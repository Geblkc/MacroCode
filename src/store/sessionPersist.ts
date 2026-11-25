/**
 * Faz 1 — oturum persist'i için gecikmeli (debounce) storage.
 *
 * Sorun: Zustand `persist`, `createJSONStorage` ile HER `set()` çağrısında
 * önce tüm state'i `JSON.stringify` eder, sonra `localStorage.setItem` yapar.
 * Streaming'de bu her token'da O(toplam transkript) maliyet demekti.
 *
 * Çözüm: `PersistStorage` arayüzünü doğrudan uygula. Zustand'ın verdiği
 * state nesnesi referans olarak tutulur (kopya/serialize YOK); gerçek
 * `JSON.stringify` + `localStorage` yazımı yalnızca yazma trafiği
 * `delayMs` boyunca kesildikten SONRA bir kez yapılır. Sürekli akan bir
 * yanıtta bu, akış boyunca sıfır yazma anlamına gelir.
 *
 * Güvenlik ağı: `pagehide` / `beforeunload` / sekme gizlenince bekleyen
 * yazma hemen flush edilir; uygulama kapanırken son durum kaybolmaz.
 */
import type { PersistStorage, StorageValue } from 'zustand/middleware';

/** Son yazmadan sonra bu kadar sessizlik olunca diske yazılır. */
export const SESSION_PERSIST_DELAY_MS = 1500;

export interface DeferredStorage<S> {
  storage: PersistStorage<S>;
  /** Bekleyen yazmayı hemen uygular (kapanış/elle flush). */
  flush: () => void;
  /** Yazılmayı bekleyen state var mı? */
  hasPending: () => boolean;
}

function readRaw(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Gizli mod / erişim engeli: kalıcılık devre dışı, uygulama çalışmaya devam eder.
    return null;
  }
}

export function createDeferredSessionStorage<S>(
  delayMs: number = SESSION_PERSIST_DELAY_MS,
): DeferredStorage<S> {
  let pendingName: string | null = null;
  let pendingValue: StorageValue<S> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const writeNow = () => {
    clearTimer();
    if (pendingName === null || pendingValue === null) return;
    const name = pendingName;
    const value = pendingValue;
    pendingName = null;
    pendingValue = null;
    const raw = readRaw();
    if (!raw) return;
    try {
      raw.setItem(name, JSON.stringify(value));
    } catch {
      // Kota/aşılan sınır: SQLite asıl depo olduğundan sessizce vazgeç.
    }
  };

  const schedule = () => {
    clearTimer();
    timer = setTimeout(writeNow, delayMs);
  };

  const storage: PersistStorage<S> = {
    getItem: (name) => {
      const raw = readRaw();
      if (!raw) return null;
      let text: string | null = null;
      try {
        text = raw.getItem(name);
      } catch {
        return null;
      }
      if (!text) return null;
      try {
        const parsed = JSON.parse(text) as StorageValue<S>;
        if (!parsed || typeof parsed !== 'object' || !('state' in parsed)) return null;
        return parsed;
      } catch {
        // Bozuk kayıt: temizle, store varsayılanla açılsın.
        try {
          raw.removeItem(name);
        } catch {
          // yoksay
        }
        return null;
      }
    },
    setItem: (name, value) => {
      // Referans tutulur; serialize ertelenir.
      pendingName = name;
      pendingValue = value;
      schedule();
    },
    removeItem: (name) => {
      pendingName = null;
      pendingValue = null;
      clearTimer();
      const raw = readRaw();
      if (!raw) return;
      try {
        raw.removeItem(name);
      } catch {
        // yoksay
      }
    },
  };

  // Kapanış/gizlenme anında bekleyeni kaydet.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', writeNow);
    window.addEventListener('beforeunload', writeNow);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') writeNow();
      });
    }
  }

  return {
    storage,
    flush: writeNow,
    hasPending: () => pendingValue !== null,
  };
}
