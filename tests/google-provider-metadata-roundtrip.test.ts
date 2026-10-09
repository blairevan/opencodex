import { describe, expect, test } from "bun:test";
import {
  providerMetadataFromResponsesFunctionCall,
  responsesExtraContentFromProviderMetadata,
} from "../src/responses/provider-opaque-metadata";

const SIGNATURE = "CiQAx-provider-opaque-signature-0123456789abcdef";

describe("Google provider-opaque tool-call metadata", () => {
  test("round-trips an opaque signature through the Responses function-call wire shape", () => {
    const wire = responsesExtraContentFromProviderMetadata({
      google: { thoughtSignature: SIGNATURE },
    });

    expect(wire).toEqual({
      extra_content: { google: { thought_signature: SIGNATURE } },
    });
    expect(providerMetadataFromResponsesFunctionCall(wire)).toEqual({
      google: { thoughtSignature: SIGNATURE },
    });
  });
});
