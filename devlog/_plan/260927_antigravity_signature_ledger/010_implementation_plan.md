# Antigravity thought_signature 续接账本实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Codex Desktop 丢弃工具调用 `extra_content` 后，按同一会话和精确 `call_id` 恢复 Google Antigravity `thought_signature`。

**Architecture:** 新增有界持久化账本。Bridge 输出时按最终 Responses `call_id` 记录签名；Core 在 OAuth 路由已确定、Google adapter 构建请求前，向对应内部 `OcxToolCall.providerMetadata` 恢复签名。既有参数键控回放缓存只作为缺少可信会话键时的短期兜底。

**Tech Stack:** Bun、TypeScript strict、Bun test、Responses/SSE bridge、原子 JSON 状态快照。

**Spec:** `devlog/_plan/260927_antigravity_signature_ledger/000_design.md`

## 全局约束

- 不新增依赖，不使用 `any`、`@ts-ignore` 或 eslint bypass。
- 不持久化提示词、工具输入/输出、原始线程值或 token；键均哈希，日志不输出签名。
- 持久恢复的会话键仅取 parent-thread、`session_id`/`session-id`、`thread-id`；不得使用 `prompt_cache_key` 或首条用户文本。
- 相同目标、project、OAuth account、实际 wire model、会话范围和精确 `call_id` 是恢复的全部前提。
- 无条目时不得猜测、合成或跨调用借用签名。
- 状态满足一小时 TTL、原子落盘、启动恢复、条目/字节上限、内存预算与关闭 flush。

---

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `src/responses/google-thought-signature-ledger.ts` | 账本、哈希范围、TTL、快照、恢复与测试 seam。 |
| `src/server/responses/core.ts` | 派生范围，恢复内部调用 metadata，记录终态输出签名。 |
| `src/types.ts` | 私有 parsed-request scope 类型。 |
| `src/server/lifecycle.ts` | 退出前 flush 账本。 |
| `src/lib/state-store-registrations.ts` | TTL sweep 注册。 |
| `src/lib/app-owned-memory-stores.ts` | 全局内存预算注册。 |
| `src/lib/config-ownership.ts`、`structure/00_overview.md` | 受管状态文件及用途。 |
| `tests/google-thought-signature-ledger.test.ts` | 账本持久化、隔离、TTL、容量与安全。 |
| `tests/google-signature-history-roundtrip.test.ts` | Responses 至 Google 的端到端回归。 |
| `tests/state-store-sweeper.test.ts` | sweep 与内存预算回归。 |

### Task 0: 受控移植签名 metadata 往返前置修复

**Files:**
- Modify: `src/bridge.ts`
- Modify: `src/responses/parser.ts`
- Modify: `src/responses/schema.ts`
- Modify: `src/types.ts`
- Modify: `src/adapters/google.ts`
- Modify: `src/adapters/google-antigravity-wire.ts`
- Modify: `src/adapters/google-antigravity-replay.ts`
- Modify: `src/lib/synthetic-tool-id.ts`
- Create: `src/responses/provider-opaque-metadata.ts`
- Create: `tests/google-provider-metadata-roundtrip.test.ts`
- Create: `tests/google-signature-history-roundtrip.test.ts`
- Modify: `tests/bridge.test.ts`, `tests/responses-parser.test.ts`, `tests/google-antigravity-wire.test.ts`

**Interfaces:**
- Consumes: 上游 Gemini `thoughtSignature`、`thought_signature` 与 Responses `extra_content.google.thought_signature`。
- Produces: `OcxToolCall.providerMetadata`，以及 Bridge/Parser/Google adapter 间字节不变的 opaque metadata 往返。

- [x] **Step 1: 先移植测试与运行失败用例**

从已验证的 `859a42e76` 与 `ff507001b` 仅移植测试和必要 fixture：custom/freeform `exec`、tool search、历史 replay、synthetic id 拒绝与并行调用签名隔离。不要移植 `docs/antigravity-thought-signature-missing-diagnosis.md`，避免将旧诊断材料带入本任务。

Run: `bun test tests/google-provider-metadata-roundtrip.test.ts tests/google-signature-history-roundtrip.test.ts tests/bridge.test.ts tests/responses-parser.test.ts tests/google-antigravity-wire.test.ts --timeout 60000`

Expected: FAIL，`dev` 尚未提供 provider-opaque metadata 的读取、输出与 Google wire 传递。

- [x] **Step 2: 移植最小生产前置能力**

以小块补丁移植 `859a42e76` 的 Responses metadata 往返，再移植 `ff507001b` 的 opaque signature alias、synthetic id 拒绝和 Google wire 防御。保留 `dev` 当前 3.6 wire-model 目录与无关路由行为；只合并上述接口必需部分。每块补丁后运行对应失败测试，避免把 `main` 的后续模型目录或无关功能带入。

