import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { getStoredToken } from '../utils/authStorage';
import { consumeOAuthNonce } from '../utils/oauthNonce';

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
 *   /auth/callback?mode=connect&provider=google&returnUrl=/app#pending=...
 *   → POST /api/auth/connections/complete s JWT dokončí prepojenie.
 *
 * Login mode overuje `cnonce` vo fragmente proti nonce uloženému pri štarte
 * flow (utils/oauthNonce) — cudzí token podstrčený cez URL sa zahodí.
 *
 * Error mode:
 *   /auth/callback?error=EMAIL_EXISTS_UNVERIFIED&message=...
 */
function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { loginWithToken, isAuthenticated, loading } = useAuth();
  const [status, setStatus] = useState('processing'); // processing | error
  const [errorMessage, setErrorMessage] = useState('');
  const [slowServer, setSlowServer] = useState(false);
  // Prvý effect už nastavil konkrétnu chybu (napr. nesedí nonce) — druhý
  // ju v tom istom commite nesmie prepísať generickou hláškou.
  const failedRef = useRef(false);
  const fail = (message) => {
    failedRef.current = true;
    setErrorMessage(message);
    setStatus('error');
  };

  useEffect(() => {
    const error = searchParams.get('error');
    const provider = searchParams.get('provider') || 'oauth';
    const mode = searchParams.get('mode');
    const returnUrl = searchParams.get('returnUrl') || '/app';

    // ─── Error path ───────────────────────────────────────────────────
    if (error) {
      fail(decodeErrorMessage(error));
      // Auto-redirect na login po 4s
      const t = setTimeout(() => navigate('/login', { replace: true }), 4000);
      return () => clearTimeout(t);
    }

    const hash = window.location.hash || '';
    const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    // Fragment (token / pending) hneď z URL odstránime, nech neostane v histórii.
    const clearHash = () => {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch { /* noop */ }
    };

    // ─── Connect mode (Settings link) ────────────────────────────────
    // Server identitu nepripojil — poslal pending token, ktorý potvrdíme
    // so svojím JWT. Prepojí sa len ak flow spustil tento prihlásený účet.
    if (mode === 'connect') {
      const pending = hashParams.get('pending');
      clearHash();
      const finish = () => {
        const target = sanitizeReturn(returnUrl);
        const sep = target.includes('?') ? '&' : '?';
        navigate(`${target}${sep}connected=${encodeURIComponent(provider)}&openConnections=1`, { replace: true });
      };
      if (!pending) {
        // Starší server (prepojenie už prebehlo v callbacku).
        const t = setTimeout(finish, 600);
        return () => clearTimeout(t);
      }
      if (!getStoredToken()) {
        fail('Pre pripojenie účtu sa najprv prihlás a skús to znova v Nastaveniach.');
        return undefined;
      }
      let cancelled = false;
      api.post('/api/auth/connections/complete', { pending })
        .then(() => { if (!cancelled) finish(); })
        .catch((err) => {
          if (cancelled) return;
          fail(decodeErrorMessage(err?.response?.data?.code || 'CONNECT_FAILED'));
        });
      return () => { cancelled = true; };
    }

    // ─── Login mode ──────────────────────────────────────────────────
    // Token je v URL hash. Parse: "#token=xxx&cnonce=yyy"
    const token = hashParams.get('token');
    const cnonce = hashParams.get('cnonce');

    if (!token) {
      fail('Chýba prihlasovací token. Skús sa prihlásiť znova.');
      const t = setTimeout(() => navigate('/login', { replace: true }), 3000);
      return () => clearTimeout(t);
    }

    // ── iOS Safari → custom URL scheme redirect ──────────────────────
    // Universal Links nezachytia server-side 302 redirect (Apple security
    // policy: only user-tap navigation triggers them). Po Google OAuth
    // flow Safari ostal otvorený a user musel kliknúť "Otvoriť" v banneri.
    // Workaround: ak detekujeme že beží iOS Safari (NIE WKWebView v appke),
    // urobíme window.location na `prplcrm://auth?token=...` — iOS appka
    // má registrovaný custom scheme handler v Info.plist + onOpenURL ho
    // zachytí, uloží JWT do Keychain a načíta /app.
    //
    // Detection: iPhone/iPad UA + neexistuje webkit.messageHandlers
    // (to existuje len v WKWebView, NIE v Safari).
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isInWKWebView = !!(window.webkit && window.webkit.messageHandlers);
    if (isIOS && !isInWKWebView) {
      const returnUrl = sanitizeReturn(searchParams.get('returnUrl') || '/app');
      const customSchemeUrl = `prplcrm://auth?token=${encodeURIComponent(token)}&returnUrl=${encodeURIComponent(returnUrl)}`;
      // Cleanup hash z URL pred redirect-om — ak appka neje nainštalovaná,
      // Safari ostane na tejto stránke a user uvidí "Prihlasujem..." spinner.
      // Po 1.5s fallback urobíme normálny web flow (loginWithToken + navigate).
      clearHash();
      // Natívna appka si väzbu na flow overí sama (prijme token len keď
      // OAuth spustila) — nonce z jej WebView tu v Safari nie je.
      window.location.href = customSchemeUrl;
      // Fallback timer — ak Safari nezatvorí stránku za 1.5s, appka pravdepodobne
      // nie je nainštalovaná → web flow (flow vtedy spustil tento Safari).
      const fallbackTimer = setTimeout(() => {
        if (!consumeOAuthNonce(cnonce)) {
          fail(decodeErrorMessage('STATE_INVALID'));
          return;
        }
        loginWithToken(token);
      }, 1500);
      return () => clearTimeout(fallbackTimer);
    }

    clearHash();

    // Login-CSRF ochrana: token prijmeme len ak flow spustil tento prehliadač.
    if (!consumeOAuthNonce(cnonce)) {
      fail(decodeErrorMessage('STATE_INVALID'));
      return undefined;
    }

    loginWithToken(token);

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
    // Auto-navigácia len v login móde — connect mód naviguje sám po
    // dokončení prepojenia (inak by ho tento effect predbehol a stratil
    // ?connected=…), error mód má vlastný redirect.
    if (searchParams.get('mode') === 'connect' || searchParams.get('error')) return undefined;
    if (status !== 'processing' || failedRef.current) return undefined;
    if (isAuthenticated) {
      const returnUrl = sanitizeReturn(searchParams.get('returnUrl') || '/app');
      navigate(returnUrl, { replace: true });
      return undefined;
    }
    // AuthContext pri prechodnej chybe (cold start Render 30–50 s, 503,
    // sieť) /me opakuje a token nemaže — chybu ukážeme až keď overenie
    // definitívne skončí bez prihlásenia (401 → loading=false, bez usera).
    if (!loading && !getStoredToken()) {
      setErrorMessage('Prihlásenie sa nepodarilo dokončiť. Skús to znova.');
      setStatus('error');
      return undefined;
    }
    // Po 8 s len informujeme, že server sa prebúdza.
    const timeout = setTimeout(() => setSlowServer(true), 8000);
    return () => clearTimeout(timeout);
  }, [isAuthenticated, status, loading]); // eslint-disable-line react-hooks/exhaustive-deps

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
              {slowServer
                ? 'Server sa prebúdza, môže to trvať až minútu…'
                : 'Chvíľu strpenia, dokončujem prihlásenie.'}
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
function decodeErrorMessage(code) {
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
    INIT_FAILED: 'Nepodarilo sa spustiť prihlásenie. Skús to znova.',
    USER_NOT_FOUND: 'Účet neexistuje. Prihlás sa znova.'
  };
  // Text z URL (?message=) zámerne nezobrazujeme — útočník by cez odkaz
  // vedel podstrčiť ľubovoľnú „hlášku Prpl CRM“ (content spoofing).
  return messages[code] || 'Prihlásenie zlyhalo. Skús to znova.';
}

export default AuthCallback;
