/**
 * Sohbet zaman çizelgesi — mesajlar, araç kartları ve geçici satırları
 * (hata/uyarı/bilgi) tek kronolojik listede birleştirir.
 *
 * Neden ayrı bir yardımcı?
 * - `Terminal` önceden önce tüm mesajları, sonra tüm `extras` satırlarını
 *   basıyordu → araç kartları, okunan dosyalar ve hatalar hep en altta
 *   kalıyordu. Son AI cevabı da onların üstünde görünüyordu.
 * - Araç sonuçları oturumda `system` mesajı olarak durur. Bu satırlar ham
 *   `///` çıktısı olarak basılmak yerine ilgili kartla birleştirilir; böylece
 *   uygulama yeniden başladığında da kartlar doğru yerde görünür.
 *
 * Saf fonksiyon: React/store bağımlılığı yok (test edilebilir).
 */
import type { ExtraLine, Message, ToolEvent } from '../types';
import { previewArgs, toolTarget } from './engine/toolPreview';

export type TimelineItem =
  | { kind: 'message'; key: string; ts: number; seq: number; message: Message }
  | { kind: 'tool'; key: string; ts: number; seq: number; tool: ToolEvent }
  | { kind: 'extra'; key: string; ts: number; seq: number; extra: ExtraLine };

export interface TimelineInput {
  messages: Message[];
  extras: ExtraLine[];
  /** Bu andan önceki mesajlar gizlenir (/clear). */
  clearedBefore?: number | null;
}

/** Eşit zaman damgalarında mesaj → araç kartı → geçici satır sırası korunur. */
const KIND_ORDER: Record<TimelineItem['kind'], number> = {
  message: 0,
  tool: 1,
  extra: 2,
};

function toolKey(id: string): string {
  return `tool-${id}`;
}

/**
 * Aynı araç id'si tek kartta birleşir. Sonradan gelen bilgi (sonuç, canlı
 * çıktı) mevcut alanları EZMEZ; yalnızca dolu değerler günceller.
 *
 * Önemli kural: **bitmiş durum geri alınmaz**. Mesajlardan gelen sonuç
 * ("ok"/"err") ile extras'taki eski çağrı satırı ("run") birleşirse kart
 * "çalışıyor"da takılıp kalmaz; extras cap'i eski satırları attığında da
 * kart doğru durumda görünür.
 */
function mergeTool(prev: ToolEvent, next: ToolEvent): ToolEvent {
  const keepFinal = next.status === 'run' && prev.status !== 'run';
  const merged: ToolEvent = {
    ...prev,
    ...next,
    args: next.args || prev.args,
    target: next.target || prev.target,
    output: next.output ?? prev.output,
  };
  if (keepFinal) {
    merged.status = prev.status;
    merged.output = prev.output;
  }
  return merged;
}

export function buildTimeline({ messages, extras, clearedBefore }: TimelineInput): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, TimelineItem & { kind: 'tool' }>();
  /** Araç çağrısının yapıldığı an (süre ölçümü ve yerleşim için). */
  const starts = new Map<string, number>();
  let seq = 0;

  const upsertTool = (tool: ToolEvent, ts: number, isCall = false) => {
    const key = toolKey(tool.id);
    const existing = tools.get(key);
    if (existing) {
      existing.ts = Math.min(existing.ts, ts);
      existing.tool = mergeTool(existing.tool, tool);
    } else {
      const item: TimelineItem & { kind: 'tool' } = {
        kind: 'tool',
        key,
        ts,
        seq: seq++,
        tool,
      };
      tools.set(key, item);
      items.push(item);
    }
    if (isCall && !starts.has(key)) starts.set(key, ts);
    // Süre: sonuç geldiğinde çağrı anından ölçülür.
    const item = tools.get(key)!;
    const start = starts.get(key);
    if (
      item.tool.ms === undefined &&
      item.tool.status !== 'run' &&
      start !== undefined &&
      ts > start
    ) {
      item.tool = { ...item.tool, ms: ts - start };
    }
  };

  for (const m of messages) {
    if (clearedBefore != null && m.timestamp < clearedBefore) continue;

    // Araç sonucu (system + toolCallId) ham satır olarak gösterilmez.
    if (m.role === 'system' && m.toolCallId) {
      const name = m.toolName ?? 'tool';
      upsertTool(
        {
          id: m.toolCallId,
          name,
          args: '',
          status: m.isError ? 'err' : 'ok',
          output: m.content,
        },
        m.timestamp,
      );
      continue;
    }

    // Assistant mesajındaki çağrılar kart olarak, metnin hemen ardından gelir.
    items.push({ kind: 'message', key: m.id, ts: m.timestamp, seq: seq++, message: m });
    for (const call of m.toolCalls ?? []) {
      const callTs = call.ts ?? m.timestamp;
      upsertTool(
        {
          id: call.id,
          name: String(call.name),
          args: previewArgs(call.args),
          target: toolTarget(String(call.name), call.args),
          status: 'run',
        },
        callTs,
        true,
      );
    }
  }

  for (const e of extras) {
    if (clearedBefore != null && e.ts < clearedBefore) continue;
    if (e.tool) {
      upsertTool(e.tool, e.ts);
      continue;
    }
    items.push({ kind: 'extra', key: e.id, ts: e.ts, seq: seq++, extra: e });
  }

  return items.sort(
    (a, b) => a.ts - b.ts || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.seq - b.seq,
  );
}
