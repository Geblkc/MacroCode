import { describe, it, expect } from 'vitest';
import { CORE_TOOLS } from './toolspec';
import {
  AGENT_MODES,
  ASK_ALLOWED_TOOL_NAMES,
  canChangeAgentMode,
  filterToolsForMode,
  getDisallowedToolsForMode,
  getModePrompt,
  getSubagentPrompt,
  isToolDisallowed,
  isValidAgentMode,
  MCP_TOOL_WILDCARD,
  normalizeAgentMode,
  PLAN_ALLOWED_TOOL_NAMES,
  PLANNING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  resolveRestoreMode,
  stripModePrompt,
  WRITE_AND_EXEC_TOOL_NAMES,
} from './agentModes';

describe('agentModes', () => {
  it('build modu tüm araçlara izin verir', () => {
    const filtered = filterToolsForMode(CORE_TOOLS, 'build');
    expect(filtered).toHaveLength(CORE_TOOLS.length);
    expect(getDisallowedToolsForMode('build')).toEqual([]);
    expect(getModePrompt('build')).toContain('[AGENT MODE: BUILD]');
  });

  it('plan modu yalnızca salt-okunur ve planlama araçlarına izin verir', () => {
    const filtered = filterToolsForMode(CORE_TOOLS, 'plan');
    const names = filtered.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('list_dir');
    expect(names).toContain('grep');
    expect(names).toContain('glob');
    expect(names).toContain('plan');
    expect(names).toContain('todo');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('exec');
    expect(getDisallowedToolsForMode('plan')).toContain('write_file');
    expect(getDisallowedToolsForMode('plan')).toContain('exec');
    expect(getModePrompt('plan')).toContain('[AGENT MODE: PLAN]');
  });

  it('ask modu yalnızca inceleme araçlarına izin verir, plan/todo/yazma kapalıdır', () => {
    const filtered = filterToolsForMode(CORE_TOOLS, 'ask');
    const names = filtered.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('grep');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('exec');
    expect(names).not.toContain('plan');
    expect(names).not.toContain('todo');
    expect(getDisallowedToolsForMode('ask')).toContain('exec');
    expect(getModePrompt('ask')).toContain('[AGENT MODE: ASK]');
  });

  it('M2: isToolDisallowed birebir ve `önek:*` joker eşleşmesi yapar', () => {
    expect(isToolDisallowed('exec', ['exec', 'write_file'])).toBe(true);
    expect(isToolDisallowed('exec2', ['exec'])).toBe(false);
    // `mcp:*` → tüm mcp:<sunucu>:<araç> adları.
    expect(isToolDisallowed('mcp:filesystem:read_file', [MCP_TOOL_WILDCARD])).toBe(true);
    expect(isToolDisallowed('mcp:', [MCP_TOOL_WILDCARD])).toBe(true);
    // Önek sınırı: `mcp:` ile başlamayan ad eşleşmez.
    expect(isToolDisallowed('mcpx:filesystem:read', [MCP_TOOL_WILDCARD])).toBe(false);
    expect(isToolDisallowed('read_file', [MCP_TOOL_WILDCARD])).toBe(false);
    expect(isToolDisallowed('anything', [])).toBe(false);
  });

  it('M2: plan/ask modları MCP araçlarını yasaklar, build yasaklamaz', () => {
    expect(getDisallowedToolsForMode('plan')).toContain(MCP_TOOL_WILDCARD);
    expect(getDisallowedToolsForMode('ask')).toContain(MCP_TOOL_WILDCARD);
    expect(getDisallowedToolsForMode('build')).not.toContain(MCP_TOOL_WILDCARD);
  });

  it('bekleyen onay varken mod değişimi kapalıdır', () => {
    expect(canChangeAgentMode(0)).toBe(true);
    expect(canChangeAgentMode(1)).toBe(false);
    expect(canChangeAgentMode(3)).toBe(false);
  });

  it('resolveRestoreMode: run state modu > oturum modu > build', () => {
    // Eski kayıt (mod yok) → oturumun modu.
    expect(resolveRestoreMode(undefined, 'plan')).toBe('plan');
    // Hiçbiri yok → build.
    expect(resolveRestoreMode(undefined, undefined)).toBe('build');
    // Run state modu her zaman kazanır.
    expect(resolveRestoreMode('build', 'plan')).toBe('build');
    expect(resolveRestoreMode('ask', 'build')).toBe('ask');
  });

  it('stripModePrompt koordinatörün mod bloğunu çıkarır, özel talimatı korur', () => {
    const prompt = ['özel talimat', getModePrompt('build'), '[skill:x] kural'].join('\n');
    const stripped = stripModePrompt(prompt);
    expect(stripped).toContain('özel talimat');
    expect(stripped).toContain('[skill:x] kural');
    expect(stripped).not.toContain('[AGENT MODE: BUILD]');
    expect(stripped).not.toContain('You are in BUILD mode');
    // Plan/ask blokları da çıkar.
    expect(stripModePrompt(getModePrompt('plan'))).toBe('');
    expect(stripModePrompt(undefined)).toBe('');
  });

  it('getSubagentPrompt salt-okunur olduğunu söyler ve mod bloğu içermez', () => {
    const p = getSubagentPrompt();
    expect(p).toContain('[SUBAGENT: READ-ONLY]');
    expect(p).toContain('You cannot write, edit, or execute');
    expect(p).not.toContain('[AGENT MODE:');
  });

  // ── Bölüm 6: izin/yasak listelerinde tek kaynak ve tekrar yok ─────────────

  it('ask izinli listesi salt-okunur listeden türetilir', () => {
    expect([...ASK_ALLOWED_TOOL_NAMES]).toEqual([...READ_ONLY_TOOL_NAMES]);
    // Planlama araçları ask modunda sunulmaz.
    for (const name of PLANNING_TOOL_NAMES) {
      expect(ASK_ALLOWED_TOOL_NAMES).not.toContain(name);
    }
  });

  it('plan izinli listesi salt-okunur + planlama araçlarıdır', () => {
    expect([...PLAN_ALLOWED_TOOL_NAMES]).toEqual([...READ_ONLY_TOOL_NAMES, ...PLANNING_TOOL_NAMES]);
    // Yeni bir salt-okunur araç eklendiğinde iki mod da otomatik kapsar.
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(ASK_ALLOWED_TOOL_NAMES).toContain(name);
      expect(PLAN_ALLOWED_TOOL_NAMES).toContain(name);
    }
  });

  it('yasak listelerinde tekrar yok (subagent vb.)', () => {
    for (const mode of ['plan', 'ask'] as const) {
      const list = getDisallowedToolsForMode(mode);
      expect(new Set(list).size).toBe(list.length);
      // Eskiden ask dalında elle tekrarlanan `subagent` artık tek kez.
      expect(list.filter((n) => n === 'subagent')).toHaveLength(1);
      expect(list.filter((n) => n === MCP_TOOL_WILDCARD)).toHaveLength(1);
    }
  });

  it('izinli ve yasak listeleri çakışmaz; birlikte tüm araçları kapsar', () => {
    const coreNames = CORE_TOOLS.map((t) => t.name);
    for (const [mode, allowed] of [
      ['plan', PLAN_ALLOWED_TOOL_NAMES],
      ['ask', ASK_ALLOWED_TOOL_NAMES],
    ] as const) {
      const disallowed = getDisallowedToolsForMode(mode);
      // İzinli bir araç yasak listede olamaz (engine onay anında reddederdi).
      for (const name of allowed) {
        expect(isToolDisallowed(name, disallowed)).toBe(false);
      }
      // Çekirdek araçların her biri ya izinli ya yasak olmalı (boşluk yok).
      for (const name of coreNames) {
        const inAllowed = (allowed as readonly string[]).includes(name);
        const inDisallowed = isToolDisallowed(name, disallowed);
        expect(inAllowed || inDisallowed).toBe(true);
        expect(inAllowed && inDisallowed).toBe(false);
      }
    }
  });

  it('WRITE_AND_EXEC_TOOL_NAMES çekirdek araçlarda gerçekten var', () => {
    const coreNames = new Set<string>(CORE_TOOLS.map((t) => t.name));
    for (const name of WRITE_AND_EXEC_TOOL_NAMES) {
      expect(coreNames.has(name)).toBe(true);
    }
  });

  // ── Bölüm 9: mod doğrulama / normalizasyon ──────────────────────────────────

  it('isValidAgentMode yalnız tam eşleşmeyi kabul eder', () => {
    expect(isValidAgentMode('build')).toBe(true);
    expect(isValidAgentMode('plan')).toBe(true);
    expect(isValidAgentMode('ask')).toBe(true);
    expect(isValidAgentMode('PLAN')).toBe(false);
    expect(isValidAgentMode(' plan')).toBe(false);
    expect(isValidAgentMode('')).toBe(false);
    expect(isValidAgentMode(undefined)).toBe(false);
    expect(isValidAgentMode(42)).toBe(false);
  });

  it('normalizeAgentMode bozuk biçimi kurtarır, bilinmeyeni fallback yapar', () => {
    expect(normalizeAgentMode('PLAN')).toBe('plan');
    expect(normalizeAgentMode(' build ')).toBe('build');
    expect(normalizeAgentMode('Ask')).toBe('ask');
    // Bilinmeyen değer fallback'e düşer (güvenli taraf çağıranın seçimi).
    expect(normalizeAgentMode('turbo')).toBe('build');
    expect(normalizeAgentMode('turbo', 'plan')).toBe('plan');
    expect(normalizeAgentMode(null, 'plan')).toBe('plan');
    expect(normalizeAgentMode({}, 'plan')).toBe('plan');
    // Alan yok → undefined (kaydı kirletmeyiz).
    expect(normalizeAgentMode(undefined)).toBeUndefined();
  });

  it('AGENT_MODES üç modu içerir ve normalizasyonla tutarlı', () => {
    expect([...AGENT_MODES]).toEqual(['build', 'plan', 'ask']);
    for (const mode of AGENT_MODES) {
      expect(normalizeAgentMode(mode.toUpperCase())).toBe(mode);
    }
  });
});
