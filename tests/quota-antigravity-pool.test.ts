import { describe, expect, test } from "bun:test";
import {
  supportsPerAccountQuota,
  getCachedProviderAccountQuota,
  setCachedProviderAccountQuotaForTests,
  parseAntigravityModelsQuota,
  parseAntigravityBucketsQuota,
  parseAntigravityQuotaSummary,
} from "../src/providers/quota";

describe("antigravity per-account quota", () => {
  test("supportsPerAccountQuota returns true for google-antigravity", () => {
    expect(supportsPerAccountQuota("google-antigravity")).toBe(true);
    expect(supportsPerAccountQuota("anthropic")).toBe(true);
    expect(supportsPerAccountQuota("xai")).toBe(false);
  });

  test("caches and reads per-account quota for google-antigravity", () => {
    const quota = {
      customWindows: [
        { label: "Gemini (Weekly)", percent: 17.8, resetAt: 1700000000000 },
        { label: "Gemini (5h)", percent: 27.7, resetAt: 1700000000000 },
        { label: "Claude/GPT (Weekly)", percent: 0, resetAt: 1700000000000 },
        { label: "Claude/GPT (5h)", percent: 0, resetAt: 1700000000000 },
      ],
      updatedAt: Date.now(),
    };
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-123", quota);
    const cached = getCachedProviderAccountQuota("google-antigravity", "acc-123");
    expect(cached).not.toBeNull();
    expect(cached?.customWindows?.find(w => w.label === "Gemini (Weekly)")?.percent).toBe(17.8);
    expect(cached?.customWindows?.find(w => w.label === "Gemini (5h)")?.percent).toBe(27.7);
  });

  test("parseAntigravityQuotaSummary parses retrieveUserQuotaSummary groups and weekly/5h limits", () => {
    const mockSummary = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-08-23T01:08:09Z",
              remainingFraction: 0.822,
            },
            {
              bucketId: "gemini-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              resetTime: "2026-08-16T11:08:09Z",
              remainingFraction: 0.723,
            },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            {
              bucketId: "3p-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-08-23T09:42:13Z",
              remainingFraction: 1.0,
            },
          ],
        },
      ],
    };
    const parsed = parseAntigravityQuotaSummary(mockSummary);
    expect(parsed).not.toBeNull();
    const gemWeekly = parsed?.customWindows?.find(w => w.label === "Gemini (Weekly)");
    const gem5h = parsed?.customWindows?.find(w => w.label === "Gemini (5h)");
    const claWeekly = parsed?.customWindows?.find(w => w.label === "Claude/GPT (Weekly)");

    expect(gemWeekly?.percent).toBeCloseTo(17.8, 1); // 100 - 82.2
    expect(gem5h?.percent).toBeCloseTo(27.7, 1); // 100 - 72.3
    expect(claWeekly?.percent).toBe(0);
  });

  test("parseAntigravityBucketsQuota parses retrieveUserQuota buckets", () => {
    const mockBuckets = [
      {
        modelId: "gemini-3.7-flash-high",
        tokenType: "WTUS",
        remainingFraction: 0.85,
        resetTime: "2026-08-16T18:00:00Z",
      },
      {
        modelId: "claude-sonnet-4-6",
        tokenType: "WTUS",
        remainingFraction: 0.7,
        resetTime: "2026-08-16T19:00:00Z",
      },
    ];
    const parsed = parseAntigravityBucketsQuota(mockBuckets);
    expect(parsed).not.toBeNull();
    const gem = parsed?.customWindows?.find(w => w.label === "Gem");
    const cla = parsed?.customWindows?.find(w => w.label === "Cla");
    expect(gem?.percent).toBe(15);
    expect(cla?.percent).toBe(30);
  });

  test("parseAntigravityModelsQuota parses legacy models quota", () => {
    const mockModels = {
      "gemini-3.1-pro": {
        displayName: "Gemini 3.1 Pro",
        quotaInfo: {
          remainingFraction: 0.6,
          resetTime: "2026-08-16T20:00:00Z",
        },
      },
    };
    const parsed = parseAntigravityModelsQuota(mockModels);
    expect(parsed).not.toBeNull();
    const gem = parsed?.customWindows?.find(w => w.label === "Gem");
    expect(gem?.percent).toBe(40);
  });
});
