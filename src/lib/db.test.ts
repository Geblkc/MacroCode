import { describe, expect, it } from 'vitest';
import { appendAudit, parseSession, readAuditLog, saveSessionsToDb, type SqlDatabase } from './db';
import type { Session } from '../types';

function fakeDb(): SqlDatabase & { rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    async execute(query: string, bind?: unknown[]) {
      const q = query.trim().toUpperCase();
      if (q.startsWith('CREATE TABLE')) return null;
      if (q.startsWith('INSERT INTO AUDIT_LOG')) {
        const [id, ts, session_id, tool, args_preview, decision, result] = (bind ?? []) as [
          string,
          number,
          string,
          string,
          string,
          string,
          string,
        ];
        rows.push({ id, ts, session_id, tool, args_preview, decision, result });
        return null;
      }
      return null;
    },
    async select<T>(): Promise<T> {
      return [...rows].sort((a, b) => Number(b.ts) - Number(a.ts)) as unknown as T;
    },
  };
}

describe('Faz 6 — audit_log', () => {
  it('yaz → oku roundtrip, decision korunur', async () => {
    const db = fakeDb();
    expect(
      await appendAudit(
        {
          sessionId: 's1',
          tool: 'exec',
          argsPreview: '{"cmd":"ls"}',
          decision: 'approved',
          result: 'ok',
        },
        db,
      ),
    ).toBe(true);
    const rows = await readAuditLog('s1', 20, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 's1', tool: 'exec', decision: 'approved' });
  });

  it('L6/L7: audit argsPreview/result yazılmadan önce redakte edilir', async () => {
    const db = fakeDb();
    await appendAudit(
      {
        sessionId: 's2',
        tool: 'mcp:server:call',
        argsPreview: '{"apiKey":"sk-abcdefghijklmnop","q":"normal"}',
        decision: 'approved',
        result: 'ok Bearer abcdefghijklmnopqrst',
      },
      db,
    );
    const rows = await readAuditLog('s2', 20, db);
    expect(rows[0].argsPreview).not.toContain('sk-abcdefghijklmnop');
    expect(rows[0].argsPreview).toContain('«redakte»');
    expect(rows[0].argsPreview).toContain('normal');
    expect(rows[0].result).not.toContain('abcdefghijklmnopqrst');
    expect(rows[0].result).toContain('«redakte»');
  });

  it('DB yoksa sessizce boş döner', async () => {
    await expect(readAuditLog('s1', 20, undefined)).resolves.toEqual([]);
  });

  it('session snapshot transaction komutlarını plugin havuzuna dağıtmaz', async () => {
    const queries: string[] = [];
    const db: SqlDatabase = {
      async execute(query: string) {
        queries.push(query);
        return null;
      },
      async select<T>() {
        return [] as unknown as T;
      },
    };
    const session: Session = {
      id: 's1',
      name: 'Test',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      provider: 'anthropic',
      model: 'claude-test',
      systemPrompt: '',
    };

    await expect(saveSessionsToDb([session], 's1', db)).resolves.toBe(true);
    expect(queries.some((query) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(query.trim()))).toBe(false);
  });
});

// ── Bölüm 9: DB'den yüklenen oturumlarda agentMode doğrulaması ───────────────

describe('Bölüm 9 — parseSession agentMode normalizasyonu', () => {
  function raw(over: Record<string, unknown>): string {
    return JSON.stringify({
      id: 's1',
      name: 'Test',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      provider: 'anthropic',
      model: 'claude-test',
      systemPrompt: '',
      ...over,
    });
  }

  it('geçerli modlar aynen korunur', () => {
    for (const mode of ['build', 'plan', 'ask'] as const) {
      expect(parseSession(raw({ agentMode: mode }))?.agentMode).toBe(mode);
    }
  });

  it('bozuk biçim kırpılıp küçültülerek kurtarılır', () => {
    expect(parseSession(raw({ agentMode: 'PLAN' }))?.agentMode).toBe('plan');
    expect(parseSession(raw({ agentMode: ' plan ' }))?.agentMode).toBe('plan');
    expect(parseSession(raw({ agentMode: 'Ask' }))?.agentMode).toBe('ask');
    expect(parseSession(raw({ agentMode: 'BUILD' }))?.agentMode).toBe('build');
  });

  it('tanınmayan değer güvenli tarafa (plan) çekilir — build değil', () => {
    // Eskiden bilinmeyen mod build davranışına düşüp tam araç setini açıyordu.
    expect(parseSession(raw({ agentMode: 'turbo' }))?.agentMode).toBe('plan');
    expect(parseSession(raw({ agentMode: 42 }))?.agentMode).toBe('plan');
    expect(parseSession(raw({ agentMode: {} }))?.agentMode).toBe('plan');
    expect(parseSession(raw({ agentMode: null }))?.agentMode).toBe('plan');
  });

  it('alan hiç yoksa dokunulmaz (oturum varsayılanı build)', () => {
    const s = parseSession(raw({}));
    expect(s).not.toBeNull();
    expect(s?.agentMode).toBeUndefined();
  });

  it('bozuk JSON / eksik zorunlu alan null döner', () => {
    expect(parseSession('{bozuk')).toBeNull();
    expect(parseSession(JSON.stringify({ id: 's1' }))).toBeNull();
  });
});
