import type { Model, Provider, ProviderDefinition } from '../../types';
import type { CustomModel } from '../../types';
import { anthropicProvider } from './anthropic';
import { geminiProvider } from './gemini';
import { ollamaProvider } from './ollama';
import { openaiProvider } from './openai';
import { openrouterProvider } from './openrouter';
import { deepseekProvider } from './deepseek';
import { xaiProvider } from './xai';
import { minimaxProvider } from './minimax';
import { moonshotaiProvider } from './moonshotai';
import { zhipuaiProvider } from './zhipuai';
import { nvidiaProvider } from './nvidia';
import { EVREN_BASE_URL, evrenProvider } from './evren';
import type { AIProvider } from './common';
import { enrichModels, getActiveCatalog, getActiveCatalogIndex, catalogModels } from './catalog';
import { buildKnownModelMap, getActiveLiveCatalog, liveEntryToModel } from './liveCatalog';

export * from './common';
export * from './catalog';
export * from './liveCatalog';
export * from './visibility';

export const PROVIDER_DEFS: Record<Provider, ProviderDefinition> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    auth: 'api-key',
    placeholder: 'sk-ant-…',
    defaultModel: 'claude-opus-5-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsKey: true,
    openAICompatible: false,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyUrlLabel: 'console.anthropic.com',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    auth: 'api-key',
    placeholder: 'sk-…',
    defaultModel: 'gpt-6.1-sol',
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    openAICompatible: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyUrlLabel: 'platform.openai.com',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    auth: 'api-key',
    placeholder: 'AIza…',
    defaultModel: 'gemini-3.8-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    needsKey: true,
    openAICompatible: false,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyUrlLabel: 'aistudio.google.com',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    auth: 'url',
    placeholder: 'http://localhost:11434',
    defaultModel: 'llama3.3',
    defaultBaseUrl: 'http://localhost:11434',
    needsKey: false,
    openAICompatible: false,
    keyUrl: 'https://ollama.com/download',
    keyUrlLabel: 'ollama.com',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    auth: 'api-key',
    placeholder: 'sk-or-…',
    defaultModel: 'openrouter/auto',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    openAICompatible: true,
    keyUrl: 'https://openrouter.ai/keys',
    keyUrlLabel: 'openrouter.ai',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    auth: 'api-key',
    placeholder: 'sk-…',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    openAICompatible: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyUrlLabel: 'platform.deepseek.com',
  },
  xai: {
    id: 'xai',
    label: 'xAI Grok',
    auth: 'api-key',
    placeholder: 'xai-…',
    defaultModel: 'grok-4.20',
    defaultBaseUrl: 'https://api.x.ai/v1',
    needsKey: true,
    openAICompatible: true,
    keyUrl: 'https://console.x.ai',
    keyUrlLabel: 'console.x.ai',
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    auth: 'api-key',
    placeholder: 'sk-…',
    defaultModel: 'MiniMax-M3.1-Flash',
    defaultBaseUrl: 'https://api.minimax.io/v1',
    needsKey: true,
    openAICompatible: true,
    keyUrl: 'https://platform.minimax.io/console/access',
    keyUrlLabel: 'platform.minimax.io',
  },
  moonshotai: {
    id: 'moonshotai',
    label: 'Kimi (Moonshot AI)',
    auth: 'api-key',
    placeholder: 'sk-…',
    defaultModel: 'kimi-k3.1-pro',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    needsKey: true,
    openAICompatible: true,
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    keyUrlLabel: 'platform.kimi.ai',
  },
  zhipuai: {
    id: 'zhipuai',
    label: 'GLM (Zhipu AI)',
    auth: 'api-key',
    placeholder: '…',
    defaultModel: 'glm-5.3',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    needsKey: true,
    openAICompatible: true,
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    keyUrlLabel: 'z.ai',
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA',
    auth: 'api-key',
    placeholder: 'nvapi-…',
    defaultModel: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    needsKey: true,
    openAICompatible: true,
    keyUrl: 'https://build.nvidia.com/',
    keyUrlLabel: 'build.nvidia.com',
  },
  evren: {
    id: 'evren',
    label: 'EVREN LLM',
    auth: 'api-key',
    placeholder: 'evren_llm_…',
    defaultModel: 'evren/glm-5.3',
    defaultBaseUrl: EVREN_BASE_URL,
    needsKey: true,
    openAICompatible: true,
    keyUrl: 'https://evren.ssyz.org.tr/api-keys',
    keyUrlLabel: 'evren.ssyz.org.tr',
  },
};

