import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from './settings';
import { setActiveCatalog } from '../lib/providers/catalog';
import { setActiveLiveCatalog } from '../lib/providers/liveCatalog';
import { resolveModels } from '../lib/providers';
import { parseModelsDev } from '../lib/providers/modelsDev';
import type { ModelsDevCatalog } from '../types';

/** models.dev biçiminde küçük katalog (2 model). */
const RAW = {
  anthropic: {
    models: {
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        description: 'd',
        reasoning: true,
        tool_call: true,
        temperature: false,
        release_date: '2026-09-22',
        modalities: { input: ['text', 'image'], output: ['text'] },
        open_weights: false,
        limit: { context: 1000000, output: 128000 },
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
      },
    },
  },
  openai: {
    models: {
      'gpt-6.1-sol': {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        description: 'd',
        reasoning: true,
        tool_call: true,
        temperature: true,
        release_date: '2026-09-29',
        modalities: { input: ['text'], output: ['text'] },
        open_weights: false,
        limit: { context: 1050000, output: 128000 },
        cost: { input: 2, output: 10, cache_read: 0.1 },
      },
    },
  },
};

const catalog: ModelsDevCatalog = parseModelsDev(RAW);

afterEach(() => {
  useSettingsStore.setState({ prices: {}, modelsDevCatalog: null });
  setActiveCatalog(null);
});

describe('settings — models.dev kataloğu', () => {
  it('katalog yüklenince fiyatlar otomatik dolar', () => {
    useSettingsStore.getState().setModelsDevCatalog(catalog);
    const prices = useSettingsStore.getState().prices;
    expect(prices['claude-opus-5-5']).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
    });
    expect(prices['gpt-6.1-sol']).toEqual({ input: 2, output: 10, cacheRead: 0.1 });
  });

  it('elle girilen fiyat katalog tarafından ezilmez', () => {
    useSettingsStore.getState().setPrice('claude-opus-5-5', { input: 99, output: 99 });
    useSettingsStore.getState().setModelsDevCatalog(catalog);
    const prices = useSettingsStore.getState().prices;
    expect(prices['claude-opus-5-5']).toEqual({ input: 99, output: 99 });
    // Diğer modeller yine katalogdan dolar.
    expect(prices['gpt-6.1-sol']?.input).toBe(2);
  });

  it('katalog global olarak yayınlanır (registry zenginleşir)', () => {
    useSettingsStore.getState().setModelsDevCatalog(catalog);
    expect(useSettingsStore.getState().modelsDevCatalog).not.toBeNull();
    const m = resolveModels([]).find((x) => x.id === 'claude-opus-5-5');
    expect(m?.catalogPrice?.input).toBe(4);
    expect(m?.description).toBe('d');
  });

  it('katalog temizlenince global katalog da sıfırlanır', () => {
    useSettingsStore.getState().setModelsDevCatalog(catalog);
    useSettingsStore.getState().setModelsDevCatalog(null);
    expect(useSettingsStore.getState().modelsDevCatalog).toBeNull();
  });

  it('cache fiyatı elle girilebilir ve korunur', () => {
    useSettingsStore.getState().setPrice('gpt-6.1-sol', {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 1.5,
    });
    const p = useSettingsStore.getState().prices['gpt-6.1-sol'];
    expect(p?.cacheRead).toBe(0.5);
    expect(p?.cacheWrite).toBe(1.5);
  });
});

describe('settings — canlı API kataloğu', () => {
  const baseKeys = { ...useSettingsStore.getState().apiKeys };

  afterEach(() => {
    useSettingsStore.setState({
      apiKeys: baseKeys,
      liveCatalog: null,
      liveErrors: {},
      liveBusy: {},
    });
    setActiveLiveCatalog(null);
    vi.unstubAllGlobals();
  });

  it('API listesini çeker ve global kataloğa yayınlar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ id: 'live-1' }, { id: 'text-embedding-3-small' }] }),
            { status: 200 },
          ),
      ),
    );
    useSettingsStore.setState({
      apiKeys: { ...baseKeys, openai: 'sk-test' },
      liveCatalog: null,
      liveErrors: {},
    });

    await useSettingsStore.getState().refreshLiveCatalog('openai', true);

    const state = useSettingsStore.getState();
    expect(state.liveCatalog?.openai?.models.map((m) => m.id)).toEqual(['live-1']);
    expect(state.liveErrors.openai).toBeUndefined();
    expect(state.liveBusy.openai).toBe(false);
  });

  it('API hatasında önceki başarılı listeyi korur', async () => {
    const seeded = {
      openai: { fetchedAt: 123, models: [{ id: 'eski-model' }] },
    };
    useSettingsStore.setState({
      apiKeys: { ...baseKeys, openai: 'sk-test' },
      liveCatalog: seeded,
      liveErrors: {},
    });
    setActiveLiveCatalog(seeded);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hata', { status: 500 })),
    );

    await useSettingsStore.getState().refreshLiveCatalog('openai', true);

    const state = useSettingsStore.getState();
    expect(state.liveCatalog?.openai?.models.map((m) => m.id)).toEqual(['eski-model']);
    expect(state.liveErrors.openai).toBeTruthy();
  });

  it('boş API listesini hata sayar ve eski listeyi korur', async () => {
    const seeded = {
      openai: { fetchedAt: 123, models: [{ id: 'eski-model' }] },
    };
    useSettingsStore.setState({
      apiKeys: { ...baseKeys, openai: 'sk-test' },
      liveCatalog: seeded,
      liveErrors: {},
    });
    setActiveLiveCatalog(seeded);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );

    await useSettingsStore.getState().refreshLiveCatalog('openai', true);

    expect(useSettingsStore.getState().liveCatalog?.openai?.models[0].id).toBe('eski-model');
    expect(useSettingsStore.getState().liveErrors.openai).toBeTruthy();
  });

  it('anahtar silinince canlı liste temizlenir', async () => {
    const seeded = {
      openai: { fetchedAt: 123, models: [{ id: 'eski-model' }] },
    };
    useSettingsStore.setState({
      apiKeys: { ...baseKeys, openai: '' },
      liveCatalog: seeded,
      liveErrors: {},
    });
    setActiveLiveCatalog(seeded);

    await useSettingsStore.getState().refreshLiveCatalog('openai', true);

    expect(useSettingsStore.getState().liveCatalog?.openai).toBeUndefined();
  });

  it('clearLiveCatalog kaydı ve hatayı siler', () => {
    useSettingsStore.setState({
      liveCatalog: { openai: { fetchedAt: 1, models: [{ id: 'm1' }] } },
      liveErrors: { openai: 'hata' },
    });
    useSettingsStore.getState().clearLiveCatalog('openai');
    expect(useSettingsStore.getState().liveCatalog?.openai).toBeUndefined();
    expect(useSettingsStore.getState().liveErrors.openai).toBeUndefined();
  });
});
