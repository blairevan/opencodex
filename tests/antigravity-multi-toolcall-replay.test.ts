
import { describe, expect, test, beforeEach } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import {
  __resetAntigravityReplayCache,
} from "../src/adapters/google-antigravity-replay";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const MODEL = "gemini-3.7-flash";
const SIG = "sig-valid-thought-signature-0123456789";

const provider = {
  adapter: "google",
  googleMode: "cloud-code-assist",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  apiKey: "test-token",
  project: "test-project",
} as OcxProviderConfig;

describe("parallel streaming tool-call thought-signature preservation", () => {
  beforeEach(() => __resetAntigravityReplayCache());

  test("preserves the signature only on the first parallel tool call across SSE chunks", async () => {
    const adapter = createGoogleAdapter(provider);
    const parsedRequest = {
      modelId: MODEL,
      _clientThreadId: "fixture-parallel-stream",
      stream: true,
      context: {
        messages: [{ role: "user", content: "run multiple commands" }],
        systemPrompt: [],
        tools: [{ name: "exec", description: "exec", parameters: { type: "object" } }],
      },
      options: {},
    } as unknown as OcxParsedRequest;

    await adapter.buildRequest(parsedRequest);

    // Simulate multi-chunk SSE stream:
    // Chunk 1: Thought part with signature
    // Chunk 2-6: Function call parts across subsequent SSE lines
    const sseLines = [
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ thought: true, text: "thinking...", thoughtSignature: SIG }] } }] } })}\n\n`,
      ...[1, 2, 3, 4, 5].map(i =>
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { name: "default_api__exec", args: { cmd: "cmd_" + i } } }] } }] } })}\n\n`
      ),
    ];

    const response = new Response(sseLines.join(""), {
      headers: { "content-type": "text/event-stream" },
    });

    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(response)) {
      events.push(event);
    }

    // Parallel calls share one model step: only the first call carries the signature.
    const starts = events.filter(e => e.type === "tool_call_start");
    expect(starts.length).toBe(5);
    expect((starts[0] as unknown as { providerMetadata?: { google?: { thoughtSignature?: string } } }).providerMetadata?.google?.thoughtSignature).toBe(SIG);
    for (const s of starts.slice(1)) {
      expect((s as unknown as { providerMetadata?: { google?: { thoughtSignature?: string } } }).providerMetadata?.google?.thoughtSignature).toBeUndefined();
    }

    // Verify replay cache can re-inject into follow-up request contents
    parsedRequest.context.messages.push({ role: "assistant", content: [1, 2, 3, 4, 5].map(i => ({
      type: "toolCall", id: `call-${i}`, name: "default_api__exec", arguments: { cmd: "cmd_" + i },
    })) });
    const replay = await createGoogleAdapter(provider).buildRequest(parsedRequest);
    const envelope = JSON.parse(replay.body as string) as { request: { contents: Array<{ role: string; parts: Array<{ thoughtSignature?: string }> }> } };
    const parts = envelope.request.contents.find(content => content.role === "model")?.parts ?? [];

    expect(parts[0]?.thoughtSignature).toBe(SIG);
    for (let i = 1; i < 5; i++) {
      expect(parts[i]?.thoughtSignature).toBeUndefined();
    }
  });
});
