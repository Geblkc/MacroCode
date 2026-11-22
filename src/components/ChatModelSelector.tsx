import { useMemo, useState } from 'react';
import {
  getModel,
  hasProviderKey,
  hiddenProviders,
  isModelEnabled,
  resolveModels,
  visibleModels,
} from '../lib/providers';
import type { Model } from '../types';
import { useSettingsStore } from '../store/settings';
import { useSessionStore } from '../store/session';
import { useT } from '../lib/i18n';
import { Icon } from './icons';
import ModelDropdown from './ModelDropdown';

interface Props {
  /** "anahtar ekle" satırından ayarları aç. */
  onOpenSettings?: () => void;
  /** Panel kapandıktan sonra odağı giriş alanına döndür. */
  onDone?: () => void;
}

/**
 * Sohbet kutusunun model seçicisi (Antigravity tarzı alt satır çipi).
 *
 * Titlebar'dan taşındı: aynı görünürlük/süzgeç kuralları, aynı ortak
 * `ModelDropdown` paneli. Panel, kompozör ekranın altında olduğu için yukarı
 * açılır (`anchor="composer"`).
 */
export default function ChatModelSelector({ onOpenSettings, onDone }: Props) {
  const t = useT();
  const provider = useSettingsStore((s) => s.currentProvider);
  const model = useSettingsStore((s) => s.currentModel);
  const customModels = useSettingsStore((s) => s.customModels);
  const disabledModels = useSettingsStore((s) => s.disabledModels);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const modelsDevCatalog = useSettingsStore((s) => s.modelsDevCatalog);
  const liveCatalog = useSettingsStore((s) => s.liveCatalog);

  // Aktif konuşmanın modeli (yoksa global varsayılan).
  const sessionProvider = useSessionStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.provider,
  );
  const sessionModel = useSessionStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.model ?? '',
  );

  const [open, setOpen] = useState(false);

  const displayProvider = sessionProvider ?? provider;
  const displayModel = sessionModel || model;
  const differs = displayModel !== model;
  const keyMissing = !hasProviderKey(displayProvider, apiKeys);

  const all = useMemo(() => {
    // resolveModels modül singleton'larını okur; bağımlılıkların amacı katalog
    // veya canlı liste değiştiğinde listeyi yeniden çözümlemeyi tetiklemek.
    void modelsDevCatalog;
    void liveCatalog;
    return resolveModels(customModels);
  }, [customModels, modelsDevCatalog, liveCatalog]);

  const visible = useMemo(
    () => visibleModels(all, apiKeys).filter((m) => isModelEnabled(disabledModels, m.id)),
    [all, apiKeys, disabledModels],
  );

  const locked = useMemo(() => hiddenProviders(all, apiKeys), [all, apiKeys]);

  const select = (m: Model) => {
    const settings = useSettingsStore.getState();
    settings.setProvider(m.provider);
    settings.setModel(m.id);
    // Seçim aktif konuşmaya da yansır (rozet ile davranış uyuşsun).
    const activeId = useSessionStore.getState().activeSessionId;
    if (activeId) {
      useSessionStore
        .getState()
        .updateSessionModel(activeId, { provider: m.provider, model: m.id });
    }
  };

  const close = () => {
    setOpen(false);
    onDone?.();
  };

  const displayName = getModel(displayModel, customModels)?.name ?? displayModel;
  // Canlı API listesi aktif modeli döndürmediyse seçim kaybolmasın.
  const extraModel =
    displayModel && !visible.some((m) => m.id === displayModel)
      ? getModel(displayModel, customModels)
      : undefined;

  return (
    <div className="model-selector-anchor">
      <button
        type="button"
        className={`model-chip${open ? ' open' : ''}`}
        title={
          differs
            ? `${displayProvider} / ${displayModel} (${t('titlebar.thisChat')}) · ${t('titlebar.defaultModel', { model })}`
            : `${displayProvider} / ${displayModel}`
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('titlebar.modelSelect')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`status-dot${keyMissing ? ' warn' : ''}`} aria-hidden="true" />
        <span className="mname">{displayName}</span>
        <Icon name="chevron-down" size="sm" />
      </button>

      <ModelDropdown
        open={open}
        onClose={close}
        anchor="composer"
        models={visible}
        locked={locked}
        activeModel={displayModel}
        extra={
          extraModel
            ? {
                id: extraModel.id,
                label: extraModel.name,
                onSelect: () => select(extraModel),
              }
            : undefined
        }
        onSelect={select}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
