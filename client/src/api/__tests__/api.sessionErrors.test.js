import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Odhlasovanie v axios interceptore.
 *
 * Invariant: klient smie zmazať token a poslať používateľa na /login LEN pri
 * HTTP 401. Do 9/2026 to robil aj pri 403 — a server posiela 403 pri limite
 * plánu (PLAN_LIMIT, FEATURE_NOT_IN_PLAN, STORAGE_LIMIT), pri chýbajúcej role
 * aj pri WORKSPACE_OVER_LIMIT. Free používateľ, ktorý narazil na limit, bol
 * teda namiesto UpgradeModalu odhlásený (a v Android appke sa mu zmazal
 * TokenStore + zrušil Block Store token).
 */
const removeStoredToken = vi.fn();
vi.mock('../../utils/authStorage', () => ({
  getStoredToken: () => 'jwt-test',
  removeStoredToken: (...a) => removeStoredToken(...a),
  isNativeIOSApp: () => false,
}));
vi.mock('../../utils/workspaceStorage', () => ({
  getStoredWorkspaceId: () => null,
  removeStoredWorkspaceId: vi.fn(),
}));

const respond = (status, data = {}) => async (config) => {
  const err = new Error(`Request failed with status code ${status}`);
  err.config = config;
  err.response = { status, data, headers: {}, config };
  err.isAxiosError = true;
  throw err;
};

describe('api interceptor — kedy sa odhlasuje', () => {
  let api, isSessionInvalidError, hrefSetter, planGateEvents, onPlanGate;

  beforeEach(async () => {
    vi.resetModules();
    removeStoredToken.mockClear();
    ({ default: api, isSessionInvalidError } = await import('../api'));
    hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/app', get href() { return 'http://localhost/app'; }, set href(v) { hrefSetter(v); } },
    });
    planGateEvents = [];
    onPlanGate = (e) => planGateEvents.push(e.detail);
    window.addEventListener('plan-gate', onPlanGate);
  });

  afterEach(() => {
    window.removeEventListener('plan-gate', onPlanGate);
    vi.restoreAllMocks();
  });

  it('isSessionInvalidError je true len pre 401', () => {
    expect(isSessionInvalidError({ response: { status: 401 } })).toBe(true);
    for (const status of [400, 403, 404, 429, 500, 502, 503]) {
      expect(isSessionInvalidError({ response: { status } })).toBe(false);
    }
    expect(isSessionInvalidError({ code: 'ERR_NETWORK' })).toBe(false);
    expect(isSessionInvalidError(undefined)).toBe(false);
  });

  it('401 → zmaže token a presmeruje na /login', async () => {
    api.defaults.adapter = respond(401, { message: 'Neplatný alebo expirovaný token' });
    await expect(api.get('/api/contacts')).rejects.toBeTruthy();
    expect(removeStoredToken).toHaveBeenCalledTimes(1);
    expect(hrefSetter).toHaveBeenCalledWith('/login');
  });

  it('401 z prihlasovacieho endpointu (zlé heslo na /admin) → existujúcu session nemaže ani nepresmeruje', async () => {
    api.defaults.adapter = respond(401, { message: 'Nesprávne heslo' });
    await expect(api.post('/api/admin/login', { password: 'x' })).rejects.toBeTruthy();
    expect(removeStoredToken).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('403 PLAN_LIMIT → ostáva prihlásený a vystrelí plan-gate (UpgradeModal)', async () => {
    api.defaults.adapter = respond(403, { code: 'PLAN_LIMIT', message: 'Limit projektov' });
    await expect(api.post('/api/tasks', {})).rejects.toBeTruthy();
    expect(removeStoredToken).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
    expect(planGateEvents).toEqual([{ code: 'PLAN_LIMIT', message: 'Limit projektov' }]);
  });

  it('403 bez kódu (chýbajúca rola) → ostáva prihlásený', async () => {
    api.defaults.adapter = respond(403, { message: 'Vyžaduje sa rola owner.' });
    await expect(api.put('/api/workspaces/x', {})).rejects.toBeTruthy();
    expect(removeStoredToken).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('429 a 500 → ostáva prihlásený', async () => {
    for (const status of [429, 500]) {
      api.defaults.adapter = respond(status, { message: 'x' });
      await expect(api.get('/api/auth/me')).rejects.toBeTruthy();
    }
    expect(removeStoredToken).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
  });
});
