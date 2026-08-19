/**
 * Opt-in Google Antigravity OAuth account pool.
 *
 * Default OFF. When enabled:
 * - Sticky session affinity across requests that share a session key (preserving reasoning thoughtSignature and context)
 * - 429 cools the failed account and fails over to another eligible account
 * - New sessions use `strategy` (default quota): lowest known Gemini/Claude family usage,
 *   round-robin, or fill-first — affinity still wins for bound sessions
 */
import { createHash } from "node:crypto";
import { setActiveAccount, getAccountSet, getAccountCredential } from "./store";
import { getCachedProviderAccountQuota } from "../providers/quota";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
  POOL_KEY_ANTIGRAVITY,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import type { AntigravityAccountPoolConfig, OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import { retainedUtf8Bytes } from "../lib/admission";

const PROVIDER = "google-antigravity";
/** Fallback cooldown when neither Retry-After nor quota resetAt is available: 5 h default window. */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 60_000;
/** Extra safety buffer added on top of quota resetAt to avoid edge-timing rate-limits (5 min). */
const BUFFER_COOLDOWN_MS = 5 * 60_000;
/** Hard cap on cooldowns (allows weekly reset windows up to 7 days). */
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const MAX_AFFINITY_COMPONENT_BYTES = 512;
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
/** Cap same-request 429 rotations so short Retry-After cannot infinite-loop. */
export const ANTIGRAVITY_POOL_MAX_FAILOVERS_PER_REQUEST = 3;

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "quota-reset" | "default";
}

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

const upstreamHealth = new Map<string, AccountHealth>();
const sessionAffinity = new Map<string, AffinityEntry>();

function normalizeAffinityComponent(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized && retainedUtf8Bytes(normalized) <= MAX_AFFINITY_COMPONENT_BYTES ? normalized : "";
}

