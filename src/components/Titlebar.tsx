import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '../store/settings';
import { useWorkspaceStore } from '../store/workspace';
import { useT } from '../lib/i18n';
import { Icon } from './icons';

interface Props {
  sessionName: string;
  /** Proje anlık görüntüleri panelini aç. */
  onOpenSnapshots?: () => void;
  /** /root tek yol: '' = diyalog, 'off', '1..5' (App'te kodlanır). */
  onRootCommand?: (arg: string) => void;
}

/** Platform tespiti: macOS'ta traffic light, diğerinde kare düğmeler. */
function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Mac|iPhone|iPad/.test(ua);
}

export default function Titlebar({ sessionName, onOpenSnapshots, onRootCommand }: Props) {
  const t = useT();
  const workspaceLabel = useWorkspaceStore((s) => s.label);
  const workspaceRoot = useWorkspaceStore((s) => s.root);
  const recent = useWorkspaceStore((s) => s.recent ?? []);
  const removeRecent = useWorkspaceStore((s) => s.removeRecent);
  const [wsOpen, setWsOpen] = useState(false);

  // Workspace menüsü: Esc ile kapat.
  useEffect(() => {
    if (!wsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setWsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wsOpen]);

  const mac = isMac();

  return (
    <div className="titlebar" data-tauri-drag-region>
      {isTauri() ? (
        mac ? (
          <span className="traffic no-drag" role="group" aria-label={t('titlebar.windowControls')}>
            <button
              className="tl-btn"
              title={t('titlebar.close')}
              aria-label={t('titlebar.close')}
              onClick={() =>
                void getCurrentWindow()
                  .close()
                  .catch(() => {})
              }
            >
              <i className="tl tl-r" />
            </button>
            <button
              className="tl-btn"
              title={t('titlebar.minimize')}
              aria-label={t('titlebar.minimize')}
              onClick={() =>
                void getCurrentWindow()
                  .minimize()
                  .catch(() => {})
              }
            >
              <i className="tl tl-y" />
            </button>
            <button
              className="tl-btn"
              title={t('titlebar.maximize')}
              aria-label={t('titlebar.maximize')}
              onClick={() =>
                void getCurrentWindow()
                  .toggleMaximize()
                  .catch(() => {})
              }
            >
              <i className="tl tl-g" />
            </button>
          </span>
        ) : (
          <span className="winctl no-drag" role="group" aria-label={t('titlebar.windowControls')}>
            <button
              title={t('titlebar.minimize')}
              aria-label={t('titlebar.minimize')}
              onClick={() =>
                void getCurrentWindow()
                  .minimize()
                  .catch(() => {})
              }
            >
              <Icon name="chevron-down" size="sm" className="rot-90" />
            </button>
            <button
              title={t('titlebar.maximize')}
              aria-label={t('titlebar.maximize')}
              onClick={() =>
                void getCurrentWindow()
                  .toggleMaximize()
                  .catch(() => {})
              }
            >
              <Icon name="panel" size="sm" />
            </button>
            <button
              title={t('titlebar.close')}
              aria-label={t('titlebar.close')}
              onClick={() =>
                void getCurrentWindow()
                  .close()
                  .catch(() => {})
              }
            >
              <Icon name="x" size="sm" />
            </button>
          </span>
        )
      ) : (
        <span className="traffic" aria-hidden="true">
          <i className="tl tl-r" />
          <i className="tl tl-y" />
          <i className="tl tl-g" />
        </span>
      )}

      <span className="identity">
        <img
          className="titlebar-logo"
          src="macrocode-logo.svg"
          alt=""
          aria-hidden="true"
          draggable={false}
        />
        <span className="app-name">MacroCode</span>
        <span className="dot-sep" aria-hidden="true">
          ·
        </span>
        <span className="session-name" title={sessionName}>
          {sessionName}
        </span>
      </span>

      <span className="titlebar-right no-drag">
        {workspaceRoot ? (
          <button
            className={`workspace-chip${wsOpen ? ' open' : ''}`}
            title={workspaceRoot}
            aria-label={t('titlebar.workspace', { name: workspaceLabel || workspaceRoot })}
            aria-haspopup="menu"
            aria-expanded={wsOpen}
            onClick={() => setWsOpen((v) => !v)}
          >
            <Icon name="folder" size="sm" />
            {workspaceLabel || workspaceRoot.split('/').filter(Boolean).pop() || workspaceRoot}
            <Icon name="chevron-down" size="sm" />
          </button>
        ) : null}

        {wsOpen && onRootCommand ? (
          <>
            <div className="dropdown-backdrop" onClick={() => setWsOpen(false)} />
            <div className="ws-menu" role="menu" aria-label={t('titlebar.workspaceMenu')}>
              <button
                role="menuitem"
                className="ws-menu-item"
                onClick={() => {
                  setWsOpen(false);
                  onRootCommand('');
                }}
              >
                <Icon name="folder" size="sm" />
                {t('workspace.pick')}
              </button>
              {onOpenSnapshots ? (
                <button
                  role="menuitem"
                  className="ws-menu-item"
                  onClick={() => {
                    setWsOpen(false);
                    onOpenSnapshots();
                  }}
                >
                  <Icon name="clock" size="sm" />
                  {t('snapshot.title')}
                </button>
              ) : null}
              {recent.length > 0 ? (
                <>
                  <div className="ws-menu-title">{t('workspace.recents')}</div>
                  {recent.map((entry, i) => (
                    <div key={entry.root} className="ws-menu-row" role="none">
                      <button
                        role="menuitem"
                        className="ws-menu-item"
                        title={entry.root}
                        onClick={() => {
                          setWsOpen(false);
                          onRootCommand(String(i + 1));
                        }}
                      >
                        <Icon name="folder" size="sm" />
                        <span className="ws-menu-label">{entry.label}</span>
                        <span className="ws-menu-path">{entry.root}</span>
                      </button>
                      <button
                        className="ws-menu-x"
                        aria-label={t('workspace.removeRecent', { name: entry.label })}
                        title={t('workspace.removeRecent', { name: entry.label })}
                        onClick={() => removeRecent(entry.root)}
                      >
                        <Icon name="x" size="sm" />
                      </button>
                    </div>
                  ))}
                </>
              ) : (
                <div className="ws-menu-title">{t('workspace.recentsNone')}</div>
              )}
              <button
                role="menuitem"
                className="ws-menu-item danger"
                onClick={() => {
                  setWsOpen(false);
                  onRootCommand('off');
                }}
              >
                <Icon name="x" size="sm" />
                {t('workspace.remove')}
              </button>
            </div>
          </>
        ) : null}
      </span>
    </div>
  );
}
