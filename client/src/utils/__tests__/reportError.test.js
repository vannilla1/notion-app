import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  maybeAutoReload, isChunkLoadError, reportError, chunkRecoveryContext, describeChunkRecovery,
  scheduleChunkRecoveryReset, trackRouteLoad, markChunkReloadBlocked, __resetChunkRecovery,
} from '../reportError';

/**
 * Zlyhanie lazy chunku — Diagnostika 23. 10. 2026 (Safari, /admin/dashboard):
 * 1) „undefined is not an object (evaluating 'e._result.default')“ — handler
 *    vite:preloadError s preventDefault() nechal import vyriešiť s undefined,
 * 2) „Importing a module script failed.“ — chunk zlyhal aj po reloade.
 * Stupne za 10 min: reload → (online) aktualizácia SW + reload → hlásenie.
 */
const SAFARI = 'Importing a module script failed.';
const CHROMIUM = 'Failed to fetch dynamically imported module: https://prplcrm.eu/assets/AdminPanel-x.js';

let reload;
let originalLocation;

beforeEach(() => {
  sessionStorage.clear();
  __resetChunkRecovery();
  reload = vi.fn();
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, pathname: '/admin/dashboard', reload },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  delete navigator.serviceWorker;
  delete navigator.onLine;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const stubServiceWorker = (registration) => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn().mockResolvedValue(registration), controller: {} },
  });
};

// Nové načítanie stránky = modulový stav sa vynuluje, sessionStorage ostáva.
const nextPageLoad = () => __resetChunkRecovery();

