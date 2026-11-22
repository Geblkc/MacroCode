import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentActivityStore } from './agentActivity';

const SESSION_ID = 'session-1';

describe('Agent aktivite durumu', () => {
  beforeEach(() => {
    useAgentActivityStore.setState({ activities: {} });
  });

  it('oturum için hazırlık aşamasını başlatır', () => {
    const store = useAgentActivityStore.getState();
    store.begin(SESSION_ID, 'run-1');

    const activity = useAgentActivityStore.getState().activities[SESSION_ID];
    expect(activity.phase).toBe('preparing');
    expect(activity.runId).toBe('run-1');
  });

  it('aynı turda aşamayı ve araç hedefini günceller', () => {
    const store = useAgentActivityStore.getState();
    store.begin(SESSION_ID, 'run-1');
    store.update(SESSION_ID, 'run-1', {
      phase: 'tool',
      tool: { id: 'call-1', name: 'read_file', target: 'src/App.tsx' },
    });

    const activity = useAgentActivityStore.getState().activities[SESSION_ID];
    expect(activity.phase).toBe('tool');
    expect(activity.tool?.target).toBe('src/App.tsx');
  });

  it('farklı bir turun geç temizliği yeni turu silmez', () => {
    const store = useAgentActivityStore.getState();
    store.begin(SESSION_ID, 'run-2');
    store.end(SESSION_ID, 'run-1');

    expect(useAgentActivityStore.getState().activities[SESSION_ID]?.runId).toBe('run-2');
  });

  it('eski turun olayı yeni turun aşamasını değiştiremez', () => {
    const store = useAgentActivityStore.getState();
    store.begin(SESSION_ID, 'run-2');
    store.update(SESSION_ID, 'run-1', { phase: 'tool' });

    expect(useAgentActivityStore.getState().activities[SESSION_ID]?.phase).toBe('preparing');
  });

  it('eşleşen tur bittiğinde aktiviteyi temizler', () => {
    const store = useAgentActivityStore.getState();
    store.begin(SESSION_ID, 'run-1');
    store.end(SESSION_ID, 'run-1');

    expect(useAgentActivityStore.getState().activities[SESSION_ID]).toBeUndefined();
  });
});
