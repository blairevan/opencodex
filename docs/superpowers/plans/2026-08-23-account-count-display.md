# 可用账户数量与状态提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 OAuth 账号区域标题改为“可用账户[x/y]”，并在悬停时展示非零账号状态数量。

**Architecture:** 在现有 OAuth 健康状态辅助模块中新增纯函数，按固定优先级将账号归类为互斥状态并计算总数。ProviderAuthPanel 使用该摘要生成标题和原生 Hover 文案，不新增后端接口或改变路由资格判断。

**Tech Stack:** React 19、TypeScript、现有 i18n、Bun test、Vite。

## Global Constraints

- `y` 是已登录账号总数，包含停用、被限制、需要重新登录和额度不可用账号。
- `x` 只统计正常账号：已启用、不需要重新登录、不在冷却/限流状态且额度可用。
- 状态互斥优先级为：手动停用、需要重新登录、被限制、额度不可用、正常。
- Hover 中只显示数量大于 0 的状态，固定顺序输出。
- 不新增后端接口，不改变账号切换、停用、删除、额度查询和路由行为。
- 所有新增可见文案必须写入全部 locale 文件。

---

### Task 1: Add pure account status summary and tests

**Files:**
- Modify: `gui/src/oauth-health-display.ts`
- Test: `gui/tests/oauth-health-display.test.ts`

**Interfaces:**
- Produces `OAuthAccountStatusCounts` and `summarizeOAuthAccountStatuses(accounts)` for ProviderAuthPanel.

- [ ] **Step 1: Add failing tests**

Import the new summary helper and add tests:

```ts
test("summarizeOAuthAccountStatuses counts normal and total accounts", () => {
  const counts = summarizeOAuthAccountStatuses([
    { enabled: true, active: true, health: { status: "healthy" } },
    { enabled: true, active: false },
  ]);
  expect(counts).toEqual({ total: 2, normal: 2, disabled: 0, reauth: 0, restricted: 0, unavailable: 0 });
});

test("summarizeOAuthAccountStatuses applies mutually exclusive status priority", () => {
  const counts = summarizeOAuthAccountStatuses([
    { enabled: false, needsReauth: true, health: { status: "cooldown" }, quotaUnavailable: true },
    { enabled: true, needsReauth: true, health: { status: "cooldown" } },
    { enabled: true, health: { status: "cooldown" } },
    { enabled: true, health: { status: "warning" } },
  ]);
  expect(counts).toEqual({ total: 4, normal: 0, disabled: 1, reauth: 1, restricted: 1, unavailable: 1 });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd gui && bun test tests/oauth-health-display.test.ts`

Expected: FAIL because `summarizeOAuthAccountStatuses` is not exported.

- [ ] **Step 3: Implement the minimal summary helper**

Add these types and function to `gui/src/oauth-health-display.ts`:

