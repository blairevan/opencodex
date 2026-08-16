# HANDOFF.md

> 当前任务交接文档。每次修改请追加内容并更新修订记录，不要完全覆盖。

---

## 1. 当前任务

**分支**: `fix/429-transient-retry`（基于 v2.21.0）

**目标**: 修复 OpenCodeX 在遇到 429 限流时的重试机制，确保所有上游请求路径都使用 `fetchWithTransientRetry`（含 429 退避），而非仅连接重置重试的 `fetchWithResetRetry`。

**涉及路径**:
- `src/lib/upstream-retry.ts` — transient retry 参数
- `src/server/responses/core.ts` — routed 模型路径、rebuildAndRefetch、fetchContinuation
- `src/web-search/loop.ts` — web-search 循环

---

## 2. 已完成

### 2.1 代码改动

| 日期 | 内容 | 状态 |
|------|------|------|
| 2026-08-16 | `upstream-retry.ts`: 429 加入 `isTransientUpstreamStatus`（上游已包含） | ✅ 无需改动 |
| 2026-08-16 | `upstream-retry.ts`: 参数调大：4 次重试、1s 基础退避、20s 上限 | ✅ |
| 2026-08-16 | `core.ts`: `fetchContinuation` 中 `fetchWithResetRetry` → `fetchWithTransientRetry` | ✅ |
| 2026-08-16 | `core.ts`: `rebuildAndRefetch` 中 `fetchWithResetRetry` → `fetchWithTransientRetry` | ✅ |
| 2026-08-16 | `core.ts`: routed 模型初始请求路径（第一版改动，被 rebase 保留） | ✅ |
| 2026-08-16 | `loop.ts`: web-search 循环中 `fetchWithResetRetry` → `fetchWithTransientRetry` | ✅ |
| 2026-08-16 | `docs/fix-429-transient-retry.md`: 设计文档 | ✅ |

### 2.2 仓库维护

| 日期 | 内容 |
|------|------|
| 2026-08-16 | 移除上游 remote（origin 指向 lidge-jun），仅保留 fork（blairevan/opencodex） |
| 2026-08-16 | main 从 v2.10.0 更新到 v2.21.0 |
| 2026-08-16 | fix/429-transient-retry rebase 到最新 main |
| 2026-08-16 | 安装方式从 npm 全局安装切换为源码 `npm link`，shim 已自动重写指向源码路径 |

---

## 3. 卡住的问题

### 3.1 Codex Desktop 无法通过 shim 自动拉起代理

- **现象**: 启动 Codex Desktop（GUI app）时，代理不会自动启动
- **原因**: `ocx codex-shim` 只拦截终端 `codex` CLI 命令（替换 PATH 中的 shell 脚本），Codex Desktop 作为 macOS `.app` 不经过 shell PATH，直接执行内部二进制
- **已解决**: 通过 `ocx service install` 安装 launchd 后台服务，开机自启，常驻后台，不再依赖 shim 触发

### 3.2 opencodex 版本落后

- 当前 npm 全局安装: v2.10.0
- 最新: v2.21.0
- 未从源码安装，`ocx` 命令指向 npm 全局路径

---

## 4. 下一步计划

- [x] 切换安装方式：从 npm 全局安装改为源码 `npm link`（已自动重写 shim 路径）
- [x] 配置 `ocx service install` 实现开机自启（launchd，macOS），不再依赖 shim 触发起动
- [ ] 推送 `fix/429-transient-retry` 到 fork：`git push --force-with-lease origin fix/429-transient-retry`
- [ ] 验证 429 重试在实际场景中的表现
- [ ] 向主仓库提 PR（如果修复需要合入上游）

---

## 5. 踩过的坑

### 5.1 Rebase 冲突处理

**时间**: 2026-08-16

**问题**: 从 v2.10.0 rebase 到 v2.21.0 时，上游对 `core.ts` 做了大量重构（提取 `fetchContinuation` 函数），导致多处冲突。

