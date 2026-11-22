/**
 * Faz C — FS araçları (Tauri invoke wrapper).
 * Tarayıcı-dev'de Rust yoksa açıklayıcı hata döner.
 */
import { strArg } from '../toolspec';
import type { ToolCall } from '../types';
import { decideTool } from '../policy';
import { t } from '../../i18n/core';

export interface DirEntry {
  name: string;
  is_dir: boolean;
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

export async function toolListDir(root: string, call: ToolCall): Promise<string> {
  const d = decideTool('list_dir', call.args, 'manual');
  if (!d.allowed) throw new Error(d.reason ?? t('tool.forbiddenPath'));
  const path = strArg(call.args, 'path', '');
  const entries = await invokeRust<DirEntry[]>('list_dir', { root, path });
  if (entries.length === 0) return t('tool.emptyDir');
  return entries.map((e) => `${e.is_dir ? 'dir  ' : 'file '} ${e.name}`).join('\n');
}

export interface ReadFileResult {
  content: string;
  truncated: boolean;
  next_offset?: number | null;
  next_column?: number | null;
  total_lines?: number | null;
  artifact?: boolean;
}

/**
 * Backend'in yapılandırılmış sayfa bilgisini modele tek bir İngilizce marker
 * olarak aktarır. Ham içerik ayrıca kırpılmaz; ortak output policy bunu
 * daha sonra artifact'a dönüştürür.
 */
function formatReadFileResult(path: string, limit: number, out: ReadFileResult): string {
  if (!out.truncated) return out.content;
  const parts = ['[read_file truncated'];
  if (out.next_offset !== undefined && out.next_offset !== null) {
    parts.push(`next_offset=${out.next_offset}`);
  }
  if (out.next_column !== undefined && out.next_column !== null) {
    parts.push(`next_column=${out.next_column}`);
  }
  if (out.total_lines !== undefined && out.total_lines !== null) {
    parts.push(`total_lines=${out.total_lines}`);
  }
  const marker = `${parts.join('; ')}]`;
  const separator = out.content.length > 0 && !out.content.endsWith('\n') ? '\n' : '';
  const readMore =
    out.next_offset !== undefined && out.next_offset !== null
      ? `read_more=read_file(path=${JSON.stringify(path)}, offset=${out.next_offset}, column=${out.next_column ?? 1}, limit=${limit})`
      : 'read_more=unavailable (file size limit reached)';
  return `${out.content}${separator}${marker}\n${readMore}`;
}

export async function toolReadFile(root: string, call: ToolCall): Promise<string> {
  const d = decideTool('read_file', call.args, 'manual');
  if (!d.allowed) throw new Error(d.reason ?? t('tool.forbiddenPath'));
  const path = strArg(call.args, 'path', '');
  if (!path) throw new Error('path gerekli');
  const limitRaw = call.args.limit;
  const limit =
    typeof limitRaw === 'number' && Number.isFinite(limitRaw)
      ? Math.min(1_000, Math.max(1, Math.floor(limitRaw)))
      : 200;
  const offsetRaw = call.args.offset;
  const offset =
    typeof offsetRaw === 'number' && Number.isFinite(offsetRaw)
      ? Math.max(1, Math.floor(offsetRaw))
      : null;
  const columnRaw = call.args.column;
  const column =
    typeof columnRaw === 'number' && Number.isFinite(columnRaw)
      ? Math.max(1, Math.floor(columnRaw))
      : null;
  const out = await invokeRust<ReadFileResult>('read_file', {
    root,
    path,
    limit,
    ...(offset !== null ? { offset } : {}),
    ...(column !== null ? { column } : {}),
  });
  return formatReadFileResult(path, limit, out);
}

export async function toolGrep(root: string, call: ToolCall): Promise<string> {
  const d = decideTool('grep', call.args, 'manual');
  if (!d.allowed) throw new Error(d.reason ?? t('tool.forbiddenPath'));
  const pattern = strArg(call.args, 'pattern', '');
  if (!pattern) throw new Error('pattern gerekli');
  const path = strArg(call.args, 'path', '');
  const regex = call.args.regex === true;
  const hits = await invokeRust<Array<{ path: string; line: number; text: string }>>('grep_files', {
    root,
    pattern,
    path: path || null,
    ...(regex ? { regex: true } : {}),
  });
  if (hits.length === 0) return t('tool.noMatch');
  return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n');
}

export async function toolGlob(root: string, call: ToolCall): Promise<string> {
  const d = decideTool('glob', call.args, 'manual');
  if (!d.allowed) throw new Error(d.reason ?? t('tool.forbiddenPath'));
  const pattern = strArg(call.args, 'pattern', '');
  if (!pattern) throw new Error('pattern gerekli');
  const path = strArg(call.args, 'path', '');
  const hits = await invokeRust<DirEntry[]>('glob_files', {
    root,
    pattern,
    path: path || null,
  });
  if (hits.length === 0) return t('tool.noMatch');
  return hits.map((e) => `${e.is_dir ? 'dir  ' : 'file '} ${e.name}`).join('\n');
}

export async function runFsTool(root: string, call: ToolCall): Promise<string> {
  if (call.name === 'list_dir') return toolListDir(root, call);
  if (call.name === 'read_file') return toolReadFile(root, call);
  if (call.name === 'grep') return toolGrep(root, call);
  if (call.name === 'glob') return toolGlob(root, call);
  throw new Error(`bilinmeyen fs aracı: ${call.name}`);
}
