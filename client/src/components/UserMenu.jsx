import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../api/api';
import { getStoredToken } from '../utils/authStorage';
import PushNotificationToggle from './PushNotificationToggle';
import { isMobileDevice } from '../utils/platform';
import { useWorkspace } from '../context/WorkspaceContext';
import { switchWorkspace as switchWorkspaceApi, leaveWorkspace as leaveWorkspaceApi } from '../api/workspaces';
import { setStoredWorkspaceId, getStoredWorkspaceId } from '../utils/workspaceStorage';

// Auth + per-request workspace intent header. Every backend endpoint that
// uses `requireWorkspace` middleware picks up X-Workspace-Id; without it the
// server falls back to user.currentWorkspaceId from DB, which on multi-device
// accounts is the LAST workspace the user clicked — not necessarily where
// they are now. Sync buttons in this menu were hitting that fallback and
// syncing the wrong workspace's tasks.
const authHeaders = () => {
  const token = getStoredToken();
  const wsId = getStoredWorkspaceId();
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (wsId) h['X-Workspace-Id'] = wsId;
  return h;
};
import { getWorkspaceRoleLabel } from '../utils/constants';

const translateErrorMessage = (message) => {
  if (!message) return 'Neznáma chyba';

  const translations = {
    'Google Tasks token expired. Please reconnect your account.':
      'Token pre Google Tasks expiroval. Prosím, odpojte a znova pripojte váš účet kliknutím na tlačidlo "Odpojiť" a potom "Pripojiť Google Tasks".',
    'Google Tasks not connected':
      'Google Tasks nie je pripojený. Kliknite na "Pripojiť Google Tasks".',
    'Google Tasks OAuth not configured':
      'Google Tasks integrácia nie je nakonfigurovaná na serveri.',
    'Token refresh failed':
      'Nepodarilo sa obnoviť prístupový token. Prosím, odpojte a znova pripojte účet.',
    'invalid_grant':
      'Platnosť prístupu vypršala. Prosím, odpojte a znova pripojte váš Google účet.',
    'Network Error':
      'Chyba siete. Skontrolujte pripojenie k internetu.',
    'Request failed with status code 401':
      'Neautorizovaný prístup. Prosím, prihláste sa znova.',
    'Request failed with status code 403':
      'Prístup zamietnutý. Nemáte oprávnenie na túto akciu.',
    'Request failed with status code 500':
      'Chyba servera. Skúste to znova neskôr.'
  };

  // Check for exact match
  if (translations[message]) {
    return translations[message];
  }

  // Check for partial matches
  for (const [key, value] of Object.entries(translations)) {
    if (message.includes(key)) {
      return value;
    }
  }

  // Return original if no translation found
  return message;
};

