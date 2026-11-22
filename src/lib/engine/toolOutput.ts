/**
 * Tool çıktıları için tek merkezî context politikası.
 *
 * Modele giden metinler İngilizce ve yapılandırılmıştır; arayüz diliyle
 * bağımsız olmalıdır. UI uyarıları ayrıca i18n katmanından üretilir.
 */
import policyJson from './toolOutputPolicy.json';

export interface ToolOutputPolicy {
  softMaxChars: number;
  headChars: number;
  tailChars: number;
  hardMaxBytes: number;
  hardMaxLines: number;
  summaryMaxChars: number;
}

export const TOOL_OUTPUT_POLICY = policyJson as ToolOutputPolicy;

export interface ToolArtifact {
  /** Dosya adı (uzantı hariç). */
  id: string;
  /** Workspace-relative artifact yolu. */
  path: string;
  /** UTF-8 bayt sayısı. */
  bytes: number;
  /** Satır sayısı. */
  lines: number;
  /** Deterministik, kısa özet. */
  summary: string;
}

export type ToolOutputMode = 'small' | 'medium' | 'hard';

export interface PreparedToolOutput {
  /** Provider'a gönderilecek metin. */
  text: string;
  mode: ToolOutputMode;
  artifact?: ToolArtifact;
}

export type ToolOutputStore = (root: string, content: string) => Promise<ToolArtifact>;

const TOOL_OUTPUT_DIR = '.macrocode/tool-outputs';
const TOOL_OUTPUT_NAME_RE = /^tool-output-[a-zA-Z0-9_-]+\.log$/;
const TOOL_OUTPUT_PREFIX = 'tool-output-';
const TOOL_OUTPUT_MAX_STEM_CHARS = 128;

/** Unicode scalar değer sayısı (JS `.length` UTF-16 birim sayar). */
export function toolOutputCharCount(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** UTF-8 bayt sayısı. */
export function toolOutputByteCount(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Satır sayısı: Sonda newline yoksa son satır da sayılır. */
export function toolOutputLineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return text.charCodeAt(text.length - 1) === 10 ? count : count + 1;
}

function takeCodePoints(text: string, max: number): string {
  if (max <= 0) return '';
  let count = 0;
  let out = '';
  for (const ch of text) {
    if (count >= max) break;
    out += ch;
    count++;
  }
  return out;
}

function takeLastCodePoints(text: string, max: number): string {
  if (max <= 0) return '';
  // Sabit boyutlu ring buffer: büyük çıktılarda `shift()` maliyeti oluşturmasın.
  const points: string[] = [];
  let next = 0;
  for (const ch of text) {
    if (points.length < max) {
      points.push(ch);
      continue;
    }
    points[next] = ch;
    next = (next + 1) % max;
  }
  if (points.length < max || next === 0) return points.join('');
  return [...points.slice(next), ...points.slice(0, next)].join('');
}

/** Bir metin aralığını tek satıra indirger; devasa satırları kopyalamaz. */
function oneLineRange(text: string, start: number, end: number, max: number): string {
  if (max <= 0) return '';
  let out = '';
  let count = 0;
  let pendingSpace = false;
  let seenContent = false;
  let overflow = false;

  for (let index = start; index < end;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const ch = String.fromCodePoint(codePoint);
    index += ch.length;

    if (/\s/u.test(ch)) {
      if (seenContent) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      if (count >= max) {
        overflow = true;
        break;
      }
      out += ' ';
      count += 1;
      pendingSpace = false;
    }
    if (count >= max) {
      overflow = true;
      break;
    }
    out += ch;
    count += 1;
    seenContent = true;
  }

  if (!overflow) return out;
  return `${[...out].slice(0, max - 1).join('')}…`;
}

function oneLine(text: string, max: number): string {
  return oneLineRange(text, 0, text.length, max);
}

/** Rust tarafının ürettiği güvenli artifact adı. */
export function createToolOutputName(): string {
  try {
    const c = globalThis.crypto as unknown as { randomUUID?: () => string } | undefined;
    if (c?.randomUUID) return `tool-output-${c.randomUUID()}.log`;
  } catch {
    // Aşağıdaki fallback'e düşer.
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `tool-output-${id}.log`;
}

/**
 * Yalnızca MacroCode'un yönettiği artifact yolları `read_file` ile okunabilir.
 * Workspace içindeki diğer `.macrocode` dosyaları kapalı kalır.
 */
export function isToolOutputPath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, '/');
  const prefix = `${TOOL_OUTPUT_DIR}/`;
  if (!normalized.startsWith(prefix)) return false;
  const name = normalized.slice(prefix.length);
  if (!TOOL_OUTPUT_NAME_RE.test(name)) return false;
  const stem = name.slice(0, -'.log'.length);
  return stem.length > TOOL_OUTPUT_PREFIX.length && stem.length <= TOOL_OUTPUT_MAX_STEM_CHARS;
}