export const PROVIDER_IDS: Provider[] = Object.keys(PROVIDER_DEFS) as Provider[];

export const PROVIDERS: Record<Provider, AIProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
  openrouter: openrouterProvider,
  deepseek: deepseekProvider,
  xai: xaiProvider,
  minimax: minimaxProvider,
  moonshotai: moonshotaiProvider,
  zhipuai: zhipuaiProvider,
  nvidia: nvidiaProvider,
  evren: evrenProvider,
};

export function getProvider(name: Provider): AIProvider {
  const p = PROVIDERS[name as Provider];
  if (!p) {
    const ids = PROVIDER_IDS.join('/');
    const suggestion = suggestProvider(String(name));
    throw new Error(
      `bilinmeyen sağlayıcı: ${name} · ${ids} kullan${suggestion ? ` · bunu mu demek istedin: ${suggestion}?` : ''}`,
    );
  }
  return p;
}

/** Basit yakınlık önerisi (önek + harf örtüşmesi). */
export function suggestProvider(raw: string): Provider | null {
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  if ((PROVIDER_IDS as string[]).includes(q)) return q as Provider;
  const prefix = PROVIDER_IDS.find((id) => id.startsWith(q) || q.startsWith(id));
  if (prefix) return prefix;
  let best: Provider | null = null;
  let bestScore = 0;
  for (const id of PROVIDER_IDS) {
    const setQ = new Set(q);
    let hit = 0;
    for (const ch of id) if (setQ.has(ch)) hit++;
    const score = hit / Math.max(id.length, q.length);
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return bestScore >= 0.4 ? best : null;
}

export function getProviderDef(id: Provider): ProviderDefinition {
  return PROVIDER_DEFS[id];
}

export const ALL_MODELS: Model[] = PROVIDER_IDS.flatMap((id) => PROVIDERS[id].models);

/** Elle eklenen modeli registry `Model` biçimine çevirir. */
export function toRegistryModel(c: CustomModel): Model {
  const out: Model = {
    id: c.id,
    name: c.name || c.id,
    provider: c.provider,
    contextWindow: c.contextWindow ?? 128000,
    supportsVision: c.capabilities.vision,
    maxOutput: c.maxOutput ?? 8192,
    capabilities: { ...c.capabilities },
  };
  if (c.description) out.description = c.description;
  if (c.family) out.family = c.family;
  if (c.catalogPrice) out.catalogPrice = { ...c.catalogPrice };
  return out;
}

/**
 * Görünür model listesi: registry + elle eklenenler.
 * Id çakışırsa custom kazanır (kullanıcı geçersiz kılar).
 *
 * Kaynak sırası:
 *   1. **Sağlayıcı API'si** (`activeLiveCatalog`) — anahtarı olan sağlayıcı
 *      için başarılı bir listeyse o sağlayıcının modelleri API listesidir.
 *   2. **Mevcut katalog** — API listesi yoksa çekirdek + models.dev.
 *   3. Elle eklenen (custom) modeller her durumda en sonda kazanır.
 *
 * API kayıtları models.dev/çekirdek metadata'sıyla zenginleştirilir.
 */
export function resolveModels(customs: CustomModel[] = []): Model[] {
  const index = getActiveCatalogIndex();
  const core = enrichModels(ALL_MODELS, index);
  // Çekirdek + katalog genişletmesi (çakışmada çekirdek kazanır).
  // Katalog yoksa `core` referansı korunur (ALL_MODELS ile aynı dizi).
  const extra = catalogModels(getActiveCatalog());
  let base = core;
  if (extra.length > 0) {
    const seen = new Set(core.map((m) => m.id));
    base = [...core];
    for (const m of extra) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      base.push(m);
    }
  }

  // Canlı API listesi olan sağlayıcılarda o sağlayıcının modelleri değiştirilir.
  const live = getActiveLiveCatalog();
  const liveProviders = PROVIDER_IDS.filter((p) => (live[p]?.models.length ?? 0) > 0);
  if (liveProviders.length > 0) {
    const known = buildKnownModelMap(base);
    const byProvider = new Map<Provider, Model[]>();
    for (const m of base) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    for (const p of liveProviders) {
      byProvider.set(
        p,
        (live[p]?.models ?? []).map((e) => liveEntryToModel(e, p, known)),
      );
    }
    base = [];
    for (const p of PROVIDER_IDS) {
      const list = byProvider.get(p);
      if (list) base.push(...list);
    }
  }

  if (customs.length === 0) return base;
  const over = new Map(customs.map((c) => [c.id, toRegistryModel(c)]));
  const out = base.map((m) => over.get(m.id) ?? m);
  for (const [, m] of over) {
    if (!base.some((r) => r.id === m.id)) out.push(m);
  }
  return out;
}

