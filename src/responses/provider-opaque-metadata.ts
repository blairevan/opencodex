import type { OcxProviderOpaqueToolCallMetadata } from "../types";

/** Wire shape accepted by the Responses function-call protocol. */
interface ResponsesExtraContent {
  google?: { thought_signature?: unknown };
}

const MAX_SIGNATURE_BYTES = 64 * 1024;

/** Return true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return true when a signature is bounded and safe to retain as opaque metadata. */
function isCarryableSignature(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_SIGNATURE_BYTES;
}

/** Read Google provider metadata from a Responses function-call item. */
export function providerMetadataFromResponsesFunctionCall(
  item: { extra_content?: unknown } | undefined,
): OcxProviderOpaqueToolCallMetadata | undefined {
  if (!isRecord(item?.extra_content)) return undefined;
  const google = (item.extra_content as ResponsesExtraContent).google;
  if (!isRecord(google) || !isCarryableSignature(google.thought_signature)) return undefined;
  return { google: { thoughtSignature: google.thought_signature } };
}

/** Read an upstream Google function-call signature without interpreting its opaque format. */
export function providerMetadataFromGoogleFunctionCallPart(
  part: unknown,
): OcxProviderOpaqueToolCallMetadata | undefined {
  if (!isRecord(part)) return undefined;
  const direct = part.thoughtSignature ?? part.thought_signature;
  if (isCarryableSignature(direct)) return { google: { thoughtSignature: direct } };
  const nested = providerMetadataFromResponsesFunctionCall({ extra_content: part.extra_content });
  return nested;
}

/** Serialize Google provider metadata onto a Responses function-call item. */
export function responsesExtraContentFromProviderMetadata(
  metadata: OcxProviderOpaqueToolCallMetadata | undefined,
): { extra_content: { google: { thought_signature: string } } } | undefined {
  const signature = metadata?.google?.thoughtSignature;
  if (!isCarryableSignature(signature)) return undefined;
  return { extra_content: { google: { thought_signature: signature } } };
}
