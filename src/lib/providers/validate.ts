import type { Provider } from '../../types';
import { EVREN_BASE_URL, isEvrenTermsError } from './evren';
import { DEFAULT_OLLAMA_URL } from './ollama';
import { fetchFor } from './rustFetch';

/** Bağlantı testi sonucu: bağlı / geçersiz / şartlar kabul edilmemiş / ağ hatası. */
export type ValidateResult = 'ok' | 'invalid' | 'terms' | 'network';

export interface ValidateOptions {
  fetchImpl?: typeof fetch;
  /** OpenAI-uyumlu sağlayıcılarda varsayılan yerine bu taban URL denenir. */
  baseUrl?: string;
  /** Ağ hatasının gerçek nedeni (Rust proxy / CORS) UI'da gösterilmek üzere. */
  onNetworkError?: (error: unknown) => void;
}

const OPENAI_COMPATIBLE_BASE: Partial<Record<Provider, string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  minimax: 'https://api.minimax.io/v1',
  moonshotai: 'https://api.moonshot.ai/v1',
  zhipuai: 'https://api.z.ai/api/paas/v4',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  evren: EVREN_BASE_URL,
};

/**
 * Sağlayıcı anahtarını 3 durumlu doğrular.
 * Uç bilgisi mevcut `validateKey` gerçeklemeleriyle aynıdır
 * (Ollama `/api/tags`, Gemini `/v1beta/models?key=`, OpenAI-uyumlular `{base}/models`,
 * Anthropic ücretli çağrıdan kaçınmak için biçim denetimi).
 */
export async function validateDetailed(
  provider: Provider,
  key: string,
  opts: ValidateOptions = {},
): Promise<ValidateResult> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const value = key.trim();
  const networkError = (e: unknown): ValidateResult => {
    opts.onNetworkError?.(e);
    return 'network';
  };

  if (provider === 'ollama') {
    const base = (value || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
    const url = `${base}/api/tags`;
    try {
      const res = await fetchFor(url, opts.fetchImpl)(url);
      return res.ok ? 'ok' : 'invalid';
    } catch (e) {
      return networkError(e);
    }
  }

  if (provider === 'anthropic') {
    return value.startsWith('sk-ant-') && value.length > 20 ? 'ok' : 'invalid';
  }

  if (provider === 'gemini') {
    if (!value) return 'invalid';
    try {
      const res = await f(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`,
      );
      return res.ok ? 'ok' : 'invalid';
    } catch (e) {
      return networkError(e);
    }
  }

  const base = (opts.baseUrl?.trim() || OPENAI_COMPATIBLE_BASE[provider] || '').replace(/\/+$/, '');
  if (!value || !base) return 'invalid';
  const url = `${base}/models`;
  try {
    // Özel taban URL (proxy/Azure/LM Studio) CSP dışında kalabilir → Rust proxy.
    const res = await fetchFor(url, opts.fetchImpl)(url, {
      headers: { authorization: `Bearer ${value}` },
    });
    if (res.ok) return 'ok';
    // EVREN yeni anahtarlarda şart kabulüne kadar 403 döner; bu "geçersiz
    // anahtar" değildir, kullanıcıya portalı göstermek gerekir.
    if (res.status === 403 && isEvrenTermsError(res.status, await res.text().catch(() => '')))
      return 'terms';
    return 'invalid';
  } catch (e) {
    return networkError(e);
  }
}
