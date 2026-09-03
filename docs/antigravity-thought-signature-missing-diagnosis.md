# Google Antigravity / Gemini 多工具调用 thought_signature 丢失导致 400 报错分析

> **修订说明（2026-09-03 第二版 - 经会话日志回放与代码实测）**
>
> 通过提取 2026-09-03 08:47:14 真实的崩溃会话日志（Session ID: `01a064bb-5f58-7172-9864-311386d66f1a.jsonl`）并编写 Bun 脚本进行全链路回放测试，**确认了真实故障的精确代码断点**：
> 崩溃的真实根因在于 `src/bridge.ts` 中，当输出 `custom_tool_call`（如 `exec`、`apply_patch` 等 freeform 工具）或 `tool_search_call` 时，**遗漏了 `...(responsesExtraContentFromProviderMetadata(currentToolCall.providerMetadata) ?? {})` 的挂载**，导致该类工具的思考签名在推流给客户端时被彻底丢弃，下一轮带历史回传时无法还原 `thought_signature`，最终触发 Google Antigravity 400。

## 1. 故障现象与真实日志回放数据

在任务执行多工具调用时，调用链触发 Google Antigravity 400 异常中断：

```text
Provider error 400: Antigravity invalid request: Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call default_api:exec , position 4. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.
```

### 故障现场真实日志（来自 `/Users/zhuhaijun/.codex/sessions/2026/09/03/rollout-2026-09-03T08-46-36-01a064bb-5f58-7172-9864-311386d66f1a.jsonl`）

1. **Line 6 (用户输入)**：
   ```json
   { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "现在的数据更新机制是什么？" }] }
   ```
2. **Line 8 (模型首轮输出 custom_tool_call)**：
   ```json
   {
     "type": "custom_tool_call",
     "id": "ctc_81bb96a408054baab1fcdc37028f9e57",
     "call_id": "call_d0fa80e4",
     "name": "exec",
     "input": "{\"cmd\":\"rg --files docs/\"}"
   }
   ```
3. **Line 9 (客户端执行失败输出)**：
   ```json
   {
     "type": "custom_tool_call_output",
     "call_id": "call_d0fa80e4",
     "output": "Script error: SyntaxError: Unexpected token ':'"
   }
   ```
4. **Line 11 (第二轮请求向 Antigravity 回传历史时抛出 400 崩溃)**：
   ```text
   Provider error 400: Antigravity invalid request: Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call default_api:exec , position 4.
   ```

---

## 2. 真实缺陷代码级实测定位

### 2.1 致命断点：`src/bridge.ts` 漏挂 `custom_tool_call` / `tool_search_call` 的 `extra_content`

在 `src/bridge.ts` 中，存在流式（`bridgeToResponsesSSE`）和非流式（`buildResponseJSON`）两处工具调用组装逻辑：

#### ① 流式输出（`bridgeToResponsesSSE`，约 615~635 行 与 655~675 行）：
```ts
const item = currentToolCall.toolSearch
  ? {
      type: "tool_search_call", id: currentToolCall.itemId,
      call_id: currentToolCall.callId, execution: "client",
      arguments: parseArgsObj(currentToolCall.args), status: "completed",
      // ❌ 缺失 extra_content
    }
  : currentToolCall.freeform
  ? {
      type: "custom_tool_call", id: currentToolCall.itemId,
      call_id: currentToolCall.callId, name: currentToolCall.name,
      input: freeformInput(currentToolCall.args), status: "completed",
      // ❌ 缺失！未挂载 responsesExtraContentFromProviderMetadata
    }
  : {
      type: "function_call", id: currentToolCall.itemId,
      call_id: currentToolCall.callId, name: currentToolCall.name,
      arguments: argsStr, status: "completed",
      ...(currentToolCall.namespace ? { namespace: currentToolCall.namespace } : {}),
      // ✅ 普通 function_call 正常挂载
      ...(responsesExtraContentFromProviderMetadata(currentToolCall.providerMetadata) ?? {}),
    };
```

