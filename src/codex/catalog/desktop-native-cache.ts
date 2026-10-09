import { createHash } from "node:crypto";
import type { RawEntry } from "./parsing";

/** Marks model rows projected from Codex Desktop's active model cache. */
export const CODEX_DESKTOP_NATIVE_CATALOG_KIND = "codex-desktop-native-v1";

const MODEL_SLUG_PATTERN = /^(?:gpt|codex|o[1-9])-[a-z0-9][a-z0-9._-]*$/i;
const DESKTOP_SHELL_TYPES = new Set(["unified_exec", "shell_command"]);
const MIRRORED_FIELDS = [
  "display_name",
  "description",
  "default_reasoning_level",
  "supported_reasoning_levels",
  "context_window",
  "max_context_window",
  "max_input_tokens",
  "input_modalities",
  "shell_type",
  "supports_parallel_tool_calls",
  "supports_image_generation",
  "supports_reasoning_summaries",
  "reasoning_summary_format",
  "priority",
] as const;
const FINGERPRINT_FIELD = "opencodex_desktop_native_fingerprint";

/** Select currently visible native model rows from a Desktop cache snapshot. */
export function desktopNativeModelRows(rows: readonly unknown[]): RawEntry[] {
  return rows.flatMap(value => {
    if (!isRawEntry(value)) return [];
    const row = value;
    const slug = typeof row.slug === "string" ? row.slug : "";
    const levels = row.supported_reasoning_levels;
    const accepted = MODEL_SLUG_PATTERN.test(slug)
      && row.visibility === "list"
      && row.supported_in_api === true
      && typeof row.shell_type === "string"
      && DESKTOP_SHELL_TYPES.has(row.shell_type)
      && typeof row.context_window === "number"
      && row.context_window > 0
      && Array.isArray(levels)
      && levels.length > 0
      && levels.every(level => typeof level === "object"
        && level !== null
        && typeof (level as { effort?: unknown }).effort === "string"
        && (level as { effort: string }).effort.trim().length > 0);
    return accepted ? [row] : [];
  });
}

/** Project Desktop's public model fields onto a known native template, excluding prompt text. */
export function projectDesktopNativeModelRow(
  template: RawEntry | null,
  observed: RawEntry,
): RawEntry | null {
  const slug = typeof observed.slug === "string" ? observed.slug : "";
  if (!template || desktopNativeModelRows([observed]).length === 0) return null;

  const projected = structuredClone(template) as RawEntry;
  for (const field of MIRRORED_FIELDS) {
    const value = observed[field];
    if (value !== undefined) projected[field] = structuredClone(value);
  }
  projected.slug = slug;
  projected.visibility = "list";
  projected.supported_in_api = true;
  projected.opencodex_catalog_kind = CODEX_DESKTOP_NATIVE_CATALOG_KIND;
  projected[FINGERPRINT_FIELD] = cacheRowFingerprint(observed);
  return projected;
}

/** Check whether a catalog row was generated from an accepted Desktop cache row. */
export function isDesktopNativeCatalogRow(entry: RawEntry): boolean {
  return entry.opencodex_catalog_kind === CODEX_DESKTOP_NATIVE_CATALOG_KIND
    && typeof entry.slug === "string"
    && MODEL_SLUG_PATTERN.test(entry.slug);
}

/** Replace owned Desktop rows by slug, repairing historical duplicates without changing foreign rows. */
export function reconcileDesktopNativeCatalogRows(
  prior: readonly RawEntry[],
  current: readonly RawEntry[],
  authoritative: boolean,
): RawEntry[] {
  const foreign = prior.filter(entry => !isDesktopNativeCatalogRow(entry));
  const owned = new Map<string, RawEntry>();
  for (const entry of authoritative ? current : [...prior, ...current]) {
    if (isDesktopNativeCatalogRow(entry) && typeof entry.slug === "string") {
      owned.set(entry.slug, entry);
    }
  }
  return [...foreign, ...owned.values()];
}

/** Compare the capabilities OpenCodex mirrors, ignoring Desktop prompt and session fields. */
export function desktopNativeRowMatchesCache(entry: RawEntry, observed: RawEntry): boolean {
  return entry.slug === observed.slug
    && entry[FINGERPRINT_FIELD] === cacheRowFingerprint(observed);
}

/** Hash only mirrored model metadata so Desktop changes can be detected without copying prompts. */
function cacheRowFingerprint(entry: RawEntry): string {
  const content = MIRRORED_FIELDS.map(field => [field, entry[field] ?? null]);
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Narrow JSON file values before reading cache fields. */
function isRawEntry(value: unknown): value is RawEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
