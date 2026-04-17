// Per-device workspace ID storage.
//
// Prečo: backend (server/middleware/workspace.js) od teraz rešpektuje
// `X-Workspace-Id` header od klienta ako ground truth pre workspace
// context requestu. Každé zariadenie (desktop tab, iOS appka, Android
// appka, PWA) má svoj vlastný "current workspace" — žiadne multi-device
// interferencie.
//
// Storage stratégia sa riadi rovnakým patternom ako authStorage.js:
//   - Web prehliadač (tab):   sessionStorage — per-tab izolácia, aby dva
//                             taby mohli mať otvorené rôzne workspace-y
//   - iOS natívna appka:      localStorage   — single WKWebView, musí prežiť
//                                              kill appky
//   - PWA / Android TWA:      localStorage   — standalone mode, swipe-kill
//                                              zabije sessionStorage
//
// Fallback: ak storage nemá hodnotu (prvý request po logine, migrácia),
// axios interceptor header nepošle a backend spadne na user.currentWorkspaceId
// z DB. Po prvom fetchWorkspaces() klient hodnotu nastaví a ďalšie requesty
// idú s headerom.

const isNativeIOSApp = () =>
  typeof navigator !== 'undefined' &&
  (/PrplCRM-iOS/.test(navigator.userAgent) ||
    !!(typeof window !== 'undefined' && window.webkit && window.webkit.messageHandlers));

const isPwaStandalone = () => {
  try {
    if (typeof window === 'undefined') return false;
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.navigator && window.navigator.standalone === true) return true;
    return false;
  } catch {
    return false;
  }
};

const usePersistentStorage = () => isNativeIOSApp() || isPwaStandalone();

const storage = () => (usePersistentStorage() ? localStorage : sessionStorage);

const KEY = 'currentWorkspaceId';

export const getStoredWorkspaceId = () => {
  try {
    return storage().getItem(KEY) || null;
  } catch {
    return null;
  }
};

export const setStoredWorkspaceId = (workspaceId) => {
  try {
    if (workspaceId) {
      storage().setItem(KEY, String(workspaceId));
    } else {
      storage().removeItem(KEY);
    }
  } catch {
    /* Private Browsing / quota — header sa nepošle, backend fallne na DB */
  }
};

export const removeStoredWorkspaceId = () => {
  try { sessionStorage.removeItem(KEY); } catch { /* noop */ }
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
};
