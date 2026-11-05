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

## 2. 本地服务与通信参数探查

Antigravity 采用 Electron 宿主结合本地 Go 编写的 `language_server` 架构，本地使用 ConnectRPC 协议通信。

```bash
# 确认 language_server 进程参数与使用的云端端点
ps aux | grep language_server | grep -v grep

# 找到 language_server 正在监听的本地端口（查看 LISTEN 项）
lsof -p $(pgrep -f "language_server.*antigravity" | head -n 1) | grep LISTEN
```

启动参数中包含 `--csrf_token` 与 `--cloud_code_endpoint`，通常端点为 `https://daily-cloudcode-pa.googleapis.com`。

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

1. **版本指纹更新**：
   在 [src/adapters/client-fingerprint.ts](/opt/app/aitools/opencodex/src/adapters/client-fingerprint.ts:45) 中更新 `ANTIGRAVITY_IDE_VERSION`。

2. **模型注册与路由映射**：
   在 [src/providers/antigravity-models.ts](/opt/app/aitools/opencodex/src/providers/antigravity-models.ts:1) 中：
   - `ANTIGRAVITY_WIRE_MODELS`：添加云端实际接收的 wire 模型 ID。
   - `ANTIGRAVITY_MODELS`：添加在 picker 中展示的基础模型 ID。
   - `ANTIGRAVITY_MODEL_EFFORTS`：为支持推理梯度的模型配置 `["low", "medium", "high", ...]`。
   - `ANTIGRAVITY_SUFFIXED_BASE_MODELS` 与 `resolveAntigravityEffortWireModel`：若新模型使用后缀 wire ID，定义默认档位与前缀映射。
   - `ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS` 与 `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS`：填入对应的上下文窗口大小（如 1M tokens）。
   - `ANTIGRAVITY_MODEL_INPUT_MODALITIES`：配置输入模态（如 `["text", "image"]`）。
   - `ANTIGRAVITY_USAGE_BASE_BY_ID`：将带后缀的 wire 模型映射回基础模型，防止统计账单按子档位割裂。

3. **默认模型策略确认**：
   在 [src/providers/registry.ts](/opt/app/aitools/opencodex/src/providers/registry.ts:1459) 中，确认 `defaultModel` 是否需要调整或继续保持。

4. **用量与定价推导**：
   在 [src/usage/expected-prices.ts](/opt/app/aitools/opencodex/src/usage/expected-prices.ts:108) 中为新模型添加预期价格覆盖项（通常标记为 `verified-derived`）。

## 5. 验证与门禁检查

完成代码修改后，执行针对性测试与静态检查，确保无回归故障：

```bash
# 1. 运行 Antigravity 针对性测试套件
bun test tests/google-antigravity-wire.test.ts tests/antigravity-static-catalog.test.ts

# 2. 运行 Antigravity 账号池与重放综合测试
bun test tests/google-antigravity-replay.test.ts tests/antigravity-routing.test.ts tests/responses-antigravity-pool.test.ts

# 3. 严格类型检查
bun run typecheck
```
