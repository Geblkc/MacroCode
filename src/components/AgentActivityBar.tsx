import { useT } from '../lib/i18n';
import { agentActivityLabelKey, agentToolLabelKey } from '../lib/agentActivity';
import type { AgentActivity } from '../store/agentActivity';
import { Icon, type IconName } from './icons';

interface Props {
  activity: AgentActivity;
}

function activityIcon(phase: AgentActivity['phase']): IconName {
  if (phase === 'awaiting_approval') return 'clock';
  if (phase === 'retrying') return 'refresh';
  return 'cpu';
}

/**
 * Agent çalışmasını her zaman görünür tutan aktivite şeridi.
 * Metin değişse de spinner DOM düğümü değişmez; animasyon yeniden başlamaz.
 */
export default function AgentActivityBar({ activity }: Props) {
  const t = useT();
  const label = t(agentActivityLabelKey(activity.phase));

  let detail: string | null = null;
  if (activity.tool) {
    const toolKey = agentToolLabelKey(activity.tool.name);
    const toolLabel = toolKey ? t(toolKey) : activity.tool.name;
    detail = activity.tool.target ? `${toolLabel} · ${activity.tool.target}` : toolLabel;
  }
  if (activity.phase === 'retrying' && activity.retry) {
    detail = t('agentActivity.retryDetail', {
      attempt: activity.retry.attempt,
      total: activity.retry.maxAttempts,
    });
  }

  return (
    <div
      className="agent-activity"
      data-phase={activity.phase}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`${t('agentActivity.ariaLabel')}: ${label}${detail ? ` — ${detail}` : ''}`}
    >
      <span className="agent-activity-visual" aria-hidden="true">
        <Icon name={activityIcon(activity.phase)} size="sm" />
      </span>
      <span className="agent-activity-copy">
        <span className="agent-activity-title">{label}</span>
        {detail ? <span className="agent-activity-detail">{detail}</span> : null}
      </span>
    </div>
  );
}