#### ② 非流式输出（`buildResponseJSON`，约 1580~1605 行）：
```ts
if (toolSearch) {
  pushOutput({
    type: "tool_search_call", id: `tsc_${uuid()}`,
    call_id: currentToolCallId, execution: "client",
    arguments: parseArgsObj(coercedArgs), status,
    // ❌ 缺失 extra_content
  });
} else if (freeform) {
  pushOutput({
    type: "custom_tool_call", id: `ctc_${uuid()}`,
    call_id: currentToolCallId, name: realName,
    input: freeformInput(currentToolCallArgs), status,
    // ❌ 缺失！未挂载 responsesExtraContentFromProviderMetadata
  });
} else {
  pushOutput({
    type: "function_call", id: `fc_${uuid()}`,
    call_id: currentToolCallId, name: realName,
    arguments: coercedArgs || "{}", status,
    ...(ns ? { namespace: ns } : {}),
    // ✅ 普通 function_call 正常挂载
    ...(responsesExtraContentFromProviderMetadata(currentToolCallProviderMetadata) ?? {}),
  });
}
```

### 2.2 为什么普通工具正常，而 `exec` / `apply_patch` 必然 400？

1. 在 Codex 的 Responses 协议中，`exec`、`apply_patch` 属于 `freeform: true` 工具，在 Responses API 中输出为 `custom_tool_call`。
2. 当 Gemini 生成 `exec` 调用时，`google.ts` 正确生成了带有 `providerMetadata.google.thoughtSignature` 的 `tool_call_start`。
3. 但经过 `bridge.ts` 转换为 SSE 输出给 Codex 客户端时，因走 `freeform` 分支，最初**丢弃了 `extra_content.google.thought_signature`**。
4. 此外，在请求解析侧，`src/responses/schema.ts` 中的 `customToolCallItemSchema` 最初未声明 `extra_content` 属性，导致 Zod 校验时会自动 strip 剥离客户端带回的签名数据。
5. 经过修复 `bridge.ts` 输出与 `schema.ts` 校验定义后，`custom_tool_call` 的签名得以完整 Round-trip，`messagesToGeminiFormat` 能精确还原 `thoughtSignature`。

---

## 3. 彻底修复方案

### 3.1 在 `src/bridge.ts` 中补齐所有分支的 `extra_content` 挂载

无论是 `function_call`、`custom_tool_call` 还是 `tool_search_call`（包括 `status: completed` 与 `status: incomplete`），均必须挂载：
```ts
...(responsesExtraContentFromProviderMetadata(currentToolCall.providerMetadata) ?? {})
```

### 3.2 保留并行调用的“首 call 签名”语义

保留 `src/adapters/google.ts` 中 `functionCallSignatureAssigned` 和 `google-antigravity-replay.ts` 中 `pendingThoughtSig = undefined` 的单次消费逻辑，防止签名向同一批 sibling calls 错误扩散。

### 3.3 确保 providerMetadata 权威路径无损 Round-trip

```text
Google Part.thoughtSignature
  -> tool_call_start.providerMetadata.google.thoughtSignature
  -> Responses custom_tool_call / function_call.extra_content.google.thought_signature
  -> history / previous_response_id replay
  -> providerMetadataFromResponsesFunctionCall()
  -> OcxToolCall.providerMetadata.google.thoughtSignature
  -> messagesToGeminiFormat()
  -> Gemini Part.thoughtSignature
```
只要原始 signature 存在于 Responses history 中，即能原位还原，不再出现 freeform 工具调用导致的 400 异常。

---

## 4. 补充端到端回归测试

新增/更新测试覆盖：
1. **Freeform / Custom Tool Call 签名 Round-trip 测试**：
   验证 `custom_tool_call`（`exec`、`apply_patch`）经 `bridgeToResponsesSSE` 及 `buildResponseJSON` 输出后，其输出对象中完整包含 `extra_content.google.thought_signature`。
2. **多轮 Sequential Custom Tool Call 还原测试**：
   模拟多轮 `custom_tool_call` + `custom_tool_call_output`，经 `parseRequest` -> `messagesToGeminiFormat` 后，每一个 model step 的 `functionCall` 均精确携带原始 `thoughtSignature`。
3. **Parallel Tool Calls 保持首 Call 签名语义测试**：
   确保同批并行调用中仅首个保留签名，不扩散给同批 sibling calls。
