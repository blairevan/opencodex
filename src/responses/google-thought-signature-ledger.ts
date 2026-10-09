import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileAsync, getConfigDir } from "../config";
import { enforceAppOwnedMemoryBudget, type RetainedStoreSnapshot } from "../lib/app-owned-memory";
import type { OcxMessage, OcxProviderOpaqueToolCallMetadata } from "../types";
import { providerMetadataFromGoogleFunctionCallPart } from "./provider-opaque-metadata";

const TTL_MS = 60 * 60 * 1_000;
const MAX_ENTRIES = 4_096;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
const SYNTHETIC_ID = /^(?:fc|ctc|tsc)[_-]/i;

interface LedgerEntry {
  key: string;
  signature: string;
  updatedAt: number;
  sizeBytes: number;
}

export interface GoogleThoughtSignatureScope {
  /** Fixed-size hash of destination, project, account, model, and stable conversation identity. */
  key: string;
}

export interface GoogleThoughtSignatureScopeInput {
  destination: string;
  project: string;
  account: string;
  wireModel: string;
  conversation: string;
}

const entries = new Map<string, LedgerEntry>();
let totalBytes = 0;
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistGate: Promise<void> = Promise.resolve();
let snapshotPathOverrideForTests: string | null = null;

/** Hash length-prefixed UTF-8 values so component boundaries cannot collide. */
function hashParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** Create an opaque scope identity from the selected Google route and stable conversation key. */
export function createGoogleThoughtSignatureScope(
  input: GoogleThoughtSignatureScopeInput,
): GoogleThoughtSignatureScope | undefined {
  if (Object.values(input).some(value => typeof value !== "string" || value.trim().length === 0)) return undefined;
  return { key: hashParts([input.destination, input.project, input.account, input.wireModel, input.conversation]) };
}

/** Return the on-disk path for the bounded signature snapshot. */
function snapshotPath(): string {
  return snapshotPathOverrideForTests ?? join(getConfigDir(), "google-thought-signatures.json");
}

/** Return true for a bounded, opaque signature accepted at the provider boundary. */
function validSignature(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_SIGNATURE_BYTES;
}

/** Return true when an identifier is suitable as a provider-issued Responses call id. */
function validCallId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !SYNTHETIC_ID.test(value);
}

/** Derive a fixed-size ledger index from the private scope hash and exact Responses call id. */
function entryKey(scope: GoogleThoughtSignatureScope, callId: string): string {
  return hashParts([scope.key, callId]);
}

/** Load and validate the bounded snapshot once; malformed files are ignored fail-closed. */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const path = snapshotPath();
  try {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SNAPSHOT_MAX_BYTES) return;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if ((parsed as { version?: unknown }).version !== 1) return;
    const rows = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const value = row as Record<string, unknown>;
      if (typeof value.key !== "string" || !/^[a-f0-9]{64}$/.test(value.key)
        || !validSignature(value.signature) || typeof value.updatedAt !== "number"
        || !Number.isFinite(value.updatedAt) || Date.now() - value.updatedAt >= TTL_MS) continue;
      insertEntry(value.key, value.signature, value.updatedAt, false);
    }
  } catch {
    // Snapshot state is an optimization. Invalid or unreadable state never blocks a request.
  }
}

/** Insert a validated entry and enforce oldest-first count and byte limits. */
function insertEntry(key: string, signature: string, updatedAt: number, persist: boolean): void {
  const sizeBytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(signature, "utf8") + 64;
  if (sizeBytes > MAX_BYTES) return;
  const previous = entries.get(key);
  if (previous) totalBytes -= previous.sizeBytes;
  entries.delete(key);
  entries.set(key, { key, signature, updatedAt, sizeBytes });
  totalBytes += sizeBytes;
  while (entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldestKey = entries.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = entries.get(oldestKey);
    entries.delete(oldestKey);
    if (oldest) totalBytes -= oldest.sizeBytes;
  }
  if (persist) schedulePersist();
}

/** Schedule an atomic snapshot write after a short debounce. */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushGoogleThoughtSignatures().catch(() => undefined);
  }, SNAPSHOT_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/** Read exact call ids and Google signatures from completed Responses output items. */
function outputCallSignatures(output: readonly unknown[]): Array<{ callId: string; signature: string }> {
  const result: Array<{ callId: string; signature: string }> = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    if (value.type !== "function_call" && value.type !== "custom_tool_call" && value.type !== "tool_search_call") continue;
    if (!validCallId(value.call_id)) continue;
    const metadata = providerMetadataFromGoogleFunctionCallPart({ extra_content: value.extra_content });
    const signature = metadata?.google?.thoughtSignature;
    if (validSignature(signature)) result.push({ callId: value.call_id, signature });
  }
  return result;
}

