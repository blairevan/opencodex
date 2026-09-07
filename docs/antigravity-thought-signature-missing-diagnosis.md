# Google Antigravity / Gemini 多工具调用 thought_signature 丢失导致 400 报错分析

> **修订说明（2026-09-07 第三版 - 与当前代码实现同步）**
>
> 本文同时保留 2026-09-03 已确认并修复的历史缺陷，以及 2026-09-07 新会话复发后的再次定位结果。
>
> - **2026-09-03 历史缺陷已确认**：`src/bridge.ts` 在 `custom_tool_call` / `tool_search_call` 分支遗漏 provider metadata，Responses schema 又会 strip 未声明的 `extra_content`，导致签名无法通过客户端历史 Round-trip。该问题已在当时修复。
> - **2026-09-07 复发现象不能直接归因于同一断点**：客户端 JSONL 中 `custom_tool_call.extra_content` 为空只能证明 Responses 持久化路径缺签名；当前实现还存在独立的 Antigravity replay cache，可在下一轮按 model + session + functionCall identity 恢复签名。
> - **本次代码已进一步修订**：统一 Google-family 上游签名别名读取、将 provider-owned signature 作为 opaque token 处理、保留 legacy history 的 synthetic-id 防护，并新增脱敏的 inbound / observe / replay 生命周期诊断；后续代码审查发现的 providerMetadata synthetic-id 绕过 P1 也已通过 Responses 入站 + Google 最终出站双层防护修复。
> - **新增回归已验证**：即使 `exec custom_tool_call` 的客户端历史没有 `extra_content`，只要 replay observe、session 和 call identity 正常，下一轮仍可恢复原 `thoughtSignature`。
>
> 因此，本文当前结论是：**2026-09-03 根因已经闭环；2026-09-07 现场仍需要通过新增 replay 诊断日志确认真实断点，不能仅凭 `extra_content` 为空把问题锁定到 adapter 入站。**

## 1. 故障现象与真实日志回放数据

在任务执行多工具调用时，调用链触发 Google Antigravity 400 异常中断：

```text
Provider error 400: Antigravity invalid request: Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call default_api:exec , position 4. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.
```

### 故障现场真实日志（来自 `~/.codex/sessions/2026/09/03/rollout-2026-09-03T08-46-36-01a064bb-5f58-7172-9864-311386d66f1a.jsonl`）

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

## 2. 2026-09-03 历史缺陷：代码级实测定位

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

### 2.2 为什么当时普通工具正常，而 `exec` / `apply_patch` 会触发 400？

1. 在 Codex 的 Responses 协议中，`exec`、`apply_patch` 属于 `freeform: true` 工具，在 Responses API 中输出为 `custom_tool_call`。
2. 当 Gemini 生成 `exec` 调用时，`google.ts` 正确生成了带有 `providerMetadata.google.thoughtSignature` 的 `tool_call_start`。
3. 但经过 `bridge.ts` 转换为 SSE 输出给 Codex 客户端时，因走 `freeform` 分支，最初**丢弃了 `extra_content.google.thought_signature`**。
4. 此外，在请求解析侧，`src/responses/schema.ts` 中的 `customToolCallItemSchema` 最初未声明 `extra_content` 属性，导致 Zod 校验时会自动 strip 剥离客户端带回的签名数据。
5. 经过修复 `bridge.ts` 输出与 `schema.ts` 校验定义后，`custom_tool_call` 的签名得以完整 Round-trip，`messagesToGeminiFormat` 能精确还原 `thoughtSignature`。

---

## 3. 2026-09-03 已实施修复

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

## 4. 2026-09-03 已补充的端到端回归测试

新增/更新测试覆盖：
1. **Freeform / Custom Tool Call 签名 Round-trip 测试**：
   验证 `custom_tool_call`（`exec`、`apply_patch`）经 `bridgeToResponsesSSE` 及 `buildResponseJSON` 输出后，其输出对象中完整包含 `extra_content.google.thought_signature`。
2. **多轮 Sequential Custom Tool Call 还原测试**：
   模拟多轮 `custom_tool_call` + `custom_tool_call_output`，经 `parseRequest` -> `messagesToGeminiFormat` 后，每一个 model step 的 `functionCall` 均精确携带原始 `thoughtSignature`。
3. **Parallel Tool Calls 保持首 Call 签名语义测试**：
   确保同批并行调用中仅首个保留签名，不扩散给同批 sibling calls。

---

## 5. 2026-09-07 新会话复发：Responses 持久化路径确认缺签名，实际断点需由 replay 链路确认

### 5.1 现场证据与结论边界

