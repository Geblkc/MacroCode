import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferredSessionStorage } from './sessionPersist';

interface Persisted {
  sessions: Array<{ id: string }>;
  activeSessionId: string | null;
}

function installLocalStorageStub(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  return map;
}

describe('Faz 1 — gecikmeli oturum persist storage', () => {
  let raw: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    raw = installLocalStorageStub();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as Record<string, unknown>).localStorage;
  });

  it('hızlı ardışık setItem çağrılarında tek yazma yapar (debounce)', () => {
    const d = createDeferredSessionStorage<Persisted>(1500);
    for (let i = 0; i < 50; i++) {
      d.storage.setItem('s', {
        state: { sessions: [{ id: `s${i}` }], activeSessionId: `s${i}` },
      });
      vi.advanceTimersByTime(20);
    }
    expect(raw.has('s')).toBe(false);
    expect(d.hasPending()).toBe(true);

    // Son yazmadan 1500 ms sonra bir kez.
    vi.advanceTimersByTime(1479);
    expect(raw.has('s')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(raw.has('s')).toBe(true);
    expect(d.hasPending()).toBe(false);
    expect(JSON.parse(raw.get('s')!).state.activeSessionId).toBe('s49');
  });

  it('flush bekleyeni hemen yazar', () => {
    const d = createDeferredSessionStorage<Persisted>(1500);
    d.storage.setItem('s', { state: { sessions: [], activeSessionId: null } });
    d.flush();
    expect(raw.has('s')).toBe(true);
    vi.advanceTimersByTime(5000);
    // İkinci kez yazmaz.
    expect(raw.size).toBe(1);
  });

  it('getItem kaydı geri okur, bozuk kaydı temizler', () => {
    const d = createDeferredSessionStorage<Persisted>(1500);
    expect(d.storage.getItem('s')).toBeNull();

    d.storage.setItem('s', { state: { sessions: [{ id: 'a' }], activeSessionId: 'a' } });
    d.flush();
    const got = d.storage.getItem('s') as { state: Persisted } | null;
    expect(got?.state.activeSessionId).toBe('a');

    raw.set('s', '{bozuk');
    expect(d.storage.getItem('s')).toBeNull();
    expect(raw.has('s')).toBe(false);
  });

  it('removeItem bekleyen yazmayı iptal eder ve anahtarı siler', () => {
    const d = createDeferredSessionStorage<Persisted>(1500);
    d.storage.setItem('s', { state: { sessions: [], activeSessionId: null } });
    d.storage.removeItem('s');
    vi.advanceTimersByTime(5000);
    expect(raw.has('s')).toBe(false);
    expect(d.hasPending()).toBe(false);
  });

  it('localStorage kota hatası yutulur (uygulama çalışmaya devam eder)', () => {
    raw.clear();
    (globalThis as unknown as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    const d = createDeferredSessionStorage<Persisted>(10);
    d.storage.setItem('s', { state: { sessions: [], activeSessionId: null } });
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(d.hasPending()).toBe(false);
  });
});
