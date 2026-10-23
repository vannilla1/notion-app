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
  /Importing a module script failed/i,            // Safari
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i,   // Firefox
  /Loading chunk \d+ failed/i,
  /ChunkLoadError/i,
  /Unable to preload CSS/i                        // Vite preload CSS lazy route
];

const RECOVERY_KEY = '__prpl_chunk_recovery';
const RECOVERY_WINDOW_MS = 10 * 60 * 1000; // najviac 2 automatické pokusy za 10 min
// Workbox sťahuje precache po jednom súbore — na pomalej sieti trvá inštalácia
// novej verzie aj 10+ s (overené: 29 zmenených súborov, 1,3 MB).
const SW_ACTIVATE_TIMEOUT_MS = 20000;
const STABLE_RESET_MS = 30000;
// Jedna obnova na jedno načítanie stránky (boundary + globálny handler by
// inak tú istú chybu započítali dvakrát a preskočili stupeň).
let recoveryScheduled = false;
let chunkErrorThisLoad = false;
// Počet práve zobrazených „Načítavam…“ pri načítaní route (Suspense fallback)
// — zaseknutý chunk ešte nie je dôkaz, že stránka funguje.
let pendingRouteLoads = 0;

export function trackRouteLoad(delta) {
  pendingRouteLoads = Math.max(0, pendingRouteLoads + delta);
}

export function isChunkLoadError(message) {
  return CHUNK_LOAD_PATTERNS.some(p => p.test(String(message || '')));
}

function readRecovery() {
  try {
    const s = JSON.parse(sessionStorage.getItem(RECOVERY_KEY) || 'null');
    return s && typeof s.first === 'number' && typeof s.n === 'number' ? s : null;
  } catch {
    return null;
  }
}

// 2. pokus: obyčajný reload nepomohol. Ak je na serveri novší service worker
// (deploy), update() ho nainštaluje a počkáme na aktiváciu (skipWaiting +
// clientsClaim) — reload potom dostane aktuálny index.html z jeho precache.
// Precache zámerne NEmažeme: pri nezmenenom sw.js by sa už nenaplnil (stratil
// by sa offline štart) a workbox pri chýbajúcej položke aj tak siahne na sieť.
async function refreshServiceWorker() {
  const work = (async () => {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (!reg) return;
    await reg.update();
    const worker = reg.installing || reg.waiting;
    if (!worker || worker.state === 'activated' || worker.state === 'redundant') return;
    await new Promise((resolve) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' || worker.state === 'redundant') resolve();
      });
    });
  })().catch(() => { /* SW nedostupný / update zlyhal — reload aj tak */ });
  await Promise.race([work, new Promise(resolve => setTimeout(resolve, SW_ACTIVATE_TIMEOUT_MS))]);
}

// Exportované aj pre RouteErrorBoundary (App.jsx) — React v produkcii chyby
// zachytené boundary NEposiela na window 'error', takže zlyhanie lazy chunku
// po deployi by inak skončilo v červenom okne namiesto auto-reloadu.
// Stupne za 10 min: 1) obyčajný reload, 2) (len online) aktualizovať service
// worker a reload, 3) koniec — hlásenie do Diagnostiky + okno „Obnoviť stránku“.
// Diagnostika 23. 10. 2026 (Safari, /admin/dashboard): chunk zlyhal opakovane.
export function maybeAutoReload(message) {
  if (!isChunkLoadError(message)) return false;
  chunkErrorThisLoad = true;
  if (recoveryScheduled) return true;
  // Bez siete reload nepomôže — skončil by na stránke prehliadača „bez
  // pripojenia“ (a stratil rozpísaný formulár); okno s tlačidlom je lepšie.
  if (navigator.onLine === false) return false;
  try {
    const now = Date.now();
    let state = readRecovery();
    if (!state || now < state.first || now - state.first > RECOVERY_WINDOW_MS) state = { first: now, n: 0 };
    if (state.n === 0) {
      sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ first: state.first, n: 1 }));
      recoveryScheduled = true;
      window.location.reload();
      return true;
    }
    if (state.n === 1) {
      sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ first: state.first, n: 2 }));
      recoveryScheduled = true;
      const route = window.location.pathname;
      refreshServiceWorker().finally(() => {
        if (window.location.pathname === route) {
          window.location.reload();
          return;
        }
        // Používateľ medzitým odišiel na inú (funkčnú) stránku — reload by mu
        // zahodil rozpísané údaje. Návrat na pokazenú stránku spustí 2. pokus znova.
        recoveryScheduled = false;
        try { sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ first: state.first, n: 1 })); } catch { /* noop */ }
      });
      return true;
    }
    return false;
  } catch {
    return false; // sessionStorage nedostupný → bez automatiky, nikdy slučka
  }
}

