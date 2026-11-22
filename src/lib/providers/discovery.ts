import type { DiscoveredModel, LiveModelEntry, Provider } from '../../types';
import { EVREN_BASE_URL, EVREN_PORTAL_URL, isEvrenTermsError } from './evren';
import { DEFAULT_OLLAMA_URL, listOllamaModels } from './ollama';
import { fetchFor } from './rustFetch';
import { t } from '../i18n/core';

/** Keşif kaynağı → modelin bağlanacağı yerleşik sağlayıcı. */
export const SOURCE_PROVIDER: Record<Exclude<DiscoveredModel['source'], 'modelsDev'>, Provider> = {
  openrouter: 'openrouter',
  ollama: 'ollama',
  openai: 'openai',
  gemini: 'gemini',
};

/** Model listesi isteği için üst sınır — boot'u/UI'yı kilitlemesin. */
export const DISCOVERY_TIMEOUT_MS = 10_000;

const now = () => Date.now();

/**
 * Sohbet dışı model id'lerini eler (embedding, ses, görsel üretimi, moderasyon…).
 * API listeleri çoğu zaman chat dışı modelleri de döndürür; ajan/sohbet
 * listesine alınmamalıdır.
 */
const NON_CHAT_ID =
  /(?:^|[-_/])(embed(?:ding)?s?|tts|whisper|dall-e|moderation|rerank|sora|transcribe|realtime|image|audio|video|davinci|babbage)(?:[-_/]|$)/i;

export function isLikelyChatModelId(id: string): boolean {
  return !!id.trim() && !NON_CHAT_ID.test(id);
}

function timeoutSignal(): AbortSignal | undefined {
  const fn = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
  return typeof fn === 'function' ? fn(DISCOVERY_TIMEOUT_MS) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Liste yanıtı için ortak hata. */
function listError(source: string, status: number): Error {
  return new Error(t('errors.listFailed', { source, status }));
}

function asDiscovered(ids: LiveModelEntry[], source: DiscoveredModel['source']): DiscoveredModel[] {
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const e of ids) {
    if (!e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      source,
      contextWindow: e.contextWindow,
      name: e.name,
      maxOutput: e.maxOutput,
      fetchedAt: now(),
    });
  }
  return out;
}

/** OpenRouter model kataloğu (anahtarsız public uç). */
export async function fetchOpenRouterModels(fetchImpl?: typeof fetch): Promise<LiveModelEntry[]> {
  const url = 'https://openrouter.ai/api/v1/models';
  const res = await fetchFor(url, fetchImpl)(url, { signal: timeoutSignal() });
  if (!res.ok) throw listError('openrouter', res.status);
  const json = (await res.json()) as { data?: unknown[] };
  const rows = Array.isArray(json.data) ? json.data : [];
  const out: LiveModelEntry[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    if (!id || !isLikelyChatModelId(id)) continue;
    const top = (r.top_provider ?? {}) as Record<string, unknown>;
    const entry: LiveModelEntry = { id };
    const name = str(r.name);
    if (name) entry.name = name;
    const ctx = num(r.context_length) ?? num(top.context_length);
    if (ctx) entry.contextWindow = ctx;
    const maxOut = num(top.max_completion_tokens);
    if (maxOut) entry.maxOutput = maxOut;
    out.push(entry);
  }
  return out;
}

const DEFAULT_OPENAI_COMPATIBLE_BASE_URLS: Partial<Record<Provider, string>> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  minimax: 'https://api.minimax.chat/v1',
  moonshotai: 'https://api.moonshot.cn/v1',
  zhipuai: 'https://open.bigmodel.cn/api/paas/v4',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  evren: EVREN_BASE_URL,
};

