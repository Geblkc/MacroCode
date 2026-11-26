import { beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../types';
import {
  __resetSessionSummaryCache,
  selectSessionSummaries,
  summarizeSession,
} from './sessionSummaries';

function session(over: Partial<Session> & { id: string }): Session {
  return {
    name: over.id,
    createdAt: 0,
    updatedAt: 0,
    provider: 'anthropic',
    model: 'claude',
    messages: [],
    ...over,
  } as Session;
}

describe('Faz 2 — oturum özeti', () => {
  beforeEach(() => {
    __resetSessionSummaryCache();
  });

  it('görünen alanlar sabitse aynı referansı döndürür', () => {
    const base = Date.now() - 5000;
    const a = session({ id: 'a', updatedAt: base, messages: [{ id: 'm1' } as never] });
    const s1 = summarizeSession(a);
    // Aynı dakika içinde içerik büyüse bile özet referansı korunur.
    const b = {
      ...a,
      messages: [{ id: 'm1' } as never, { id: 'm2' } as never],
      updatedAt: base + 1000,
    };
    const s2 = summarizeSession(b);
    expect(s1.messageCount).toBe(1);
    expect(s2.messageCount).toBe(2);
    expect(s2).not.toBe(s1);

    // Mesaj sayısı aynı, aynı dakika → aynı referans.
    const c = { ...b, updatedAt: base + 2000 };
    expect(summarizeSession(c)).toBe(s2);
  });

  it('dakika değişince yeni özet üretir', () => {
    const base = Date.now() - 5000;
    const a = session({ id: 'a', updatedAt: base });
    const s1 = summarizeSession(a);
    const s2 = summarizeSession({ ...a, updatedAt: base + 60_000 });
    expect(s2).not.toBe(s1);
    expect(s2.updatedAt).toBe(s1.updatedAt + 60_000);
  });

  it('ad/model/mod değişimi özeti tazeler', () => {
    const a = session({ id: 'a', updatedAt: 1000 });
    const s1 = summarizeSession(a);
    const s2 = summarizeSession({ ...a, name: 'yeni' });
    expect(s2).not.toBe(s1);
    expect(s2.name).toBe('yeni');
  });

  it('arşiv bilgisi korunur ve liste sırası bozulmaz', () => {
    const list = [
      session({ id: 'a', updatedAt: 1000 }),
      session({ id: 'b', updatedAt: 2000, deletedAt: 3000 }),
    ];
    const out = selectSessionSummaries(list);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out[1].deletedAt).toBe(3000);
  });

  it('özet tam mesaj içeriğini taşımaz', () => {
    const out = summarizeSession(
      session({
        id: 'a',
        agentMode: 'build',
        messages: [{ id: 'm', content: 'x'.repeat(10_000) } as never],
      }),
    );
    expect(Object.keys(out).sort()).toEqual(
      ['agentMode', 'id', 'messageCount', 'model', 'name', 'updatedAt'].sort(),
    );
  });
});
