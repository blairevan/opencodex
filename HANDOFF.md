# HANDOFF.md

> 当前任务交接文档。每次修改请追加内容并更新修订记录，不要完全覆盖。

---

## 1. 当前任务

**当前事项**: 将 Antigravity thought-signature 跨请求恢复补强合入个人 Fork `main`，并重启本机 OpenCodex 服务。

**个人 Fork**: `blairevan/opencodex:main` 当前为 `e9ca6d6c2`；代码修复提交为 `076870a73`，随后提交交接记录。Fork `main` 保持 v2.21.0 版本元数据；本次没有将上游数千个提交合入。

**服务 checkout**: `/opt/app/aitools/opencodex` 的本地 `main` 包含源码合并提交 `395197ccf`，以及本地文档规划/交接记录提交；工作区干净。

**运行服务**: LaunchAgent `com.opencodex.proxy`，端口 `10100`。2026-09-28 08:00 重启后 PID `26932`，`/healthz` 返回 `status: ok`、版本 `2.21.0`。启动路径指向上述源码 checkout。

**上游关系**: PR [#6143](https://github.com/lidge-jun/opencodex/pull/6143) 仍为 Draft/Open，来源 `codex/model-catalog-sync`，目标上游 `dev`；Fork `main` 的兼容移植不会自动更新该 PR。

**相关分支**:
- Fork `codex/integration` / `origin/codex/integration`: `2a8f4eff3`，包含模型同步功能。
- Fork `codex/model-catalog-sync` 是 PR #6143 的来源分支；本地旧分支 `codex/model-catalog-sync-current` 已删除。
- Antigravity thought-signature ledger 已从错误的上游 `dev` 开发基线迁移并适配 Fork `main`，已合入提交 `076870a73`。

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

## 3. 历史排查记录

### 3.1 Codex Desktop 无法通过 shim 自动拉起代理

- **现象**: 启动 Codex Desktop（GUI app）时，代理不会自动启动
- **原因**: `ocx codex-shim` 只拦截终端 `codex` CLI 命令（替换 PATH 中的 shell 脚本），Codex Desktop 作为 macOS `.app` 不经过 shell PATH，直接执行内部二进制
- **已解决**: 通过 `ocx service install` 安装 launchd 后台服务，开机自启，常驻后台，不再依赖 shim 触发

### 3.2 源码版本与上游版本差异

- 当前运行源码版本仍报告 v2.21.0；Fork `main` 也保留 v2.21.0 版本元数据。
- 上游 `main` 已到 v2.69.0。两条线历史差异很大；本次仅将模型同步功能移植到 Fork `main`，没有同步整个上游历史。

---

## 4. 下一步计划

- [x] 将 Desktop `models_cache.json` watcher 移植到个人 Fork `main`，并推送提交 `dd52011cd`、`23101efad`。
- [x] 将 Fork `main` 同步到服务源码 checkout，保留本地文档提交。
- [x] 重启 LaunchAgent 并检查新 PID、监听端口及 `/healthz`。
- [ ] 运行回归测试：`bun test tests/codex-desktop-model-cache-sync.test.ts`。
- [ ] 构建文档站：`cd docs-site && bun install --frozen-lockfile && bun run build`。
- [ ] 继续处理上游 PR #6143 的验证与 Review Readiness；PR 目前保持 Draft。
- [x] Antigravity thought-signature ledger 以个人 Fork `main` 为基线完成适配；此次不合入上游 `dev`。

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

### 5.5 Fork 推送与本地服务重启

- **问题**: 推送到 GitHub Fork 不会自动更新 `/opt/app/aitools/opencodex` 的源码 checkout；单纯重启仍会加载本地旧代码。
- **本次处理**: 先 fetch Fork `main`，把它合入服务使用的本地 checkout 并保留本地提交，再通过 `launchctl kickstart -k "gui/$(id -u)/com.opencodex.proxy"` 重启。
- **验证**: 同时检查 `lsof -nP -iTCP:10100 -sTCP:LISTEN` 和 `curl -fsS http://127.0.0.1:10100/healthz`；kickstart 成功本身不代表服务已健康。

---

## 6. 环境信息

| 项目 | 值 |
|------|-----|
| 仓库路径 | `/opt/app/aitools/opencodex` |
| 安装方式 | LaunchAgent 直接运行源码 checkout 中的 Bun CLI |
| Fork | `github.com/blairevan/opencodex` |
| 上游 | `github.com/lidge-jun/opencodex` |
| Node | v22.16.0 (nvm) |
| 运行时 | Bun (bundled) |
| opencodex 版本 | v2.21.0（`/healthz` 与 Fork `main` 元数据） |
| Fork `main` | `e9ca6d6c2`（含 thought-signature 修复 `076870a73`）|
| 服务 checkout 分支 | 本地 `main`，源码合并提交 `395197ccf`，另含本地文档规划/交接提交；工作区干净 |
| 服务 | LaunchAgent `com.opencodex.proxy`，PID `26932`，端口 `10100`（2026-09-28 08:00 检查） |

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
| 2026-08-18 10:00 | Claude | 在 Accounts 页面标题右侧新增「刷新配额」按钮与强制刷新链路 |
| 2026-08-18 10:20 | Claude | 新增自动刷新开关、4 档刷新间隔选择 (10s/30s/1m/3m，默认 60s) 与实时倒计时展示 |
| 2026-08-18 10:35 | Claude | 自动刷新控件升级为微型滑动开关（Toggle Switch）样式 |
| 2026-08-18 10:45 | Claude | 去除自动刷新控件外层边框与背景，优化视觉布局 |
| 2026-08-18 11:00 | Claude | 彻底修复多工具调用流式跨分块 thought_signature 丢失问题（单轮连续工具调用全量通过） |
| 2026-09-28 07:42 | Codex | 记录 Codex Desktop 模型缓存同步移植至 Fork `main`、服务 checkout 同步与 LaunchAgent 重启验证；列明上游 PR 和未完成验证 |
| 2026-09-28 08:00 | Codex | 将 Antigravity thought-signature ledger（`076870a73`）及部署交接记录（`e9ca6d6c2`）快进合入 Fork `main`，同步服务 checkout 并重启；验证 PID `26932`、端口 `10100` 与 `/healthz` |

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

### 7.5 Accounts 页面新增一键刷新配额按钮 (2026-08-18)
- **状态**: ✅ 已实现并在顶部 `AVAILABLE ACCOUNTS` 标题栏右侧上线
- **改动说明**:
  - `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`: 在可用账户标题右侧增加带有 `IconRefresh` 旋转加载动画的「刷新配额」按钮。
  - `gui/src/hooks/useProviderAccountPools.ts` & `gui/src/pages/Providers.tsx`: 点击时调用带 `forceRefresh=true`（即 `&quota=1&refresh=1`）的后端接口，实时向 Google CCA 官方接口抓取最新数据并就地更新。
  - `gui/src/i18n/*.ts`: 补齐全语言字典。

### 7.6 自动刷新与多档间隔倒计时上线 (2026-08-18)
- **状态**: ✅ 已实现并在可用账户标题栏右侧上线
- **改动说明**:
  - `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`: 增加 `[自动刷新]` 复选框开关、刷新间隔下拉框（10秒、30秒、1分钟、3分钟，默认60秒）以及动态倒计时 Badge（如 `45s`）。
  - `localStorage` 持久化记住用户的自动刷新偏好与选择的间隔。
  - 定时器每秒递减并在归零时自动触发 `&quota=1&refresh=1`，重置倒计时。
  - `gui/src/styles/provider-workspace-settings.css`: 增加紧凑的控制栏与倒计时 Badge 样式。
  - `gui/src/i18n/*.ts`: 补齐全语言字典条目。

### 7.7 自动刷新控件升级为微型滑动开关样式 (2026-08-18)
- **状态**: ✅ 已实现并编译上线
- **改动说明**:
  - `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`: 将自动刷新的勾选框升级为 `toggle toggle-sm` 精致滑动开关组件，与系统的账户池开关保持一致视觉风格。
  - `gui/src/styles/provider-workspace-settings.css`: 新增 `.toggle-sm` 微型开关动画样式。

### 7.8 自动刷新控件视觉优化 (2026-08-18)
- **状态**: ✅ 已优化并构建上线
- **改动说明**:
  - `gui/src/styles/provider-workspace-settings.css`: 去除自动刷新控制区外层的灰色圆角边框与底色背景（改为无边框纯净流式布局），视觉更加轻盈清爽。

### 7.9 修复流式连续多工具调用签名丢失（Position N 报错）(2026-08-18)
- **状态**: ✅ 已定位根本原因并完成修复上线
- **问题根因**:
  - 在 Gemini 思考模型进行流式输出时，SSE 分块 1 输出思考过程并附带 `thoughtSignature`，随后模型在后续分块（Chunk 2..N）连续触发多个 `functionCall`。
  - 在 `src/adapters/google.ts` 中，原流式处理在调用 `observeAntigravityReplay` 之后才将流状态中的签名赋予当前分块，导致 `observeAntigravityReplay` 接收到的后续分块 `functionCall` 丢失签名，未能成功存入 `ReplayCache`。
  - 在 `src/responses/parser.ts` 中，Freeform 工具（`custom_tool_call`）遗漏了 `providerMetadata` 提取。
- **修复措施**:
  - `src/adapters/google.ts`: 在流式分块迭代中，于调用 `observeAntigravityReplay` 之前，优先将当前思考轮次的 `streamLastThoughtSignature` 绑定到每个 `functionCall` 上。
  - `src/responses/parser.ts`: 为 `custom_tool_call` 补充 `providerMetadata` 解析。
  - `tests/antigravity-multi-toolcall-replay.test.ts`: 新增连续 5 个工具调用流式跨分块签名重放测试用例。

### 7.10 修复 5h 额度耗尽后切号失效与长会话 Replay 缺失 400 (2026-08-19)
- **状态**: ✅ 已定位根因、修复并提交部署 (`72266436`)
- **改动说明**:
  1. **基于 5h / 周窗口 resetAt 的动态智能冷却**: `src/oauth/antigravity-routing.ts` 改造 429 冷却计算逻辑，优先读取配额缓存中对应模型家族的瓶颈重置时间（`resetAt`）。若 5h 额度耗尽按 5h 重置剩余时间冷却，若周额度耗尽按周重置剩余时间冷却，并在重置时间基础上**多增加 5 分钟缓冲**（`BUFFER_COOLDOWN_MS = 5min`），避免临界抖动。兜底采用 5 小时，上限支持至 7 天。
  2. **启动配额预热**: `src/server/index.ts` 在服务启动时异步并发探测所有 Antigravity 账号的初始配额，确保多账号池在收到首个请求时已有真实配额打分，避免冷启动时内存缓存为空导致 80% 阈值路由失效。
  3. **长历史签名防护**: `src/adapters/google.ts` 在 `buildRequest` 阶段对 `applyAntigravityReplay` 进行容错拦截。若某一轮存在部分函数调用由于超出 256 LRU 淘汰导致签名缺失，则剥离该轮全部签名，避免产生部分有签名、部分缺签名触发的上游 `400: Function call is missing a thought_signature` 报错。
  4. **非流式 400 Clear-on-Invalid 对称处理**: `src/adapters/google.ts` 的 `parseResponse` 增加对 400 签名错误的重放缓存清理机制，与流式路径保持对称。

---

## 8. Codex Desktop 模型缓存持续同步 (2026-09-28)

### 8.1 实施与交付

- `src/codex/catalog/watch.ts` 监听当前 Codex Home 下的 `models_cache.json`，以 debounce 方式检查新出现的账号原生模型，并调用现有 Codex 启动同步流程。
- 仅在 Codex 集成已运行且没有外部 Codex 模型 provider 时启动 watcher；目录同步仍按账号 selector 隔离，过滤 OpenCodex 自身 `client_version: "0.0.0"` 的缓存失效写入，退出时停止 watcher。
- Fork `main` 提交：`dd52011cd`（功能移植），`23101efad`（清除重复 watcher stop 调用）。远端 `origin/main` 指向 `23101efad`。
- 服务 checkout 本地合并提交：`7b8270fa6`；保留了本地文档规划提交 `88d0ec4e4`，未推送此本地合并提交。

### 8.2 验证与待办

- `bun install --frozen-lockfile`：通过；`bun run typecheck`：通过（在独立 Fork-main 移植 worktree 中，重复 stop 清理前）。
- `git diff --check`：通过。回归测试已添加至 `tests/codex-desktop-model-cache-sync.test.ts`，尚未运行；docs-site build 尚未验证。
- 服务已重启；`/healthz` 返回 `status: ok`，PID `92918`，端口 `10100`。服务包版本仍为 `2.21.0`，本次只更新了功能代码。
- 上游 PR #6143 仍为 Draft/Open，目标 `lidge-jun/opencodex:dev`；功能进入个人 Fork `main` 不代表已进入上游。
- Antigravity ledger 分支仍在独立 worktree，工作区包含未提交修改，不在本次集成范围内。

---

## 9. Antigravity thought-signature 跨请求持久化 (2026-09-28)

### 9.1 修复内容

- fork `main` 已包含 opaque provider metadata 的 Responses 往返与已有 Antigravity replay cache；本次没有重复搬运这些现存改动。
- 新增有界的一小时签名 ledger，以 route/project/account/wire-model/conversation scope 加精确 Responses `call_id` 索引；不以工具参数或名称猜测关联。
- 完成或可续接的 Responses 输出保存签名；后续历史请求只对完全匹配且缺签名的工具调用恢复。快照只存哈希索引与 provider 签名，加入 TTL、数量/字节限制、内存预算回收、状态清扫、关机 flush 与卸载所有权清单。
- Provider 管理校验测试使用按伪域名显式 allowlist 的 resolver spy，避免机器 DNS/代理环境让测试夹具漂移，同时保留同步目的地安全检查。

### 9.2 验证与交付

- Fork 基线：`origin/main` `23101efad`；交付分支：`codex/antigravity-signature-ledger-fork-main`；Fork `main` 合入：`076870a73`。
- `bun install`、`bun run typecheck`、五个相关测试文件、`git diff --check` 均通过；完整 `bun run test` 在多处非本次改动的 E2E 超时/重试断言差异后中止，不能视为全量通过。
- `bun run privacy:scan` 命中基线文件 `docs/gpt-6-astra-model-discovery-diagnosis.md:51` 的本机路径；该无关文档未修改。
- Fork `main` 当前为 `e9ca6d6c2`；代码提交 `076870a73`，部署交接文档提交 `e9ca6d6c2`。服务 checkout 本地合并提交 `395197ccf`，工作区干净；该 checkout 还保留本地规划/交接文档提交。
- LaunchAgent `com.opencodex.proxy` 已于 2026-09-28 08:00 重启：PID `26932` 正监听 `127.0.0.1:10100`，`/healthz` 为 `status: ok`、版本 `2.21.0`。启动日志同时记录了 Google 已退役 Flash 模型 ID 的配置迁移到 successor `gemini-3.7-flash`。

### 9.3 修订记录

- 2026-09-28 08:00 CST：将签名 ledger 修复快进推送到个人 Fork `main`，同步服务 checkout、重启 LaunchAgent，并验证监听 PID 与健康接口。
