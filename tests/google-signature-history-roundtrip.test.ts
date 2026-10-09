import { afterEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { parseRequest } from "../src/responses/parser";
import {
  clearGoogleThoughtSignatureLedgerForTests,
  createGoogleThoughtSignatureScope,
  rememberGoogleThoughtSignatures,
  restoreGoogleThoughtSignatures,
} from "../src/responses/google-thought-signature-ledger";
import type { OcxProviderConfig } from "../src/types";

const signature = "CiQAx-long-history-signature-0123456789abcdef";
const provider = {
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  googleMode: "cloud-code-assist",
  project: "project-roundtrip",
  apiKey: "oauth-token-fixture",
} as OcxProviderConfig;

function scopeFor(conversation: string) {
  return createGoogleThoughtSignatureScope({
    destination: provider.baseUrl,
    project: provider.project ?? "",
    account: "account-roundtrip",
    wireModel: "gemini-3.6-flash",
    conversation,
  });
}

afterEach(() => clearGoogleThoughtSignatureLedgerForTests());

describe("Google thought-signature history round trip", () => {
  test("restores the exact early call after 257 history items and forwards it to Antigravity", async () => {
    const scope = scopeFor("thread-roundtrip");
    const output = Array.from({ length: 257 }, (_, index) => ({
      type: "custom_tool_call",
      id: `ctc_${index}`,
      call_id: `call-long-${index}`,
      name: "exec",
      input: "same command",
      status: "completed",
      ...(index === 0 ? { extra_content: { google: { thought_signature: signature } } } : {}),
    }));
    expect(rememberGoogleThoughtSignatures(scope, output)).toBe(1);

    const parsed = parseRequest({
      model: "gemini-3.6-flash",
      input: [
        ...output.map(item => ({ type: item.type, call_id: item.call_id, name: item.name, input: item.input })),
        { type: "function_call_output", call_id: "call-long-0", output: "done" },
      ],
    });
    expect(parsed.context.messages.flatMap(message => message.role === "assistant"
      ? message.content.filter(part => part.type === "toolCall").map(part => part.type === "toolCall" ? part.id : "")
      : []).slice(0, 3)).toEqual(["call-long-0", "call-long-1", "call-long-2"]);
    expect(restoreGoogleThoughtSignatures(scope, parsed.context.messages)).toBe(1);

    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const envelope = JSON.parse(request.body);
    const modelTurn = envelope.request.contents.find((content: { role: string }) => content.role === "model");
    const functionCallPart = modelTurn.parts.find((part: Record<string, unknown>) => "functionCall" in part);

    expect(functionCallPart.thoughtSignature).toBe(signature);
  });

  test("the same call id in another conversation does not receive the signature", async () => {
    const originalScope = scopeFor("thread-original");
    const foreignScope = scopeFor("thread-foreign");
    rememberGoogleThoughtSignatures(originalScope, [{
      type: "function_call",
      call_id: "call-shared",
      extra_content: { google: { thought_signature: signature } },
    }]);
    const parsed = parseRequest({
      model: "gemini-3.6-flash",
      input: [
        { type: "function_call", call_id: "call-shared", name: "exec", arguments: "{}" },
        { type: "function_call_output", call_id: "call-shared", output: "done" },
      ],
    });

    expect(restoreGoogleThoughtSignatures(foreignScope, parsed.context.messages)).toBe(0);
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const envelope = JSON.parse(request.body);
    const modelTurn = envelope.request.contents.find((content: { role: string }) => content.role === "model");
    const functionCallPart = modelTurn.parts.find((part: Record<string, unknown>) => "functionCall" in part);

    expect(functionCallPart.thoughtSignature).toBeUndefined();
  });
});
