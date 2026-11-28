import { useCallback, useRef } from 'react';
import {
  buildAgentHistory,
  createAgentRun,
  type AgentRun,
  type AgentHistoryItem,
  type AgentRunState,
} from '../lib/engine/agent';
import { listApprovals, queueApproval, takeApproval } from '../lib/engine/approvals';
import { appendAudit, appendUsageEvent } from '../lib/db';
import { costForTokens } from '../lib/pricing';
import { parseCustomAllowList } from '../lib/engine/policy';
import { supportsTools } from '../lib/engine/providers';
import { createId, useSessionStore } from '../store/session';
import { useAgentActivityStore, type AgentActivityPatch } from '../store/agentActivity';
import { useSettingsStore } from '../store/settings';
import { useWorkspaceStore } from '../store/workspace';
import { apiKeyFor, providerNeedsKey } from './useStream';
import { formatProviderError, type RetryInfo } from '../lib/providers/common';
import { PROVIDER_IDS, resolveModels } from '../lib/providers';
import { compactionLimitFor } from '../lib/engine/tokens';
import { compactHistory, shouldCompact } from '../lib/engine/compact';
import { applyMemo, memoToPersisted, resolveMemo, setMemo } from '../lib/engine/compactionMemo';
import { buildRepoContext } from '../lib/engine/repoContext';
import { logError, logInfo, redact } from '../lib/logger';
import { promptCacheKey } from '../lib/providers/promptCache';
import { deriveTodoState } from '../lib/engine/tools/todo';
import { listSkills, skillsPrompt } from '../lib/engine/skills';
import { configureMcp, mcpToolsForAgent } from '../lib/engine/mcp/pool';
import { makeSummarizeFn, summarizerConfig } from '../lib/summarize';
import { useT } from '../lib/i18n';
import { t } from '../lib/i18n/core';
import type { Provider, ToolEvent } from '../types';
import { isBlankAssistantMessage } from '../lib/message';
import { getModePrompt, resolveRestoreMode } from '../lib/engine/agentModes';
import { previewArgs, toolTarget } from '../lib/engine/toolPreview';
import type { AgentEvent, ToolCall, ToolDefinition } from '../lib/engine/types';
import { createDeltaBatcher } from '../lib/deltaBatch';

export interface AgentToolLine {
  type: 'sys' | 'err' | 'warn';
  content: string;
  /** Varsa satır yapılandırılmış bir araç çağrısıdır (kart render edilir). */
  tool?: ToolEvent;
}

/**
 * Faz 3: canlı araç çıktısı (`tool_stream`) için birleştirme penceresi.
 * Her stdout parçası App'te ayrı bir extras güncellemesi + timeline hesabı
 * tetikliyordu; 100 ms'lik pencere bunu saniyede ~10 yazmaya indirir.
 */
export const TOOL_LINE_FLUSH_MS = 100;

/** Faz 1 G2/G5: oturum başına aktif run (onayda durur, resolve ile devam eder). */
interface ActiveAgentRun {
  run: AgentRun;
  /** Aktivite olaylarının bu run'a bağlı kaldığı sabit kimlik. */
  activityRunId: string;
}

const activeRuns = new Map<string, ActiveAgentRun>();

/**
 * Faz 1: oturum başına aktif delta tamponunun flush kancası. `resolvePending`
 * gibi handler referansına sahip olmayan yollar, tur sonu temizliğinden önce
 * bekleyen metni yazabilsin diye tutulur.
 */
const runHandlerFlush = new Map<string, { handler: RunEventHandler; flush: () => void }>();

function registerRunHandler(sessionId: string, handler: RunEventHandler): void {
  runHandlerFlush.set(sessionId, { handler, flush: handler.flush });
}

function flushRunDeltas(sessionId: string): void {
  runHandlerFlush.get(sessionId)?.flush();
}

function releaseRunHandler(sessionId: string, handler: RunEventHandler): void {
  if (runHandlerFlush.get(sessionId)?.handler === handler) runHandlerFlush.delete(sessionId);
}

export function getActiveAgentRun(sessionId: string): AgentRun | undefined {
  return activeRuns.get(sessionId)?.run;
}

/** Eski turun geç temizliği daha yeni bir run kaydını silmez. */
function clearActiveRun(sessionId: string, activityRunId: string): void {
  if (activeRuns.get(sessionId)?.activityRunId === activityRunId) {
    activeRuns.delete(sessionId);
  }
}

