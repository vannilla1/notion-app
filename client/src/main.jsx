import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { reportError, installGlobalErrorHandlers } from './utils/reportError';
import { installBreadcrumbInstrumentation } from './utils/breadcrumbs';
import './styles/index.css';

// In-house error tracking (nahrada Sentry). Poradie záleží — breadcrumbs
// musia byť nainštalované PRED prvým error handlerom, aby sme pri prvej
// chybe mali context aspoň pár "app boot" udalostí.
installBreadcrumbInstrumentation();
installGlobalErrorHandlers();

// Po deployi nový service worker hneď prevezme otvorené taby a zmaže starý
// precache (skipWaiting + clientsClaim + cleanupOutdatedCaches). Tab so starým
// bundlom potom pri prechode na lazy route žiada chunk so starým hashom →
// „Failed to fetch dynamically imported module“. Vite to hlási udalosťou
// vite:preloadError — jedno automatické obnovenie načíta nový bundle.
// Poistka proti slučke: druhá chyba do 30 s už ide do RouteErrorBoundary.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'prpl_chunk_reload_at';
  let last = 0;
  try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch { /* storage nedostupný */ }
  if (Date.now() - last < 30000) return;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* storage nedostupný */ }
  event.preventDefault();
  window.location.reload();
});

// Platformové body classes — CSS cez ne cielene upravuje padding, tap targets,
// safe-area insets. Analóg k 'ios-app' class ktorú injectuje Swift WKWebView
// (ios/PrplCRM/ContentView.swift), ale pre Android to musíme urobiť z JS lebo
// TWA nevie injektnúť kód pred React-om.
//
//   platform-android  — UA obsahuje Android (browser, PWA, TWA, WebView)
//   pwa-standalone    — display-mode: standalone (installed PWA alebo TWA);
//                        tu aplikujeme safe-area-inset-top kvôli status baru
//                        a camera cutoutu. V normálnom browseri NIE — tam
//                        browser chrome už status bar pokrýva.
(function markPlatform() {
  try {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) document.body.classList.add('platform-android');
    const mql = window.matchMedia && window.matchMedia('(display-mode: standalone)');
    const isStandalone = (mql && mql.matches) || window.navigator.standalone === true;
    if (isStandalone) document.body.classList.add('pwa-standalone');
    // Ak user v behu appku nainštaluje (A2HS), class sa nedoplní — to je OK,
    // ďalší cold-start ju nastaví. Nestojí za to riešiť live switch.
  } catch { /* never break boot */ }
})();

// Minimal local error boundary — renders fallback UI a chybu hlási cez
// reportError() do in-house Diagnostiky (viď componentDidCatch nižšie).
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, errorInfo) {
    reportError({
      name: error?.name,
      message: error?.message || 'React render error',
      stack: error?.stack,
      componentStack: errorInfo?.componentStack
    });
  }
  // Tlačidlo sľubuje „Obnoviť stránku" — skutočný reload. Samotné
  // setState({ hasError: false }) len znova vyrenderovalo ten istý podstrom
  // s rovnakým stavom (AuthProvider, Router, cache modulov), takže pri
  // deterministickej chybe (TDZ, chýbajúce pole, stale chunk) spadol hneď
  // znova a používateľ klikal bez efektu — ide o najvyšší boundary, pod ním
  // už žiadna cesta von nie je. Manuálna akcia, nie 401 slučka z api.js.
  reset = () => {
    try { window.location.reload(); } catch { this.setState({ hasError: false }); }
  };
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'sans-serif' }}>
        <h2 style={{ color: '#EF4444', marginBottom: '12px' }}>Nastala neocakavana chyba</h2>
        <p style={{ color: '#64748b', marginBottom: '20px' }}>
          Skuste obnovit stranku.
        </p>
        <button
          onClick={this.reset}
          style={{
            padding: '10px 24px', background: '#6366f1', color: '#fff',
            border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px'
          }}
        >
          Obnovit stranku
        </button>
      </div>
    );
  }
}

// Prerendrovaný landing ('/') sa HYDRATUJE namiesto nahradenia:
// createRoot().render() by celý DOM zmazal a nanovo vykreslil — ten repaint
// (po načítaní webfontov) Chrome počíta ako nový, neskorší LCP. hydrateRoot
// sa na existujúce HTML len "pripne" (event handlery) bez prekreslenia.
// LandingPage je na to samostatná: bez Routera (footer <a>), bez AuthProvideru.
// Markup MUSÍ presne sedieť s entry-server.jsx (inak React spadne na client
// render). Fallbacky: iOS shell, prázdny root (prerender zlyhal), iná cesta
// → plný App cez createRoot ako doteraz.
import LandingPage from './pages/LandingPage';

const rootEl = document.getElementById('root');
const hydratableLanding = (
  window.location.pathname === '/' &&
  !window.__iosNative &&
  rootEl.firstElementChild !== null
);

if (hydratableLanding) {
  ReactDOM.hydrateRoot(
    rootEl,
    <React.StrictMode>
      <AppErrorBoundary>
        <LandingPage />
      </AppErrorBoundary>
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AppErrorBoundary>
    </React.StrictMode>
  );
}
