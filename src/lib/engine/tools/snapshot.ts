/**
 * Proje / dosya anlık görüntüleri — Rust köprüsü + saf yardımcılar.
 *
 * Backend: `src-tauri/src/commands/snapshots.rs`
 * Depolama: <workspace>/.macrocode/snapshots/ (jail içinde, blocks.json uygulanır)
 */
import { t } from '../../i18n/core';
import { decideTool } from '../policy';
import { strArg } from '../toolspec';
import type { ToolCall } from '../types';

export interface SnapshotFile {
  path: string;
  bytes: number;
}

export interface SnapshotInfo {
  id: string;
  label: string;
  created_at: number;
  file_count: number;
  total_bytes: number;
  files: SnapshotFile[];
  excluded?: string[];
}

async function invokeRust<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  throw new Error(
    `${cmd} yalnızca Tauri'de çalışır · /root ile workspace seçip masaüstü uygulamada dene`,
  );
}

export function createSnapshot(root: string, label = ''): Promise<SnapshotInfo> {
  return invokeRust<SnapshotInfo>('create_snapshot', { root, label: label || null });
}

export function listSnapshots(root: string): Promise<SnapshotInfo[]> {
  return invokeRust<SnapshotInfo[]>('list_snapshots', { root });
}

export function restoreSnapshot(root: string, id: string): Promise<string> {
  return invokeRust<string>('restore_snapshot', { root, id });
}

export function deleteSnapshot(root: string, id: string): Promise<string> {
  return invokeRust<string>('delete_snapshot', { root, id });
}

/** Boyutu insan okunur biçime çevirir (saf, test edilebilir). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Terminal satırı için kısa özet (saf; i18n t fonksiyonu enjekte edilebilir). */
export function formatSnapshotLine(s: SnapshotInfo, tr: typeof t = t): string {
  const label = s.label || tr('snapshot.untitled');
  const date = new Date(s.created_at).toLocaleString();
  return `${s.id.slice(0, 12)} · ${label} · ${date} · ${s.file_count} dosya · ${formatBytes(s.total_bytes)}`;
}

/** Agent aracı: anlık görüntü oluşturur (dosyaları değiştirmez, kopyalar). */
export async function toolCreateSnapshot(root: string, call: ToolCall): Promise<string> {
  const decision = decideTool('create_snapshot', call.args, 'manual');
  if (!decision.allowed) throw new Error(decision.reason ?? t('tool.forbiddenPath'));
  const label = strArg(call.args, 'label', '').slice(0, 60);
  const snap = await createSnapshot(root, label);
  return t('tool.snapshotCreated', {
    id: snap.id.slice(0, 12),
    n: snap.file_count,
    label: snap.label || t('snapshot.untitled'),
  });
}
