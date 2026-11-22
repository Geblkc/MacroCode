import { describe, expect, it } from 'vitest';
import {
  discoverGemini,
  discoverOllama,
  discoverOpenAI,
  discoverOpenRouter,
  discoverProviderModels,
  fetchAnthropicModels,
  fetchGeminiModels,
  fetchOpenAICompatibleModels,
  isLikelyChatModelId,
} from './discovery';

const jsonFetch = (payload: unknown, ok = true, status = 200) =>
  (async () => ({
    ok,
    status,
    json: async () => payload,
  })) as unknown as typeof fetch;

describe('discovery', () => {
  it('openrouter kataloğu çözer', async () => {
    const f = jsonFetch({ data: [{ id: 'a/b', context_length: 100 }, { id: 'c' }, { no: 1 }] });
    const out = await discoverOpenRouter(f);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'a/b', source: 'openrouter', contextWindow: 100 });
    expect(out[1].contextWindow).toBeUndefined();
  });

  it('openrouter hatası fırlatır', async () => {
    await expect(discoverOpenRouter(jsonFetch({}, false, 500))).rejects.toThrow();
  });

  it('ollama isimleri döner', async () => {
    const f = jsonFetch({ models: [{ name: 'llama3.3:latest' }] });
    const out = await discoverOllama('http://h:11434/', f);
    expect(out).toEqual([
      {
        id: 'llama3.3:latest',
        source: 'ollama',
        contextWindow: undefined,
        fetchedAt: expect.any(Number),
      },
    ]);
  });

  it('openai data id kullanır', async () => {
    const f = jsonFetch({ data: [{ id: 'm1' }, {}] });
    const out = await discoverOpenAI('k', 'https://x/v1/', f);
    expect(out.map((m) => m.id)).toEqual(['m1']);
    expect(out[0].source).toBe('openai');
  });

  it('gemini models/ önekini kırpar', async () => {
    const f = jsonFetch({ models: [{ name: 'models/gemini-x' }, { name: 5 }] });
    const out = await discoverGemini('AIzaK', f);
    expect(out.map((m) => m.id)).toEqual(['gemini-x']);
    await expect(discoverGemini('  ', f)).rejects.toThrow();
  });
});

describe('canlı API model listeleri', () => {
  it('sohbet dışı id’leri eler', () => {
    expect(isLikelyChatModelId('gpt-5.6')).toBe(true);
    expect(isLikelyChatModelId('text-embedding-3-small')).toBe(false);
    expect(isLikelyChatModelId('gpt-image-1')).toBe(false);
    expect(isLikelyChatModelId('whisper-1')).toBe(false);
    expect(isLikelyChatModelId('gemini-2.5-flash-image')).toBe(false);
  });

  it('openai uyumlu listede metadata ve sohbet filtresi uygular', async () => {
    const f = jsonFetch({
      data: [
        { id: 'm1', name: 'Model One', context_length: 1000 },
        { id: 'text-embedding-3-small' },
        { id: 'gpt-image-1' },
        { id: 'm2', max_model_len: 2000, max_output_tokens: 500 },
      ],
    });
    const out = await fetchOpenAICompatibleModels('k', 'https://x/v1/', f);
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out[0]).toMatchObject({ id: 'm1', name: 'Model One', contextWindow: 1000 });
    expect(out[1]).toMatchObject({ id: 'm2', contextWindow: 2000, maxOutput: 500 });
  });

  it('anthropic başlıkları gönderir ve sayfaları birleştirir', async () => {
    const calls: { url: string; opts: RequestInit }[] = [];
    const f = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, opts: init ?? {} });
      const after = new URL(url).searchParams.get('after_id');
      const data = after
        ? [{ id: 'claude-b', display_name: 'Claude B' }]
        : [{ id: 'claude-a', display_name: 'Claude A' }, { id: 'claude-embedding' }];
      return {
        ok: true,
        status: 200,
        json: async () => ({ data, has_more: !after, last_id: 'claude-a' }),
      };
    }) as unknown as typeof fetch;

    const out = await fetchAnthropicModels('sk-ant-test', f);
    expect(out.map((m) => m.id)).toEqual(['claude-a', 'claude-b']);
    expect(calls).toHaveLength(2);
    const headers = calls[0].opts.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[1].url).toContain('after_id=claude-a');
  });

  it('gemini yalnız generateContent modellerini alır', async () => {
    const f = jsonFetch({
      models: [
        {
          name: 'models/gemini-x',
          displayName: 'Gemini X',
          inputTokenLimit: 1000,
          outputTokenLimit: 100,
          supportedGenerationMethods: ['generateContent'],
        },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-y' },
      ],
    });
    const out = await fetchGeminiModels('AIzaK', f);
    expect(out.map((m) => m.id)).toEqual(['gemini-x', 'gemini-y']);
    expect(out[0]).toMatchObject({
      name: 'Gemini X',
      contextWindow: 1000,
      maxOutput: 100,
    });
  });

  it('discoverProviderModels sağlayıcıya göre uç seçer', async () => {
    const f = jsonFetch({ data: [{ id: 'deepseek-x' }] });
    const out = await discoverProviderModels('deepseek', {
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com/v1',
      fetchImpl: f,
    });
    expect(out.map((m) => m.id)).toEqual(['deepseek-x']);
    await expect(discoverProviderModels('anthropic', {})).rejects.toThrow();
  });

  it('nvidia OpenAI uyumlu /models ucunu kullanır', async () => {
    const f = jsonFetch({ data: [{ id: 'nvidia/llama-3.3-nemotron-super-49b-v1' }] });
    const out = await discoverProviderModels('nvidia', {
      apiKey: 'nvapi-test',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      fetchImpl: f,
    });
    expect(out.map((m) => m.id)).toEqual(['nvidia/llama-3.3-nemotron-super-49b-v1']);
  });

  it('evren sade kimlikleri öneker, sohbet dışı ve yinelenen kayıtları eler', async () => {
    const f = jsonFetch({
      data: [
        {
          id: 'glm-5.3',
          task: 'chat',
          context_length: 524288,
          default_max_output_tokens: 16384,
        },
        { id: 'qwen3-vl-30b', task: 'vision_chat' },
        { id: 'bge-embedding', task: 'embedding' },
        { id: 'glm-5.3', task: 'chat' },
        { id: 'evren/auto', task: 'chat' },
      ],
    });
    const out = await discoverProviderModels('evren', { apiKey: 'evren_llm_test', fetchImpl: f });
    expect(out.map((m) => m.id)).toEqual(['evren/glm-5.3', 'evren/qwen3-vl-30b', 'evren/auto']);
    expect(out[0]).toMatchObject({ contextWindow: 524288, maxOutput: 16384 });
    await expect(discoverProviderModels('evren', {})).rejects.toThrow();
  });
});
