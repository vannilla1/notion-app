import { useEffect, useState } from 'react';
import api, { API_BASE_URL } from '@/api/api';

/**
 * OAuthButtons — render Google + Apple Sign In tlačítok pod login/register form.
 *
 * Klikom na tlačítko sa user navigne (window.location.assign) na backend init
 * endpoint, ktorý ho redirectuje k Google/Apple. Po úspechu Apple/Google
 * redirectne späť na /auth/callback (handlere AuthCallback.jsx).
 *
 * Pre `mode="connect"` (Settings page) — neredirectujeme priamo, ale pošleme
 * POST /api/auth/{provider}/connect-init s auth header-om a server vráti URL,
 * ktorú potom otvoríme cez window.location.
 *
 * Props:
 *   mode: 'login' | 'connect'  (default 'login')
 *   returnUrl?: string         (kam sa vrátiť po success, default /app
 *                               pre login, /app/settings pre connect)
 *   onError?: (msg) => void    (pre connect mode keď init zlyhá)
 */
function OAuthButtons({ mode = 'login', returnUrl, onError }) {
  const [busy, setBusy] = useState(null); // null | 'google' | 'apple'

  const handleProvider = async (provider) => {
    setBusy(provider);
    try {
      if (mode === 'connect') {
        // Connect flow potrebuje auth — POST init endpoint vráti URL.
        const res = await api.post(`/api/auth/${provider}/connect-init`, {
          returnUrl: returnUrl || '/app/settings'
        });
        if (res.data && res.data.url) {
          window.location.assign(res.data.url);
          return;
        }
        throw new Error('Init returned no URL');
      } else {
        // Login flow — server-side redirect. POZOR: musíme navigovať na BACKEND
        // doménu (API_BASE_URL), nie relatívnu URL — FE doména /api/auth/...
        // by skončila 404, lebo Vite serv nemá tieto routes.
        const params = new URLSearchParams();
        if (returnUrl) params.set('returnUrl', returnUrl);
        const qs = params.toString();
        window.location.assign(`${API_BASE_URL}/api/auth/${provider}/login${qs ? `?${qs}` : ''}`);
      }
    } catch (err) {
      setBusy(null);
      const msg = err?.response?.data?.message ||
        (provider === 'google' ? 'Google prihlásenie zlyhalo.' : 'Apple prihlásenie zlyhalo.');
      if (onError) onError(msg);
      else alert(msg);
    }
  };

  return (
    <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginBottom: '4px'
      }}>
        <div style={{ flex: 1, height: '1px', background: 'rgba(0,0,0,0.08)' }} />
        <span style={{ fontSize: '12px', color: 'var(--text-muted, #64748b)' }}>
          {mode === 'connect' ? 'Pripojiť účet' : 'alebo'}
        </span>
        <div style={{ flex: 1, height: '1px', background: 'rgba(0,0,0,0.08)' }} />
      </div>

      {/* Google — biele s farebným G logom (Google branding guidelines) */}
      <button
        type="button"
        onClick={() => handleProvider('google')}
        disabled={!!busy}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          padding: '11px 16px',
          background: 'white',
          color: '#1f1f1f',
          border: '1px solid #dadce0',
          borderRadius: '8px',
          fontSize: '14px',
          fontWeight: 500,
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy && busy !== 'google' ? 0.6 : 1,
          transition: 'background 0.15s'
        }}
        onMouseEnter={e => { if (!busy) e.currentTarget.style.background = '#f8f9fa'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'white'; }}
      >
        <GoogleIcon />
        {busy === 'google'
          ? 'Načítavam...'
          : (mode === 'connect' ? 'Pripojiť Google účet' : 'Pokračovať s Google')}
      </button>

      {/* Apple — čierne s bielym Apple logom */}
      <button
        type="button"
        onClick={() => handleProvider('apple')}
        disabled={!!busy}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          padding: '11px 16px',
          background: '#000',
          color: 'white',
          border: '1px solid #000',
          borderRadius: '8px',
          fontSize: '14px',
          fontWeight: 500,
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy && busy !== 'apple' ? 0.6 : 1,
          transition: 'background 0.15s'
        }}
      >
        <AppleIcon />
        {busy === 'apple'
          ? 'Načítavam...'
          : (mode === 'connect' ? 'Pripojiť Apple účet' : 'Pokračovať s Apple')}
      </button>
    </div>
  );
}

// Google G logo — 4 farebné kúsky (oficiálny brand asset)
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}

// Apple logo — minimalist silhouette
function AppleIcon() {
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M13.624 9.5c-.018-1.886 1.541-2.79 1.612-2.835-.879-1.286-2.249-1.462-2.737-1.482-1.166-.118-2.273.687-2.864.687-.59 0-1.502-.67-2.467-.652-1.27.018-2.44.738-3.094 1.873-1.32 2.288-.337 5.674.95 7.534.628.91 1.378 1.93 2.36 1.892.95-.038 1.31-.612 2.46-.612 1.148 0 1.475.612 2.484.595 1.026-.018 1.674-.928 2.302-1.84.726-1.058 1.025-2.083 1.043-2.135-.024-.012-2.005-.768-2.024-3.054zm-1.872-5.612c.527-.638.882-1.527.785-2.41-.76.03-1.679.506-2.224 1.144-.488.564-.916 1.467-.8 2.336.846.066 1.71-.428 2.24-1.07z" fill="#fff"/>
    </svg>
  );
}

export default OAuthButtons;