/** Store signatures from authoritative completed or resumable Responses output. */
export function rememberGoogleThoughtSignatures(
  scope: GoogleThoughtSignatureScope | undefined,
  output: readonly unknown[],
): number {
  if (!scope || !Array.isArray(output)) return 0;
  ensureLoaded();
  let remembered = 0;
  for (const { callId, signature } of outputCallSignatures(output)) {
    insertEntry(entryKey(scope, callId), signature, Date.now(), true);
    remembered += 1;
  }
  if (remembered > 0) enforceAppOwnedMemoryBudget();
  return remembered;
}

/** Restore signatures only onto unsigned internal calls with an exact matching call id. */
export function restoreGoogleThoughtSignatures(
  scope: GoogleThoughtSignatureScope | undefined,
  messages: readonly OcxMessage[],
): number {
  if (!scope) return 0;
  ensureLoaded();
  sweepExpiredGoogleThoughtSignatures();
  let restored = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || !validCallId(part.id)) continue;
      if (part.providerMetadata?.google?.thoughtSignature) continue;
      const entry = entries.get(entryKey(scope, part.id));
      if (!entry || !validSignature(entry.signature)) continue;
      const metadata: OcxProviderOpaqueToolCallMetadata = {
        ...part.providerMetadata,
        google: { ...part.providerMetadata?.google, thoughtSignature: entry.signature },
      };
      part.providerMetadata = metadata;
      entry.updatedAt = Date.now();
      entries.delete(entry.key);
      entries.set(entry.key, entry);
      restored += 1;
    }
  }
  if (restored > 0) schedulePersist();
  return restored;
}

/** Remove expired entries and return the number removed. */
export function sweepExpiredGoogleThoughtSignatures(at = Date.now()): number {
  ensureLoaded();
  let removed = 0;
  for (const [key, entry] of entries) {
    if (at - entry.updatedAt < TTL_MS) continue;
    entries.delete(key);
    totalBytes -= entry.sizeBytes;
    removed += 1;
  }
  if (removed > 0) schedulePersist();
  return removed;
}

/** Flush the current snapshot atomically, serializing concurrent writes. */
export async function flushGoogleThoughtSignatures(): Promise<void> {
  ensureLoaded();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const path = snapshotPath();
  if (entries.size === 0 && !existsSync(path)) return;
  const content = JSON.stringify({ version: 1, entries: [...entries.values()].map(({ key, signature, updatedAt }) => ({ key, signature, updatedAt })) });
  persistGate = persistGate.catch(() => undefined).then(async () => {
    if (Buffer.byteLength(content, "utf8") > SNAPSHOT_MAX_BYTES) throw new Error("Google signature snapshot exceeded its size cap");
    await atomicWriteFileAsync(path, content);
  });
  await persistGate;
}

/** Return privacy-safe retained-store accounting for the process memory budget. */
export function googleThoughtSignatureLedgerSnapshot(): RetainedStoreSnapshot {
  let oldestAt: number | null = null;
  for (const entry of entries.values()) oldestAt = oldestAt === null ? entry.updatedAt : Math.min(oldestAt, entry.updatedAt);
  return { count: entries.size, bytes: totalBytes, evictableBytes: totalBytes, pinnedBytes: 0, oldestAt };
}

/** Evict the oldest ledger entry to satisfy the application-owned memory budget. */
export function evictOldestGoogleThoughtSignature(): number {
  ensureLoaded();
  const key = entries.keys().next().value as string | undefined;
  if (!key) return 0;
  const entry = entries.get(key);
  entries.delete(key);
  if (!entry) return 0;
  totalBytes -= entry.sizeBytes;
  schedulePersist();
  return entry.sizeBytes;
}

/** Test-only: direct snapshot path override, scoped to a temporary test directory. */
export function setGoogleThoughtSignatureSnapshotPathForTests(path: string | null): void {
  snapshotPathOverrideForTests = path;
  resetGoogleThoughtSignatureLedgerMemoryForTests();
}

/** Test-only: simulate a process restart while preserving the snapshot file. */
export function resetGoogleThoughtSignatureLedgerMemoryForTests(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  entries.clear();
  totalBytes = 0;
  loaded = false;
  persistGate = Promise.resolve();
}

/** Test-only: clear in-memory state and any pending debounce. */
export function clearGoogleThoughtSignatureLedgerForTests(): void {
  resetGoogleThoughtSignatureLedgerMemoryForTests();
  if (snapshotPathOverrideForTests) {
    try { unlinkSync(snapshotPathOverrideForTests); } catch { /* no test snapshot */ }
  }
  snapshotPathOverrideForTests = null;
}
