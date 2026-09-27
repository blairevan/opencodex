import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexDesktopNativeModelsNeedSync } from "../src/codex/catalog";
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
});