**解决**:
1. 第一个冲突（routed 模型路径）：`fetchContinuation` 函数内仍使用 `fetchWithResetRetry`，保留上游结构后手动改函数名
2. 第二个冲突（rebuildAndRefetch）：`git checkout --ours` 跳过，事后手动补上改动
3. 第三个冲突（web-search loop）：`git checkout --ours` 跳过，事后手动补上改动

**教训**: `git rebase` 时用 `--ours` 会丢弃本地 commit 的改动，需要事后逐个检查对比并手动补交。两个 commit 在 rebase 过程中被静默跳过，直到对比 `git diff main..` 才发现遗漏。

### 5.2 Edit 工具无法匹配冲突标记

**问题**: 文件中的 `<<<<<<<`、`=======`、`>>>>>>>` 冲突标记虽肉眼可见，但 Edit 工具多次报 "String to replace not found"，可能是缩进（tab/空格）或不可见字符差异导致。

**解决**: 直接用 `git checkout --ours` + 事后手动编辑，绕过 Edit 工具对冲突标记的匹配问题。

### 5.3 429 已在上游包含

**问题**: 本地 commit 中 "将 429 加入 transient 状态码" 的改动，在上游 v2.21.0 的 `isTransientUpstreamStatus` 中已存在。

**结论**: 该改动在 rebase 后自动变为空操作，仅保留 `fetchWithResetRetry → fetchWithTransientRetry` 的函数替换部分。

### 5.4 源码安装后 Dashboard 缺失

**时间**: 2026-08-16

**问题**: 从 npm 全局安装切换为源码 `npm link` 后，`http://localhost:10100/` 返回 `"dashboard": {"available": false, "reason": "GUI build not found"}`。

**原因**: npm 包通过 `files` 字段包含预编译的 `gui/dist/`，`npm install -g` 直接可用。源码中的 `bun install` 只安装依赖，不自动构建 GUI（`build:gui` 未挂在 `postinstall` 下）。

**解决**: 执行 `bun run build:gui`。

**避免方法**: 从 npm 包切换到源码安装时，检查 `package.json` 的 `files` 字段中列出的构建产物是否已生成：
- `gui/dist` — 需 `bun run build:gui`
- 标准流程：`bun install && bun run build:gui && npm link`

---

## 6. 环境信息

| 项目 | 值 |
|------|-----|
| 仓库路径 | `/opt/app/aitools/opencodex` |
| 安装方式 | 源码 `npm link`（非 npm registry） |
| Fork | `github.com/blairevan/opencodex` |
| 上游 | `github.com/lidge-jun/opencodex` |
| Node | v22.16.0 (nvm) |
| 运行时 | Bun (bundled) |
| opencodex 版本 | v2.21.0（源码） |
| 当前分支 | `fix/429-transient-retry` |
| 基于 | main @ v2.21.0 |

---

## 修订记录

| 时间 | 修订人 | 内容 |
|------|--------|------|
| 2026-08-16 18:00 | Claude | 初始创建，记录 rebase 完成后的状态、已完成内容、问题和下一步 |
| 2026-08-16 18:15 | Claude | 切换安装方式：npm 全局卸载 → 通过源码 `npm link` 安装，shim 自动重指向源码路径 |
| 2026-08-16 18:45 | Claude | 配置 `ocx service install`：launchd 后台服务，开机自启，端口 10100，解决 Desktop 自动拉起问题 |
| 2026-08-16 18:50 | Claude | 记录踩坑 5.4：源码安装后 Dashboard 缺失，需手动 `bun run build:gui`；避免方法：标准部署流程 `bun install && bun run build:gui && npm link` |
| 2026-08-16 19:30 | Claude | 完成 Google Antigravity 多账号池化与自动切换可行性分析及设计规范（Spec） |
| 2026-08-16 19:45 | Claude | 完成 Google Antigravity 账号池与自动切换全量代码实现及测试验证 (242/242 tests passing) |
| 2026-08-16 20:00 | Claude | 接入 Google CCA 官方专用端点 retrieveUserQuota，提升配额探测精度与时效 |
| 2026-08-16 20:15 | Claude | 接入 Google 官方同款 retrieveUserQuotaSummary，实现 Gemini / Claude 周额度与 5h 额度全量展示与调度 |

