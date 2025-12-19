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
        <h1 className="login-title">
          {isRegister ? 'Create Account' : 'Welcome Back'}
        </h1>
        <p className="login-subtitle">
          {isRegister
            ? 'Sign up to start collaborating'
            : 'Sign in to your workspace'}
        </p>

        {error && <div className="error-message">{error}</div>}

        <form onSubmit={handleSubmit}>
          {isRegister && (
            <div className="form-group">
              <label className="form-label">Username</label>
              <input
                type="text"
                className="form-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
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
              placeholder="Enter your email"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Loading...' : isRegister ? 'Sign Up' : 'Sign In'}
          </button>
        </form>

        <div className="login-footer">
          {isRegister ? (
            <>
              Already have an account?{' '}
              <a href="#" onClick={() => setIsRegister(false)}>
                Sign in
              </a>
            </>
          ) : (
            <>
              Don't have an account?{' '}
              <a href="#" onClick={() => setIsRegister(true)}>
                Sign up
              </a>
            </>
          )}
        </div>

        <div style={{ marginTop: '24px', paddingTop: '24px', borderTop: '1px solid var(--border-color)' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', textAlign: 'center' }}>
            Demo accounts (password: password123)
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fillDemoUser(1)}
              style={{ flex: 1 }}
            >
              User 1
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fillDemoUser(2)}
              style={{ flex: 1 }}
            >
              User 2
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
