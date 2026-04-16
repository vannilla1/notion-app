import { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { acceptInvitation } from '../api/workspaces';

function Login() {
  const { login, register } = useAuth();
  const { fetchWorkspaces, switchWorkspace } = useWorkspace();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [isRegister, setIsRegister] = useState(searchParams.get('register') === 'true');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const inviteToken = searchParams.get('invite');

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
              placeholder="Zadajte heslo"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
            />
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
              <Link to="/vop" style={{ color: 'var(--accent-color, #6366f1)' }}>Obchodnými podmienkami</Link>
              {' '}a{' '}
              <Link to="/ochrana-udajov" style={{ color: 'var(--accent-color, #6366f1)' }}>Zásadami ochrany osobných údajov</Link>.
            </p>
          )}
        </form>

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

        <a href="/ochrana-udajov" style={{ display: 'block', textAlign: 'center', marginTop: '16px', fontSize: '12px', color: 'var(--text-muted)', textDecoration: 'none' }}>
          Zásady ochrany osobných údajov
        </a>
      </div>
    </div>
  );
}

export default Login;