```ts
export type OAuthAccountStatusCounts = {
  total: number;
  normal: number;
  disabled: number;
  reauth: number;
  restricted: number;
  unavailable: number;
};

export function summarizeOAuthAccountStatuses(
  accounts: readonly {
    enabled?: boolean;
    needsReauth?: boolean;
    health?: { status?: OAuthHealthStatus } | null;
    quotaUnavailable?: boolean;
  }[],
): OAuthAccountStatusCounts {
  const counts: OAuthAccountStatusCounts = {
    total: accounts.length,
    normal: 0,
    disabled: 0,
    reauth: 0,
    restricted: 0,
    unavailable: 0,
  };
  for (const account of accounts) {
    if (account.enabled === false) counts.disabled += 1;
    else if (accountNeedsReauth(account)) counts.reauth += 1;
    else if (oauthHealthIsCooldown(account.health?.status)) counts.restricted += 1;
    else if (account.quotaUnavailable === true || account.health?.status === "warning") counts.unavailable += 1;
    else counts.normal += 1;
  }
  return counts;
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `cd gui && bun test tests/oauth-health-display.test.ts`

Expected: all tests in the file pass.

### Task 2: Add localized title and Hover details

**Files:**
- Modify: `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`
- Modify: `gui/src/i18n/en.ts`
- Modify: `gui/src/i18n/de.ts`
- Modify: `gui/src/i18n/ja.ts`
- Modify: `gui/src/i18n/ko.ts`
- Modify: `gui/src/i18n/ru.ts`
- Modify: `gui/src/i18n/tr.ts`
- Modify: `gui/src/i18n/zh.ts`
- Modify: `gui/src/i18n/zh-TW.ts`

**Interfaces:**
- Consumes `summarizeOAuthAccountStatuses` and `OAuthAccountStatusCounts` from Task 1.
- Produces a localized heading label and non-zero status detail string.

- [ ] **Step 1: Add locale keys**

Add these keys to every locale catalog with translated values:

```ts
"pws.availableAccountsCount": "Available accounts ({available}/{total})",
"pws.accountStatus.normal": "Normal: {count}",
"pws.accountStatus.disabled": "Manually disabled: {count}",
"pws.accountStatus.reauth": "Reauthentication required: {count}",
"pws.accountStatus.restricted": "Restricted: {count}",
"pws.accountStatus.unavailable": "Quota unavailable: {count}",
```

- [ ] **Step 2: Build the non-zero Hover detail string**

Add a helper near the component rendering code:

```ts
function accountStatusHoverText(t: TFn, counts: OAuthAccountStatusCounts): string {
  return [
    counts.normal > 0 ? t("pws.accountStatus.normal", { count: counts.normal }) : null,
    counts.restricted > 0 ? t("pws.accountStatus.restricted", { count: counts.restricted }) : null,
    counts.disabled > 0 ? t("pws.accountStatus.disabled", { count: counts.disabled }) : null,
    counts.reauth > 0 ? t("pws.accountStatus.reauth", { count: counts.reauth }) : null,
    counts.unavailable > 0 ? t("pws.accountStatus.unavailable", { count: counts.unavailable }) : null,
  ].filter((line): line is string => line !== null).join("\n");
}
```

- [ ] **Step 3: Replace the OAuth heading**

Before rendering the OAuth section, derive:

```ts
const accountStatusCounts = summarizeOAuthAccountStatuses(accounts);
const accountTitle = t("pws.availableAccountsCount", {
  available: accountStatusCounts.normal,
  total: accountStatusCounts.total,
});
const accountStatusDetails = accountStatusHoverText(t, accountStatusCounts);
```

Render the OAuth heading with `accountTitle`, `title={accountStatusDetails}`, and `aria-label={`${accountTitle}. ${accountStatusDetails}`}`. Keep the existing API-key heading unchanged.

- [ ] **Step 4: Run the locale and focused checks**

Run:

```bash
cd gui
bun test tests/oauth-health-display.test.ts tests/locale-parity.test.ts
bun run build
git diff --check
```

Expected: all tests, build, and diff checks pass.

- [ ] **Step 5: Run i18n lint and record baseline failures**

Run: `cd gui && bun run lint:i18n`

Expected: the new keys produce no new missing-translation or hardcoded-copy findings. Existing unrelated lint findings, if still present, must be reported separately rather than changed in this scoped task.

- [ ] **Step 6: Manually verify the account matrix**

Verify in Providers → an OAuth provider → Accounts:

1. `可用账户[x/y]` shows normal and total counts.
2. Disabled, restricted, reauth-required, and unavailable accounts are included in y but excluded from x.
3. Hover shows only non-zero statuses in the fixed order.
4. Existing account list actions, quota rows, and account information setting remain unchanged.

## Self-review

- Spec coverage: total/normal counts, mutually exclusive priorities, non-zero Hover rows, i18n, no backend changes, and regression checks are covered by Tasks 1–2.
- Completeness: every implementation step contains exact files, code, commands, and expected results.
- Type consistency: `OAuthAccountStatusCounts` and `summarizeOAuthAccountStatuses` are declared in Task 1 and consumed unchanged in Task 2.
