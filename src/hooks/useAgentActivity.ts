import { useSessionStore } from '../store/session';
import { useAgentActivityStore, type AgentActivity } from '../store/agentActivity';

/** Aktif oturumun Agent aktivite durumu. */
export function useActiveAgentActivity(): AgentActivity | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  return useAgentActivityStore((s) =>
    activeSessionId ? (s.activities[activeSessionId] ?? null) : null,
  );
}
