/**
 * Breadcrumbs — ring buffer posledných N udalostí, ktoré sa pripoja k error
 * reportu. Nahrádza Sentry `addBreadcrumb` + autoinštrumentáciu (navigation,
 * fetch, console, UI events).
 *
 * Používa sa z reportError.js — vezme snímku a pošle s error payloadom
 * ako `context.breadcrumbs`.
 *
 * Dôvody vlastnej implementácie vs. Sentry:
 *  - Sentry bol odstránený kvôli iOS memory (Replay 10–20 MB) + GDPR.
 *  - Tento modul je < 1 KB gzipped, nebeží žiadna background queue,
 *    nič neposiela sám — len drží in-memory ring a dumpe sa pri errore.
 */

const MAX_BREADCRUMBS = 30;
const MAX_STRING_LEN = 200; // ochrana pred obrovskými payloadmi
const buf = [];

function push(entry) {
  try {
    buf.push({
      ts: Date.now(),
      ...entry
    });
    if (buf.length > MAX_BREADCRUMBS) buf.shift();
  } catch {
    // never throw from the instrumentation itself
  }
}

function truncate(s) {
  if (typeof s !== 'string') return s;
  if (s.length <= MAX_STRING_LEN) return s;
  return s.slice(0, MAX_STRING_LEN) + '…';
}

/**
 * Vráť kópiu bufferu (array). Volá sa pri error reporte.
 */
export function getBreadcrumbs() {
  return buf.slice();
}

/**
 * Manuálne pridanie breadcrumbu (napr. "user clicked Save" z UI logiky).
 */
export function addBreadcrumb({ category, message, level = 'info', data }) {
  push({
    category: category || 'manual',
    level,
    message: truncate(message),
    data
  });
}

/**
 * Inštaluje automatic breadcrumbs. Volá sa raz z main.jsx.
 *
 * Kategórie:
 *   - navigation  — pushState / replaceState / popstate (React Router)
 *   - fetch       — úspešné aj neúspešné HTTP requesty (method, url, status)
 *   - console     — console.error + console.warn
 *   - ui.click    — click eventy na <button>, <a>, [role="button"]
 *   - lifecycle   — page visibility (hidden/visible) a cold start
 */
export function installBreadcrumbInstrumentation() {
  if (typeof window === 'undefined') return;
  if (window.__prplBreadcrumbsInstalled) return;
  window.__prplBreadcrumbsInstalled = true;

  push({ category: 'lifecycle', level: 'info', message: 'app boot' });

  // 1) Navigation — patch history API + listen popstate
  try {
    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;
    window.history.pushState = function (...args) {
      push({ category: 'navigation', level: 'info', message: `push ${args[2] || ''}` });
      return origPush.apply(this, args);
    };
    window.history.replaceState = function (...args) {
      push({ category: 'navigation', level: 'info', message: `replace ${args[2] || ''}` });
      return origReplace.apply(this, args);
    };
    window.addEventListener('popstate', () => {
      push({ category: 'navigation', level: 'info', message: `pop ${location.pathname}${location.search}` });
    });
  } catch { /* noop */ }

  // 2) Fetch — patch globálne fetch
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input?.url || '');
        const method = (init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
        const start = Date.now();
        return origFetch.apply(this, arguments).then(res => {
          push({
            category: 'fetch',
            level: res.ok ? 'info' : 'warning',
            message: `${method} ${truncate(url)} → ${res.status}`,
            data: { duration_ms: Date.now() - start }
          });
          return res;
        }).catch(err => {
          push({
            category: 'fetch',
            level: 'error',
            message: `${method} ${truncate(url)} → ${err?.message || 'network error'}`,
            data: { duration_ms: Date.now() - start }
          });
          throw err;
        });
      };
    }
  } catch { /* noop */ }

  // 3) Console — iba error/warn (log/info sú noise)
  try {
    const origError = console.error;
    const origWarn = console.warn;
    console.error = function (...args) {
      push({
        category: 'console',
        level: 'error',
        message: truncate(args.map(a => typeof a === 'string' ? a : (a?.message || String(a))).join(' '))
      });
      return origError.apply(this, args);
    };
    console.warn = function (...args) {
      push({
        category: 'console',
        level: 'warning',
        message: truncate(args.map(a => typeof a === 'string' ? a : (a?.message || String(a))).join(' '))
      });
      return origWarn.apply(this, args);
    };
  } catch { /* noop */ }

  // 4) UI clicks — bubbling listener na document, zachytí všetky click-y
  try {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const clickable = t.closest('button, a, [role="button"]');
      if (!clickable) return;
      const label = (clickable.getAttribute('aria-label')
        || clickable.innerText
        || clickable.getAttribute('title')
        || clickable.tagName).toString().trim().replace(/\s+/g, ' ');
      push({
        category: 'ui.click',
        level: 'info',
        message: truncate(`${clickable.tagName.toLowerCase()}: ${label}`)
      });
    }, { capture: true, passive: true });
  } catch { /* noop */ }

  // 5) Visibility transitions
  try {
    document.addEventListener('visibilitychange', () => {
      push({ category: 'lifecycle', level: 'info', message: document.hidden ? 'hidden' : 'visible' });
    });
  } catch { /* noop */ }
}
