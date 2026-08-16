/**
 * Opt-in Anthropic / Google Antigravity OAuth account pool controls (#294).
 * Experimental — shows a strong warning because the feature is not battle-tested.
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  type AccountPoolStrategy,
} from "../../account-pool-strategy";
import AccountPoolStrategyControls from "../AccountPoolStrategyControls";

type PoolState = {
  enabled: boolean;
  threshold: number;
  strategy: AccountPoolStrategy;
  stickyLimit: number;
};

export default function AnthropicAccountPoolSettings({
  provider = "anthropic",
  apiBase,
  accountCount,
}: {
  provider?: "anthropic" | "google-antigravity";
  apiBase: string;
  accountCount: number;
}) {
  const t = useT();
  const isAntigravity = provider === "google-antigravity";
  const p = isAntigravity ? "antigravityPool" : "anthropicPool";

  const [state, setState] = useState<PoolState | null>(null);
  const [draft, setDraft] = useState("80");
  const [stickyDraft, setStickyDraft] = useState(String(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void Promise.resolve()
      .then(() => fetch(`${apiBase}/api/oauth/accounts/pool?provider=${provider}`, { signal: ac.signal }))
      .then(res => {
        if (!res.ok) throw new Error("load");
        return res.json() as Promise<{
          enabled?: boolean;
          autoSwitchThreshold?: number;
          strategy?: unknown;
          stickyLimit?: unknown;
        }>;
      })
      .then(json => {
        if (cancelled) return;
        const nextThreshold = typeof json.autoSwitchThreshold === "number" ? json.autoSwitchThreshold : 80;
        const nextSticky = normalizeAccountPoolStickyLimit(json.stickyLimit);
        setState({
          enabled: json.enabled === true,
          threshold: nextThreshold,
          strategy: normalizeAccountPoolStrategy(json.strategy),
          stickyLimit: nextSticky,
        });
        setDraft(String(nextThreshold));
        setStickyDraft(String(nextSticky));
        setLoadError(false);
      })
      .catch(() => {
        if (cancelled || ac.signal.aborted) return;
        setLoadError(true);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [apiBase, provider]);

  const save = useCallback(async (next: {
    enabled: boolean;
    threshold: number;
    strategy: AccountPoolStrategy;
    stickyLimit: number;
  }) => {
    const previousState = state;
    setState({
      enabled: next.enabled,
      threshold: next.threshold,
      strategy: next.strategy,
      stickyLimit: next.stickyLimit,
    });
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/pool`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          enabled: next.enabled,
          autoSwitchThreshold: next.threshold,
          strategy: next.strategy,
          stickyLimit: next.stickyLimit,
        }),
      });
      if (!res.ok) throw new Error("save");
      const json = await res.json().catch(() => null) as {
        strategy?: unknown;
        stickyLimit?: unknown;
      } | null;
      const savedStrategy = normalizeAccountPoolStrategy(json?.strategy ?? next.strategy);
      const savedSticky = normalizeAccountPoolStickyLimit(json?.stickyLimit ?? next.stickyLimit);
      setState({
        enabled: next.enabled,
        threshold: next.threshold,
        strategy: savedStrategy,
        stickyLimit: savedSticky,
      });
      setDraft(String(next.threshold));
      setStickyDraft(String(savedSticky));
    } catch {
      setError(t(`${p}.saveFailed`));
      if (previousState) {
        setState(previousState);
        setDraft(String(previousState.threshold));
        setStickyDraft(String(previousState.stickyLimit));
      }
    } finally {
      setSaving(false);
    }
  }, [apiBase, p, provider, state, t]);

  const enabled = state?.enabled === true;
  const threshold = state?.threshold ?? 80;
  const strategy = state?.strategy ?? DEFAULT_ACCOUNT_POOL_STRATEGY;
  const stickyLimit = state?.stickyLimit ?? DEFAULT_ACCOUNT_POOL_STICKY_LIMIT;
  const loading = state === null && !loadError;
  const toggleDisabled = loading || saving || loadError || (!enabled && accountCount < 2);

  return (
    <div className="card" style={{ marginTop: 12 }} aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{t(`${p}.title`)}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadError
              ? t(`${p}.loadFailed`)
              : loading
                ? t("common.loading")
                : enabled
                  ? t(`${p}.enabledDesc`, { threshold })
                  : t(`${p}.disabledDesc`)}
          </div>
        </div>
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          disabled={toggleDisabled}
          aria-pressed={enabled}
          aria-label={t(`${p}.title`)}
          title={enabled ? t(`${p}.on`) : t(`${p}.off`)}
          onClick={() => {
            void save({
              enabled: !enabled,
              threshold,
              strategy,
              stickyLimit,
            });
          }}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      <div
        role="alert"
        className="card-sub"
        style={{
          marginTop: 10,
          padding: "10px 16px",
          border: "1px solid var(--border, #c9a227)",
          borderRadius: 6,
          background: "color-mix(in srgb, var(--warn, #c9a227) 12%, transparent)",
        }}
      >
        {t(`${p}.experimentalWarning`)}
      </div>

      {accountCount < 2 && (
        <div className="card-sub" style={{ marginTop: 8 }}>{t(`${p}.needTwoAccounts`)}</div>
      )}

      {enabled && state && (
        <>
          <label className="field" style={{ display: "block", marginTop: 12 }}>
            <span className="field-label">{t(`${p}.threshold`)}</span>
            <input
              className="input mono"
              type="number"
              min={0}
              max={100}
              step={1}
              value={draft}
              disabled={saving}
              aria-label={t(`${p}.thresholdAria`)}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                const parsed = Number(draft);
                if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
                  setDraft(String(threshold));
                  setError(t(`${p}.thresholdInvalid`));
                  return;
                }
                if (parsed !== threshold) {
                  void save({
                    enabled: true,
                    threshold: parsed,
                    strategy,
                    stickyLimit,
                  });
                }
              }}
            />
            <div className="card-sub" style={{ marginTop: 4 }}>{t(`${p}.thresholdHelp`)}</div>
          </label>

          <AccountPoolStrategyControls
            strategy={strategy}
            stickyDraft={stickyDraft}
            disabled={saving}
            strategySelectId={`${provider}-pool-strategy`}
            stickyInputId={`${provider}-pool-sticky-limit`}
            onStrategyChange={(next) => {
              if (next === strategy) return;
              void save({
                enabled: true,
                threshold,
                strategy: next,
                stickyLimit,
              });
            }}
            onStickyDraftChange={setStickyDraft}
            onStickyCommit={(nextDraft) => {
              const parsed = parseAccountPoolStickyLimitDraft(nextDraft ?? stickyDraft);
              if (parsed === null) {
                setStickyDraft(String(stickyLimit));
                setError(t("accountPool.stickyLimitInvalid"));
                return;
              }
              if (parsed === stickyLimit) {
                setStickyDraft(String(parsed));
                return;
              }
              void save({
                enabled: true,
                threshold,
                strategy,
                stickyLimit: parsed,
              });
            }}
          />
        </>
      )}

      {error && (
        <div role="alert" className="card-sub" style={{ marginTop: 8, color: "var(--danger, #c44)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
