import axios from 'axios';
import { getStoredToken, removeStoredToken } from '../utils/authStorage';
import { getStoredWorkspaceId, removeStoredWorkspaceId } from '../utils/workspaceStorage';

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000, // 60s timeout - Render cold starts can take 30-50s
});

api.interceptors.request.use(
  (config) => {
    // Per-tab token (sessionStorage on web, localStorage on iOS native).
    // Viac v client/src/utils/authStorage.js.
    const token = getStoredToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    // Per-device workspace intent. Backend (requireWorkspace middleware)
    // ho preferuje pred user.currentWorkspaceId z DB → každé zariadenie
    // má vlastný workspace bez multi-device interferencie. Ak header chýba
    // (prvý request po logine, pred fetchWorkspaces), backend spadne na DB
    // fallback. Viac v client/src/utils/workspaceStorage.js.
    const wsId = getStoredWorkspaceId();
    if (wsId) {
      config.headers['X-Workspace-Id'] = wsId;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    if (!config) return Promise.reject(error);

    config._retryCount = config._retryCount || 0;

    const isBlob = config.responseType === 'blob';

    const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
    const isNetwork = error.code === 'ERR_NETWORK' || (!error.response && error.message !== 'canceled');
    const is503 = error.response?.status === 503;

    if (!isBlob && (isTimeout || isNetwork || is503) && config._retryCount < 3) {
      config._retryCount += 1;
      const delay = config._retryCount * 3000; // 3s, 6s, 9s
      await new Promise(r => setTimeout(r, delay));
      return api(config);
    }

    // 403 NOT_MEMBER = lokálny X-Workspace-Id ukazuje na workspace, z ktorého
    // ma user medzitým vyhodili (membership zmena na inom zariadení, admin remove).
    // Nezlogujeme usera — len zmažeme stale workspace storage a necháme Workspace
    // Context refetchnúť. Ďalší request pôjde bez headera → backend fallback
    // na User.currentWorkspaceId v DB a vráti niektorý z validných workspaces.
    if (error.response?.status === 403 && error.response?.data?.code === 'NOT_MEMBER') {
      removeStoredWorkspaceId();
      if (!config._wsRetry) {
        config._wsRetry = true;
        delete config.headers['X-Workspace-Id'];
        return api(config);
      }
    }

    // 400 NO_WORKSPACE = stale workspace context. Vzniká keď klient pošle
    // X-Workspace-Id pre workspace ktorý medzičasom bol zmazaný, alebo keď
    // user.currentWorkspaceId v DB ukazuje na neexistujúci/odpojený workspace.
    // Bez tohto handlera stránka napr. /crm dostane 400 z GET /api/contacts
    // a end-user vidí len bielu obrazovku + log "Request failed with status
    // code 400". Liečenie je rovnaké ako pri NOT_MEMBER — zmaž stale storage
    // a retry bez headera, čím necháme backend auto-recovery na inú validnú
    // membership (alebo definitívne 400 ak user už nemá žiadnu — vtedy
    // WorkspaceContext zachytí prázdne workspaces[] a presmeruje na setup).
    if (error.response?.status === 400 && error.response?.data?.code === 'NO_WORKSPACE') {
      if (!config._wsFix) {
        config._wsFix = true;
        removeStoredWorkspaceId();
        if (config.headers) delete config.headers['X-Workspace-Id'];
        return api(config);
      }
    }

    if (error.response?.status === 401 || error.response?.status === 403) {
      // removeStoredToken() maže z sessionStorage (web) alebo localStorage (iOS)
      // + cleanup legacy kľúčov (user, starý localStorage token z predošlej verzie).
      removeStoredToken();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }

    // Obohatíme error.message o request kontext PRED reject. Bez tohto je
    // typický unhandled rejection v Diagnostics len "Request failed with
    // status code 400" — bezcenné, lebo nevieme ktorý endpoint zlyhal.
    // Po: "GET /api/contacts → 400: Workspace required" — vidno presne
    // čo opraviť. Calling code naďalej číta error.response.status / data,
    // takže overhead je nulový.
    if (error.response && config.url) {
      const method = (config.method || 'GET').toUpperCase();
      const url = config.url;
      const status = error.response.status;
      const serverMsg =
        error.response.data?.message ||
        error.response.data?.error ||
        '';
      error.message = `${method} ${url} → ${status}${serverMsg ? `: ${serverMsg}` : ''}`;
    }
    return Promise.reject(error);
  }
);

export default api;
