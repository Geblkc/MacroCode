import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveCatalog, Model } from '../../types';
import {
  LIVE_CACHE_KEY,
  LIVE_TTL_MS,
  buildKnownModelMap,
  getActiveLiveCatalog,
  isLiveStale,
  liveEntryToModel,
  loadCachedLiveCatalog,
  prettyModelName,
  saveCachedLiveCatalog,
  setActiveLiveCatalog,
} from './liveCatalog';

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const knownModel = (): Model => ({
  id: 'gpt-x',
  name: 'Eski Ad',
  provider: 'openai',
  contextWindow: 1000,
  supportsVision: false,
  maxOutput: 100,
  capabilities: { tools: true, vision: false, reasoning: true },
  catalogPrice: { input: 1, output: 2 },
});

afterEach(() => {
  setActiveLiveCatalog(null);
  vi.unstubAllGlobals();
});

describe('liveEntryToModel', () => {
  it('bilinen modelin metadata’sını korur, API adını/limitlerini uygular', () => {
    const known = buildKnownModelMap([knownModel()]);
    const m = liveEntryToModel(
      { id: 'gpt-x', name: 'Yeni Ad', contextWindow: 2000, maxOutput: 50 },
      'openai',
      known,
    );
    expect(m.name).toBe('Yeni Ad');
    expect(m.contextWindow).toBe(2000);
    expect(m.maxOutput).toBe(100); // daha büyük registry değeri korunur
    expect(m.capabilities).toEqual({ tools: true, vision: false, reasoning: true });
    expect(m.catalogPrice).toEqual({ input: 1, output: 2 });
  });

  it('bilinmeyen modelde güvenli varsayılanlar kullanır', () => {
    const m = liveEntryToModel({ id: 'yeni-model' }, 'openai', new Map());
    expect(m).toMatchObject({
      id: 'yeni-model',
      name: 'Yeni Model',
      provider: 'openai',
      contextWindow: 128000,
      maxOutput: 8192,
      supportsVision: false,
      capabilities: { tools: false, vision: false, reasoning: false },
    });
  });

  it('nvidia canlı modellerinde tools varsayılan açık (ajan modu)', () => {
    const m = liveEntryToModel({ id: 'nvidia/minimaxai/minimax-m3.1-flash' }, 'nvidia', new Map());
    expect(m.capabilities.tools).toBe(true);
  });

  it('prettyModelName satıcı önekini ve ayraçları temizler', () => {
    expect(prettyModelName('openai/gpt-5.6-sol')).toBe('Gpt 5.6 Sol');
  });
});

describe('canlı katalog singleton + TTL', () => {
  it('aktif katalog okunur/yazılır', () => {
    const cat: LiveCatalog = {
      openai: { fetchedAt: 1, models: [{ id: 'm1' }] },
    };
    setActiveLiveCatalog(cat);
    expect(getActiveLiveCatalog()).toBe(cat);
    setActiveLiveCatalog(null);
    expect(getActiveLiveCatalog()).toEqual({});
  });

  it('boş/eski liste bayat sayılır', () => {
    const now = 10_000_000;
    expect(isLiveStale(null, now)).toBe(true);
    expect(isLiveStale({ fetchedAt: now, models: [] }, now)).toBe(true);
    expect(isLiveStale({ fetchedAt: now - LIVE_TTL_MS + 1, models: [{ id: 'm' }] }, now)).toBe(
      false,
    );
    expect(isLiveStale({ fetchedAt: now - LIVE_TTL_MS - 1, models: [{ id: 'm' }] }, now)).toBe(
      true,
    );
  });
});

describe('canlı katalog önbelleği', () => {
  it('başarılı listeleri yazar ve geri okur', () => {
    vi.stubGlobal('localStorage', memStorage());
    const cat: LiveCatalog = {
      openai: {
        fetchedAt: 123,
        models: [{ id: 'm1', name: 'M1', contextWindow: 1000 }],
      },
    };
    saveCachedLiveCatalog(cat);
    expect(loadCachedLiveCatalog()).toEqual(cat);
  });

  it('bozuk JSON ve boş listeler sessizce elenir', () => {
    const storage = memStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem(LIVE_CACHE_KEY, '{bozuk');
    expect(loadCachedLiveCatalog()).toBeNull();
    storage.setItem(
      LIVE_CACHE_KEY,
      JSON.stringify({ openai: { fetchedAt: 1, models: [] }, xai: { models: [] } }),
    );
    expect(loadCachedLiveCatalog()).toBeNull();
  });

  it('hatalı kayıtları (id’siz) atmaz, yalnız geçerli modelleri tutar', () => {
    const storage = memStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem(
      LIVE_CACHE_KEY,
      JSON.stringify({
        openai: {
          fetchedAt: 5,
          models: [{ id: 'm1' }, { name: 'id yok' }, { id: 'm2', contextWindow: -1 }],
        },
      }),
    );
    expect(loadCachedLiveCatalog()?.openai?.models).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });
});
