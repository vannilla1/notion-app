import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

/**
 * Bootstrap session (GET /api/auth/me) pri štarte appky.
 *
 * Invariant: prechodná chyba (429, 5xx, sieť) NESMIE zmazať token — appka
 * ostane v stave „načítavam" a skúša znova. Odhlási len 401.
 */
const removeStoredToken = vi.fn();
let storedToken = 'jwt-test';
vi.mock('../../utils/authStorage', () => ({
  getStoredToken: () => storedToken,
  setStoredToken: vi.fn(),
  removeStoredToken: (...a) => { storedToken = null; removeStoredToken(...a); },
  isNativeIOSApp: () => false,
}));

const get = vi.fn();
vi.mock('@/api/api', () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), defaults: { headers: { common: {} } } },
  isSessionInvalidError: (e) => e?.response?.status === 401,
}));

import { AuthProvider, useAuth } from '../AuthContext';

const Probe = () => {
  const { loading, isAuthenticated, user } = useAuth();
  return <div data-testid="state">{loading ? 'loading' : isAuthenticated ? `in:${user.username}` : 'out'}</div>;
};
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('AuthContext bootstrap — prechodné chyby neodhlasujú', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storedToken = 'jwt-test';
    removeStoredToken.mockClear();
    get.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  const meCalls = () => get.mock.calls.filter(([url]) => url === '/api/auth/me').length;

  it('429 → token ostáva, stav loading, po 2 s ďalší pokus uspeje', async () => {
    get.mockImplementation((url) => {
      if (url !== '/api/auth/me') return Promise.resolve({ data: {} });
      return meCalls() === 1 ? Promise.reject(httpError(429)) : Promise.resolve({ data: { id: '1', username: 'martin' } });
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    await flush();
    expect(screen.getByTestId('state').textContent).toBe('loading');
    expect(removeStoredToken).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await flush();
    expect(meCalls()).toBe(2);
    expect(screen.getByTestId('state').textContent).toBe('in:martin');
    expect(removeStoredToken).not.toHaveBeenCalled();
  });

  it('výpadok siete → token ostáva a pokusy pokračujú s rastúcim odstupom', async () => {
    get.mockImplementation((url) => (url === '/api/auth/me'
      ? Promise.reject(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }))
      : Promise.resolve({ data: {} })));
    render(<AuthProvider><Probe /></AuthProvider>);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); await flush();
    expect(meCalls()).toBe(3);
    expect(screen.getByTestId('state').textContent).toBe('loading');
    expect(removeStoredToken).not.toHaveBeenCalled();
  });

  it('401 → odhlási (token zmazaný, stav out), žiadne ďalšie pokusy', async () => {
    get.mockImplementation((url) => (url === '/api/auth/me' ? Promise.reject(httpError(401)) : Promise.resolve({ data: {} })));
    render(<AuthProvider><Probe /></AuthProvider>);
    await flush();
    expect(removeStoredToken).toHaveBeenCalled();
    expect(screen.getByTestId('state').textContent).toBe('out');
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(meCalls()).toBe(1);
  });
});
