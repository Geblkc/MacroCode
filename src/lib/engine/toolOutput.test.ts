import { describe, expect, it } from 'vitest';
import {
  TOOL_OUTPUT_POLICY,
  isToolOutputPath,
  prepareToolOutput,
  toolOutputByteCount,
  toolOutputCharCount,
  toolOutputLineCount,
  type ToolArtifact,
} from './toolOutput';

function artifact(path = '.macrocode/tool-outputs/tool-output-test.log'): ToolArtifact {
  return {
    id: 'tool-output-test',
    path,
    bytes: 20_000,
    lines: 300,
    summary: 'First line: start Last line: end',
  };
}

describe('tool output policy', () => {
  it('12.000 karaktere kadar çıktıyı değiştirmeden geçirir', async () => {
    const raw = 'x'.repeat(TOOL_OUTPUT_POLICY.softMaxChars);
    const out = await prepareToolOutput('/tmp', raw, async () => artifact());
    expect(out.mode).toBe('small');
    expect(out.text).toBe(raw);
  });

  it('12.001 karakteri medium sınıfına geçirir', async () => {
    const raw = 'x'.repeat(TOOL_OUTPUT_POLICY.softMaxChars + 1);
    const out = await prepareToolOutput('/tmp', raw, async () => artifact());
    expect(out.mode).toBe('medium');
    expect(out.text).toContain('[tool output truncated; middle omitted]');
  });

  it('orta çıktıda ilk 4.000 ve son 2.000 karakteri korur, ortayı atlar', async () => {
    const raw = `${'A'.repeat(4_000)}${'M'.repeat(6_001)}${'Z'.repeat(2_000)}`;
    let stored = '';
    const out = await prepareToolOutput('/tmp', raw, async (_root, content) => {
      stored = content;
      return artifact();
    });
    expect(out.mode).toBe('medium');
    expect(stored).toBe(raw);
    expect(out.text).toContain('A'.repeat(4_000));
    expect(out.text).toContain('Z'.repeat(2_000));
    expect(out.text).not.toContain('M'.repeat(100));
    expect(out.text).toContain('[tool output truncated; middle omitted]');
    expect(out.text).toContain('read_more=read_file');
  });

  it('orta çıktıda Unicode head/tail sınırını bozmadan korur', async () => {
    const head = `${'A'.repeat(3_999)}😀`;
    const tail = `Z${'😀'.repeat(1_999)}`;
    const middle = 'M'.repeat(6_001);
    const out = await prepareToolOutput('/tmp', `${head}${middle}${tail}`, async () => artifact());
    expect(out.mode).toBe('medium');
    expect(out.text).toContain(head);
    expect(out.text).toContain(tail);
    expect(out.text).not.toContain('M'.repeat(100));
  });

  it('hard çıktıda modele ham içerik parçası göndermez', async () => {
    const raw = 'Q'.repeat(TOOL_OUTPUT_POLICY.hardMaxBytes + 1);
    const out = await prepareToolOutput('/tmp', raw, async () => artifact());
    expect(out.mode).toBe('hard');
    expect(out.text).toContain('path=.macrocode/tool-outputs/tool-output-test.log');
    expect(out.text).toContain('bytes=20000');
    expect(out.text).toContain('lines=300');
    expect(out.text).toContain('summary=');
    expect(out.text).toContain('read_more=read_file');
    expect(out.text).not.toContain('Q'.repeat(100));
  });

  it('hard byte sınırının hemen üstünü hard yapar', async () => {
    const exact = 'B'.repeat(TOOL_OUTPUT_POLICY.hardMaxBytes);
    const over = 'B'.repeat(TOOL_OUTPUT_POLICY.hardMaxBytes + 1);
    expect(toolOutputByteCount(exact)).toBe(TOOL_OUTPUT_POLICY.hardMaxBytes);
    const exactOut = await prepareToolOutput('/tmp', exact, async () => artifact());
    const overOut = await prepareToolOutput('/tmp', over, async () => artifact());
    expect(exactOut.mode).toBe('medium');
    expect(overOut.mode).toBe('hard');
  });

  it('hard satır sınırında çok satırlı çıktıyı hard yapar', async () => {
    const below = Array.from({ length: TOOL_OUTPUT_POLICY.hardMaxLines - 1 }, () => 'line').join(
      '\n',
    );
    const atLimit = Array.from({ length: TOOL_OUTPUT_POLICY.hardMaxLines }, () => 'line').join(
      '\n',
    );
    expect(toolOutputLineCount(below)).toBe(TOOL_OUTPUT_POLICY.hardMaxLines - 1);
    expect(toolOutputLineCount(atLimit)).toBe(TOOL_OUTPUT_POLICY.hardMaxLines);
    const belowOut = await prepareToolOutput('/tmp', below, async () => artifact());
    const limitOut = await prepareToolOutput('/tmp', atLimit, async () => artifact());
    expect(belowOut.mode).toBe('medium');
    expect(limitOut.mode).toBe('hard');
  });

  it('artifact yazılamazsa medium çıktıda head/tail ve hata açıklaması bırakır', async () => {
    const raw = `${'A'.repeat(4_000)}${'M'.repeat(6_001)}${'Z'.repeat(2_000)}`;
    const out = await prepareToolOutput('/tmp', raw, async () => {
      throw new Error('disk full');
    });
    expect(out.mode).toBe('medium');
    expect(out.text).toContain('A'.repeat(4_000));
    expect(out.text).toContain('Z'.repeat(2_000));
    expect(out.text).toContain('artifact_error=disk full');
    expect(out.text).not.toContain('M'.repeat(100));
  });

  it('artifact yazılamazsa hard çıktı yine de ham gövdeyi modele göndermez', async () => {
    const raw = 'Q'.repeat(TOOL_OUTPUT_POLICY.hardMaxBytes + 1);
    const out = await prepareToolOutput('/tmp', raw, async () => {
      throw new Error('disk full');
    });
    expect(out.mode).toBe('hard');
    expect(out.text).toContain('artifact_error=disk full');
    expect(out.text).toContain('bytes=131073');
    expect(out.text).not.toContain('Q'.repeat(1_000));
  });

  it('hard artifact hatasında ilk/son ham satırlar bile summary içinde sızmaz', async () => {
    const raw = `FIRST_RAW_SENTINEL\n${'Q'.repeat(TOOL_OUTPUT_POLICY.hardMaxBytes)}\nLAST_RAW_SENTINEL`;
    const out = await prepareToolOutput('/tmp', raw, async () => {
      throw new Error('disk full');
    });
    expect(out.mode).toBe('hard');
    expect(out.text).not.toContain('FIRST_RAW_SENTINEL');
    expect(out.text).not.toContain('LAST_RAW_SENTINEL');
    expect(out.text).toContain('summary=Output exceeded hard limit');
  });

  it('Unicode karakterleri bozmadan karakter sayar', () => {
    expect(toolOutputCharCount('😀a')).toBe(2);
  });

  it('yalnızca yönetilen artifact yollarını read_file için kabul eder', () => {
    expect(isToolOutputPath('.macrocode/tool-outputs/tool-output-abc.log')).toBe(true);
    expect(isToolOutputPath('.macrocode/context.md')).toBe(false);
    expect(isToolOutputPath('.macrocode/tool-outputs/other.log')).toBe(false);
    expect(isToolOutputPath('.macrocode/tool-outputs/tool-output-.log')).toBe(false);
    expect(isToolOutputPath(`../outside.log`)).toBe(false);
    expect(isToolOutputPath(`.macrocode/tool-outputs/tool-output-${'x'.repeat(129)}.log`)).toBe(
      false,
    );
  });
});
