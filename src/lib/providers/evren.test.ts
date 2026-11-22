import { describe, expect, it } from 'vitest';
import { EVREN_BASE_URL, EVREN_PORTAL_URL, evrenProvider, isEvrenTermsError } from './evren';
import { PROVIDER_DEFS } from './index';
import { discoverProviderModels } from './discovery';
import { validateDetailed } from './validate';
import { needsProxy } from './rustFetch';

describe('EVREN API adresi — tek kaynak', () => {
  it('registry, doğrulama ve keşif aynı adresi kullanır', async () => {
    expect(PROVIDER_DEFS.evren.defaultBaseUrl).toBe(EVREN_BASE_URL);

    let seen = '';
    const f = (async (url: unknown) => {
      seen = String(url);
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;

    await evrenProvider.validateKey('evren_llm_test', f);
    expect(seen).toBe(`${EVREN_BASE_URL}/models`);

    seen = '';
    await discoverProviderModels('evren', { apiKey: 'evren_llm_test', fetchImpl: f });
    expect(seen).toBe(`${EVREN_BASE_URL}/models`);

    // CSP connect-src dışındaki host Rust proxy'sine yönlendirilir.
    expect(needsProxy(`${EVREN_BASE_URL}/models`)).toBe(true);
  });

  it('sabit katalogda yayından kaldırılan modeller yok', () => {
    const ids = evrenProvider.models.map((m) => m.id);
    expect(ids).toContain('evren/glm-5.3');
    expect(ids).toContain('evren/auto');
    expect(ids).not.toContain('evren/deepseek-v4-flash');
    expect(ids).not.toContain('evren/mimo-v2.6-pro');
  });
});

describe('EVREN 403 terms_not_accepted', () => {
  const termsFetch = (async () => ({
    ok: false,
    status: 403,
    text: async () =>
      JSON.stringify({ error: { code: 'terms_not_accepted', message: 'terms not accepted' } }),
  })) as unknown as typeof fetch;

  it('işaretleyici yalnız 403 gövdesinde aranır', () => {
    expect(isEvrenTermsError(403, '{"error":{"code":"terms_not_accepted"}}')).toBe(true);
    expect(isEvrenTermsError(401, 'terms_not_accepted')).toBe(false);
    expect(isEvrenTermsError(403, 'forbidden')).toBe(false);
  });

  it('bağlantı testi "geçersiz anahtar" yerine terms döner', async () => {
    expect(await validateDetailed('evren', 'evren_llm_test', { fetchImpl: termsFetch })).toBe(
      'terms',
    );
  });

  it('model keşfi portal bağlantılı hata fırlatır', async () => {
    await expect(
      discoverProviderModels('evren', { apiKey: 'evren_llm_test', fetchImpl: termsFetch }),
    ).rejects.toThrow(EVREN_PORTAL_URL);
  });
});
