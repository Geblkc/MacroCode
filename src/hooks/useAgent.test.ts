import { beforeEach, describe, expect, it } from 'vitest';
import { makeRunEventHandler } from './useAgent';
import { useSessionStore } from '../store/session';
import type { AgentActivityPatch } from '../store/agentActivity';
import { buildAgentHistory, toProviderMessages } from '../lib/engine/agent';

const SESSION_ID = 's1';
const ASSISTANT_ID = 'a0';

function seed(): void {
  const now = 1;
  useSessionStore.setState({
    sessions: [
      {
        id: SESSION_ID,
        name: 'test',
        createdAt: now,
        updatedAt: now,
        agentMode: 'build',
        provider: 'anthropic',
        model: 'x',
        systemPrompt: '',
        messages: [
          { id: 'u0', role: 'user', content: 'soru', timestamp: now },
          {
            id: ASSISTANT_ID,
            role: 'assistant',
            content: '',
            timestamp: now,
            provider: 'anthropic',
            model: 'x',
          },
        ],
      },
    ],
    activeSessionId: SESSION_ID,
    streamingSessions: { [SESSION_ID]: true },
  });
}

function msgs() {
  return useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID)!.messages;
}

function handler(onActivity?: (patch: AgentActivityPatch) => void) {
  return makeRunEventHandler({
    sessionId: SESSION_ID,
    assistantId: ASSISTANT_ID,
    provider: 'anthropic',
    model: 'x',
    callNames: new Map(),
    emit: () => {},
    activity: onActivity ? { runId: 'run-1', update: onActivity } : undefined,
  });
}

describe('v1.0 — nihai cevap araç çıktılarının altında', () => {
  beforeEach(seed);

  it('tool sonrası metin dizinin sonundaki yeni assistant mesajına yazılır', () => {
    const h = handler();
    h({ k: 'text', delta: 'bakıyorum' });
    h({ k: 'tool_call', call: { id: 'c1', name: 'read_file', args: { path: 'a.ts' } } });
    h({ k: 'tool_result', id: 'c1', ok: true, output: 'içerik' });
    h({ k: 'text', delta: 'nihai cevap' });

    const all = msgs();
    expect(all.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'assistant']);
    expect(all[1].content).toBe('bakıyorum');
    expect(all[1].toolCalls?.[0].id).toBe('c1');
    expect(all[2].toolCallId).toBe('c1');
    expect(all[3].content).toBe('nihai cevap');
    expect(h.targetId()).toBe(all[3].id);
  });

  it('provider geçmişinde çağrı → sonuç → cevap sırası korunur', () => {
    const h = handler();
    h({ k: 'text', delta: 'bakıyorum' });
    h({ k: 'tool_call', call: { id: 'c1', name: 'read_file', args: { path: 'a.ts' } } });
    h({ k: 'tool_result', id: 'c1', ok: true, output: 'içerik' });
    h({ k: 'text', delta: 'nihai cevap' });

    const history = buildAgentHistory(msgs(), 'unused');
    expect(toProviderMessages(history).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('araç sonucu araya girmediyse cevap tek mesajda kalır', () => {
    const h = handler();
    h({ k: 'text', delta: 'merhaba ' });
    h({ k: 'text', delta: 'dünya' });

    expect(msgs()).toHaveLength(2);
    expect(msgs()[1].content).toBe('merhaba dünya');
    expect(h.targetId()).toBe(ASSISTANT_ID);
  });

  it('birden fazla araç turunda her sonuç kendi çağrısını izler', () => {
    const h = handler();
    h({ k: 'text', delta: 'bir' });
    h({ k: 'tool_call', call: { id: 'c1', name: 'read_file', args: { path: 'a.ts' } } });
    h({ k: 'tool_result', id: 'c1', ok: true, output: 'A' });
    h({ k: 'tool_call', call: { id: 'c2', name: 'read_file', args: { path: 'b.ts' } } });
    h({ k: 'tool_result', id: 'c2', ok: true, output: 'B' });
    h({ k: 'text', delta: 'iki' });

    const all = msgs();
    expect(all.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'system',
      'assistant',
      'system',
      'assistant',
    ]);
    expect(all[3].toolCalls?.[0].id).toBe('c2');
    expect(all[4].toolCallId).toBe('c2');
    expect(all[5].content).toBe('iki');
  });

  it('aktivite aşamasını model, araç ve sonuç olaylarıyla eşleştirir', () => {
    const patches: AgentActivityPatch[] = [];
    const h = handler((patch) => patches.push(patch));

    h({ k: 'turn_start' });
    h({ k: 'text', delta: 'yanıt' });
    h({ k: 'tool_call', call: { id: 'c1', name: 'read_file', args: { path: 'a.ts' } } });
    h({ k: 'tool_result', id: 'c1', ok: true, output: 'A' });

    expect(patches.map((p) => p.phase)).toEqual(['thinking', 'writing', 'tool', 'finalizing']);
    expect(patches[2].tool).toEqual({
      id: 'c1',
      name: 'read_file',
      target: 'a.ts',
    });
  });
});
