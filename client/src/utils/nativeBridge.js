// Unified native bridge — Android Kotlin (window.NativeBridge) + iOS WKWebView
// (window.webkit.messageHandlers).
//
// Prečo centralizujeme: authStorage, workspaceStorage, AuthContext, push flow —
// všetky potrebujú detekovať natívne prostredie a posielať auth / workspace
// zmeny do natívnej vrstvy. Duplicitná detekcia v 4 súboroch bola pain na
// udržanie (user-agent substring sa ľahko preklepne).
//
// Android bridge zdrojový kód: android-native/.../WebAppInterface.kt
// iOS bridge zdrojový kód:     ios/PrplCRM/ContentView.swift
//
// Obidva sú best-effort — ak metóda neexistuje (stará verzia appky), voláme
// catch-all ktorý ticho zlyhá. Primárne je storage, NativeBridge je sekundárny
// security layer (encrypted prefs vs. localStorage).

// ── Detektory prostredia ──────────────────────────────────────────────────

export const isNativeIOSApp = () => {
  if (typeof window === 'undefined') return false;
  if (/PrplCRM-iOS/.test(navigator.userAgent)) return true;
  return !!(window.webkit && window.webkit.messageHandlers);
};

export const isNativeAndroidApp = () => {
  if (typeof window === 'undefined') return false;
  if (/PrplCRM-Android/.test(navigator.userAgent)) return true;
  // Android bridge sa injektuje synchronne pri WebView.addJavascriptInterface,
  // takže window.NativeBridge existuje hneď od prvého JS evaluácie v stránke.
  return !!(window.NativeBridge && typeof window.NativeBridge.isNativeApp === 'function');
};

export const isNativeApp = () => isNativeIOSApp() || isNativeAndroidApp();

// ── Android NativeBridge — safe wrappery ──────────────────────────────────
//
// Každá metóda skontroluje existenciu `window.NativeBridge` a konkrétnej
// funkcie, inak je no-op. Robí sa to preto, že:
//   1. Web tab (non-Android) jednoducho bridge nemá.
//   2. Staršia verzia Android appky môže mať chýbajúcu novšiu metódu.
//   3. Kotlin `@JavascriptInterface` metódy sú volané synchronne a vracajú
//      primitívy (String / Boolean) — žiadne sľuby, žiadny event bus.

const callBridge = (method, ...args) => {
  try {
    const nb = typeof window !== 'undefined' ? window.NativeBridge : null;
    if (!nb || typeof nb[method] !== 'function') return null;
    return nb[method](...args);
  } catch {
    // NativeBridge metóda hodila — neznámy dôvod, ticho pokračujeme.
    // Web appka má fallback cez localStorage/sessionStorage.
    return null;
  }
};

/** Pošle auth token do Android EncryptedSharedPreferences. No-op mimo Android. */
export const nativeSetAuthToken = (token) => {
  if (!isNativeAndroidApp()) return;
  callBridge('setAuthToken', token || '');
};

/** Zmaže všetky uložené credentials v natívnej vrstve (token + workspace + FCM cache). */
export const nativeClearAll = () => {
  if (!isNativeAndroidApp()) return;
  callBridge('clearAll');
};

/** Nastaví aktívny workspaceId v natívnej vrstve (používa sa pri switchi workspace). */
export const nativeSetWorkspaceId = (workspaceId) => {
  if (!isNativeAndroidApp()) return;
  callBridge('setCurrentWorkspaceId', workspaceId || '');
};

/** Platform identifier — pre debugging / analytics. */
export const nativePlatform = () => {
  if (isNativeAndroidApp()) return 'android-native';
  if (isNativeIOSApp()) return 'ios-native';
  return 'web';
};
