import axios from 'axios';

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000, // 60s timeout - Render cold starts can take 30-50s
});

// Add auth token to all requests
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Auto-retry on timeout, network errors, and 503
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    if (!config) return Promise.reject(error);

    config._retryCount = config._retryCount || 0;

    // Don't retry blob/file download requests — they're large and retrying wastes connections
    const isBlob = config.responseType === 'blob';

    const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
    const isNetwork = error.code === 'ERR_NETWORK' || (!error.response && error.message !== 'canceled');
    const is503 = error.response?.status === 503;

    // Retry on timeout, network error, or 503 (server waking up) — but NOT for blob requests
    if (!isBlob && (isTimeout || isNetwork || is503) && config._retryCount < 3) {
      config._retryCount += 1;
      const delay = config._retryCount * 3000; // 3s, 6s, 9s
      await new Promise(r => setTimeout(r, delay));
      return api(config);
    }

    if (error.response?.status === 401 || error.response?.status === 403) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;
