import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPerfForTests,
  perfDisable,
  perfEnable,
  perfEnabled,
  perfRecordDbSave,
  perfRecordTerminal,
  perfReportLines,
  perfReset,
  perfSnapshot,
} from './perf';

/** Node test ortamında localStorage yok — minimal taklit. */
function installLocalStorageStub(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  return map;
}

describe('Faz 0 — perf ölçüm altyapısı', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
    __resetPerfForTests();
  });

  afterEach(() => {
    __resetPerfForTests();
    delete (globalThis as unknown as Record<string, unknown>).localStorage;
  });

  it('varsayılan olarak kapalıdır ve kapalıyken sayaç tutmaz', () => {
    expect(perfEnabled()).toBe(false);
    perfRecordDbSave({ ms: 5, bytes: 100, sessions: 2 });
    perfRecordTerminal({ ms: 3, lines: 10, optimized: true });
    const snap = perfSnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.db.saves).toBe(0);
    expect(snap.terminal.renders).toBe(0);
  });

  it('perfEnable bayrağı yazar ve DB sayaçlarını toplar', () => {
    perfEnable();
    expect(store.get('macrocode-perf')).toBe('1');
    expect(perfEnabled()).toBe(true);

    perfRecordDbSave({ ms: 4, bytes: 120, sessions: 2 });
    perfRecordDbSave({ ms: 9, bytes: 80, sessions: 1 });

    const snap = perfSnapshot();
    expect(snap.db.saves).toBe(2);
    expect(snap.db.bytes).toBe(200);
    expect(snap.db.ms).toBe(13);
    expect(snap.db.maxMs).toBe(9);
    expect(snap.db.sessions).toBe(3);
  });

  it('terminal render süresini ve satır sayısını toplar', () => {
    perfEnable();
    perfRecordTerminal({ ms: 4, lines: 120, optimized: true });
    perfRecordTerminal({ ms: 9, lines: 240, optimized: true });
    perfRecordTerminal({ ms: 2, lines: 30, optimized: false });

    const snap = perfSnapshot();
    expect(snap.terminal.renders).toBe(3);
    expect(snap.terminal.lastMs).toBe(2);
    expect(snap.terminal.maxMs).toBe(9);
    expect(snap.terminal.lines).toBe(30);
    expect(snap.terminal.maxLines).toBe(240);
    expect(snap.terminal.optimized).toBe(false);
  });

  it('perfReset terminal sayaçlarını sıfırlar', () => {
    perfEnable();
    perfRecordTerminal({ ms: 7, lines: 500, optimized: true });
    perfReset();
    expect(perfSnapshot().terminal).toMatchObject({ renders: 0, maxLines: 0 });
  });

  it('perfDisable bayrağı siler ve ölçümü durdurur', () => {
    perfEnable();
    perfDisable();
    expect(store.has('macrocode-perf')).toBe(false);
    expect(perfEnabled()).toBe(false);
  });

  it('rapor kapalıyken tek yönlendirme satırı, açıkken baseline başlığı üretir', () => {
    expect(perfReportLines('kapalı')).toEqual(['/// perf: kapalı · /perf on']);
    perfEnable();
    perfRecordTerminal({ ms: 6, lines: 150, optimized: true });
    const lines = perfReportLines('kapalı');
    expect(lines[0]).toContain('perf baseline');
    expect(lines.some((l) => l.includes('store:'))).toBe(true);
    expect(lines.some((l) => l.includes('db:'))).toBe(true);
    expect(lines.some((l) => l.includes('terminal:') && l.includes('cv on'))).toBe(true);
  });
});
