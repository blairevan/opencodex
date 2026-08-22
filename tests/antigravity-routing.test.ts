import { describe, expect, test, beforeEach } from "bun:test";
import {
  isAntigravityAccountPoolEnabled,
  antigravityAutoSwitchThreshold,
  resolveAntigravityAccountForSession,
  bindAntigravitySessionAffinity,
  clearAntigravityAccountCooldown,
  clearAntigravityAccountPoolState,
  rotateAntigravityAccountOn429,
  getAntigravityAccountHealthSnapshot,
  getAntigravityPoolRetryAfterSeconds,
  formatAntigravityProviderForLog,
  antigravitySessionKeyFromParts,
} from "../src/oauth/antigravity-routing";
import { setCachedProviderAccountQuotaForTests } from "../src/providers/quota";
import { mutateStore } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";

describe("antigravity-routing", () => {
  const configPoolEnabled: OcxConfig = {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
    antigravityAccountPool: {
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
    },
  };

  beforeEach(async () => {
    clearAntigravityAccountPoolState();
    // Seed auth.json with two mock antigravity accounts
    await mutateStore(store => {
      store["google-antigravity"] = {
        activeAccountId: "acc-1",
        accounts: [
          {
            id: "acc-1",
            credential: {
              access: "token-1",
              refresh: "refresh-1",
              expires: Date.now() + 3600_000,
              email: "user1@gmail.com",
              projectId: "proj-1",
            },
          },
          {
            id: "acc-2",
            credential: {
              access: "token-2",
              refresh: "refresh-2",
              expires: Date.now() + 3600_000,
              email: "user2@gmail.com",
              projectId: "proj-2",
            },
          },
        ],
      };
    });
  });

  test("returns pool-disabled when pool is not enabled", () => {
    const res = resolveAntigravityAccountForSession("s1", "gemini-3.1-pro", {});
    expect(res.accountId).toBe("acc-1");
    expect(res.reason).toBe("pool-disabled");
  });

  test("does not route to a disabled active account when the pool is disabled", async () => {
    await mutateStore(store => {
      const account = store["google-antigravity"]?.accounts.find(item => item.id === "acc-1");
      if (account) account.enabled = false;
    });
    const res = resolveAntigravityAccountForSession("single-account-mode", "gemini-3.1-pro", {});
    expect(res.accountId).toBe("acc-2");
    expect(res.reason).toBe("pool-disabled");
  });

  test("maintains session affinity across requests", () => {
    bindAntigravitySessionAffinity("session-123", "acc-2");
    const res = resolveAntigravityAccountForSession("session-123", "gemini-3.1-pro", configPoolEnabled);
    expect(res.accountId).toBe("acc-2");
    expect(res.reason).toBe("affinity");
  });

  test("auto-switches to lowest usage account when active exceeds threshold (Gemini model)", () => {
    // acc-1 has 85% Gem usage (exceeds 80% threshold)
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-1", {
      customWindows: [{ label: "Gem", percent: 85 }, { label: "Cla", percent: 20 }],
      updatedAt: Date.now(),
    });
    // acc-2 has 30% Gem usage
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-2", {
      customWindows: [{ label: "Gem", percent: 30 }, { label: "Cla", percent: 90 }],
      updatedAt: Date.now(),
    });

    const res = resolveAntigravityAccountForSession("new-session", "gemini-3.1-pro", configPoolEnabled);
    expect(res.accountId).toBe("acc-2");
    expect(res.reason).toBe("lowest-usage");
  });

  test("auto-switches based on Claude usage when model is Claude on Antigravity", () => {
    // acc-1 has 20% Gem, 90% Cla (exceeds Cla threshold)
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-1", {
      customWindows: [{ label: "Gem", percent: 20 }, { label: "Cla", percent: 90 }],
      updatedAt: Date.now(),
    });
    // acc-2 has 80% Gem, 25% Cla (healthy Cla)
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-2", {
      customWindows: [{ label: "Gem", percent: 80 }, { label: "Cla", percent: 25 }],
      updatedAt: Date.now(),
    });

    const res = resolveAntigravityAccountForSession("new-session-2", "claude-3.7-sonnet", configPoolEnabled);
    expect(res.accountId).toBe("acc-2");
    expect(res.reason).toBe("lowest-usage");
  });

  test("excludes an explicitly disabled account from Antigravity routing", async () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-1", {
      customWindows: [{ label: "Gemini (5h)", percent: 90 }],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-2", {
      customWindows: [{ label: "Gemini (5h)", percent: 10 }],
      updatedAt: Date.now(),
    });
    await mutateStore(store => {
      const account = store["google-antigravity"]?.accounts.find(item => item.id === "acc-2");
      if (account) (account as typeof account & { enabled?: boolean }).enabled = false;
    });
    const res = resolveAntigravityAccountForSession("disabled-account-session", "gemini-3.1-pro", configPoolEnabled);
    expect(res.accountId).toBe("acc-1");
  });

  test("429 failover cools the failed account and fails over to healthy account", () => {
    const next = rotateAntigravityAccountOn429(
      configPoolEnabled,
      "acc-1",
      "120",
      "session-failover",
      "gemini-3.1-pro",
    );
    expect(next).toBe("acc-2");
    expect(getAntigravityAccountHealthSnapshot("acc-1")).not.toBeNull();
    expect(getAntigravityPoolRetryAfterSeconds()).toBeGreaterThan(0);
  });

  test("clearing cooldown restores account eligibility", () => {
    rotateAntigravityAccountOn429(configPoolEnabled, "acc-1", "60", "s1");
    expect(getAntigravityAccountHealthSnapshot("acc-1")).not.toBeNull();
    clearAntigravityAccountCooldown("acc-1");
    expect(getAntigravityAccountHealthSnapshot("acc-1")).toBeNull();
  });

  test("formats provider log label with account ordinal", () => {
    const label = formatAntigravityProviderForLog("google-antigravity", "acc-1", configPoolEnabled);
    expect(label).toContain("google-antigravity-");
  });

  test("dynamically derives cooldown from 5h quota reset time with 5 min buffer", () => {
    const now = 1_000_000;
    const resetAt = now + 28 * 60_000; // 28 minutes remaining
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-1", {
      customWindows: [
        { label: "Gemini (5h)", percent: 100, resetAt },
        { label: "Gemini (Weekly)", percent: 10, resetAt: now + 6 * 24 * 60 * 60_000 },
      ],
      updatedAt: now,
    });

    rotateAntigravityAccountOn429(
      configPoolEnabled,
      "acc-1",
      undefined,
      "s-quota-5h",
      "gemini-3.7-flash",
      now,
    );

    const snap = getAntigravityAccountHealthSnapshot("acc-1", now);
    expect(snap).not.toBeNull();
    expect(snap?.cooldownSource).toBe("quota-reset");
    // 28 min + 5 min buffer = 33 min
    expect(snap?.cooldownUntil).toBe(now + 28 * 60_000 + 5 * 60_000);
  });

  test("dynamically derives cooldown from weekly quota reset time when weekly limit is exhausted with 5 min buffer", () => {
    const now = 1_000_000;
    const weeklyResetAt = now + 3 * 24 * 60 * 60_000; // 3 days remaining
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-1", {
      customWindows: [
        { label: "Claude/GPT (5h)", percent: 100, resetAt: now + 30 * 60_000 },
        { label: "Claude/GPT (Weekly)", percent: 100, resetAt: weeklyResetAt },
      ],
      updatedAt: now,
    });

    rotateAntigravityAccountOn429(
      configPoolEnabled,
      "acc-1",
      undefined,
      "s-quota-weekly",
      "claude-3.7-sonnet",
      now,
    );

    const snap = getAntigravityAccountHealthSnapshot("acc-1", now);
    expect(snap).not.toBeNull();
    expect(snap?.cooldownSource).toBe("quota-reset");
    // 3 days + 5 min buffer
    expect(snap?.cooldownUntil).toBe(weeklyResetAt + 5 * 60_000);
  });

  test("extracts session key from parts", () => {
    const key = antigravitySessionKeyFromParts({ clientThreadId: "thread-abc-123" });
    expect(key).toBe("thread-abc-123");
  });
});
