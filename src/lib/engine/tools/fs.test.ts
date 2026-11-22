import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../types';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [string])),
}));

import { toolReadFile } from './fs';

const call = (path: string, extra: Record<string, unknown> = {}): ToolCall => ({
  id: 'r1',
  name: 'read_file',
  args: { path, ...extra },
});

describe('read_file output pagination', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('artifact sayfa imlecini modele yapılandırılmış olarak aktarır', async () => {
    invokeMock.mockResolvedValue({
      content: 'first page',
      truncated: true,
      next_offset: 4,
      next_column: 2,
      total_lines: 20,
      artifact: true,
    });

    const out = await toolReadFile(
      '/tmp',
      call('.macrocode/tool-outputs/tool-output-abc.log', { offset: 1, column: 1, limit: 2 }),
    );
    expect(out).toContain('[read_file truncated; next_offset=4; next_column=2; total_lines=20]');
    expect(out).toContain(
      'read_more=read_file(path=".macrocode/tool-outputs/tool-output-abc.log", offset=4, column=2, limit=2)',
    );
    expect(invokeMock).toHaveBeenCalledWith(
      'read_file',
      expect.objectContaining({
        path: '.macrocode/tool-outputs/tool-output-abc.log',
        offset: 1,
        column: 1,
        limit: 2,
      }),
    );
  });

  it('normal dosyada da devam imlecini gösterir', async () => {
    invokeMock.mockResolvedValue({
      content: 'a\nb',
      truncated: true,
      next_offset: 3,
      next_column: null,
      total_lines: 5,
      artifact: false,
    });
    const out = await toolReadFile('/tmp', call('src/a.ts', { limit: 2 }));
    expect(out).toContain('next_offset=3');
    expect(out).toContain('read_more=read_file(path="src/a.ts", offset=3, column=1, limit=2)');
  });

  it('devam imleci olmayan byte sınırlı sayfada yanlış read_more üretmez', async () => {
    invokeMock.mockResolvedValue({
      content: 'partial',
      truncated: true,
      next_offset: null,
      next_column: null,
      total_lines: 5,
      artifact: false,
    });
    const out = await toolReadFile('/tmp', call('src/a.ts', { limit: 2 }));
    expect(out).toContain('read_more=unavailable (file size limit reached)');
    expect(out).not.toContain('read_more=read_file');
  });

  it('dosya içeriği benzer bir marker içerse bile gerçek cursor bilgisini ekler', async () => {
    invokeMock.mockResolvedValue({
      content: '[read_file truncated; next_offset=99]',
      truncated: true,
      next_offset: 4,
      next_column: null,
      total_lines: 8,
      artifact: true,
    });
    const out = await toolReadFile(
      '/tmp',
      call('.macrocode/tool-outputs/tool-output-abc.log', { limit: 2 }),
    );
    expect(out).toContain('[read_file truncated; next_offset=4; total_lines=8]');
    expect(out).toContain(
      'read_more=read_file(path=".macrocode/tool-outputs/tool-output-abc.log", offset=4, column=1, limit=2)',
    );
  });

  it('geçersiz sayfa parametrelerini backend ile aynı aralığa normalize eder', async () => {
    invokeMock.mockResolvedValue({
      content: 'ok',
      truncated: false,
      next_offset: null,
      next_column: null,
      total_lines: 1,
      artifact: false,
    });
    await toolReadFile('/tmp', call('src/a.ts', { limit: -5, offset: -2, column: 0 }));
    expect(invokeMock).toHaveBeenCalledWith(
      'read_file',
      expect.objectContaining({ limit: 1, offset: 1, column: 1 }),
    );
  });
});
