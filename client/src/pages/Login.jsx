import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { acceptInvitation } from '../api/workspaces';
import OAuthButtons from '../components/OAuthButtons';
import { isIosNativeApp } from '../utils/platform';

function Login() {
  const { login, register } = useAuth();
  const { fetchWorkspaces, switchWorkspace } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // App Store Review Guideline 3.1.1 + 3.1.3(d) Reader-app exception: na iOS
  // native (WKWebView shell) NESMIE byť žiadny registračný flow — Apple to
  // považuje za "access to external mechanisms for purchases or subscriptions"
  // (Reject z 3. mája 2026 pre Submission 6d6c20b0). Forcujeme iba login,
  // register query param ignorujeme, "Zaregistrujte sa" CTA skryjeme. Nový
  // účet si user vytvorí na webe (prplcrm.eu).
  const iosNative = isIosNativeApp();
  // isRegister sa deriva priamo z URL, aby bol stav zachovaný aj pri návrate
  // cez browser back button (napr. z /vop alebo /ochrana-udajov).
  // Na iOS native ignorujeme query param a vždy show login.
  const isRegister = !iosNative && searchParams.get('register') === 'true';
  const setIsRegister = (value) => {
    if (iosNative) return; // no-op na iOS — register flow nie je dostupný
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set('register', 'true');
    } else {
      newParams.delete('register');
    }
    setSearchParams(newParams, { replace: false });
  };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const inviteToken = searchParams.get('invite');

  // iOS WKWebView keyboard handling — multi-vrstvová stratégia (CSS + JS):
  //
  // 1. CSS layer:
  //    - viewport meta `interactive-widget=resizes-content` zmenší layout viewport
  //      keď sa vysunie kbd (iOS 16+ default)
  //    - `100dvh` + auto-margin centering scrolluje keď karta nezmestí
  //    - `@media (max-height: 760px)` kompaktný režim — menšie paddingy/fonty
  //      aby sa celá karta vrátane Register buttonu zmestila nad kbd
  //
  // 2. JS layer (tu) — poistka pre case keď CSS nezareaguje včas alebo keď
  //    aktívny field je tesne pri okraji viewportu:
  //    a) Po focuse INPUT-u → scrollIntoView na samotný input (centruje ho)
  //    b) Pri poslednom inpute (password) navyše scrollneme submit BUTTON do view
  //       — užívateľ typeuje heslo a hneď vidí kam má kliknúť (Apple review demo
  //       musí byť bez manuálneho scrollu pre clean video)
  //
  //    Delay 300ms čaká na animáciu vysunutia kbd. Druhý 200ms delay zaručí
  //    že prvý scroll dokončí pred druhým (iOS smooth-scroll je sekvenčný).
  useEffect(() => {
    const handleFocus = (e) => {
      const tag = e.target?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;

      setTimeout(() => {
        try {
          e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {
          e.target.scrollIntoView();
        }

        // Ak je toto posledný input vo formulári, ešte scrollneme aj submit
        // button do viditeľnej oblasti — aby user vedel kam má kliknúť bez
        // nutnosti manuálne scrollovať.
        const form = e.target.closest('form');
        if (!form) return;
        const inputs = form.querySelectorAll('input, textarea');
        const isLast = inputs[inputs.length - 1] === e.target;
        if (!isLast) return;

        setTimeout(() => {
          const submitBtn = form.querySelector('button[type="submit"]');
          if (submitBtn) {
            try {
              submitBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch {
              submitBtn.scrollIntoView();
            }
          }
        }, 200);
      }, 300);
    };
    document.addEventListener('focusin', handleFocus);
    return () => document.removeEventListener('focusin', handleFocus);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // API interceptor automatically retries on timeout/network errors (server cold start)
      if (isRegister) {
        await register(username, email, password);
      } else {
        await login(email, password);
      }

      // If there's an invite token, accept it after login/register
      if (inviteToken) {
        try {
          const result = await acceptInvitation(inviteToken);
          if (result.workspaceId) {
            await switchWorkspace(result.workspaceId);
          } else {
            await fetchWorkspaces();
          }
        } catch (inviteErr) {
          await fetchWorkspaces();
        }
        navigate('/app');
        return;
      }
    } catch (err) {
      if (err.response?.data?.message) {
        setError(err.response.data.message);
      } else if (err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.code === 'ERR_NETWORK' || !err.response) {
        setError('Server sa nepodarilo prebudiť. Skúste to znova o 30 sekúnd.');
      } else {
        setError('Nastala neočakávaná chyba. Skúste to znova.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/icons/icon-96x96.png" alt="Prpl CRM" width="48" height="48" style={{ borderRadius: '12px' }} />
        </div>
        <h1 className="login-title">
          {isRegister ? 'Vytvoriť účet' : 'Prpl CRM'}
        </h1>
        <p className="login-subtitle">
          {isRegister
            ? 'Zaregistrujte sa a začnite spravovať kontakty a projekty'
            : 'Spravujte kontakty, projekty a tímovú spoluprácu na jednom mieste'}
        </p>

        {error && <div className="error-message">{error}</div>}

        <form onSubmit={handleSubmit}>
          {isRegister && (
            <div className="form-group">
              <label className="form-label">Používateľské meno</label>
              <input
                type="text"
                className="form-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Zadajte používateľské meno"
                /*
                 * name="username" + autocomplete="username" je hard signal pre iOS
                 * Password AutoFill že toto je account-name field. Bez `name` iOS
                 * heuristika niekedy nezistí kontext registrácie a neponúkne
                 * Strong Password generator. Dôležité pre čistý Apple review demo.
                 */
                name="username"
                autoComplete="username"
                required
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Zadajte email"
              name="email"
              autoComplete="email"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Heslo</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isRegister ? 'Min. 8 znakov, písmeno + číslo' : 'Zadajte heslo'}
              /*
               * name + autocomplete combo signalizuje iOS Keychain či je toto
               * registrácia (new-password) alebo prihlásenie (current-password).
               * Spolu s `passwordrules` triggeruje Strong Password generátor.
               */
              name={isRegister ? 'new-password' : 'current-password'}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              /*
               * passwordrules — Apple Password AutoFill API. Triggeruje "Use Strong Password"
               * v iOS Keychaine pri registrácii (autocomplete=new-password). iOS vygeneruje
               * heslo zodpovedajúce týmto pravidlám. Android Chrome Password Generator tiež
               * rešpektuje minlength. Bez tohoto atribútu iOS niekedy nevie že je to nový
               * účet a ponúka len existujúce uložené heslá namiesto generovania nového.
               *
               * Naša backend policy: min 8, ≥1 písmeno, ≥1 číslo alebo špec. znak, HIBP check.
               * `required: lower; required: digit` zaručí že vygenerované heslo prejde policy.
               * `allowed: ascii-printable` dovolí špec. znaky pre vyššiu entropiu.
               *
               * Ref: https://developer.apple.com/password-rules/
               */
              passwordrules={isRegister ? 'minlength: 8; maxlength: 128; required: lower; required: digit; allowed: ascii-printable;' : undefined}
              minLength={isRegister ? 8 : undefined}
              required
            />
            {isRegister && (
              <p
                style={{
                  fontSize: '12px',
                  color: 'var(--text-muted, #64748b)',
                  margin: '6px 2px 0',
                  lineHeight: 1.4
                }}
              >
                Heslo musí obsahovať minimálne <strong>8 znakov</strong>, aspoň jedno{' '}
                <strong>písmeno</strong> a aspoň jedno <strong>číslo</strong> alebo{' '}
                <strong>špeciálny znak</strong>. iOS aj Android vám môžu vygenerovať silné heslo automaticky.
              </p>
            )}
          </div>

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Načítavam...' : isRegister ? 'Registrovať' : 'Prihlásiť'}
          </button>
          {!isRegister && (
            <p style={{ fontSize: '13px', textAlign: 'center', marginTop: '12px' }}>
              <Link to="/forgot-password" style={{ color: 'var(--accent-color, #6366f1)', textDecoration: 'none' }}>
                Zabudli ste heslo?
              </Link>
            </p>
          )}
          {isRegister && (
            <p style={{ fontSize: '12px', color: 'var(--text-muted, #64748b)', marginTop: '12px', textAlign: 'center', lineHeight: '1.5' }}>
              Registráciou súhlasíte s{' '}
              <Link to="/vop?from=register" style={{ color: 'var(--accent-color, #6366f1)' }}>Obchodnými podmienkami</Link>
              {' '}a{' '}
              <Link to="/ochrana-udajov?from=register" style={{ color: 'var(--accent-color, #6366f1)' }}>Zásadami ochrany osobných údajov</Link>.
            </p>
          )}
        </form>

        <OAuthButtons mode="login" />

        {/* Toggle login/register — na iOS native skrytý úplne, lebo App Store
            3.1.1 / 3.1.3(d) zakazuje "account registration features for
            businesses and organizations" v Reader-app exception flow. Na webe
            a Androide ostáva normálne. */}
        {/* iOS native — vysvetlenie kde sa registrovať (App Store 3.1.3(d)
            Reader-app: registrácia musí byť mimo iOS appky). Bez tejto info
            by user nemal ako pochopiť, prečo na iOS appke nie je signup
            tlačidlo. Bordered card s ikonou aby vyčnieval z formulára. */}
        {iosNative && !isRegister && (
          <div className="ios-register-hint">
            <div className="ios-register-hint-icon">ℹ️</div>
            <div className="ios-register-hint-text">
              <strong>Ešte nemáte účet?</strong>
              <p>
                Účet si vytvoríte zdarma na webe <a
                  href="https://prplcrm.eu"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-color, #6366f1)', fontWeight: 600 }}
                >prplcrm.eu</a> a potom sa sem vráťte prihlásiť. Registrácia priamo v iOS aplikácii nie je dostupná.
              </p>
            </div>
          </div>
        )}

        {!iosNative && (
          <div className="login-footer">
            {isRegister ? (
              <>
                Už máte účet?{' '}
                <a href="#" onClick={() => setIsRegister(false)}>
                  Prihláste sa
                </a>
              </>
            ) : (
              <>
                Nemáte účet?{' '}
                <a href="#" onClick={() => setIsRegister(true)}>
                  Zaregistrujte sa
                </a>
              </>
            )}
          </div>
        )}

        {!isRegister && (
          <a href="/ochrana-udajov" style={{ display: 'block', textAlign: 'center', marginTop: '16px', fontSize: '12px', color: 'var(--text-muted)', textDecoration: 'none' }}>
            Zásady ochrany osobných údajov
          </a>
        )}
      </div>
    </div>
  );
}

export default Login;
