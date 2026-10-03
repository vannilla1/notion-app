import { useState, useEffect, useRef } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import api from '../api/api';

function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const redirectTimerRef = useRef(null);

  // Odložené presmerovanie sa pri odchode zo stránky (napr. klik na „Späť na
  // prihlásenie“) zruší — inak by po 2 s prišla druhá navigácia.
  useEffect(() => () => clearTimeout(redirectTimerRef.current), []);

  // Guard: ak URL neobsahuje token, rovno ukáž chybu — nemá zmysel
  // renderovať form a posielať prázdny token na backend.
  useEffect(() => {
    if (!token) {
      setError('Odkaz na obnovenie hesla je neplatný. Požiadajte o nový odkaz.');
    }
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Rovnaká politika ako server (validatePassword) a zmena hesla v UserMenu
    if (newPassword.length < 8) {
      setError('Heslo musí mať aspoň 8 znakov.');
      return;
    }
    if (!/[A-Za-z]/.test(newPassword) || !/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(newPassword)) {
      setError('Heslo musí obsahovať písmeno a číslo alebo špeciálny znak.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Heslá sa nezhodujú.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/api/auth/reset-password', { token, newPassword });
      setSuccess(true);
      // Po 2 sekundách presmerovať na /login
      redirectTimerRef.current = setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      if (err.response?.data?.message) {
        setError(err.response.data.message);
      } else if (err.response?.status === 429) {
        setError('Príliš veľa pokusov. Skúste neskôr.');
      } else {
        setError('Nastala chyba. Skúste to znova.');
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
          {success ? 'Hotovo ✓' : 'Nastaviť nové heslo'}
        </h1>
        <p className="login-subtitle">
          {success
            ? 'Heslo bolo úspešne zmenené. Presmerujem vás na prihlásenie…'
            : 'Zvoľte si nové heslo: aspoň 8 znakov, písmeno a číslo alebo špeciálny znak.'}
        </p>

        {error && <div className="error-message">{error}</div>}

        {!success && token && (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Nové heslo</label>
              <input
                type="password"
                className="form-input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Aspoň 8 znakov, písmeno + číslo"
                autoComplete="new-password"
                passwordrules="minlength: 8; maxlength: 128; required: lower; required: digit; allowed: ascii-printable;"
                required
                autoFocus
                minLength={8}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Potvrdenie hesla</label>
              <input
                type="password"
                className="form-input"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Zadajte heslo ešte raz"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Ukladám...' : 'Nastaviť nové heslo'}
            </button>
          </form>
        )}

        <div className="login-footer" style={{ marginTop: '20px' }}>
          <Link to="/login" style={{ color: 'var(--accent-color, #6366f1)', textDecoration: 'none' }}>
            ← Späť na prihlásenie
          </Link>
        </div>
      </div>
    </div>
  );
}

export default ResetPassword;
