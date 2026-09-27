import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearGoogleThoughtSignatureLedgerForTests,
  createGoogleThoughtSignatureScope,
  rememberGoogleThoughtSignatures,
  resetGoogleThoughtSignatureLedgerMemoryForTests,
  restoreGoogleThoughtSignatures,
  setGoogleThoughtSignatureSnapshotPathForTests,
  sweepExpiredGoogleThoughtSignatures,
} from "../src/responses/google-thought-signature-ledger";
import type { OcxMessage } from "../src/types";

const SIGNATURE = "opaque-google-signature-for-ledger-test";

function call(id: string, providerMetadata?: { google?: { thoughtSignature?: string } }): OcxMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", arguments: { command: "same" }, providerMetadata }],
  } as OcxMessage;
}

const scope = () => createGoogleThoughtSignatureScope({
  destination: "https://daily-cloudcode-pa.googleapis.com",
  project: "project-a",
  account: "account-a",
  wireModel: "gemini-3.6-flash",
  conversation: "thread-a",
});

afterEach(() => clearGoogleThoughtSignatureLedgerForTests());

describe("Google thought-signature ledger", () => {
  test("restores by exact Responses call id even when arguments are identical", () => {
    rememberGoogleThoughtSignatures(scope(), [{
      type: "custom_tool_call",
      call_id: "call-a",
      extra_content: { google: { thought_signature: SIGNATURE } },
    }]);

    const messages = [call("call-a"), call("call-b")];
    const restored = restoreGoogleThoughtSignatures(scope(), messages);

    expect(restored).toBe(1);
    expect(messages[0]?.content[0]?.type === "toolCall" && messages[0].content[0].providerMetadata?.google?.thoughtSignature).toBe(SIGNATURE);
    expect(messages[1]?.content[0]?.type === "toolCall" && messages[1].content[0].providerMetadata?.google?.thoughtSignature).toBeUndefined();
  });

  test("isolates signatures by route and conversation scope", () => {
    rememberGoogleThoughtSignatures(scope(), [{
      type: "function_call",
      call_id: "call-a",
      extra_content: { google: { thought_signature: SIGNATURE } },
    }]);
    const foreignScope = createGoogleThoughtSignatureScope({
      destination: "https://daily-cloudcode-pa.googleapis.com",
      project: "project-a",
      account: "account-b",
      wireModel: "gemini-3.6-flash",
      conversation: "thread-a",
    });
    const messages = [call("call-a")];

    expect(restoreGoogleThoughtSignatures(foreignScope, messages)).toBe(0);
    expect(messages[0]?.content[0]?.type === "toolCall" && messages[0].content[0].providerMetadata).toBeUndefined();
  });

  test("rejects synthetic Responses item ids as call ids", () => {
    expect(rememberGoogleThoughtSignatures(scope(), [{
      type: "function_call",
      call_id: "fc_synthetic_item_id",
      extra_content: { google: { thought_signature: SIGNATURE } },
    }])).toBe(0);
  });

  test("retains an early call across a history longer than the replay-cache window", () => {
    const output = Array.from({ length: 257 }, (_, index) => ({
      type: "custom_tool_call",
      call_id: `call-long-${index}`,
      extra_content: { google: { thought_signature: `${SIGNATURE}-${index}` } },
    }));
    expect(rememberGoogleThoughtSignatures(scope(), output)).toBe(257);

    const history = Array.from({ length: 257 }, (_, index) => call(`call-long-${index}`));
    expect(restoreGoogleThoughtSignatures(scope(), history)).toBe(257);
    expect(history[0]?.content[0]?.type === "toolCall" && history[0].content[0].providerMetadata?.google?.thoughtSignature).toBe(`${SIGNATURE}-0`);
  });

  test("expires entries after the one-hour continuation window", () => {
    rememberGoogleThoughtSignatures(scope(), [{
      type: "function_call",
      call_id: "call-expired",
      extra_content: { google: { thought_signature: SIGNATURE } },
    }]);

    expect(sweepExpiredGoogleThoughtSignatures(Date.now() + 60 * 60 * 1_000 + 1)).toBe(1);
    expect(restoreGoogleThoughtSignatures(scope(), [call("call-expired")])).toBe(0);
  });

  test("evicts oldest entries when the aggregate signature-byte cap is reached", () => {
    const largeSignature = "s".repeat(64 * 1024);
    const output = Array.from({ length: 260 }, (_, index) => ({
      type: "function_call",
      call_id: `call-byte-cap-${index}`,
      extra_content: { google: { thought_signature: largeSignature } },
    }));
    rememberGoogleThoughtSignatures(scope(), output);
    const history = Array.from({ length: 260 }, (_, index) => call(`call-byte-cap-${index}`));

    const restored = restoreGoogleThoughtSignatures(scope(), history);

    expect(restored).toBeLessThan(260);
    expect(history[0]?.content[0]?.type === "toolCall" && history[0].content[0].providerMetadata).toBeUndefined();
    expect(history[259]?.content[0]?.type === "toolCall" && history[259].content[0].providerMetadata?.google?.thoughtSignature).toBe(largeSignature);
  });

  test("loads exact call signatures from an atomic snapshot after an in-memory restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-google-signatures-"));
    const path = join(directory, "ledger.json");
    setGoogleThoughtSignatureSnapshotPathForTests(path);
    rememberGoogleThoughtSignatures(scope(), [{
      type: "function_call",
      call_id: "call-persisted",
      extra_content: { google: { thought_signature: SIGNATURE } },
    }]);
    const { flushGoogleThoughtSignatures } = await import("../src/responses/google-thought-signature-ledger");
    await flushGoogleThoughtSignatures();
    resetGoogleThoughtSignatureLedgerMemoryForTests();

    const messages = [call("call-persisted")];
    expect(restoreGoogleThoughtSignatures(scope(), messages)).toBe(1);
    expect(messages[0]?.content[0]?.type === "toolCall" && messages[0].content[0].providerMetadata?.google?.thoughtSignature).toBe(SIGNATURE);

    clearGoogleThoughtSignatureLedgerForTests();
    rmSync(directory, { recursive: true, force: true });
  });

  test("fails closed on a corrupt snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-google-signatures-corrupt-"));
    const path = join(directory, "ledger.json");
    writeFileSync(path, "{ invalid json");
    setGoogleThoughtSignatureSnapshotPathForTests(path);

    expect(restoreGoogleThoughtSignatures(scope(), [call("call-corrupt")])).toBe(0);

    clearGoogleThoughtSignatureLedgerForTests();
    rmSync(directory, { recursive: true, force: true });
  });
});
