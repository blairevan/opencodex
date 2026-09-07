/**
 * Synthetic Responses/tool-call identifiers that must never be promoted into provider-owned
 * opaque state such as Gemini thought signatures. Keep this check prefix-only so provider tokens
 * remain otherwise opaque and are not constrained to a guessed character set.
 */
export function isSyntheticToolCallIdLike(value: string): boolean {
  return /^(fc|ctc|tsc|call|msg|rs|resp|reasoning|item|ws|toolu|tool|func|function)[-_]/i.test(value);
}
