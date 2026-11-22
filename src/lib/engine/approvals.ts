/**
 * Faz 1 G3 (K9): kalıcı onay kuyruğu — SQLite + bellek.
 * UI (App) boot'ta restoreApprovals çağırır, step() pending'i queueApproval ile yazar,
 * resolve öncesi takeApproval ile düşer.
 */
import { executeSqlWrite, openSql, PENDING_APPROVALS_TABLE_SQL as PENDING_SQL } from '../db';
import type { ToolCall } from './types';

export interface PendingApproval {
  id: string;
  sessionId: string;
  call: ToolCall;
  createdAt: number;
  /**
   * Faz 12 B.8 — kalıcı agent durumu (JSON).
   * Uygulama yeniden başlatıldığında bekleyen iş kaldığı yerden sürülsün.
   */
  runState?: string | null;
}

/** Tek kaynak: `db.ts` (şema `src-tauri/src/lib.rs` migration ile aynı). */
export const PENDING_APPROVALS_TABLE_SQL = PENDING_SQL;

export interface ApprovalsDb {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

const memory = new Map<string, PendingApproval>();

/** DB kilitliyken onayları kaybetmemek için localStorage yedeği. */
const APPROVAL_STORAGE_KEY = 'macrocode-approvals';

function readStoredApprovals(): PendingApproval[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(APPROVAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PendingApproval =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as PendingApproval).id === 'string' &&
        typeof (item as PendingApproval).sessionId === 'string',
    );
  } catch {
    return [];
  }
}

function writeStoredApprovals(items: PendingApproval[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(APPROVAL_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // localStorage dolu/kapalı olabilir; bellek yedeği yeterli.
  }
}

function storeApprovalLocally(approval: PendingApproval): void {
  const next = readStoredApprovals().filter((item) => item.id !== approval.id);
  next.push(approval);
  writeStoredApprovals(next);
}

function removeApprovalLocally(id: string): void {
  const current = readStoredApprovals();
  const next = current.filter((item) => item.id !== id);
  if (next.length !== current.length) writeStoredApprovals(next);
}

function takeApprovalLocally(id: string): PendingApproval | undefined {
  const current = readStoredApprovals();
  const found = current.find((item) => item.id === id);
  if (found) {
    writeStoredApprovals(current.filter((item) => item.id !== id));
  }
  return found;
}

function fallbackApprovals(sessionId?: string): PendingApproval[] {
  const merged = new Map<string, PendingApproval>();
  for (const item of memory.values()) {
    if (!sessionId || item.sessionId === sessionId) merged.set(item.id, item);
  }
  for (const item of readStoredApprovals()) {
    if (!sessionId || item.sessionId === sessionId) merged.set(item.id, item);
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
}

async function openApprovalsDb(provided?: ApprovalsDb): Promise<ApprovalsDb | null> {
  if (provided) return provided;
  // Faz 7 A1: tek paylaşılan bağlantı (db.ts) — hata `sqlError()` ile görünür.
  // Şema `openDb()` sırasında bir kez kurulur; burada tekrar CREATE çalıştırmak
  // agent döngüsünde gereksiz yazma kilidi üretiyordu.
  return openSql();
}

interface ApprovalRow {
  id: string;
  session_id: string;
  call_data: string;
  run_state: string | null;
  created_at: number;
}

function rowToApproval(row: ApprovalRow): PendingApproval | null {
  try {
    const call = JSON.parse(row.call_data) as ToolCall;
    if (!call || typeof call.id !== 'string') return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      call,
      createdAt: typeof row.created_at === 'number' ? row.created_at : Date.now(),
      ...(row.run_state ? { runState: row.run_state } : {}),
    };
  } catch {
    return null;
  }
}

export async function queueApproval(p: PendingApproval, db?: ApprovalsDb): Promise<void> {
  memory.set(p.id, p);
  const odb = await openApprovalsDb(db);
  if (!odb) {
    storeApprovalLocally(p);
    return;
  }
  try {
    await executeSqlWrite(
      (sqlDb) =>
        sqlDb.execute(
          'INSERT OR REPLACE INTO pending_approvals (id, session_id, call_data, run_state, created_at) VALUES ($1, $2, $3, $4, $5)',
          [p.id, p.sessionId, JSON.stringify(p.call), p.runState ?? null, p.createdAt],
        ),
      odb,
    );
    removeApprovalLocally(p.id);
  } catch {
    // Onay kuyruğu agent'ın durmasını gerektiremez. DB kilitliyse localStorage
    // yedeğine yazıp akışı sürdürüyoruz.
    storeApprovalLocally(p);
  }
}

export async function takeApproval(
  id: string,
  db?: ApprovalsDb,
): Promise<PendingApproval | undefined> {
  const mem = memory.get(id);
  const odb = await openApprovalsDb(db);
  if (!odb) {
    const local = takeApprovalLocally(id);
    if (local) memory.delete(id);
    return local ?? mem;
  }
  try {
    const fromDb = await executeSqlWrite(async (sqlDb) => {
      const rows = await sqlDb.select<ApprovalRow[]>(
        'SELECT id, session_id, call_data, run_state, created_at FROM pending_approvals WHERE id = $1',
        [id],
      );
      await sqlDb.execute('DELETE FROM pending_approvals WHERE id = $1', [id]);
      return rows.length > 0 ? rowToApproval(rows[0]) : null;
    }, odb);
    memory.delete(id);
    removeApprovalLocally(id);
    return fromDb ?? mem;
  } catch {
    // Kilitli DB'de kayıt silinemezse localStorage/bellek kopyasını kullan.
    const local = takeApprovalLocally(id);
    if (local) memory.delete(id);
    return local ?? mem;
  }
}

export async function listApprovals(
  sessionId?: string,
  db?: ApprovalsDb,
): Promise<PendingApproval[]> {
  const odb = await openApprovalsDb(db);
  if (!odb) return fallbackApprovals(sessionId);
  try {
    const fromDb = await executeSqlWrite(async (sqlDb) => {
      const rows = sessionId
        ? await sqlDb.select<ApprovalRow[]>(
            'SELECT id, session_id, call_data, run_state, created_at FROM pending_approvals WHERE session_id = $1 ORDER BY created_at ASC',
            [sessionId],
          )
        : await sqlDb.select<ApprovalRow[]>(
            'SELECT id, session_id, call_data, run_state, created_at FROM pending_approvals ORDER BY created_at ASC',
          );
      return rows.map(rowToApproval).filter((p): p is PendingApproval => p !== null);
    }, odb);
    // Bellekte olup DB'de olmayan (henüz yazılmamış) kayıtları birleştir.
    for (const m of memory.values()) {
      if (!fromDb.some((p) => p.id === m.id) && (!sessionId || m.sessionId === sessionId)) {
        fromDb.push(m);
      }
    }
    return fromDb;
  } catch {
    return fallbackApprovals(sessionId);
  }
}

export async function restoreApprovals(db?: ApprovalsDb): Promise<PendingApproval[]> {
  const all = await listApprovals(undefined, db);
  for (const a of all) memory.set(a.id, a);
  return all;
}

export function clearApprovalsMemory(): void {
  memory.clear();
}
