import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeRunEventHandler,
  readAgentModeForSession,
  TOOL_LINE_FLUSH_MS,
  type AgentToolLine,
} from './useAgent';
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
    h.flush();

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
    h.flush();

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
    h.flush();

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
    h.flush();

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
    h.flush();

    expect(patches.map((p) => p.phase)).toEqual(['thinking', 'writing', 'tool', 'finalizing']);
    expect(patches[2].tool).toEqual({
      id: 'c1',
      name: 'read_file',
      target: 'a.ts',
    });
  });
});

describe('Faz 3 — canlı araç çıktısı birleştirme', () => {
  beforeEach(seed);

  function collectingHandler() {
    const lines: AgentToolLine[] = [];
    const h = makeRunEventHandler({
      sessionId: SESSION_ID,
      assistantId: ASSISTANT_ID,
      provider: 'anthropic',
      model: 'x',
      callNames: new Map(),
      emit: (line) => lines.push(line),
    });
    return { h, lines };
  }

  it('pencere içindeki parçaları tek satırda birleştirir', () => {
    vi.useFakeTimers();
    try {
      const { h, lines } = collectingHandler();
      h({ k: 'tool_call', call: { id: 'c1', name: 'exec', args: { cmd: 'ls' } } });
      const afterCall = lines.length;

      h({ k: 'tool_stream', id: 'c1', stream: 'stdout', data: 'a' });
      h({ k: 'tool_stream', id: 'c1', stream: 'stdout', data: 'b' });
      expect(lines.length).toBe(afterCall); // pencere dolmadı

      vi.advanceTimersByTime(TOOL_LINE_FLUSH_MS);
      expect(lines.length).toBe(afterCall + 1);
      const tool = lines[lines.length - 1].tool;
      expect(tool?.output).toBe('ab');
      expect(tool?.status).toBe('run');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tool_result öncesinde bekleyen çıktıyı hemen yazar', () => {
    vi.useFakeTimers();
    try {
      const { h, lines } = collectingHandler();
      h({ k: 'tool_call', call: { id: 'c1', name: 'exec', args: { cmd: 'ls' } } });
      h({ k: 'tool_stream', id: 'c1', stream: 'stdout', data: 'canlı' });
      h({ k: 'tool_result', id: 'c1', ok: true, output: 'canlı bitti' });

      // Sonuç beklemeden önce canlı satır, hemen ardından sonuç satırı.
      expect(lines.map((l) => l.tool?.status)).toEqual(['run', 'run', 'ok']);
      expect(lines[1].tool?.output).toBe('canlı');
      expect(lines[2].tool?.output).toBe('canlı bitti');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush bekleyen canlı çıktıyı kaybetmez', () => {
    vi.useFakeTimers();
    try {
      const { h, lines } = collectingHandler();
      h({ k: 'tool_call', call: { id: 'c1', name: 'exec', args: { cmd: 'ls' } } });
      h({ k: 'tool_stream', id: 'c1', stream: 'stdout', data: 'x' });
      h.flush();
      expect(lines[lines.length - 1].tool?.output).toBe('x');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Bölüm 8: bayat session yerine taze mod ───────────────────────────────────

describe('Bölüm 8 — gönderimde taze agent modu okunur', () => {
  beforeEach(seed);

  it('store o an hangi moddaysa onu döndürür', () => {
    expect(readAgentModeForSession(SESSION_ID)).toBe('build');
    useSessionStore.getState().setAgentMode(SESSION_ID, 'plan');
    expect(readAgentModeForSession(SESSION_ID)).toBe('plan');
    useSessionStore.getState().setAgentMode(SESSION_ID, 'ask');
    expect(readAgentModeForSession(SESSION_ID)).toBe('ask');
  });

  it('bozuk/eksik kayıtta güvenli varsayılana düşer', () => {
    useSessionStore.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === SESSION_ID ? { ...sess, agentMode: 'PLAN ' as unknown as 'plan' } : sess,
      ),
    }));
    // `'PLAN '` normalize edilir → plan (build'e sessizce düşmez).
    expect(readAgentModeForSession(SESSION_ID)).toBe('plan');

    useSessionStore.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === SESSION_ID ? { ...sess, agentMode: 'turbo' as unknown as 'build' } : sess,
      ),
    }));
    expect(readAgentModeForSession(SESSION_ID)).toBe('build');

    useSessionStore.setState((s) => ({
      sessions: s.sessions.map((sess) => {
        const { agentMode: _drop, ...rest } = sess;
        return rest as typeof sess;
      }),
    }));
    expect(readAgentModeForSession(SESSION_ID)).toBe('build');

    // Bilinmeyen oturum kimliği de çökmez.
    expect(readAgentModeForSession('yok')).toBe('build');
  });
});
