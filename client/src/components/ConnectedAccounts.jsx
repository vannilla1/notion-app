import { useEffect, useState } from 'react';
import api from '@/api/api';
import OAuthButtons from './OAuthButtons';

/**
 * ConnectedAccounts — Settings panel pre pripojenie/odpojenie OAuth účtov.
 *
 * Zobrazuje:
 *   - Aktuálne pripojené prihlasovacie metódy (Heslo, Google, Apple) s ikonami
 *   - Tlačítka na pripojenie chýbajúcich
 *   - Tlačítka na odpojenie pripojených (s last-method guardom)
 *
 * Pripojenie spustí OAuth flow cez OAuthButtons (mode="connect"). Odpojenie
 * volá DELETE /api/auth/connections/:provider. Backend bráni odpojeniu
 * poslednej metódy (vráti 400 LAST_LOGIN_METHOD).
 */
function ConnectedAccounts({ open, onClose, onError }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null); // null | 'google' | 'apple' | 'password'
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState(''); // 'success' | 'error'

  useEffect(() => {
    if (open) {
      loadConnections();
      // Ak nás server-redirect vrátil sem s ?connected=google, zobraz success
      try {
        const params = new URLSearchParams(window.location.search);
        const connected = params.get('connected');
        if (connected) {
          setMessage(connected === 'google' ? 'Google účet pripojený.' : 'Apple účet pripojený.');
          setMessageType('success');
          // Vyčisti query param aby sa správa pri F5 nezopakovala
          params.delete('connected');
          const newSearch = params.toString();
          window.history.replaceState(
            null, '',
            `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}`
          );
        }
      } catch { /* noop */ }
    }
  }, [open]);

  const loadConnections = async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/auth/connections');
      setData(res.data);
    } catch (err) {
      const msg = err?.response?.data?.message || 'Nepodarilo sa načítať pripojené účty.';
      setMessage(msg);
      setMessageType('error');
      if (onError) onError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async (provider) => {
    if (!confirm(`Naozaj chceš odpojiť ${provider === 'google' ? 'Google' : provider === 'apple' ? 'Apple' : 'heslo'}?`)) return;
    setBusy(provider);
    try {
      await api.delete(`/api/auth/connections/${provider}`);
      setMessage(`${labelFor(provider)} bol odpojený.`);
      setMessageType('success');
      await loadConnections();
    } catch (err) {
      const msg = err?.response?.data?.message || 'Odpojenie zlyhalo.';
      setMessage(msg);
      setMessageType('error');
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '480px', width: '100%' }}
      >
        <div className="modal-header">
          <h2>Pripojené účty</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ padding: '20px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
              Načítavam...
            </div>
          ) : !data ? (
            <div style={{ textAlign: 'center', padding: '24px' }}>
              <p>Nepodarilo sa načítať dáta.</p>
              <button className="btn btn-primary" onClick={loadConnections} style={{ marginTop: '12px' }}>
                Skúsiť znova
              </button>
            </div>
          ) : (
            <>
              <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '16px', marginTop: 0 }}>
                Spravuj prihlasovacie metódy svojho účtu. Aspoň jedna metóda
                musí ostať pripojená — nemôžeš sa odhlásiť do "uväznenia".
              </p>

              <ProviderRow
                icon="🔒"
                label="Heslo (email)"
                connected={data.hasPassword}
                onDisconnect={() => handleDisconnect('password')}
                busy={busy === 'password'}
                allowedToDisconnect={data.providers && data.providers.length > 1}
              />
              <ProviderRow
                icon={<GoogleColorIcon />}
                label="Google"
                connected={data.hasGoogle}
                onDisconnect={() => handleDisconnect('google')}
                busy={busy === 'google'}
                allowedToDisconnect={data.providers && data.providers.length > 1}
              />
              <ProviderRow
                icon={<AppleIconBlack />}
                label="Apple"
                connected={data.hasApple}
                onDisconnect={() => handleDisconnect('apple')}
                busy={busy === 'apple'}
                allowedToDisconnect={data.providers && data.providers.length > 1}
              />

              {/* Tlačítka na pripojenie chýbajúcich — OAuthButtons zariadi
                  init flow. Ukážeme ich len keď nejaký provider nie je pripojený. */}
              {(!data.hasGoogle || !data.hasApple) && (
                <div style={{ marginTop: '16px' }}>
                  <OAuthButtons
                    mode="connect"
                    returnUrl="/app/dashboard"
                    onError={(m) => { setMessage(m); setMessageType('error'); }}
                  />
                </div>
              )}

              {message && (
                <div
                  style={{
                    marginTop: '16px',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    background: messageType === 'success' ? '#dcfce7' : '#fee2e2',
                    color: messageType === 'success' ? '#166534' : '#991b1b'
                  }}
                >
                  {message}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderRow({ icon, label, connected, onDisconnect, busy, allowedToDisconnect }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px',
      borderRadius: '10px',
      border: '1px solid #e2e8f0',
      marginBottom: '8px',
      background: 'white'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{
          width: '32px',
          height: '32px',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f1f5f9',
          fontSize: '16px'
        }}>
          {icon}
        </div>
        <div>
          <div style={{ fontWeight: 500 }}>{label}</div>
          <div style={{ fontSize: '12px', color: connected ? '#16a34a' : '#94a3b8' }}>
            {connected ? '✓ Pripojené' : 'Nepripojené'}
          </div>
        </div>
      </div>
      {connected && (
        <button
          onClick={onDisconnect}
          disabled={busy || !allowedToDisconnect}
          title={allowedToDisconnect
            ? 'Odpojiť'
            : 'Toto je posledná prihlasovacia metóda. Najprv pripoj inú.'}
          style={{
            padding: '6px 12px',
            border: '1px solid #e2e8f0',
            background: 'white',
            color: '#dc2626',
            borderRadius: '6px',
            cursor: (busy || !allowedToDisconnect) ? 'not-allowed' : 'pointer',
            fontSize: '13px',
            opacity: (busy || !allowedToDisconnect) ? 0.5 : 1
          }}
        >
          {busy ? '...' : 'Odpojiť'}
        </button>
      )}
    </div>
  );
}

function labelFor(provider) {
  if (provider === 'google') return 'Google účet';
  if (provider === 'apple') return 'Apple účet';
  if (provider === 'password') return 'Heslo';
  return provider;
}

function GoogleColorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}
function AppleIconBlack() {
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M13.624 9.5c-.018-1.886 1.541-2.79 1.612-2.835-.879-1.286-2.249-1.462-2.737-1.482-1.166-.118-2.273.687-2.864.687-.59 0-1.502-.67-2.467-.652-1.27.018-2.44.738-3.094 1.873-1.32 2.288-.337 5.674.95 7.534.628.91 1.378 1.93 2.36 1.892.95-.038 1.31-.612 2.46-.612 1.148 0 1.475.612 2.484.595 1.026-.018 1.674-.928 2.302-1.84.726-1.058 1.025-2.083 1.043-2.135-.024-.012-2.005-.768-2.024-3.054zm-1.872-5.612c.527-.638.882-1.527.785-2.41-.76.03-1.679.506-2.224 1.144-.488.564-.916 1.467-.8 2.336.846.066 1.71-.428 2.24-1.07z" fill="#0f172a"/>
    </svg>
  );
}

export default ConnectedAccounts;
