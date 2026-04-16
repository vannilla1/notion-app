// Per-tab authentication token storage.
//
// Historický problém: token bol v localStorage (zdieľaný medzi tabmi). Keď
// sa user v druhom tabe prihlásil ako iný účet, prvý tab tichom prepisom
// začal volať API pod novým tokenom (axios interceptor číta localStorage
// pri každom requeste), UI ale ďalej ukazovalo starého usera/workspace.
//
// Nové správanie:
//   - Web (prehliadač):       sessionStorage — per-tab izolácia
//   - iOS natívna appka:      localStorage   — jeden WKWebView, token musí
//                                              prežiť kill appky
//
// Ak nový web tab nemá vo svojom sessionStorage žiadny token, pri štarte
// sa cez BroadcastChannel spýta ostatných tabov, či mu požičajú token
// (UX: nový tab zdedí existujúcu session). Vidieť v AuthContext.jsx.

const isNativeIOSApp = () =>
  /PrplCRM-iOS/.test(navigator.userAgent) ||
  !!(window.webkit && window.webkit.messageHandlers);

const storage = () => (isNativeIOSApp() ? localStorage : sessionStorage);

export const getStoredToken = () => {
  try {
    return storage().getItem('token');
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
  try {
    storage().removeItem('token');
  } catch { /* noop */ }
  // Cleanup: historicky sme na web-e zapisovali do localStorage, po deploye
  // môžu mať useri oba kľúče (legacy localStorage + nový sessionStorage).
  // Odstránime aj zvyšok, aby sa neobjavil pri ďalšom page refresh.
  if (!isNativeIOSApp()) {
    try { localStorage.removeItem('token'); } catch { /* noop */ }
  }
  try { localStorage.removeItem('user'); } catch { /* noop */ }
};

export { isNativeIOSApp };
