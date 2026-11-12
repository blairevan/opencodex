# Antigravity 升级排查与适配清单

本文档维护 Google Antigravity APP 升级后的标准化排查步骤与 opencodex 适配清单，指导维护者快速识别上游变更并保持代理行为一致。

## 1. 客户端版本与指纹提取

Antigravity 升级后，首先需要提取安装包的版本号与构建信息。Google Cloud Code Assist 后端会根据客户端 User-Agent 执行门禁拦截，版本落后可能导致请求返回 404 NOT_FOUND。

```bash
# 查看本地安装的 Antigravity 应用版本
defaults read /Applications/Antigravity.app/Contents/Info.plist CFBundleShortVersionString

# 或使用 rea 工具提取 plist 结构化证据
rea inspect-plist /Applications/Antigravity.app
```

提取版本号后，检查 [src/adapters/client-fingerprint.ts](/opt/app/aitools/opencodex/src/adapters/client-fingerprint.ts:45) 中的 `ANTIGRAVITY_IDE_VERSION` 是否需要同步推进。

## 2. 客户端启动参数与通信参数提取（rea 静态分析）

Antigravity 采用 Electron 宿主结合本地 Go 编写的 `language_server` 架构。可通过 `rea` 静态提取 `app.asar` 中的 `dist/languageServer.js`，检查 Electron 拉起 `language_server` 时的命令行参数（如 `--subclient_type`、`--override_ide_version`、`--cloud_code_endpoint`）：

```bash
# 使用 rea 分析与解包 app.asar
rea analyze-javascript-application /Applications/Antigravity.app
rea extract-artifact /Applications/Antigravity.app/Contents/Resources/app.asar
```

重点检查 `dist/languageServer.js` 中的启动参数：
- `--subclient_type`：2.31.0 起变更为 `hub`，对应 HTTP `User-Agent` 前缀 `antigravity/hub/<version> (aidev_client; os_type=<os>; arch=<arch>)`。若仍发送旧版 `antigravity/ide/<version>`，云端 `daily-cloudcode-pa.googleapis.com` 会在 `:fetchAvailableModels` 中隐藏 `gemini-4-carbon-*` 与 `gemini-4-argon-*`，且在 `:streamGenerateContent` 时返回 `404 NOT_FOUND`。
- `--cloud_code_endpoint`：默认端点为 `https://daily-cloudcode-pa.googleapis.com`。

## 3. 模型矩阵与推荐列表核对

排查新版本上游支持的模型变化，可以通过本地 Language Server 接口或直接调用云端 API。

```bash
# 方式 A：调用本地 Language Server（端口与 token 来自上一步）
curl -k -s -X POST \
  -H "Content-Type: application/json" \
  -H "Connect-Protocol-Version: 1" \
  -H "x-codeium-csrf-token: <csrf_token>" \
  -d '{}' \
  https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetAvailableModels | jq .

# 方式 B：使用已登录账号向云端拉取可用模型
ocx account refresh google-antigravity --json
```

重点核对以下三类变动：
- 新上线的模型系列（如 Gemini 新代际、Claude 5.x 系列、Flash Lite 等）。
- 模型的命名规则（单 wire ID 配合 thinkingConfig，还是通过 `-low`、`-medium`、`-high` 划分独立 wire ID）。
- 标记下线、弃用或进入过渡期的模型（检查 `tagDescription`）。

## 4. opencodex 代码适配检查项

如果确认有新模型加入或版本迭代，依次检查并修改下列文件：

1. **版本与子客户端指纹更新**：
   在 [src/adapters/client-fingerprint.ts](/opt/app/aitools/opencodex/src/adapters/client-fingerprint.ts:45) 中更新 `ANTIGRAVITY_IDE_VERSION` 与 `ANTIGRAVITY_IDE_SUBCLIENT`（如 `antigravity/hub/2.31.2`）。

2. **模型注册与路由映射**：
   在 [src/providers/antigravity-models.ts](/opt/app/aitools/opencodex/src/providers/antigravity-models.ts:1) 中：
   - `ANTIGRAVITY_WIRE_MODELS`：添加云端实际接收的 wire 模型 ID。
   - `ANTIGRAVITY_MODELS`：添加在 picker 中展示的基础模型 ID。
   - `ANTIGRAVITY_MODEL_EFFORTS`：为支持推理梯度的模型配置 `["low", "medium", "high", ...]`。
   - **单 Wire ID vs 带后缀 Wire ID 档位规则**：
     - `gemini-3.8-flash` 使用单一 `-tiered` Wire ID（`gemini-3.8-flash-tiered`）配合 `generationConfig.thinkingConfig.thinkingLevel` 传递思考强度，在 `ANTIGRAVITY_THINKING_LEVEL_MODELS` 与 `ANTIGRAVITY_PICKER_TO_WIRE` 中配置。
     - `gemini-4-carbon`、`gemini-4-argon` 与 `claude-5.5` 系列在 `daily-cloudcode-pa.googleapis.com` 上使用带后缀的独立 Wire ID（如 `gemini-4-carbon-{low,medium,high}`、`gemini-4-argon-{low,medium,high}`）并同时携带对应的 `thinkingLevel`，在 `CARBON_TIERS`、`ARGON_TIERS` 与 `ANTIGRAVITY_SUFFIXED_BASE_MODELS` 中配置。
     - 非订阅等级可用的模型在 `:fetchAvailableModels` 中会返回 `*-disabled`（且 `disabled: true`），`parseAntigravityAvailableModels` 需过滤此类不可调用占位项。
   - `ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS` 与 `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS`：填入对应的上下文窗口大小（如 1M tokens）。
   - `ANTIGRAVITY_MODEL_INPUT_MODALITIES`：配置输入模态（如 `["text", "image"]`）。
   - `ANTIGRAVITY_USAGE_BASE_BY_ID`：将带后缀的 wire 模型映射回基础模型，防止统计账单按子档位割裂。

3. **请求 Envelope 与信令头对齐**：
   - 在 [src/adapters/google.ts](/opt/app/aitools/opencodex/src/adapters/google.ts:580) 中确认 CCA 封包格式，需携带 `enabledCreditTypes: ["GOOGLE_ONE_AI"]` 等第一方信令字段。

4. **默认模型策略确认**：
   在 [src/providers/registry.ts](/opt/app/aitools/opencodex/src/providers/registry.ts:1459) 中，确认 `defaultModel` 是否需要调整或继续保持。

5. **用量与定价推导**：
   在 [src/usage/expected-prices.ts](/opt/app/aitools/opencodex/src/usage/expected-prices.ts:108) 中为新模型添加预期价格覆盖项（通常标记为 `verified-derived`）。

## 6. 验证与门禁检查

完成代码修改后，执行针对性测试与静态检查，确保无回归故障：

```bash
# 1. 运行 Antigravity 针对性测试套件
bun test tests/google-antigravity-wire.test.ts tests/antigravity-static-catalog.test.ts

# 2. 运行 Antigravity 账号池与重放综合测试
bun test tests/google-antigravity-replay.test.ts tests/antigravity-routing.test.ts tests/responses-antigravity-pool.test.ts

# 3. 严格类型检查
bun run typecheck
```
