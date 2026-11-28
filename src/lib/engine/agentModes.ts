/**
 * Agent çalışma modları: build, plan, ask.
 * Her modun araç erişimi ve sisteme eklenen talimatları farklıdır.
 */
import type { AgentMode } from '../../types';
import type { ToolDefinition } from './types';

/** Salt-okunur araç isimleri (plan modunda açık, ask modunda da kullanılabilir). */
export const READ_ONLY_TOOL_NAMES = [
  'read_file',
  'list_dir',
  'grep',
  'glob',
  'todo',
  'plan',
] as const;

/** Değişiklik yapan (yazma ve çalıştırma) araçlar. */
export const WRITE_AND_EXEC_TOOL_NAMES = [
  'edit_file',
  'write_file',
  'create_snapshot',
  'propose_patch',
  'exec',
  'subagent',
] as const;

/**
 * Moda göre modele sunulacak araç listesini filtreler.
 * - build: tüm araçlar açık (CORE_TOOLS + extraTools).
 * - plan: yalnızca salt-okunur araştırma ve planlama araçları (read, list, grep, glob, todo, plan).
 * - ask: salt-okunur inceleme araçları (read, list, grep, glob) - yazma ve komut çalıştırma kesinlikle yok.
 */
export function filterToolsForMode(
  tools: ToolDefinition[],
  mode: AgentMode = 'build',
): ToolDefinition[] {
  if (mode === 'build') {
    return tools;
  }
  if (mode === 'plan') {
    return tools.filter((t) =>
      READ_ONLY_TOOL_NAMES.includes(t.name as (typeof READ_ONLY_TOOL_NAMES)[number]),
    );
  }
  if (mode === 'ask') {
    // Soru-cevap modunda model isterse kod inceleyebilsin ama plan/todo/yazma araçları olmasın
    const askAllowed = ['read_file', 'list_dir', 'grep', 'glob'];
    return tools.filter((t) => askAllowed.includes(t.name));
  }
  return tools;
}

/**
 * M2 — `mcp:` araçları dinamik olduğu için ada göre listelenemez; yasak
 * listesinde `mcp:*` önek deseniyle temsil edilir.
 */
export const MCP_TOOL_WILDCARD = 'mcp:*';

/**
 * M2 — bir araç adı yasak listesindeki bir desene uyuyor mu?
 *
 * Eski kontrol `disallowed.includes(name)` idi: `mcp:*` gibi bir önek
 * deseni hiçbir zaman eşleşmediğinden model `mcp:sunucu:araç` çağırdığında
 * yasak deliniyordu (plan/ask modunda onay kartına düşüp çalışabiliyordu).
 * Desteklenen sözdizimi: birebir ad veya `önek:*` (sondaki `*` joker).
 */
export function isToolDisallowed(name: string, disallowed: readonly string[]): boolean {
  const toolName = String(name);
  return disallowed.some((pattern) => {
    if (pattern === toolName) return true;
    if (pattern.endsWith(':*')) {
      return toolName.startsWith(pattern.slice(0, -1));
    }
    return false;
  });
}

/**
 * Moda göre yasaklı (disallow) araç isimlerini döndürür.
 *
 * M2: plan/ask modları salt-okunur kabul edilir — MCP araçları yan etki
 * yapabildiği için (DB yazma, dış servis çağrısı) bu modlarda kapalıdır.
 */
export function getDisallowedToolsForMode(mode: AgentMode = 'build'): string[] {
  if (mode === 'plan') {
    return [...WRITE_AND_EXEC_TOOL_NAMES, MCP_TOOL_WILDCARD];
  }
  if (mode === 'ask') {
    return [...WRITE_AND_EXEC_TOOL_NAMES, 'todo', 'plan', 'subagent', MCP_TOOL_WILDCARD];
  }
  return [];
}

/**
 * Restore edilen bir run'ın yürürlükteki modu.
 *
 * Sıra: run state'inde kayıtlı mod → oturumun o anki modu → build.
 * Eski kayıtlarda `agentMode` alanı yoktur; bu durumda oturumun modu
 * kullanılır (geriye uyumlu). Alan varsa o kazanır: yeniden başlatmadan
 * sonra kullanıcı mod değiştirmiş olsa bile bekleyen iş doğduğu modda
 * değerlendirilir (`modeDisallow` ayrıca canlı modla birleştirir).
 */
