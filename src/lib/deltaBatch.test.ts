import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeltaBatcher } from './deltaBatch';

describe('Faz 1 — delta birleştirici', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pencerede biriken deltaları tek yazmada birleştirir', () => {
    const sink = vi.fn();
    const b = createDeltaBatcher(sink, 40);

    b.pushText('mer');
    b.pushText('haba');
    b.pushReasoning('düşün');
    expect(sink).not.toHaveBeenCalled();

    vi.advanceTimersByTime(39);
    expect(sink).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('merhaba', 'düşün');
    expect(b.hasPending()).toBe(false);
  });

  it('throttle: akış sürerken pencere başına bir yazma', () => {
    const sink = vi.fn();
    const b = createDeltaBatcher(sink, 40);

    for (let i = 0; i < 20; i++) {
      b.pushText('x');
      vi.advanceTimersByTime(10);
    }
    // 200 ms / 40 ms = 5 pencere
    expect(sink).toHaveBeenCalledTimes(5);

    b.pushText('y');
    b.flush();
    expect(sink).toHaveBeenCalledTimes(6);
    expect(sink).toHaveBeenLastCalledWith('y', '');
  });

  it('flush bekleyeni hemen yazar ve zamanlayıcıyı iptal eder', () => {
    const sink = vi.fn();
    const b = createDeltaBatcher(sink, 40);
    b.pushText('a');
    b.flush();
    expect(sink).toHaveBeenCalledWith('a', '');
    vi.advanceTimersByTime(100);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('flush boşsa sink çağrılmaz', () => {
    const sink = vi.fn();
    const b = createDeltaBatcher(sink, 40);
    b.flush();
    b.pushText('');
    b.pushReasoning('');
    b.flush();
    expect(sink).not.toHaveBeenCalled();
  });

  it('cancel bekleyeni yazmadan atar', () => {
    const sink = vi.fn();
    const b = createDeltaBatcher(sink, 40);
    b.pushText('taslak');
    expect(b.hasPending()).toBe(true);
    b.cancel();
    expect(b.hasPending()).toBe(false);
    vi.advanceTimersByTime(100);
    expect(sink).not.toHaveBeenCalled();
  });
});
