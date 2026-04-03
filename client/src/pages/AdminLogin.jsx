import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/api/api';

export default function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await api.post('/api/admin/login', { email, password });
      localStorage.setItem('adminToken', res.data.token);
      navigate('/admin/dashboard');
    } catch (err) {
      setError(err.response?.data?.message || 'Prihlásenie zlyhalo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0f172a', fontFamily: 'Inter, sans-serif'
    }}>
      <div style={{
        background: '#1e293b', borderRadius: '16px', padding: '40px', width: '100%', maxWidth: '400px',
        boxShadow: '0 25px 50px rgba(0,0,0,0.3)', border: '1px solid #334155'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>🔒</div>
          <h1 style={{ fontSize: '22px', color: '#f1f5f9', margin: 0 }}>Super Admin</h1>
          <p style={{ color: '#64748b', fontSize: '14px', marginTop: '8px' }}>Prístup len pre oprávnených</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#94a3b8', marginBottom: '6px' }}>Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid #334155',
                background: '#0f172a', color: '#f1f5f9', fontSize: '14px', outline: 'none',
                boxSizing: 'border-box'
              }}
              placeholder="admin@email.com"
            />
          </div>
          <div style={{ marginBottom: '24px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#94a3b8', marginBottom: '6px' }}>Heslo</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid #334155',
                background: '#0f172a', color: '#f1f5f9', fontSize: '14px', outline: 'none',
                boxSizing: 'border-box'
              }}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div style={{
              padding: '10px 14px', background: 'rgba(239,68,68,0.15)', color: '#f87171',
              borderRadius: '8px', fontSize: '13px', marginBottom: '16px'
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px', border: 'none',
              background: '#6366f1', color: 'white', fontSize: '15px', fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1
            }}
          >
            {loading ? 'Prihlasujem...' : 'Prihlásiť sa'}
          </button>
        </form>
      </div>
    </div>
  );
}