// Úspešná obnova: stránka beží 30 s bez chyby chunku → počítadlo pokusov
// späť na nulu, aby ďalší (nesúvisiaci) deploy znova dostal obe automatické
// pokusy. Chyba v tomto načítaní počítadlo nechá (inak by sa slučka nezastavila).
export function scheduleChunkRecoveryReset() {
  const check = () => {
    if (chunkErrorThisLoad || recoveryScheduled) return;
    if (pendingRouteLoads > 0) { setTimeout(check, 5000); return; } // chunk sa ešte načítava
    try { sessionStorage.removeItem(RECOVERY_KEY); } catch { /* storage nedostupný */ }
  };
  setTimeout(check, STABLE_RESET_MS);
}

// Naplánovaný reload sa neuskutočnil (iOS shell ho zrušil a otvoril Safari).
// Ďalšia chyba chunku na tejto stránke musí znova dostať normálnu obnovu.
export function markChunkReloadBlocked() {
  recoveryScheduled = false;
}

// Kontext k hláseniu, keď automatická obnova nepomohla — Safari pri tejto
// chybe neposiela URL ani stack, príčinu treba čítať z okolností.
export function chunkRecoveryContext() {
  const state = readRecovery();
  let swControlled = false;
  try { swControlled = !!navigator.serviceWorker?.controller; } catch { /* noop */ }
  return {
    online: navigator.onLine,
    swControlled,
    attempts: state ? state.n : 0,
    firstAttemptAgoMs: state ? Date.now() - state.first : null,
    route: typeof location !== 'undefined' ? location.pathname : ''
  };
}

// Server ukladá z breadcrumbs len text (nie `data`), preto kontext ako text.
export function describeChunkRecovery() {
  const c = chunkRecoveryContext();
  return `attempts=${c.attempts} online=${c.online ? 1 : 0} sw=${c.swControlled ? 1 : 0}`
    + ` ago=${c.firstAttemptAgoMs ?? '-'}ms route=${c.route}`;
}

// Len pre testy.
export function __resetChunkRecovery() {
  recoveryScheduled = false;
  chunkErrorThisLoad = false;
  pendingRouteLoads = 0;
}

function isIgnored(payload) {
  const msg = payload?.message || '';
  return IGNORED_PATTERNS.some(p => p.test(msg));
}

// Schémy rozšírení prehliadača — chyby z nich nie sú naše.
const EXTENSION_SCHEMES = /^(chrome-extension|moz-extension|safari-extension|safari-web-extension|webkit-masked-url):/i;

/**
 * Chyby z CUDZÍCH skriptov (rozšírenia prehliadača, skripty injektované
 * botmi/prekladačmi) — nie sú naše a v Diagnostike len šumia. Sentry ich
 * filtroval automaticky, in-house tracker to potrebuje tiež.
 *
 * Poznávací znak: PRVÝ stack frame s pozíciou (zdroj:riadok:stĺpec)
 * nepochádza z nášho originu, ale z `<anonymous>:N:N` (injektovaný skript),
 * `*-extension://` schémy alebo cudzieho originu. Natívne volania ako
 * "at JSON.stringify (<anonymous>)" pozíciu NEMAJÚ — tie preskakujeme,
 * rozhoduje prvý lokalizovaný frame. Reálny príklad z produkcie: rozšírenie
 * prepísalo appendChild a JSON.stringify-ovalo DOM (cyklická React fiber
 * referencia) — v stacku boli aj naše react-vendor frame-y (React volal
 * prepísané API), ale PRVÝ lokalizovaný frame bol <anonymous>:25:21.
 *
 * Pri pochybnostiach (neparsovateľný stack, žiadny lokalizovaný frame)
 * vraciame false — radšej reportovať než potichu stratiť reálnu chybu.
 */
