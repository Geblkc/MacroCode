import { describe, expect, it } from 'vitest';
import { formatBytes, formatSnapshotLine, type SnapshotInfo } from './snapshot';
import { filterToolsForMode, getDisallowedToolsForMode } from '../agentModes';
import { CORE_TOOLS } from '../toolspec';
import { decideTool } from '../policy';

const info: SnapshotInfo = {
  id: '1234567890-abc-0001',
  label: 'önemli',
  created_at: 1_700_000_000_000,
  file_count: 12,
  total_bytes: 2 * 1024 * 1024,
  files: [],
};

describe('snapshot yardımcıları', () => {
  it('boyutu okunur biçime çevirir', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('satır özetinde kimlik, etiket ve dosya sayısı var', () => {
    const line = formatSnapshotLine(info);
    expect(line).toContain('1234567890');
    expect(line).toContain('önemli');
    expect(line).toContain('12');
  });

  it('create_snapshot izin kararları yazma sınıfındadır', () => {
    expect(decideTool('create_snapshot', {}, 'manual').allowed).toBe(true);
    expect(decideTool('create_snapshot', {}, 'auto-read').allowed).toBe(false);
    expect(decideTool('create_snapshot', {}, 'auto-edit')).toHaveProperty('autoApproved', true);
  });

  it('anlık görüntü aracı yalnız build modunda açık', () => {
    expect(CORE_TOOLS.some((t) => t.name === 'create_snapshot')).toBe(true);
    expect(filterToolsForMode(CORE_TOOLS, 'build').some((t) => t.name === 'create_snapshot')).toBe(
      true,
    );
    expect(filterToolsForMode(CORE_TOOLS, 'plan').some((t) => t.name === 'create_snapshot')).toBe(
      false,
    );
    expect(filterToolsForMode(CORE_TOOLS, 'ask').some((t) => t.name === 'create_snapshot')).toBe(
      false,
    );
    expect(getDisallowedToolsForMode('plan')).toContain('create_snapshot');
  });
});
