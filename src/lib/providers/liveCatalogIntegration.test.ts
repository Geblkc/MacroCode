import { afterEach, describe, expect, it } from 'vitest';
import type { CustomModel, LiveCatalog } from '../../types';
import { parseModelsDev } from './modelsDev';
import { getModel, getModelsForProvider, resolveModels, setActiveCatalog } from './index';
import { setActiveLiveCatalog } from './liveCatalog';

const devCatalog = parseModelsDev({
  openai: {
    models: {
      'live-1': {
        id: 'live-1',
        name: 'Live 1',
        description: 'api model',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 500_000, output: 32_000 },
        cost: { input: 1, output: 3 },
      },
    },
  },
  anthropic: {
    models: {
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 1_000_000, output: 128_000 },
      },
    },
  },
});

const liveOpenAI: LiveCatalog = {
  openai: {
    fetchedAt: 1,
    models: [
      { id: 'live-1', name: 'Live 1', contextWindow: 400_000 },
      { id: 'live-2', name: 'Live 2' },
    ],
  },
};

afterEach(() => {
  setActiveLiveCatalog(null);
  setActiveCatalog(null);
});

describe('resolveModels — canlı API listesi', () => {
  it('API listesi olan sağlayıcıda yalnız o liste kullanılır', () => {
    setActiveCatalog(devCatalog);
    setActiveLiveCatalog(liveOpenAI);
    const models = resolveModels([]);
    const openai = models.filter((m) => m.provider === 'openai');
    expect(openai.map((m) => m.id)).toEqual(['live-1', 'live-2']);
    // Diğer sağlayıcılar mevcut kataloğa düşer (fallback).
    expect(models.some((m) => m.provider === 'anthropic' && m.id === 'claude-opus-5-5')).toBe(true);
  });

  it('API kaydı models.dev metadata’sıyla zenginleşir', () => {
    setActiveCatalog(devCatalog);
    setActiveLiveCatalog(liveOpenAI);
    const m = resolveModels([]).find((x) => x.id === 'live-1');
    expect(m).toMatchObject({
      name: 'Live 1',
      contextWindow: 500_000,
      catalogPrice: { input: 1, output: 3 },
      capabilities: { tools: true, vision: true, reasoning: true },
    });
  });

  it('canlı liste yoksa çekirdek + katalog aynen kalır', () => {
    setActiveCatalog(devCatalog);
    setActiveLiveCatalog(null);
    const models = resolveModels([]);
    expect(models.some((m) => m.provider === 'openai' && m.id === 'gpt-6.1-sol')).toBe(true);
    expect(models.some((m) => m.id === 'live-1')).toBe(true); // models.dev kaydı
  });

  it('özel model canlı liste kaydını ezer', () => {
    setActiveLiveCatalog(liveOpenAI);
    const custom: CustomModel = {
      id: 'live-1',
      provider: 'openai',
      name: 'Benim Modelim',
      capabilities: { tools: false, vision: false, reasoning: false },
    };
    const m = resolveModels([custom]).find((x) => x.id === 'live-1');
    expect(m?.name).toBe('Benim Modelim');
    expect(m?.capabilities.tools).toBe(false);
  });

  it('getModel, API listesinde olmayan bilinen modeli statik kayıttan çözer', () => {
    setActiveLiveCatalog(liveOpenAI);
    const m = getModel('gpt-6.1-sol');
    expect(m?.provider).toBe('openai');
    expect(m?.contextWindow).toBeGreaterThan(0);
  });

  it('getModelsForProvider canlı listeyi döndürür', () => {
    setActiveLiveCatalog(liveOpenAI);
    expect(getModelsForProvider('openai').map((m) => m.id)).toEqual(['live-1', 'live-2']);
  });
});
