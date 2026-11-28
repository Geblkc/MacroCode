import { describe, expect, it } from 'vitest';
import { createAgentRun, type AgentRunState } from './agent';
import type { AgentEvent } from './types';

describe('Faz 12 B.8 — agent durumu kalıcılığı (run_state)', () => {
  it('serialize: geçmiş + adım + bekleyen çağrı kaydedilir', async () => {
    const events: AgentEvent[] = [];
    let n = 0;
    const run = createAgentRun([{ role: 'user', content: 'yaz' }], {
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      workspaceRoot: '/tmp',
      onEvent: (e) => events.push(e),
      streamImpl: async ({ onChunk }) => {
        n++;
        if (n === 1) {
          onChunk({
            text: '',
            done: false,
            toolCalls: [{ id: 'c1', name: 'exec', args: { cmd: 'ls' } }],
          });
          onChunk({ text: '', done: true });
        } else {
          onChunk({ text: 'bitti', done: false });
          onChunk({ text: '', done: true });
        }
      },
    });
    const r = await run.step();
    expect(r.kind).toBe('needs-approval');

    const state = JSON.parse(run.serialize()) as AgentRunState;
    expect(state.steps).toBe(1);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0].call.id).toBe('c1');
    // Geçmiş: kullanıcı + assistant(toolCalls) + tool sonucu yok (onay bekliyor)
    expect(state.msgs.length).toBeGreaterThanOrEqual(2);
  });

  it('restore: kayıtlı durumdan run kaldığı yerden sürer', async () => {
    // 1. tur: exec çağrısı → onay bekliyor.
    let n = 0;
    const run = createAgentRun([{ role: 'user', content: 'yaz' }], {
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      workspaceRoot: '/tmp',
      onEvent: () => {},
      streamImpl: async ({ onChunk }) => {
        n++;
        if (n === 1) {
          onChunk({
            text: '',
            done: false,
            toolCalls: [{ id: 'c1', name: 'exec', args: { cmd: 'ls' } }],
          });
          onChunk({ text: '', done: true });
        } else {
          onChunk({ text: 'devam etti', done: false });
          onChunk({ text: '', done: true });
        }
      },
    });
    await run.step();
    const saved = run.serialize();

    // 2. tur: YENİ run, kayıtlı durumdan (restart simülasyonu).
    const state = JSON.parse(saved) as AgentRunState;
    const events: AgentEvent[] = [];
    const restored = createAgentRun(
      [],
      {
        provider: 'openai',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: '/tmp',
        onEvent: (e) => events.push(e),
        streamImpl: async ({ onChunk }) => {
          onChunk({ text: 'devam etti', done: false });
          onChunk({ text: '', done: true });
        },
      },
      state,
    );
    // Onaylanan iş: resolve → run devam eder.
    const r = await restored.resolve([{ id: 'c1', approved: true }]);
    expect(r.kind).toBe('done');
    const texts = events
      .filter((e) => e.k === 'text')
      .map((e) => (e.k === 'text' ? e.delta : ''))
      .join('');
    expect(texts).toContain('devam etti');
  });

  it('serialize: agentMode kaydedilir', async () => {
    const run = createAgentRun([{ role: 'user', content: 'x' }], {
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      workspaceRoot: '/tmp',
      agentMode: 'plan',
      onEvent: () => {},
      streamImpl: async ({ onChunk }) => {
        onChunk({ text: 'plan', done: false });
        onChunk({ text: '', done: true });
      },
    });
    await run.step();
    const state = JSON.parse(run.serialize()) as AgentRunState;
    expect(state.agentMode).toBe('plan');
  });

  it('restore: run kendi modunu taşır — farklı modda exec onayı çalışmaz', async () => {
    // 1) Build modunda exec onay bekliyor.
    let executed = 0;
    const buildRun = createAgentRun([{ role: 'user', content: 'x' }], {
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      workspaceRoot: '/tmp',
      agentMode: 'build',
      onEvent: () => {},
      streamImpl: async ({ onChunk }) => {
        onChunk({
          text: '',
          done: false,
          toolCalls: [{ id: 'c1', name: 'exec', args: { cmd: 'ls' } }],
        });
        onChunk({ text: '', done: true });
      },
    });
    const step = await buildRun.step();
    expect(step.kind).toBe('needs-approval');
    const saved = JSON.parse(buildRun.serialize()) as AgentRunState;

    // 2) Restore: state kendi modunu (build) taşır; deps ise artık 'plan'.
    const events: AgentEvent[] = [];
    const restored = createAgentRun(
      [],
      {
        provider: 'openai',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: '/tmp',
        agentMode: 'plan',
        onEvent: (e) => events.push(e),
        runToolImpl: async () => {
          executed++;
          return 'çalıştı';
        },
        streamImpl: async ({ onChunk }) => {
          onChunk({ text: 'bitti', done: false });
          onChunk({ text: '', done: true });
        },
      },
      saved,
    );
    const r = await restored.resolve([{ id: 'c1', approved: true }]);
    expect(r.kind).toBe('done');
    expect(executed).toBe(0);
    const results = events.filter((e) => e.k === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].k === 'tool_result' && results[0].ok).toBe(false);
    expect(results[0].k === 'tool_result' && results[0].output).toContain('tool_disallowed');
  });

  it('restore: kayıtlı mod plan ise read_file onayı çalışır', async () => {
    const state: AgentRunState = {
      msgs: [{ role: 'user', content: 'x' }],
      steps: 1,
      finalText: '',
      usage: null,
      agentMode: 'plan',
      pending: [{ call: { id: 'c2', name: 'read_file', args: { path: 'a.ts' } } }],
    };
    let executed = 0;
    const run = createAgentRun(
      [],
      {
        provider: 'openai',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: '/tmp',
        agentMode: 'plan',
        onEvent: () => {},
        runToolImpl: async () => {
          executed++;
          return 'dosya';
        },
        streamImpl: async ({ onChunk }) => {
          onChunk({ text: 'tamam', done: false });
          onChunk({ text: '', done: true });
        },
      },
      state,
    );
    const r = await run.resolve([{ id: 'c2', approved: true }]);
    expect(r.kind).toBe('done');
    expect(executed).toBe(1);
  });

  it('restore: adım sayısı korunur (maxSteps aşılmaz)', async () => {
    const state: AgentRunState = {
      msgs: [{ role: 'user', content: 'x' }],
      steps: 7,
      finalText: 'önceki',
      usage: null,
      pending: [],
    };
    const run = createAgentRun(
      [],
      {
        provider: 'openai',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: '/tmp',
        maxSteps: 8,
        onEvent: () => {},
        streamImpl: async ({ onChunk }) => {
          onChunk({ text: 'tur', done: false });
          onChunk({ text: '', done: true });
        },
      },
      state,
    );
    const r = await run.step();
    // 7'den başladı → maxSteps 8 → tek tur daha, sonra biter.
    expect(r.kind).toBe('done');
    const s = JSON.parse(run.serialize()) as AgentRunState;
    expect(s.steps).toBe(8);
  });

  it('restore: döngü koruması onayı geri yüklenir ve aracı çalıştırmaz', async () => {
    const state: AgentRunState = {
      msgs: [{ role: 'user', content: 'x' }],
      steps: 4,
      finalText: '',
      usage: null,
      pending: [{ call: { id: 'g4', name: 'read_file', args: { path: 'a.ts' } }, loopGuard: true }],
    };
    let turns = 0;
    let executed = 0;
    const run = createAgentRun(
      [],
      {
        provider: 'openai',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: '/tmp',
        onEvent: () => {},
        streamImpl: async ({ onChunk }) => {
          turns++;
          onChunk({ text: 'farklı yol', done: false });
          onChunk({ text: '', done: true });
        },
        runToolImpl: async () => {
          executed++;
          return 'çalışmamalıydı';
        },
      },
      state,
    );
    const r = await run.resolve([{ id: 'g4', approved: true }]);
    if (r.kind !== 'done') throw new Error('done bekleniyordu');
    expect(r.text).toContain('farklı yol');
    expect(turns).toBe(1);
    expect(executed).toBe(0);
  });

  it('restore: pending çağrılar step() ile yeniden bildirilir', async () => {
    const state: AgentRunState = {
      msgs: [{ role: 'user', content: 'x' }],
      steps: 1,
      finalText: '',
      usage: null,
      pending: [{ call: { id: 'c9', name: 'exec', args: { cmd: 'ls' } } }],
    };
    const run = createAgentRun(
      [],
      {
        provider: 'openai',
        apiKey: 'k',
        model: 'm',
        workspaceRoot: '/tmp',
        onEvent: () => {},
        streamImpl: async ({ onChunk }) => {
          onChunk({ text: '', done: true });
        },
      },
      state,
    );
    const r = await run.step();
    expect(r.kind).toBe('needs-approval');
    if (r.kind === 'needs-approval') {
      expect(r.pending[0].id).toBe('c9');
    }
  });
});
