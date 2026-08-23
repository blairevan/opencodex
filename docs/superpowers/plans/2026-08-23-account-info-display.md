# 账号信息展示设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Providers 账号列表底部增加“展示账号信息”开关，关闭后仅显示别名或脱敏邮箱用户名。

**Architecture:** 使用 GUI 本地展示偏好，不新增后端接口或配置字段。新增纯函数负责邮箱用户名脱敏，ProviderAuthPanel 读取并保存全局 `localStorage` 布尔偏好；账号行根据偏好决定是否渲染辅助信息行。

**Tech Stack:** React 19、TypeScript、现有 i18n、Bun test、Vite。

## Global Constraints

- 默认值为 `true`，保持现有账号展示行为。
- 关闭时有别名只显示别名；无别名时只显示邮箱 `@` 前用户名的脱敏结果。
- 脱敏长用户名使用前 2 位 + `***` + 后 2 位；长度不超过 4 时使用同长度 `*`，不暴露完整用户名。
- 只保存展示偏好，不保存账号、邮箱、账号 ID、Token、Cookie 或额度数据。
- 所有新增可见文案必须写入全部 locale 文件。
- 不新增依赖，不修改后端 API，不改变额度、健康状态和账号操作逻辑。

---

### Task 1: Add and test the email username masking helper

**Files:**
- Modify: `gui/src/lib/privacy.ts`
- Test: `gui/tests/oauth-health-display.test.ts`

**Interfaces:**
- Produces `maskEmailUsername(value: string | null | undefined): string` for ProviderAuthPanel and privacy-focused tests.

- [ ] **Step 1: Add failing tests**

Append tests to `gui/tests/oauth-health-display.test.ts`:

```ts
test("maskEmailUsername keeps only the first and last two username characters", () => {
  expect(maskEmailUsername("blair15@example.test")).toBe("bl***15");
  expect(maskEmailUsername("ab@example.test")).toBe("**");
});

test("maskEmailUsername never exposes short usernames in full", () => {
  expect(maskEmailUsername("abc@example.test")).toBe("***");
  expect(maskEmailUsername("abcd@example.test")).toBe("****");
  expect(maskEmailUsername(null)).toBe("account-…");
});
```

