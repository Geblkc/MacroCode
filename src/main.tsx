import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { useSettingsStore } from './store/settings';
import './styles/fonts.css';
import './styles/global.css';
import './styles/high-contrast.css';
import './styles/shell.css';
import './styles/message.css';
import './styles/markdown.css';
import './styles/agent.css';
import './styles/settings.css';
import './styles/git.css';
import './styles/stats.css';
import './styles/session-history.css';
import './styles/toast.css';
import './styles/utilities.css';

/**
 * Görünüm tercihlerini ilk React render'ından ÖNCE uygular.
 *
 * `index.html` statik olarak `data-contrast="high"` + `data-uifont="inter"`
 * taşır (yeni kurulum varsayılanı, FOUC yok). Persist edilmiş bir tercihi
 * olan kullanıcıda ise React mount'u beklemek açılışta yanlış paletin bir an
 * görünmesine yol açardı — store hidrasyonu senkron olduğu için burada
 * gerçek değerleri hemen yazıyoruz. `App.tsx` efektleri aynı nitelikleri
 * sonraki değişikliklerde güncellemeye devam eder.
 */
function applyAppearance() {
  const { contrast, uiFont } = useSettingsStore.getState();
  const root = document.documentElement;
  root.setAttribute('data-contrast', contrast);
  root.setAttribute('data-uifont', uiFont);
}

applyAppearance();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