- [x] **Step 3: 验证前置能力**

Run: `bun test tests/google-provider-metadata-roundtrip.test.ts tests/google-signature-history-roundtrip.test.ts tests/bridge.test.ts tests/responses-parser.test.ts tests/google-antigravity-wire.test.ts --timeout 60000`

Expected: PASS，且无签名历史仍保持无签名，synthetic id 不能成为 Google signature。

```bash
git add src/bridge.ts src/responses/parser.ts src/responses/schema.ts src/responses/provider-opaque-metadata.ts src/types.ts src/adapters/google.ts src/adapters/google-antigravity-wire.ts src/adapters/google-antigravity-replay.ts src/lib/synthetic-tool-id.ts tests/bridge.test.ts tests/responses-parser.test.ts tests/google-antigravity-wire.test.ts tests/google-provider-metadata-roundtrip.test.ts tests/google-signature-history-roundtrip.test.ts
git commit -m "fix(antigravity): preserve opaque tool call metadata"
```

### Task 1: 实现精确调用 ID 账本

**Files:**
- Create: `src/responses/google-thought-signature-ledger.ts`
- Create: `tests/google-thought-signature-ledger.test.ts`

**Interfaces:**
- Consumes: `OcxToolCall.providerMetadata` 的 Google 签名形状、Responses 输出项的 `call_id` 与 `extra_content`。
- Produces: `GoogleThoughtSignatureScope`、`rememberGoogleThoughtSignatures`、`restoreGoogleThoughtSignatures`、`sweepExpiredGoogleThoughtSignatures`、`flushGoogleThoughtSignatures`、metrics/reset seam。

- [x] **Step 1: 写失败测试**

在 `tests/google-thought-signature-ledger.test.ts` 固定一个 scope，记录签名调用 `call-a`，再恢复两个无签名调用。断言仅 `call-a` 被恢复，即使 `call-b` 名称和参数完全一致。

```ts
rememberGoogleThoughtSignatures(scope, [signedCall("call-a", SIGNATURE)]);
const restored = restoreGoogleThoughtSignatures(scope, [unsignedCall("call-a"), unsignedCall("call-b")]);
expect(signatureOf(restored[0])).toBe(SIGNATURE);
expect(signatureOf(restored[1])).toBeUndefined();
```

- [x] **Step 2: 运行失败测试**

Run: `bun test tests/google-thought-signature-ledger.test.ts --timeout 60000`

Expected: FAIL，账本模块尚不存在。

- [x] **Step 3: 写最小账本实现**

新增独立模块，使用 `sha256(destination + project + account + wireModel + conversation + callId)` 作为索引。值仅为 opaque signature、更新时间与字节数；实现 1 小时 TTL、原子 JSON 快照、加载校验、条目/字节上限、惰性过期清理和不泄露值的 metrics。

```ts
export interface GoogleThoughtSignatureScope { key: string; }
export function rememberGoogleThoughtSignatures(scope: GoogleThoughtSignatureScope | undefined, output: readonly unknown[]): void;
export function restoreGoogleThoughtSignatures(scope: GoogleThoughtSignatureScope | undefined, messages: readonly OcxMessage[]): number;
```

恢复仅创建新的 `providerMetadata` 对象；只处理非空 `id`、缺少 Google 签名的 `toolCall`，并拒绝 synthetic 或畸形签名。

- [x] **Step 4: 补齐账本边界测试**

在同一文件测试不同会话/账户/project/model/目标隔离、synthetic/空签名拒绝、重启后恢复、TTL 到期、条目和字节淘汰、损坏快照 fail-closed。测试只使用 fixture 签名，绝不打印账本值。

- [ ] **Step 5: 验证并提交**

Run: `bun test tests/google-thought-signature-ledger.test.ts --timeout 60000`

Expected: PASS。

```bash
git add src/responses/google-thought-signature-ledger.ts tests/google-thought-signature-ledger.test.ts
git commit -m "feat(responses): persist Google tool signatures by call id"
```

### Task 2: 将账本接入 Antigravity 请求与响应

**Files:**
- Modify: `src/server/responses/core.ts`
- Modify: `src/types.ts`
- Modify: `tests/google-signature-history-roundtrip.test.ts`
- Test: `tests/google-antigravity-wire.test.ts`

**Interfaces:**
- Consumes: Task 1 的账本接口、Core 已选择的 Antigravity account/project、`resolveAntigravityEffortWireModel()` 产生的实际 wire model。
- Produces: 可选 `_googleThoughtSignatureScope` 与终态输出记录，供 Google adapter 读取恢复后的 `providerMetadata`。

- [x] **Step 1: 写 257+ 历史端到端失败用例**

