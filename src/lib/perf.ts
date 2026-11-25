/**
 * Faz 0 — performans ölçüm altyapısı (baseline).
 *
 * Amaç: optimizasyon öncesi/sonrası aynı metrikleri ölçebilmek. Bu modül
 * **ölçüm dışında hiçbir şey yapmaz**; kapalıyken tüm giriş noktaları tek
 * `if (!active) return` ile döner.
 *
 * Toplanan metrikler:
 * - açılış: install / React mount / FCP / DOMContentLoaded
 * - store: toplam güncelleme + streaming sırasındaki güncelleme sayısı
 * - persist: localStorage yazma sayısı/boyutu/süresi (anahtar bazında)
 * - DB: `saveSessionsToDb` çağrı sayısı, süre, gönderilen bayt
 * - streaming: oturum sayısı/süresi + rAF frame dağılımı (p50/p95/max)
 * - long tasks: 50 ms üstü görev sayısı/süresi
 * - bellek: `performance.memory` varsa JS heap
 *
 * Etkinleştirme: dev derlemesinde otomatik; release'te `localStorage`
 * `macrocode-perf=1` veya `/perf on` (oturum + sonraki açılışlar).
 *
 * Kullanım: `installPerf()` main.tsx'te (React'ten önce),
 * `perfObserveSessionStore(subscribe)` store hazır olduğunda bir kez,
 * `perfMark('app:mounted')` App mount efektinde.
 */

const FLAG_KEY = 'macrocode-perf';

const active = { value: false };

