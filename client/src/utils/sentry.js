import * as Sentry from '@sentry/react';

const isNativeIOSApp = () => {
  try {
    return /PrplCRM-iOS/.test(navigator.userAgent) ||
           !!(window.webkit && window.webkit.messageHandlers);
  } catch {
    return false;
  }
};

const initSentry = () => {
  const dsn = import.meta.env.VITE_SENTRY_DSN;

  if (!dsn) {
    console.info('[Sentry] DSN not configured, frontend error tracking disabled');
    return;
  }

  // Skip Sentry in native iOS app — the Replay integration alone uses
  // 10-20MB of RAM, which combined with our JS bundle pushes WKWebView
  // over the memory limit → WebContent process jetsam → full reload
  // (the "scroll jumps to dashboard" bug). Native iOS errors are tracked
  // separately via APNs/TestFlight crash reports.
  if (isNativeIOSApp()) {
    console.info('[Sentry] Skipped in iOS native app (memory optimization)');
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE || 'development',
    // Capture 10% of transactions in production, 100% in dev
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
    // Capture 100% of errors always
    replaysOnErrorSampleRate: 1.0,
    // Capture 10% of sessions for replay in production
    replaysSessionSampleRate: import.meta.env.PROD ? 0.1 : 0,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: false,
      }),
    ],
    // Filter out sensitive data + drop non-actionable environment errors
    beforeSend(event, hint) {
      // 1) Password scrubbing
      if (event.request?.data) {
        const data = event.request.data;
        if (data.password) data.password = '[FILTERED]';
        if (data.currentPassword) data.currentPassword = '[FILTERED]';
        if (data.newPassword) data.newPassword = '[FILTERED]';
      }

      // 2) Service Worker registration rejections from /registerSW.js.
      //    Typicky ide o environmentálne príčiny na strane klienta
      //    (AdBlock/Privacy extensions blokujú SW, antivirus, corporate
      //    firewall, stale cached SW referencia po deploy-i). App funguje
      //    aj bez SW — stratí len offline cache. Tieto eventy nie sú
      //    actionable a iba zaplavujú Sentry.
      try {
        const err = hint?.originalException;
        const msg = (err && err.message) || event.exception?.values?.[0]?.value || '';
        const stack = (err && err.stack) || event.exception?.values?.[0]?.stacktrace?.frames?.map(f => f.filename).join(' ') || '';
        if (msg === 'Rejected' && /registerSW\.js/.test(stack)) {
          return null;
        }
      } catch {
        // never let the filter itself break Sentry
      }

      return event;
    },
    // Ignore common non-actionable errors
    ignoreErrors: [
      'ResizeObserver loop',
      'Non-Error promise rejection',
      'Load failed',
      'Failed to fetch',
      'NetworkError',
      'AbortError',
    ],
  });

  console.info('[Sentry] Frontend error tracking initialized');
};

// Set user context when user logs in
export const setSentryUser = (user) => {
  if (!import.meta.env.VITE_SENTRY_DSN) return;
  Sentry.setUser({
    id: user.id || user._id,
    username: user.username,
    email: user.email,
  });
};

// Clear user context on logout
export const clearSentryUser = () => {
  if (!import.meta.env.VITE_SENTRY_DSN) return;
  Sentry.setUser(null);
};

export default initSentry;
