/**
 * Faz D — Güvenli yazma: önizleme + onaylı uygulama.
 * Doğrudan overwrite API'si yok; akış: propose -> preview -> approve -> apply.
 */
import { strArg } from '../toolspec';
import type { PendingPatch, ToolCall } from '../types';
import { createToolCallId } from '../types';
import { decideTool } from '../policy';
import { t } from '../../i18n/core';

const pending = new Map<string, PendingPatch>();

/** Basit satır diff'i: ortak prefix/suffix kırp, ortayı -/+ olarak göster. */
export function makePreview(path: string, oldText: string, newText: string): string {
  const a = oldText.replace(/\r\n/g, '\n').split('\n');
  const b = newText.replace(/\r\n/g, '\n').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const rem = a.slice(pre, a.length - suf);
  const add = b.slice(pre, b.length - suf);
  const head = [`--- ${path} (önizleme)`, `@@ -${pre + 1},${rem.length} +${pre + 1},${add.length} @@`];
  const show = (lines: string[], sign: string) =>
    lines.slice(0, 40).map((l) => `${sign} ${l.slice(0, 240)}`);
  const out = [...head, ...show(rem, '-'), ...show(add, '+')];
  if (rem.length > 40 || add.length > 40) out.push('…[diff kesildi]');
  if (rem.length === 0 && add.length === 0) out.push(t('tool.noChange'));
  return out.join('\n');
}

export function proposePatch(
  path: string,
  newContent: string,
  oldContent = '',
  root = '',
): PendingPatch {
  const p: PendingPatch = {
    id: createToolCallId(),
    path,
    content: newContent,
    preview: makePreview(path, oldContent, newContent),
    createdAt: Date.now(),
    ...(root ? { root } : {}),
  };
  pending.set(p.id, p);
  // Bellek şişmesin: en fazla 10 bekleyen.
  while (pending.size > 10) {
    const first = pending.keys().next().value;
    if (!first) break;
    pending.delete(first);
  }
  return p;
}

export function listPending(): PendingPatch[] {
  return [...pending.values()];
}

export function takePending(id: string): PendingPatch | undefined {
  const p = pending.get(id);
  if (p) pending.delete(id);
  return p;
}

export function clearPending(): void {
  pending.clear();
}

async function invokeRust<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  throw new Error(`${cmd} yalnızca Tauri'de çalışır`);
}

/**
 * Esnek ve çok kademeli arama-değiştirme motoru (toleranslı hunk eşleme).
 *
 * 1. Kademe: Birebir tam eşleşme (exact match).
 * 2. Kademe: Satır sonu uyumluluğu (\r\n CRLF ve \n LF farklarını tolere eder).
 * 3. Kademe: Satır sonu boşluk toleransı (trailing whitespace).
 * 4. Kademe: Girinti (indentation) ve tam satır trim toleransı (orijinal girinti korunur).
 */
export function applySearchReplace(
  oldText: string,
  search: string,
  replace: string,
  path: string,
): string {
  // 1. Kademe: Birebir eşleşme (hızlı yol)
  const exactOccurrences = oldText.split(search).length - 1;
  if (exactOccurrences === 1) {
    return oldText.replace(search, replace);
  }
  if (exactOccurrences > 1) {
    throw new Error(
      `aranılan kod bloğu ${path} içinde birden fazla kez (${exactOccurrences}) geçiyor. Daha fazla çevreleyen satır ekleyerek tekilleştir.`,
    );
  }

  // 2. Kademe: Satır sonu uyumluluğu (\r\n vs \n)
  const usesCrlf = oldText.includes('\r\n');
  const normOld = oldText.replace(/\r\n/g, '\n');
  const normSearch = search.replace(/\r\n/g, '\n');
  const normReplace = replace.replace(/\r\n/g, '\n');

  const crlfOccurrences = normOld.split(normSearch).length - 1;
  if (crlfOccurrences === 1) {
    const replaced = normOld.replace(normSearch, normReplace);
    return usesCrlf ? replaced.replace(/\n/g, '\r\n') : replaced;
  }
  if (crlfOccurrences > 1) {
    throw new Error(
      `aranılan kod bloğu ${path} içinde birden fazla kez (${crlfOccurrences}) geçiyor. Daha fazla çevreleyen satır ekleyerek tekilleştir.`,
    );
  }

  // 3. Kademe: Satır sonu boşluk toleransı (trailing whitespace tolerance)
  const oldLines = normOld.split('\n');
  const searchLines = normSearch.split('\n');

  if (searchLines.length <= oldLines.length) {
    const trimEndMatches: number[] = [];
    for (let i = 0; i <= oldLines.length - searchLines.length; i++) {
      let matched = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (oldLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
          matched = false;
          break;
        }
      }
      if (matched) trimEndMatches.push(i);
    }

    if (trimEndMatches.length === 1) {
      const startLine = trimEndMatches[0];
      const endLine = startLine + searchLines.length;
      const replaceLines = normReplace.split('\n');
      const newLines = [
        ...oldLines.slice(0, startLine),
        ...replaceLines,
        ...oldLines.slice(endLine),
      ];
      const replaced = newLines.join('\n');
      return usesCrlf ? replaced.replace(/\n/g, '\r\n') : replaced;
    }
    if (trimEndMatches.length > 1) {
      throw new Error(
        `aranılan kod bloğu ${path} içinde birden fazla kez (${trimEndMatches.length}) geçiyor. Daha fazla çevreleyen satır ekleyerek tekilleştir.`,
      );
    }

    // 4. Kademe: Girinti (indentation) ve tam trim toleransı
    const fullTrimMatches: number[] = [];
    for (let i = 0; i <= oldLines.length - searchLines.length; i++) {
      let matched = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (oldLines[i + j].trim() !== searchLines[j].trim()) {
          matched = false;
          break;
        }
      }
      if (matched) fullTrimMatches.push(i);
    }

    if (fullTrimMatches.length === 1) {
      const startLine = fullTrimMatches[0];
      const endLine = startLine + searchLines.length;

      // Dosyadaki ve aramadaki ilk dolu satırın girintisini tespit et
      let targetIndent = '';
      let searchIndent = '';
      for (let j = 0; j < searchLines.length; j++) {
        if (searchLines[j].trim().length > 0) {
          targetIndent = oldLines[startLine + j].match(/^(\s*)/)?.[1] ?? '';
          searchIndent = searchLines[j].match(/^(\s*)/)?.[1] ?? '';
          break;
        }
      }

      // Yeni satırları dosyanın girinti seviyesine göre uyarla
      const replaceLines = normReplace.split('\n').map((line) => {
        if (!line.trim()) return line;
        if (searchIndent && line.startsWith(searchIndent)) {
          return targetIndent + line.slice(searchIndent.length);
        }
        return line;
      });

      const newLines = [
        ...oldLines.slice(0, startLine),
        ...replaceLines,
        ...oldLines.slice(endLine),
      ];
      const replaced = newLines.join('\n');
      return usesCrlf ? replaced.replace(/\n/g, '\r\n') : replaced;
    }
    if (fullTrimMatches.length > 1) {
      throw new Error(
        `aranılan kod bloğu ${path} içinde birden fazla kez (${fullTrimMatches.length}) geçiyor. Daha fazla çevreleyen satır ekleyerek tekilleştir.`,
      );
    }
  }

  // Hiçbir kademede eşleşme bulunamadı
  throw new Error(
    `aranılan kod bloğu ${path} içinde bulunamadı. Lütfen read_file ile güncel içeriği kontrol et.`,
  );
}