/** `import.meta.env.DEV` vitest/tsc'de de tanımlıdır. */
function devBuild(): boolean {
  try {
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

function flagOn(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function perfEnabled(): boolean {
  return active.value;
}

/** `performance.now()` yoksa Date.now()'a düşer. */
export function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/* ─────────────────────────── sayaçlar ─────────────────────────── */

interface KeyStat {
  writes: number;
  bytes: number;
  ms: number;
}

const startedAt = Date.now();

const stats = {
  installMs: -1,
  mountMs: -1,
  storeUpdates: 0,
  storeUpdatesDuringStream: 0,
  storage: new Map<string, KeyStat>(),
  db: { saves: 0, bytes: 0, ms: 0, maxMs: 0, sessions: 0 },
  streams: { count: 0, totalMs: 0, lastMs: 0 },
  frames: [] as number[],
  longTasks: { count: 0, maxMs: 0, totalMs: 0 },
};

let wasStreaming = false;
let streamStartedAt = 0;
let updatesAtStreamStart = 0;
let frameRaf = 0;
let frameLast = 0;
let frameSampling = false;
const marks = new Map<string, number>();

/* ─────────────────────── localStorage ölçümü ───────────────────── */

let restoreStorage: (() => void) | null = null;

function installStorageCounter(): void {
  if (restoreStorage) return;
  if (typeof Storage === 'undefined' || typeof Storage.prototype.setItem !== 'function') return;
  const proto = Storage.prototype;
  const original = proto.setItem;
  proto.setItem = function patchedSetItem(this: Storage, key: string, value: string): void {
    if (!active.value) {
      original.call(this, key, value);
      return;
    }
    const t0 = perfNow();
    try {
      original.call(this, key, value);
    } finally {
      const ms = perfNow() - t0;
      const current = stats.storage.get(key) ?? { writes: 0, bytes: 0, ms: 0 };
      current.writes += 1;
      current.bytes += key.length + (typeof value === 'string' ? value.length : 0);
      current.ms += ms;
      stats.storage.set(key, current);
    }
  };
  restoreStorage = () => {
    proto.setItem = original;
    restoreStorage = null;
  };
}

/* ───────────────────────── long tasks ───────────────────────── */

let longTaskObserver: PerformanceObserver | null = null;

function installLongTaskObserver(): void {
  if (longTaskObserver) return;
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      if (!active.value) return;
      for (const entry of list.getEntries()) {
        // 'longtask' girişleri 50 ms üstüdür; threshold yine de korunur.
        if (entry.duration < 50) continue;
        stats.longTasks.count += 1;
        stats.longTasks.totalMs += entry.duration;
        if (entry.duration > stats.longTasks.maxMs) stats.longTasks.maxMs = entry.duration;
      }
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {
    // WebKitGTK 'longtask' desteklemiyorsa sessizce atlanır.
    longTaskObserver = null;
  }
}

/* ───────────────────────── frame örnekleme ───────────────────────── */

function startFrameSampling(): void {
  if (frameSampling) return;
  if (typeof requestAnimationFrame !== 'function') return;
  frameSampling = true;
  stats.frames = [];
  frameLast = 0;
  const tick = (ts: number) => {
    if (!frameSampling) return;
    if (frameLast > 0) {
      const delta = ts - frameLast;
      // Arka plan sekmesi/askıya alma: 1 sn üstü boşlukları sayma.
      if (delta > 0 && delta < 1000) {
        if (stats.frames.length < 20_000) stats.frames.push(delta);
      }
    }
    frameLast = ts;
    frameRaf = requestAnimationFrame(tick);
  };
  frameRaf = requestAnimationFrame(tick);
}

function stopFrameSampling(): void {
  if (!frameSampling) return;
  frameSampling = false;
  if (frameRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRaf);
  frameRaf = 0;
  frameLast = 0;
}

/* ───────────────────────── akış takibi ───────────────────────── */

function onStreamingChange(streaming: Record<string, boolean> | undefined): void {
  if (!active.value) return;
  const isStreaming = !!streaming && Object.keys(streaming).length > 0;
  if (isStreaming && !wasStreaming) {
    streamStartedAt = perfNow();
    updatesAtStreamStart = stats.storeUpdates;
    startFrameSampling();
  } else if (!isStreaming && wasStreaming) {
    const ms = perfNow() - streamStartedAt;
    stats.streams.count += 1;
    stats.streams.totalMs += ms;
    stats.streams.lastMs = ms;
    stats.storeUpdatesDuringStream += stats.storeUpdates - updatesAtStreamStart;
    stopFrameSampling();
  }
  wasStreaming = isStreaming;
}

/**
 * Session store aboneliğini bağlar. `main.tsx` içinde bir kez çağrılır
 * (döngüsel import olmaması için store bu modüle import edilmez).
 */
export function perfObserveSessionStore(
  subscribe: (listener: (streaming: Record<string, boolean>) => void) => () => void,
): void {
  subscribe((streaming) => {
    if (!active.value) return;
    stats.storeUpdates += 1;
    onStreamingChange(streaming);
  });
}

/* ───────────────────────── kayıt API'leri ───────────────────────── */

/** DB yazımı tamamlandığında çağrılır (db.ts). */
export function perfRecordDbSave(info: { ms: number; bytes: number; sessions: number }): void {
  if (!active.value) return;
  stats.db.saves += 1;
  stats.db.bytes += info.bytes;
  stats.db.ms += info.ms;
  stats.db.sessions += info.sessions;
  if (info.ms > stats.db.maxMs) stats.db.maxMs = info.ms;
}

/** Açılış işaretleri (performance.mark + dahili tablo). */
export function perfMark(name: string): void {
  if (!active.value && !devBuild()) return;
  const at = perfNow();
  if (!marks.has(name)) marks.set(name, at);
  try {
    performance.mark(`macrocode:${name}`);
  } catch {
    // performance.mark yoksa dahili tablo yeterli.
  }
}

/* ───────────────────────── kurulum ───────────────────────── */

/** Dev'de otomatik, release'te flag ile. Idempotent. */
export function installPerf(): void {
  if (active.value) return;
  if (!devBuild() && !flagOn()) return;
  active.value = true;
  stats.installMs = perfNow();
  installStorageCounter();
  installLongTaskObserver();
  exposeConsoleApi();
}

/** `/perf on` — bayrağı yazar ve ölçümü bu oturumda başlatır. */
export function perfEnable(): void {
  try {
    localStorage.setItem(FLAG_KEY, '1');
  } catch {
    // Kota/erişim hatası ölçümü engellemez (bu yazma sayaç dışıdır).
  }
  if (!active.value) {
    active.value = true;
    stats.installMs = perfNow();
    installStorageCounter();
    installLongTaskObserver();
  }
  exposeConsoleApi();
}

/** `/perf off` — bayrağı siler; sayaçlar durur, geçmiş veri raporda kalır. */
export function perfDisable(): void {
  try {
    localStorage.removeItem(FLAG_KEY);
  } catch {
    // yoksay
  }
  active.value = false;
  stopFrameSampling();
  wasStreaming = false;
}

export function perfReset(): void {
  stats.storeUpdates = 0;
  stats.storeUpdatesDuringStream = 0;
  stats.storage.clear();
  stats.db = { saves: 0, bytes: 0, ms: 0, maxMs: 0, sessions: 0 };
  stats.streams = { count: 0, totalMs: 0, lastMs: 0 };
  stats.frames = [];
  stats.longTasks = { count: 0, maxMs: 0, totalMs: 0 };
  updatesAtStreamStart = stats.storeUpdates;
  streamStartedAt = perfNow();
  stopFrameSampling();
  if (wasStreaming) startFrameSampling();
}

/* ───────────────────────── rapor ───────────────────────── */

export interface PerfSnapshot {
  enabled: boolean;
  dev: boolean;
  startedAt: number;
  installMs: number;
  storeUpdates: number;
  storeUpdatesDuringStream: number;
  storage: Array<{ key: string; writes: number; bytes: number; ms: number }>;
  db: { saves: number; bytes: number; ms: number; maxMs: number; sessions: number };
  streams: { count: number; totalMs: number; lastMs: number };
  frames: { samples: number; p50: number; p95: number; max: number; over50: number };
  longTasks: { count: number; maxMs: number; totalMs: number };
  memory: { usedBytes: number; totalBytes: number } | null;
  marks: Record<string, number>;
  fcpMs: number | null;
  domContentLoadedMs: number | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function readMemory(): PerfSnapshot['memory'] {
  const perf = performance as unknown as {
    memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number };
  };
  const mem = perf.memory;
  if (!mem || typeof mem.usedJSHeapSize !== 'number') return null;
  return {
    usedBytes: mem.usedJSHeapSize,
    totalBytes: mem.totalJSHeapSize ?? mem.usedJSHeapSize,
  };
}

export function perfSnapshot(): PerfSnapshot {
  const sorted = [...stats.frames].sort((a, b) => a - b);
  const fcp = performance.getEntriesByName?.('first-contentful-paint')?.[0] as
    PerformanceEntry | undefined;
  const nav = performance.getEntriesByType?.('navigation')?.[0] as
    PerformanceNavigationTiming | undefined;
  return {
    enabled: active.value,
    dev: devBuild(),
    startedAt,
    installMs: stats.installMs,
    storeUpdates: stats.storeUpdates,
    storeUpdatesDuringStream: stats.storeUpdatesDuringStream,
    storage: [...stats.storage.entries()].map(([key, v]) => ({ key, ...v })),
    db: { ...stats.db },
    streams: { ...stats.streams },
    frames: {
      samples: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      over50: sorted.filter((x) => x > 50).length,
    },
    longTasks: { ...stats.longTasks },
    memory: readMemory(),
    marks: Object.fromEntries(marks),
    fcpMs: fcp && fcp.startTime > 0 ? fcp.startTime : null,
    domContentLoadedMs:
      nav && nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd : null,
  };
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/** `/perf` çıktısı — satır bazlı, terminale doğrudan yazılır. */
export function perfReportLines(offLabel: string): string[] {
  if (!active.value) {
    return [`/// perf: ${offLabel} · /perf on`];
  }
  const s = perfSnapshot();
  const lines: string[] = [];
  lines.push(`/// perf baseline · ${s.dev ? 'dev' : 'release'} · ${new Date().toISOString()}`);

  const mount = s.marks['app:mounted'];
  const boot: string[] = [];
  if (s.installMs >= 0) boot.push(`install ${fmtMs(s.installMs)}`);
  if (mount !== undefined) boot.push(`mount ${fmtMs(mount)}`);
  if (s.fcpMs != null) boot.push(`fcp ${fmtMs(s.fcpMs)}`);
  if (s.domContentLoadedMs != null) boot.push(`dcl ${fmtMs(s.domContentLoadedMs)}`);
  if (boot.length > 0) lines.push(`  boot: ${boot.join(' · ')}`);

  const streamSec = s.streams.totalMs > 0 ? s.streams.totalMs / 1000 : 0;
  const perSec = streamSec > 0 ? (s.storeUpdatesDuringStream / streamSec).toFixed(1) : '—';
  lines.push(
    `  store: ${s.storeUpdates} updates · ${s.storeUpdatesDuringStream} during stream (${s.streams.count} streams, ${perSec}/s)`,
  );

  const sessionStorage = s.storage.find((x) => x.key === 'macrocode-sessions');
  if (sessionStorage) {
    const perWrite = sessionStorage.writes > 0 ? sessionStorage.bytes / sessionStorage.writes : 0;
    lines.push(
      `  persist: ${sessionStorage.writes} writes · ${fmtBytes(sessionStorage.bytes)} · ` +
        `avg ${fmtBytes(perWrite)} · ${fmtMs(sessionStorage.ms)} blocked`,
    );
  } else {
    lines.push('  persist: no writes yet');
  }
  for (const other of s.storage) {
    if (other.key === 'macrocode-sessions') continue;
    lines.push(`    ${other.key}: ${other.writes} writes · ${fmtBytes(other.bytes)}`);
  }

  const sessionsPerSave = s.db.saves > 0 ? (s.db.sessions / s.db.saves).toFixed(1) : '—';
  lines.push(
    `  db: ${s.db.saves} saves · ${fmtBytes(s.db.bytes)} · ${fmtMs(s.db.ms)} total · ` +
      `max ${fmtMs(s.db.maxMs)} · ${sessionsPerSave} sessions/save`,
  );

  if (s.frames.samples > 0) {
    lines.push(
      `  frames: ${s.frames.samples} samples · p50 ${fmtMs(s.frames.p50)} · ` +
        `p95 ${fmtMs(s.frames.p95)} · max ${fmtMs(s.frames.max)} · >50ms ${s.frames.over50}`,
    );
  } else {
    lines.push('  frames: no stream sampled yet');
  }

  lines.push(
    `  longtasks: ${s.longTasks.count} · total ${fmtMs(s.longTasks.totalMs)} · max ${fmtMs(s.longTasks.maxMs)}`,
  );
  if (s.memory) {
    lines.push(
      `  heap: ${fmtBytes(s.memory.usedBytes)} used / ${fmtBytes(s.memory.totalBytes)} total`,
    );
  }
  lines.push('  hint: 60s stream + agent tool run → /perf');
  return lines;
}

/* ───────────────────────── devtools köprüsü ───────────────────────── */

function exposeConsoleApi(): void {
  if (typeof window === 'undefined') return;
  const api = {
    snapshot: perfSnapshot,
    report: () => perfReportLines('off').join('\n'),
    reset: perfReset,
    enable: perfEnable,
    disable: perfDisable,
    mark: perfMark,
  };
  (window as unknown as Record<string, unknown>).__macrocodePerf = api;
}

/** Test temizliği: sayaçları sıfırlar ve kurulumu geri alır. */
export function __resetPerfForTests(): void {
  perfReset();
  active.value = false;
  marks.clear();
  if (longTaskObserver) {
    longTaskObserver.disconnect();
    longTaskObserver = null;
  }
  restoreStorage?.();
  stopFrameSampling();
  wasStreaming = false;
}
