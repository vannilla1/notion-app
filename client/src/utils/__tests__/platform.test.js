import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isIosNativeApp, isNativeApp, __resetPlatformCache } from '../platform';
import { isNativeIOSApp } from '../nativeBridge';

/**
 * Detekcia iOS shellu musí spoznať LEN našu appku — UA suffix zo Swiftu
 * alebo náš WKScriptMessageHandler `iosNative`. Do 9/2026 stačila samotná
 * existencia window.webkit.messageHandlers, ktorú má každý WKWebView
 * s hocijakým handlerom (Gmail/Outlook/LinkedIn in-app prehliadač na iOS,
 * shimy v cudzích Android appkách). Web otvorený z takého prehliadača sa
 * potom správal ako iOS appka (IAP namiesto Stripe, skrytý cookie banner,
 * vypnutá analytika) a VitePWA registrácia SW hlásila do Diagnostiky
 * "SW disabled in iOS native app" z prostredia, ktoré vôbec nebolo naše.
 */
const ORIGINAL_UA = navigator.userAgent;

const setUserAgent = (ua) => {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
};

describe('isIosNativeApp', () => {
  beforeEach(() => {
    __resetPlatformCache();
    delete window.webkit;
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148');
  });

  afterEach(() => {
    __resetPlatformCache();
    delete window.webkit;
    setUserAgent(ORIGINAL_UA);
  });

  it('spozná náš shell podľa UA suffixu zo Swiftu', () => {
    setUserAgent('PrplCRM-iOS/1.0 Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)');
    expect(isIosNativeApp()).toBe(true);
    expect(isNativeIOSApp()).toBe(true);
    expect(isNativeApp()).toBe(true);
  });

  it('spozná náš shell podľa handlera iosNative (starší UA bez suffixu)', () => {
    window.webkit = { messageHandlers: { iosNative: { postMessage() {} } } };
    expect(isIosNativeApp()).toBe(true);
    expect(isNativeIOSApp()).toBe(true);
  });

  it('cudzí WKWebView s vlastnými handlermi (Gmail/Outlook in-app) NIE je naša appka', () => {
    window.webkit = { messageHandlers: { gmailBridge: { postMessage() {} } } };
    expect(isIosNativeApp()).toBe(false);
    expect(isNativeIOSApp()).toBe(false);
    expect(isNativeApp()).toBe(false);
  });

  it('prázdne messageHandlers (shim) NIE je naša appka', () => {
    window.webkit = { messageHandlers: {} };
    expect(isIosNativeApp()).toBe(false);
    expect(isNativeIOSApp()).toBe(false);
  });

  it('bežný Safari bez window.webkit nie je naša appka', () => {
    expect(isIosNativeApp()).toBe(false);
    expect(isNativeIOSApp()).toBe(false);
  });
});

/**
 * Diagnostika musí rozlíšiť chybu z webu od chyby z natívnej appky.
 * Do 9/2026 išli všetky JS chyby ako release 'web' (VITE_RELEASE_SHA nie je
 * v builde nastavené), hoci shelly načítavajú ten istý bundle — v paneli sa
 * potom nedalo povedať, či padá web alebo appka.
 */
describe('reportError → release z user agenta', () => {
  const ORIGINAL = navigator.userAgent;
  const send = async (ua) => {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const { reportError } = await import('../reportError');
    // Stack musí ukazovať na náš origin, inak ho isThirdPartyStack zahodí.
    reportError({ message: `boom ${ua.slice(0, 12)} ${Math.random()}`, stack: `Error: boom\n    at x (${location.origin}/app:1:1)` });
    expect(fetchMock).toHaveBeenCalled();
    return JSON.parse(fetchMock.mock.calls[0][1].body);
  };

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: ORIGINAL, configurable: true });
    vi.unstubAllGlobals();
  });

  it('iOS shell → release ios-<verzia>', async () => {
    const body = await send('PrplCRM-iOS/1.0.19.79 Mozilla/5.0 (iPhone)');
    expect(body.release).toBe('ios-1.0.19.79');
  });

  it('Android shell → release android-<verzia>', async () => {
    const body = await send('Mozilla/5.0 (Linux; Android 16) PrplCRM-Android/1.0.9');
    expect(body.release).toBe('android-1.0.9');
  });

  it('web → bez release (server doplní "web")', async () => {
    const body = await send('Mozilla/5.0 (Macintosh) Chrome/152.0.0.0 Safari/537.36');
    expect(body.release).toBeUndefined();
  });
});
