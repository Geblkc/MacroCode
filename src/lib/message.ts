import type { Message } from '../types';

/**
 * Görünür içeriği olmayan asistan mesajı mı?
 *
 * Dikkat: `reasoning`, `thinking` ve `images` de görünür içeriktir. Eskiden
 * yalnızca `content` / `toolCalls` kontrol ediliyordu; reasoning-only bir tur
 * sonunda mesaj "boş" sanılıp siliniyor, kullanıcı hiçbir şey görmüyordu.
 */
export function isBlankAssistantMessage(m: Message | undefined): boolean {
  if (!m || m.role !== 'assistant') return false;
  return (
    m.content.trim() === '' &&
    (m.toolCalls?.length ?? 0) === 0 &&
    (m.images?.length ?? 0) === 0 &&
    !m.reasoning?.trim() &&
    (m.thinking?.length ?? 0) === 0
  );
}
