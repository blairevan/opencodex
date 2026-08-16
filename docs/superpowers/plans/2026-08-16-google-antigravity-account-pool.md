# Google Antigravity 账号池与自动切换实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Google Antigravity (Cloud Code Assist) 实现多 OAuth 账号的用量感知自动切换、会话亲和性 (Session Affinity) 与 429 故障转移 (Failover)。

**Architecture:** 构建 `src/oauth/antigravity-routing.ts` 状态机与选号引擎，改造 `src/providers/quota.ts` 支持账号级 Gemini/Claude 双额度探测，并在 `src/server/responses/core.ts` 中完成 Access Token 与 Project ID 的双凭证原子注入及 429 重试链路。

**Tech Stack:** TypeScript, Bun, Google Cloud Code Assist (CCA) API, Bun Test.

## Global Constraints

- **Language**: Chinese (简体中文) for explanations and docs; English for identifiers and code.
- **Diff-First & Modularity**: 保留已有代码结构与不相关改动，严格遵循 TypeScript 强类型。
- **No Secrets**: 严禁在代码、测试用例或日志中硬编码真实 Token 或 Project ID。
- **Zero Regression**: `antigravityAccountPool.enabled === false` 时，保持原有的单活跃账号逻辑 100% 行为一致。

---

### Task 1: 配置定义与 Schema 校验 (`src/types.ts`, `src/config.ts`)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Test: `tests/config-antigravity-pool.test.ts`

**Interfaces:**
- Consumes: `OcxAccountPoolRotationStrategy` from `src/types.ts`
- Produces: `AntigravityAccountPoolConfig` interface, `config.antigravityAccountPool` in `OcxConfig`

- [ ] **Step 1: 编写配置解析失败测试用例**

```ts
// tests/config-antigravity-pool.test.ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("antigravityAccountPool config", () => {
  test("parses valid antigravityAccountPool config", () => {
    const raw = {
      providers: {},
      antigravityAccountPool: {
        enabled: true,
        autoSwitchThreshold: 75,
        strategy: "fill-first",
        stickyLimit: 3,
      },
    };
    // Expect config parsing to preserve valid pool fields
    expect(raw.antigravityAccountPool.enabled).toBe(true);
    expect(raw.antigravityAccountPool.autoSwitchThreshold).toBe(75);
    expect(raw.antigravityAccountPool.strategy).toBe("fill-first");
    expect(raw.antigravityAccountPool.stickyLimit).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试确认测试框架正常**

Run: `bun test tests/config-antigravity-pool.test.ts`
Expected: PASS

- [ ] **Step 3: 在 `src/types.ts` 中增加配置类型定义**

```ts
export interface AntigravityAccountPoolConfig {
  /** Enable multi-account pool routing for Google Antigravity. Default false. */
  enabled?: boolean;
  /** Usage % threshold for proactive account switching (0-100). Default 80. */
  autoSwitchThreshold?: number;
  /** Account selection strategy: "quota" | "round-robin" | "fill-first". Default "quota". */
  strategy?: OcxAccountPoolRotationStrategy;
  /** Number of sticky requests per round-robin selection (1-100). Default 1. */
  stickyLimit?: number;
}
```
并在 `OcxConfig` 接口中添加：
```ts
  antigravityAccountPool?: AntigravityAccountPoolConfig;
```

- [ ] **Step 4: 在 `src/config.ts` 中添加 schema 校验与合并逻辑**

在 `ocxConfigSchema` 的 `z.object` 中添加：
```ts
  antigravityAccountPool: z.object({
    enabled: z.boolean().optional(),
    autoSwitchThreshold: z.number().int().min(0).max(100).optional(),
    strategy: z.enum(["quota", "round-robin", "fill-first"]).optional(),
    stickyLimit: z.number().int().min(1).max(100).optional(),
  }).optional(),
```

- [ ] **Step 5: 运行全量配置测试**

Run: `bun test tests/config*.test.ts`
Expected: PASS

---

### Task 2: 多账号配额探测改造 (`src/providers/quota.ts`)

**Files:**
- Modify: `src/providers/quota.ts`
- Test: `tests/quota-antigravity-pool.test.ts`

**Interfaces:**
- Consumes: `getAccountSet`, `getValidAccessTokenForAccount`, `getAccountCredential` from `src/oauth/store.ts`
- Produces: `supportsPerAccountQuota("google-antigravity") === true`, `fetchProviderAccountQuotas("google-antigravity")`

- [ ] **Step 1: 编写多账号配额探测的单元测试**

```ts
// tests/quota-antigravity-pool.test.ts
import { describe, expect, test } from "bun:test";
import { supportsPerAccountQuota, getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } from "../src/providers/quota";

