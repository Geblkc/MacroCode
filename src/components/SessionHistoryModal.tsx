/**
 * Oturum geçmişi: tüm oturumları (aktif + arşiv) listeler, arşivden geri
 * yükler veya arşivdeki oturumu kalıcı olarak siler.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useT, type TranslationKey } from '../lib/i18n';
import { getModel } from '../lib/providers';
import { showToast } from '../lib/toast';
import { isSessionArchived, useSessionStore } from '../store/session';
import { useSettingsStore } from '../store/settings';
import type { AgentMode, Session } from '../types';
import ConfirmDialog from './ConfirmDialog';
import { Icon, type IconName } from './icons';

interface Props {
  open: boolean;
  onClose: () => void;
}

type HistoryFilter = 'all' | 'active' | 'archived';

const FILTERS: Array<{ id: HistoryFilter; labelKey: TranslationKey }> = [
  { id: 'all', labelKey: 'sessionHistory.filter.all' },
  { id: 'active', labelKey: 'sessionHistory.filter.active' },
  { id: 'archived', labelKey: 'sessionHistory.filter.archived' },
];

const MODE_ICON: Record<AgentMode, IconName> = {
  build: 'wrench',
  plan: 'list-checks',
  ask: 'message',
};

const MODE_LABEL_KEY: Record<AgentMode, TranslationKey> = {
  build: 'mode.build',
  plan: 'mode.plan',
  ask: 'mode.ask',
};

/** Satır önizlemesi: ilk kullanıcı mesajının düz metin, kısa hâli. */
function previewOf(session: Session): string {
  const first = session.messages.find((m) => m.role === 'user');
  return first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
}

export default function SessionHistoryModal({ open, onClose }: Props) {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const currentModel = useSettingsStore((s) => s.currentModel);
  const customModels = useSettingsStore((s) => s.customModels);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [pendingPurgeId, setPendingPurgeId] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const trapFocus = useFocusTrap(modalRef, open);

  const rows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    return sessions
      .filter((s) => {
        if (filter === 'active') return !isSessionArchived(s);
        if (filter === 'archived') return isSessionArchived(s);
        return true;
      })
      .filter(
        (s) =>
          !q ||
          s.name.toLocaleLowerCase('tr').includes(q) ||
          previewOf(s).toLocaleLowerCase('tr').includes(q),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, filter, query]);

  const pendingPurge = sessions.find((s) => s.id === pendingPurgeId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pendingPurgeId) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, pendingPurgeId]);

  // Kapandıktan sonra filtre ve arama kalmasın.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setFilter('all');
    setPendingPurgeId(null);
  }, [open]);

  if (!open) return null;

  const doRestore = (session: Session) => {
    const store = useSessionStore.getState();
    if (isSessionArchived(session)) store.restoreSession(session.id);
    else store.setActiveSession(session.id);
    showToast(t('sessionHistory.restoreToast'), 'ok');
    onClose();
  };

  const doPurge = () => {
    if (!pendingPurge) return;
    useSessionStore.getState().purgeSession(pendingPurge.id);
    setPendingPurgeId(null);
    showToast(t('sessionHistory.purgedToast'), 'ok');
  };

  const onModalKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    trapFocus(e);
  };

  return (
    <>
      <div className="stats-overlay" onClick={onClose}>
        <div
          className="stats-modal history-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t('sessionHistory.title')}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onModalKeyDown}
          ref={modalRef}
        >
          <div className="stats-header">
            <h2>
              <Icon name="clock" size="sm" /> {t('sessionHistory.title')}
            </h2>
            <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>
              <Icon name="x" size="sm" />
            </button>
          </div>

          <div className="history-toolbar">
            <label className="history-search">
              <Icon name="search" size="sm" />
              <input
                className="input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery('');
                }}
                placeholder={t('sessionHistory.search')}
                aria-label={t('sessionHistory.searchAria')}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <div className="history-filters" role="group" aria-label={t('sessionHistory.title')}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`btn btn-sm${filter === f.id ? ' active' : ''}`}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {t(f.labelKey)}
                </button>
              ))}
            </div>
            <span className="history-count">
              {t('sessionHistory.count', { count: rows.length })}
            </span>
          </div>

          <div className="history-list">
            {rows.length === 0 ? (
              <p className="history-empty">
                {sessions.length === 0 ? t('sessionHistory.empty') : t('sessionHistory.noMatch')}
              </p>
            ) : (
              rows.map((s) => {
                const archived = isSessionArchived(s);
                const mode = s.agentMode ?? 'build';
                const modelId = s.model || currentModel;
                const modelLabel = getModel(modelId, customModels)?.name ?? modelId;
                const modeLabel = t(MODE_LABEL_KEY[mode]);
                return (
                  <div
                    key={s.id}
                    className={`history-row${archived ? ' archived' : ''}${
                      s.id === activeId && !archived ? ' current' : ''
                    }`}
                  >
                    <div className="history-main">
                      <div className="history-name-row">
                        <span className="history-name">{s.name}</span>
                        {s.id === activeId && !archived ? (
                          <span className="history-tag current">{t('sessionHistory.active')}</span>
                        ) : null}
                        {archived ? (
                          <span className="history-tag archived">
                            {t('sessionHistory.archived')}
                          </span>
                        ) : null}
                      </div>
                      <div className="history-preview">
                        {previewOf(s) || t('sessionHistory.previewEmpty')}
                      </div>
                      <div className="history-meta">
                        <span>{new Date(s.updatedAt).toLocaleString()}</span>
                        <span aria-hidden="true">·</span>
                        <span>{t('sessionHistory.messages', { count: s.messages.length })}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`smode smode-${mode}`}
                          title={modeLabel}
                          aria-label={modeLabel}
                        >
                          <Icon name={MODE_ICON[mode]} size="sm" />
                        </span>
                        <span className="history-model" title={modelId}>
                          {modelLabel}
                        </span>
                      </div>
                    </div>
                    <div className="history-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => doRestore(s)}
                        title={t('sessionHistory.restoreAria', { name: s.name })}
                        aria-label={t('sessionHistory.restoreAria', { name: s.name })}
                      >
                        <Icon name="refresh" size="sm" />
                        <span>{t('sessionHistory.restore')}</span>
                      </button>
                      {archived ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost btn-danger"
                          onClick={() => setPendingPurgeId(s.id)}
                          title={t('sessionHistory.purgeAria', { name: s.name })}
                          aria-label={t('sessionHistory.purgeAria', { name: s.name })}
                        >
                          <Icon name="trash" size="sm" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingPurge !== null}
        title={t('sessionHistory.purgeTitle')}
        message={t('sessionHistory.purgeMessage', { name: pendingPurge?.name ?? '' })}
        confirmLabel={t('sessionHistory.purgeOk')}
        cancelLabel={t('common.cancel')}
        danger
        initialFocus="cancel"
        onConfirm={doPurge}
        onCancel={() => setPendingPurgeId(null)}
      />
    </>
  );
}
