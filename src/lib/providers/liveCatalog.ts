import type {
  LiveCatalog,
  LiveModelEntry,
  LiveProviderCatalog,
  Model,
  Provider,
} from '../../types';

/**
 * Canlı model kataloğu — sağlayıcı API'lerinden çekilen model kimlikleri.
 *
 * `modelsDev.ts` ile aynı desen: ağır liste zustand persist'ine yazılmaz,
 * ayrı bir localStorage anahtarında önbelleklenir. Çekirdek/models.dev
 * metadata'sı (`contextWindow`, fiyat, yetenekler) eşleşen kayıtlardan gelir;
 * API listesi hangi modellerin kullanılabilir olduğunun tek kaynağıdır.
 *
 * API alınamazsa store eski başarılı listeyi korur; hiç canlı liste yoksa
 * `resolveModels()` mevcut kataloğa (çekirdek + models.dev) düşer.
 */

export const LIVE_CACHE_KEY = 'macrocode-live-models';

/** Canlı listenin bayat sayılma süresi (24 saat). */
export const LIVE_TTL_MS = 24 * 60 * 60 * 1000;

/** Bilinmeyen modeller için güvenli varsayılanlar. */
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_OUTPUT = 8_192;

/**
 * Canlı listeden gelen ve çekirdek/models.dev'de eşleşmesi olmayan modellerde
 * araç çağırmayı varsayılan açan sağlayıcılar.
 *
 * NVIDIA NIM uçları OpenAI uyumlu `tools` şemasını destekler; katalogda
 * bulunmayan modellerde güvenli varsayılan (`tools: false`) ajan modunu
 * gereksiz yere kilitliyordu. Diğer sağlayıcılarda temkinli davranılır.
 */
const LIVE_TOOLS_BY_DEFAULT: ReadonlySet<Provider> = new Set<Provider>(['nvidia']);

let activeLiveCatalog: LiveCatalog = {};

/** Aktif canlı kataloğu değiştirir (boot/yenileme sonrası çağrılır). */
export function setActiveLiveCatalog(catalog: LiveCatalog | null): void {
  activeLiveCatalog = catalog ?? {};
}

/** Aktif canlı katalog (boş nesne = hiç canlı liste yok). */
export function getActiveLiveCatalog(): LiveCatalog {
  return activeLiveCatalog;
}

/** Sağlayıcının canlı listesi bayat mı? (Yoksa/boşsa yenilenmeli.) */
export function isLiveStale(
  entry: LiveProviderCatalog | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!entry || entry.models.length === 0) return true;
  return now - entry.fetchedAt > LIVE_TTL_MS;
}

/** Model id'sinden okunabilir ad üretir (`gpt-5.6-sol` → `Gpt 5.6 Sol`). */
export function prettyModelName(id: string): string {
  const cleaned = id
    .replace(/^[^/]+\//, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!cleaned) return id;
  return cleaned.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Eşleştirme anahtarları: önce sağlayıcı+id, sonra global id. */
export function knownModelKey(provider: Provider, id: string): string {
  return `${provider}:${id}`;
}

export function buildKnownModelMap(models: Model[]): Map<string, Model> {
  const map = new Map<string, Model>();
  for (const m of models) {
    map.set(knownModelKey(m.provider, m.id), m);
    if (!map.has(m.id)) map.set(m.id, m);
  }
  return map;
}

/**
 * Canlı API kaydını registry `Model` biçimine çevirir.
 *
 * Eşleşen çekirdek/katalog kaydı varsa metadata'sı (fiyat, yetenek, modalite)
 * korunur; API'nin verdiği ad/limitler daha büyükse onlar kullanılır.
 * Eşleşme yoksa güvenli varsayılanlar uygulanır (araç çağırma kapalı —
 * bilinmeyen modelde ajan davranışını zorlamamak için).
 */
export function liveEntryToModel(
  entry: LiveModelEntry,
  provider: Provider,
  known: Map<string, Model>,
): Model {
  const found = known.get(knownModelKey(provider, entry.id)) ?? known.get(entry.id);
  if (found) {
    const next: Model = { ...found, capabilities: { ...found.capabilities } };
    if (entry.name) next.name = entry.name;
    if (entry.contextWindow) {
      next.contextWindow = Math.max(next.contextWindow, entry.contextWindow);
    }
    if (entry.maxOutput) next.maxOutput = Math.max(next.maxOutput, entry.maxOutput);
    return next;
  }
  return {
    id: entry.id,
    name: entry.name || prettyModelName(entry.id),
    provider,
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT,
    supportsVision: false,
    maxOutput: entry.maxOutput ?? DEFAULT_MAX_OUTPUT,
    capabilities: { tools: LIVE_TOOLS_BY_DEFAULT.has(provider), vision: false, reasoning: false },
  };
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function entryFromUnknown(raw: unknown): LiveModelEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;
  const out: LiveModelEntry = { id };
  if (typeof r.name === 'string' && r.name.trim()) out.name = r.name.trim();
  if (typeof r.contextWindow === 'number' && r.contextWindow > 0) {
    out.contextWindow = r.contextWindow;
  }
  if (typeof r.maxOutput === 'number' && r.maxOutput > 0) out.maxOutput = r.maxOutput;
  return out;
}

/** Önbelleği okur (bozuk/eski kayıtlar sessizce elenir). */
export function loadCachedLiveCatalog(): LiveCatalog | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(LIVE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const out: LiveCatalog = {};
    let any = false;
    for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      if (typeof v.fetchedAt !== 'number' || !Array.isArray(v.models)) continue;
      const models = v.models.map(entryFromUnknown).filter((m): m is LiveModelEntry => m !== null);
      if (models.length === 0) continue;
      out[provider as Provider] = { fetchedAt: v.fetchedAt, models };
      any = true;
    }
    return any ? out : null;
  } catch {
    return null;
  }
}

/** Canlı kataloğu önbelleğe yazar (yalnız başarılı listeler). */
export function saveCachedLiveCatalog(catalog: LiveCatalog): void {
  const s = storage();
  if (!s) return;
  const clean: Record<string, { fetchedAt: number; models: LiveModelEntry[] }> = {};
  for (const [provider, entry] of Object.entries(catalog)) {
    if (!entry || entry.models.length === 0) continue;
    clean[provider] = { fetchedAt: entry.fetchedAt, models: entry.models };
  }
  try {
    s.setItem(LIVE_CACHE_KEY, JSON.stringify(clean));
  } catch {
    // Kota doldu / depolama kapalı — önbellek opsiyoneldir.
  }
}