function UserMenu({ user, onLogout, onUserUpdate }) {
  const navigate = useNavigate();
  const { currentWorkspace, workspaces, switchWorkspace, createWorkspace } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [showMobileWorkspaces, setShowMobileWorkspaces] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [leavingWorkspace, setLeavingWorkspace] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [showProfile, setShowProfile] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [showCalendarSettings, setShowCalendarSettings] = useState(false);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    color: ''
  });
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [calendarFeed, setCalendarFeed] = useState({
    enabled: false,
    feedUrl: null,
    loading: false
  });
  const [googleCalendar, setGoogleCalendar] = useState({
    connected: false,
    connectedAt: null,
    lastSyncAt: null,
    loading: false,
    syncing: false,
    pendingTasks: null,
    isDedicatedCalendar: false
  });
  const [googleTasks, setGoogleTasks] = useState({
    connected: false,
    connectedAt: null,
    lastSyncAt: null,
    loading: false,
    syncing: false,
    pendingTasks: null,
    quota: null
  });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [googleTasksMessage, setGoogleTasksMessage] = useState('');
  const [googleTasksMessageType, setGoogleTasksMessageType] = useState('success'); // 'success' or 'error'
  // Scoped per-section message states — prevents Calendar/Tasks errors from
  // leaking into the other section's UI (was: shared errors.general appearing
  // only under Calendar card, confusing users when Tasks failed).
  const [googleCalendarMessage, setGoogleCalendarMessage] = useState('');
  const [googleCalendarMessageType, setGoogleCalendarMessageType] = useState('success');
  const [avatarTimestamp, setAvatarTimestamp] = useState(() => user?.avatarTimestamp || 1);
  const menuRef = useRef(null);
  const fileInputRef = useRef(null);

  const API_URL = `${API_BASE_URL}/api`;

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Po OAuth návrate z Google (query ?google_calendar=connected | ?google_tasks=connected)
  // automaticky otvoríme "Synchronizácia kalendára" modal a scrollneme k relevantnej
  // sekcii. User začínal flow klikom na "Pripojiť Google ..." v tomto modali — vracať
  // ho na samotný /tasks list by znamenalo, že sa musí znova prekliknúť, aby videl
  // úspešné pripojenie v kontexte integrácie.
  // URL query si po spracovaní čistíme, aby pri ďalšom refresh-i modal nenapáril znova.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const params = new URLSearchParams(window.location.search);
      const calendarConnected = params.get('google_calendar') === 'connected';
      const tasksConnected = params.get('google_tasks') === 'connected';
      if (!calendarConnected && !tasksConnected) return;

      // Otvorí modal + fetchne statusy; pozrie, ktorú sekciu scrollnúť do viewportu.
      handleOpenCalendarSettings();

      // Scroll k relevantnej sekcii po tom, čo modal zrendruje. 300 ms pokryje aj
      // fetchCalendar*/fetchGoogleTasksStatus dokončenie (bežia paralelne ~100-300 ms),
      // aby sekcia bola vo finálnom stave pred scrollom.
      setTimeout(() => {
        const selector = calendarConnected
          ? '.google-calendar-section'
          : '.google-tasks-section';
        const el = document.querySelector(selector);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 300);

      // Vyčisti query-string, aby refresh modal znova neautomatizoval.
      params.delete('google_calendar');
      params.delete('google_tasks');
      params.delete('message');
      const newSearch = params.toString();
      const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
      window.history.replaceState({}, '', newUrl);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchProfile = async () => {
    try {
      setLoading(true);
      setErrors({});
      const token = getStoredToken();
      const response = await axios.get(`${API_URL}/auth/profile`, {
        headers: authHeaders()
      });
      setProfile(response.data);
      setFormData({
        username: response.data.username,
        email: response.data.email,
        color: response.data.color
      });
    } catch {
      // Fallback - use local user if server fails
      if (user) {
        setProfile({
          id: user.id,
          username: user.username,
          email: user.email,
          color: user.color || '#3B82F6',
          avatar: user.avatar || null,
          createdAt: user.createdAt || new Date().toISOString()
        });
        setFormData({
          username: user.username,
          email: user.email,
          color: user.color || '#3B82F6'
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOpenProfile = () => {
    fetchProfile();
    setShowProfile(true);
    setIsOpen(false);
    setMessage('');
    setErrors({});
  };

  const handleCloseProfile = () => {
    setShowProfile(false);
    setErrors({});
    setMessage('');
  };

  const handleOpenPasswordChange = () => {
    setShowPasswordChange(true);
    setIsOpen(false);
    setPasswordData({
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    });
    setMessage('');
    setErrors({});
  };

  const handleClosePasswordChange = () => {
    setShowPasswordChange(false);
    setErrors({});
    setMessage('');
  };

  const handleOpenCalendarSettings = async () => {
    setShowCalendarSettings(true);
    setIsOpen(false);
    setMessage('');
    setErrors({});
    setGoogleTasksMessage('');
    await Promise.all([
      fetchCalendarFeedStatus(),
      fetchGoogleCalendarStatus(),
      fetchGoogleTasksStatus()
    ]);
  };

  const handleCloseCalendarSettings = () => {
    setShowCalendarSettings(false);
    setErrors({});
    setMessage('');
  };

  const fetchCalendarFeedStatus = async () => {
    try {
      setCalendarFeed(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      const response = await axios.get(`${API_URL}/tasks/calendar/feed/status`, {
        headers: authHeaders()
      });
      setCalendarFeed({
        enabled: response.data.enabled,
        feedUrl: response.data.feedUrl,
        loading: false
      });
    } catch {
      setCalendarFeed(prev => ({ ...prev, loading: false }));
    }
  };

  const handleEnableCalendarFeed = async () => {
    try {
      setCalendarFeed(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      const response = await axios.post(`${API_URL}/tasks/calendar/feed/generate`, {}, {
        headers: authHeaders()
      });
      setCalendarFeed({
        enabled: true,
        feedUrl: response.data.feedUrl,
        loading: false
      });
      setMessage('Kalendár feed bol aktivovaný');
    } catch {
      setErrors({ general: 'Chyba pri aktivácii kalendár feedu' });
      setCalendarFeed(prev => ({ ...prev, loading: false }));
    }
  };

  const handleDisableCalendarFeed = async () => {
    try {
      setCalendarFeed(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      await axios.post(`${API_URL}/tasks/calendar/feed/disable`, {}, {
        headers: authHeaders()
      });
      setCalendarFeed({
        enabled: false,
        feedUrl: null,
        loading: false
      });
      setMessage('Kalendár feed bol deaktivovaný');
    } catch {
      setErrors({ general: 'Chyba pri deaktivácii kalendár feedu' });
      setCalendarFeed(prev => ({ ...prev, loading: false }));
    }
  };

  const handleRegenerateCalendarFeed = async () => {
    if (!confirm('Naozaj chcete vygenerovať nový odkaz? Starý odkaz prestane fungovať.')) {
      return;
    }
    try {
      setCalendarFeed(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      const response = await axios.post(`${API_URL}/tasks/calendar/feed/regenerate`, {}, {
        headers: authHeaders()
      });
      setCalendarFeed({
        enabled: true,
        feedUrl: response.data.feedUrl,
        loading: false
      });
      setMessage('Nový kalendár feed bol vygenerovaný');
    } catch {
      setErrors({ general: 'Chyba pri generovaní nového odkazu' });
      setCalendarFeed(prev => ({ ...prev, loading: false }));
    }
  };

  const handleCopyFeedUrl = () => {
    if (calendarFeed.feedUrl) {
      navigator.clipboard.writeText(calendarFeed.feedUrl);
      setMessage('Odkaz bol skopírovaný do schránky');
    }
  };

  const fetchGoogleCalendarStatus = async () => {
    try {
      setGoogleCalendar(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      const response = await axios.get(`${API_URL}/google-calendar/status`, {
        headers: authHeaders()
      });
      setGoogleCalendar({
        connected: response.data.connected,
        connectedAt: response.data.connectedAt,
        lastSyncAt: response.data.lastSyncAt || null,
        loading: false,
        syncing: false,
        pendingTasks: response.data.pendingTasks || null,
        isDedicatedCalendar: !!response.data.isDedicatedCalendar,
        syncDisabledWorkspaces: response.data.syncDisabledWorkspaces || []
      });
    } catch {
      setGoogleCalendar(prev => ({ ...prev, loading: false }));
    }
  };

  const handleConnectGoogleCalendar = async () => {
    try {
      setGoogleCalendar(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      const response = await axios.get(`${API_URL}/google-calendar/auth-url`, {
        headers: authHeaders()
      });
      // Belt-and-suspenders flag — if the URL redirect query param doesn't reach
      // us (iOS/Android WebView quirks), this flag still triggers the toast once
      // we detect the integration became connected.
      try { sessionStorage.setItem('pending_google_connect', 'calendar'); } catch { /* ignore */ }
      window.location.href = response.data.authUrl;
    } catch {
      setErrors({ general: 'Chyba pri pripájaní Google Calendar' });
      setGoogleCalendar(prev => ({ ...prev, loading: false }));
    }
  };

  const handleDisconnectGoogleCalendar = async () => {
    if (!confirm('Naozaj chcete odpojiť Google Calendar? Všetky synchronizačné dáta budú vymazané.')) {
      return;
    }
    try {
      setGoogleCalendar(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      await axios.post(`${API_URL}/google-calendar/disconnect`, {}, {
        headers: authHeaders()
      });
      setGoogleCalendar({
        connected: false,
        connectedAt: null,
        lastSyncAt: null,
        loading: false,
        syncing: false,
        pendingTasks: null,
        isDedicatedCalendar: false
      });
      setMessage('Google Calendar bol odpojený');
    } catch {
      setErrors({ general: 'Chyba pri odpájaní' });
      setGoogleCalendar(prev => ({ ...prev, loading: false }));
    }
  };

  // Removed single-workspace handleSyncGoogleCalendar — the new unified
  // handleSyncCalendar iterates every enabled workspace (respects checkbox
  // state), so the current-workspace-only variant is no longer needed.

  // Per-workspace sync toggle — lets the user explicitly enable/disable sync
  // for a specific workspace independently of the global Calendar/Tasks
  // connection. Blacklist model: default is all-on, disabled ones stored in
  // googleCalendar.syncDisabledWorkspaces / googleTasks.syncDisabledWorkspaces
  // on the server. Toggling off triggers server-side cleanup (deletes the
  // per-workspace calendar or list + any synced tasks pointing to it).
  const toggleWorkspaceSync = async ({ api, workspaceId, enabled }) => {
    const token = getStoredToken();
    return axios.post(`${API_URL}/${api}/workspace-sync-toggle`,
      { workspaceId, enabled },
      { headers: { Authorization: token ? `Bearer ${token}` : undefined } }
    );
  };

  const handleToggleCalendarWorkspace = async (workspaceId, enabled, workspaceName) => {
    // Odpojenie workspace = server vymaže všetky Prpl CRM udalosti z Google kalendára
    // pre daný workspace. Je to deštruktívna akcia, preto vyžadujeme potvrdenie.
    if (!enabled) {
      const label = workspaceName ? `„${workspaceName}"` : 'tento workspace';
      const ok = window.confirm(
        `Naozaj chcete vypnúť synchronizáciu kalendára pre ${label}?\n\n` +
        `Všetky udalosti z tohto workspace budú odstránené z vášho Google Calendara.\n` +
        `Údaje v Prpl CRM zostanú zachované.`
      );
      if (!ok) return;
    }
    // Optimisticky update lokálny state (checkbox reaguje okamžite bez čakania
    // na server) + neukazuj success banner po každom kliknutí — banner meniaci
    // výšku spôsoboval scroll jump pri rýchlom zaškrtávaní viacerých workspaces.
    // Server volanie beží v pozadí; refetch statusu je odložený na onClose
    // modalu (alebo ho vyvolá "Synchronizovať" tlačidlo).
    setGoogleCalendar(prev => {
      const current = (prev.syncDisabledWorkspaces || []).map(String);
      const wsKey = String(workspaceId);
      const next = enabled
        ? current.filter(id => id !== wsKey)
        : [...current, wsKey];
      return { ...prev, syncDisabledWorkspaces: next };
    });
    try {
      await toggleWorkspaceSync({ api: 'google-calendar', workspaceId, enabled });
    } catch (e) {
      // Rollback optimistic state + surface error
      setGoogleCalendar(prev => {
        const current = (prev.syncDisabledWorkspaces || []).map(String);
        const wsKey = String(workspaceId);
        const reverted = enabled
          ? [...current, wsKey]
          : current.filter(id => id !== wsKey);
        return { ...prev, syncDisabledWorkspaces: reverted };
      });
      setGoogleCalendarMessage(translateErrorMessage(e.response?.data?.message || e.message));
      setGoogleCalendarMessageType('error');
    }
  };

  const handleToggleTasksWorkspace = async (workspaceId, enabled, workspaceName) => {
    if (!enabled) {
      const label = workspaceName ? `„${workspaceName}"` : 'tento workspace';
      const ok = window.confirm(
        `Naozaj chcete vypnúť synchronizáciu úloh pre ${label}?\n\n` +
        `Všetky úlohy z tohto workspace budú odstránené z vašich Google Tasks (a z „Úlohy" v Google Calendari).\n` +
        `Údaje v Prpl CRM zostanú zachované.`
      );
      if (!ok) return;
    }
    // Viď komentár v handleToggleCalendarWorkspace — optimistic update
    // zabraňuje scroll jumpu spôsobenému re-renderom pending counteru
    // a pridávaniu success bannerov po každom kliknutí.
    setGoogleTasks(prev => {
      const current = (prev.syncDisabledWorkspaces || []).map(String);
      const wsKey = String(workspaceId);
      const next = enabled
        ? current.filter(id => id !== wsKey)
        : [...current, wsKey];
      return { ...prev, syncDisabledWorkspaces: next };
    });
    try {
      await toggleWorkspaceSync({ api: 'google-tasks', workspaceId, enabled });
    } catch (e) {
      setGoogleTasks(prev => {
        const current = (prev.syncDisabledWorkspaces || []).map(String);
        const wsKey = String(workspaceId);
        const reverted = enabled
          ? [...current, wsKey]
          : current.filter(id => id !== wsKey);
        return { ...prev, syncDisabledWorkspaces: reverted };
      });
      setGoogleTasksMessage(translateErrorMessage(e.response?.data?.message || e.message));
      setGoogleTasksMessageType('error');
    }
  };

  // Force-sync every workspace the user has ENABLED for sync (respects the
  // per-workspace checkboxes). Handles the "I just enabled a workspace, push
  // its existing tasks to Google now" use case — auto-sync only fires on task
  // changes, not retroactively.
  //
  // Sequential (not parallel) because concurrent /sync calls from the same
  // user would trip Google OAuth token refresh races and hit rate limits.
  //
  // Results route to per-section message state (calendar vs tasks) — not the
  // shared errors.general, which was leaking Tasks failures into the Calendar
  // card visually.
  const syncEnabledWorkspaces = async ({ api, kind, statusSetter, state, msgSetter, typeSetter }) => {
    const wsList = Array.isArray(workspaces) ? workspaces : [];
    const disabled = (state?.syncDisabledWorkspaces || []).map(String);
    const enabledWs = wsList.filter(w => {
      const id = String(w.id || w._id || '');
      return id && !disabled.includes(id);
    });
    if (enabledWs.length === 0) {
      msgSetter(`${kind}: žiadny zapnutý workspace na synchronizáciu.`);
      typeSetter('error');
      return;
    }
    statusSetter(prev => ({ ...prev, syncing: true }));
    msgSetter('');
    const token = getStoredToken();
    const succeeded = [];
    const failed = []; // { name, reason }
    // Explicit long timeout — a 400-task /sync can legitimately take 3+ min
    // with rate-limit backoffs. Default browser fetch has no timeout, but
    // some middleboxes (proxies, Render internal) cut at ~5 min. Explicit
    // axios timeout makes the failure mode clear if we ever hit it.
    const AXIOS_TIMEOUT = 12 * 60 * 1000; // 12 minutes per workspace
    const INTER_SYNC_DELAY = 2000; // 2s between sequential /sync calls — lets Google quota window breathe

    for (let i = 0; i < enabledWs.length; i++) {
      const ws = enabledWs[i];
      const wsId = ws.id || ws._id;
      try {
        await axios.post(`${API_URL}/${api}/sync`, {}, {
          headers: {
            Authorization: token ? `Bearer ${token}` : undefined,
            'X-Workspace-Id': wsId
          },
          timeout: AXIOS_TIMEOUT
        });
        succeeded.push(ws.name || wsId);
      } catch (e) {
        // Capture the REAL error for this workspace — previously we threw
        // away the server message and just showed names, so users couldn't
        // see WHY a workspace failed (quota? auth? timeout?).
        const serverMsg = e.response?.data?.message || e.code || e.message || 'neznáma chyba';
        failed.push({ name: ws.name || wsId, reason: serverMsg });
      }
      // Small pause before next workspace so we don't burst Google's quota
      // window. Skip after the last iteration to avoid pointless wait.
      if (i < enabledWs.length - 1) {
        await new Promise(r => setTimeout(r, INTER_SYNC_DELAY));
      }
    }

    statusSetter(prev => ({ ...prev, syncing: false }));

    if (failed.length === 0) {
      msgSetter(`${kind}: synchronizovaných ${succeeded.length} workspace${succeeded.length === 1 ? '' : 'ov'}.`);
      typeSetter('success');
    } else {
      // Show workspace names AND why they failed (truncated per item to keep
      // the toast readable). Users can then decide: retry, disable that ws,
      // or reconnect if it's an auth problem.
      const detail = failed
        .map(f => `${f.name}: ${String(f.reason).slice(0, 120)}`)
        .join(' | ');
      msgSetter(`${kind}: ${succeeded.length} OK, ${failed.length} zlyhalo. ${detail}`);
      typeSetter('error');
    }
  };

  const handleSyncCalendar = () =>
    syncEnabledWorkspaces({
      api: 'google-calendar',
      kind: 'Google Calendar',
      statusSetter: setGoogleCalendar,
      state: googleCalendar,
      msgSetter: setGoogleCalendarMessage,
      typeSetter: setGoogleCalendarMessageType
    }).then(() => fetchGoogleCalendarStatus());

  const handleSyncTasks = () =>
    syncEnabledWorkspaces({
      api: 'google-tasks',
      kind: 'Google Tasks',
      statusSetter: setGoogleTasks,
      state: googleTasks,
      msgSetter: setGoogleTasksMessage,
      typeSetter: setGoogleTasksMessageType
    }).then(() => fetchGoogleTasksStatus());

  // Note: legacy handlers handleMigrateCalendar / handleMigrateTasks /
  // handleDeduplicateCalendar were removed — they addressed migration from
  // pre-PR2 state and historical duplicates from pre-lock races. Users who
  // hit either edge case can now just disconnect + reconnect; the disconnect
  // cleanup (bd41c95 + 1cbcaf8 + 4607c55) scrubs every Prpl CRM-named
  // calendar/list + source=prplcrm-marked event across the user's entire
  // Google account. No separate button needed.

  const fetchGoogleTasksStatus = async (retries = 2) => {
    try {
      setGoogleTasks(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      const response = await axios.get(`${API_URL}/google-tasks/status`, {
        headers: authHeaders(),
        timeout: 15000
      });
      setGoogleTasks({
        connected: response.data.connected,
        connectedAt: response.data.connectedAt,
        lastSyncAt: response.data.lastSyncAt || null,
        loading: false,
        syncing: false,
        pendingTasks: response.data.pendingTasks || null,
        quota: response.data.quota || null,
        syncDisabledWorkspaces: response.data.syncDisabledWorkspaces || []
      });
    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
      const isNetwork = error.code === 'ERR_NETWORK' || !error.response;
      if ((isTimeout || isNetwork) && retries > 0) {
        await new Promise(r => setTimeout(r, 3000));
        return fetchGoogleTasksStatus(retries - 1);
      }
      setGoogleTasks(prev => ({ ...prev, loading: false }));
    }
  };

  const handleConnectGoogleTasks = async () => {
    try {
      setGoogleTasks(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      const response = await axios.get(`${API_URL}/google-tasks/auth-url`, {
        headers: authHeaders()
      });
      try { sessionStorage.setItem('pending_google_connect', 'tasks'); } catch { /* ignore */ }
      window.location.href = response.data.authUrl;
    } catch {
      setErrors({ general: 'Chyba pri pripájaní Google Tasks' });
      setGoogleTasks(prev => ({ ...prev, loading: false }));
    }
  };

  const handleDisconnectGoogleTasks = async () => {
    if (!confirm('Naozaj chcete odpojiť Google Tasks? Všetky synchronizačné dáta budú vymazané.')) {
      return;
    }
    try {
      setGoogleTasks(prev => ({ ...prev, loading: true }));
      const token = getStoredToken();
      await axios.post(`${API_URL}/google-tasks/disconnect`, {}, {
        headers: authHeaders()
      });
      setGoogleTasks({
        connected: false,
        connectedAt: null,
        loading: false,
        syncing: false
      });
      setMessage('Google Tasks bol odpojený');
    } catch {
      setErrors({ general: 'Chyba pri odpájaní' });
      setGoogleTasks(prev => ({ ...prev, loading: false }));
    }
  };

  // Removed single-workspace handleSyncGoogleTasks — same rationale as
  // handleSyncGoogleCalendar above.

  const handleResetAndSyncGoogleTasks = async () => {
    try {
      setGoogleTasks(prev => ({ ...prev, syncing: true }));
      setGoogleTasksMessage('');
      const token = getStoredToken();

      await axios.post(`${API_URL}/google-tasks/reset-sync`, {}, {
        headers: authHeaders(),
        timeout: 10000
      });

      const response = await axios.post(`${API_URL}/google-tasks/sync`, { force: true }, {
        headers: authHeaders(),
        timeout: 660000
      });
      setGoogleTasksMessage(response.data.message);
      setGoogleTasksMessageType('success');
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
      await fetchGoogleTasksStatus();
    } catch (error) {
      let errorMsg;
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        errorMsg = 'Synchronizácia trvala príliš dlho. Skúste to znova.';
      } else {
        errorMsg = error.response?.data?.message || error.message || 'Chyba pri synchronizácii';
      }
      setGoogleTasksMessage(translateErrorMessage(errorMsg));
      setGoogleTasksMessageType('error');
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
    }
  };

  const handleCleanupGoogleTasks = async () => {
    try {
      setGoogleTasks(prev => ({ ...prev, syncing: true }));
      setGoogleTasksMessage('');
      const token = getStoredToken();
      const response = await axios.post(`${API_URL}/google-tasks/cleanup`, {}, {
        headers: authHeaders()
      });
      setGoogleTasksMessage(response.data.message);
      setGoogleTasksMessageType('success');
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
      await fetchGoogleTasksStatus();
    } catch (error) {
      const errorMsg = error.response?.data?.message || error.message || 'Chyba pri čistení';
      setGoogleTasksMessage(translateErrorMessage(errorMsg));
      setGoogleTasksMessageType('error');
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
    }
  };

  // Note: bulk deletion of Google Tasks is handled by the user directly in Google Tasks
  // ("Odstrániť zoznam" on the "Prpl CRM" list) — we intentionally don't expose destructive
  // in-app tools to keep the flow simple and consistent with Google Calendar handling.

  const handleProfileChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  const handlePasswordDataChange = (e) => {
    const { name, value } = e.target;
    setPasswordData({ ...passwordData, [name]: value });
  };

  const handleSaveProfile = async () => {
    try {
      setErrors({});
      setMessage('');
      const token = getStoredToken();
      const response = await axios.put(`${API_URL}/auth/profile`, formData, {
        headers: authHeaders()
      });
      setProfile(response.data);
      if (onUserUpdate) {
        onUserUpdate(response.data);
      }
          setShowProfile(false);
    } catch (error) {
      setErrors({ general: error.response?.data?.message || 'Chyba pri ukladaní profilu' });
    }
  };

  const handleChangePassword = async () => {
    setErrors({});
    setMessage('');

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setErrors({ confirmPassword: 'Heslá sa nezhodujú' });
      return;
    }

    if (passwordData.newPassword.length < 6) {
      setErrors({ newPassword: 'Heslo musí mať aspoň 6 znakov' });
      return;
    }

    try {
      const token = getStoredToken();
      await axios.put(`${API_URL}/auth/password`, {
        currentPassword: passwordData.currentPassword,
        newPassword: passwordData.newPassword
      }, {
        headers: authHeaders()
      });
      setMessage('Heslo bolo úspešne zmenené');
      setPasswordData({
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
      });
    } catch (error) {
      setErrors({ general: error.response?.data?.message || 'Chyba pri zmene hesla' });
    }
  };

  const handleAvatarUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setErrors({});
    setMessage('');

    const formData = new FormData();
    formData.append('avatar', file);

    const token = getStoredToken();
    const uploadUrl = `${API_URL}/auth/avatar`;

    const xhr = new XMLHttpRequest();

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText);
          const newAvatar = response.avatar;
          const newTimestamp = Date.now();
          setProfile(prev => ({ ...prev, avatar: newAvatar }));
          setAvatarTimestamp(newTimestamp);
          setMessage('Avatar bol úspešne nahraný');
          if (onUserUpdate) {
            onUserUpdate({ avatar: newAvatar, avatarTimestamp: newTimestamp });
          }
        } catch {
          setErrors({ general: 'Chyba pri spracovaní odpovede' });
        }
      } else {
        try {
          const errorResponse = JSON.parse(xhr.responseText);
          setErrors({ general: errorResponse.message || 'Chyba pri nahrávaní avatara' });
        } catch {
          setErrors({ general: `Chyba pri nahrávaní avatara (${xhr.status})` });
        }
      }
    });

    xhr.addEventListener('error', () => {
      setErrors({ general: 'Chyba siete pri nahrávaní avatara' });
    });

    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(formData);

    e.target.value = '';
  };

  const handleDeleteAvatar = async () => {
    try {
      const token = getStoredToken();
      await axios.delete(`${API_URL}/auth/avatar`, {
        headers: authHeaders()
      });
      setProfile(prev => ({ ...prev, avatar: null }));
      setMessage('Avatar bol odstránený');
      if (onUserUpdate) {
        onUserUpdate({ avatar: null });
      }
    } catch (error) {
      setErrors({ general: error.response?.data?.message || 'Chyba pri odstraňovaní avatara' });
    }
  };

  const getInitials = (username) => {
    return username ? username.charAt(0).toUpperCase() : '?';
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('sk-SK', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  };

  const colorOptions = [
    '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
    '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'
  ];

  return (
    <div className="user-menu" ref={menuRef}>
      <button
        className="user-menu-trigger"
        onClick={() => setIsOpen(!isOpen)}
      >
        {user?.avatar ? (
          <img
            src={`${API_BASE_URL}/api/auth/avatar/${user.id}?t=${user.avatarTimestamp || avatarTimestamp}`}
            alt={user.username}
            className="user-avatar-img"
          />
        ) : (
          <div
            className="user-avatar"
            style={{ backgroundColor: user?.color || '#3B82F6' }}
          >
            {getInitials(user?.username)}
          </div>
        )}
        <div className="user-menu-info">
          <span className="user-name">{user?.username}</span>
          <span className="user-email">{user?.email}</span>
        </div>
        <span className="dropdown-arrow">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="user-menu-dropdown">
          <div className="user-menu-header">
            {user?.avatar ? (
              <img
                src={`${API_BASE_URL}/api/auth/avatar/${user.id}?t=${user.avatarTimestamp || avatarTimestamp}`}
                alt={user.username}
                className="dropdown-avatar-img"
              />
            ) : (
              <div
                className="dropdown-avatar"
                style={{ backgroundColor: user?.color || '#3B82F6' }}
              >
                {getInitials(user?.username)}
              </div>
            )}
            <div className="dropdown-user-info">
              <span className="dropdown-username">{user?.username}</span>
              <span className="dropdown-email">{user?.email}</span>
            </div>
          </div>
          {currentWorkspace && (
            <>
              <div
                className="user-menu-workspace-mobile"
                onClick={() => setShowMobileWorkspaces(!showMobileWorkspaces)}
                style={{ cursor: 'pointer' }}
              >
                <span
                  className="workspace-color-dot"
                  style={{ backgroundColor: currentWorkspace.color || '#6366f1' }}
                />
                <span className="workspace-name-mobile">{currentWorkspace.name}</span>
                <span className="workspace-role-mobile">
                  {getWorkspaceRoleLabel(currentWorkspace.role)}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#94a3b8' }}>
                  {showMobileWorkspaces ? '▲' : '▼'}
                </span>
              </div>
              {showMobileWorkspaces && (
                <div className="mobile-workspace-list">
                  {workspaces.filter(w => (w.id || w._id) !== (currentWorkspace.id || currentWorkspace._id)).map(ws => (
                    <div
                      key={ws.id || ws._id}
                      className="mobile-workspace-item"
                      onClick={async () => {
                        const wsId = ws.id || ws._id;
                        await switchWorkspaceApi(wsId);
                        // Per-device storage + native Android bridge write-through.
                        setStoredWorkspaceId(wsId);
                        // ws= URL param má v WorkspaceContext najvyššiu prioritu
                        // (nad localStorage aj DB default) → bulletproof pre
                        // Android race medzi MainActivity inject a React boot.
                        window.location.href = `/app?ws=${encodeURIComponent(wsId)}`;
                      }}
                    >
                      <span
                        className="workspace-color-dot"
                        style={{ backgroundColor: ws.color || '#6366f1' }}
                      />
                      <span className="workspace-name-mobile">{ws.name}</span>
                      <span className="workspace-role-mobile">
                        {getWorkspaceRoleLabel(ws.role)}
                      </span>
                    </div>
                  ))}
                  {currentWorkspace?.role !== 'owner' && (
                    <div
                      className="mobile-workspace-item"
                      style={{ color: '#EF4444', borderTop: '1px solid var(--border-color, #e2e8f0)' }}
                      onClick={() => setShowLeaveConfirm(true)}
                    >
                      <span style={{ fontSize: '14px' }}>🚪</span>
                      <span>Opustiť prostredie</span>
                    </div>
                  )}
                  {creatingWorkspace ? (
                    <div className="mobile-workspace-create-form">
                      <input
                        type="text"
                        value={newWorkspaceName}
                        onChange={(e) => setNewWorkspaceName(e.target.value)}
                        placeholder="Názov prostredia..."
                        className="mobile-workspace-input"
                        autoFocus
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter' && newWorkspaceName.trim()) {
                            await createWorkspace(newWorkspaceName.trim());
                            setNewWorkspaceName('');
                            setCreatingWorkspace(false);
                            window.location.href = '/app';
                          }
                          if (e.key === 'Escape') {
                            setCreatingWorkspace(false);
                            setNewWorkspaceName('');
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <div
                      className="mobile-workspace-item mobile-workspace-add"
                      onClick={() => setCreatingWorkspace(true)}
                    >
                      <span style={{ fontSize: '16px', color: '#6366f1' }}>+</span>
                      <span style={{ color: '#6366f1' }}>Nové prostredie</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <div className="user-menu-divider"></div>
          <button className="user-menu-item" onClick={handleOpenProfile}>
            <span className="menu-icon">👤</span>
            Môj profil
          </button>
          <button className="user-menu-item" onClick={handleOpenPasswordChange}>
            <span className="menu-icon">🔒</span>
            Zmeniť heslo
          </button>
          <button className="user-menu-item" onClick={handleOpenCalendarSettings}>
            <span className="menu-icon">📅</span>
            Synchronizácia kalendára
          </button>
          <div className="user-menu-divider"></div>
          <button className="user-menu-item" onClick={() => { setIsOpen(false); navigate('/workspace/members'); }}>
            <span className="menu-icon">👥</span>
            Správa tímu
          </button>
          <button className="user-menu-item" onClick={() => { setIsOpen(false); navigate('/app/billing'); }}>
            <span className="menu-icon">💳</span>
            Predplatné
          </button>
          <div className="user-menu-divider"></div>
          <button className="user-menu-item logout" onClick={onLogout}>
            <span className="menu-icon">🚪</span>
            Odhlásiť sa
          </button>
        </div>
      )}

      {showProfile && (
        <div className="modal-overlay" onClick={handleCloseProfile}>
          <div className="modal-content profile-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Môj profil</h2>
              <button className="modal-close" onClick={handleCloseProfile}>×</button>
            </div>

            {loading ? (
              <div className="modal-loading">Načítavam...</div>
            ) : !profile ? (
              <div className="modal-loading">
                <p>Nepodarilo sa načítať profil</p>
                <button className="btn btn-primary" onClick={fetchProfile} style={{ marginTop: '12px' }}>
                  Skúsiť znova
                </button>
              </div>
            ) : (
              <div className="profile-content">
                <div className="profile-avatar-section">
                  {profile.avatar ? (
                    <img
                      src={`${API_BASE_URL}/api/auth/avatar/${profile.id}?t=${avatarTimestamp}`}
                      alt={profile.username}
                      className="profile-avatar-img"
                    />
                  ) : (
                    <div
                      className="profile-avatar-placeholder"
                      style={{ backgroundColor: formData.color || profile.color }}
                    >
                      {getInitials(profile.username)}
                    </div>
                  )}
                  <div className="avatar-actions">
                    <button
                      className="btn btn-secondary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Nahrať fotku
                    </button>
                    {profile.avatar && (
                      <button
                        className="btn btn-danger"
                        onClick={handleDeleteAvatar}
                      >
                        Odstrániť
                      </button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleAvatarUpload}
                      style={{ display: 'none' }}
                    />
                  </div>
                </div>

                <div className="profile-form">
                  <div className="form-group">
                    <label>Užívateľské meno</label>
                    <input
                      type="text"
                      name="username"
                      value={formData.username}
                      onChange={handleProfileChange}
                      className="form-input"
                    />
                  </div>
                  <div className="form-group">
                    <label>Email</label>
                    <input
                      type="email"
                      name="email"
                      value={formData.email}
                      onChange={handleProfileChange}
                      className="form-input"
                    />
                  </div>
                  <div className="form-group">
                    <label>Farba profilu</label>
                    <div className="color-picker">
                      {colorOptions.map(color => (
                        <div
                          key={color}
                          className={`color-option ${formData.color === color ? 'selected' : ''}`}
                          style={{ backgroundColor: color }}
                          onClick={() => setFormData({ ...formData, color })}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => e.key === 'Enter' && setFormData({ ...formData, color })}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Registrovaný od</label>
                    <span className="profile-info-value">{formatDate(profile.createdAt)}</span>
                  </div>
                </div>

                {message && <div className="form-success">{message}</div>}
                {errors.general && <div className="form-error">{errors.general}</div>}

                <div className="modal-actions">
                  <button className="btn btn-primary" onClick={handleSaveProfile}>
                    Uložiť zmeny
                  </button>
                  <button className="btn btn-secondary" onClick={handleCloseProfile}>
                    Zavrieť
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showPasswordChange && (
        <div className="modal-overlay" onClick={handleClosePasswordChange}>
          <div className="modal-content password-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Zmena hesla</h2>
              <button className="modal-close" onClick={handleClosePasswordChange}>×</button>
            </div>

            <div className="password-form">
              <div className="form-group">
                <label>Aktuálne heslo</label>
                <input
                  type="password"
                  name="currentPassword"
                  value={passwordData.currentPassword}
                  onChange={handlePasswordDataChange}
                  className="form-input"
                />
              </div>
              <div className="form-group">
                <label>Nové heslo</label>
                <input
                  type="password"
                  name="newPassword"
                  value={passwordData.newPassword}
                  onChange={handlePasswordDataChange}
                  className={`form-input ${errors.newPassword ? 'form-input-error' : ''}`}
                />
                {errors.newPassword && <span className="form-error">{errors.newPassword}</span>}
              </div>
              <div className="form-group">
                <label>Potvrdiť nové heslo</label>
                <input
                  type="password"
                  name="confirmPassword"
                  value={passwordData.confirmPassword}
                  onChange={handlePasswordDataChange}
                  className={`form-input ${errors.confirmPassword ? 'form-input-error' : ''}`}
                />
                {errors.confirmPassword && <span className="form-error">{errors.confirmPassword}</span>}
              </div>

              {message && <div className="form-success">{message}</div>}
              {errors.general && <div className="form-error">{errors.general}</div>}

              <div className="modal-actions">
                <button className="btn btn-primary" onClick={handleChangePassword}>
                  Zmeniť heslo
                </button>
                <button className="btn btn-secondary" onClick={handleClosePasswordChange}>
                  Zavrieť
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCalendarSettings && (
        <div className="modal-overlay" onClick={handleCloseCalendarSettings}>
          <div className="modal-content calendar-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Synchronizácia kalendára</h2>
              <button className="modal-close" onClick={handleCloseCalendarSettings}>×</button>
            </div>

            <div className="modal-body">
              {/* Stručný návod — zbalený by-default, rozbalí sa na kliknutie.
                  <details> drží vlastný state, netreba React useState. */}
              <details
                style={{
                  marginBottom: '16px',
                  padding: '12px 14px',
                  background: '#F5F3FF',
                  border: '1px solid #DDD6FE',
                  borderRadius: '8px'
                }}
              >
                <summary style={{
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '14px',
                  color: '#5B21B6',
                  userSelect: 'none'
                }}>
                  📖 Ako to funguje (návod)
                </summary>
                <div style={{ marginTop: '10px', fontSize: '13px', color: '#4C1D95', lineHeight: '1.6' }}>
                  <ol style={{ margin: '0 0 8px 18px', padding: 0 }}>
                    <li><strong>Pripojte Google účet</strong> — kliknite „Pripojiť Google Calendar" alebo „Pripojiť Google Tasks".</li>
                    <li><strong>Vyberte workspace</strong> — zaškrtnite tie, ktoré sa majú synchronizovať. Pre každý vzniká vlastný kalendár <em>„Prpl CRM — názov workspace"</em> s farbou workspace.</li>
                    <li><strong>Kliknite „Synchronizovať"</strong> — nahrá všetky existujúce úlohy a udalosti zo zaškrtnutých workspaces do Googlu. Ďalšie zmeny idú automaticky v reálnom čase.</li>
                  </ol>
                  <div style={{ marginTop: '8px', padding: '8px 10px', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: '6px', color: '#92400E' }}>
                    ⚠️ <strong>Pozor:</strong> Odškrtnutie workspace alebo „Odpojiť" <strong>vymaže príslušné udalosti/úlohy z Google</strong>. Dáta v Prpl CRM zostávajú zachované.
                  </div>
                  <div style={{ marginTop: '8px', fontSize: '12px', color: '#6D28D9' }}>
                    💡 Google Tasks sa v Google Calendari zobrazia pod spoločnou položkou „Úlohy" — každá úloha má prefix <code>[Workspace]</code> v názve, aby ste vedeli, z ktorého workspace pochádza.
                  </div>
                </div>
              </details>

              {/* Web Push toggle — desktop-only.
                  Hidden on all mobile (iOS native → APNs, Android native → FCM,
                  iOS Safari → no Web Push outside PWA, Android Chrome → native app
                  is the recommended path). Also keeps the legacy ios-app body-class
                  gate for older WebView shells. */}
              {!isMobileDevice() && !document.body.classList.contains('ios-app') && (
              <div className="calendar-section push-notifications-section">
                <h3>🔔 Push notifikácie</h3>
                <p className="section-description">
                  Dostávajte notifikácie aj keď máte aplikáciu zatvorenú.
                </p>
                <PushNotificationToggle />
              </div>
              )}

              <div className="calendar-section google-calendar-section">
                <h3>🚀 Google Calendar (Okamžitá synchronizácia)</h3>
                <p className="section-description">
                  Priame prepojenie s Google Calendar. Zmeny sa prejavia <strong>okamžite</strong>.
                </p>

                {googleCalendar.loading ? (
                  <div className="calendar-loading">Načítavam...</div>
                ) : googleCalendar.connected ? (
                  <div className="calendar-enabled">
                    <div className="calendar-status">
                      <span className="status-indicator active"></span>
                      <span>Google Calendar je pripojený</span>
                    </div>
                    {googleCalendar.connectedAt && (
                      <p className="connected-info">
                        Pripojený od: {new Date(googleCalendar.connectedAt).toLocaleDateString('sk-SK')}
                        {googleCalendar.lastSyncAt && (
                          <span style={{ marginLeft: '8px', color: '#6B7280' }}>
                            · Posledná sync: {new Date(googleCalendar.lastSyncAt).toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                        )}
                      </p>
                    )}

                    {googleCalendar.pendingTasks && (
                      <div className="sync-status-info" style={{
                        marginTop: '12px',
                        padding: '12px',
                        backgroundColor: googleCalendar.pendingTasks.pending > 0 ? '#FEF3C7' : '#D1FAE5',
                        borderRadius: '8px',
                        fontSize: '14px'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span>Synchronizované:</span>
                          <strong>{googleCalendar.pendingTasks.synced} / {googleCalendar.pendingTasks.total}</strong>
                        </div>
                        {googleCalendar.pendingTasks.pending > 0 && (
                          <div style={{ color: '#B45309', fontWeight: '500' }}>
                            ⏳ Čaká na synchronizáciu: {googleCalendar.pendingTasks.pending} úloh
                          </div>
                        )}
                        {googleCalendar.pendingTasks.pending === 0 && googleCalendar.pendingTasks.total > 0 && (
                          <div style={{ color: '#059669', fontWeight: '500' }}>
                            ✅ Všetky úlohy sú synchronizované
                          </div>
                        )}
                        {googleCalendar.pendingTasks.total === 0 && (
                          <div style={{ color: '#059669', fontWeight: '500' }}>
                            Žiadne úlohy s termínom na synchronizáciu
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{
                      marginTop: '10px',
                      padding: '10px 12px',
                      background: '#EEF2FF',
                      border: '1px solid #C7D2FE',
                      borderRadius: '6px',
                      fontSize: '13px',
                      color: '#3730A3',
                      lineHeight: '1.5'
                    }}>
                      ℹ️ Pre každý workspace vzniká v Google Calendari samostatný kalendár <strong>„Prpl CRM — názov workspace"</strong> s vlastnou farbou. Kliknutím <strong>Odpojiť</strong> sa zmažú všetky Prpl CRM kalendáre aj udalosti naraz.
                    </div>

                    {Array.isArray(workspaces) && workspaces.length > 0 && (
                      <div style={{
                        marginTop: '12px',
                        padding: '10px 12px',
                        backgroundColor: '#F9FAFB',
                        border: '1px solid #E5E7EB',
                        borderRadius: '6px'
                      }}>
                        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: '#374151' }}>
                          Synchronizované workspace:
                        </div>
                        {workspaces.map(ws => {
                          const wsId = String(ws.id || ws._id);
                          const disabled = (googleCalendar.syncDisabledWorkspaces || []).map(String);
                          const enabled = !disabled.includes(wsId);
                          return (
                            <label key={wsId} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={enabled}
                                disabled={googleCalendar.syncing}
                                onChange={(e) => handleToggleCalendarWorkspace(wsId, e.target.checked, ws.name)}
                              />
                              <span>{ws.name}</span>
                            </label>
                          );
                        })}
                        <div style={{ fontSize: '11px', color: '#6B7280', marginTop: '6px' }}>
                          Vypnuté workspace sa nebudú synchronizovať. Existujúce udalosti v Google sa automaticky zmažú.
                        </div>
                      </div>
                    )}

                    {/* Jednoduchá kompaktná akcia — auto-sync + per-workspace
                        checkboxy pokrývajú 99% prípadov. Manuálne Synchronizovať
                        je ponechané iba ako safety net (znovu-zapnutie
                        workspace, premenovanie, Google hiccup). */}
                    <div style={{
                      marginTop: '12px',
                      display: 'flex',
                      gap: '8px',
                      flexWrap: 'wrap'
                    }}>
                      <button
                        type="button"
                        onClick={handleSyncCalendar}
                        disabled={googleCalendar.syncing}
                        title="Manuálne spustí synchronizáciu pre zaškrtnuté workspace (bežne netreba — sync beží automaticky)"
                        style={{
                          padding: '6px 12px',
                          fontSize: '13px',
                          backgroundColor: '#6366F1',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          cursor: googleCalendar.syncing ? 'not-allowed' : 'pointer',
                          opacity: googleCalendar.syncing ? 0.6 : 1
                        }}
                      >
                        {googleCalendar.syncing ? '⏳ Synchronizujem…' : '🔄 Synchronizovať'}
                      </button>
                      <button
                        type="button"
                        onClick={handleDisconnectGoogleCalendar}
                        disabled={googleCalendar.syncing}
                        style={{
                          padding: '6px 12px',
                          fontSize: '13px',
                          backgroundColor: '#EF4444',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          cursor: googleCalendar.syncing ? 'not-allowed' : 'pointer',
                          opacity: googleCalendar.syncing ? 0.6 : 1
                        }}
                      >
                        Odpojiť
                      </button>
                    </div>

                    {googleCalendarMessage && (
                      <div className="form-success" style={{
                        marginTop: '12px',
                        ...(googleCalendarMessageType === 'error' ? {
                          background: '#FEE2E2',
                          color: '#DC2626'
                        } : {})
                      }}>
                        {googleCalendarMessage}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="calendar-disabled">
                    <button className="btn btn-google" onClick={handleConnectGoogleCalendar}>
                      <svg width="18" height="18" viewBox="0 0 24 24" style={{ marginRight: '8px' }}>
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                      </svg>
                      Pripojiť Google Calendar
                    </button>
                  </div>
                )}
              </div>

              <div className="calendar-section google-tasks-section" style={{ marginTop: '24px' }}>
                <h3>✅ Google Tasks (Projekty s odškrtávaním)</h3>
                <p className="section-description">
                  Synchronizácia do Google Tasks. Projekty sa dajú <strong>odškrtnúť</strong> priamo v kalendári.
                </p>

                {googleTasks.loading ? (
                  <div className="calendar-loading">Načítavam...</div>
                ) : googleTasks.connected ? (
                  <div className="calendar-enabled">
                    <div className="calendar-status">
                      <span className="status-indicator active"></span>
                      <span>Google Tasks je pripojený</span>
                    </div>
                    {googleTasks.connectedAt && (
                      <p className="connected-info">
                        Pripojený od: {new Date(googleTasks.connectedAt).toLocaleDateString('sk-SK')}
                        {googleTasks.lastSyncAt && (
                          <span style={{ marginLeft: '8px', color: '#6B7280' }}>
                            · Posledná sync: {new Date(googleTasks.lastSyncAt).toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                        )}
                      </p>
                    )}

                    {googleTasks.pendingTasks && (
                      <div className="sync-status-info" style={{
                        marginTop: '12px',
                        padding: '12px',
                        backgroundColor: googleTasks.pendingTasks.pending > 0 ? '#FEF3C7' : '#D1FAE5',
                        borderRadius: '8px',
                        fontSize: '14px'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span>Synchronizované:</span>
                          <strong>{googleTasks.pendingTasks.synced} / {googleTasks.pendingTasks.total}</strong>
                        </div>
                        {googleTasks.pendingTasks.pending > 0 && (
                          <div style={{ color: '#B45309', fontWeight: '500' }}>
                            ⏳ Čaká na synchronizáciu: {googleTasks.pendingTasks.pending} projektov
                          </div>
                        )}
                        {googleTasks.pendingTasks.pending === 0 && (
                          <div style={{ color: '#059669', fontWeight: '500' }}>
                            ✅ Všetky projekty sú synchronizované
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{
                      marginTop: '10px',
                      padding: '10px 12px',
                      background: '#EEF2FF',
                      border: '1px solid #C7D2FE',
                      borderRadius: '6px',
                      fontSize: '13px',
                      color: '#3730A3',
                      lineHeight: '1.5'
                    }}>
                      ℹ️ Pre každý workspace vzniká v Google Tasks samostatný zoznam <strong>„Prpl CRM — názov workspace"</strong>. Úlohy sa zobrazia aj v Google Calendar cez „Úlohy" v bočnom paneli. Kliknutím <strong>Odpojiť</strong> sa zmažú všetky Prpl CRM zoznamy aj úlohy naraz.
                    </div>

                    {Array.isArray(workspaces) && workspaces.length > 0 && (
                      <div style={{
                        marginTop: '12px',
                        padding: '10px 12px',
                        backgroundColor: '#F9FAFB',
                        border: '1px solid #E5E7EB',
                        borderRadius: '6px'
                      }}>
                        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: '#374151' }}>
                          Synchronizované workspace:
                        </div>
                        {workspaces.map(ws => {
                          const wsId = String(ws.id || ws._id);
                          const disabled = (googleTasks.syncDisabledWorkspaces || []).map(String);
                          const enabled = !disabled.includes(wsId);
                          return (
                            <label key={wsId} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={enabled}
                                disabled={googleTasks.syncing}
                                onChange={(e) => handleToggleTasksWorkspace(wsId, e.target.checked, ws.name)}
                              />
                              <span>{ws.name}</span>
                            </label>
                          );
                        })}
                        <div style={{ fontSize: '11px', color: '#6B7280', marginTop: '6px' }}>
                          Vypnuté workspace sa nebudú synchronizovať. Existujúce úlohy v Google sa automaticky zmažú.
                        </div>
                      </div>
                    )}

                    <div style={{
                      marginTop: '12px',
                      display: 'flex',
                      gap: '8px',
                      flexWrap: 'wrap'
                    }}>
                      <button
                        type="button"
                        onClick={handleSyncTasks}
                        disabled={googleTasks.syncing}
                        title="Manuálne spustí synchronizáciu pre zaškrtnuté workspace (bežne netreba — sync beží automaticky)"
                        style={{
                          padding: '6px 12px',
                          fontSize: '13px',
                          backgroundColor: '#6366F1',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          cursor: googleTasks.syncing ? 'not-allowed' : 'pointer',
                          opacity: googleTasks.syncing ? 0.6 : 1
                        }}
                      >
                        {googleTasks.syncing ? '⏳ Synchronizujem…' : '🔄 Synchronizovať'}
                      </button>
                      <button
                        type="button"
                        onClick={handleDisconnectGoogleTasks}
                        disabled={googleTasks.syncing}
                        style={{
                          padding: '6px 12px',
                          fontSize: '13px',
                          backgroundColor: '#EF4444',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          cursor: googleTasks.syncing ? 'not-allowed' : 'pointer',
                          opacity: googleTasks.syncing ? 0.6 : 1
                        }}
                      >
                        Odpojiť
                      </button>
                    </div>
                    {googleTasksMessage && (
                      <div className="form-success" style={{
                        marginTop: '12px',
                        ...(googleTasksMessageType === 'error' ? {
                          background: '#FEE2E2',
                          color: '#DC2626'
                        } : {})
                      }}>
                        {googleTasksMessage}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="calendar-disabled">
                    <button className="btn btn-google" onClick={handleConnectGoogleTasks}>
                      <svg width="18" height="18" viewBox="0 0 24 24" style={{ marginRight: '8px' }}>
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                      </svg>
                      Pripojiť Google Tasks
                    </button>
                    <p className="calendar-note" style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
                      Projekty sa zobrazia v Google Tasks a na bočnom paneli Google Calendar.
                    </p>
                  </div>
                )}
              </div>

            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={handleCloseCalendarSettings}>
                Zavrieť
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Leave workspace confirm modal */}
      {showLeaveConfirm && currentWorkspace && (
        <div className="workspace-leave-overlay" onClick={() => !leavingWorkspace && setShowLeaveConfirm(false)}>
          <div className="workspace-leave-modal" onClick={e => e.stopPropagation()}>
            <div className="workspace-leave-modal-icon">🚪</div>
            <h3 className="workspace-leave-modal-title">Opustiť prostredie?</h3>
            <p className="workspace-leave-modal-text">
              Naozaj chcete opustiť prostredie <strong>{currentWorkspace.name}</strong>?
              Stratíte prístup ku všetkým kontaktom, projektom a úlohám v tomto prostredí.
              Pre opätovný prístup vás bude musieť niekto znova pozvať.
            </p>
            <div className="workspace-leave-modal-actions">
              <button
                className="workspace-leave-modal-btn cancel"
                onClick={() => setShowLeaveConfirm(false)}
                disabled={leavingWorkspace}
              >
                Zrušiť
              </button>
              <button
                className="workspace-leave-modal-btn confirm"
                onClick={async () => {
                  try {
                    setLeavingWorkspace(true);
                    await leaveWorkspaceApi();
                    window.location.href = '/app';
                  } catch (err) {
                    alert(err.response?.data?.message || 'Chyba pri opúšťaní prostredia');
                    setLeavingWorkspace(false);
                    setShowLeaveConfirm(false);
                  }
                }}
                disabled={leavingWorkspace}
              >
                {leavingWorkspace ? 'Opúšťam...' : 'Áno, opustiť'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default UserMenu;
