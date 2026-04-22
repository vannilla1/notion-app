// Per-device workspace ID storage.
//
// Prečo: backend (server/middleware/workspace.js) od teraz rešpektuje
// `X-Workspace-Id` header od klienta ako ground truth pre workspace
// context requestu. Každé zariadenie (desktop tab, iOS appka, Android
// appka, PWA) má svoj vlastný "current workspace" — žiadne multi-device
// interferencie.
//
// Storage stratégia — duálna (sessionStorage + localStorage):
//
//   Read priority (getStoredWorkspaceId):
//     1. sessionStorage — per-tab state (dva taby = dva workspace-y)
//     2. localStorage   — device-wide fallback (nový tab v tom istom
//                         prehliadači nepadne na polluted DB default)
//     3. null           — úplne nové zariadenie → fallback na DB default
//
//   Write (setStoredWorkspaceId):
//     Zapisujeme do OBIDVOCH, aby:
//       - refresh v súčasnom tabe čítal sessionStorage (okamžitý)
//       - nový tab čítal localStorage (device-wide remembrance)
//
// Prečo nie iba localStorage: dva taby v jednom prehliadači by si prepisovali
// workspace. sessionStorage per-tab chráni voľbu aktívneho tabu.
//
// Prečo nie iba sessionStorage: desktop bez localStorage fallbacku padá na
// `User.currentWorkspaceId` v DB, ktorý môže byť stale (iný device nastavil
// iné workspace). User-visible bug: "refresh na desktope ma prehodil na
// workspace z iOS".
//
// Native appky (iOS WKWebView, Android TWA, PWA standalone): rovnaký dual
// pattern funguje — sessionStorage + localStorage v jednej webview instancii
// sa správa rovnako ako localStorage (nie je multi-tab). navyše
// `nativeSetWorkspaceId` zrkadlí hodnotu do Android/iOS keystore.

import {
  isNativeIOSApp as _isNativeIOSApp,
  isNativeAndroidApp,
  nativeSetWorkspaceId
} from './nativeBridge';

const isNativeIOSApp = _isNativeIOSApp;
const isNativeApp = () => isNativeIOSApp() || isNativeAndroidApp();

const KEY = 'currentWorkspaceId';

const safeGet = (store) => {
  try { return store?.getItem(KEY) || null; } catch { return null; }
};

const safeSet = (store, value) => {
  try {
    if (value) store?.setItem(KEY, String(value));
    else store?.removeItem(KEY);
  } catch { /* Private Browsing / quota */ }
};

export const getStoredWorkspaceId = () => {
  if (typeof window === 'undefined') return null;
  // 1) sessionStorage má priority — tab-špecifický state.
  // 2) localStorage fallback — device-wide (zachováva voľbu pri novom tabe
  //    alebo keď sessionStorage vyprší).
  return safeGet(window.sessionStorage) || safeGet(window.localStorage);
};

export const setStoredWorkspaceId = (workspaceId) => {
  if (typeof window !== 'undefined') {
    // Dual-write: sessionStorage (per-tab authority) + localStorage (device-wide
    // fallback pre nový tab / refresh s vyexpirovaným session-om).
    safeSet(window.sessionStorage, workspaceId);
    safeSet(window.localStorage, workspaceId);
  }
  // Write-through do natívnej Android/iOS vrstvy — MainActivity pri cold-start
  // injectne tento workspaceId späť do localStorage, takže appka vidí
  // správny workspace bez re-fetch z DB.
  nativeSetWorkspaceId(workspaceId);
};

export const removeStoredWorkspaceId = () => {
  try { sessionStorage.removeItem(KEY); } catch { /* noop */ }
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
};

// Exposed for diagnostics / tests.
export const _internal = { isNativeApp };