/** Model açılır listelerde görünsün mü (kapalılar gizlenir, seçili rozet korunur). */
export function isModelEnabled(disabled: string[], id: string): boolean {
  return !disabled.includes(id);
}

export function isKnownModel(id: string, customs: CustomModel[] = []): boolean {
  return resolveModels(customs).some((m) => m.id === id);
}

export function getModel(id: string, customs: CustomModel[] = []): Model | undefined {
  const visible = resolveModels(customs).find((m) => m.id === id);
  if (visible) return visible;
  // Canlı API listesi bu modeli döndürmediyse (ya da liste yoksa) bilinen
  // statik kayıttan çöz — açık oturumun yetenek/limit bilgisi kaybolmasın.
  const index = getActiveCatalogIndex();
  return (
    enrichModels(ALL_MODELS, index).find((m) => m.id === id) ??
    catalogModels(getActiveCatalog()).find((m) => m.id === id)
  );
}

/** Model → sağlayıcı çözümleme (Titlebar / /model için). */
export function getProviderForModel(
  modelId: string,
  customs: CustomModel[] = [],
): Provider | undefined {
  return getModel(modelId, customs)?.provider;
}

export function getModelsForProvider(provider: Provider): Model[] {
  const index = getActiveCatalogIndex();
  const live = getActiveLiveCatalog()[provider];
  if (live && live.models.length > 0) {
    const known = buildKnownModelMap([
      ...enrichModels(ALL_MODELS, index),
      ...catalogModels(getActiveCatalog()),
    ]);
    return live.models.map((e) => liveEntryToModel(e, provider, known));
  }
  const models = PROVIDERS[provider]?.models ?? [];
  const core = enrichModels(models, index);
  const extra = catalogModels(getActiveCatalog()).filter((m) => m.provider === provider);
  const seen = new Set(core.map((m) => m.id));
  const merged = [...core];
  for (const m of extra) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }
  return merged;
}

/** Capability lookup — Agent kararları buradan beslenir. */
export function getCapabilitiesForModel(
  modelId: string,
  customs: CustomModel[] = [],
): Model['capabilities'] | undefined {
  return getModel(modelId, customs)?.capabilities;
}

export function supportsToolsForModel(modelId: string, customs: CustomModel[] = []): boolean {
  return getCapabilitiesForModel(modelId, customs)?.tools ?? false;
}

export function getMaxOutputForModel(
  modelId: string,
  customs: CustomModel[] = [],
): number | undefined {
  return getModel(modelId, customs)?.maxOutput;
}

/**
 * P0-3 — Kaldırılan eski model ID'leri güncel karşılıklarına taşır.
 * Bilinmeyen/özel ID'ler aynen korunur (kullanıcı özel modeli ezilmez).
 */
export const REMOVED_MODEL_MAP: Record<string, string> = {
  'gpt-4o': 'gpt-6.1-sol',
  'gpt-4o-mini': 'gpt-6-luna',
  o3: 'gpt-6.1-sol',
  'o4-mini': 'gpt-6-luna',
  'claude-sonnet-4-6': 'claude-sonnet-5-5',
  'claude-opus-5': 'claude-opus-5-5',
  'claude-haiku-4-5': 'claude-haiku-5-5',
  'gemini-2.5-pro': 'gemini-3-pro',
  'gemini-2.5-flash': 'gemini-3.8-flash',
  'anthropic/claude-sonnet-5-5': 'anthropic/claude-sonnet-5.5',
};

export function migrateModelId(modelId: string): string {
  return REMOVED_MODEL_MAP[modelId] ?? modelId;
}

/** Session provider/model çiftini registry'ye hizalar (eski ID + tutarsız provider). */
export function migrateProviderModel(
  provider: Provider,
  modelId: string,
): { provider: Provider; model: string } {
  if (!modelId) return { provider, model: modelId };
  const model = migrateModelId(modelId);
  const owner = getProviderForModel(model);
  if (owner && owner !== provider) return { provider: owner, model };
  return { provider, model };
}
