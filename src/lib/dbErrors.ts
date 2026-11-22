/** SQLite/DB hata yardımcıları. */

/** Hata nesnesinden güvenli mesaj çıkarır. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/**
 * SQLite'ın geçici yazma kilidi hatalarını tanır.
 *
 * SQLx hata metni farklı sürümlerde `database is locked`,
 * `SQLITE_BUSY` veya `(code: 5)` biçiminde gelebilir. Bu hata
 * kalıcı bir veri hatası değildir; kısa bir bekleme/yeniden deneme
 * ile çözülebilir.
 */
export function isDatabaseBusyError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('database is locked') ||
    message.includes('sqlite_busy') ||
    message.includes('sqlite_locked') ||
    message.includes('database table is locked') ||
    /\(code:\s*5\)/.test(message) ||
    /\(code:\s*6\)/.test(message)
  );
}