Update the test import to include `maskEmailUsername` from `../src/lib/privacy`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd gui && bun test tests/oauth-health-display.test.ts`

Expected: FAIL because `maskEmailUsername` is not exported yet.

- [ ] **Step 3: Implement the minimal helper**

Add this documented function to `gui/src/lib/privacy.ts`:

```ts
/** Masks the local part of an email for privacy-safe account labels. */
export function maskEmailUsername(value: string | null | undefined): string {
  const email = value?.trim() ?? "";
  const at = email.indexOf("@");
  const username = (at >= 0 ? email.slice(0, at) : email).trim();
  if (!username) return "account-…";
  if (username.length <= 4) return "*".repeat(username.length);
  return `${username.slice(0, 2)}***${username.slice(-2)}`;
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `cd gui && bun test tests/oauth-health-display.test.ts`

Expected: all tests in the file pass.

- [ ] **Step 5: Commit the helper and tests**

```bash
git add gui/src/lib/privacy.ts gui/tests/oauth-health-display.test.ts
git commit -m "feat(gui): 增加邮箱用户名脱敏标签"
```

### Task 2: Add the persisted display setting and account-row behavior

**Files:**
- Modify: `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`
- Modify: `gui/src/styles/provider-workspace-settings.css`
- Modify: `gui/src/i18n/en.ts`
- Modify: `gui/src/i18n/de.ts`
- Modify: `gui/src/i18n/ja.ts`
- Modify: `gui/src/i18n/ko.ts`
- Modify: `gui/src/i18n/ru.ts`
- Modify: `gui/src/i18n/tr.ts`
- Modify: `gui/src/i18n/zh.ts`
- Modify: `gui/src/i18n/zh-TW.ts`

**Interfaces:**
- Consumes `maskEmailUsername` from Task 1.
- Produces a bottom-of-account-list toggle using the existing `toggle-with-label` style and the key `ocx_show_account_info`.

- [ ] **Step 1: Add all locale keys**

Add the same key to every locale catalog:

```ts
"pws.showAccountInfo": "Show account information"
```

Use the corresponding translated text in each non-English catalog. Use the setting label for both the toggle's `aria-label` and `title`.

- [ ] **Step 2: Add the persisted state with default enabled**

In `ProviderAuthPanel`, initialize from `localStorage` with a safe fallback:

```ts
const [showAccountInfo, setShowAccountInfo] = useState<boolean>(() => {
  try {
    const stored = localStorage.getItem("ocx_show_account_info");
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
});
```

Persist changes in the existing local preference effect or a dedicated effect, catching storage failures without affecting account rendering.

- [ ] **Step 3: Derive the privacy-safe account label**

Inside the account mapping, keep the existing `label` for the enabled state and derive the closed-state label:

```ts
const displayLabel = showAccountInfo
  ? label
  : account.alias?.trim() || maskEmailUsername(account.email);
```

Render `displayLabel` as the only identity line when `showAccountInfo` is false. Render the current email/ID secondary line only when it is true. Preserve health summaries, badges, quota rows, and action controls.

- [ ] **Step 4: Add the setting at the bottom of the account area**

After the account list and add/import controls, render a dedicated setting row:

```tsx
<div className="pwi-account-display-setting">
  <span>{t("pws.showAccountInfo")}</span>
  <button
    type="button"
    className={`toggle toggle-with-label toggle-with-label--account ${showAccountInfo ? "on" : ""}`}
    aria-pressed={showAccountInfo}
    aria-label={t("pws.showAccountInfo")}
    onClick={() => setShowAccountInfo(value => !value)}
  >
    <span className="toggle-label-text">{showAccountInfo ? t("pws.accountEnabled") : t("pws.accountDisabled")}</span>
    <span className="toggle-knob" />
  </button>
</div>
```

Use a class-based row style, not inline layout, and keep it below the existing Antigravity pool/import area.

- [ ] **Step 5: Add focused styles**

Add to `gui/src/styles/provider-workspace-settings.css`:

```css
.pwi-account-display-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border-soft);
  color: var(--muted);
  font-size: var(--text-label);
}
```

Keep the toggle itself aligned with the existing account toggle styles and allow the label to wrap on narrow screens.

- [ ] **Step 6: Run GUI checks**

Run:

```bash
cd gui
bun run build
bun run lint:i18n
git diff --check
```

Expected: build and diff checks pass. If `lint:i18n` reports pre-existing unrelated violations, record them separately and confirm the new key has parity in all catalogs.

- [ ] **Step 7: Manually verify the display matrix**

Verify in Providers → Google Antigravity → Accounts:

1. Default state is enabled and current email/ID rows remain visible.
2. Disable the setting for an account with alias: only the alias line remains.
3. Disable it for an account without alias: only the masked email username remains.
4. Refresh the page: the setting remains disabled.
5. Quota bars, account expand/collapse, enable/disable, alias edit, remove, and account switching remain functional.

- [ ] **Step 8: Commit the UI implementation**

```bash
git add gui/src/lib/privacy.ts gui/tests/oauth-health-display.test.ts gui/src/components/provider-workspace/ProviderAuthPanel.tsx gui/src/styles/provider-workspace-settings.css gui/src/i18n/*.ts
git commit -m "feat(gui): 增加账号信息展示设置"
```

## Self-review

- Spec coverage: default-on setting, alias-only display, masked email fallback, local persistence, bottom placement, i18n, privacy boundary, and regression checks are covered by Tasks 1–2.
- Completeness scan: all implementation steps contain concrete files, code, commands, and expected outcomes.
- Type consistency: `maskEmailUsername(value: string | null | undefined): string` is declared in Task 1 and consumed unchanged in Task 2.
