import { useEffect, useState } from 'react';
import type { ToolEvent } from '../types';
import { useT } from '../lib/i18n';
import { AGENT_TOOL_LABEL } from '../lib/agentActivity';
import { cancelExec } from '../lib/engine/tools/shell';
import { Icon, type IconName } from './icons';

interface Props {
  tool: ToolEvent;
}

/** Araç adı → ikon eşlemesi. */
const TOOL_ICON: Record<string, IconName> = {
  read_file: 'file-code',
  write_file: 'file-code',
  edit_file: 'file-code',
  propose_patch: 'wrench',
  exec: 'terminal',
  grep: 'search',
  glob: 'folder',
  list_dir: 'folder',
  todo: 'list-checks',
  plan: 'list-checks',
  subagent: 'cpu',
  create_snapshot: 'clock',
};

function toolIcon(name: string): IconName {
  return TOOL_ICON[name] ?? 'wrench';
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s` : `${ms}ms`;
}

export default function ToolCallCard({ tool }: Props) {
  const t = useT();
  // Çalışan exec otomatik açılır → canlı çıktı görünür olur.
  const [open, setOpen] = useState(() => tool.name === 'exec' && tool.status === 'run');
  const hasOutput = !!tool.output && tool.output.trim().length > 0;
  const failed = tool.status === 'err';
  const awaiting = tool.awaitingApproval === true;
  const running = tool.status === 'run' && !awaiting;
  const canCancel = running && tool.name === 'exec';
  const statusLabel = awaiting
    ? t('approval.pending')
    : running
      ? t('tool.running')
      : failed
        ? t('tool.failed')
        : t('tool.done');
  const labelKey = AGENT_TOOL_LABEL[tool.name];
  const label = labelKey ? t(labelKey) : tool.name;
  const target = tool.target || tool.args;
  const lineCount = hasOutput ? tool.output!.split('\n').length : 0;

  // Hata sonradan geldiğinde çıktıyı kendiliğinden aç (sebep görünür olsun).
  useEffect(() => {
    if (failed && hasOutput) setOpen(true);
  }, [failed, hasOutput]);

  return (
    <div
      className={`tool${failed ? ' tool-failed' : ''}${running ? ' tool-running' : ''}${awaiting ? ' tool-awaiting' : ''}`}
    >
      <div className="tool-head">
        <button
          className="tool-toggle"
          onClick={() => hasOutput && setOpen((v) => !v)}
          aria-expanded={hasOutput ? open : undefined}
          aria-label={`${label}${target ? ` — ${target}` : ''} — ${statusLabel}`}
        >
          <span className="tool-ico">
            <Icon name={toolIcon(tool.name)} size="sm" />
          </span>
          <span className="tool-name">{label}</span>
          {target ? (
            <span className="tool-target" title={target}>
              {target}
            </span>
          ) : null}
          {tool.ms !== undefined ? <span className="tool-dur">{formatMs(tool.ms)}</span> : null}
          <span className="tool-state">
            <span
              className={`tool-status${awaiting ? ' wait' : running ? ' run' : failed ? ' err' : ' ok'}`}
              title={statusLabel}
              aria-hidden="true"
            >
              <Icon
                name={awaiting ? 'clock' : running ? 'refresh' : failed ? 'x' : 'check'}
                size="sm"
              />
            </span>
            <span className="tool-state-label">{statusLabel}</span>
          </span>
          {hasOutput ? <Icon name="chevron-down" size="sm" className="tool-chev" /> : null}
        </button>
        {canCancel ? (
          <button
            className="tool-stop"
            onClick={() => void cancelExec(tool.id)}
            title={t('common.cancel')}
            aria-label={t('common.cancel')}
          >
            <Icon name="x" size="sm" />
          </button>
        ) : null}
      </div>
      {hasOutput && open ? (
        <div className="tool-out-wrap">
          <div className="tool-out-meta">
            <span>{t('tool.output')}</span>
            <span>{t('tool.lineCount', { count: lineCount })}</span>
          </div>
          <pre className="tool-out">{tool.output}</pre>
        </div>
      ) : null}
    </div>
  );
}