- 失败会话：`01a07b0d-8dc7-7982-921c-85dc61ee2852`；该会话在 2026-09-07 新建，故不能归因于其他会话遗留的历史记录。
- 会话使用 `gemini-3.8-flash-medium`，并经本机 OpenCodex `http://127.0.0.1:10100/v1` 路由至 Antigravity。
- 首轮已连续输出 7 个 `custom_tool_call`，名称均为 `exec`；它们在客户端会话 JSONL 中的 `extra_content` 均为空。
- 后续请求被 Antigravity 拒绝：`Function call is missing a thought_signature in functionCall parts`；错误中的 `position 13` 是上游重建历史中的函数调用位置，不是本轮第 13 次 shell 命令。

这些证据能够确认 **Responses 持久化路径没有把签名带回客户端历史**，但不能单独证明签名在 Google adapter 入站阶段已经丢失。当前 Antigravity 还有一条独立的 replay cache 恢复路径：

```text
Antigravity response Part
  -> observeAntigravityReplay(model, sessionId, parts)
  -> replay cache（按 model + session + functionCall identity 保存）
  -> 下一轮 applyAntigravityReplay(model, sessionId, contents)
  -> 匹配 functionCall.thoughtSignature
```

因此，即便客户端 `custom_tool_call.extra_content` 为空，只要原始 Part 有签名、session/replay key 稳定且 functionCall 的 name+args 可匹配，下一轮请求仍应由 replay cache 恢复签名。新增回归测试已经证明这一场景可以正常工作。

### 5.2 已确认并修复的兼容性缺口

此前 `src/adapters/google.ts` 的签名读取存在不一致：传播/replay 路径能够识别多个字段别名，而 `googleToolCallMetadataFromPart()` 只直接读取 `part.thoughtSignature`；同时上游真实响应也经过了面向历史污染防护的字符集 heuristic。

现已统一为 `googleThoughtSignatureFromPart()`：

1. 读取 `thoughtSignature`、`thought_signature`、`extra_content.google.thought_signature` 三种入站形态；
2. 对 **上游 provider-owned Part** 将签名视作 opaque token，只做最小长度和 64 KiB 上限检查，不按字符集猜测合法性；
3. `isLikelyRealThoughtSignature()` 仍保留在客户端历史/legacy 字段边界，用于拒绝 `fc_...`、`ctc_...`、`call_...` 等 synthetic id，避免把 Responses item id 误发成 Google thought signature；
4. 流式与非流式 adapter metadata、thought-part 传播、replay observe 共用相同的字段读取规则。

这项修复消除了一个真实兼容性缺口，但在没有复现后的诊断链证据前，仍不能把它认定为 2026-09-07 现场 400 的唯一根因。

### 5.3 新增脱敏签名生命周期诊断

Provider debug 开启时，现在记录三类事件：

```text
[ocx:google-antigravity:thought-signature-inbound]
[ocx:google-antigravity:thought-signature-observe]
[ocx:google-antigravity:thought-signature-replay]
```

诊断信息只包含：

- `present` / `source`；
- function call 顺序 `call_index`；
- `session_key` / `call_key` 的截断哈希；
- opaque signature 的 SHA-256 短指纹 `fingerprint`；
- replay 的 `cache_present` 以及 `history` / `replay` / `missing` 状态。

不会记录原始 thought signature、function arguments、请求正文、token 或账号标识。默认 debug 关闭时不会计算签名指纹，也不会产生这些日志。

复现时可通过 `ocx debug provider on` 开启，重点按以下模式判断断点：

- `inbound present=false`：上游返回 Part 本身未观察到签名，优先检查真实 Antigravity response；
- `inbound present=true` 且 `observe present=true`，下一轮 `cache_present=false`：优先检查 model/session identity、进程/持久化状态；
- `cache_present=true` 且 `source=missing`：优先检查 functionCall name/args 规范化导致的 call identity mismatch；
- `source=replay` 且 fingerprint 与上一轮 observe 一致：replay 已成功注入，应继续检查最终 wire request 之后的上游处理；
- `source=history`：Responses provider metadata 持久化路径已经直接提供签名，replay 没有覆盖它。

### 5.4 回归验证

新增覆盖包括：

1. 非流式 functionCall 分别携带 camelCase、snake_case、嵌套 `extra_content` 签名，均恢复到 `providerMetadata.google.thoughtSignature`；
2. 上游 opaque signature 使用超出现有 base64-like heuristic 的字符时仍能从真实 provider Part 进入 metadata；
3. 流式 snake_case functionCall 能进入 `tool_call_start.providerMetadata`；
4. 完整模拟 `exec custom_tool_call` 的客户端历史 `extra_content` 为空，使用新的 adapter 实例发起下一轮时，模块级 Antigravity replay cache 仍能将原签名恢复到匹配的 functionCall；
5. 原有 parallel、sequential、Responses history、Vertex replay、bridge 与 parser 回归保持通过。

