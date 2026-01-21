import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

function Login() {
  const { login, register } = useAuth();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegister) {
        await register(username, email, password);
      } else {
        await login(email, password);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const fillDemoUser = (userNum) => {
    setEmail(`user${userNum}@example.com`);
    setPassword('password123');
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
          {isRegister ? 'Vytvoriť účet' : 'Purple CRM'}
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

        <div style={{ marginTop: '24px', paddingTop: '24px', borderTop: '1px solid var(--border-color)' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', textAlign: 'center' }}>
            Demo účty (heslo: password123)
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fillDemoUser(1)}
              style={{ flex: 1 }}
            >
              Užívateľ 1
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fillDemoUser(2)}
              style={{ flex: 1 }}
            >
              Užívateľ 2
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
