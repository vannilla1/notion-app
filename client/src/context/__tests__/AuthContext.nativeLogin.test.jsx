import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

/**
 * window.__nativeAuthLogin — token z `prplcrm://auth` (OAuth dokončený
 * v Safari) nesie cnonce a prijme sa len ak flow spustil tento WebView.
 * Natívne SDK prihlásenie (bez opts) ostáva bez zmeny.
 */
const setStoredToken = vi.fn();
vi.mock('../../utils/authStorage', () => ({
  getStoredToken: () => null,
  setStoredToken: (...a) => setStoredToken(...a),
  removeStoredToken: vi.fn(),
  isNativeIOSApp: () => true,
}));
vi.mock('@/api/api', () => ({
  default: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), defaults: { headers: { common: {} } } },
  isSessionInvalidError: () => false,
}));

import { AuthProvider } from '../AuthContext';
import { createOAuthNonce } from '../../utils/oauthNonce';

describe('__nativeAuthLogin', () => {
  beforeEach(() => {
    setStoredToken.mockClear();
    localStorage.clear();
  });

  it('s cnonce, ktorý tento WebView nevydal → odmietne', () => {
    render(<AuthProvider><div /></AuthProvider>);
    let ok;
    act(() => { ok = window.__nativeAuthLogin('a.b.c', { cnonce: 'cudzi-nonce' }); });
    expect(ok).toBe(false);
    expect(setStoredToken).not.toHaveBeenCalled();
  });

  it('so zhodným cnonce → prihlási (a nonce je jednorazový)', () => {
    render(<AuthProvider><div /></AuthProvider>);
    const nonce = createOAuthNonce();
    let ok;
    act(() => { ok = window.__nativeAuthLogin('a.b.c', { cnonce: nonce }); });
    expect(ok).toBe(true);
    expect(setStoredToken).toHaveBeenCalledWith('a.b.c');
    act(() => { ok = window.__nativeAuthLogin('d.e.f', { cnonce: nonce }); });
    expect(ok).toBe(false);
  });

  it('natívne SDK prihlásenie bez opts funguje ako doteraz', () => {
    render(<AuthProvider><div /></AuthProvider>);
    let ok;
    act(() => { ok = window.__nativeAuthLogin('g.h.i'); });
    expect(ok).toBe(true);
    expect(setStoredToken).toHaveBeenCalledWith('g.h.i');
  });
});
