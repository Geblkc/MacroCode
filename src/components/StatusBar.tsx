import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '../store/session';
import { useSettingsStore } from '../store/settings';
import { useWorkspaceStore } from '../store/workspace';
import { sessionCost } from '../lib/pricing';
import { contextUsage } from '../lib/engine/contextUsage';
import { useT } from '../lib/i18n';
import { useGitStore } from '../store/git';
import { useActiveAgentActivity } from '../hooks/useAgentActivity';
import { agentActivityLabelKey } from '../lib/agentActivity';
import { Icon } from './icons';

interface Props {
  /** Bekleyen onay sayısı (badge + uyarı). */
  pendingCount?: number;
  /** Akış sürüyor (nabız atan rozet — Faz 7). */
  isStreaming?: boolean;
  /** Bekleyen onaya kaydır. */
  onPendingClick?: () => void;
  /** Klasör rozetine tıkla → /root diyalog yolunu aç (App'te kodlanır). */
  onWorkspaceClick?: () => void;
  /** Bağlam rozetine tıkla → bağlamı şimdi özetle (/compact). */
  onCompact?: () => void;
  /** Git rozetine tıkla → Git panelini aç/kapat. */
  onGitClick?: () => void;
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function StatusBar({
  pendingCount = 0,
  isStreaming,
  onPendingClick,
  onWorkspaceClick,
  onCompact,
  onGitClick,
}: Props) {
  const t = useT();
  const agentActivity = useActiveAgentActivity();
  // Faz 2: tam `sessions` yerine yalnız görünen alanlar. `rev` yalnızca
  // token/bağlam/maliyet değişiminde artar → ağır hesaplar akış sırasında
  // her deltada tekrarlanmaz.
  const active = useSessionStore(
    useShallow((s) => {
      const sess = s.sessions.find((x) => x.id === s.activeSessionId);
      return {
        id: s.activeSessionId,
        model: sess?.model ?? '',
        provider: sess?.provider ?? null,
        agentMode: sess?.agentMode ?? 'build',
        rev: s.usageRevision,
      };
    }),
  );
  const activeId = active.id;
  const keyStatus = useSettingsStore((s) => s.keyStatus);
  const currentProvider = useSettingsStore((s) => s.currentProvider);
  const currentModel = useSettingsStore((s) => s.currentModel);
  const customModels = useSettingsStore((s) => s.customModels);
  const prices = useSettingsStore((s) => s.prices);
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const root = useWorkspaceStore((s) => s.root);
  const label = useWorkspaceStore((s) => s.label);
  const approvalMode = useWorkspaceStore((s) => s.approvalMode);
  const gitInfo = useGitStore((s) => s.info);
  const gitStatus = useGitStore((s) => s.status);
  const gitOpen = useGitStore((s) => s.open);

  const model = active.model || currentModel;
  const provider = active.provider ?? currentProvider;

  // Bağlam = **son API isteğinin** boyutu (agent'ta adım başına kaydedilir);
  // oturum toplamı ise ayrı gösterilir. Gerçek usage yoksa yaklaşık geçmiş
  // token'ına düşülür — `tokens` agent turunda kümülatif olduğu için kullanılmaz.
  //
  // Faz 2: mesaj dizisi yerine `usageRevision` bağımlılığı. Streaming metin
  // deltaları bu değeri artırmaz; akış bitince (setStreaming(false)) ve her
  // gerçek usage olayında tazelenir.
  const { inTok, outTok, ctx, cost } = useMemo(() => {
    // `rev` yalnızca türevlerin tazelenme sinyalidir (gövdede kullanılmaz).
    void active.rev;
    const sess = activeId
      ? (useSessionStore.getState().sessions.find((s) => s.id === activeId) ?? null)
      : null;
    const messages = sess?.messages ?? [];
    let i = 0;
    let o = 0;
    for (const m of messages) {
      const tok = m.tokens;
      if (!tok) continue;
      i += tok.input ?? 0;
      o += tok.output ?? 0;
    }
    let sessionCostValue: number | null = null;
    if (sess && Object.keys(prices).length > 0) {
      try {
        const r = sessionCost(messages, prices);
        sessionCostValue = r.cost > 0 ? r.cost : null;
      } catch {
        sessionCostValue = null;
      }
    }
    return {
      inTok: i,
      outTok: o,
      ctx: contextUsage(messages, model, customModels),
      cost: sessionCostValue,
    };
  }, [activeId, active.rev, model, customModels, prices]);
  const ctxClass = ctx.level === 'err' ? 'err' : ctx.level === 'warn' ? 'warn' : '';
  const ctxTitle = t('status.contextUsage', {
    used: fmtCount(ctx.used),
    total: fmtCount(ctx.window),
    percent: ctx.percent,
    compactAt: ctx.compactAt,
  });
  const ctxMeter = (
    <>
      <span className="ctx-meter" aria-hidden="true">
        <span className={`ctx-fill ${ctxClass}`} style={{ width: `${ctx.percent}%` }} />
      </span>
      {fmtCount(ctx.used)} / {fmtCount(ctx.window)}
    </>
  );

  const connected = keyStatus[provider] ?? false;
  const mcpOn = mcpServers.filter((m) => m.enabled).length;
  const approvalLabel =
    approvalMode === 'manual'
      ? t('status.approval.manual')
      : approvalMode === 'auto-read'
        ? t('status.approval.autoRead')
        : t('status.approval.autoEdit');

  const agentMode = active.agentMode;
  const modeKey =
    agentMode === 'build' ? 'mode.build' : agentMode === 'plan' ? 'mode.plan' : 'mode.ask';
  const modeDescKey =
    agentMode === 'build'
      ? 'mode.buildDesc'
      : agentMode === 'plan'
        ? 'mode.planDesc'
        : 'mode.askDesc';
  const modeLabel = t(modeKey);
  const activityLabel = agentActivity
    ? t(agentActivityLabelKey(agentActivity.phase))
    : t('status.streaming');

  return (
    <div className="statusbar" role="status" aria-label={t('status.ariaLabel')}>
      <span className="sb-item strong">
        <span
          className={`status-dot${connected ? '' : ' off'}`}
          aria-hidden="true"
          title={connected ? t('status.connected') : t('status.disconnected')}
        />
        {provider}
      </span>

      <span className="sb-sep" aria-hidden="true" />

      <span className="sb-item" title={model}>
        {model}
      </span>

      <span className="sb-sep" aria-hidden="true" />

      <span className="sb-item sb-mode-tag" title={t(modeDescKey)}>
        <Icon
          name={agentMode === 'build' ? 'wrench' : agentMode === 'plan' ? 'list-checks' : 'message'}
          size="sm"
        />
        {modeLabel}
      </span>

      {ctx.window > 0 ? (
        <>
          <span className="sb-sep" aria-hidden="true" />
          {onCompact ? (
            <button
              type="button"
              className={`sb-item btn-reset clickable${ctx.level !== 'ok' ? ` ctx-${ctx.level}` : ''}`}
              title={`${ctxTitle} · ${t('status.contextCompact')}`}
              aria-label={`${ctxTitle} · ${t('status.contextCompact')}`}
              onClick={onCompact}
            >
              {ctxMeter}
            </button>
          ) : (
            <span
              className={`sb-item${ctx.level !== 'ok' ? ` ctx-${ctx.level}` : ''}`}
              title={ctxTitle}
              aria-label={ctxTitle}
            >
              {ctxMeter}
            </span>
          )}
        </>
      ) : null}

      {inTok > 0 || outTok > 0 ? (
        <>
          <span className="sb-sep" aria-hidden="true" />
          <span
            className="sb-item"
            title={`${t('status.tokenCounter')} · ${t('status.sessionTotals', {
              input: fmtCount(inTok),
              output: fmtCount(outTok),
            })}`}
          >
            <span className="sb-sigma" aria-hidden="true">
              Σ
            </span>
            ↑ {fmtCount(inTok)}&nbsp; ↓ {fmtCount(outTok)}
          </span>
        </>
      ) : null}

      {cost !== null ? (
        <span className="sb-item" title={t('status.estimatedCost')}>
          ~${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}
        </span>
      ) : null}

      {pendingCount > 0 ? (
        <>
          <span className="sb-sep" aria-hidden="true" />
          <button
            className="sb-item btn-reset"
            onClick={onPendingClick}
            title={t('status.pendingTitle')}
          >
            <span className="sb-badge">
              <Icon name="alert-triangle" size="sm" />
              {t('status.pendingCount', { count: pendingCount })}
            </span>
          </button>
        </>
      ) : null}

      {isStreaming || agentActivity ? (
        <>
          <span className="sb-sep" aria-hidden="true" />
          <span
            className={`sb-item sb-run-status${agentActivity ? ` phase-${agentActivity.phase}` : ''}`}
            title={
              agentActivity
                ? `${t('agentActivity.ariaLabel')}: ${activityLabel}`
                : t('status.streaming')
            }
          >
            {agentActivity ? (
              <span className="sb-run-spinner" aria-hidden="true" />
            ) : (
              <span className="stream-dot" aria-hidden="true" />
            )}
            {activityLabel}
          </span>
        </>
      ) : null}

      <span className="sb-item" title={t('status.approvalMode')}>
        <Icon name="activity" size="sm" />
        {approvalLabel}
      </span>

      <span className="sb-right">
        {onGitClick && gitInfo?.isRepo && gitStatus ? (
          <>
            <button
              type="button"
              className={`sb-item btn-reset clickable sb-git${gitOpen ? ' open' : ''}`}
              title={t('status.gitTitle')}
              aria-label={t('status.gitTitle')}
              onClick={onGitClick}
            >
              <Icon name="branch" size="sm" />
              <span className="sb-git-branch">
                {gitStatus.detached ? t('status.gitDetached') : gitStatus.branch || 'HEAD'}
              </span>
              {gitStatus.ahead > 0 ? <span>↑{gitStatus.ahead}</span> : null}
              {gitStatus.behind > 0 ? <span>↓{gitStatus.behind}</span> : null}
              <span className={`sb-git-dirty${gitStatus.files.length > 0 ? ' dirty' : ''}`}>
                {gitStatus.files.length > 0
                  ? t('status.gitDirty', { count: gitStatus.files.length })
                  : t('status.gitClean')}
              </span>
            </button>
            <span className="sb-sep" aria-hidden="true" />
          </>
        ) : null}
        {root ? (
          <button
            className="sb-item btn-reset clickable"
            title={onWorkspaceClick ? t('status.workspaceTitle') : root}
            aria-label={t('status.workspaceTitle')}
            onClick={onWorkspaceClick}
          >
            <Icon name="folder" size="sm" />
            {label || root.split('/').filter(Boolean).pop() || root}
          </button>
        ) : null}
        {mcpOn > 0 ? (
          <>
            {root ? <span className="sb-sep" aria-hidden="true" /> : null}
            <span className="sb-item" title={t('status.mcpActive', { count: mcpOn })}>
              <Icon name="cpu" size="sm" />
              {mcpOn} MCP
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

// Faz 2: App streaming sırasında yeniden render olsa da (Terminal için gerekli)
// StatusBar prop'ları ve `active` özeti değişmedikçe atlanır.
export default memo(StatusBar);
