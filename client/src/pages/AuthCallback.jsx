import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * AuthCallback — landing page po OAuth redirect zo servera.
 *
 * Server (auth-google.js / auth-apple.js) po úspešnom flow redirectne sem
 * s URL ako:
 *   /auth/callback#token=JWT_HERE?provider=google&isNew=1&returnUrl=/app
 *
 * Token je v hash fragmente (#) — neleak-uje do server logov ani referreru.
 * Query stringy nesú meta info (provider, returnUrl, isNew, linked, error).
 *
 * Connect mode (existing user pripojí Google/Apple v Settings):
 *   /auth/callback?mode=connect&provider=google&connected=1&returnUrl=/settings
 *
 * Error mode:
 *   /auth/callback?error=EMAIL_EXISTS_UNVERIFIED&message=...
 */
function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { loginWithToken, isAuthenticated } = useAuth();
  const [status, setStatus] = useState('processing'); // processing | error
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const error = searchParams.get('error');
    const provider = searchParams.get('provider') || 'oauth';
    const mode = searchParams.get('mode');
    const returnUrl = searchParams.get('returnUrl') || '/app';

    // ─── Error path ───────────────────────────────────────────────────
    if (error) {
      const message = decodeErrorMessage(error, searchParams.get('message'));
      setErrorMessage(message);
      setStatus('error');
      // Auto-redirect na login po 4s
      const t = setTimeout(() => navigate('/login', { replace: true }), 4000);
      return () => clearTimeout(t);
    }

    // ─── Connect mode (Settings link) ────────────────────────────────
    // Server neposlal token (user už bol prihlásený), len redirect-ol nás
    // späť na Settings/Connections so success flagom.
    if (mode === 'connect') {
      // Drobné delay aby sa stačilo zobraziť hlásenie
      const t = setTimeout(() => {
        const target = sanitizeReturn(returnUrl);
        const sep = target.includes('?') ? '&' : '?';
        navigate(`${target}${sep}connected=${provider}`, { replace: true });
      }, 600);
      return () => clearTimeout(t);
    }

    // ─── Login mode ──────────────────────────────────────────────────
    // Token je v URL hash. Parse: "#token=xxx"
    const hash = window.location.hash || '';
    const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const token = hashParams.get('token');

    if (!token) {
      setErrorMessage('Chýba prihlasovací token. Skús sa prihlásiť znova.');
      setStatus('error');
      const t = setTimeout(() => navigate('/login', { replace: true }), 3000);
      return () => clearTimeout(t);
    }

    loginWithToken(token);

    // Cleanup hash z URL aby token nebol viditeľný (replaceState).
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch { /* noop */ }

    // ČAKAME na druhý useEffect dolu, ktorý sa spustí keď isAuthenticated=true
    // (po dokončení fetchUser). Tým zaručíme že Dashboard po navigácii nájde
    // user state pripravený a nerenderuje s `user=null`.
    // Žiadne setTimeout + window.location.assign tu — viď druhý useEffect.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Po loginWithToken sa user fetchne a isAuthenticated prejde na true.
  // Tento useEffect čaká na ten moment a urobí soft navigate (cez React Router).
  // Soft navigation zachová context providery v jednej React tree, čo je
  // robustnejšie než hard window.location.assign().
  //
  // Safeguard: po 8 sekundách bez `isAuthenticated=true` zobrazíme error —
  // niečo zlyhalo (napr. fetchUser dostal 401 → token bol invalidovaný).
  useEffect(() => {
    if (status !== 'processing') return;
    if (isAuthenticated) {
      const returnUrl = sanitizeReturn(searchParams.get('returnUrl') || '/app');
      navigate(returnUrl, { replace: true });
      return;
    }
    // Auth-fail safeguard
    const timeout = setTimeout(() => {
      if (status === 'processing') {
        console.error('[AuthCallback] timeout — user fetch did not complete in 8s');
        setErrorMessage('Prihlásenie sa nepodarilo dokončiť (timeout). Skús to znova.');
        setStatus('error');
      }
    }, 8000);
    return () => clearTimeout(timeout);
  }, [isAuthenticated, status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '24px',
      backgroundColor: 'var(--bg-color, #f8fafc)',
      color: 'var(--text-color, #0f172a)'
    }}>
      <div style={{
        textAlign: 'center',
        padding: '32px',
        background: 'white',
        borderRadius: '16px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
        maxWidth: '440px',
        width: '100%'
      }}>
        {status === 'processing' ? (
          <>
            <div style={{
              width: '48px',
              height: '48px',
              margin: '0 auto 16px',
              border: '4px solid #e2e8f0',
              borderTopColor: '#6366f1',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }} />
            <h2 style={{ margin: '0 0 8px', fontSize: '18px' }}>Prihlasujem...</h2>
            <p style={{ margin: 0, color: '#64748b', fontSize: '14px' }}>
              Chvíľu strpenia, dokončujem prihlásenie.
            </p>
          </>
        ) : (
          <>
            <div style={{
              width: '48px',
              height: '48px',
              margin: '0 auto 16px',
              borderRadius: '50%',
              background: '#fee2e2',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '24px'
            }}>
              ✕
            </div>
            <h2 style={{ margin: '0 0 8px', fontSize: '18px', color: '#dc2626' }}>
              Prihlásenie zlyhalo
            </h2>
            <p style={{ margin: '0 0 16px', color: '#475569', fontSize: '14px' }}>
              {errorMessage}
            </p>
            <button
              onClick={() => navigate('/login', { replace: true })}
              style={{
                padding: '10px 20px',
                background: '#6366f1',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500'
              }}
            >
              Naspäť na prihlásenie
            </button>
          </>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

// Otvor returnUrl iba ak je relatívny path. Anti open-redirect (rovnaký
// princíp ako na backende — viď routes/auth-google.js sanitizeReturnUrl).
function sanitizeReturn(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return '/app';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/app';
}

// User-friendly preklady error kódov z OAuth flow-u.
function decodeErrorMessage(code, rawMessage) {
  const messages = {
    USER_CANCELLED: 'Prihlasovanie zrušené.',
    NOT_CONFIGURED: 'Prihlásenie cez tento spôsob momentálne nie je dostupné.',
    MISSING_PARAMS: 'Neúplná odpoveď z prihlasovacej služby. Skús to znova.',
    STATE_INVALID: 'Bezpečnostný overovací kód nesedí. Skús to znova.',
    STATE_EXPIRED: 'Prihlasovacia relácia vypršala. Skús to znova.',
    EMAIL_EXISTS_UNVERIFIED: 'S týmto emailom už máš účet. Prihlás sa najprv heslom a v Nastaveniach pripoj Google/Apple účet.',
    PROVIDER_ID_TAKEN: 'Tento účet je už pripojený k inému používateľovi.',
    NO_EMAIL: 'Provider nezdielal email. Skús povoliť zdieľanie emailu a opakuj.',
    LAST_LOGIN_METHOD: 'Nemôžeš odpojiť poslednú prihlasovaciu metódu.',
    INVALID_PROVIDER: 'Neplatný spôsob prihlásenia.',
    LOGIN_FAILED: 'Prihlásenie zlyhalo. Skús to znova.',
    CONNECT_FAILED: 'Pripojenie účtu zlyhalo. Skús to znova.',
    CALLBACK_FAILED: 'Niečo sa pokazilo pri prihlasovaní. Skús to znova.',
    INIT_FAILED: 'Nepodarilo sa spustiť prihlásenie. Skús to znova.'
  };
  return messages[code] || rawMessage || 'Prihlásenie zlyhalo. Skús to znova.';
}

export default AuthCallback;