function isThirdPartyStack(stack) {
  if (!stack) return false;
  try {
    for (const raw of String(stack).split('\n')) {
      const line = raw.trim();
      // Zdroj frame-u: Chrome "at fn (src:l:c)" / "at src:l:c",
      // Firefox+Safari "fn@src:l:c"
      let src = null;
      if (line.startsWith('at ')) {
        const m = line.match(/\(([^()]*)\)\s*$/);
        src = m ? m[1] : line.slice(3).trim();
      } else {
        const atIdx = line.lastIndexOf('@');
        if (atIdx !== -1) src = line.slice(atIdx + 1).trim();
      }
      if (!src) continue; // riadok správy / neznámy formát
      if (!/:\d+:\d+$/.test(src)) continue; // natívny frame bez pozície — preskoč
      const cleaned = src.replace(/:\d+:\d+$/, '');
      if (cleaned === '<anonymous>') return true; // injektovaný skript
      if (EXTENSION_SCHEMES.test(cleaned)) return true; // rozšírenie
      // Prvý lokalizovaný frame s URL — rozhoduje jeho origin
      try {
        const u = new URL(cleaned, location.href);
        return u.origin !== location.origin;
      } catch {
        return false; // neparsovateľné — radšej reportuj
      }
    }
  } catch { /* heuristika sa nesmie sama rozbiť */ }
  return false;
}

/**
 * Verzia pre Diagnostiku. VITE_RELEASE_SHA v builde nie je nastavené, takže
 * doteraz išli VŠETKY JS chyby ako 'web' — aj tie, ktoré vznikli vnútri
 * natívnych shellov (tie načítavajú ten istý bundle z prplcrm.eu). V paneli
 * sa potom nedalo rozlíšiť „padá to na webe" od „padá to v appke".
 * Verziu vieme z UA suffixu, ktorý si shelly pridávajú samy:
 * `PrplCRM-iOS/<verzia>` a `PrplCRM-Android/<verzia>`.
 */
function resolveRelease() {
  try {
    if (import.meta.env.VITE_RELEASE_SHA) return import.meta.env.VITE_RELEASE_SHA;
    const m = String(navigator.userAgent).match(/PrplCRM-(iOS|Android)\/([\w.]+)/);
    return m ? `${m[1].toLowerCase()}-${m[2]}` : undefined;
  } catch {
    return undefined;
  }
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
 * URL pre report BEZ citlivých tokenov. Plné location.href by do DB chýb
 * (ServerError, admin Diagnostika, zálohy) ukladalo ako plaintext:
 *   - session JWT z OAuth callbacku (/auth/callback#token=JWT),
 *   - jednorazový token resetu hesla (/reset-password?token=),
 *   - token pozvánky (/invite/:token, /login?invite=).
 * Hash sa zahodí celý, známe query kľúče sa prepíšu, token v ceste /invite/
 * sa nahradí. hashKey() aj server (serverErrorService) používajú len pathname,
 * takže dedup/fingerprint ďalej fungujú (všetky pozvánky sa zlúčia — žiaduce).
 */
function safeUrl() {
  try {
    const u = new URL(location.href);
    u.hash = '';
    for (const k of ['token', 'invite', 'code']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, '[redacted]');
    }
    u.pathname = u.pathname.replace(/^\/invite\/[^/]+/, '/invite/[redacted]');
    return u.toString();
  } catch {
    try { return location.pathname; } catch { return ''; }
  }
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
    // Chunk chyba sem príde len keď automatická obnova nepomohla — hlásiť aj
    // Chromium znenie, ktoré inak zachytí sieťový filter /Failed to fetch/.
    if (!isChunkLoadError(payload.message) && isIgnored(payload)) return;
    if (isThirdPartyStack(payload.stack)) return; // rozšírenia/injektované skripty — nie naša chyba
    const enriched = {
      name: payload.name || 'Error',
      message: String(payload.message).slice(0, 1000),
      stack: payload.stack ? String(payload.stack).slice(0, 10000) : undefined,
      componentStack: payload.componentStack ? String(payload.componentStack).slice(0, 5000) : undefined,
      line: payload.line,
      column: payload.column,
      url: safeUrl(),
      userAgent: navigator.userAgent,
      release: resolveRelease(),
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

// Popis ne-Error dôvodu rejectu. JSON.stringify hádže pre cyklický objekt
// (axios config, DOM uzol, React fiber) alebo BigInt — a bežal priamo
// v 'unhandledrejection' listeneri, mimo try bloku reportError. Vznikla tak
// druhá window 'error' udalosť ("Converting circular structure to JSON")
// a pôvodná príčina sa do Diagnostiky nedostala.
function describeReason(r) {
  try {
    return JSON.stringify(r).slice(0, 500);
  } catch {
    try { return String(r).slice(0, 500); } catch { return 'Unserializable rejection reason'; }
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
      : (typeof reason === 'string' ? reason : describeReason(reason));
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