export function antigravityAccountPoolConfig(config: OcxConfig): AntigravityAccountPoolConfig {
  const raw = config.antigravityAccountPool;
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

export function isAntigravityAccountPoolEnabled(config: OcxConfig): boolean {
  return antigravityAccountPoolConfig(config).enabled === true;
}

export function antigravityAutoSwitchThreshold(config: OcxConfig): number {
  const value = antigravityAccountPoolConfig(config).autoSwitchThreshold;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  return DEFAULT_AUTO_SWITCH_THRESHOLD;
}

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

export function getAntigravityAccountHealthSnapshot(
  accountId: string,
  now = Date.now(),
): { cooldownUntil?: number; cooldownSource?: AccountHealth["cooldownSource"] } | null {
  const entry = upstreamHealth.get(accountId);
  if (!entry) return null;
  if (entry.cooldownUntil <= now) {
    upstreamHealth.delete(accountId);
    return null;
  }
  return { cooldownUntil: entry.cooldownUntil, cooldownSource: entry.cooldownSource };
}

export function clearAntigravityAccountCooldown(accountId: string): boolean {
  return upstreamHealth.delete(accountId);
}

export function sweepExpiredAntigravityRoutingHealth(now = Date.now()): number {
  let removed = 0;
  for (const [accountId, health] of upstreamHealth) {
    if (health.cooldownUntil > now) continue;
    upstreamHealth.delete(accountId);
    removed += 1;
  }
  return removed;
}

/** Test / logout helper. */
export function clearAntigravityAccountPoolState(): void {
  upstreamHealth.clear();
  sessionAffinity.clear();
}

export function antigravitySessionAffinitySizeForTests(): number {
  return sessionAffinity.size;
}

function isCooled(accountId: string, now: number): boolean {
  return getAntigravityAccountHealthSnapshot(accountId, now) !== null;
}

function isGeminiModel(modelId: string | undefined): boolean {
  if (!modelId) return true;
  const id = modelId.toLowerCase();
  return id.includes("gemini") || (!id.includes("claude") && !id.includes("opus") && !id.includes("sonnet") && !id.includes("gpt-oss") && !id.includes("gpt_oss"));
}

function matchesFamilyWindow(label: string, isGemini: boolean): boolean {
  const l = label.toLowerCase();
  if (isGemini) {
    return l.includes("gem") || l.startsWith("gemini");
  }
  return l.includes("cla") || l.includes("gpt") || l.startsWith("claude");
}

function hasKnownUsage(accountId: string, modelId?: string): boolean {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  if (!quota?.customWindows || quota.customWindows.length === 0) return false;
  const isGem = isGeminiModel(modelId);
  const matched = quota.customWindows.filter(w => matchesFamilyWindow(w.label, isGem));
  const windows = matched.length > 0 ? matched : quota.customWindows;
  return windows.some(w => typeof w.percent === "number" && Number.isFinite(w.percent));
}

function usageScore(accountId: string, modelId?: string): number {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  if (!quota?.customWindows || quota.customWindows.length === 0) {
    return UNKNOWN_USAGE_SCORE;
  }
  const isGem = isGeminiModel(modelId);
  const matched = quota.customWindows.filter(w => matchesFamilyWindow(w.label, isGem));
  const windows = matched.length > 0 ? matched : quota.customWindows;
  let maxScore = Number.NEGATIVE_INFINITY;
  for (const win of windows) {
    if (typeof win.percent === "number" && Number.isFinite(win.percent)) {
      maxScore = Math.max(maxScore, win.percent);
    }
  }
  if (maxScore === Number.NEGATIVE_INFINITY) return UNKNOWN_USAGE_SCORE;
  return Math.max(0, Math.min(100, maxScore));
}

function resolveQuotaDerivedCooldownMs(
  accountId: string,
  modelId: string | undefined,
  now: number,
): number | undefined {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  if (!quota?.customWindows || quota.customWindows.length === 0) {
    return undefined;
  }

  const isGem = isGeminiModel(modelId);
  const matched = quota.customWindows.filter(w => matchesFamilyWindow(w.label, isGem));
  const windows = matched.length > 0 ? matched : quota.customWindows;

  let maxFullUsageResetAt: number | undefined;
  let highestPercent = Number.NEGATIVE_INFINITY;
  let highestPercentResetAt: number | undefined;

  for (const win of windows) {
    if (typeof win.resetAt === "number" && Number.isFinite(win.resetAt) && win.resetAt > now) {
      const pct = typeof win.percent === "number" && Number.isFinite(win.percent) ? win.percent : 0;
      if (pct >= 90) {
        if (maxFullUsageResetAt === undefined || win.resetAt > maxFullUsageResetAt) {
          maxFullUsageResetAt = win.resetAt;
        }
      }
      if (pct > highestPercent) {
        highestPercent = pct;
        highestPercentResetAt = win.resetAt;
      }
    }
  }

  const targetResetAt = maxFullUsageResetAt ?? highestPercentResetAt;
  if (targetResetAt && targetResetAt > now) {
    const remainingMs = targetResetAt - now;
    const cooldownWithBuffer = remainingMs + BUFFER_COOLDOWN_MS;
    return Math.min(Math.max(cooldownWithBuffer, 1_000), MAX_COOLDOWN_MS);
  }

  return undefined;
}

function isPoolCredentialUsable(accountId: string): boolean {
  const cred = getAccountCredential(PROVIDER, accountId);
  if (!cred) return false;
  return typeof cred.projectId === "string" && cred.projectId.length > 0;
}

export function getEligibleAntigravityAccounts(now = Date.now()): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account =>
      account.needsReauth !== true
      && !isCooled(account.id, now)
      && isPoolCredentialUsable(account.id))
    .map(account => account.id);
}

/** Earliest remaining cooldown among cooled Antigravity accounts, for client Retry-After. */
export function getAntigravityPoolRetryAfterSeconds(now = Date.now()): number | null {
  const set = getAccountSet(PROVIDER);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const snap = getAntigravityAccountHealthSnapshot(account.id, now);
    if (!snap?.cooldownUntil) continue;
    if (earliest === null || snap.cooldownUntil < earliest) earliest = snap.cooldownUntil;
  }
  if (earliest === null || earliest <= now) return null;
  return Math.max(1, Math.ceil((earliest - now) / 1000));
}

