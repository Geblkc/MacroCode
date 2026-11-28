import { describe, it, expect } from 'vitest';
import { CORE_TOOLS } from './toolspec';
import {
  canChangeAgentMode,
  filterToolsForMode,
  getDisallowedToolsForMode,
  getModePrompt,
  getSubagentPrompt,
  isToolDisallowed,
  MCP_TOOL_WILDCARD,
  resolveRestoreMode,
  stripModePrompt,
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
});