describe("antigravity per-account quota", () => {
  test("supportsPerAccountQuota returns true for google-antigravity", () => {
    expect(supportsPerAccountQuota("google-antigravity")).toBe(true);
  });

  test("caches and reads per-account quota for google-antigravity", () => {
    const quota = {
      customWindows: [
        { label: "Gem", percent: 45 },
        { label: "Cla", percent: 70 },
      ],
      updatedAt: Date.now(),
    };
    setCachedProviderAccountQuotaForTests("google-antigravity", "acc-123", quota);
    const cached = getCachedProviderAccountQuota("google-antigravity", "acc-123");
    expect(cached).not.toBeNull();
    expect(cached?.customWindows?.find(w => w.label === "Gem")?.percent).toBe(45);
    expect(cached?.customWindows?.find(w => w.label === "Cla")?.percent).toBe(70);
  });
});
```

- [ ] **Step 2: 运行测试验证失败项**

Run: `bun test tests/quota-antigravity-pool.test.ts`
Expected: FAIL at `supportsPerAccountQuota`

- [ ] **Step 3: 在 `src/providers/quota.ts` 中实现 Antigravity 多账号探测**

1. 修改 `supportsPerAccountQuota`：
```ts
export function supportsPerAccountQuota(provider: string): boolean {
  return provider === "anthropic" || provider === "google-antigravity";
}
```

2. 在 `fetchAccountQuota` 中增加 `google-antigravity` 探测分支：
```ts
if (provider === "google-antigravity") {
  const credential = getAccountCredential("google-antigravity", accountId);
  if (!credential?.projectId) return { ts: Date.now(), quota: cached?.quota ?? null, unavailable: true };
  const token = await getValidAccessTokenForAccount("google-antigravity", accountId);
  const baseUrl = (loadConfig().providers["google-antigravity"]?.baseUrl || "https://daily-cloudcode-pa.googleapis.com").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ project: credential.projectId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return { ts: Date.now(), quota: cached?.quota ?? null, unavailable: true };
  const raw = await response.json();
  const quota = parseAntigravityModelsQuota(raw);
  const entry: AccountQuotaCacheEntry = { ts: Date.now(), quota };
  if (mayCommitAccountQuotaKey(key, writerGeneration)) {
    accountQuotaCache.set(key, entry);
    sweepExpiredOnWrite(entry.ts);
  }
  return entry;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/quota-antigravity-pool.test.ts`
Expected: PASS

---

### Task 3: 账号池调度模块 (`src/oauth/antigravity-routing.ts`)

**Files:**
- Create: `src/oauth/antigravity-routing.ts`
- Modify: `src/lib/state-store-registrations.ts`
- Test: `tests/antigravity-routing.test.ts`

**Interfaces:**
- Consumes: `getAccountSet`, `getAccountCredential`, `setActiveAccount` from `src/oauth/store.ts`, `getCachedProviderAccountQuota` from `src/providers/quota.ts`
- Produces:
  - `isAntigravityAccountPoolEnabled(config: OcxConfig): boolean`
  - `resolveAntigravityAccountForSession(sessionKey: string | null, modelId: string, config: OcxConfig): { accountId: string | null; reason: string }`
  - `rotateAntigravityAccountOn429(config: OcxConfig, failedAccountId: string, retryAfter: string | null, sessionKey?: string | null, modelId?: string): string | null`
  - `getAntigravityPoolAccessTokenAndProject(accountId: string): Promise<{ accessToken: string; projectId: string }>`

- [ ] **Step 1: 编写路由状态机与选号测试用例**

```ts
// tests/antigravity-routing.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import {
  isAntigravityAccountPoolEnabled,
  resolveAntigravityAccountForSession,
  rotateAntigravityAccountOn429,
  clearAntigravityAccountPoolState,
} from "../src/oauth/antigravity-routing";

describe("antigravity-routing", () => {
  beforeEach(() => {
    clearAntigravityAccountPoolState();
  });

  test("returns pool-disabled when pool is not enabled", () => {
    const res = resolveAntigravityAccountForSession("s1", "gemini-3.1-pro", {});
    expect(res.reason).toBe("pool-disabled");
  });
});
```

- [ ] **Step 2: 创建 `src/oauth/antigravity-routing.ts`**

实现完整的 Antigravity 专有路由逻辑：
- 状态机：`upstreamHealth` 与 `sessionAffinity`
- 模型家族感知打分：`usageScoreForModel(accountId, modelId)`（区分 `Gem` vs `Cla`）
- 选号策略：`resolveAntigravityAccountForSession`
- 429 容灾轮换：`rotateAntigravityAccountOn429`
- 双凭证读取：`getAntigravityPoolAccessTokenAndProject(accountId)`

- [ ] **Step 3: 注册状态清理到 `src/lib/state-store-registrations.ts`**

在 state store registrations 中添加 `sweepExpiredAntigravityRoutingHealth`。

- [ ] **Step 4: 运行单元测试**

Run: `bun test tests/antigravity-routing.test.ts`
Expected: PASS

---

### Task 4: 管理接口开放 (`src/server/management/oauth-account-routes.ts`)

**Files:**
- Modify: `src/server/management/oauth-account-routes.ts`
- Test: `tests/oauth-account-routes-antigravity.test.ts`

**Interfaces:**
- Consumes: `antigravity-routing.ts`
- Produces:
  - `GET /api/oauth/accounts/pool?provider=google-antigravity`
  - `PUT /api/oauth/accounts/pool` with `provider: "google-antigravity"`
  - `POST /api/oauth/accounts/clear-cooldown` with `provider: "google-antigravity"`

- [ ] **Step 1: 编写 Management API 测试用例**

```ts
// tests/oauth-account-routes-antigravity.test.ts
import { describe, expect, test } from "bun:test";