本轮相关 8 组 focused regression 最新结果为 **227 tests passed / 0 failed**。完整仓库测试在当前 DevSpace 运行超过 300 秒被执行环境终止；`typecheck` 当前也受 checkout 中 macOS TypeScript 平台包与 Linux arm64 DevSpace 不匹配影响，未能实际启动编译器。

### 5.5 审查发现的 P1：客户端 synthetic id 可绕过 opaque providerMetadata 路径

代码审查进一步发现一个 P1 阻断问题：`providerMetadata.google.thoughtSignature` 不能被视为天然可信。`providerMetadataFromResponsesFunctionCall()` 会从客户端回传的 `extra_content.google.thought_signature` 构造该字段，因此客户端可以提交类似：

```text
ctc_038f26d3f20962bc016a54f0fcfa208190a8ec0f289c2ba211
fc_d8df7548e31a4130b7624f3d27571cdd
call_d0fa80e4...
```

如果最终 `messagesToGeminiFormat()` 只因为它位于 `providerMetadata` 中就按 opaque provider token 原样转发，这些 synthetic Responses/tool ids 会绕过 legacy `isLikelyRealThoughtSignature()` 防护，被写入 Google `functionCall.thoughtSignature`，再次触发 Antigravity 400。

该问题现已按“外部输入边界 + 最终出站边界”双层修复：

1. `src/responses/provider-opaque-metadata.ts`
   - `providerMetadataFromResponsesFunctionCall()` 将 Responses history 明确视为客户端可控输入；
   - 在保留 opaque 字符集兼容的前提下，拒绝已知 synthetic id 前缀；
   - 只有通过该边界的值才能被提升为 `providerMetadata.google.thoughtSignature`。
2. `src/adapters/google.ts`
   - 即使某条未来内部路径直接构造了 `providerMetadata`，最终生成 Google Part 前仍再次拒绝 synthetic id；
   - 该第二层属于 defense in depth，避免新的数据来源绕过 Responses ingress。
3. `src/lib/synthetic-tool-id.ts`
   - 新增共享 `isSyntheticToolCallIdLike()`；
   - Responses ingress、Google legacy heuristic 与最终 Google wire guard 共用同一 synthetic-id 规则，避免多处正则长期漂移。

该防护只做 synthetic prefix deny-list，不重新限制 provider signature 的字符集。因此类似：

```text
opaque:provider:signature:with:new-charset
```

仍可通过 Responses history 完整 Round-trip；同时 `ctc_...` / `fc_...` / `call_...` / `toolu_...` 等客户端 synthetic id 会被拒绝。

新增回归包括：

- `providerMetadataFromResponsesFunctionCall()` 拒绝 `ctc_...`、`fc_...`、`call_...`、`toolu_...`；
- `custom_tool_call.extra_content.google.thought_signature = ctc_...` 经 `parseRequest()` 后不会进入 Google `thoughtSignature`；
- 即使内部 `OcxToolCall.providerMetadata.google.thoughtSignature` 被直接设置为 `ctc_...`，最终 Google wire guard 仍会删除它；
- 非 synthetic 的新字符集 opaque provider signature 继续正常通过。

### 5.6 本次代码修改清单（2026-09-07）

#### `src/lib/synthetic-tool-id.ts`

- 新增共享 `isSyntheticToolCallIdLike()`；
- 统一识别 `fc_`、`ctc_`、`tsc_`、`call_`、`toolu_` 等 synthetic Responses/tool-call id；
- 仅做前缀拒绝，不对其他 opaque provider token 做字符集猜测。

#### `src/adapters/google-antigravity-wire.ts`

- 新增 `googleThoughtSignatureFromPart()`，作为 Google-family 上游 Part 的统一签名读取入口；
- 支持以下三种字段形态：
  - `thoughtSignature`
  - `thought_signature`
  - `extra_content.google.thought_signature`
- provider-owned signature 按 opaque token 处理，只限制最小长度与 64 KiB 上限；
- 保留 `isLikelyRealThoughtSignature()` 给 legacy/history 边界使用，继续拒绝 `fc_...`、`ctc_...`、`call_...` 等 synthetic id；
- 新增 `googleThoughtSignatureFingerprint()`，仅生成 SHA-256 截断指纹供 opt-in debug 使用，不输出原始签名。

#### `src/responses/provider-opaque-metadata.ts`

