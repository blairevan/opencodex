import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { __resetAntigravityReplayCache } from "../src/adapters/google-antigravity-replay";
import { clearGoogleThoughtSignatureLedgerForTests, createGoogleThoughtSignatureScope, flushGoogleThoughtSignatures, rememberGoogleOriginalToolCall, resetGoogleThoughtSignatureLedgerMemoryForTests, restoreGoogleThoughtSignatures } from "../src/responses/google-thought-signature-ledger";
import { startServer } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const SIGNATURE = "opaque-continuation-signature-fixture";
const MODEL = "gemini-3.8-flash-medium";
const ORIGINAL_ARGS = { code: "text(1);" };
const originalFetch = globalThis.fetch;
let directory = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  directory = mkdtempSync(join(tmpdir(), "ocx-google-continuation-"));
  process.env.OPENCODEX_HOME = directory;
  codexHome = installIsolatedCodexHome("ocx-google-continuation-codex-");
  __resetAntigravityReplayCache();
  clearGoogleThoughtSignatureLedgerForTests();
  saveConfig({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "google", googleMode: "cloud-code-assist", authMode: "oauth",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        models: [MODEL], defaultModel: MODEL,
      },
    },
  } satisfies OcxConfig);
  writeFileSync(join(directory, "auth.json"), JSON.stringify({
    "google-antigravity": {
      activeAccountId: "fixture-account",
      accounts: [{
        id: "fixture-account",
        credential: { access: "fixture-only", refresh: "fixture-only", expires: 9999999999999, projectId: "fixture-project" },
      }],
    },
  }), { mode: 0o600 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetAntigravityReplayCache();
  clearGoogleThoughtSignatureLedgerForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome.restore();
  rmSync(directory, { recursive: true, force: true });
});

