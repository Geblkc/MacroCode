import { createOpenAICompatibleProvider } from './openaiCompatible';

/** EVREN API adresi — validate / discovery / registry bu sabiti kullanır. */
export const EVREN_BASE_URL = 'https://evren-llmapi.ssyz.org.tr/v1';
/** Kullanım şartlarının kabul edildiği portal. */
export const EVREN_PORTAL_URL = 'https://evren.ssyz.org.tr';

/**
 * EVREN, anahtarın kullanım şartları kabul edilene kadar `/v1/*` çağrılarını
 * `403 terms_not_accepted` ile reddeder. Bağlantı testi ve model keşfi bu durumu
 * "geçersiz anahtar" olarak göstermemek için gövdeyi denetler.
 */
export function isEvrenTermsError(status: number, body: string): boolean {
  return status === 403 && /terms_not_accepted/i.test(body);
}

/**
 * EVREN LLM (SAYZEK) — OpenAI uyumlu API.
 *
 * API model kimlikleri sade (`glm-5.3`, `deepseek-v4.1-flash`, …) ve mevcut
 * GLM/DeepSeek sağlayıcılarıyla çakışır. Registry'de `evren/` öneği kullanılır;
 * `mapModel` istek gövdesinde bu öneği sıyırır. Canlı keşif de aynı öneği ekler.
 */
export const evrenProvider = createOpenAICompatibleProvider({
  name: 'evren',
  baseUrl: EVREN_BASE_URL,
  mapModel: (model) => model.replace(/^evren\//, ''),
  models: [
    {
      id: 'evren/glm-5.3',
      name: 'GLM 5.3',
      provider: 'evren',
      contextWindow: 524288,
      supportsVision: false,
      maxOutput: 16384,
      capabilities: { tools: true, vision: false, reasoning: false },
    },
    {
      id: 'evren/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      provider: 'evren',
      contextWindow: 1048576,
      supportsVision: false,
      maxOutput: 16384,
      capabilities: { tools: true, vision: false, reasoning: false },
    },
    {
      id: 'evren/qwen3.8-flash-next',
      name: 'Qwen 3.8 Flash Next',
      provider: 'evren',
      contextWindow: 262144,
      supportsVision: false,
      maxOutput: 16384,
      capabilities: { tools: true, vision: false, reasoning: false },
    },
    {
      id: 'evren/gemma-4-31b',
      name: 'Gemma 4 31B',
      provider: 'evren',
      contextWindow: 262144,
      supportsVision: false,
      maxOutput: 16384,
      capabilities: { tools: true, vision: false, reasoning: false },
    },
    {
      id: 'evren/qwen3-vl-30b',
      name: 'Qwen3 VL 30B',
      provider: 'evren',
      contextWindow: 262144,
      supportsVision: true,
      maxOutput: 16384,
      capabilities: { tools: true, vision: true, reasoning: false },
    },
    {
      id: 'evren/auto',
      name: 'EVREN Auto',
      provider: 'evren',
      contextWindow: 32768,
      supportsVision: false,
      maxOutput: 16384,
      capabilities: { tools: true, vision: false, reasoning: false },
    },
  ],
});
