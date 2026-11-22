import { describe, expect, it } from 'vitest';
import { toolExec } from './shell';
import type { ToolCall } from '../types';

const call = (cmd: string, args: string[] = []): ToolCall => ({
  id: 't1',
  name: 'exec',
  args: { cmd, args },
});

describe('Y2 (Faz 3) — exec onay bayrağı', () => {
  it('onaysız exec reddedilir (autoApproved asla true değil)', async () => {
    // invoke'a bile gitmeden guard düşer — "yalnızca Tauri" hatası YOK.
    await expect(toolExec('/tmp', call('npm', ['--version']), 'manual')).rejects.toThrow(
      /onay gerekli/,
    );
  });

  it("approved: true guard'ı geçer (invoke çağrısına ulaşır)", async () => {
    // Guard aşıldı → hata artık onay değil, Tauri ortamı hakkındadır.
    await expect(
      toolExec('/tmp', call('npm', ['--version']), 'manual', { approved: true }),
    ).rejects.toThrow(/yalnızca Tauri/);
  });

  it('approved olsa bile sert kilitler (rm) reddedilir', async () => {
    await expect(
      toolExec('/tmp', call('rm', ['-rf', '/']), 'manual', { approved: true }),
    ).rejects.toThrow(/yasaklı/);
  });

  it('izin listesinde olmayan komut onayla çalıştırılabilir (invoke a kadar geçer)', async () => {
    // `sudo` allowlist'te yok → onay kartına düşer; onaylanınca invoke'a ulaşır.
    await expect(toolExec('/tmp', call('sudo', []), 'manual', { approved: true })).rejects.toThrow(
      /yalnızca Tauri/,
    );
    // Onaysız aynı komut "onay gerekli" hatasıyla durur.
    await expect(toolExec('/tmp', call('sudo', []), 'manual')).rejects.toThrow(/onay gerekli/);
  });

  it("extraAllow özel komuta izin verir (Rust invoke'a kadar)", async () => {
    const extra = { docker: [['ps']] };
    // İzinli: guard'ı geçer → Tauri ortamı hatası.
    await expect(
      toolExec('/tmp', call('docker', ['ps']), 'manual', { approved: true, extraAllow: extra }),
    ).rejects.toThrow(/yalnızca Tauri/);
    // İzin dışı prefix: onay kartına düşer (unlisted) → onaylı çağrı invoke'a ulaşır.
    await expect(
      toolExec('/tmp', call('docker', ['rm']), 'manual', { approved: true, extraAllow: extra }),
    ).rejects.toThrow(/yalnızca Tauri/);
    // Onaysız çağrı yine "onay gerekli" ile durur.
    await expect(
      toolExec('/tmp', call('docker', ['rm']), 'manual', { extraAllow: extra }),
    ).rejects.toThrow(/onay gerekli/);
  });

  it('M5: güvenli olmayan cwd invoke öncesi reddedilir', async () => {
    const cwdCall = (cwd: string): ToolCall => ({
      id: 't2',
      name: 'exec',
      args: { cmd: 'npm', args: ['--version'], cwd },
    });
    // Mutlak yol, `..` ve bloklu dizin → erken hata.
    await expect(toolExec('/tmp', cwdCall('/etc'), 'manual', { approved: true })).rejects.toThrow(
      /cwd güvenli değil/,
    );
    await expect(
      toolExec('/tmp', cwdCall('../kacis'), 'manual', { approved: true }),
    ).rejects.toThrow(/cwd güvenli değil/);
    await expect(toolExec('/tmp', cwdCall('.git'), 'manual', { approved: true })).rejects.toThrow(
      /cwd güvenli değil/,
    );
    // Güvenli göreli cwd → guard'ı geçer, Tauri ortamı hatasına ulaşır.
    await expect(toolExec('/tmp', cwdCall('src'), 'manual', { approved: true })).rejects.toThrow(
      /yalnızca Tauri/,
    );
  });
});
