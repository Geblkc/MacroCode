import type { TranslationKey } from './i18n';
import type { AgentActivityPhase } from '../store/agentActivity';

/** Aşamanın durum çubuğu ve aktivite şeridinde kullanılan etiketi. */
export const AGENT_ACTIVITY_LABEL: Record<AgentActivityPhase, TranslationKey> = {
  preparing: 'agentActivity.preparing',
  thinking: 'agentActivity.thinking',
  writing: 'agentActivity.writing',
  tool: 'agentActivity.tool',
  awaiting_approval: 'agentActivity.awaitingApproval',
  retrying: 'agentActivity.retrying',
  finalizing: 'agentActivity.finalizing',
};

export function agentActivityLabelKey(phase: AgentActivityPhase): TranslationKey {
  return AGENT_ACTIVITY_LABEL[phase];
}

/** Araç adı → kısa, eylem odaklı insan dili etiket. */
export const AGENT_TOOL_LABEL: Record<string, TranslationKey> = {
  read_file: 'tool.name.readFile',
  write_file: 'tool.name.writeFile',
  edit_file: 'tool.name.editFile',
  propose_patch: 'tool.name.proposePatch',
  exec: 'tool.name.exec',
  grep: 'tool.name.grep',
  glob: 'tool.name.glob',
  list_dir: 'tool.name.listDir',
  todo: 'tool.name.todo',
  plan: 'tool.name.plan',
  subagent: 'tool.name.subagent',
  create_snapshot: 'tool.name.snapshot',
};

export function agentToolLabelKey(name: string): TranslationKey | null {
  return AGENT_TOOL_LABEL[name] ?? null;
}
