/** Proje anlık görüntülerini oluşturma / listeleme / geri yükleme paneli. */
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../lib/i18n';
import {
  createSnapshot,
  deleteSnapshot,
  formatBytes,
  listSnapshots,
  restoreSnapshot,
  type SnapshotInfo,
} from '../lib/engine/tools/snapshot';
import { showToast } from '../lib/toast';
import { useGitStore } from '../store/git';
import { Icon } from './icons';

interface ConfirmReq {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  initialFocus?: 'confirm' | 'cancel';
}

interface Props {
  open: boolean;
  root: string | null;
  onClose: () => void;
  /** Sonucu terminal extras satırı olarak göster. */
  onMessage: (text: string, kind?: 'sys' | 'err') => void;
  confirm: (req: ConfirmReq) => Promise<boolean>;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function SnapshotsModal({ open, root, onClose, onMessage, confirm }: Props) {
  const t = useT();
  const [items, setItems] = useState<SnapshotInfo[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!root) return;
    try {
      setItems(await listSnapshots(root));
      setError('');
    } catch (e) {
      setError(errText(e));
    }
  }, [root]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const doCreate = () =>
    run(async () => {
      if (!root) return;
      try {
        const s = await createSnapshot(root, label);
        onMessage(
          t('commands.snapshotCreated', {
            id: s.id.slice(0, 12),
            n: s.file_count,
            size: (s.total_bytes / (1024 * 1024)).toFixed(2),
          }),
        );
        setLabel('');
        await load();
      } catch (e) {
        setError(errText(e));
        showToast(errText(e), 'err');
      }
    });

  const doRestore = (s: SnapshotInfo) =>
    run(async () => {
      if (!root) return;
      const ok = await confirm({
        title: t('snapshot.restoreTitle'),
        message: t('snapshot.restoreMessage', {
          name: s.label || t('snapshot.untitled'),
          id: s.id.slice(0, 12),
        }),
        confirmLabel: t('snapshot.restore'),
        cancelLabel: t('common.cancel'),
        danger: true,
        initialFocus: 'cancel',
      });
      if (!ok) return;
      try {
        const msg = await restoreSnapshot(root, s.id);
        onMessage(msg);
        showToast(t('snapshot.restoredToast'), 'ok');
        void useGitStore.getState().refresh(root);
        await load();
      } catch (e) {
        onMessage(t('snapshot.restoreFailed', { message: errText(e) }), 'err');
        setError(errText(e));
      }
    });

  const doDelete = (s: SnapshotInfo) =>
    run(async () => {
      if (!root) return;
      const ok = await confirm({
        title: t('snapshot.deleteTitle'),
        message: t('snapshot.deleteMessage', {
          name: s.label || t('snapshot.untitled'),
          id: s.id.slice(0, 12),
        }),
        confirmLabel: t('snapshot.delete'),
        cancelLabel: t('common.cancel'),
        danger: true,
        initialFocus: 'cancel',
      });
      if (!ok) return;
      try {
        onMessage(await deleteSnapshot(root, s.id));
        await load();
      } catch (e) {
        onMessage(t('snapshot.deleteFailed', { message: errText(e) }), 'err');
      }
    });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('snapshot.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <Icon name="clock" className="head-icon" />
          <span className="modal-title">{t('snapshot.title')}</span>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="x" size="sm" />
          </button>
        </div>
        <div className="modal-body snapshot-body">
          {!root ? (
            <div className="snapshot-empty">{t('snapshot.needsRoot')}</div>
          ) : (
            <>
              <div className="snapshot-create">
                <input
                  className="snapshot-input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t('snapshot.labelPlaceholder')}
                  aria-label={t('snapshot.labelPlaceholder')}
                  maxLength={60}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doCreate();
                  }}
                />
                <button className="btn btn-primary" onClick={() => void doCreate()} disabled={busy}>
                  <Icon name="plus" size="sm" />
                  {t('snapshot.create')}
                </button>
              </div>
              {error ? <div className="snapshot-error">{error}</div> : null}
              {items.length === 0 ? (
                <div className="snapshot-empty">{t('snapshot.empty')}</div>
              ) : (
                <div className="snapshot-list">
                  {items.map((s) => (
                    <div key={s.id} className="snapshot-row">
                      <div className="snapshot-info">
                        <div className="snapshot-name">{s.label || t('snapshot.untitled')}</div>
                        <div className="snapshot-meta">
                          {new Date(s.created_at).toLocaleString()} · {s.file_count}{' '}
                          {t('snapshot.files')} · {formatBytes(s.total_bytes)} ·{' '}
                          <span className="snapshot-id">{s.id.slice(0, 12)}</span>
                        </div>
                      </div>
                      <button
                        className="btn"
                        onClick={() => void doRestore(s)}
                        disabled={busy}
                        title={t('snapshot.restoreHint')}
                      >
                        <Icon name="refresh" size="sm" />
                        {t('snapshot.restore')}
                      </button>
                      <button
                        className="btn icon-btn btn-danger"
                        onClick={() => void doDelete(s)}
                        disabled={busy}
                        aria-label={t('snapshot.delete')}
                        title={t('snapshot.delete')}
                      >
                        <Icon name="trash" size="sm" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