---

## 7. 后续规划：Google Antigravity 多账号池化与自动切换

### 7.1 目标与设计
- **设计文档**: `docs/superpowers/specs/2026-08-16-google-antigravity-account-pool-design.md`
- **核心能力**:
  1. 多账号配额独立探测（Gemini / Claude 双模型家族感知）
  2. 会话亲和性（Session Affinity）绑定
  3. 基于用量（`autoSwitchThreshold`）的最低用量选号
  4. 429 / RESOURCE_EXHAUSTED 自动冷却与同请求无缝故障转移（Failover）
- **改造模块**:
  - `src/types.ts`: 新增 `AntigravityAccountPoolConfig`
  - `src/providers/quota.ts`: 多账号配额遍历与 `accountQuotaCache` 注入
  - `src/oauth/antigravity-routing.ts` (新建): 账号池状态机、选号与容灾轮换
  - `src/server/responses/core.ts`: 双凭据 (`apiKey` + `project`) 动态注入与 429 重试链路
  - `src/server/management/oauth-account-routes.ts`: 账号池管理接口放开支持

### 7.2 实施进展 (2026-08-16)
- **状态**: ✅ 已全部实现并通过全量测试 (242/242 tests passing)
- **交付产物**:
  - `docs/superpowers/plans/2026-08-16-google-antigravity-account-pool.md`: 实施计划
  - `src/types.ts`: `AntigravityAccountPoolConfig` 配置结构
  - `src/providers/quota.ts`: `supportsPerAccountQuota` 放开支持与 `parseAntigravityModelsQuota` / 账号级配额探测
  - `src/oauth/antigravity-routing.ts`: 新增 Antigravity 专有路由引擎（双家族打分、会话亲和性、429 冷却与容灾轮换）
  - `src/codex/pool-rotation.ts` & `src/lib/state-store-registrations.ts`: 注册 Antigravity 轮换常量与状态清理器
  - `src/server/management/oauth-account-routes.ts`: 开放 `google-antigravity` 账号池配置读取/修改/重置冷却接口
  - `src/server/responses/core.ts`: 接入 Token + Project ID 双凭证动态注入与 429 自动故障转移
  - `tests/antigravity-routing.test.ts`, `tests/config-antigravity-pool.test.ts`, `tests/quota-antigravity-pool.test.ts`, `tests/oauth-account-routes-antigravity.test.ts`, `tests/responses-antigravity-pool.test.ts`: 单元与集成测试套件

### 7.3 配额探测端点升级 (2026-08-16)
- **状态**: ✅ 已接入 Google CCA 官方专用配额端点 `v1internal:retrieveUserQuota`
- **改动说明**:
  - `src/providers/quota.ts`: 新增 `parseAntigravityBucketsQuota` 和 `fetchAntigravityUserQuotaWithFallback`，优先请求官方专用配额接口 `retrieveUserQuota` 获取 27 个模型分桶（buckets）的精确剩余比例与重置时间，并在失败时自动回退到 `fetchAvailableModels`。
  - `tests/quota-antigravity-pool.test.ts`: 补充 `parseAntigravityBucketsQuota` 单测用例。

### 7.4 周额度与 5 小时双窗口探测全量上线 (2026-08-16)
- **状态**: ✅ 已接入 Google Antigravity 官方 App 同款汇总端点 `v1internal:retrieveUserQuotaSummary`
- **改动说明**:
  - `src/providers/quota.ts`: 新增 `parseAntigravityQuotaSummary`，完整解析 Gemini Models / Claude and GPT models 的 `Weekly Limit Remaining` (周额度) 与 `Five Hour Limit Remaining` (5 小时额度) 双窗口。
  - `src/oauth/antigravity-routing.ts`: 选号与打分逻辑兼容 `Gemini (Weekly)` / `Gemini (5h)` 与 `Claude/GPT (Weekly)` / `Claude/GPT (5h)`。
  - 前端编译与测试全量通过。
