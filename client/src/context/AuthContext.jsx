import { createContext, useContext, useState, useEffect } from 'react';
import api from '@/api/api';
import { setSentryUser, clearSentryUser } from '../utils/sentry';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      fetchUser();
    } else {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      api.get('/health').catch(() => {});
    }, 10 * 60 * 1000); // 10 minutes
    return () => clearInterval(interval);
  }, [token]);

  // Cross-tab auth sync: ak iný tab zmení token v localStorage (login/logout
  // ako iný user), tento tab má v React state stále starý token, ale axios
  // interceptor v api.js číta localStorage.getItem('token') na KAŽDOM requeste
  // — takže ďalší API call by šiel s novým tokenom, ale UI by ukazovalo
  // starého usera / workspace / permissions. Plný reload je najbezpečnejší:
  // reinicializuje všetky contexty (Auth, Workspace, Socket) konzistentne
  // z novej hodnoty v localStorage.
  //
  // Storage event sa z princípu NEpáli v tabe, ktorý zmenu vyvolal — takže
  // vlastný login()/logout()/register() v tomto tabe tu nespustí reload.
  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key !== 'token') return;
      // Ignorovať, ak sa hodnota reálne nemenila (niektoré prehliadače
      // emitujú event aj pri setItem s rovnakou hodnotou).
      if (e.newValue === e.oldValue) return;
      window.location.reload();
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const fetchUser = async () => {
    try {
      const res = await api.get('/api/auth/me');
      setUser(res.data);
      setSentryUser(res.data);
    } catch {
      localStorage.removeItem('token');
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const login = async (email, password) => {
    const res = await api.post('/api/auth/login', { email, password });
    const { token: newToken, user: userData } = res.data;
    localStorage.setItem('token', newToken);
    api.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
    setToken(newToken);
    setUser(userData);
    setSentryUser(userData);
    return userData;
  };

  const register = async (username, email, password) => {
    const res = await api.post('/api/auth/register', { username, email, password });
    const { token: newToken, user: userData } = res.data;
    localStorage.setItem('token', newToken);
    api.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
    setToken(newToken);
    setUser(userData);
    setSentryUser(userData);
    return userData;
  };

  const logout = () => {
    localStorage.removeItem('token');
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
