import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexDesktopNativeModelsNeedSync, nativeOpenAiSlugs } from "../src/codex/catalog";
import { desktopNativeModelRows, projectDesktopNativeModelRow } from "../src/codex/catalog/desktop-native-cache";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccountNamespaces: { desktop: "@main" },
    codexAccountPickerEnabled: true,
    ...overrides,
  } as OcxConfig;
}

function observedModel(slug = "gpt-future-unlisted"): Record<string, unknown> {
  return {
    slug,
    display_name: "Future GPT model",
    description: "Native Codex model",
    visibility: "list",
    supported_in_api: true,
    base_instructions: "You are Codex.",
    comp_hash: "native-comp-hash",
    shell_type: "shell_command",
    supported_reasoning_levels: [{ effort: "high" }],
    model_messages: { instructions_template: "You are Codex." },
  };
}

/** Build the visible model row shape currently emitted by Codex Desktop. */
function currentDesktopModel(slug = "gpt-6-sol"): Record<string, unknown> {
  return {
    slug,
    display_name: "GPT-6-Sol",
    description: "Workhorse model for coding and everyday work.",
    default_reasoning_level: "medium",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"]
      .map(effort => ({ effort })),
    context_window: 272_000,
    max_context_window: 872_000,
    visibility: "list",
    supported_in_api: true,
    shell_type: "unified_exec",
    model_messages: { persistent_instructions: "Do not copy this cache prompt." },
  };
}

describe("Codex Desktop model cache sync detection", () => {
  test("detects new account-native rows and ignores disabled or already-synced rows", () => {
    const isolatedHome = installIsolatedCodexHome("ocx-native-cache-sync-");
    try {
      const config = makeConfig();
      const cachePath = join(isolatedHome.path, "models_cache.json");
      const observed = observedModel();
      writeFileSync(cachePath, JSON.stringify({ client_version: "1.2.3", models: [observed] }), "utf8");

      expect(codexDesktopNativeModelsNeedSync(config)).toBe(true);
      expect(codexDesktopNativeModelsNeedSync(makeConfig({ codexAccountPickerEnabled: false }))).toBe(false);

      writeFileSync(
        join(isolatedHome.path, "opencodex-catalog.json"),
        JSON.stringify({ models: [observed] }),
        "utf8",
      );
      expect(codexDesktopNativeModelsNeedSync(config)).toBe(false);

      writeFileSync(cachePath, JSON.stringify({ client_version: "0.0.0", models: [observed] }), "utf8");
      expect(codexDesktopNativeModelsNeedSync(config)).toBe(false);
    } finally {
      isolatedHome.restore();
    }
  });

  test("mirrors current Desktop model rows without account-picker gating or prompt copying", () => {
    const isolatedHome = installIsolatedCodexHome("ocx-native-cache-current-schema-");
    try {
      const cachePath = join(isolatedHome.path, "models_cache.json");
      const catalogPath = join(isolatedHome.path, "opencodex-catalog.json");
      const observed = currentDesktopModel();
      writeFileSync(cachePath, JSON.stringify({ client_version: "0.158.0", models: [observed] }), "utf8");

      expect(desktopNativeModelRows([observed])).toHaveLength(1);
      expect(codexDesktopNativeModelsNeedSync(makeConfig({ codexAccountPickerEnabled: false }))).toBe(true);

      const template = observedModel("gpt-5.5");
      const projected = projectDesktopNativeModelRow(template, observed);
      expect(projected).toMatchObject({
        slug: "gpt-6-sol",
        display_name: "GPT-6-Sol",
        shell_type: "unified_exec",
        context_window: 272_000,
        supported_in_api: true,
      });
      expect(projected?.model_messages).toEqual(template.model_messages);
      expect(JSON.stringify(projected)).not.toContain("Do not copy this cache prompt.");
      writeFileSync(catalogPath, JSON.stringify({ models: [projected] }), "utf8");
      expect(nativeOpenAiSlugs()).toContain("gpt-6-sol");
      expect(codexDesktopNativeModelsNeedSync(makeConfig({ codexAccountPickerEnabled: false }))).toBe(false);

      const updated = { ...observed, default_reasoning_level: "high" };
      writeFileSync(cachePath, JSON.stringify({ client_version: "0.158.0", models: [updated] }), "utf8");
      expect(codexDesktopNativeModelsNeedSync(makeConfig({ codexAccountPickerEnabled: false }))).toBe(true);

      writeFileSync(cachePath, JSON.stringify({ client_version: "0.158.0", models: [] }), "utf8");
      expect(codexDesktopNativeModelsNeedSync(makeConfig({ codexAccountPickerEnabled: false }))).toBe(true);
    } finally {
      isolatedHome.restore();
    }
  });
});
