/**
 * Faz 5b — Salt-okunur alt-agent: aynı tool setinin okuma alt kümesiyle çalışır,
 * kendi context bütçesiyle özetlenir, koordinatöre tek özet döner.
 * Yazma araçları (exec/write_file/edit_file/propose_patch) yasaktır.
 */
import { compactHistory } from './compact';
import { compactionLimitFor } from './tokens';
import { getSubagentPrompt, stripModePrompt } from './agentModes';
import { createAgentRun, type AgentDeps, type AgentHistoryItem } from './agent';

export const SUBAGENT_BLOCKED_TOOLS = [
  'exec',
  'write_file',
  'edit_file',
  'propose_patch',
  // Yaşanan hata: yasak listesinde olmadığı için alt-agent `create_snapshot`
  // çağırabiliyordu. Snapshot manuel modda onay bekleyen bir araçtır; alt-agent
  // onay isteyemediği için `runSubagent` işi "atlandı" ile bitiriyordu
  // (boşa adım + token). Yazma sınıfındaki tüm araçlar burada olmalı.
  'create_snapshot',
  // Faz 8 L1: alt-agent alt-agent çağıramaz (özyineleme koruması).
  'subagent',
  // Planlama araçları: alt-agent'ın işi tek bir özet döndürmektir, kendi
  // görev listesini yönetmek değil. `ask` şema filtresi bunları zaten
  // sunmaz; yasak listesi ikinci savunma hattıdır (model şemada olmayan bir
  // aracı yine de çağırırsa koordinatörün todo durumu kirlenmesin).
  'plan',
  'todo',
  // M2: MCP araçları salt-okunur alt-agent'ta kapalı — dinamik adlar
  // `mcp:*` joker deseniyle engellenir (yan etki yapabilirler).
  'mcp:*',
];

/**
 * Alt-agent'ın araç şeması modu.
 *
 * `ask` = yalnızca `read_file`, `list_dir`, `grep`, `glob`. Prompt
 * (`getSubagentPrompt`) "yazamazsın/çalıştıramazsın" derken şemada da
 * yazma aracı yoktur → model görünmeyen aracı çağırıp `tool_disallowed`
 * ile adım harcamaz. `plan` seçilmedi: `plan`/`todo` alt-agent'a görev
 * listesi yönetme yetkisi verir, oysa alt-agent tek bir özet döndürür.
 */
export const SUBAGENT_TOOLS_MODE = 'ask' as const;

export interface SubagentResult {
  text: string;
  steps: number;
  compacted: boolean;
}

export interface SubagentDeps extends AgentDeps {
  summarize: (transcript: string) => Promise<string>;
}

/**
 * Alt-görev çalıştırır. Geçmiş bütçeyi aşarsa Faz 2 compaction ile küçültülür
 * (özetleyici enjeksiyonu). Yazma denemeleri hata sonucu alır, döngü sürer.
 */
export async function runSubagent(
  task: string,
  history: AgentHistoryItem[],
  deps: SubagentDeps,
): Promise<SubagentResult> {
  const budget = compactionLimitFor(deps.model, deps.customModels ?? []);
  let effHistory = history;
  let compacted = false;
  try {
    const out = await compactHistory({ history, budget, summarize: deps.summarize });
    if (out !== history) {
      effHistory = out;
      compacted = true;
    }
  } catch {
    effHistory = history;
  }
  // Faz 8 L1/L8: alt-agent `createAgentRun` üzerinden çalışır (tek döngü
  // uygulaması kaldı — eski `runAgent` kopyası silindi).
  const run = createAgentRun([...effHistory, { role: 'user', content: task }], {
    ...deps,
    // Koordinatörün mod prompt'u devralınmaz ("BUILD: dosya yazabilirsin").
    // Yerine salt-okunur alt-agent bloğu eklenir; araç şeması da `ask`
    // filtresinden geçer → prompt ile sunulan araçlar tutarlı.
    systemPrompt: [stripModePrompt(deps.systemPrompt), getSubagentPrompt()]
      .filter(Boolean)
      .join('\n'),
    toolsMode: SUBAGENT_TOOLS_MODE,
    // Ana akış sınırsız olsa da alt-ajan dar görevler için 4 adımda sınırlı
    // kalır; kullanıcı küçük bir sınır seçtiyse o daha da sıkılaştırır.
    maxSteps: deps.maxSteps && deps.maxSteps > 0 ? Math.min(deps.maxSteps, 4) : 4,
    disallowTools: [...(deps.disallowTools ?? []), ...SUBAGENT_BLOCKED_TOOLS],
    // Alt-ajanın **metni** ana akışa karışmasın (iki kez akmasın); araç
    // olayları (tool_call/tool_result) geçer — kullanıcı ilerlemeyi görsün.
    onEvent: (e) => {
      if (e.k === 'text') return;
      deps.onEvent(e);
    },
  });
  const result = await run.step();
  if (result.kind === 'needs-approval') {
    // Salt-okunur alt-agent onay isteyemez; yine de güvenli davranış.
    return { text: '(alt ajan onay bekleyen bir araç istedi — atlandı)', steps: 0, compacted };
  }
  return { text: result.text, steps: result.steps, compacted };
}
