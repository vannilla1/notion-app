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
    // Filter out sensitive data
    beforeSend(event) {
      if (event.request?.data) {
        const data = event.request.data;
        if (data.password) data.password = '[FILTERED]';
        if (data.currentPassword) data.currentPassword = '[FILTERED]';
        if (data.newPassword) data.newPassword = '[FILTERED]';
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