- 将 Responses `extra_content.google.thought_signature` 明确视为客户端可控输入；
- `providerMetadataFromResponsesFunctionCall()` 在保留 opaque 字符集兼容的同时，拒绝 synthetic Responses/tool-call id；
- 防止客户端通过 `extra_content` 把 `ctc_...` / `fc_...` 等 synthetic id 提升为 `providerMetadata.google.thoughtSignature`。

#### `src/adapters/google.ts`

- `googleToolCallMetadataFromPart()` 改为调用统一 helper，不再只识别 camelCase；
- streaming / buffered functionCall 都增加脱敏 inbound signature 诊断；
- thought-part → functionCall 的签名传播与 metadata 提取使用相同字段读取规则；
- `messagesToGeminiFormat()` 区分两类输入边界：
  - `providerMetadata.google.thoughtSignature` 保留 opaque 字符集，但最终出站前仍调用共享 synthetic-id deny-list 进行 defense-in-depth 校验；
  - legacy `OcxToolCall.thoughtSignature` 继续使用 `isLikelyRealThoughtSignature()`，防止 synthetic item id 被误发给 Google。

#### `src/adapters/google-antigravity-replay.ts`

- replay observe 改为复用 `googleThoughtSignatureFromPart()`；
- provider debug 开启时记录 observe / replay 的脱敏生命周期信息；
- replay miss 现在能区分：
  - session cache 不存在；
  - history 已直接带签名；
  - replay key 命中并成功注入；
  - session cache 存在但 functionCall identity 未命中；
- 日志不包含 function arguments、原始 signature、token 或账号信息。

#### 测试

- `tests/google-provider-metadata-roundtrip.test.ts`
  - 新增客户端 synthetic id 无法被提升为 provider metadata 的回归；
  - 同时验证新字符集 opaque signature 仍可正常通过；
- `tests/google-antigravity-wire.test.ts`
  - 新增 streaming snake_case signature 回归；
  - 新增 synthetic id 无法通过内部 `providerMetadata` 绕过最终 Google wire guard 的回归；
- `tests/google-signature-history-roundtrip.test.ts`
  - 新增 camelCase / snake_case / nested alias 归一化；
  - 新增超出现有 base64-like 字符集 heuristic 的 opaque provider signature 回归；
  - 新增 opaque provider metadata 经 Responses history 后重建 Google Part 的完整回归；
  - 新增客户端 `custom_tool_call.extra_content` 注入 `ctc_...` 后不会进入 Google `thoughtSignature` 的端到端回归；
  - 新增 `exec custom_tool_call` 客户端 `extra_content` 为空、依赖 Antigravity replay cache 恢复签名的完整回归。

### 5.7 当前诊断状态与下一次复现判定标准

当前代码已经同时具备两条签名连续性路径：

```text
路径 A：Responses 持久化
upstream Part
  -> providerMetadata
  -> extra_content.google.thought_signature
  -> client/history
  -> providerMetadataFromResponsesFunctionCall()
  -> Google functionCall.thoughtSignature

路径 B：Antigravity replay
upstream Part
  -> observeAntigravityReplay()
  -> replay cache
  -> applyAntigravityReplay()
  -> Google functionCall.thoughtSignature
```

下一次若仍出现 `Function call is missing a thought_signature`，应以 debug 生命周期日志为准，不再仅根据客户端 JSONL 的 `extra_content` 推断根因：

1. **inbound 已缺失**：检查 Antigravity 原始 response Part / 上游模型行为；
2. **observe 成功、下一轮 cache 不存在**：检查 model/session identity、重启恢复或 snapshot 状态；
3. **cache 存在但 source=missing**：检查 functionCall name/args 在编译、freeform unwrap、history rebuild 过程中是否发生 identity 漂移；
4. **source=replay/history 且 fingerprint 正确**：本地签名连续性已经成立，应转向最终请求 wire 或上游校验规则；
5. **Responses history 自身有签名**：优先确认 provider metadata 在 parser → `messagesToGeminiFormat()` 最后一跳是否保持同一 fingerprint。

### 5.8 验证限制

本次 focused tests 已通过，但仍保留以下非代码结论边界：

- 尚未取得 2026-09-07 故障请求对应的原始 Antigravity SSE Part，因此不能宣布当次生产 400 的唯一根因已经确认；
- full test suite 在当前 DevSpace 因 300 秒执行上限未完整跑完；
- `bun run typecheck` 因当前 checkout 的 TypeScript 平台包为 macOS，而执行环境为 Linux arm64，编译器未能启动；
- `privacy:scan` 当前失败来自另一个既有文档 `docs/gpt-6-astra-model-discovery-diagnosis.md` 中的本机 home path，与本次改动无关；本诊断文档中的本机绝对 home path 已改为 `~/.codex/...`。
