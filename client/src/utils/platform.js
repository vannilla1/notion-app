// Centralized platform detection so iOS-native gating is consistent.
// Detects whether the React app is running inside the native iOS WKWebView
// shell (vs a regular mobile/desktop browser).
//
// Two signals, either is sufficient:
//  1. Custom user agent suffix injected by Swift (`PrplCRM-iOS/...`)
//  2. window.webkit.messageHandlers — only present in WKWebView with
//     scriptMessageHandlers configured (which our Swift app does)
//
// Use this for hiding web-specific UI in the iOS native app:
//  - duplicate in-app notification toasts (APNs banner already shows them)
//  - "Enable browser notifications" prompts
//  - PWA install prompts
//  - service worker update banners
//  - cookie consent banners (handled at OS level for native apps)
//  - any "open in browser" or "install our app" UI

let cached;

export const isIosNativeApp = () => {
  if (cached !== undefined) return cached;
  try {
    cached = (
      /PrplCRM-iOS/.test(navigator.userAgent) ||
      !!(typeof window !== 'undefined' &&
         window.webkit &&
         window.webkit.messageHandlers)
    );
  } catch {
    cached = false;
  }
  return cached;
};

// Reset cache (only for tests)
export const __resetPlatformCache = () => { cached = undefined; mobileCached = undefined; };

// Mobile / tablet detection. Used to hide desktop-only UI like the Web Push
// notifications toggle:
//  - iOS native app uses APNs (not Web Push)
//  - Android native app uses FCM (not Web Push)
//  - iOS Safari doesn't support Web Push outside installed PWA
//  - Android Chrome supports Web Push but the native app is the recommended path
// Matches UA tokens for phones/tablets; treats everything else as desktop.
let mobileCached;
export const isMobileDevice = () => {
  if (mobileCached !== undefined) return mobileCached;
  try {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    mobileCached = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  } catch {
    mobileCached = false;
  }
  return mobileCached;
};
