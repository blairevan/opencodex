/**
 * #1735: a Gemini thought signature must survive a HISTORY-driven turn, where the same-process
 * replay cache is not available — the exact case the cache was masking.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { __resetAntigravityReplayCache } from "../src/adapters/google-antigravity-replay";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const SIGNATURE = "CiQAx-history-thought-signature-0123456789abcdef";
const SIGNATURE_B = "CiQAx-history-thought-signature-second-call-99";
const MODEL = "gemini-3.6-flash";
const CCA_MODEL = "gemini-3.7-flash";

const provider = {
  adapter: "google",
  googleMode: "vertex",
  baseUrl: "https://aiplatform.googleapis.com",
  apiKey: "vertex-test-key",
} as OcxProviderConfig;

const antigravityProvider = {
  adapter: "google",
  googleMode: "cloud-code-assist",
  baseUrl: "https://cloudcode-pa.googleapis.com",
  apiKey: "antigravity-test-token",
  project: "test-project",
} as OcxProviderConfig;

function firstTurn(): OcxParsedRequest {
  return {
    modelId: MODEL,
    stream: false,
    context: {
      messages: [{ role: "user", content: "run pwd" }],
      systemPrompt: [],
      tools: [{ name: "shell_command", description: "run a command", parameters: { type: "object" } }],
    },
    options: {},
  } as unknown as OcxParsedRequest;
}

function googleBody(parts: Record<string, unknown>[]): Record<string, unknown> {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  };
}

function modelParts(body: string): Record<string, unknown>[] {
  const parsed = JSON.parse(body) as { contents: Array<{ role?: string; parts?: Record<string, unknown>[] }> };
  return parsed.contents.find(content => content.role === "model")?.parts ?? [];
}

describe("#1735 thought signature survives history replay", () => {
  beforeEach(() => __resetAntigravityReplayCache());

  test("the adapter attaches the signature to the tool call that produced it", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    const events = await adapter.parseResponse!(new Response(JSON.stringify(googleBody([
      { functionCall: { name: "shell_command", args: { command: "pwd" } }, thoughtSignature: SIGNATURE },
    ]))));
    const start = events.find((e: AdapterEvent) => e.type === "tool_call_start");
    expect(start && "providerMetadata" in start ? start.providerMetadata?.google?.thoughtSignature : undefined)
      .toBe(SIGNATURE);
  });

  test("parallel calls each keep their own signature", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    const events = await adapter.parseResponse!(new Response(JSON.stringify(googleBody([
      { functionCall: { name: "shell_command", args: { command: "pwd" } }, thoughtSignature: SIGNATURE },
      { functionCall: { name: "shell_command", args: { command: "ls" } }, thoughtSignature: SIGNATURE_B },
    ]))));
    const signatures = events
      .filter((e: AdapterEvent) => e.type === "tool_call_start")
      .map((e: AdapterEvent) => ("providerMetadata" in e ? e.providerMetadata?.google?.thoughtSignature : undefined));
    // Neither signature may migrate onto the other call.
    expect(signatures).toEqual([SIGNATURE, SIGNATURE_B]);
  });

  test("upstream signature aliases are normalized into provider metadata without charset guessing", async () => {
    const variants: Array<Record<string, unknown>> = [
      { thought_signature: SIGNATURE },
      { extra_content: { google: { thought_signature: SIGNATURE } } },
      { thoughtSignature: "opaque:provider:signature:with:new-charset" },
    ];
    for (const variant of variants) {
      const adapter = createGoogleAdapter(provider);
      await adapter.buildRequest(firstTurn());
      const events = await adapter.parseResponse!(new Response(JSON.stringify(googleBody([
        { functionCall: { name: "shell_command", args: { command: "pwd" } }, ...variant },
      ]))));
      const start = events.find((e: AdapterEvent) => e.type === "tool_call_start");
      const expected = typeof variant.thoughtSignature === "string" ? variant.thoughtSignature : SIGNATURE;
      expect(start && "providerMetadata" in start ? start.providerMetadata?.google?.thoughtSignature : undefined)
        .toBe(expected);
    }
  });

  test("opaque provider metadata survives Responses history into the rebuilt Google part", async () => {
    const opaqueSignature = "opaque:provider:signature:with:new-charset";
    const parsed = parseRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        {
          type: "function_call",
          call_id: "call_shell_opaque",
          name: "shell_command",
          arguments: JSON.stringify({ command: "pwd" }),
          extra_content: { google: { thought_signature: opaqueSignature } },
        },
        { type: "function_call_output", call_id: "call_shell_opaque", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });

    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(opaqueSignature);
  });

  test("client synthetic ids in custom_tool_call extra_content are not forwarded as Google signatures", async () => {
    const parsed = parseRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        {
          type: "custom_tool_call",
          call_id: "call_exec_synthetic",
          name: "exec",
          input: "pwd",
          extra_content: { google: { thought_signature: "ctc_038f26d3f20962bc016a54f0fcfa208190a8ec0f289c2ba211" } },
        },
        { type: "custom_tool_call_output", call_id: "call_exec_synthetic", output: "ok" },
      ],
      tools: [{ type: "custom", name: "exec", description: "run shell input" }],
    });

    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBeUndefined();
  });

  test("custom exec history with empty extra_content is rescued by the Antigravity replay cache", async () => {
    const first = parseRequest({
      model: CCA_MODEL,
      input: "run pwd",
      tools: [{ type: "custom", name: "exec", description: "run shell input" }],
    });
    const firstAdapter = createGoogleAdapter(antigravityProvider);
    await firstAdapter.buildRequest(first);
    await firstAdapter.parseResponse!(new Response(JSON.stringify({
      response: googleBody([
        { functionCall: { name: "exec", args: { input: "pwd" } }, thoughtSignature: SIGNATURE },
      ]),
    })));

    // Simulate the exact failure symptom seen in Codex history: the custom_tool_call came back
    // without provider extra_content. A fresh adapter instance mirrors production request scope;
    // only the module-level replay cache can restore the signature here.
    const followup = parseRequest({
      model: CCA_MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "custom_tool_call", call_id: "call_exec_1", name: "exec", input: "pwd" },
        { type: "custom_tool_call_output", call_id: "call_exec_1", output: "ok" },
      ],
      tools: [{ type: "custom", name: "exec", description: "run shell input" }],
    });
    const request = await createGoogleAdapter(antigravityProvider).buildRequest(followup);
    const envelope = JSON.parse(request.body as string) as {
      request?: { contents?: Array<{ role?: string; parts?: Record<string, unknown>[] }> };
    };
    const parts = envelope.request?.contents?.find(content => content.role === "model")?.parts ?? [];
    const functionCallPart = parts.find(part => "functionCall" in part);
    expect(functionCallPart?.thoughtSignature).toBe(SIGNATURE);
  });

  test("a signature replayed through Responses history reaches the rebuilt Google part", async () => {
    // No cache is warmed here: this is a cold process replaying client-supplied history.
    const parsed = parseRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        {
          type: "function_call",
          call_id: "call_shell_1",
          name: "shell_command",
          arguments: JSON.stringify({ command: "pwd" }),
          extra_content: { google: { thought_signature: SIGNATURE } },
        },
        { type: "function_call_output", call_id: "call_shell_1", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });

    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(SIGNATURE);
  });

  test("history without a signature stays unsigned rather than borrowing one", async () => {
    const parsed = parseRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "function_call", call_id: "call_shell_1", name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) },
        { type: "function_call_output", call_id: "call_shell_1", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBeUndefined();
  });
});
