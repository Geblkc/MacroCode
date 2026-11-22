import { describe, expect, it } from 'vitest';
import { isDatabaseBusyError } from './dbErrors';

describe('SQLite hata yardımcıları', () => {
  it('SQLITE_BUSY / database locked mesajlarını tanır', () => {
    expect(isDatabaseBusyError(new Error('database is locked'))).toBe(true);
    expect(isDatabaseBusyError(new Error('SQLITE_BUSY: database table is locked'))).toBe(true);
    expect(isDatabaseBusyError(new Error('error returned from database: (code: 5)'))).toBe(true);
  });

  it('ilgisiz hataları kilit sanmaz', () => {
    expect(isDatabaseBusyError(new Error('syntax error'))).toBe(false);
    expect(isDatabaseBusyError('database is locked')).toBe(true);
  });
});