function pickLowestUsage(excludeId: string | undefined, modelId: string | undefined, now: number): string | null {
  const eligible = getEligibleAntigravityAccounts(now).filter(id => id !== excludeId);
  if (eligible.length === 0) return null;
  let best = eligible[0]!;
  let bestScore = usageScore(best, modelId);
  for (let i = 1; i < eligible.length; i++) {
    const id = eligible[i]!;
    const score = usageScore(id, modelId);
    if (score < bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

function pickNextFillFirstAntigravityAccount(
  config: OcxConfig,
  afterId: string,
  modelId: string | undefined,
  eligible: string[],
): string | null {
  if (eligible.length === 0) return null;
  const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
  const set = getAccountSet(PROVIDER);
  const stableAll = set
    ? [...set.accounts.map(a => a.id)].sort((a, b) => a.localeCompare(b))
    : ordered;
  const startIdx = stableAll.indexOf(afterId);
  if (startIdx < 0) {
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(config, id, modelId)) return id;
    }
    return ordered[0] ?? null;
  }
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(startIdx + step) % stableAll.length]!;
    if (!eligible.includes(candidate)) continue;
    if (!fallback) fallback = candidate;
    if (isActiveUnderFillFirstThreshold(config, candidate, modelId)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

function pickAlternateAntigravityAccount(
  config: OcxConfig,
  excludeId: string,
  modelId: string | undefined,
  now: number,
): string | null {
  const strategy = antigravityPoolStrategy(config);
  const eligible = getEligibleAntigravityAccounts(now).filter(id => id !== excludeId);
  if (strategy === "round-robin") {
    return pickRoundRobinAccount(POOL_KEY_ANTIGRAVITY, eligible, stickyLimitForPool(config));
  }
  if (strategy === "fill-first") {
    return pickNextFillFirstAntigravityAccount(config, excludeId, modelId, eligible);
  }
  return pickLowestUsage(excludeId, modelId, now);
}

function pruneExpiredAffinity(now: number): void {
  for (const [key, entry] of sessionAffinity) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) sessionAffinity.delete(key);
  }
  if (sessionAffinity.size <= MAX_AFFINITY_ENTRIES) return;
  const sorted = [...sessionAffinity.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const drop = sessionAffinity.size - MAX_AFFINITY_ENTRIES;
  for (let i = 0; i < drop; i++) sessionAffinity.delete(sorted[i]![0]);
}

export type AntigravityAccountSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "round-robin"
  | "fill-first"
  | "none"
  | "all-cooled";

export interface AntigravityAccountSelection {
  accountId: string | null;
  reason: AntigravityAccountSelectionReason;
}

function stickyLimitForPool(config: OcxConfig): number {
  return normalizeAccountPoolStickyLimit(antigravityAccountPoolConfig(config).stickyLimit);
}

function antigravityPoolStrategy(config: OcxConfig): OcxAccountPoolRotationStrategy {
  return normalizeAccountPoolStrategy(antigravityAccountPoolConfig(config).strategy);
}

function isActiveUnderFillFirstThreshold(config: OcxConfig, accountId: string, modelId?: string): boolean {
  const threshold = antigravityAutoSwitchThreshold(config);
  if (threshold <= 0) return true;
  if (!hasKnownUsage(accountId, modelId)) return true;
  return usageScore(accountId, modelId) < threshold;
}

function pickFillFirstAntigravityAccount(config: OcxConfig, modelId: string | undefined, now: number): string | null {
  const eligible = getEligibleAntigravityAccounts(now);
  if (eligible.length === 0) return null;

  const set = getAccountSet(PROVIDER);
  const active = set?.activeAccountId;
  if (active && eligible.includes(active) && isActiveUnderFillFirstThreshold(config, active, modelId)) {
    return active;
  }

  if (!active || !set) {
    const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(config, id, modelId)) return id;
    }
    return ordered[0] ?? null;
  }

  return pickNextFillFirstAntigravityAccount(config, active, modelId, eligible);
}

