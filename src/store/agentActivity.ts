import { create } from 'zustand';

/** Agent çalışmasının kullanıcıya gösterilen aşamaları. */
export type AgentActivityPhase =
  'preparing' | 'thinking' | 'writing' | 'tool' | 'awaiting_approval' | 'retrying' | 'finalizing';

export interface AgentActivityTool {
  id: string;
  name: string;
  /** Kullanıcıya gösterilen kısa hedef; ham argümanlar dahil edilmez. */
  target?: string;
}

export interface AgentActivityRetry {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface AgentActivity {
  /** Tur boyunca sabit kalır; CSS animasyonlarının yeniden başlamasını önler. */
  runId: string;
  sessionId: string;
  phase: AgentActivityPhase;
  tool?: AgentActivityTool;
  retry?: AgentActivityRetry;
  startedAt: number;
  updatedAt: number;
}

export interface AgentActivityPatch {
  phase?: AgentActivityPhase;
  /** `null` mevcut aracı temizler. */
  tool?: AgentActivityTool | null;
  /** `null` mevcut retry bilgisini temizler. */
  retry?: AgentActivityRetry | null;
}

interface AgentActivityStore {
  activities: Record<string, AgentActivity>;
  begin: (sessionId: string, runId: string) => void;
  update: (sessionId: string, runId: string, patch: AgentActivityPatch) => void;
  /** Eski bir turun geç temizliği yeni turu silmemeli. */
  end: (sessionId: string, runId: string) => void;
  endAll: () => void;
}

/**
 * Agent aktivitesi çalışma zamanı durumudur; kalıcı oturum verisine karışmaz.
 * Oturum anahtarı kullanılır; böylece oturum değişimi hayalet gösterge bırakmaz.
 */
export const useAgentActivityStore = create<AgentActivityStore>((set) => ({
  activities: {},

  begin: (sessionId, runId) =>
    set((state) => {
      const now = Date.now();
      return {
        activities: {
          ...state.activities,
          [sessionId]: {
            runId,
            sessionId,
            phase: 'preparing',
            startedAt: now,
            updatedAt: now,
          },
        },
      };
    }),

  update: (sessionId, runId, patch) =>
    set((state) => {
      const current = state.activities[sessionId];
      if (!current || current.runId !== runId) return state;

      const tool = patch.tool === undefined ? current.tool : (patch.tool ?? undefined);
      const retry = patch.retry === undefined ? current.retry : (patch.retry ?? undefined);
      const phase = patch.phase ?? current.phase;

      if (current.phase === phase && current.tool === tool && current.retry === retry) {
        return state;
      }

      return {
        activities: {
          ...state.activities,
          [sessionId]: {
            ...current,
            phase,
            tool,
            retry,
            updatedAt: Date.now(),
          },
        },
      };
    }),

  end: (sessionId, runId) =>
    set((state) => {
      const current = state.activities[sessionId];
      if (!current || current.runId !== runId) return state;

      const activities = { ...state.activities };
      delete activities[sessionId];
      return { activities };
    }),

  endAll: () => set({ activities: {} }),
}));
