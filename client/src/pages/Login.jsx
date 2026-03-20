import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { acceptInvitation } from '../api/workspaces';

function Login() {
  const { login, register } = useAuth();
  const { fetchWorkspaces } = useWorkspace();
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
          await acceptInvitation(inviteToken);
          await fetchWorkspaces();
        } catch (inviteErr) {
          console.log('Auto-accept invite failed:', inviteErr.response?.data?.message);
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
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="48" height="48" rx="12" fill="url(#gradient)"/>
            <path d="M14 16C14 14.8954 14.8954 14 16 14H32C33.1046 14 34 14.8954 34 16V32C34 33.1046 33.1046 34 32 34H16C14.8954 34 14 33.1046 14 32V16Z" fill="white" fillOpacity="0.9"/>
            <path d="M18 20H30M18 24H26M18 28H22" stroke="#6366f1" strokeWidth="2" strokeLinecap="round"/>
            <defs>
              <linearGradient id="gradient" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
                <stop stopColor="#6366f1"/>
                <stop offset="1" stopColor="#8b5cf6"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <h1 className="login-title">
          {isRegister ? 'Vytvoriť účet' : 'Prpl CRM'}
        </h1>
        <p className="login-subtitle">
          {isRegister
            ? 'Zaregistrujte sa a začnite spravovať kontakty a úlohy'
            : 'Spravujte kontakty, úlohy a tímovú spoluprácu na jednom mieste'}
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

        <a href="/privacy" style={{ display: 'block', textAlign: 'center', marginTop: '16px', fontSize: '12px', color: 'var(--text-muted)', textDecoration: 'none' }}>
          Zásady ochrany osobných údajov
        </a>
      </div>
    </div>
  );
}

export default Login;
