/**
 * Client-side error reporter — posiela chyby do /api/errors/client,
 * ktoré sa zobrazia v Super Admin Panel → Diagnostics → Chyby.
 *
 * Zdroje chýb ktoré sem putujú:
 *   1) React render errory cez ErrorBoundary.componentDidCatch
 *   2) Unhandled JS chyby cez window.addEventListener('error')
 *   3) Neošetrené promise rejections cez 'unhandledrejection'
 *
 * Dedup: rovnaký error.message z rovnakej URL za posledných 30s sa
 * neposiela znovu (zabráni flood-u pri infinite render loop-e ako bol
 * Dashboard TDZ bug).
 *
 * Bezpečnosť: fire-and-forget, neblokuje UI, nikdy nehádže.
 * Ak beží natívna iOS WKWebView appka, pošle sa cez fetch rovnako —
 * backend pod tou istou doménou.
 */

import { getStoredToken } from './authStorage';

const DEDUP_WINDOW_MS = 30 * 1000;
const MAX_REPORTS_PER_SESSION = 50; // safety cap
const recentHashes = new Map(); // hash → timestamp
let reportCount = 0;

function hashKey(payload) {
  // Jednoduchý kľúč — message + first line of stack + pathname
  const stackFirstLine = (payload.stack || '').split('\n')[0] || '';
  let pathname = '';
  try { pathname = new URL(payload.url || location.href).pathname; } catch {}
  return `${payload.message}|${stackFirstLine}|${pathname}`;
}

function shouldSend(payload) {
  if (reportCount >= MAX_REPORTS_PER_SESSION) return false;
  const key = hashKey(payload);
  const now = Date.now();
  const last = recentHashes.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return false;
  recentHashes.set(key, now);
  // Občasné čistenie aby Map neviazla
  if (recentHashes.size > 100) {
    for (const [k, ts] of recentHashes) {
      if (now - ts > DEDUP_WINDOW_MS) recentHashes.delete(k);
    }
  }
  return true;
}

/**
 * @param {object} payload
 * @param {string} payload.message
 * @param {string} [payload.name]
 * @param {string} [payload.stack]
 * @param {string} [payload.componentStack]
 * @param {number} [payload.line]
 * @param {number} [payload.column]
 */
export function reportError(payload) {
  try {
    if (!payload || !payload.message) return;
    const enriched = {
      name: payload.name || 'Error',
      message: String(payload.message).slice(0, 1000),
      stack: payload.stack ? String(payload.stack).slice(0, 10000) : undefined,
      componentStack: payload.componentStack ? String(payload.componentStack).slice(0, 5000) : undefined,
      line: payload.line,
      column: payload.column,
      url: location.href,
      userAgent: navigator.userAgent,
      release: import.meta.env.VITE_RELEASE_SHA || undefined
    };

    if (!shouldSend(enriched)) return;
    reportCount += 1;

    const token = getStoredToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // keepalive: true aby sa request dokončil aj keď user zatvára tab,
    // alebo aj keď practicky immediately potom React padne do fallback UI.
    fetch('/api/errors/client', {
      method: 'POST',
      headers,
      body: JSON.stringify(enriched),
      keepalive: true,
      credentials: 'omit'
    }).catch(() => { /* best-effort, never re-throw */ });
  } catch {
    // reporter sa nesmie sám rozbiť
  }
}

/**
 * Napojí globálne browser listenery. Volá sa raz z main.jsx.
 */
export function installGlobalErrorHandlers() {
  if (typeof window === 'undefined') return;
  if (window.__prplErrorHandlersInstalled) return;
  window.__prplErrorHandlersInstalled = true;

  window.addEventListener('error', (event) => {
    // ResourceLoad errory (img, script) nemajú event.error — ignoruj
    if (!event?.error && !event?.message) return;
    const err = event.error;
    reportError({
      name: err?.name || 'Error',
      message: err?.message || event.message || 'Unknown error',
      stack: err?.stack,
      line: event.lineno,
      column: event.colno
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    if (!reason) return;
    if (reason instanceof Error) {
      reportError({
        name: reason.name || 'UnhandledRejection',
        message: reason.message || 'Unhandled promise rejection',
        stack: reason.stack
      });
    } else {
      reportError({
        name: 'UnhandledRejection',
        message: typeof reason === 'string' ? reason : JSON.stringify(reason).slice(0, 500)
      });
    }
  });
}