在 `tests/google-signature-history-roundtrip.test.ts` 记录 257 个不同 `call_id`，再构造带较早 `call_id`、但无 `extra_content` 的完整 Responses 历史。使用同一可信 session、账户、project 与 wire model，断言 Google 请求的 functionCall 含有原签名；使用不同 session 的相同 `call_id` 时断言无签名。

```ts
expect(functionCallPart?.thoughtSignature).toBe(SIGNATURE_FOR_EARLY_CALL);
expect(foreignSessionFunctionCall?.thoughtSignature).toBeUndefined();
```

- [x] **Step 2: 运行失败测试**

Run: `bun test tests/google-signature-history-roundtrip.test.ts --timeout 60000`

Expected: FAIL，早期调用不在既有 256 项参数回放缓存中。

- [x] **Step 3: 在 Core 恢复已解析调用**

在 OAuth account、project 和有效 wire model 已稳定后派生 scope。缺少 parent-thread/session/thread header 时 scope 为 `undefined`。将 scope 写入私有 parsed 字段，并在 adapter `buildRequest` 前调用：

```ts
if (parsed._googleThoughtSignatureScope) {
  restoreGoogleThoughtSignatures(parsed._googleThoughtSignatureScope, parsed.context.messages);
}
```

不得改写 `_rawBody`，以免代理私有状态流向原生 passthrough 或客户端。

- [x] **Step 4: 在终态输出记录签名**

在现有 `rememberResponseState(...)` 终态回调旁，以同一 scope 调用 `rememberGoogleThoughtSignatures(scope, response.output)`。仅复用已被 `rememberResponseState` 接纳的 completed 或 `max_output_tokens` 可续接响应；失败、过滤、无 output 不写账本。

- [ ] **Step 5: 验证并提交**

Run: `bun test tests/google-signature-history-roundtrip.test.ts tests/google-antigravity-wire.test.ts --timeout 60000`

Expected: PASS，包括显式 metadata、Desktop 丢字段恢复、257+ 调用和跨范围拒绝。

```bash
git add src/server/responses/core.ts src/types.ts tests/google-signature-history-roundtrip.test.ts tests/google-antigravity-wire.test.ts
git commit -m "fix(antigravity): restore signatures by exact Responses call id"
```

### Task 3: 接入生命周期、内存预算与所有权

**Files:**
- Modify: `src/server/lifecycle.ts`
- Modify: `src/lib/state-store-registrations.ts`
- Modify: `src/lib/app-owned-memory-stores.ts`
- Modify: `src/lib/config-ownership.ts`
- Modify: `structure/00_overview.md`
- Modify: `tests/state-store-sweeper.test.ts`

**Interfaces:**
- Consumes: Task 1 的 flush、sweep、retained-store snapshot 和 oldest-entry eviction。
- Produces: 与既有 continuation/replay 状态一致的 sweep、内存回收与优雅停机行为。

- [x] **Step 1: 写生命周期失败测试**

在 `tests/state-store-sweeper.test.ts` 将 `google-thought-signature-ledger` 加入生产注册列表的精确断言。构造过期项、调用 `sweepExpired()` 并断言移除；压低应用内存预算后断言最旧账本项被释放。

- [x] **Step 2: 运行失败测试**

Run: `bun test tests/state-store-sweeper.test.ts --timeout 60000`

Expected: FAIL，账本尚未注册 sweep 或内存预算。

- [x] **Step 3: 实现生命周期接入**

在状态注册表加入账本 TTL sweep；在 app-owned memory 注册表加入 `continuation` 分类的 snapshot/evict；在 `src/server/lifecycle.ts` 现有 state/replay `Promise.allSettled` flush 中加入账本；在受管清单与 `structure/00_overview.md` 记录该快照文件仅含哈希键、opaque 签名和受限 TTL 状态。

- [x] **Step 4: 运行聚焦验证**

Run: `bun test tests/state-store-sweeper.test.ts tests/google-thought-signature-ledger.test.ts --timeout 60000`

Expected: PASS。

- [x] **Step 5: 运行共享边界验证并提交**

Run: `bun run typecheck && bun test && bun run privacy:scan`

Expected: PASS；若有无关失败，交付时必须与本任务的聚焦验证分开报告。

```bash
git add src/server/lifecycle.ts src/lib/state-store-registrations.ts src/lib/app-owned-memory-stores.ts src/lib/config-ownership.ts structure/00_overview.md tests/state-store-sweeper.test.ts
git commit -m "feat(antigravity): manage thought signature ledger lifecycle"
```

## 实施后验收

- [x] `bun test tests/google-thought-signature-ledger.test.ts tests/google-signature-history-roundtrip.test.ts tests/google-antigravity-wire.test.ts tests/state-store-sweeper.test.ts --timeout 60000`
- [x] `bun run typecheck && bun test && bun run privacy:scan`
- [x] `git diff --check && git status --short --branch`
- [x] 交付时明确区分本地测试证据与尚未执行的真实 Antigravity 上游验证。
