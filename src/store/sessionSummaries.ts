/**
 * Faz 2 — hafif oturum özeti (sidebar / geçmiş listeleri için).
 *
 * Sidebar yalnızca kimlik, ad, mesaj sayısı, model ve mod gösterir; tam
 * `Session` nesnesine (mesaj içerikleri, tool çıktıları, görseller) abone
 * olmak her streaming deltasında tüm listeyi yeniden hesaplatıyordu.
 *
 * - Özet nesneleri oturum kimliği başına önbelleklenir ve **görünen alanlar**
 *   değişmedikçe aynı referans döner.
 * - `updatedAt` dakikaya yuvarlanır (gösterim zaten saat:dakika); böylece
 *   akış sırasında saniye saniye değişen zaman damgası listeyi titretmez.
 * - `useShallow` ile özet dizisi referansı değil elemanları karşılaştırılır.
 */
import { useShallow } from 'zustand/react/shallow';
import type { AgentMode, Session } from '../types';
import { useSessionStore } from './session';

export interface SessionSummary {
  id: string;
  name: string;
  deletedAt?: number;
  /** Dakika kovasına yuvarlanmış güncelleme zamanı. */
  updatedAt: number;
  model: string;
  agentMode?: AgentMode;
  messageCount: number;
}

const MINUTE = 60_000;

const cache = new Map<string, SessionSummary>();

function bucket(ts: number | undefined): number {
  if (!ts || ts <= 0) return 0;
  return Math.floor(ts / MINUTE) * MINUTE;
}

export function summarizeSession(s: Session): SessionSummary {
  const updatedAt = bucket(s.updatedAt);
  const model = s.model || '';
  const messageCount = s.messages.length;
  const prev = cache.get(s.id);
  if (
    prev &&
    prev.name === s.name &&
    prev.deletedAt === s.deletedAt &&
    prev.updatedAt === updatedAt &&
    prev.model === model &&
    prev.agentMode === s.agentMode &&
    prev.messageCount === messageCount
  ) {
    return prev;
  }
  const next: SessionSummary = {
    id: s.id,
    name: s.name,
    ...(s.deletedAt !== undefined ? { deletedAt: s.deletedAt } : {}),
    updatedAt,
    model,
    ...(s.agentMode ? { agentMode: s.agentMode } : {}),
    messageCount,
  };
  cache.set(s.id, next);
  return next;
}

export function selectSessionSummaries(sessions: Session[]): SessionSummary[] {
  // Silinmiş oturumların önbellek kayıtları birikmesin (nadir, küçük).
  if (cache.size > sessions.length + 64) {
    const live = new Set(sessions.map((s) => s.id));
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  }
  return sessions.map(summarizeSession);
}

/** Sidebar'ın abone olduğu dar seçici. */
export function useSessionSummaries(): SessionSummary[] {
  return useSessionStore(useShallow((s) => selectSessionSummaries(s.sessions)));
}

/** Test temizliği. */
export function __resetSessionSummaryCache(): void {
  cache.clear();
}
