/**
 * Faz 1 — streaming delta birleştirici.
 *
 * SSE her token'da bir olay üretir; her olayda store'a yazmak tüm oturum
 * ağacını kopyalar ve aboneleri uyandırır. Bu yardımcı metni/reasoning'i
 * kısa bir pencerede biriktirip tek yazmaya indirger:
 *
 * - İlk delta geldiğinde `delayMs` sonrası için tek bir zamanlayıcı kurulur
 *   (throttle): saniyede ~25 yazma üst sınırı.
 * - `flush()` bekleyeni hemen yazar (tur sonu, hata, iptal).
 * - `cancel()` bekleyeni atar (temizlik; yazma yapmaz).
 *
 * Sıralama korunur: metin ve reasoning aynı turda birikir, flush'ta metin
 * önce yazılır. Araç olayları gibi sıra değiştiren olaylardan ÖNCE çağıran
 * taraf `flush()` etmelidir.
 */
export interface DeltaBatcher {
  pushText: (delta: string) => void;
  pushReasoning: (delta: string) => void;
  /** Bekleyeni hemen yazar. Boşsa hiçbir şey yapmaz. */
  flush: () => void;
  /** Bekleyeni yazmadan atar. */
  cancel: () => void;
  /** Yazılmayı bekleyen veri var mı? */
  hasPending: () => boolean;
}

export interface DeltaSink {
  (text: string, reasoning: string): void;
}

export const DELTA_FLUSH_MS = 40;

export function createDeltaBatcher(
  sink: DeltaSink,
  delayMs: number = DELTA_FLUSH_MS,
): DeltaBatcher {
  let text = '';
  let reasoning = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (!text && !reasoning) return;
    const nextText = text;
    const nextReasoning = reasoning;
    text = '';
    reasoning = '';
    sink(nextText, nextReasoning);
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delayMs);
  };

  return {
    pushText: (delta) => {
      if (!delta) return;
      text += delta;
      schedule();
    },
    pushReasoning: (delta) => {
      if (!delta) return;
      reasoning += delta;
      schedule();
    },
    flush,
    cancel: () => {
      clearTimer();
      text = '';
      reasoning = '';
    },
    hasPending: () => text.length > 0 || reasoning.length > 0,
  };
}
