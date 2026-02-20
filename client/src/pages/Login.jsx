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
      {/* Animated floating orbs */}
      <div className="login-orb login-orb-1" />
      <div className="login-orb login-orb-2" />
      <div className="login-orb login-orb-3" />

      <div className="login-card">
        <div className="login-logo anim-reveal" style={{ animationDelay: '0s' }}>
          <svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="52" height="52" rx="14" fill="url(#logo-grad)" />
            <rect x="1" y="1" width="50" height="50" rx="13" stroke="url(#logo-stroke)" strokeWidth="1" strokeOpacity="0.4" />
            <path d="M15 17C15 15.8954 15.8954 15 17 15H35C36.1046 15 37 15.8954 37 17V35C37 36.1046 36.1046 37 35 37H17C15.8954 37 15 36.1046 15 35V17Z" fill="white" fillOpacity="0.95"/>
            <path d="M20 22H32M20 26H28M20 30H24" stroke="#7c3aed" strokeWidth="2.2" strokeLinecap="round"/>
            <defs>
              <linearGradient id="logo-grad" x1="0" y1="0" x2="52" y2="52" gradientUnits="userSpaceOnUse">
                <stop stopColor="#7c3aed"/>
                <stop offset="0.5" stopColor="#8b5cf6"/>
                <stop offset="1" stopColor="#a78bfa"/>
              </linearGradient>
              <linearGradient id="logo-stroke" x1="0" y1="0" x2="52" y2="52" gradientUnits="userSpaceOnUse">
                <stop stopColor="#c4b5fd"/>
                <stop offset="1" stopColor="#7c3aed"/>
              </linearGradient>
            </defs>
          </svg>
        </div>

        <h1 className="login-title anim-reveal" style={{ animationDelay: '0.08s' }}>
          {isRegister ? 'Vytvoriť účet' : (
            <>Purple <span className="text-gradient">CRM</span></>
          )}
        </h1>
        <p className="login-subtitle anim-reveal" style={{ animationDelay: '0.14s' }}>
          {isRegister
            ? 'Zaregistrujte sa a začnite spravovať kontakty a úlohy'
            : 'Spravujte kontakty, úlohy a tímovú spoluprácu na jednom mieste'}
        </p>

        {error && <div className="error-message">{error}</div>}

        <form onSubmit={handleSubmit}>
          {isRegister && (
            <div className="form-group anim-reveal" style={{ animationDelay: '0.18s' }}>
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

          <div className="form-group anim-reveal" style={{ animationDelay: '0.2s' }}>
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

          <div className="form-group anim-reveal" style={{ animationDelay: '0.26s' }}>
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

          <div className="anim-reveal" style={{ animationDelay: '0.32s' }}>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? (
                <span className="btn-loading">
                  <span className="btn-spinner" />
                  Načítavam...
                </span>
              ) : isRegister ? 'Registrovať' : 'Prihlásiť sa'}
            </button>
          </div>
        </form>

        <div className="login-footer anim-reveal" style={{ animationDelay: '0.38s' }}>
          {isRegister ? (
            <>
              Už máte účet?{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); setIsRegister(false); }}>
                Prihláste sa
              </a>
            </>
          ) : (
            <>
              Nemáte účet?{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); setIsRegister(true); }}>
                Zaregistrujte sa
              </a>
            </>
          )}
        </div>

        <div className="login-demo anim-reveal" style={{ animationDelay: '0.44s' }}>
          <div className="login-demo-label">
            <span className="login-demo-dot" />
            Demo prístup
          </div>
          <div className="login-demo-buttons">
            <button
              type="button"
              className="btn btn-demo"
              onClick={() => fillDemoUser(1)}
            >
              Užívateľ 1
            </button>
            <button
              type="button"
              className="btn btn-demo"
              onClick={() => fillDemoUser(2)}
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
