// Per-tab authentication token storage.
//
// Historický problém: token bol v localStorage (zdieľaný medzi tabmi). Keď
// sa user v druhom tabe prihlásil ako iný účet, prvý tab tichom prepisom
// začal volať API pod novým tokenom (axios interceptor číta localStorage
// pri každom requeste), UI ale ďalej ukazovalo starého usera/workspace.
//
// Nové správanie:
//   - Web prehliadač (tab):   sessionStorage — per-tab izolácia
//   - iOS natívna appka:      localStorage   — jeden WKWebView, token musí
//                                              prežiť kill appky
//   - PWA / Android TWA:      localStorage   — "installed app" je single-
//                                              -instance, žiadne viac tabov
//                                              neexistujú. Bez localStorage by
//                                              každý swipe-from-recents zabil
//                                              Chrome tab → sessionStorage sa
//                                              zmaže → user sa odhlási.
//
// Ak nový web tab nemá vo svojom sessionStorage žiadny token, pri štarte
// sa cez BroadcastChannel spýta ostatných tabov, či mu požičajú token
// (UX: nový tab zdedí existujúcu session). Vidieť v AuthContext.jsx.

const isNativeIOSApp = () =>
  /PrplCRM-iOS/.test(navigator.userAgent) ||
  !!(window.webkit && window.webkit.messageHandlers);

// PWA installed to home screen (iOS Safari add-to-home) alebo Android TWA
// (launched cez Bubblewrap wrapper) reportuje display-mode: standalone.
// Detektor musí byť defenzívny — matchMedia nie je v každom kontexte
// (test prostredia, staré prehliadače, SSR).
const isPwaStandalone = () => {
  try {
    if (typeof window === 'undefined') return false;
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.navigator && window.navigator.standalone === true) return true; // iOS legacy
    return false;
  } catch {
    return false;
  }
};

const usePersistentStorage = () => isNativeIOSApp() || isPwaStandalone();

const storage = () => (usePersistentStorage() ? localStorage : sessionStorage);

export const getStoredToken = () => {
  try {
    const primary = storage().getItem('token');
    if (primary) return primary;

    // Migration fallback: existujúci PWA/TWA useri ktorí sa prihlásili pred
    // týmto fixom majú token v sessionStorage. Po update sa ich session
    // vymaže pri swipe-kill. Pozrieme sa ešte aj do opačného storage-u
    // a ak nájdeme token, migrujeme ho. Robíme to len v persistent-mode
    // (PWA/iOS) — web tab naopak musí ostať sessionStorage-only aby sa
    // nezdielal token medzi tabmi.
    if (usePersistentStorage()) {
      const legacy = sessionStorage.getItem('token');
      if (legacy) {
        try { localStorage.setItem('token', legacy); } catch { /* noop */ }
        return legacy;
      }
    }
    return null;
  } catch {
    return null;
  }
};

export const setStoredToken = (token) => {
  try {
    storage().setItem('token', token);
  } catch {
    // Private Browsing / quota edge case — fallback na cookie by bola
    // zmena v architektúre, pre túto chvíľu necháme token len v pamäti
    // cez AuthContext state, ďalší refresh vyhodí usera na /login.
  }
};

export const removeStoredToken = () => {
  // Na logout zmazeme token z oboch storage-ov bez ohľadu na current mode —
  // rieši to aj prípad keď user v jednej session bol web-tab (sessionStorage)
  // a po installe PWA/TWA používa localStorage, alebo naopak.
  try { sessionStorage.removeItem('token'); } catch { /* noop */ }
  try { localStorage.removeItem('token'); } catch { /* noop */ }
  try { localStorage.removeItem('user'); } catch { /* noop */ }
  // Per-device workspace intent viaže sa na session — na logout ho zmažeme,
  // inak by ďalší prihlásený user na tomto zariadení zdedil cudzí workspaceId
  // a prvé API requesty by skončili 403 (NOT_MEMBER).
  try { sessionStorage.removeItem('currentWorkspaceId'); } catch { /* noop */ }
  try { localStorage.removeItem('currentWorkspaceId'); } catch { /* noop */ }
};

export { isNativeIOSApp };