/** Araç çıktısı önizlemesi (tek satır, uzun çıktı kırpılır). */
function previewOutput(out: string, limit = 220): string {
  const flat = out.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return t('agent.previewEmpty');
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Faz 12 B.8 — ortak run olay işleyicisi.
 *
 * Hem yeni turda hem de **geri yüklenen** (restart sonrası) turda agent'ın
 * çıktısı aynı mesaj dizisine yazılmalı → tek yerden.
 *
 * v1.0: tool sonuçları kalıcı katmana `system` mesajı olarak yazıldığı için,
 * aradan sonra gelen metin **yeni bir assistant mesajına** yazılır. Böylece
 * nihai cevap transkripte araç çıktılarının ALTINDA görünür. Hedef yalnızca
 * son mesaj assistant değilse (yani bir tool sonucu araya girdiyse) yenilenir;
 * tur başına tek mesaja sabitlemek cevabı yukarıda tutuyordu.
 */
export interface RunEventHandler {
  (e: AgentEvent): void;
  /** Tur sonunda içeriğin yazıldığı mesaj id'si (boş temizliği için). */
  targetId(): string;
  /** Faz 1: bekleyen metin/reasoning deltalarını hemen yazar. */
  flush(): void;
}

export function makeRunEventHandler(opts: {
  sessionId: string;
  assistantId: string;
  provider: Provider;
  model: string;
  callNames: Map<string, string>;
  emit: (line: AgentToolLine) => void;
  /** Agent aktivite şeridini aşama değişimlerine bağlar. */
  activity?: {
    runId: string;
    update: (patch: AgentActivityPatch) => void;
  };
}): RunEventHandler {
  const { sessionId, assistantId, provider, model, callNames, emit, activity } = opts;
  const updateActivity = activity?.update;
  const store = useSessionStore.getState;
  /** P0.2: exec canlı çıktısı çağrı id'si başına birikir. */
  const streamBuf = new Map<string, string>();
  let targetId = assistantId;

  /**
   * Son kalıcı mesaj assistant değilse (tool sonucu araya girdiyse) yeni bir
   * assistant mesajı açıp dizinin sonuna ekler; aksi halde aynı mesaja devam
   * eder. Böylece cevap parçalanmaz, ama araç çıktılarının üstünde de kalmaz.
   */
  const ensureTarget = () => {
    const msgs = store().sessions.find((s) => s.id === sessionId)?.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (last?.id === targetId && last.role === 'assistant') return;
    const id = createId();
    store().addMessage(sessionId, {
      id,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      model,
      provider,
    });
    targetId = id;
  };

  // Faz 1: token başına store yazımı yerine 40 ms'lik pencerede birleştir.
  const batcher = createDeltaBatcher((text, reasoning) => {
    if (text) {
      ensureTarget();
      store().appendToMessage(sessionId, targetId, text);
    }
    if (reasoning) {
      try {
        ensureTarget();
        store().appendReasoning(sessionId, targetId, reasoning);
      } catch {
        // store hatası akışı durdurmaz
      }
    }
  });
  // Faz 3: araç başına son canlı çıktı satırı; pencerede birleştirilir.
  const pendingToolLines = new Map<string, AgentToolLine>();
  let toolTimer: ReturnType<typeof setTimeout> | null = null;

  const clearToolTimer = () => {
    if (toolTimer !== null) {
      clearTimeout(toolTimer);
      toolTimer = null;
    }
  };

  const flushToolLines = () => {
    clearToolTimer();
    if (pendingToolLines.size === 0) return;
    const lines = [...pendingToolLines.values()];
    pendingToolLines.clear();
    for (const line of lines) emit(line);
  };

  const scheduleToolFlush = () => {
    if (toolTimer !== null) return;
    toolTimer = setTimeout(() => {
      toolTimer = null;
      flushToolLines();
    }, TOOL_LINE_FLUSH_MS);
  };

  return Object.assign(
    (e: AgentEvent) => {
      // Araç/sınır olayları çıktı sırasını değiştirir: önce bekleyen metni yaz.
      if (e.k !== 'text' && e.k !== 'reasoning') batcher.flush();
      // Canlı araç çıktısı dışındaki her olay bekleyen kart güncellemesini
      // hemen yazar (araç sonucu/sıra değişimi beklemez).
      if (e.k !== 'tool_stream') flushToolLines();
      if (e.k === 'turn_start') {
        updateActivity?.({ phase: 'thinking', tool: null, retry: null });
      } else if (e.k === 'text' && e.delta) {
        updateActivity?.({ phase: 'writing' });
        batcher.pushText(e.delta);
      } else if (e.k === 'reasoning' && e.delta) {
        updateActivity?.({ phase: 'thinking' });
        batcher.pushReasoning(e.delta);
      } else if (e.k === 'thinking' && e.blocks.length > 0) {
        updateActivity?.({ phase: 'thinking' });
        try {
          ensureTarget();
          store().setAssistantThinking(sessionId, targetId, e.blocks);
        } catch {
          // yoksay
        }
      } else if (e.k === 'notice') {
        // Adım sınırı / kapanış turu gibi durumları terminalde görünür kıl.
        emit({ type: 'warn', content: e.text });
      } else if (e.k === 'usage') {
        try {
          // Metin/araç çağrısı hedefi zaten açtı; usage yeni mesaj açmaz
          // (resolve akışında boş placeholder kalmasın).
          store().setMessageLastRequest(sessionId, targetId, {
            input: e.usage.input,
            output: e.usage.output,
          });
        } catch {
          // yoksay
        }
        // v0.2.3: her API adımı için usage_events kaydı (stats ekranı).
        try {
          const settings = useSettingsStore.getState();
          const price = settings.prices[model];
          const ws = useWorkspaceStore.getState();
          const project =
            ws.label || (ws.root ? ws.root.split(/[\\/]/).filter(Boolean).pop() : undefined);
          void appendUsageEvent({
            id: createId(),
            ts: Date.now(),
            sessionId,
            provider,
            model,
            ...(project ? { project } : {}),
            inputTokens: e.usage.input ?? 0,
            outputTokens: e.usage.output ?? 0,
            reasoningTokens: e.usage.reasoning ?? 0,
            cacheReadTokens: e.usage.cacheRead ?? 0,
            cacheWriteTokens: e.usage.cacheWrite ?? 0,
            latencyMs: 0,
            ttftMs: 0,
            status: 'ok',
            costUsd: price ? costForTokens(e.usage, price) : 0,
            estimated: price ? 0 : 1,
            toolMs: 0,
          });
        } catch {
          // stats kaydı akışı durdurmaz
        }
      } else if (e.k === 'done') {
        updateActivity?.({ phase: 'finalizing', tool: null });
        if (e.usage) {
          try {
            store().setMessageUsage(sessionId, targetId, e.usage);
          } catch {
            // yoksay
          }
        }
      } else if (e.k === 'tool_call') {
        const toolName = String(e.call.name);
        callNames.set(e.call.id, toolName);
        streamBuf.delete(e.call.id);
        updateActivity?.({
          phase: 'tool',
          tool: {
            id: String(e.call.id),
            name: toolName,
            target: toolTarget(toolName, e.call.args as Record<string, unknown>),
          },
          retry: null,
        });
        try {
          ensureTarget();
          store().appendToolCalls(sessionId, targetId, [
            {
              id: e.call.id,
              name: String(e.call.name),
              args: e.call.args as Record<string, unknown>,
              ts: Date.now(),
            },
          ]);
        } catch {
          // store hatası akışı durdurmaz
        }
        emit({
          type: 'sys',
          content: `/// tool ▸ ${e.call.name} ${JSON.stringify(e.call.args).slice(0, 160)}`,
          tool: {
            id: String(e.call.id),
            name: String(e.call.name),
            args: previewArgs(e.call.args as Record<string, unknown>),
            target: toolTarget(String(e.call.name), e.call.args as Record<string, unknown>),
            status: 'run',
          },
        });
      } else if (e.k === 'tool_stream') {
        updateActivity?.({ phase: 'tool' });
        // P0.2: aynı tool id'siyle birleşen canlı çıktı. Terminal.tsx kartı
        // id üzerinden upsert eder; burada kümülatif metni taşırız.
        const toolName = callNames.get(e.id) ?? 'exec';
        const next = `${streamBuf.get(e.id) ?? ''}${e.data}`.slice(-8000);
        streamBuf.set(e.id, next);
        // Faz 3: parça başına App güncellemesi yerine pencere sonunda tek satır.
        pendingToolLines.set(String(e.id), {
          type: 'sys',
          content: `/// tool ▸ ${toolName}`,
          tool: {
            id: String(e.id),
            name: toolName,
            args: '',
            status: 'run',
            output: next,
          },
        });
        scheduleToolFlush();
      } else if (e.k === 'tool_preview') {
        emit({
          type: 'sys',
          content: `/// ${t('tool.output')} (${e.id.slice(0, 8)}):\n${e.output.slice(0, 800)}`,
        });
      } else if (e.k === 'tool_result') {
        updateActivity?.({ phase: 'finalizing', tool: null });
        const toolName = callNames.get(e.id);
        streamBuf.delete(e.id);
        try {
          store().addToolMessages(sessionId, [
            {
              role: 'system',
              content: e.output,
              toolCallId: e.id,
              ...(toolName ? { toolName } : {}),
              isError: !e.ok,
            },
          ]);
        } catch {
          // yoksay
        }
        if (toolName) {
          // Yapılandırılmış araç kartı (çağrı + sonuç tek kartta birleşir).
          emit({
            type: e.ok ? 'sys' : 'err',
            content: e.ok
              ? `▸ ${toolName}: ${previewOutput(e.output)}`
              : t('agent.toolFailed', { tool: `${e.id.slice(0, 8)}: ${e.output.slice(0, 300)}` }),
            tool: {
              id: String(e.id),
              name: toolName,
              args: '',
              status: e.ok ? 'ok' : 'err',
              output: e.output,
            },
          });
        } else if (!e.ok) {
          emit({
            type: 'err',
            content: t('agent.toolFailed', {
              tool: `${e.id.slice(0, 8)}: ${e.output.slice(0, 300)}`,
            }),
          });
        }
      }
    },
    {
      targetId: () => targetId,
      flush: () => {
        batcher.flush();
        flushToolLines();
      },
    },
  );
}

/**
 * Tur boyunca açılan boş asistan mesajlarını temizler. `onlyIds` verilirse
 * yalnızca o turun mesajlarına bakılır; verilmezse oturumdaki tüm boş asistan
 * mesajları temizlenir (onay akışı sonrası kalıntılar için).
 * `true` dönerse hiç görünür içerik üretilmemiş demektir.
 */
function cleanBlankAssistantMessages(sessionId: string, onlyIds?: string[]): boolean {
  const store = useSessionStore.getState;
  const msgs = store().sessions.find((s) => s.id === sessionId)?.messages ?? [];
  let allBlank = true;
  for (const m of msgs) {
    if (m.role !== 'assistant') continue;
    if (onlyIds && !onlyIds.includes(m.id)) continue;
    if (!isBlankAssistantMessage(m)) {
      allBlank = false;
      continue;
    }
    store().removeMessage(sessionId, m.id);
  }
  return allBlank;
}

/**
 * Agent'lı gönderim (Faz 1: duraklatılabilir run + kalıcı onay).
 * Sözleşme useStream ile aynı: başarı/abort -> null, hata -> err satırı.
 */
export function useAgent() {
  const t = useT();
  /**
   * Oturum başına iptal denetleyicisi.
   * Oturumlar paralel çalışabildiği için tek bir `abortRef` yeterli değil —
   * aksi halde 2. oturumda durdurma 1. oturumun akışını da kesiyordu.
   */
  const abortRef = useRef<
    Map<string, { controller: AbortController; sessionId: string; activityRunId: string }>
  >(new Map());

  /**
   * `sessionId` verilirse YALNIZ o oturumun akışı durur; verilmezse tüm
   * oturumlar durdurulur (uygulama kapanırken / global iptal).
   */
  const abort = useCallback((sessionId?: string) => {
    const activityStore = useAgentActivityStore.getState();
    const sessionStore = useSessionStore.getState();
    const targets =
      sessionId != null
        ? [sessionId]
        : [...new Set([...abortRef.current.keys(), ...activeRuns.keys()])];
    for (const id of targets) {
      const current = abortRef.current.get(id);
      current?.controller.abort();
      // Hazırlık aşamasındaki henüz kayıt edilmemiş run da sahibine doğru temizlenir.
      if (current) {
        activityStore.end(current.sessionId, current.activityRunId);
      }
      const active = activeRuns.get(id);
      if (active) {
        active.run.abort();
        activityStore.end(id, active.activityRunId);
        activeRuns.delete(id);
      }
      abortRef.current.delete(id);
      sessionStore.setStreaming(id, false);
    }
  }, []);

  const sendAgent = useCallback(
    async (
      text: string,
      onToolLine?: (line: AgentToolLine) => void,
      images?: string[],
      onPending?: (pending: ToolCall[]) => void,
      /** Retry başlarken bilgi, tur bitince `null`. */
      onRetry?: (info: RetryInfo | null) => void,
    ): Promise<string | null> => {
      const trimmed = text.trim();
      if (!trimmed && (!images || images.length === 0)) return null;

      let session = useSessionStore.getState().getActiveSession();
      if (!session) session = useSessionStore.getState().createSession();
      const sessionId = session.id;
      // Akış kontrolü OTURUM bazlıdır: başka bir konuşma akıyorsa bu
      // konuşma yine başlatılabilir (yalnız aynı oturum kilitli).
      if (useSessionStore.getState().isStreamingFor(sessionId)) return null;
      // Aynı oturumda onay bekleyen/çalışan bir run varsa yeni tur başlatma.
      // Bu, restore sonrası aynı oturumda iki run'ın birbirinin durumunu
      // ezip aktivite `runId` eşleşmesini bozmasını engeller.
      if (activeRuns.has(sessionId)) return null;
      const store = useSessionStore.getState;
      const settings = useSettingsStore.getState();
      const ws = useWorkspaceStore.getState();

      if (!ws.root) {
        return t('agent.noWorkspace');
      }
      if (settings.activeEndpointId) {
        return t('agent.errCustomEndpoint');
      }

      const providerName: Provider = session.provider ?? settings.currentProvider;
      const model = session.model || settings.currentModel;
      if (!supportsTools(providerName, model, settings.customModels)) {
        return t('agent.errNoTools', {
          provider: providerName,
          model,
          providers: PROVIDER_IDS.join('|'),
        });
      }
      const apiKey = apiKeyFor(providerName, settings.apiKeys);
      if (providerNeedsKey(providerName) && !apiKey.trim()) {
        return t('agent.errNoApiKey');
      }

      const userId = createId();
      const assistantId = createId();
      const now = Date.now();
      const runId = createId();
      const activityStore = useAgentActivityStore.getState();
      activityStore.begin(sessionId, runId);
      store().setStreaming(sessionId, true);
      store().addMessage(sessionId, {
        id: userId,
        role: 'user',
        content: trimmed,
        timestamp: now,
        model,
        provider: providerName,
        ...(images && images.length > 0 ? { images: [...images] } : {}),
      });
      store().addMessage(sessionId, {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: now,
        model,
        provider: providerName,
      });

      // Faz 7: compaction hafızası varsa geçmiş = "özet + o özetten sonraki mesajlar".
      // (Aynı özet her turda yeniden yapılmaz.)
      const sessionMessages =
        useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.messages ?? [];
      const rawHistory = buildAgentHistory(sessionMessages, assistantId);
      // Faz 12 B.6: bellekte yoksa oturumdaki kalıcı kopya (restart sonrası).
      const memo = resolveMemo<AgentHistoryItem>(sessionId, session.compaction);
      const history: AgentHistoryItem[] = applyMemo(memo, rawHistory);
      const ctrl = new AbortController();
      abortRef.current.set(sessionId, { controller: ctrl, sessionId, activityRunId: runId });
      const callNames = new Map<string, string>();
      const emit = (line: AgentToolLine) => onToolLine?.(line);
      const updateActivity = (patch: AgentActivityPatch) => {
        useAgentActivityStore.getState().update(sessionId, runId, patch);
      };
      const handler = makeRunEventHandler({
        sessionId,
        assistantId,
        provider: providerName,
        model,
        callNames,
        emit,
        activity: { runId, update: updateActivity },
      });
      registerRunHandler(sessionId, handler);
      /**
       * Tur boyunca açılan (boş kalmış) assistant mesajlarını temizler.
       * `toolCalls` taşıyan mesaj silinmez — tool sonuç eşleşmesi bozulmasın.
       * `true` dönerse tur hiç metin üretmemiş demektir.
       */
      const cleanEmptyAssistant = (): boolean =>
        cleanBlankAssistantMessages(sessionId, [assistantId, handler.targetId()]);

      try {
        // Faz 5: MCP bağlamı + araçları (düşen sunucu sessizce atlanır).
        configureMcp({ servers: settings.mcpServers, secrets: settings.mcpSecrets, root: ws.root });
        let extraTools: ToolDefinition[] = [];
        try {
          extraTools = await mcpToolsForAgent();
          if (settings.mcpServers.some((s) => s.enabled) && extraTools.length === 0) {
            emit({ type: 'warn', content: t('agent.mcpUnreachable') });
          }
        } catch {
          extraTools = [];
        }
        // Faz 2: gönderim öncesi otomatik compaction (user mesajı tura dahil).
        let effHistory = history;
        try {
          const limit = compactionLimitFor(model, settings.customModels);
          if (shouldCompact(history, limit)) {
            const cfg = summarizerConfig({
              currentProvider: providerName,
              currentModel: model,
              summarizerProvider: settings.summarizerProvider,
              summarizerModel: settings.summarizerModel,
              apiKeys: settings.apiKeys,
              customModels: settings.customModels,
              baseUrlOverride: settings.baseUrlOverride,
            });
            if (cfg) {
              const compacted = await compactHistory({
                history,
                budget: limit,
                summarize: makeSummarizeFn(cfg),
              });
              if (compacted !== history) {
                effHistory = compacted;
                // Hafızaya yaz: sonraki turlarda aynı özet tekrar yapılmaz.
                // Faz 9 P9.5: kesim id tabanlı olsun (zaman damgası riski).
                const memoForm = {
                  at: Date.now(),
                  items: compacted,
                  coveredIds: history
                    .map((h) => h.id)
                    .filter((x): x is string => typeof x === 'string'),
                };
                setMemo(sessionId, memoForm.at, compacted, {
                  coveredIds: memoForm.coveredIds,
                });
                // Faz 12 B.6: özet oturuma kalıcı yazılır (restart sonrası tekrar özetlenmez).
                store().setCompaction(sessionId, memoToPersisted(memoForm));
                emit({ type: 'sys', content: t('agent.compacted') });
              }
            }
          }
        } catch {
          effHistory = history;
        }
        // Faz 7 denetimi: kullanıcı mesajı oturum geçmişinde **zaten var**
        // (buildAgentHistory son mesaj olarak alır) — ikinci kez eklenmiyor.
        const historyWithUser = effHistory;
        // Faz 3: aktif todo listesi system prompt'a eklenir.
        const todoState = deriveTodoState(history);
        const todoBlock =
          todoState.items.length > 0
            ? `\n[todo]\n${todoState.items.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.id} ${t.text}`).join('\n')}`
            : '';
        // Faz 9 P9.1–P9.3: repo bağlamı (harita + AGENTS.md/README + kalıcı hafıza).
        // Önbellekli: aynı workspace'te her turda yeniden hazırlanmaz.
        let projectBlock = '';
        try {
          const repoCtx = await buildRepoContext(ws.root, {
            model,
            customModels: settings.customModels,
          });
          projectBlock = repoCtx.text;
          if (repoCtx.error) {
            emit({
              type: 'warn',
              content: t('agent.repoContextFailed', { message: repoCtx.error.slice(0, 160) }),
            });
          }
        } catch {
          // Bağlam hazırlanamazsa agent yine çalışır (tool keşfi ile).
        }
        if (ctrl.signal.aborted) {
          cleanEmptyAssistant();
          return null;
        }
        const mode = session.agentMode ?? 'build';
        const reportAgentRetry = (info: RetryInfo | null) => {
          if (info) {
            updateActivity({
              phase: 'retrying',
              tool: null,
              retry: {
                attempt: info.nextAttempt,
                maxAttempts: info.maxAttempts,
                delayMs: info.delayMs,
              },
            });
          } else {
            updateActivity({ phase: 'thinking', retry: null });
          }
          onRetry?.(info);
        };
        const run = createAgentRun(historyWithUser, {
          provider: providerName,
          apiKey,
          model,
          agentMode: mode,
          systemPrompt:
            [
              session.systemPrompt || settings.systemPrompt || '',
              getModePrompt(mode),
              // Faz 8 L5: skill registry'sindeki talimatlar modele ulaşır
              // (önceden `skillsPrompt` hiç çağrılmıyordu).
              skillsPrompt(listSkills().map((sk) => sk.name)),
              // Faz 9: proje haritası + anahtar dosyalar + kalıcı notlar.
              projectBlock,
              `[workspace:${ws.label || ws.root}]${todoBlock}`,
            ]
              .filter(Boolean)
              .join('\n')
              .trim() || undefined,
          workspaceRoot: ws.root,
          approvalMode: ws.approvalMode,
          signal: ctrl.signal,
          params: settings.modelParams[model],
          registry: resolveModels(settings.customModels),
          // Faz 11: prompt cache (agent döngüsünde en çok kazanç burada).
          ...(settings.cachePrompts !== false
            ? { cachePrompts: true, promptCacheKey: promptCacheKey(sessionId, model) }
            : {}),
          extraTools,
          extraAllow: parseCustomAllowList(settings.customAllowList),
          execTimeoutMs: settings.execTimeoutMs,
          maxSteps: settings.agentMaxSteps,
          // Faz 8 L1: alt-agent kendi compaction'ı için özetleyici (yoksa kısaltma).
          summarize: async (transcript: string) => {
            const cfg = summarizerConfig({
              currentProvider: providerName,
              currentModel: model,
              summarizerProvider: settings.summarizerProvider,
              summarizerModel: settings.summarizerModel,
              apiKeys: settings.apiKeys,
              customModels: settings.customModels,
              baseUrlOverride: settings.baseUrlOverride,
            });
            if (!cfg) return transcript.slice(0, 1200);
            return makeSummarizeFn(cfg)(transcript);
          },
          ...(settings.auditEnabled ? { auditSessionId: sessionId } : {}),
          onRetry: reportAgentRetry,
          onEvent: handler,
        });
        activeRuns.set(sessionId, { run, activityRunId: runId });
        logInfo('agent.run.start', {
          provider: providerName,
          model,
          messages: historyWithUser.length,
        });
        const result = await run.step();
        // Faz 1: tur bitiminde kuyruktaki son deltalar (cleanup'tan önce).
        handler.flush();
        if (result.kind === 'needs-approval') {
          const pendingCall = result.pending[0];
          updateActivity({
            phase: 'awaiting_approval',
            tool: pendingCall
              ? {
                  id: String(pendingCall.id),
                  name: String(pendingCall.name),
                  target: toolTarget(
                    String(pendingCall.name),
                    pendingCall.args as Record<string, unknown>,
                  ),
                }
              : null,
            retry: null,
          });
          // Faz 12 B.8: run durumu kalıcı yazılır → uygulama yeniden başlatıldığında
          // bekleyen iş kaldığı yerden sürülür (eskiden "yeniden başlatılamadı").
          const runState = run.serialize();
          for (const call of result.pending) {
            try {
              await queueApproval({
                id: call.id,
                sessionId,
                call,
                createdAt: Date.now(),
                runState,
              });
            } catch (error) {
              // Kalıcı onay kuyruğu agent'ın durmasını gerektirmez.
              logError('agent.approval.persist.failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          onPending?.(result.pending);
          emit({
            type: 'sys',
            content: t('agent.pendingLine', {
              count: result.pending.length,
              names: result.pending.map((c) => c.name).join(' · '),
            }),
          });
          return null;
        }
        clearActiveRun(sessionId, runId);
        logInfo('agent.run.done', { provider: providerName, model, kind: result.kind });
        // v1.0: turun başındaki placeholder ve tool sonrası açılan hedef mesaj
        // birlikte değerlendirilir (ikisi de boşsa gerçekten cevap yok demektir).
        if (cleanEmptyAssistant()) return t('agent.errEmptyReply');
        return null;
      } catch (err) {
        // Boş mesaj temizliğinden ÖNCE bekleyen metni yaz.
        handler.flush();
        clearActiveRun(sessionId, runId);
        logError('agent.run.error', {
          provider: providerName,
          model,
          error: err instanceof Error ? err.message : String(err),
        });
        if (ctrl.signal.aborted) return null;
        cleanEmptyAssistant();
        return formatProviderError(err);
      } finally {
        handler.flush();
        const activeRunId = activeRuns.get(sessionId)?.activityRunId;
        const stillPending = activeRunId === runId;
        if (!stillPending) {
          releaseRunHandler(sessionId, handler);
          // Aynı oturumda daha yeni bir run başladıysa akış bayrağını ve yeni
          // aktiviteyi bu eski turun temizliği bozmasın.
          if (!activeRunId) store().setStreaming(sessionId, false);
          useAgentActivityStore.getState().end(sessionId, runId);
          if (abortRef.current.get(sessionId)?.controller === ctrl) {
            abortRef.current.delete(sessionId);
          }
        }
        try {
          onRetry?.(null);
        } catch {
          // UI temizliği turu bozmaz.
        }
      }
    },
    [t],
  );

  const resolvePending = useCallback(
    async (
      sessionId: string,
      decisions: Array<{ id: string; approved: boolean }>,
      onToolLine?: (line: AgentToolLine) => void,
      onPending?: (pending: ToolCall[]) => void,
      /** Onay sonrası devam eden turda retry göstergesini temizler. */
      onRetry?: (info: RetryInfo | null) => void,
    ): Promise<string | null> => {
      const active = activeRuns.get(sessionId);
      if (!active) {
        // Bellekte run yok; varsa görünen aktivite başka bir run'a ait olabilir.
        // Bu yolda aktiviteyi koşulsuz temizlemeyiz.
        const settings = useSettingsStore.getState();
        // Bellekte run yok (restart) — patch apply yine çalışır, agent devam etmez.
        // Yalnızca ONAYLANAN karar devam gerektirir; tamamı reddedildiyse işlem
        // başarıyla tamamlanmıştır (eskiden ret de "yeniden başlatılamıyor"
        // hatası üretiyordu).
        let needsRun = false;
        for (const d of decisions) {
          let queued: Awaited<ReturnType<typeof takeApproval>>;
          try {
            queued = await takeApproval(d.id);
          } catch (error) {
            logError('agent.approval.take.failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          if (!queued) continue;
          let line: string | null = null;
          if (d.approved) {
            needsRun = true;
          } else {
            line = t('agent.rejected', { id: d.id.slice(0, 8) });
            onToolLine?.({ type: 'sys', content: line });
          }
          // L5: run bellekte yokken verilen karar da audit'e yazılır. Eskiden
          // yalnız canlı run yolu audit üretiyordu → restart sonrası onay/ret
          // kararları denetim kaydında görünmüyordu.
          if (settings.auditEnabled) {
            void appendAudit({
              sessionId,
              tool: String(queued.call.name),
              argsPreview: JSON.stringify(redact(queued.call.args ?? {})).slice(0, 200),
              decision: d.approved ? 'approved' : 'rejected',
              result: (line ?? t('agent.cannotRestart')).slice(0, 200),
            });
          }
        }
        onRetry?.(null);
        return needsRun ? t('agent.cannotRestart') : null;
      }
      const { run, activityRunId } = active;
      const activityState = useAgentActivityStore.getState();
      const existingActivity = activityState.activities[sessionId];
      // Aktivite abort sonrası kapatılmış olabilir; aynı run kimliğiyle yeniden
      // açılır. Böylece olay işleyicisi değişmeden spinner da yeniden başlamaz.
      if (!existingActivity || existingActivity.runId !== activityRunId) {
        activityState.begin(sessionId, activityRunId);
      }
      const updateActivity = (patch: AgentActivityPatch) => {
        useAgentActivityStore.getState().update(sessionId, activityRunId, patch);
      };
      updateActivity({ phase: 'preparing', tool: null, retry: null });

      const store = useSessionStore.getState;
      store().setStreaming(sessionId, true);
      const callNames = new Map<string, string>();
      // Karar öncesi kuyruğu düşür.
      for (const d of decisions) {
        let queued: Awaited<ReturnType<typeof takeApproval>>;
        try {
          queued = await takeApproval(d.id);
        } catch (error) {
          logError('agent.approval.take.failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!queued) continue;
        if (!d.approved) {
          onToolLine?.({ type: 'sys', content: t('agent.rejected', { id: d.id.slice(0, 8) }) });
        } else {
          const call = queued.call;
          updateActivity({
            phase: 'tool',
            tool: {
              id: String(call.id),
              name: String(call.name),
              target: toolTarget(String(call.name), call.args as Record<string, unknown>),
            },
          });
          onToolLine?.({ type: 'sys', content: t('agent.approved', { id: d.id.slice(0, 8) }) });
        }
      }
      try {
        // resolve içindeki olayları kalıcı katmana yansıtmak için run'ın onEvent'i zaten bağlı;
        // burada ek satırlar için geçici dinleyici yeterli (run içi emit App'e gider).
        const result = await run.resolve(decisions);
        // Faz 1: onay sonrası turun trailing deltaları (temizlikten önce).
        flushRunDeltas(sessionId);
        void callNames;
        if (result.kind === 'needs-approval') {
          const pendingCall = result.pending[0];
          updateActivity({
            phase: 'awaiting_approval',
            tool: pendingCall
              ? {
                  id: String(pendingCall.id),
                  name: String(pendingCall.name),
                  target: toolTarget(
                    String(pendingCall.name),
                    pendingCall.args as Record<string, unknown>,
                  ),
                }
              : null,
            retry: null,
          });
          // M1: kalan kartlar kuyrukta KALIR — yeniden yazarken mevcut
          // `createdAt` korunur (sıra değişmesin) ve güncel `runState` yazılır
          // (INSERT OR REPLACE eski satırı siler; runState kaybı restart'ı bozar).
          const runState = run.serialize();
          const existing = await listApprovals(sessionId);
          const prevById = new Map(existing.map((a) => [a.id, a]));
          for (const call of result.pending) {
            const prev = prevById.get(call.id);
            try {
              await queueApproval({
                id: call.id,
                sessionId,
                call,
                createdAt: prev?.createdAt ?? Date.now(),
                runState,
              });
            } catch (error) {
              // DB kilidi onay kartının çalışmasını engellememeli.
              logError('agent.approval.persist.failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          onPending?.(result.pending);
          onToolLine?.({
            type: 'sys',
            content: t('agent.pendingLine', {
              count: result.pending.length,
              names: result.pending.map((c) => c.name).join(' · '),
            }),
          });
          return null;
        }
        clearActiveRun(sessionId, activityRunId);
        // Onay turu metinsiz bitirse placeholder boş assistant satırı kalmasın.
        flushRunDeltas(sessionId);
        cleanBlankAssistantMessages(sessionId);
        store().setStreaming(sessionId, false);
        useAgentActivityStore.getState().end(sessionId, activityRunId);
        return null;
      } catch (err) {
        clearActiveRun(sessionId, activityRunId);
        flushRunDeltas(sessionId);
        cleanBlankAssistantMessages(sessionId);
        store().setStreaming(sessionId, false);
        useAgentActivityStore.getState().end(sessionId, activityRunId);
        return formatProviderError(err);
      } finally {
        try {
          onRetry?.(null);
        } catch {
          // UI temizliği turu bozmaz.
        }
      }
    },
    [t],
  );

  /**
   * Faz 12 B.8 — bekleyen onaylı işleri geri yükler.
   *
   * Uygulama yeniden başlatıldığında `pending_approvals.run_state` içindeki agent
   * durumu okunur ve tur kaldığı yerden sürülür (eskiden "yeniden başlatılamadı").
   * Dönen sayı: geri yüklenen oturum sayısı.
   */
  const restorePendingRuns = useCallback(
    async (
      onRetryFor?: (sessionId: string, info: RetryInfo | null) => void,
      onNoticeFor?: (sessionId: string, text: string) => void,
    ): Promise<number> => {
      const settings = useSettingsStore.getState();
      const ws = useWorkspaceStore.getState();
      if (!ws.root) return 0;
      const store = useSessionStore.getState;
      let restored = 0;
      let approvals: Awaited<ReturnType<typeof listApprovals>> = [];
      try {
        approvals = await listApprovals();
      } catch {
        return 0;
      }
      for (const a of approvals) {
        if (activeRuns.has(a.sessionId)) continue;
        if (!a.runState) continue;
        let state: AgentRunState;
        try {
          state = JSON.parse(a.runState) as AgentRunState;
        } catch {
          continue;
        }
        if (!state || !Array.isArray(state.msgs) || state.msgs.length === 0) continue;
        const sess = store().sessions.find((s) => s.id === a.sessionId);
        if (!sess) continue;
        const providerName: Provider = sess.provider ?? settings.currentProvider;
        const model = sess.model || settings.currentModel;
        const apiKey = apiKeyFor(providerName, settings.apiKeys);
        if (providerNeedsKey(providerName) && !apiKey.trim()) continue;

        // MCP araçları (yeniden bağlan).
        let extraTools: ToolDefinition[] = [];
        try {
          configureMcp({
            servers: settings.mcpServers,
            secrets: settings.mcpSecrets,
            root: ws.root,
          });
          extraTools = await mcpToolsForAgent();
        } catch {
          extraTools = [];
        }

        // Çıktının yazılacağı assistant mesajı (yoksa yeni placeholder).
        const msgs = store().sessions.find((s) => s.id === a.sessionId)?.messages ?? [];
        let assistantId = '';
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') {
            assistantId = msgs[i].id;
            break;
          }
        }
        if (!assistantId) {
          assistantId = createId();
          store().addMessage(a.sessionId, {
            id: assistantId,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            model,
            provider: providerName,
          });
        }

        const callNames = new Map<string, string>();
        // Mod, run'ın doğduğu moddan gelir (state'te taşınır). Eski kayıtlarda
        // alan yok → oturumun o anki moduna düşülür. Böylece yeniden başlatma
        // sonrası mod değişse bile bekleyen iş yanlış modda çalışmaz.
        const restoreMode = resolveRestoreMode(state.agentMode, sess.agentMode);
        const runId = createId();
        const updateActivity = (patch: AgentActivityPatch) => {
          useAgentActivityStore.getState().update(a.sessionId, runId, patch);
        };
        useAgentActivityStore.getState().begin(a.sessionId, runId);
        updateActivity({
          phase: 'awaiting_approval',
          tool: {
            id: String(a.call.id),
            name: String(a.call.name),
            target: toolTarget(String(a.call.name), a.call.args as Record<string, unknown>),
          },
        });
        const restoredHandler = makeRunEventHandler({
          sessionId: a.sessionId,
          assistantId,
          provider: providerName,
          model,
          callNames,
          emit: (line) => onNoticeFor?.(a.sessionId, line.content),
          activity: { runId, update: updateActivity },
        });
        registerRunHandler(a.sessionId, restoredHandler);
        const run = createAgentRun(
          state.msgs,
          {
            provider: providerName,
            apiKey,
            model,
            agentMode: restoreMode,
            systemPrompt:
              `${sess.systemPrompt || settings.systemPrompt || ''}\n${getModePrompt(restoreMode)}\n[workspace:${ws.label || ws.root}]`.trim() ||
              undefined,
            workspaceRoot: ws.root,
            approvalMode: ws.approvalMode,
            params: settings.modelParams[model],
            registry: resolveModels(settings.customModels),
            extraTools,
            extraAllow: parseCustomAllowList(settings.customAllowList),
            execTimeoutMs: settings.execTimeoutMs,
            maxSteps: settings.agentMaxSteps,
            ...(settings.auditEnabled ? { auditSessionId: a.sessionId } : {}),
            ...(settings.cachePrompts !== false
              ? { cachePrompts: true, promptCacheKey: promptCacheKey(a.sessionId, model) }
              : {}),
            onRetry: (info: RetryInfo | null) => {
              if (info) {
                updateActivity({
                  phase: 'retrying',
                  tool: null,
                  retry: {
                    attempt: info.nextAttempt,
                    maxAttempts: info.maxAttempts,
                    delayMs: info.delayMs,
                  },
                });
              } else {
                updateActivity({ phase: 'thinking', retry: null });
              }
              onRetryFor?.(a.sessionId, info);
            },
            onEvent: restoredHandler,
          },
          state,
        );
        activeRuns.set(a.sessionId, { run, activityRunId: runId });
        // Restore edilen run da "aktif akış" sayılır: eskiden yalnız aktivite
        // `awaiting_approval` yapılıyordu, `streaming` false kalıyordu →
        // mod seçici açık/tıklanabilir oluyor, Durdur butonu görünmüyor ve
        // kullanıcı onay beklerken farklı bir moda geçebiliyordu.
        store().setStreaming(a.sessionId, true);
        restored += 1;
        logInfo('agent.run.restored', { sessionId: a.sessionId, provider: providerName, model });
      }
      return restored;
    },
    [],
  );

  return { sendAgent, resolvePending, restorePendingRuns, abort };
}
