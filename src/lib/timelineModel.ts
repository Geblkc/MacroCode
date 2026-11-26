/**
 * Faz 3 — zaman çizelgesi önbelleği.
 *
 * Terminal her akış deltasında yeniden render olur. `buildTimelineBase`
 * mesajların tamamını (araç kartları + süreler) yeniden kurduğu için bu iş
 * saniyede onlarca kez tekrarlanıyordu.
 *
 * Tipik durum: mesaj dizisinin **son elemanı** içerik olarak değişir
 * (`updateLastMessage` / `appendToMessage`), önceki mesaj nesneleri aynı
 * referansta kalır ve `toolCalls` değişmez. Bu durumda iskeletin son mesaj
 * satırı kopyalanır, gerisi yeniden kullanılır — O(1) güncelleme.
 *
 * Yapısal değişimlerde (yeni mesaj, araç çağrısı, compaction, oturum değişimi)
 * iskelet sıfırdan kurulur; ViewLine önbelleği sayesinde değişmeyen mesajların
 * markdown'ı yine de yeniden üretilmez.
 *
 * Saf sınıf: React/store bağımlılığı yok (test edilebilir).
 */
import type { ExtraLine, Message } from '../types';
import { buildTimelineBase, mergeTimeline, type TimelineBase, type TimelineItem } from './timeline';

export interface TimelineModelInput {
  messages: Message[];
  extras: ExtraLine[];
  clearedBefore?: number | null;
}

export interface TimelineModel {
  build: (input: TimelineModelInput) => TimelineItem[];
  reset: () => void;
}

type MessageItem = Extract<TimelineItem, { kind: 'message' }>;

function lastMessageItem(base: TimelineBase): { index: number; id: string | null } {
  for (let i = base.items.length - 1; i >= 0; i--) {
    const item = base.items[i];
    if (item.kind === 'message') return { index: i, id: item.message.id };
  }
  return { index: -1, id: null };
}

/** `[0, count)` aralığında iki dizinin mesaj referansları aynı mı? */
function samePrefix(a: Message[], b: Message[], count: number): boolean {
  if (count > a.length || count > b.length) return false;
  for (let i = 0; i < count; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function visibleCount(messages: Message[], cleared: number | null): number {
  if (cleared == null) return messages.length;
  let n = 0;
  for (const m of messages) if (m.timestamp >= cleared) n++;
  return n;
}

export function createTimelineModel(): TimelineModel {
  let prevMessages: Message[] | null = null;
  let prevCleared: number | null = null;
  let prevVisible = 0;
  let prevBase: TimelineBase | null = null;
  let prevLastIndex = -1;
  let prevLastItemId: string | null = null;

  const reset = () => {
    prevMessages = null;
    prevCleared = null;
    prevVisible = 0;
    prevBase = null;
    prevLastIndex = -1;
    prevLastItemId = null;
  };

  const build = ({ messages, extras, clearedBefore }: TimelineModelInput): TimelineItem[] => {
    const cleared = clearedBefore ?? null;
    const n = messages.length;
    const newLast = n > 0 ? messages[n - 1] : null;
    const visible = visibleCount(messages, cleared);

    const canFastPath =
      prevBase !== null &&
      prevMessages !== null &&
      prevCleared === cleared &&
      newLast !== null &&
      n > 0 &&
      n === prevMessages.length &&
      visible === prevVisible &&
      newLast.id === prevLastItemId &&
      newLast.toolCalls === prevMessages[n - 1].toolCalls &&
      samePrefix(messages, prevMessages, n - 1) &&
      prevBase.items[prevLastIndex]?.kind === 'message';

    let base: TimelineBase;
    if (canFastPath && prevBase) {
      const items = prevBase.items.slice();
      const old = items[prevLastIndex] as MessageItem;
      // Son mesaj satırı kopyalanır; araç kartları (toolCalls değişmediği
      // için) yerinde kalır. `seq` korunur → eşit zaman damgalarında sıra
      // değişmez.
      items[prevLastIndex] = { ...old, ts: newLast!.timestamp, message: newLast! };
      base = { items, starts: prevBase.starts, seq: prevBase.seq };
    } else {
      base = buildTimelineBase({ messages, clearedBefore });
    }

    const last = lastMessageItem(base);
    prevBase = base;
    prevMessages = messages;
    prevCleared = cleared;
    prevVisible = visible;
    prevLastIndex = last.index;
    prevLastItemId = last.id;

    return mergeTimeline(base, extras, clearedBefore);
  };

  return { build, reset };
}