function pickUnboundStrategyAccount(
  config: OcxConfig,
  modelId: string | undefined,
  now: number,
): { accountId: string; reason: "round-robin" | "fill-first" } | null {
  const strategy = antigravityPoolStrategy(config);
  if (strategy === "quota") return null;

  if (strategy === "round-robin") {
    const eligible = getEligibleAntigravityAccounts(now);
    const limit = stickyLimitForPool(config);
    const picked = pickRoundRobinAccount(POOL_KEY_ANTIGRAVITY, eligible, limit);
    if (!picked) return null;
    notePoolRotationSuccess(POOL_KEY_ANTIGRAVITY, picked, limit);
    return { accountId: picked, reason: "round-robin" };
  }

  if (strategy === "fill-first") {
    const picked = pickFillFirstAntigravityAccount(config, modelId, now);
    if (!picked) return null;
    return { accountId: picked, reason: "fill-first" };
  }

  return null;
}

export function resolveAntigravityAccountForSession(
  sessionKey: string | null | undefined,
  modelId: string | undefined,
  config: OcxConfig,
  now = Date.now(),
): AntigravityAccountSelection {
  pruneExpiredAffinity(now);
  const set = getAccountSet(PROVIDER);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };

  if (!isAntigravityAccountPoolEnabled(config)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const key = normalizeAffinityComponent(sessionKey);
  if (key) {
    const affined = sessionAffinity.get(key);
    if (affined && now - affined.lastUsedAt <= AFFINITY_IDLE_TTL_MS) {
      const stillThere = set.accounts.some(a => a.id === affined.accountId && a.needsReauth !== true);
      if (stillThere && !isCooled(affined.accountId, now) && isPoolCredentialUsable(affined.accountId)) {
        affined.lastUsedAt = now;
        return { accountId: affined.accountId, reason: "affinity" };
      }
      sessionAffinity.delete(key);
    }
  }

  const strategy = antigravityPoolStrategy(config);
  if (!key && (strategy === "round-robin" || strategy === "fill-first")) {
    const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
      && !isCooled(set.activeAccountId, now)
      && isPoolCredentialUsable(set.activeAccountId);
    if (activeOk) {
      return { accountId: set.activeAccountId, reason: "active" };
    }
  }

  const strategyPick = pickUnboundStrategyAccount(config, modelId, now);
  if (strategyPick) {
    if (key && normalizeAffinityComponent(strategyPick.accountId)) {
      sessionAffinity.set(key, { accountId: strategyPick.accountId, lastUsedAt: now });
      pruneExpiredAffinity(now);
    }
    return { accountId: strategyPick.accountId, reason: strategyPick.reason };
  }

  const threshold = antigravityAutoSwitchThreshold(config);
  const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
    && !isCooled(set.activeAccountId, now)
    && isPoolCredentialUsable(set.activeAccountId);

  let accountId: string | null = null;
  let reason: AntigravityAccountSelectionReason = "none";

  if (threshold > 0) {
    if (activeOk && (!hasKnownUsage(set.activeAccountId, modelId) || usageScore(set.activeAccountId, modelId) < threshold)) {
      accountId = set.activeAccountId;
      reason = "active";
    } else {
      const picked = pickLowestUsage(undefined, modelId, now);
      if (picked) {
        accountId = picked;
        reason = activeOk && picked === set.activeAccountId ? "active" : "lowest-usage";
      } else if (activeOk) {
        accountId = set.activeAccountId;
        reason = "active";
      }
    }
  } else if (activeOk) {
    accountId = set.activeAccountId;
    reason = "active";
  } else {
    const picked = pickLowestUsage(set.activeAccountId, modelId, now);
    if (picked) {
      accountId = picked;
      reason = "only-eligible";
    }
  }

  if (!accountId) {
    const anyCooled = set.accounts.some(a => isCooled(a.id, now));
    return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
  }

  if (key && normalizeAffinityComponent(accountId)) {
    sessionAffinity.set(key, { accountId, lastUsedAt: now });
    pruneExpiredAffinity(now);
  }
  return { accountId, reason };
}

export function bindAntigravitySessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = normalizeAffinityComponent(sessionKey);
  if (!key || !normalizeAffinityComponent(accountId)) return;
  sessionAffinity.set(key, { accountId, lastUsedAt: now });
  pruneExpiredAffinity(now);
}