describe('isChunkLoadError', () => {
  it.each([
    SAFARI,
    CHROMIUM,
    'error loading dynamically imported module: https://prplcrm.eu/assets/AdminPanel-x.js',
    'Loading chunk 12 failed.',
    'ChunkLoadError: Loading chunk 3 failed',
    'Unable to preload CSS for /assets/AdminPanel-x.css',
  ])('rozpozná „%s“', (msg) => {
    expect(isChunkLoadError(msg)).toBe(true);
  });

  it('nezamení bežnú chybu ani prázdnu správu', () => {
    expect(isChunkLoadError("undefined is not an object (evaluating 'e._result.default')")).toBe(false);
    expect(isChunkLoadError('Failed to fetch')).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('maybeAutoReload', () => {
  it('ignoruje chyby, ktoré nie sú zlyhaním chunku', () => {
    expect(maybeAutoReload('TypeError: x is undefined')).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('1. zlyhanie: obyčajný reload, service worker sa nerieši', () => {
    const getRegistration = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration } });
    expect(maybeAutoReload(SAFARI)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it('druhé hlásenie tej istej chyby na tej istej stránke nepreskočí stupeň', () => {
    expect(maybeAutoReload(SAFARI)).toBe(true);
    expect(maybeAutoReload(SAFARI)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem('__prpl_chunk_recovery')).n).toBe(1);
  });

  it('2. zlyhanie: počká na aktiváciu nového service workera, až potom reload; cache nemaže', async () => {
    const cachesDelete = vi.fn();
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['workbox-precache-v2-x']), delete: cachesDelete });
    const listeners = [];
    const worker = { state: 'installing', addEventListener: (_e, fn) => listeners.push(fn) };
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker({ update, get installing() { return worker; }, waiting: null });

    expect(maybeAutoReload(SAFARI)).toBe(true);
    nextPageLoad();
    expect(maybeAutoReload(SAFARI)).toBe(true);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1); // čaká na nový worker

    worker.state = 'activated';
    listeners.forEach(fn => fn());
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(cachesDelete).not.toHaveBeenCalled();
  });

  it('2. zlyhanie bez nového service workera: reload hneď po update()', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker({ update, installing: null, waiting: null });
    maybeAutoReload(SAFARI);
    nextPageLoad();
    maybeAutoReload(SAFARI);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  it('zaseknutý service worker nezablokuje obnovenie (limit 20 s)', async () => {
    vi.useFakeTimers();
    stubServiceWorker({ update: () => new Promise(() => {}) });
    maybeAutoReload(SAFARI);
    nextPageLoad();
    maybeAutoReload(SAFARI);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(19000);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('nový worker, ktorý zlyhal (redundant), nečaká — reload hneď', async () => {
    stubServiceWorker({ update: vi.fn().mockResolvedValue(undefined), installing: { state: 'redundant', addEventListener: vi.fn() } });
    maybeAutoReload(SAFARI);
    nextPageLoad();
    maybeAutoReload(SAFARI);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  it('bez siete žiadny reload (skončil by na stránke prehliadača „bez pripojenia“), pokus sa nezapočíta', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    expect(maybeAutoReload(SAFARI)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('__prpl_chunk_recovery')).toBeNull();
  });

  it('posun hodín dozadu nezablokuje automatiku', () => {
    sessionStorage.setItem('__prpl_chunk_recovery', JSON.stringify({ first: Date.now() + 2 * 3600 * 1000, n: 2 }));
    expect(maybeAutoReload(SAFARI)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('3. zlyhanie: koniec automatiky — žiadny ďalší reload', async () => {
    maybeAutoReload(SAFARI);
    nextPageLoad();
    maybeAutoReload(SAFARI);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    nextPageLoad();
    expect(maybeAutoReload(SAFARI)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('zlyhania 35 s po sebe nevytvoria nekonečnú slučku', async () => {
    vi.useFakeTimers();
    let t = new Date('2026-10-23T17:51:44Z').getTime();
    let reloads = 0;
    for (let i = 0; i < 10; i += 1) {
      vi.setSystemTime(t);
      nextPageLoad();
      if (maybeAutoReload(SAFARI)) reloads += 1;
      await vi.advanceTimersByTimeAsync(10);
      t += 35000;
    }
    expect(reloads).toBe(2);
  });

  it('po 10 minútach začína znova od obyčajného reloadu', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T17:51:44Z'));
    maybeAutoReload(SAFARI);
    nextPageLoad();
    vi.setSystemTime(new Date('2026-10-23T18:02:00Z'));
    expect(maybeAutoReload(SAFARI)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('__prpl_chunk_recovery')).n).toBe(1);
  });

  it('nedostupný sessionStorage: bez automatiky, nikdy slučka', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(maybeAutoReload(SAFARI)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('kontext pre hlásenie popíše pokusy a stav service workera (aj ako text)', () => {
    stubServiceWorker({});
    maybeAutoReload(SAFARI);
    const ctx = chunkRecoveryContext();
    expect(ctx).toMatchObject({ attempts: 1, swControlled: true, route: '/admin/dashboard' });
    expect(typeof ctx.firstAttemptAgoMs).toBe('number');
    expect(describeChunkRecovery()).toMatch(/^attempts=1 online=1 sw=1 ago=\d+ms route=\/admin\/dashboard$/);
  });

  it('stránka 30 s bez chyby chunku vynuluje počítadlo (ďalší deploy dostane znova oba pokusy)', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('__prpl_chunk_recovery', JSON.stringify({ first: Date.now(), n: 2 }));
    scheduleChunkRecoveryReset();
    await vi.advanceTimersByTimeAsync(30000);
    expect(sessionStorage.getItem('__prpl_chunk_recovery')).toBeNull();
  });

  it('kým sa route ešte načítava (zaseknutý chunk), počítadlo sa nevynuluje', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('__prpl_chunk_recovery', JSON.stringify({ first: Date.now(), n: 1 }));
    trackRouteLoad(1);
    scheduleChunkRecoveryReset();
    await vi.advanceTimersByTimeAsync(45000);
    expect(JSON.parse(sessionStorage.getItem('__prpl_chunk_recovery')).n).toBe(1);
    trackRouteLoad(-1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionStorage.getItem('__prpl_chunk_recovery')).toBeNull();
  });

  it('2. pokus: ak používateľ medzitým odišiel na inú stránku, reload sa nespraví a pokus sa vráti', async () => {
    let resolveUpdate;
    stubServiceWorker({ update: () => new Promise((r) => { resolveUpdate = r; }), installing: null, waiting: null });
    maybeAutoReload(SAFARI);
    nextPageLoad();
    maybeAutoReload(SAFARI);
    await vi.waitFor(() => expect(resolveUpdate).toBeTypeOf('function'));
    window.location.pathname = '/crm';
    resolveUpdate();
    await vi.waitFor(() => expect(JSON.parse(sessionStorage.getItem('__prpl_chunk_recovery')).n).toBe(1));
    expect(reload).toHaveBeenCalledTimes(1);
    // návrat na pokazenú stránku: 2. pokus znova
    window.location.pathname = '/admin/dashboard';
    expect(maybeAutoReload(SAFARI)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('__prpl_chunk_recovery')).n).toBe(2);
  });

  it('zrušený reload (iOS shell): ďalšia chyba chunku znova dostane obnovu', () => {
    expect(maybeAutoReload(SAFARI)).toBe(true);   // reload zrušený, stránka žije ďalej
    expect(maybeAutoReload(SAFARI)).toBe(true);   // bez markChunkReloadBlocked by nič neurobil
    expect(JSON.parse(sessionStorage.getItem('__prpl_chunk_recovery')).n).toBe(1);
    markChunkReloadBlocked();
    expect(maybeAutoReload(SAFARI)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('__prpl_chunk_recovery')).n).toBe(2);
  });

  it('chyba chunku v tom istom načítaní počítadlo nechá (slučka sa musí zastaviť)', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('__prpl_chunk_recovery', JSON.stringify({ first: Date.now(), n: 2 }));
    scheduleChunkRecoveryReset();
    expect(maybeAutoReload(SAFARI)).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(JSON.parse(sessionStorage.getItem('__prpl_chunk_recovery')).n).toBe(2);
  });
});

describe('reportError a chunk chyby', () => {
  it('Chromium znenie chunk chyby sa nahlási (sieťový filter /Failed to fetch/ ho nezahodí)', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    reportError({ name: 'TypeError', message: CHROMIUM });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message).toBe(CHROMIUM);
  });

  it('obyčajné „Failed to fetch“ ostáva ignorované', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    reportError({ name: 'TypeError', message: 'Failed to fetch' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('main.jsx', () => {
  it('nemá handler vite:preloadError (preventDefault vracal undefined modul do React.lazy)', () => {
    const src = readFileSync(resolve(__dirname, '../../main.jsx'), 'utf8');
    expect(src).not.toMatch(/addEventListener\(\s*['"]vite:preloadError/);
  });
});
