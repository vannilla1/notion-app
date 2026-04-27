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
import { getBreadcrumbs } from './breadcrumbs';

const DEDUP_WINDOW_MS = 30 * 1000;
const MAX_REPORTS_PER_SESSION = 50; // safety cap
const recentHashes = new Map(); // hash → timestamp
let reportCount = 0;

// Non-actionable chyby — Sentry ich mal v `ignoreErrors`. Najčastejšie sú
// to environmentálne problémy (AdBlock, slabá sieť, scroll observer race),
// nie naše bugy. Zahltili by dashboard bez hodnoty pre debug.
const IGNORED_PATTERNS = [
  /ResizeObserver loop/i,
  /ResizeObserver.*limit exceeded/i,
  /Non-Error promise rejection/i,
  /Load failed/i,
  /Failed to fetch/i,
  /NetworkError/i,
  /AbortError/i,
  /The operation was aborted/i,
  /Script error\.?$/i, // cross-origin script — nedáva stack, bez hodnoty
  // Service Worker registration rejections — typicky AdBlock/privacy extensions
  /^Rejected$/i,
  // iOS WKWebView specific — fetch zrušený pri zatvorení appky
  /cancelled/i
];

// Vite/PWA stale-chunk chyby — po deploy má user starý index.html ktorý
// odkazuje na chunk hash čo už neexistuje. Auto-reload načíta nové HTML
// s aktuálnymi hashmi, takže user nezostane na "broken" page.
const CHUNK_LOAD_PATTERNS = [
  /Importing a module script failed/i,
  /Failed to fetch dynamically imported module/i,
  /Loading chunk \d+ failed/i,
  /ChunkLoadError/i
];

const RELOAD_FLAG_KEY = '__prpl_chunk_reload';
const RELOAD_COOLDOWN_MS = 60 * 1000; // 1 min — zabráni reload-loopu

function isChunkLoadError(message) {
  return CHUNK_LOAD_PATTERNS.some(p => p.test(String(message || '')));
}

function maybeAutoReload(message) {
  if (!isChunkLoadError(message)) return false;
  try {
    // Reload-loop guard: nereload-uj ak už sme práve teraz reload-li.
    const last = parseInt(sessionStorage.getItem(RELOAD_FLAG_KEY) || '0', 10);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_FLAG_KEY, String(Date.now()));
    // location.reload(true) je deprecated, modern way:
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

function isIgnored(payload) {
  const msg = payload?.message || '';
  return IGNORED_PATTERNS.some(p => p.test(msg));
}

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
    if (isIgnored(payload)) return;
    const enriched = {
      name: payload.name || 'Error',
      message: String(payload.message).slice(0, 1000),
      stack: payload.stack ? String(payload.stack).slice(0, 10000) : undefined,
      componentStack: payload.componentStack ? String(payload.componentStack).slice(0, 5000) : undefined,
      line: payload.line,
      column: payload.column,
      url: location.href,
      userAgent: navigator.userAgent,
      release: import.meta.env.VITE_RELEASE_SHA || undefined,
      // Snímka posledných ~30 breadcrumbs (navigation, fetch, clicks, console).
      // Server ich uloží do ServerError.context.breadcrumbs.
      breadcrumbs: getBreadcrumbs()
    };

    if (!shouldSend(enriched)) return;
    reportCount += 1;

    const token = getStoredToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // MUSÍ byť absolútna URL — frontend beží na prplcrm.eu, API na
    // perun-crm-api.onrender.com. Relatívna `/api/errors/client` by
    // narazila na SPA catch-all v _redirects a dostala by index.html
    // s 200, takže by reporter hlásil úspech, ale backend by o chybe
    // nikdy nevedel. (Bug found after Sentry removal.)
    const apiBase = import.meta.env.VITE_API_URL || '';
    const endpoint = `${apiBase}/api/errors/client`;

    // keepalive: true aby sa request dokončil aj keď user zatvára tab,
    // alebo aj keď practicky immediately potom React padne do fallback UI.
    fetch(endpoint, {
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
    const message = err?.message || event.message || 'Unknown error';
    if (maybeAutoReload(message)) return; // chunk-load → reload, neposielaj report
    reportError({
      name: err?.name || 'Error',
      message,
      stack: err?.stack,
      line: event.lineno,
      column: event.colno
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    if (!reason) return;
    const message = reason instanceof Error
      ? (reason.message || 'Unhandled promise rejection')
      : (typeof reason === 'string' ? reason : JSON.stringify(reason).slice(0, 500));
    if (maybeAutoReload(message)) return;
    if (reason instanceof Error) {
      reportError({
        name: reason.name || 'UnhandledRejection',
        message,
        stack: reason.stack
      });
    } else {
      reportError({
        name: 'UnhandledRejection',
        message
      });
    }
  });
}