export function clearAntigravitySessionAffinityForAccount(accountId: string): void {
  for (const [key, entry] of sessionAffinity) {
    if (entry.accountId === accountId) sessionAffinity.delete(key);
  }
}

export function rotateAntigravityAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  modelId?: string,
  now = Date.now(),
): string | null {
  if (!isAntigravityAccountPoolEnabled(config)) return null;

  const parsedRetry = parseRetryAfterMs(retryAfterHeader, now);
  let cooldownMs: number;
  let cooldownSource: AccountHealth["cooldownSource"];

  if (parsedRetry !== undefined) {
    cooldownMs = parsedRetry;
    cooldownSource = "retry-after";
  } else {
    const quotaDerivedMs = resolveQuotaDerivedCooldownMs(failedAccountId, modelId, now);
    if (quotaDerivedMs !== undefined) {
      cooldownMs = quotaDerivedMs;
      cooldownSource = "quota-reset";
    } else {
      cooldownMs = DEFAULT_COOLDOWN_MS;
      cooldownSource = "default";
    }
  }

  upstreamHealth.set(failedAccountId, {
    cooldownUntil: now + cooldownMs,
    cooldownSource,
  });
  sweepExpiredOnWrite(now);
  clearAntigravitySessionAffinityForAccount(failedAccountId);
  notePoolRotationFailure(POOL_KEY_ANTIGRAVITY, failedAccountId);

  const next = pickAlternateAntigravityAccount(config, failedAccountId, modelId, now);
  if (!next) {
    console.warn("[antigravity-pool] all eligible Antigravity OAuth accounts are in cooldown; returning 429");
    return null;
  }

  const affinityKey = normalizeAffinityComponent(sessionKey);
  if (affinityKey && normalizeAffinityComponent(next)) {
    sessionAffinity.set(affinityKey, { accountId: next, lastUsedAt: now });
    pruneExpiredAffinity(now);
  }
  console.warn(
    `[antigravity-pool] 429 on ${formatAntigravityAccountOrdinal(failedAccountId)}; failing over to ${formatAntigravityAccountOrdinal(next)}`,
  );
  return next;
}

export function promoteAntigravityActiveAccount(accountId: string): void {
  void setActiveAccount(PROVIDER, accountId).catch(() => { /* best-effort */ });
}

export function resetAntigravityRoutingForManualSelection(accountId: string): void {
  sessionAffinity.clear();
  seedPoolRotationAccount(POOL_KEY_ANTIGRAVITY, accountId);
}

const TOKEN_SKEW_MS = 60_000;

export async function getAntigravityPoolAccessTokenAndProject(accountId: string): Promise<{ accessToken: string; projectId: string }> {
  const stored = getAccountCredential(PROVIDER, accountId);
  if (!stored || !stored.projectId) {
    const { OAuthLoginRequiredError } = await import("./index");
    throw new OAuthLoginRequiredError(PROVIDER);
  }
  if (stored.expires > Date.now() + TOKEN_SKEW_MS) {
    return { accessToken: stored.access, projectId: stored.projectId };
  }
  const { getValidAccessTokenForAccount } = await import("./index");
  const token = await getValidAccessTokenForAccount(PROVIDER, accountId);
  const freshStored = getAccountCredential(PROVIDER, accountId);
  return { accessToken: token, projectId: freshStored?.projectId ?? stored.projectId };
}

export function formatAntigravityAccountOrdinal(accountId: string): string {
  return fallbackCodexAccountLogLabel(accountId);
}

export function formatAntigravityProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
  _config?: OcxConfig,
): string {
  if (!accountId) return providerName;
  return `${providerName}-${formatAntigravityAccountOrdinal(accountId)}`;
}

export function antigravitySessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
}): string | null {
  const preferred = (
    input.clientThreadId
    ?? input.sessionIdHeader
    ?? input.threadIdHeader
    ?? ""
  ).trim();
  if (preferred) {
    return preferred.length <= 128 ? preferred : createHash("sha256").update(preferred).digest("hex");
  }
  const cacheKey = input.promptCacheKey?.trim() ?? "";
  if (!cacheKey) return null;
  return cacheKey.length <= 128 ? cacheKey : createHash("sha256").update(cacheKey).digest("hex");
}
