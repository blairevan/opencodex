import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

describe("Google Antigravity account pool strategy management API", () => {
  let testDir = "";
  let previousHome: string | undefined;
  let isolatedCodexHome: IsolatedCodexHome | null = null;

  function baseConfig(): OcxConfig {
    return {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" },
      },
    } as OcxConfig;
  }

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedCodexHome = installIsolatedCodexHome("ocx-pool-mgmt-antigravity-");
    testDir = mkdtempSync(join(tmpdir(), "ocx-pool-mgmt-ga-"));
    process.env.OPENCODEX_HOME = testDir;
    saveConfig(baseConfig());
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      "google-antigravity": {
        activeAccountId: "ga1111",
        accounts: [
          { id: "ga1111", credential: { access: "t1", refresh: "r1", expires: 9999999999999, email: "u1@example.com", projectId: "p-1" } },
          { id: "ga2222", credential: { access: "t2", refresh: "r2", expires: 9999999999999, email: "u2@example.com", projectId: "p-2" } },
        ],
      },
    }), { mode: 0o600 });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test("GET /api/oauth/accounts/pool surfaces strategy defaults for google-antigravity", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool?provider=google-antigravity", server.url));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        provider: "google-antigravity",
        enabled: false,
        strategy: "quota",
        stickyLimit: 1,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool enables and updates antigravity pool config", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          enabled: true,
          autoSwitchThreshold: 75,
          strategy: "round-robin",
          stickyLimit: 3,
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        ok: true,
        provider: "google-antigravity",
        enabled: true,
        autoSwitchThreshold: 75,
        strategy: "round-robin",
        stickyLimit: 3,
      });

      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=google-antigravity", server.url));
      expect(await get.json()).toMatchObject({
        provider: "google-antigravity",
        enabled: true,
        autoSwitchThreshold: 75,
        strategy: "round-robin",
        stickyLimit: 3,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("POST /api/oauth/accounts/clear-cooldown supports google-antigravity", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/clear-cooldown", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          accountId: "ga1111",
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    } finally {
      await server.stop(true);
    }
  });
});