export function toolOutputArtifactPath(name: string): string {
  return `${TOOL_OUTPUT_DIR}/${name}`;
}

/** Tam çıktıyı Rust backend'inin güvenli artifact klasörüne yazar. */
export async function storeToolOutput(root: string, content: string): Promise<ToolArtifact> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error("tool output artifact store yalnızca Tauri'de çalışır");
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ToolArtifact>('store_tool_output', {
    root,
    name: createToolOutputName(),
    content,
  });
}

function mediumText(raw: string, artifact: ToolArtifact): string {
  const total = toolOutputCharCount(raw);
  const head = takeCodePoints(raw, TOOL_OUTPUT_POLICY.headChars);
  const tail = takeLastCodePoints(raw, TOOL_OUTPUT_POLICY.tailChars);
  const omitted = Math.max(0, total - toolOutputCharCount(head) - toolOutputCharCount(tail));
  return [
    '[tool output truncated; middle omitted]',
    head,
    `[... ${omitted} characters omitted; full output at ${artifact.path} (${artifact.bytes} bytes, ${artifact.lines} lines) ...]`,
    tail,
    `read_more=read_file(path="${artifact.path}", offset=1, limit=200)`,
  ].join('\n');
}

function hardText(artifact: ToolArtifact): string {
  return [
    '[tool output redirected to file; content omitted]',
    `path=${artifact.path}`,
    `bytes=${artifact.bytes}`,
    `lines=${artifact.lines}`,
    `summary=${oneLine(artifact.summary || 'Output is empty.', TOOL_OUTPUT_POLICY.summaryMaxChars)}`,
    `read_more=read_file(path="${artifact.path}", offset=1, limit=200)`,
  ].join('\n');
}

function mediumWithoutArtifact(raw: string, reason: string): string {
  const total = toolOutputCharCount(raw);
  const head = takeCodePoints(raw, TOOL_OUTPUT_POLICY.headChars);
  const tail = takeLastCodePoints(raw, TOOL_OUTPUT_POLICY.tailChars);
  const omitted = Math.max(0, total - toolOutputCharCount(head) - toolOutputCharCount(tail));
  return [
    '[tool output truncated; middle omitted; full-output file could not be stored]',
    head,
    `[... ${omitted} characters omitted ...]`,
    tail,
    `artifact_error=${oneLine(reason, 300)}`,
  ].join('\n');
}

function hardWithoutArtifact(raw: string, reason: string): string {
  // Hard fallback de ham içerik sızdırmaz. Rust exec fallback ile aynı
  // sözleşmede yalnızca ölçüler ve artifact hatası bulunur; ilk/son ham
  // satırlar özet olarak bile modele verilmez.
  return [
    '[tool output redirected to file could not be created; content omitted]',
    `bytes=${toolOutputByteCount(raw)}`,
    `lines=${toolOutputLineCount(raw)}`,
    'summary=Output exceeded hard limit; artifact could not be written.',
    `artifact_error=${oneLine(reason, 300)}`,
  ].join('\n');
}

/**
 * Ham tool çıktısını provider context'ine uygun hale getirir.
 *
 * - ≤ soft limit: içerik birebir korunur.
 * - Orta: head + tail + artifact.
 * - Hard: yalnızca artifact path/ölçü/özet.
 */
export async function prepareToolOutput(
  root: string,
  raw: string,
  store: ToolOutputStore = storeToolOutput,
): Promise<PreparedToolOutput> {
  // Hard sınır soft sınırdan önce uygulanır; böylece hard ölçümü her zaman
  // ham içeriğin gönderilip gönderilmeyeceğine karar verir.
  const chars = toolOutputCharCount(raw);
  const bytes = toolOutputByteCount(raw);
  const lines = toolOutputLineCount(raw);
  const hard = bytes > TOOL_OUTPUT_POLICY.hardMaxBytes || lines >= TOOL_OUTPUT_POLICY.hardMaxLines;

  if (!hard && chars <= TOOL_OUTPUT_POLICY.softMaxChars) {
    return { text: raw, mode: 'small' };
  }

  let artifact: ToolArtifact;
  try {
    artifact = await store(root, raw);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      text: hard ? hardWithoutArtifact(raw, reason) : mediumWithoutArtifact(raw, reason),
      mode: hard ? 'hard' : 'medium',
    };
  }

  return {
    text: hard ? hardText(artifact) : mediumText(raw, artifact),
    mode: hard ? 'hard' : 'medium',
    artifact,
  };
}
