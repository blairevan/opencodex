# Antigravity thought_signature 续接账本

## 目标

当 Responses 客户端重放 `function_call` 或 `custom_tool_call` 历史、却未携带
provider-opaque 字段 `extra_content.google.thought_signature` 时，仍确保 Google
Antigravity 的工具调用续接有效。

设计只能为生成该签名的原始 provider 工具调用保留签名；不得根据名称或参数推断、合成，
或在不同调用之间转移签名。

## 问题边界

当前 Bridge 会在已完成的工具调用项中正确输出 provider metadata，Parser 也能在客户端
回传时正确读取它。部分客户端会持久化自己的规范化工具调用记录，并丢弃未知的
`extra_content`。现有 Antigravity 回放缓存可按 provider 可见的函数名称与规范化参数修复
该缺失，但它是受限 LRU 兼容兜底：即使客户端仍会重放某个 `call_id`，较长的活动历史也
可能使相应缓存项过期或被淘汰。

单纯提高缓存上限只会推迟故障。持久关联必须使用客户端重放时保留的 Responses 调用身份。

## 选定设计

新增一个由 Responses 状态子系统负责、持久化于既有 OpenCodex 状态根目录下的 Google
thought_signature 续接账本。

### 身份标识

每个条目的键由下列信息的哈希组成：

1. Google 目标身份（base URL 与 project）、实际 wire model，以及被选中的 OAuth 账户身份；
2. 稳定的客户端会话键：parent-thread header 优先，其次为 `session_id` 或 `session-id`，
   最后为 `thread-id`；
3. 精确的 Responses `call_id`。

持久化索引仅保存范围键和调用键的哈希值；不保存提示词、工具输入、工具输出、原始客户端
线程值或账户 token。故意排除 `prompt_cache_key` 与首条用户文本兜底，因为它们可能跨越
彼此独立的会话。

### 写入路径

当 Responses Bridge 完成一个携带有效 Google provider metadata 的 function、custom 或
tool-search 调用时，续接记录器以最终输出项的精确 `call_id` 保存该不透明签名。记录器仅
接受已通过 provider-metadata 边界验证、且非 synthetic 的签名；绝不把 item id 提升为签名。

既有的按参数键控 Antigravity 回放缓存保持不变，继续为缺少稳定会话键的调用方提供短期
兜底。

### 读取路径

在 `previous_response_id` 展开并完成初次 `parseRequest` 后、构建 Google adapter 请求前，
Responses Core 扫描已解析历史中未携带签名的 function/custom/tool-search 调用。对于符合条件的
Google Antigravity 路由，按推导出的范围和精确 `call_id` 查找；命中时只向对应的内部
`OcxToolCall.providerMetadata` 添加签名。其余流程继续由现有 Google adapter 完成不透明
metadata 的往返传递。

当请求没有稳定会话键时不进行查找。任何条目都不得被用于不同目标、账户、实际 wire model
或客户端会话。

### 保留与失败行为

条目沿用 Responses continuation state 的一小时 TTL、原子快照写入、严格字节记账和启动
校验。请求只会刷新其展开后输入中仍存在的 `call_id`；不再处于活动历史的条目可被淘汰。
账本受条目数和字节数双重约束，过期或淘汰时不得在日志中保留任何 secret。

条目不可用时，请求遵循现有安全行为：不猜测签名，也不向相似调用借用签名。既有的按参数
键控回放缓存仍可提供有效签名；否则上游拒绝准确表明没有可安全恢复的签名。

## 受影响边界

- `src/responses/`：账本数据类型、持久化、TTL 清理与恢复 helper。
- `src/server/responses/core.ts`：在路由选择后推导可信请求范围，在解析前恢复 metadata，
  并向终态记录提供范围。
- `src/bridge.ts` 或终态记录器：记录精确的输出调用 ID 及其 provider metadata。
- `src/lib/config-ownership.ts` 与 `structure/00_overview.md`：若使用独立快照文件，则声明
  新的受管状态文件。
- `tests/`：直接历史、长历史淘汰、重启耐久性、范围隔离、畸形 metadata 与过期/容量覆盖。

## 验收标准

1. 在超过 256 个不同的既有工具调用后，缺少 `extra_content` 的 `exec`
   `custom_tool_call` 仍可按精确 `call_id` 恢复。
2. 名称和参数相同、但 `call_id` 不同的调用绝不共享签名。
3. 在 TTL 内重启代理后，符合条件的条目仍可恢复。
4. 不同线程/会话、账户、project、目标或 wire model 之间绝不互相恢复签名。
5. 缺失、畸形、synthetic、过期或已淘汰的条目保持历史不变，且不引入敏感诊断信息。