export function resolveRestoreMode(
  runStateMode: AgentMode | undefined,
  sessionMode: AgentMode | undefined,
): AgentMode {
  return runStateMode ?? sessionMode ?? 'build';
}

/**
 * Bekleyen onay varken mod değiştirilebilir mi? *
 * Onay kartı, doğduğu run'ın moduna aittir (`AgentRunState.agentMode`) ve
 * onay anında o moda göre yeniden doğrulanır. Kullanıcı ortada mod
 * değiştirirse hangi modun geçerli olduğu belirsizleşir → kural: bekleyen
 * onay yanıtlanana kadar mod sabit. UI (`ModeSelector`) ve `/mode` komutu
 * aynı kapıdan geçer.
 */
export function canChangeAgentMode(pendingCount: number): boolean {
  return !(pendingCount > 0);
}

/**
 * System prompt'tan mod bloklarını (`[AGENT MODE: ...]`) çıkarır.
 *
 * Alt-agent, koordinatörün promptunu devralır ama mod bölümünü devralmamalı:
 * Build modunda "dosya yazabilirsin" denirken alt-agent salt-okunurdur →
 * model görünmeyen araçları çağırıp `tool_disallowed` alıyordu (boşa adım ve
 * token). Bloklar deterministik üretildiği için birebir eşleşmeyle çıkarılır.
 */
export function stripModePrompt(systemPrompt: string | undefined): string {
  if (!systemPrompt) return '';
  let out = systemPrompt;
  for (const mode of ['build', 'plan', 'ask'] as AgentMode[]) {
    const block = getModePrompt(mode);
    while (out.includes(block)) out = out.replace(block, '');
  }
  return out.trim();
}

/**
 * Salt-okunur alt-agent için system prompt bloğu.
 *
 * Araç şeması da `plan` filtresinden geçer (`toolsMode`), yani prompt ile
 * gerçekten erişilebilir araçlar birbiriyle tutarlıdır.
 */
export function getSubagentPrompt(): string {
  return [
    '[SUBAGENT: READ-ONLY]',
    'You are a read-only research sub-agent. Another agent delegated this task to you.',
    '- You may read files, list directories, search, and inspect the workspace.',
    '- You cannot write, edit, or execute anything: those tools are not available.',
    '- Do not ask for approval or permission; just investigate.',
    '- Return ONE compact summary of your findings (facts, file paths, line numbers).',
    '- The summary is the only thing the caller sees; do not include filler.',
  ].join('\n');
}

/**
 * Moda göre system prompt'a eklenecek özel rehber/yönerge bloğu.
 */
export function getModePrompt(mode: AgentMode = 'build'): string {
  switch (mode) {
    case 'plan':
      return [
        '[AGENT MODE: PLAN]',
        'You are strictly in PLANNING and ARCHITECTURAL ANALYSIS mode.',
        '- Do NOT write, modify, or execute code or shell commands.',
        '- Your role is to inspect the codebase, identify requirements, evaluate potential risks, and design a concrete, step-by-step implementation plan.',
        '- Structure your plan clearly using numbered steps or the plan/todo tool.',
        '- When the plan is ready, ask the user if they would like to switch to BUILD mode to execute it.',
      ].join('\n');

    case 'ask':
      return [
        '[AGENT MODE: ASK]',
        'You are in CONSULTATION and QUESTION-ANSWERING mode.',
        '- You are here to answer questions, explain concepts, analyze architecture, and guide the user.',
        '- Do NOT modify any files or execute commands.',
        '- Keep tool use focused: read only the files needed to answer, then respond directly.',
        '- Do not keep exploring once you have enough context; deliver the final answer promptly.',
        '- Provide clear, concise, and educational explanations with helpful examples.',
      ].join('\n');

    case 'build':
    default:
      return [
        '[AGENT MODE: BUILD]',
        'You are in BUILD mode with full development capabilities.',
        "- You can read, write, edit files, and execute workspace commands (shell commands always need the user's approval) to implement solutions directly.",
        '- Always verify changes and maintain code quality.',
      ].join('\n');
  }
}
