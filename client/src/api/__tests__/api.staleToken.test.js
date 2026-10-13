import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Zmena hesla zvýši tokenVersion a server vráti nový token. Polling, ktorý
 * odišiel ešte so starým tokenom, dostane 401 — ten nesmie zmazať NOVÝ token
 * (používateľ by sa po zmene hesla náhodne odhlásil).
 */
const state = vi.hoisted(() => ({ token: 'jwt-old' }));
const removeStoredToken = vi.fn();
vi.mock('../../utils/authStorage', () => ({
  getStoredToken: () => state.token,
  removeStoredToken: (...a) => removeStoredToken(...a),
  isNativeIOSApp: () => false,
}));
vi.mock('../../utils/workspaceStorage', () => ({
  getStoredWorkspaceId: () => null,
  removeStoredWorkspaceId: vi.fn(),
}));

describe('api interceptor — 401 na request so starým tokenom', () => {
  let api, hrefSetter;

  beforeEach(async () => {
    vi.resetModules();
    removeStoredToken.mockClear();
    state.token = 'jwt-old';
    ({ default: api } = await import('../api'));
    hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/app', get href() { return 'http://localhost/app'; }, set href(v) { hrefSetter(v); } },
    });
  });

  const fail401AfterTokenSwap = async (config) => {
    // Kým request letel, zmena hesla uložila nový token.
    state.token = 'jwt-new';
    const err = new Error('Request failed with status code 401');
    err.config = config;
    err.response = { status: 401, data: { message: 'Token bol zneplatnený' }, headers: {}, config };
    err.isAxiosError = true;
    throw err;
  };

  it('starý token → 401 nezmaže nový token ani nepresmeruje', async () => {
    api.defaults.adapter = fail401AfterTokenSwap;
    await expect(api.get('/api/notifications/unread-count')).rejects.toBeTruthy();
    expect(removeStoredToken).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('aktuálny token → 401 odhlási ako doteraz', async () => {
    api.defaults.adapter = async (config) => {
      const err = new Error('Request failed with status code 401');
      err.config = config;
      err.response = { status: 401, data: {}, headers: {}, config };
      err.isAxiosError = true;
      throw err;
    };
    await expect(api.get('/api/contacts')).rejects.toBeTruthy();
    expect(removeStoredToken).toHaveBeenCalledTimes(1);
    expect(hrefSetter).toHaveBeenCalledWith('/login');
  });
});
