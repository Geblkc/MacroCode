import { describe, expect, it } from 'vitest';
import {
  applyPendingPatch,
  applySearchReplace,
  clearPending,
  makePreview,
  proposePatch,
  toolEditFile,
} from './patch';

describe('Faz D — patch', () => {
  it('diff önizleme üretir', () => {
    const p = makePreview('a.ts', 'line1\nline2\nline3', 'line1\nLINE2\nline3');
    expect(p).toContain('- line2');
    expect(p).toContain('+ LINE2');
  });

  it('onaysız uygulama yok: id tek kullanımlık', async () => {
    clearPending();
    const p = proposePatch('a.ts', 'new', 'old');
    // Tarayıcıda Rust yok -> hata vermeli, ama pending durmalı mı?
    // applyPendingPatch önce takePending yapar; Rust hatası olsa da id tükenir.
    await expect(applyPendingPatch('/tmp', p.id)).rejects.toThrow();
    await expect(applyPendingPatch('/tmp', p.id)).rejects.toThrow(/bekleyen yama bulunamadı/);
  });

  it('toolEditFile aranılan bloğu benzersiz bulup değiştirir', async () => {
    clearPending();
    const oldCode = 'function hello() {\n  return 1;\n}\n';
    const preview = await toolEditFile(
      '/tmp',
      {
        id: 'e1',
        name: 'edit_file',
        args: { path: 'test.ts', search: 'return 1;', replace: 'return 2;' },
      },
      async () => oldCode,
    );
    expect(preview).toContain('-   return 1;');
    expect(preview).toContain('+   return 2;');
  });

  it('toolEditFile bulunamayan veya çoklu eşleşen blokta hata verir', async () => {
    clearPending();
    const code = 'const a = 1;\nconst a = 1;\n';
    // Bulunamayan
    await expect(
      toolEditFile(
        '/tmp',
        { id: 'e2', name: 'edit_file', args: { path: 'test.ts', search: 'yok', replace: 'var' } },
        async () => code,
      ),
    ).rejects.toThrow(/bulunamadı/);

    // Birden fazla eşleşen
    await expect(
      toolEditFile(
        '/tmp',
        {
          id: 'e3',
          name: 'edit_file',
          args: { path: 'test.ts', search: 'const a = 1;', replace: 'const b = 2;' },
        },
        async () => code,
      ),
    ).rejects.toThrow(/birden fazla kez/);
  });

  it('1000+ satırlık büyük dosyalarda kesilme olmadan düzenleme yapar', async () => {
    clearPending();
    const lines = Array.from({ length: 1200 }, (_, i) => `const x_${i} = ${i};`);
    lines[1050] = 'const TARGET = "old";';
    const bigCode = lines.join('\n');

    const preview = await toolEditFile(
      '/tmp',
      {
        id: 'e4',
        name: 'edit_file',
        args: {
          path: 'big.ts',
          search: 'const TARGET = "old";',
          replace: 'const TARGET = "new";',
        },
      },
      async () => bigCode,
    );

    expect(preview).toContain('- const TARGET = "old";');
    expect(preview).toContain('+ const TARGET = "new";');
  });

  describe('applySearchReplace esnek eşleştirme kademeleri', () => {
    it('CRLF vs LF satır sonu farklarını tolere eder', () => {
      const crlfCode = 'line1\r\nline2\r\nline3\r\n';
      const searchLf = 'line2';
      const replaceLf = 'line2_edited';

      const res = applySearchReplace(crlfCode, searchLf, replaceLf, 'crlf.ts');
      expect(res).toBe('line1\r\nline2_edited\r\nline3\r\n');
    });

    it('satır sonundaki gereksiz boşlukları (trailing whitespace) tolere eder', () => {
      const codeWithTrailing = 'const a = 1;   \nconst b = 2;\n';
      const searchClean = 'const a = 1;\nconst b = 2;';
      const replace = 'const a = 10;\nconst b = 20;';

      const res = applySearchReplace(codeWithTrailing, searchClean, replace, 'trail.ts');
      expect(res).toContain('const a = 10;');
      expect(res).toContain('const b = 20;');
    });

    it('farklı girintileri (indentation) tolere eder ve hedef dosyanın girintisine uyarlar', () => {
      const indentedCode = '    function greet() {\n        console.log("hi");\n    }\n';
      const search2Spaces = '  function greet() {\n    console.log("hi");\n  }';
      const replace2Spaces = '  function greet() {\n    console.log("hello world");\n  }';

      const res = applySearchReplace(indentedCode, search2Spaces, replace2Spaces, 'indent.ts');
      expect(res).toContain('    function greet() {');
      expect(res).toContain('console.log("hello world");');
      expect(res).toContain('    }');
    });
  });
});