describe("Google custom-tool continuation through HTTP", () => {
  test("records a failover account's signed call under the serving account rather than the rejected account", async () => {
    saveConfig({ ...loadConfig(), antigravityAccountPool: { enabled: true, strategy: "fill-first" } });
    writeFileSync(join(directory, "auth.json"), JSON.stringify({
      "google-antigravity": {
        activeAccountId: "fixture-account",
        accounts: ["fixture-account", "fixture-alternate"].map(id => ({
          id, credential: { access: id, refresh: "fixture-only", expires: 9999999999999, projectId: id },
        })),
      },
    }), { mode: 0o600 });
    const servingProjects: string[] = [];
    const historySignatures: unknown[] = [];
    const originalScope = createGoogleThoughtSignatureScope({
      destination: "https://daily-cloudcode-pa.googleapis.com", account: "fixture-account", project: "fixture-account",
      wireModel: MODEL, conversation: "fixture-failover-thread",
    });
    rememberGoogleOriginalToolCall(originalScope, "call-prior-account", "prior-account-signature", "exec", ORIGINAL_ARGS);
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).hostname === "127.0.0.1") return originalFetch(input, init);
      if (!url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) throw new Error("Unexpected external test request");
      if (!url.includes(":generateContent")) return Response.json({});
      const request = JSON.parse(String(init?.body)) as {
        project: string; request: { contents: Array<{ parts: Array<{ functionCall?: unknown; thoughtSignature?: string }> }> };
      };
      servingProjects.push(request.project);
      historySignatures.push(request.request.contents.flatMap(content => content.parts).find(part => part.functionCall)?.thoughtSignature);
      if (request.project === "fixture-account") {
        return Response.json({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }, { status: 429 });
      }
      return Response.json({ response: {
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "exec", args: ORIGINAL_ARGS }, thoughtSignature: SIGNATURE }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      } });
    }, { preconnect: originalFetch.preconnect });
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST", headers: { "content-type": "application/json", "session_id": "fixture-failover-thread" },
        body: JSON.stringify({ model: `google-antigravity/${MODEL}`, input: [
          { role: "user", content: "Run a tool" },
          { type: "custom_tool_call", call_id: "call-prior-account", name: "exec", input: JSON.stringify(ORIGINAL_ARGS) },
          { type: "custom_tool_call_output", call_id: "call-prior-account", output: "SyntaxError" },
        ], stream: false,
          tools: [{ type: "custom", name: "exec", description: "Execute JavaScript." }] }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { output: Array<{ type: string; call_id: string; input: string }> };
      const tool = body.output.find(item => item.type === "custom_tool_call");
      if (!tool) throw new Error("Expected a serving-account tool call");
      expect(servingProjects).toEqual(["fixture-account", "fixture-alternate"]);
      expect(historySignatures).toEqual(["prior-account-signature", undefined]);
      for (const account of ["fixture-account", "fixture-alternate"]) {
        const scope = createGoogleThoughtSignatureScope({
          destination: "https://daily-cloudcode-pa.googleapis.com", account, project: account,
          wireModel: MODEL, conversation: "fixture-failover-thread",
        });
        const history = parseRequest({ model: MODEL,
          input: [{ type: "custom_tool_call", call_id: tool.call_id, name: "exec", input: tool.input }] });
        expect(restoreGoogleThoughtSignatures(scope, history.context.messages)).toBe(account === "fixture-alternate" ? 1 : 0);
      }
    } finally {
      await server.stop(true);
    }
  });

  for (const stream of [true, false]) test(`restores the exact signed call after custom-tool wrapping (stream=${stream})`, async () => {
    const requests: Array<{ request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> } }> = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
        if (new URL(url).hostname === "127.0.0.1") return originalFetch(input, init);
        throw new Error("Unexpected external request in continuation test");
      }
      requests.push(JSON.parse(String(init?.body)));
      const parts = requests.length === 1
        ? [{ functionCall: { name: "exec", args: ORIGINAL_ARGS }, thoughtSignature: SIGNATURE }]
        : [{ text: "Recovered from the tool error." }];
      const frame = { response: {
        candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      } };
      return stream ? new Response(`data: ${JSON.stringify(frame)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }) : Response.json(frame);
    }, { preconnect: originalFetch.preconnect });
    const server = startServer(0);
    try {
      const tools = [{ type: "custom", name: "exec", description: "Execute JavaScript source." }];
      const headers = { "content-type": "application/json", "session_id": "fixture-thread" };
      const first = await fetch(new URL("/v1/responses", server.url), {
        method: "POST", headers,
        body: JSON.stringify({ model: `google-antigravity/${MODEL}`, input: "Run a tool", tools, stream }),
      });
      expect(first.status).toBe(200);
      type ToolItem = { type: string; name: string; call_id: string; input: string; extra_content?: { google?: { thought_signature?: string } } };
      type ResponseBody = { output: ToolItem[] };
      const payload = await first.text();
      const completed = stream
        ? (payload.split("\n").filter(line => line.startsWith("data: {"))
          .map(line => JSON.parse(line.slice(6)) as { type: string; response?: ResponseBody })
          .find(frame => frame.type === "response.completed")?.response)
        : JSON.parse(payload) as ResponseBody;
      expect(completed).toBeDefined();
      const call = completed?.output.find(item => item.type === "custom_tool_call");
      expect(call).toBeDefined();
      if (!call) throw new Error("Expected a completed custom-tool call");
      expect(call.extra_content?.google?.thought_signature).toBe(SIGNATURE);
      // Both replay caches must survive a cold in-memory restart; only the exact-id ledger
      // can recover the original arguments after the client strips provider extra_content.
      await flushGoogleThoughtSignatures();
      resetGoogleThoughtSignatureLedgerMemoryForTests();
      __resetAntigravityReplayCache();
      const second = await fetch(new URL("/v1/responses", server.url), {
        method: "POST", headers,
        body: JSON.stringify({
          model: `google-antigravity/${MODEL}`, tools, stream,
          input: [
            { role: "user", content: "Run a tool" },
            { type: "custom_tool_call", call_id: call.call_id, name: call.name, input: call.input },
            { type: "custom_tool_call_output", call_id: call.call_id, output: "SyntaxError: Unexpected token ':'" },
          ],
        }),
      });
      expect(second.status).toBe(200);
      await second.text();
      expect(requests).toHaveLength(2);
      const replayed = requests[1]?.request.contents.flatMap(content => content.parts).find(part => part.functionCall);
      expect(replayed?.thoughtSignature).toBe(SIGNATURE);
      expect(replayed?.functionCall).toMatchObject({ name: "exec", args: ORIGINAL_ARGS });
    } finally {
      await server.stop(true);
    }
  });
});
