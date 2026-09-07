# Codex Desktop 与 OpenCodex 仪表盘中 GPT-6 Astra 模型缺失根因分析与动态修复方案

## 1. 问题现象

用户在日常使用中遇到以下两处异常现象：
1. **Codex Desktop 客户端**：在当前工作机上的模型下拉菜单中看不到最新的 **GPT-6 Astra** 模型，但同一账号在另一台机器（MacMini）上登录却能正常看到并选用。
2. **OpenCodex Web 仪表盘 (http://localhost:10100/#providers)**：进入「提供商」管理页后，左侧显示 `OpenAI (Codex login)` 状态就绪，但右侧「模型」标签页显示红字提示：**「未发现此提供商的模型。」**。

---

## 2. 验证排查与反猜想

排查初期容易主观假设为“OpenAI 灰度限制 / 账号未获得该模型权限”，通过对底层运行时及官方端点进行实测，迅速排除了这一假设：

### 2.1 账号权限实测验证
使用本机 `~/.codex/auth.json` 中的真实 OAuth 会话凭证，通过内置 Codex CLI 显式指定该模型执行单次测试：
```bash
/Applications/ChatGPT.app/Contents/Resources/codex exec \
  --model gpt-6-astra \
  -c model_reasoning_effort="low" \
  "say hello"
```
**实测输出**：
```text
OpenAI Codex v0.153.4
model: gpt-6-astra
provider: openai
reasoning effort: low
--------
codex
Hello! 👋
```
**结论**：用户的 ChatGPT Pro 账号已拥有 `gpt-6-astra` 的完整使用权限，服务端也能正常推理与响应。

### 2.2 官方原生桌面端目录验证
在隔离环境排除代理注入，直接运行桌面端自带的原生模型目录解析：
```bash
CODEX_HOME="/tmp/clean-codex-home" /Applications/ChatGPT.app/Contents/Resources/codex debug models
```
**输出结果**：原生客户端列出的模型首位即是 `gpt-6-astra`，并附带官方完整的 6 级思考深度定义（`low` 到 `ultra`）。这解释了为何 MacMini 原生登录可以正常展示该模型。

---

## 3. 根本原因深度分析（双层阻断）

问题并非出在官方或账号权限，而是由于本地运行的 **OpenCodex** 代理在两处不同的通信通道中进行了硬编码过滤或遗漏：

### 3.1 第一层阻断：桌面端模型目录被静态白名单剔除
1. **目录劫持机制**：为了将三方路由模型（如 Claude 3.7、Gemini 3.8、Qwen 等）注入到 Codex Desktop，OpenCodex 在 `~/.codex/config.toml` 中注入了：
   ```toml
   model_catalog_json = "/Users/zhuhaijun/.codex/opencodex-catalog.json"
   openai_base_url = "http://127.0.0.1:10100/v1"
   ```
   这导致 Codex Desktop 放弃原生内置目录，强制读取磁盘上的 `opencodex-catalog.json`。
2. **源码静态白名单硬编码**：
   在 `src/codex/catalog/native-models.ts` 中，原生 OpenAI 模型由静态常量维护：
   ```typescript
   export const NATIVE_OPENAI_MODELS = [
     "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
     "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
   ];
   export const SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(NATIVE_OPENAI_MODELS);
   ```
   在 OpenCodex 编译/同步生成 `opencodex-catalog.json` 时，不在该集合中的模型会被 `sync.ts` 和 `parsing.ts` 彻底丢弃。由于该列表尚未录入 `gpt-6-astra`，导致桌面端模型被过滤。

### 3.2 第二层阻断：Web 管理仪表盘遗漏注入原生模型集合
在 Web 管理端（`localhost:10100/#providers`），前端通过 `GET /api/selected-models` 获取各提供商可用模型与实时模型计数 `liveModelCounts`。
在 `src/server/management/model-routes.ts` 的接口实现中，存在两个断点：
```typescript
const models = await fetchAllModels(config);
const available: Record<string, string[]> = {};
for (const m of models) (available[m.provider] ??= []).push(m.id);

// 遗漏了 available.openai 以及 liveModelCounts.openai 的注入
```
1. **模型集合遗漏**：`fetchAllModels(config)` 只遍历已配置的三方路由提供商（Bailian、Cursor、Grok 等），对于原生直通提供商 `openai`，`available.openai` 始终为 `undefined`。
2. **活跃计数丢失导致前端二级过滤**：即使注入了 `available.openai`，前端 `filterModels` 在决定展示 `base` 还是 `fallback` 时，强依赖 `hasLiveModels = (liveModelCounts[name] ?? 0) > 0`。若后端未设置 `liveModelCounts.openai`，`hasLiveModels` 计算为 `false`，列表被直接置空降级为 `[]`，从而展示「没有匹配筛选的模型。」。

---

## 4. 解决方案与修复实现

采取**“官方原生模型动态支持与元数据自适应”**方案，避免未来 OpenAI 每次发布新模型都要手动修改源码：

### 4.1 核心代码改造

1. **白名单扩充与动态候选支持**
   - **`src/codex/catalog/native-models.ts`**：在基线集合首位加入 `"gpt-6-astra"`。
   - **`src/codex/catalog/metadata.ts`**：
     - 加入 `DOCUMENTED_NATIVE_OPENAI_ADDITIONS` 与 `NATIVE_OPENAI_CONTEXT_OVERRIDES`（272k / 872k 窗口）。
     - 改进 `catalogNativeSlugs()`，使其自动吸纳从本地 Codex 原生及缓存中探测到的有效 OpenAI 前缀模型（如 `gpt-*`、`o1/3/4-*`）。
   - **`src/codex/catalog/effort.ts`**：放开 `gpt-6` 家族的思考层级检查，保留其全档位思考能力（涵盖 `max` 与 `ultra`）。

2. **注入官方原生元数据**
   - **`src/codex/data/upstream-models.json`**：从官方应用提取 `gpt-6-astra` 的完整定义（包括系统指令提示词模板、工具调用规范、思考模式配置等），作为权威回退快照。

3. **管理端接口原生模型补全**
   - **`src/server/management/model-routes.ts`**：在 `GET /api/selected-models` 中挂载原生提供商模型：
     ```typescript
     if (config.providers.openai) {
       const { nativeModelRows } = await import("../../codex/catalog");
       available.openai = nativeModelRows(config).map(r => r.slug);
     }
     ```

---

## 5. 验证结果与使用说明

1. **本地目录验证**：
   执行 `ocx sync` 重新生成目录，确认 `~/.codex/opencodex-catalog.json` 已正确包含 `gpt-6-astra`。
   运行官方核心调试命令 `codex debug models`，验证返回包含：
   ```json
   {
     "slug": "gpt-6-astra",
     "display_name": "GPT-6-Astra",
     "visibility": "list",
     "supported_reasoning_levels": ["low", "medium", "high", "xhigh", "max", "ultra"]
   }
   ```

2. **管理端接口验证**：
   重新构建前端资源（`bun run build:gui`）并重启 OpenCodex 服务后，鉴权请求 `GET /api/selected-models`：
   ```json
   {
     "available": {
       "openai": [
         "gpt-6-astra",
         "gpt-5.6-sol",
         "gpt-5.6-terra",
         "gpt-5.6-luna",
         "gpt-5.5",
         "gpt-5.4",
         "gpt-5.4-mini",
         "gpt-5.3-codex-spark"
       ]
     }
   }
   ```

3. **客户端与页面生效**：
   - **浏览器**：刷新 `http://localhost:10100/#providers`（需硬刷新清除旧 JS 缓存），左侧展示“8 个模型”，右侧首位显示 `gpt-6-astra`。
   - **桌面端**：完全退出重启 Codex Desktop（Cmd + Q），新生成的目录即时生效，可在模型选单中直接选用 GPT-6-Astra。