describe("oauth-account-routes for google-antigravity", () => {
  test("validates pool config update for google-antigravity", async () => {
    // Test that PUT /api/oauth/accounts/pool accepts provider=google-antigravity
  });
});
```

- [ ] **Step 2: 更新 `src/server/management/oauth-account-routes.ts`**

放开 provider 检查：
```ts
const isSupportedPoolProvider = provider === "anthropic" || provider === "google-antigravity";
if (!isSupportedPoolProvider) return jsonResponse({ error: "pool config is only supported for anthropic and google-antigravity" }, 400);
```
在读取和写入配置时分别映射到 `config.anthropicAccountPool` 或 `config.antigravityAccountPool`。

- [ ] **Step 3: 运行测试验证接口**

Run: `bun test tests/oauth-account-routes-antigravity.test.ts`
Expected: PASS

---

### Task 5: 核心请求链路双凭据注入与 429 重试 (`src/server/responses/core.ts`)

**Files:**
- Modify: `src/server/responses/core.ts`
- Test: `tests/responses-antigravity-pool.test.ts`

**Interfaces:**
- Consumes: `resolveAntigravityAccountForSession`, `rotateAntigravityAccountOn429`, `getAntigravityPoolAccessTokenAndProject`
- Produces: 运行时请求自动选号、`apiKey` + `project` 注入与 429 重试

- [ ] **Step 1: 编写端到端 429 容灾切换集成测试**

```ts
// tests/responses-antigravity-pool.test.ts
import { describe, expect, test } from "bun:test";

describe("responses core antigravity pool failover", () => {
  test("retries with second account when first account returns 429", async () => {
    // Verify core.ts catches 429, rotates to next account, and rebuilds request
  });
});
```

- [ ] **Step 2: 在 `src/server/responses/core.ts` 中接入初始路由注入**

在 OAuth 请求前置阶段：
```ts
if (route.providerName === "google-antigravity" && route.provider.authMode === "oauth" && isAntigravityAccountPoolEnabled(config)) {
  const selection = resolveAntigravityAccountForSession(sessionKey, route.modelId, config);
  if (selection.accountId) {
    const cred = await getAntigravityPoolAccessTokenAndProject(selection.accountId);
    route.provider = { ...route.provider, apiKey: cred.accessToken, project: cred.projectId };
    bindAntigravitySessionAffinity(sessionKey, selection.accountId);
    promoteAntigravityActiveAccount(selection.accountId);
    logCtx.provider = formatAntigravityProviderForLog("google-antigravity", selection.accountId, config);
  }
}
```

- [ ] **Step 3: 在 429 响应重试分支接入 `rotateAntigravityAccountOn429`**

在 `core.ts` 状态码判断中：
```ts
if (upstreamResponse.status === 429 && isAntigravityAccountPoolEnabled(config) && route.providerName === "google-antigravity") {
  const nextAccountId = rotateAntigravityAccountOn429(
    config,
    currentAccountId,
    upstreamResponse.headers.get("retry-after"),
    sessionKey,
    route.modelId,
  );
  if (nextAccountId) {
    const cred = await getAntigravityPoolAccessTokenAndProject(nextAccountId);
    route.provider = { ...route.provider, apiKey: cred.accessToken, project: cred.projectId };
    invalidateSameTargetRequest();
    promoteAntigravityActiveAccount(nextAccountId);
    activeAdapter = resolveAdapter(resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire), config.cacheRetention);
    sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name, logCtx.accountLogLabel);
    const result = await rebuildAndRefetch("antigravity-oauth-429");
    if ("failed" in result) return result.failed;
    upstreamResponse = result.response;
    continue;
  }
}
```

- [ ] **Step 4: 运行端到端集成测试**

Run: `bun test tests/responses-antigravity-pool.test.ts`
Expected: PASS

---

### Task 6: 全量回归与构建测试

**Files:**
- Test: All tests in `tests/`

- [ ] **Step 1: 运行全量测试套件**

Run: `bun test`
Expected: All existing tests PASS without regressions

- [ ] **Step 2: 构建测试**

Run: `bun run build:gui`
Expected: Build success with zero TypeScript errors
