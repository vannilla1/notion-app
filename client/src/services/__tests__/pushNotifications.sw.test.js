import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Web push a PWA worker musia zdieľať JEDNU registráciu (/sw.js).
 *
 * Do 9/2026 registroval klient /sw-push.js na scope '/', kde už bežal
 * workbox /sw.js od VitePWA. Scope má len jednu registráciu, takže si skripty
 * striedavo prepisovali: po zapnutí notifikácií bežal /sw-push.js, po ďalšom
 * načítaní stránky ho inline registrácia prepla späť na /sw.js — a ten nemal
 * push handler. Subscription na serveri ostala, notifikácie sa nezobrazovali.
 * Overené 22. 9. 2026 v Chrome na lokálnom dist buildе.
 */
vi.mock('../../api/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../utils/platform', () => ({ isIosNativeApp: () => false }));

const makeRegistration = (scriptURL) => ({
  scope: 'http://localhost/',
  active: { scriptURL, state: 'activated' },
  pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn() }
});

describe('getPushRegistration', () => {
  let register, getRegistration;

  beforeEach(() => {
    register = vi.fn();
    getRegistration = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register, getRegistration, ready: Promise.resolve(), addEventListener: vi.fn() }
    });
    vi.stubGlobal('PushManager', function PushManager() {});
    vi.stubGlobal('Notification', { permission: 'granted' });
  });

  afterEach(() => {
    delete navigator.serviceWorker;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('použije existujúcu registráciu /sw.js a NIČ neregistruje', async () => {
    const existing = makeRegistration('http://localhost/sw.js');
    getRegistration.mockResolvedValue(existing);
    const { getPushRegistration } = await import('../pushNotifications');

    const reg = await getPushRegistration();

    expect(reg).toBe(existing);
    expect(getRegistration).toHaveBeenCalledWith('/');
    expect(register).not.toHaveBeenCalled();
  });

  it('bez registrácie zaregistruje /sw.js — nikdy samostatný /sw-push.js', async () => {
    getRegistration.mockResolvedValue(undefined);
    register.mockResolvedValue(makeRegistration('http://localhost/sw.js'));
    const { getPushRegistration } = await import('../pushNotifications');

    await getPushRegistration();

    expect(register).toHaveBeenCalledTimes(1);
    const [script, opts] = register.mock.calls[0];
    expect(script).toBe('/sw.js');
    expect(opts).toEqual({ scope: '/' });
    expect(script).not.toMatch(/sw-push/);
  });

  it('isSubscribedToPush číta subscription z registrácie scope "/"', async () => {
    const existing = makeRegistration('http://localhost/sw.js');
    existing.pushManager.getSubscription.mockResolvedValue({ endpoint: 'https://push.example/abc' });
    getRegistration.mockResolvedValue(existing);
    const { isSubscribedToPush } = await import('../pushNotifications');

    await expect(isSubscribedToPush()).resolves.toBe(true);
    expect(getRegistration).toHaveBeenCalledWith('/');
  });
});

describe('build: jeden worker', () => {
  it('sw-push.js sa už nikde neregistruje samostatne', async () => {
    // jsdom prepisuje import.meta.url na http://, preto cesta cez process.cwd() (= client/)
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/pushNotifications.js'), 'utf8');
    expect(src).not.toMatch(/register\(\s*['"]\/sw-push\.js/);
    const vite = fs.readFileSync(path.join(process.cwd(), 'vite.config.js'), 'utf8');
    expect(vite).toMatch(/importScripts:\s*\[\s*['"]sw-push\.js['"]\s*\]/);
  });
});
