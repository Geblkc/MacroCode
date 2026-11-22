/**
 * Araç çağrılarının tek satırlık önizlemeleri.
 *
 * Hem canlı akışta (`useAgent`) hem de geçmişten yeniden kurulan zaman
 * çizelgesinde (`timeline`) aynı metin üretilsin diye tek yerde tutulur.
 * UI'dan bağımsızdır (React/i18n import yok).
 */

/** Araç argümanlarının `k=v` biçiminde tek satırlık önizlemesi. */
export function previewArgs(args: Record<string, unknown> | undefined): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 60 ? s.slice(0, 60) + '…' : s}`);
  }
  return parts.join(' ');
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

function clamp(s: string, limit = 160): string {
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * Kullanıcıya gösterilecek asıl hedef: dosya yolu, komut, desen ya da görev.
 * Argüman listesinden daha okunur; kartın başlık satırında kullanılır.
 */
export function toolTarget(name: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'propose_patch':
      return clamp(str(a, 'path'));
    case 'list_dir':
      return clamp(str(a, 'path') || '.');
    case 'grep': {
      const pattern = str(a, 'pattern');
      const path = str(a, 'path');
      return clamp(path ? `${pattern} · ${path}` : pattern);
    }
    case 'glob': {
      const pattern = str(a, 'pattern');
      const path = str(a, 'path');
      return clamp(path ? `${pattern} · ${path}` : pattern);
    }
    case 'exec': {
      const cmd = str(a, 'cmd');
      const argv = Array.isArray(a.args)
        ? a.args.filter((x): x is string => typeof x === 'string')
        : [];
      const cwd = str(a, 'cwd');
      const line = [cmd, ...argv].filter(Boolean).join(' ');
      return clamp(cwd ? `${line}  ·  ${cwd}` : line);
    }
    case 'todo': {
      const action = str(a, 'action');
      const text = str(a, 'text');
      return clamp([action, text].filter(Boolean).join(' · '));
    }
    case 'subagent':
      return clamp(str(a, 'task'));
    case 'plan': {
      const steps = Array.isArray(a.steps)
        ? a.steps.filter((x): x is string => typeof x === 'string')
        : [];
      return clamp(steps.join(' · '));
    }
    case 'create_snapshot':
      return clamp(str(a, 'label'));
    default:
      return clamp(previewArgs(a));
  }
}
