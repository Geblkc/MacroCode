import { Component, type ErrorInfo, type ReactNode } from 'react';
import { copyText } from '../lib/clipboard';
import { t } from '../lib/i18n';
import { Icon } from './icons';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  copied: boolean;
}

/**
 * Kök hata sınırı — bir render/lifecycle hatasında beyaz ekran yerine
 * kurtarma ekranı gösterir. Oturumlar kalıcı olduğu için yeniden yükleme
 * veri kaybına yol açmaz.
 *
 * Sınıf bileşeni olmak zorundadır: `componentDidCatch` yalnızca sınıflarda var.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Geliştirici konsolunda tam bağlam kalsın; kullanıcıya stack gösterilmez.
    console.error('[MacroCode] render hatası:', error, info.componentStack);
    this.setState({ info });
  }

  private details(): string {
    const { error, info } = this.state;
    if (!error) return '';
    return [
      `MacroCode ${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'}`,
      `URL: ${globalThis.location?.href ?? '—'}`,
      `Hata: ${error.name}: ${error.message}`,
      '',
      error.stack ?? '(stack yok)',
      info?.componentStack ? `\nBileşen yığını:${info.componentStack}` : '',
    ].join('\n');
  }

  private retry = (): void => {
    this.setState({ error: null, info: null, copied: false });
  };

  private reload = (): void => {
    globalThis.location?.reload();
  };

  private copy = async (): Promise<void> => {
    const ok = await copyText(this.details());
    this.setState({ copied: ok });
  };

  render(): ReactNode {
    const { error, copied } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-card">
          <div className="error-boundary-title">
            <Icon name="alert-triangle" size="md" />
            <h1>{t('errorBoundary.title')}</h1>
          </div>
          <p className="error-boundary-msg">{t('errorBoundary.message')}</p>
          <pre className="error-boundary-detail">
            <code>
              {error.name}: {error.message}
            </code>
          </pre>
          <div className="error-boundary-actions">
            <button type="button" className="btn btn-primary" onClick={this.retry}>
              {t('errorBoundary.retry')}
            </button>
            <button type="button" className="btn" onClick={this.reload}>
              {t('errorBoundary.reload')}
            </button>
            <button type="button" className="btn" onClick={this.copy}>
              {copied ? t('common.copied') : t('errorBoundary.copy')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