/**
 * Dosya içeriğini diskten güvenli ve tam (kesilmeden, 1MB'a kadar) okur.
 */
async function readOldFileSafe(
  root: string,
  path: string,
  readOld?: (path: string) => Promise<string>,
): Promise<string> {
  if (readOld) {
    try {
      return await readOld(path);
    } catch {
      return '';
    }
  }
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      // Kesintisiz tam okuyucu (1000+ satırlık büyük dosyaları da eksiksiz okur)
      return await invokeRust<string>('read_file_full', { root, path });
    } catch {
      try {
        const out = await invokeRust<{ content: string; truncated?: boolean }>('read_file', {
          root,
          path,
          limit: 1000,
        });
        return out.content;
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** Tool çağrısı: sadece önizleme üretir, dosyaya dokunmaz. */
export async function toolProposePatch(
  root: string,
  call: ToolCall,
  readOld?: (path: string) => Promise<string>,
): Promise<string> {
  const d = decideTool('propose_patch', call.args, 'manual');
  if (!d.allowed) throw new Error(d.reason ?? t('tool.forbiddenPath'));
  const path = strArg(call.args, 'path', '');
  const content = typeof call.args.content === 'string' ? call.args.content : '';
  if (!path || !content) throw new Error('path ve content gerekli');
  const old = await readOldFileSafe(root, path, readOld);
  const p = proposePatch(path, content, old, root);
  return `${p.preview}\n\n/// onay için: /apply ${p.id}`;
}

/** Blok bazlı düzenleme tool çağrısı (search_replace). */
export async function toolEditFile(
  root: string,
  call: ToolCall,
  readOld?: (path: string) => Promise<string>,
): Promise<string> {
  const d = decideTool('edit_file', call.args, 'manual');
  if (!d.allowed) throw new Error(d.reason ?? t('tool.forbiddenPath'));
  const path = strArg(call.args, 'path', '');
  const search = typeof call.args.search === 'string' ? call.args.search : '';
  const replace = typeof call.args.replace === 'string' ? call.args.replace : '';
  if (!path || !search) throw new Error('path ve search gerekli');

  const old = await readOldFileSafe(root, path, readOld);
  if (!old) {
    throw new Error(`dosya okunamadı veya boş: ${path}`);
  }

  const newContent = applySearchReplace(old, search, replace, path);
  const p = proposePatch(path, newContent, old, root);
  return `${p.preview}\n\n/// onay için: /apply ${p.id}`;
}

/** Onaylanmış patch'i uygular (tek kullanımlık id). */
export async function applyPendingPatch(root: string, id: string): Promise<string> {
  const p = takePending(id);
  if (!p) throw new Error(`bekleyen yama bulunamadı: ${id}`);
  // Faz 10 (D2a): yama başka bir workspace'te üretilmişse uygulanmaz.
  // (Aynı göreli yol yeni kökte farklı bir dosyayı ezebilirdi.)
  if (p.root && root && p.root !== root) {
    throw new Error(
      `yama farklı workspace için: ${p.root} ≠ ${root} · /root değişti, yama iptal`,
    );
  }
  await invokeRust('apply_patch', { root, path: p.path, content: p.content });
  return `/// uygulandı: ${p.path}`;
}

/** Son veya belirtilen yamayı geri alır. */
export async function undoLastPatch(root: string, backupId?: string): Promise<string> {
  return invokeRust<string>('undo_patch', { root, backupId: backupId || null });
}