/** Kurulu Ollama modelleri. */
export async function fetchOllamaModels(
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<LiveModelEntry[]> {
  const names = await listOllamaModels(baseUrl, fetchImpl);
  return names.map((id) => ({ id }));
}

/** OpenAI uyumlu `/models` listesi. */
export async function fetchOpenAICompatibleModels(
  apiKey: string,
  baseUrl: string,
  fetchImpl?: typeof fetch,
  source: string = 'openai',
): Promise<LiveModelEntry[]> {
  const defaultBase =
    DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[source as Provider] ?? 'https://api.openai.com/v1';
  const base = (baseUrl.trim() || defaultBase).replace(/\/+$/, '');
  const url = `${base}/models`;
  // Özel taban URL CSP dışında kalabilir → Rust proxy.
  const res = await fetchFor(url, fetchImpl)(url, {
    headers: { authorization: `Bearer ${apiKey.trim()}` },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw listError(source, res.status);
  const json = (await res.json()) as { data?: unknown[] };
  const rows = Array.isArray(json.data) ? json.data : [];
  const out: LiveModelEntry[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    if (!id || !isLikelyChatModelId(id)) continue;
    const entry: LiveModelEntry = { id };
    const name = str(r.name);
    if (name) entry.name = name;
    const ctx =
      num(r.context_length) ??
      num(r.context_window) ??
      num(r.max_context_length) ??
      num(r.max_model_len);
    if (ctx) entry.contextWindow = ctx;
    const maxOut = num(r.max_output_tokens) ?? num(r.output_token_limit);
    if (maxOut) entry.maxOutput = maxOut;
    out.push(entry);
  }
  return out;
}

const EVREN_ID_PREFIX = 'evren/';

/**
 * EVREN LLM `/v1/models` listesi.
 *
 * API kimlikleri sade (`glm-5.3`) ve diğer sağlayıcılarla çakışır; registry'de
 * `evren/` öneği kullanılır. Ayrıca EVREN `task` alanıyla sohbet dışı modelleri
 * (embedding/rerank/OCR/ses) ayırt eder ve çıktı sınırını farklı bir anahtarla
 * (`default_max_output_tokens`) verir.
 */
export async function fetchEvrenModels(
  apiKey: string,
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<LiveModelEntry[]> {
  const key = apiKey.trim();
  if (!key) throw new Error(t('settings.models.error.keyFirst', { provider: 'evren' }));
  const base = (baseUrl.trim() || EVREN_BASE_URL).replace(/\/+$/, '');
  const url = `${base}/models`;
  const res = await fetchFor(url, fetchImpl)(url, {
    headers: { authorization: `Bearer ${key}` },
    signal: timeoutSignal(),
  });
  if (!res.ok) {
    // Şart kabul edilmemişse genel "liste alınamadı" yerine ne yapılacağı söylenir.
    if (res.status === 403 && isEvrenTermsError(res.status, await res.text().catch(() => ''))) {
      throw new Error(t('errors.evrenTerms', { url: EVREN_PORTAL_URL }));
    }
    throw listError('evren', res.status);
  }
  const json = (await res.json()) as { data?: unknown[] };
  const rows = Array.isArray(json.data) ? json.data : [];
  const out: LiveModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const rawId = str(r.id);
    if (!rawId || !isLikelyChatModelId(rawId)) continue;
    const task = str(r.task) ?? 'chat';
    if (task !== 'chat' && task !== 'vision_chat') continue;
    const id = rawId.startsWith(EVREN_ID_PREFIX) ? rawId : `${EVREN_ID_PREFIX}${rawId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry: LiveModelEntry = { id };
    const name = str(r.name);
    if (name) entry.name = name;
    const ctx = num(r.context_length);
    if (ctx) entry.contextWindow = ctx;
    const maxOut = num(r.default_max_output_tokens) ?? num(r.max_output_tokens);
    if (maxOut) entry.maxOutput = maxOut;
    out.push(entry);
  }
  return out;
}

/** Anthropic `/v1/models` listesi (sayfalı). */
export async function fetchAnthropicModels(
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<LiveModelEntry[]> {
  const key = apiKey.trim();
  if (!key) throw new Error(t('settings.models.error.keyFirst', { provider: 'anthropic' }));
  const out: LiveModelEntry[] = [];
  let after: string | undefined;
  // Sonsuz döngüye karşı güvenlik sınırı (normalde 1-2 sayfa yeterli).
  for (let page = 0; page < 10; page++) {
    const url = new URL('https://api.anthropic.com/v1/models');
    url.searchParams.set('limit', '1000');
    if (after) url.searchParams.set('after_id', after);
    const res = await fetchFor(url.toString(), fetchImpl)(url.toString(), {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal: timeoutSignal(),
    });
    if (!res.ok) throw listError('anthropic', res.status);
    const json = (await res.json()) as { data?: unknown[]; has_more?: unknown; last_id?: unknown };
    const rows = Array.isArray(json.data) ? json.data : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const id = str(r.id);
      if (!id || !isLikelyChatModelId(id)) continue;
      const entry: LiveModelEntry = { id };
      const name = str(r.display_name) ?? str(r.name);
      if (name) entry.name = name;
      out.push(entry);
    }
    const next = str(json.last_id);
    if (json.has_more !== true || !next || next === after) break;
    after = next;
  }
  return out;
}

/** Gemini model listesi (`models/<id>` öneki kırpılır). */
export async function fetchGeminiModels(
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<LiveModelEntry[]> {
  const key = apiKey.trim();
  if (!key) throw new Error(t('settings.models.error.keyFirst', { provider: 'gemini' }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const res = await fetchFor(url, fetchImpl)(url, { signal: timeoutSignal() });
  if (!res.ok) throw listError('gemini', res.status);
  const json = (await res.json()) as { models?: unknown[] };
  const rows = Array.isArray(json.models) ? json.models : [];
  const out: LiveModelEntry[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = str(r.name);
    if (!name) continue;
    const methods = Array.isArray(r.supportedGenerationMethods)
      ? r.supportedGenerationMethods.filter((m): m is string => typeof m === 'string')
      : [];
    // `generateContent` yoksa sohbet modeli değildir (embedding/aqa…).
    if (methods.length > 0 && !methods.includes('generateContent')) continue;
    const id = name.replace(/^models\//, '');
    if (!isLikelyChatModelId(id)) continue;
    const entry: LiveModelEntry = { id };
    const display = str(r.displayName);
    if (display) entry.name = display;
    const ctx = num(r.inputTokenLimit);
    if (ctx) entry.contextWindow = ctx;
    const maxOut = num(r.outputTokenLimit);
    if (maxOut) entry.maxOutput = maxOut;
    out.push(entry);
  }
  return out;
}

/** OpenAI model listesi (kayıtlı anahtar + özel base URL ile). */
export async function discoverOpenAI(
  apiKey: string,
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<DiscoveredModel[]> {
  return asDiscovered(await fetchOpenAICompatibleModels(apiKey, baseUrl, fetchImpl), 'openai');
}

/** OpenRouter model kataloğu (keşif ekranı biçimi). */
export async function discoverOpenRouter(fetchImpl?: typeof fetch): Promise<DiscoveredModel[]> {
  return asDiscovered(await fetchOpenRouterModels(fetchImpl), 'openrouter');
}

/** Kurulu Ollama modelleri (keşif ekranı biçimi). */
export async function discoverOllama(
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<DiscoveredModel[]> {
  return asDiscovered(await fetchOllamaModels(baseUrl, fetchImpl), 'ollama');
}

/** Gemini model listesi (keşif ekranı biçimi). */
export async function discoverGemini(
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<DiscoveredModel[]> {
  return asDiscovered(await fetchGeminiModels(apiKey, fetchImpl), 'gemini');
}

export interface DiscoverProviderOptions {
  apiKey?: string;
  /** OpenAI-uyumlu sağlayıcı taban URL'si (override veya varsayılan). */
  baseUrl?: string;
  /** Ollama sunucu adresi. */
  ollamaUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Sağlayıcının kendi API'sinden model listesini çeker.
 *
 * Desteklenmeyen/eksik uçlarda hata fırlatır — çağıran taraf (store) o
 * sağlayıcı için mevcut kataloğa düşer.
 */
export async function discoverProviderModels(
  provider: Provider,
  opts: DiscoverProviderOptions = {},
): Promise<LiveModelEntry[]> {
  const key = (opts.apiKey ?? '').trim();
  switch (provider) {
    case 'anthropic':
      return fetchAnthropicModels(key, opts.fetchImpl);
    case 'gemini':
      return fetchGeminiModels(key, opts.fetchImpl);
    case 'openrouter':
      return fetchOpenRouterModels(opts.fetchImpl);
    case 'ollama':
      return fetchOllamaModels(
        opts.ollamaUrl || opts.baseUrl || DEFAULT_OLLAMA_URL,
        opts.fetchImpl,
      );
    case 'evren':
      return fetchEvrenModels(key, opts.baseUrl ?? EVREN_BASE_URL, opts.fetchImpl);
    default:
      if (!key) throw new Error(t('settings.models.error.keyFirst', { provider }));
      return fetchOpenAICompatibleModels(
        key,
        opts.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider] ?? '',
        opts.fetchImpl,
        provider,
      );
  }
}
