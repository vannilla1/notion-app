import { createContext, useContext, useState, useEffect, useRef } from 'react';
import api from '@/api/api';
import { setSentryUser, clearSentryUser } from '../utils/sentry';
import {
  getStoredToken,
  setStoredToken,
  removeStoredToken,
  isNativeIOSApp
} from '../utils/authStorage';

const AuthContext = createContext(null);

// Kanál pre zdieľanie session medzi tabmi toho istého prehliadača.
// Nepoužíva sa na iOS natívnej appke (tam je len jeden WKWebView).
const AUTH_CHANNEL_NAME = 'prplcrm_auth';

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(getStoredToken());
  // Kým čakáme, či nám iný tab požičia session (prvých pár ms po mount-e
  // nového tabu), nechceme ho hneď odpáliť na /login — držíme loading=true.
  const [loading, setLoading] = useState(true);
  const nativeIOS = isNativeIOSApp();

  // ── Bootstrap: ak nemáme token, spýtaj sa ostatných tabov ───────────────
  // Nový web tab (napr. Ctrl+T a otvorenie appky) nemá vlastnú sessionStorage
  // session. Bez tohto by vždy skončil na /login, aj keď je user v inom tabe
  // prihlásený. Cez BroadcastChannel sa pýtame: "má niekto token?" a prvý
  // živý tab odpovie. Ak nikto neodpovie do 400 ms, pokračujeme ako neprihlásení.
  //
  // iOS natívnu appku to vynecháva — má persistentný token v localStorage.
  useEffect(() => {
    if (nativeIOS) return;
    if (token) return; // už máme session v sessionStorage
    if (typeof BroadcastChannel === 'undefined') return; // starý prehliadač

    let resolved = false;
    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);

    const onMessage = (e) => {
      if (resolved) return;
      if (e.data?.type === 'auth:token_response' && e.data.token) {
        resolved = true;
        setStoredToken(e.data.token);
        setToken(e.data.token); // triggerne fetchUser cez useEffect([token])
        channel.close();
        clearTimeout(timeout);
      }
    };
    channel.addEventListener('message', onMessage);
    channel.postMessage({ type: 'auth:token_request' });

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      channel.close();
      setLoading(false); // nikto neodpovedal → sme nepriihlásení
    }, 400);

    return () => {
      clearTimeout(timeout);
      try { channel.close(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Odpovedáme iným tabom, ktoré sa pýtajú na token ─────────────────────
  // Ref aby handler videl aktuálny token bez re-bindu pri každej zmene.
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);

  useEffect(() => {
    if (nativeIOS) return;
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    const onMessage = (e) => {
      if (e.data?.type === 'auth:token_request' && tokenRef.current) {
        channel.postMessage({
          type: 'auth:token_response',
          token: tokenRef.current
        });
      }
    };
    channel.addEventListener('message', onMessage);
    return () => {
      try { channel.close(); } catch { /* noop */ }
    };
  }, [nativeIOS]);

  // ── Keď máme token, načítaj usera ──────────────────────────────────────
  useEffect(() => {
    if (token) {
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      fetchUser();
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Keep-alive ping ────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      api.get('/health').catch(() => {});
    }, 10 * 60 * 1000); // 10 minutes
    return () => clearInterval(interval);
  }, [token]);

  const fetchUser = async () => {
    try {
      const res = await api.get('/api/auth/me');
      setUser(res.data);
      setSentryUser(res.data);
    } catch {
      removeStoredToken();
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const login = async (email, password) => {
    const res = await api.post('/api/auth/login', { email, password });
    const { token: newToken, user: userData } = res.data;
    setStoredToken(newToken);
    api.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
    setToken(newToken);
    setUser(userData);
    setSentryUser(userData);
    return userData;
  };

  const register = async (username, email, password) => {
    const res = await api.post('/api/auth/register', { username, email, password });
    const { token: newToken, user: userData } = res.data;
    setStoredToken(newToken);
    api.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
    setToken(newToken);
    setUser(userData);
    setSentryUser(userData);
    return userData;
  };

  const logout = () => {
    removeStoredToken();
    delete api.defaults.headers.common['Authorization'];
    setToken(null);
    setUser(null);
    clearSentryUser();
  };

  const updateUser = (updates) => {
    setUser(prev => ({ ...prev, ...updates }));
  };

  const value = {
    user,
    token,
    loading,
    login,
    register,
    logout,
    updateUser,
    isAuthenticated: !!token && !!user
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
