import axios from 'axios';

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001';

const adminApi = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000
});

// Admin token uložený v sessionStorage (NIE localStorage) — admin je
// vyššia trieda prístupu ako bežný user, takže bránime XSS exfiltrácii
// kratším TTL: token zaniká pri zatvorení tabu/okna. Bežný user token
// ostáva v localStorage (PWA/TWA UX) — viď authStorage.js. Toto je
// kompromis kým admin nemigrujeme na HttpOnly cookie + CSRF token.
//
// Prístup k sessionStorage je obalený try/catch — Safari s blokovanými
// cookies / private mode alebo vyčerpaná kvóta hodia SecurityError a výnimka
// v request interceptore by rejectla každý admin request ešte pred odoslaním.
// Kľúč 'adminToken' sa nemení (zapisuje ho AdminLogin.jsx).
export function getAdminToken() {
  try {
    return sessionStorage.getItem('adminToken');
  } catch {
    return null; // storage blokovaný
  }
}

export function clearAdminToken() {
  try {
    sessionStorage.removeItem('adminToken');
  } catch { /* noop */ }
}

adminApi.interceptors.request.use(config => {
  const token = getAdminToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

adminApi.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401 || error.response?.status === 403) {
      clearAdminToken();
      window.location.href = '/admin';
    }
    return Promise.reject(error);
  }
);

export default adminApi;
