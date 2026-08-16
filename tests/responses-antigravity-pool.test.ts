import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../src/codex/pool-rotation";
import {
  clearAntigravityAccountPoolState,
  isAntigravityAccountPoolEnabled,
  resolveAntigravityAccountForSession,
  rotateAntigravityAccountOn429,
  getAntigravityPoolRetryAfterSeconds,
} from "../src/oauth/antigravity-routing";
import { saveCredential, setActiveAccount, getAccountSet } from "../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-ga-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearAntigravityAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("google-antigravity");
});

afterEach(() => {
  clearAntigravityAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("google-antigravity");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

async function seedTwoAccounts() {
  await saveCredential("google-antigravity", {
    access: "access-ga-1",
    refresh: "refresh-ga-1",
    expires: Date.now() + 3_600_000,
    accountId: "ga-user-1",
    email: "user1@example.com",
    projectId: "project-ga-1",
  });
  await saveCredential("google-antigravity", {
    access: "access-ga-2",
    refresh: "refresh-ga-2",
    expires: Date.now() + 3_600_000,
    accountId: "ga-user-2",
    email: "user2@example.com",
    projectId: "project-ga-2",
  });
  const set = getAccountSet("google-antigravity")!;
  const a1 = set.accounts.find(acc => acc.credential.accountId === "ga-user-1")!;
  const a2 = set.accounts.find(acc => acc.credential.accountId === "ga-user-2")!;
  await setActiveAccount("google-antigravity", a1.id);
  return { a1, a2 };
}

describe("Google Antigravity account pool end-to-end routing", () => {
  test("switches between accounts on 429 failover", async () => {
    const { a1, a2 } = await seedTwoAccounts();
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          googleMode: "cloud-code-assist",
        },
      },
      antigravityAccountPool: {
        enabled: true,
        autoSwitchThreshold: 80,
      },
    };

    expect(isAntigravityAccountPoolEnabled(config)).toBe(true);
    const initial = resolveAntigravityAccountForSession("session-1", "gemini-3.1-pro", config);
    expect(initial.accountId).toBe(a1.id);

    // Trigger 429 on a1
    const nextId = rotateAntigravityAccountOn429(config, a1.id, "60", "session-1", "gemini-3.1-pro");
    expect(nextId).toBe(a2.id);

    // Subsequent turns for session-1 now route to a2
    const turn2 = resolveAntigravityAccountForSession("session-1", "gemini-3.1-pro", config);
    expect(turn2.accountId).toBe(a2.id);
    expect(turn2.reason).toBe("affinity");
  });

  test("reports retry-after when all pool accounts are in cooldown", async () => {
    const { a1, a2 } = await seedTwoAccounts();
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {},
      antigravityAccountPool: { enabled: true },
    };

    rotateAntigravityAccountOn429(config, a1.id, "30", "s1");
    rotateAntigravityAccountOn429(config, a2.id, "45", "s2");

    const pick = resolveAntigravityAccountForSession("s3", "gemini-3.1-pro", config);
    expect(pick.accountId).toBeNull();
    expect(pick.reason).toBe("all-cooled");
    expect(getAntigravityPoolRetryAfterSeconds()).toBeGreaterThan(0);
  });
});
