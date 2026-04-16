import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/api';

function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  // "sent" je true ak backend vrátil 200. Nikdy nezobrazujeme chybu typu
  // "email neexistuje" — backend to zámerne nerozlišuje (anti-enumeration),
  // takže frontend iba ukáže rovnakú potvrdzujúcu správu vždy.
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await api.post('/api/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      if (err.response?.status === 429) {
        setError(err.response.data?.message || 'Príliš veľa pokusov. Skúste neskôr.');
      } else {
        // Aj pri sieťovej chybe pokračujeme s "sent" stavom? Nie — user
        // musí vedieť, že sa nepodarilo odoslať. Ale správu držíme
        // všeobecnú (nerozlišujeme 400/500).
        setError('Nastala chyba. Skúste to znova o chvíľu.');
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
        <h1 className="login-title">Obnovenie hesla</h1>
        <p className="login-subtitle">
          {sent
            ? 'Skontrolujte si schránku'
            : 'Zadajte email, ku ktorému máte priradený účet, a pošleme vám odkaz na nastavenie nového hesla.'}
        </p>

        {error && <div className="error-message">{error}</div>}

        {!sent ? (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Zadajte váš email"
                autoComplete="email"
                required
                autoFocus
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Odosielam...' : 'Poslať odkaz'}
            </button>
          </form>
        ) : (
          <div style={{
            padding: '20px',
            background: 'var(--bg-secondary, #f1f5f9)',
            borderRadius: '8px',
            fontSize: '14px',
            color: 'var(--text-primary, #1e293b)',
            lineHeight: '1.6'
          }}>
            Ak je email <strong>{email}</strong> zaregistrovaný v PrplCRM, poslali sme naň
            odkaz na obnovenie hesla. Odkaz je platný <strong>1 hodinu</strong>.
            <br /><br />
            Nevidíte email? Skontrolujte <strong>Spam</strong> alebo <strong>Promo</strong> priečinok.
          </div>
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

export default ForgotPassword;
