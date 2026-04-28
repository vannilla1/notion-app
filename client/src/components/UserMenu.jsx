import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../api/api';
import { getStoredToken } from '../utils/authStorage';
import PushNotificationToggle from './PushNotificationToggle';
import NotificationPreferences from './NotificationPreferences';
import ConnectedAccounts from './ConnectedAccounts';
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
  const [showNotifPrefs, setShowNotifPrefs] = useState(false);
  const [showMobileWorkspaces, setShowMobileWorkspaces] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [leavingWorkspace, setLeavingWorkspace] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatingWorkspaceSubmitting, setCreatingWorkspaceSubmitting] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [showProfile, setShowProfile] = useState(false);
  const [showConnectedAccounts, setShowConnectedAccounts] = useState(false);
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
  // Per-workspace toggle status (busy/done/error) — rendered ako fixed-width
  // badge vedľa checkboxu. Pridané po tom, čo sme kvôli scroll-jumpu zrušili
  // success banner po každom kliknutí: bez tohoto indikátora user nevedel či
  // unsync prebehol, a falošne si myslel že musí kliknúť "Synchronizovať".
  // Shape: { [workspaceId]: 'busy' | 'done-off' | 'done-off-N' | 'error' }.
  // Ukazuje sa LEN pri reálnom disconnect-cleanupe (vypnutie už synchronizovaného
  // workspacu). Zapnutie a vypnutie prázdneho workspacu sú no-op → bez badge.
  const [calendarWsStatus, setCalendarWsStatus] = useState({});
  const [tasksWsStatus, setTasksWsStatus] = useState({});
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
        syncDisabledWorkspaces: response.data.syncDisabledWorkspaces || [],
        syncedWorkspaces: response.data.syncedWorkspaces || []
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
    // Explicitný destruction warning — odpojenie zmaže VŠETKO čo appka
    // vytvorila v Google Calendari (všetky "Prpl CRM — {workspace}" kalendáre
    // + ich eventy naprieč všetkými workspaces). User musí vedieť čo klikne,
    // aby sa predišlo náhodným kliknutiam.
    if (!confirm(
      'Naozaj chcete odpojiť Google Calendar?\n\n' +
      'Zmaže sa:\n' +
      '• Pripojenie vášho Google účtu\n' +
      '• Všetky kalendáre „Prpl CRM — názov workspace" z Google Calendara\n' +
      '• Všetky udalosti, ktoré do nich appka synchronizovala\n\n' +
      'Dáta v Prpl CRM (úlohy, termíny) zostanú zachované a synchronizáciu ' +
      'môžete kedykoľvek obnoviť kliknutím na „Pripojiť Google Calendar".'
    )) {
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
    // pre daný workspace. Je to deštruktívna akcia, preto vyžadujeme potvrdenie —
    // ALE len ak tento workspace reálne niečo v Google má (`syncedWorkspaces`).
    // Inak je to no-op a confirm by bol mätúci ("naozaj zmazať?" → niet čo zmazať).
    if (!enabled) {
      const synced = (googleCalendar.syncedWorkspaces || []).map(String);
      const hasSyncedData = synced.includes(String(workspaceId));
      if (hasSyncedData) {
        const label = workspaceName ? `„${workspaceName}"` : 'tento workspace';
        const ok = window.confirm(
          `Naozaj chcete vypnúť synchronizáciu kalendára pre ${label}?\n\n` +
          `Všetky udalosti z tohto workspace budú odstránené z vášho Google Calendara.\n` +
          `Údaje v Prpl CRM zostanú zachované.`
        );
        if (!ok) return;
      }
    }
    // Optimisticky update lokálny state (checkbox reaguje okamžite bez čakania
    // na server) + neukazuj success banner po každom kliknutí — banner meniaci
    // výšku spôsoboval scroll jump pri rýchlom zaškrtávaní viacerých workspaces.
    // Server volanie beží v pozadí; refetch statusu je odložený na onClose
    // modalu (alebo ho vyvolá "Synchronizovať" tlačidlo).
    const wsKey = String(workspaceId);
    // Badge ukazujeme LEN pri reálnom disconnect-cleanupe (disable + workspace
    // mal v Google niečo zosynchronizované). V ostatných prípadoch (zapnutie,
    // alebo vypnutie nikdy-nesynchronizovaného) je akcia vizuálne no-op —
    // užívateľ badge nepotrebuje. Iba error badge sa ukáže vždy.
    const syncedCal = (googleCalendar.syncedWorkspaces || []).map(String);
    const wasSynced = syncedCal.includes(wsKey);
    const showBadge = !enabled && wasSynced;
    setGoogleCalendar(prev => {
      const current = (prev.syncDisabledWorkspaces || []).map(String);
      const next = enabled
        ? current.filter(id => id !== wsKey)
        : [...current, wsKey];
      return { ...prev, syncDisabledWorkspaces: next };
    });
    if (showBadge) {
      setCalendarWsStatus(prev => ({ ...prev, [wsKey]: 'busy' }));
    }
    try {
      const res = await toggleWorkspaceSync({ api: 'google-calendar', workspaceId, enabled });
      const cleaned = res?.data?.eventsCleanedUp || 0;
      if (showBadge) {
        setCalendarWsStatus(prev => ({
          ...prev,
          [wsKey]: cleaned > 0 ? `done-off-${cleaned}` : 'done-off'
        }));
      }
      // Refetch status → horný riadok "N / M úloh čaká na synchronizáciu" sa
      // prepočíta hneď po zmene checkboxu. Predtým sa aktualizoval iba po
      // kliknutí na "Synchronizovať", čo bolo mätúce (user odznačil workspace,
      // čísla sa nehli → neveril tomu).
      fetchGoogleCalendarStatus();
      // Auto-clear badge po pár sekundách — user videl potvrdenie, ďalej už
      // prekáža. Fixed-width placeholder sa nezmrští, takže žiaden scroll jump.
      if (showBadge) {
        setTimeout(() => {
          setCalendarWsStatus(prev => {
            const copy = { ...prev };
            delete copy[wsKey];
            return copy;
          });
        }, 4000);
      }
    } catch (e) {
      // Rollback optimistic state + surface error
      setGoogleCalendar(prev => {
        const current = (prev.syncDisabledWorkspaces || []).map(String);
        const reverted = enabled
          ? [...current, wsKey]
          : current.filter(id => id !== wsKey);
        return { ...prev, syncDisabledWorkspaces: reverted };
      });
      setCalendarWsStatus(prev => ({ ...prev, [wsKey]: 'error' }));
      setGoogleCalendarMessage(translateErrorMessage(e.response?.data?.message || e.message));
      setGoogleCalendarMessageType('error');
    }
  };

  const handleToggleTasksWorkspace = async (workspaceId, enabled, workspaceName) => {
    // Rovnaká logika ako v handleToggleCalendarWorkspace — skip confirm ak
    // workspace v Google Tasks reálne žiadny task list nemá.
    if (!enabled) {
      const synced = (googleTasks.syncedWorkspaces || []).map(String);
      const hasSyncedData = synced.includes(String(workspaceId));
      if (hasSyncedData) {
        const label = workspaceName ? `„${workspaceName}"` : 'tento workspace';
        const ok = window.confirm(
          `Naozaj chcete vypnúť synchronizáciu úloh pre ${label}?\n\n` +
          `Všetky úlohy z tohto workspace budú odstránené z vašich Google Tasks (a z „Úlohy" v Google Calendari).\n` +
          `Údaje v Prpl CRM zostanú zachované.`
        );
        if (!ok) return;
      }
    }
    // Viď komentár v handleToggleCalendarWorkspace — optimistic update
    // zabraňuje scroll jumpu spôsobenému re-renderom pending counteru
    // a pridávaniu success bannerov po každom kliknutí.
    const wsKey = String(workspaceId);
    const syncedTasks = (googleTasks.syncedWorkspaces || []).map(String);
    const wasSyncedT = syncedTasks.includes(wsKey);
    const showBadgeT = !enabled && wasSyncedT;
    setGoogleTasks(prev => {
      const current = (prev.syncDisabledWorkspaces || []).map(String);
      const next = enabled
        ? current.filter(id => id !== wsKey)
        : [...current, wsKey];
      return { ...prev, syncDisabledWorkspaces: next };
    });
    if (showBadgeT) {
      setTasksWsStatus(prev => ({ ...prev, [wsKey]: 'busy' }));
    }
    try {
      const res = await toggleWorkspaceSync({ api: 'google-tasks', workspaceId, enabled });
      const cleaned = res?.data?.tasksCleanedUp || res?.data?.eventsCleanedUp || 0;
      if (showBadgeT) {
        setTasksWsStatus(prev => ({
          ...prev,
          [wsKey]: cleaned > 0 ? `done-off-${cleaned}` : 'done-off'
        }));
      }
      // Refetch status → prepočíta pending counter v hornom riadku, aby user
      // hneď videl koľko úloh teraz čaká na synchronizáciu.
      fetchGoogleTasksStatus();
      if (showBadgeT) {
        setTimeout(() => {
          setTasksWsStatus(prev => {
            const copy = { ...prev };
            delete copy[wsKey];
            return copy;
          });
        }, 4000);
      }
    } catch (e) {
      setGoogleTasks(prev => {
        const current = (prev.syncDisabledWorkspaces || []).map(String);
        const reverted = enabled
          ? [...current, wsKey]
          : current.filter(id => id !== wsKey);
        return { ...prev, syncDisabledWorkspaces: reverted };
      });
      setTasksWsStatus(prev => ({ ...prev, [wsKey]: 'error' }));
      setGoogleTasksMessage(translateErrorMessage(e.response?.data?.message || e.message));
      setGoogleTasksMessageType('error');
    }
  };

  // Master "Označiť všetky" toggle — prepne naraz všetky workspace-y. Volá
  // existujúce single-workspace handlery sekvenčne (paralelné /workspace-sync-toggle
  // volania by trafili Google OAuth refresh race + rate limit pri masovom
  // cleanupe). Pri odškrtnutí sa confirm ukáže JEDENKRÁT za všetky synchronizované
  // workspace-y dokopy — nie N-krát individuálne.
  const handleToggleAllCalendarWorkspaces = async (checkAll) => {
    const wsList = Array.isArray(workspaces) ? workspaces : [];
    if (wsList.length === 0) return;
    const disabledSet = new Set((googleCalendar.syncDisabledWorkspaces || []).map(String));
    const syncedSet = new Set((googleCalendar.syncedWorkspaces || []).map(String));

    if (checkAll) {
      // Zapnúť všetky aktuálne vypnuté — žiaden confirm netreba.
      const toEnable = wsList.filter(w => disabledSet.has(String(w.id || w._id)));
      for (const w of toEnable) {
        await handleToggleCalendarWorkspace(String(w.id || w._id), true, w.name);
      }
    } else {
      // Vypnúť všetky zapnuté. Spočítaj koľko z nich reálne má v Google dáta
      // a ukáž JEDEN agregovaný confirm (len ak aspoň jeden z nich sa skutočne
      // bude čistiť — inak ticho prepneme bez otravovania).
      const toDisable = wsList.filter(w => !disabledSet.has(String(w.id || w._id)));
      const withSyncedData = toDisable.filter(w => syncedSet.has(String(w.id || w._id)));
      if (withSyncedData.length > 0) {
        const ok = window.confirm(
          `Naozaj chcete vypnúť synchronizáciu kalendára pre všetky workspace-y?\n\n` +
          `Zo synchronizovaných ${withSyncedData.length} workspace-ov budú udalosti odstránené ` +
          `z vášho Google Calendara.\nÚdaje v Prpl CRM zostanú zachované.`
        );
        if (!ok) return;
      }
      // Single-workspace handler bežne pýta vlastný confirm — ten by sa N-krát
      // zopakoval. Obídeme ho tým, že zavoláme priamo API + optimistic update
      // (kopírujeme minimum potrebného zo single handleru).
      for (const w of toDisable) {
        const wsId = String(w.id || w._id);
        const hadSynced = syncedSet.has(wsId);
        setGoogleCalendar(prev => {
          const current = (prev.syncDisabledWorkspaces || []).map(String);
          return current.includes(wsId)
            ? prev
            : { ...prev, syncDisabledWorkspaces: [...current, wsId] };
        });
        if (hadSynced) setCalendarWsStatus(prev => ({ ...prev, [wsId]: 'busy' }));
        try {
          const res = await toggleWorkspaceSync({ api: 'google-calendar', workspaceId: wsId, enabled: false });
          const cleaned = res?.data?.eventsCleanedUp || 0;
          if (hadSynced) {
            setCalendarWsStatus(prev => ({
              ...prev,
              [wsId]: cleaned > 0 ? `done-off-${cleaned}` : 'done-off'
            }));
            setTimeout(() => {
              setCalendarWsStatus(prev => {
                const copy = { ...prev };
                delete copy[wsId];
                return copy;
              });
            }, 4000);
          }
        } catch (e) {
          setGoogleCalendar(prev => {
            const current = (prev.syncDisabledWorkspaces || []).map(String);
            return { ...prev, syncDisabledWorkspaces: current.filter(id => id !== wsId) };
          });
          setCalendarWsStatus(prev => ({ ...prev, [wsId]: 'error' }));
          setGoogleCalendarMessage(translateErrorMessage(e.response?.data?.message || e.message));
          setGoogleCalendarMessageType('error');
        }
      }
      fetchGoogleCalendarStatus();
    }
  };

  const handleToggleAllTasksWorkspaces = async (checkAll) => {
    const wsList = Array.isArray(workspaces) ? workspaces : [];
    if (wsList.length === 0) return;
    const disabledSet = new Set((googleTasks.syncDisabledWorkspaces || []).map(String));
    const syncedSet = new Set((googleTasks.syncedWorkspaces || []).map(String));

    if (checkAll) {
      const toEnable = wsList.filter(w => disabledSet.has(String(w.id || w._id)));
      for (const w of toEnable) {
        await handleToggleTasksWorkspace(String(w.id || w._id), true, w.name);
      }
    } else {
      const toDisable = wsList.filter(w => !disabledSet.has(String(w.id || w._id)));
      const withSyncedData = toDisable.filter(w => syncedSet.has(String(w.id || w._id)));
      if (withSyncedData.length > 0) {
        const ok = window.confirm(
          `Naozaj chcete vypnúť synchronizáciu úloh pre všetky workspace-y?\n\n` +
          `Zo synchronizovaných ${withSyncedData.length} workspace-ov budú úlohy odstránené ` +
          `z vašich Google Tasks.\nÚdaje v Prpl CRM zostanú zachované.`
        );
        if (!ok) return;
      }
      for (const w of toDisable) {
        const wsId = String(w.id || w._id);
        const hadSynced = syncedSet.has(wsId);
        setGoogleTasks(prev => {
          const current = (prev.syncDisabledWorkspaces || []).map(String);
          return current.includes(wsId)
            ? prev
            : { ...prev, syncDisabledWorkspaces: [...current, wsId] };
        });
        if (hadSynced) setTasksWsStatus(prev => ({ ...prev, [wsId]: 'busy' }));
        try {
          const res = await toggleWorkspaceSync({ api: 'google-tasks', workspaceId: wsId, enabled: false });
          const cleaned = res?.data?.tasksCleanedUp || 0;
          if (hadSynced) {
            setTasksWsStatus(prev => ({
              ...prev,
              [wsId]: cleaned > 0 ? `done-off-${cleaned}` : 'done-off'
            }));
            setTimeout(() => {
              setTasksWsStatus(prev => {
                const copy = { ...prev };
                delete copy[wsId];
                return copy;
              });
            }, 4000);
          }
        } catch (e) {
          setGoogleTasks(prev => {
            const current = (prev.syncDisabledWorkspaces || []).map(String);
            return { ...prev, syncDisabledWorkspaces: current.filter(id => id !== wsId) };
          });
          setTasksWsStatus(prev => ({ ...prev, [wsId]: 'error' }));
          setGoogleTasksMessage(translateErrorMessage(e.response?.data?.message || e.message));
          setGoogleTasksMessageType('error');
        }
      }
      fetchGoogleTasksStatus();
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
        syncDisabledWorkspaces: response.data.syncDisabledWorkspaces || [],
        syncedWorkspaces: response.data.syncedWorkspaces || []
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
    // Viď komentár v handleDisconnectGoogleCalendar — rovnaký princíp,
    // len pre Google Tasks zoznamy.
    if (!confirm(
      'Naozaj chcete odpojiť Google Tasks?\n\n' +
      'Zmaže sa:\n' +
      '• Pripojenie vášho Google účtu\n' +
      '• Všetky zoznamy „Prpl CRM — názov workspace" z Google Tasks\n' +
      '• Všetky úlohy, ktoré do nich appka synchronizovala (aj v sekcii ' +
      '„Úlohy" v Google Calendari)\n\n' +
      'Dáta v Prpl CRM zostanú zachované a synchronizáciu môžete kedykoľvek ' +
      'obnoviť kliknutím na „Pripojiť Google Tasks".'
    )) {
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
                            try {
                              // Backend očakáva { name: '...' }, nie čistý string.
                              await createWorkspace({ name: newWorkspaceName.trim() });
                              setNewWorkspaceName('');
                              setCreatingWorkspace(false);
                              window.location.href = '/app';
                            } catch (err) {
                              alert(err?.response?.data?.message || 'Nepodarilo sa vytvoriť prostredie');
                            }
                          }
                          if (e.key === 'Escape') {
                            setCreatingWorkspace(false);
                            setNewWorkspaceName('');
                          }
                        }}
                      />
                      <div className="mobile-workspace-create-actions">
                        <button
                          type="button"
                          className="mobile-workspace-btn mobile-workspace-btn-cancel"
                          onClick={() => {
                            setCreatingWorkspace(false);
                            setNewWorkspaceName('');
                          }}
                        >
                          Zrušiť
                        </button>
                        <button
                          type="button"
                          className="mobile-workspace-btn mobile-workspace-btn-confirm"
                          disabled={!newWorkspaceName.trim() || creatingWorkspaceSubmitting}
                          onClick={async () => {
                            const trimmed = newWorkspaceName.trim();
                            if (!trimmed || creatingWorkspaceSubmitting) return;
                            setCreatingWorkspaceSubmitting(true);
                            try {
                              await createWorkspace({ name: trimmed });
                              setNewWorkspaceName('');
                              setCreatingWorkspace(false);
                              window.location.href = '/app';
                            } catch (err) {
                              alert(err?.response?.data?.message || 'Nepodarilo sa vytvoriť prostredie');
                              setCreatingWorkspaceSubmitting(false);
                            }
                          }}
                        >
                          {creatingWorkspaceSubmitting ? 'Vytváram…' : 'Vytvoriť'}
                        </button>
                      </div>
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
          <button className="user-menu-item" onClick={() => { setIsOpen(false); setShowConnectedAccounts(true); }}>
            <span className="menu-icon">🔗</span>
            Pripojené účty
          </button>
          <button className="user-menu-item" onClick={handleOpenCalendarSettings}>
            <span className="menu-icon">📅</span>
            Synchronizácia kalendára
          </button>
          <button className="user-menu-item" onClick={() => { setIsOpen(false); setShowNotifPrefs(true); }}>
            <span className="menu-icon">🔔</span>
            Nastavenia notifikácií
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
                  <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid #DDD6FE' }}>
                    <strong>Čo robia checkboxy pri workspace-och:</strong>
                    <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                      <li><strong>Zaškrtnutie</strong> — workspace sa zapne na synchronizáciu. Nové zmeny (nová úloha, zmena dátumu) sa budú posielať do Google automaticky v reálnom čase. Existujúce úlohy, ktoré v Google ešte nie sú, pošlite jednorazovo cez tlačidlo „Synchronizovať".</li>
                      <li><strong>Odškrtnutie</strong> — všetky udalosti/úlohy daného workspace sa <strong>okamžite zmažú z Google</strong> (Calendar aj Tasks). Dáta v Prpl CRM zostávajú zachované.</li>
                    </ul>
                  </div>
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
                        {/* Master checkbox — užitočný keď user má veľa
                            workspace-ov. "checked" len keď sú všetky zapnuté,
                            `indeterminate` keď je zapnutá iba časť (tri-state
                            reaguje jasnejšie než obyčajný binary checkbox). */}
                        {workspaces.length > 1 && (() => {
                          const disabled = (googleCalendar.syncDisabledWorkspaces || []).map(String);
                          const totalCount = workspaces.length;
                          const enabledCount = workspaces.filter(w => !disabled.includes(String(w.id || w._id))).length;
                          const allChecked = enabledCount === totalCount;
                          const noneChecked = enabledCount === 0;
                          return (
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', marginBottom: '6px', borderBottom: '1px dashed #E5E7EB', paddingBottom: '6px', fontSize: '13px', fontWeight: 600, color: '#4B5563', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={allChecked}
                                ref={el => { if (el) el.indeterminate = !allChecked && !noneChecked; }}
                                disabled={googleCalendar.syncing}
                                onChange={(e) => handleToggleAllCalendarWorkspaces(e.target.checked)}
                              />
                              <span style={{ flex: 1 }}>Označiť všetky</span>
                              <span style={{ fontSize: '11px', color: '#6B7280', fontWeight: 400 }}>
                                {enabledCount} / {totalCount}
                              </span>
                            </label>
                          );
                        })()}
                        {workspaces.map(ws => {
                          const wsId = String(ws.id || ws._id);
                          const disabled = (googleCalendar.syncDisabledWorkspaces || []).map(String);
                          const enabled = !disabled.includes(wsId);
                          const status = calendarWsStatus[wsId];
                          let badge = '';
                          let badgeColor = '#6B7280';
                          if (status === 'busy') { badge = '⏳ pracujem…'; badgeColor = '#6366F1'; }
                          else if (status === 'done-off') { badge = '✓ vypnuté a vyčistené'; badgeColor = '#10B981'; }
                          else if (typeof status === 'string' && status.startsWith('done-off-')) {
                            const n = status.slice('done-off-'.length);
                            badge = `✓ zmazaných ${n}`;
                            badgeColor = '#10B981';
                          } else if (status === 'error') { badge = '⚠ chyba'; badgeColor = '#DC2626'; }
                          return (
                            <label key={wsId} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={enabled}
                                disabled={googleCalendar.syncing}
                                onChange={(e) => handleToggleCalendarWorkspace(wsId, e.target.checked, ws.name)}
                              />
                              <span style={{ flex: 1 }}>{ws.name}</span>
                              {/* Fixed-width status badge — reserved space, so
                                  appearing/disappearing text nespôsobí layout shift
                                  (to bol pôvodný scroll-jump bug). */}
                              <span style={{ minWidth: '150px', textAlign: 'right', fontSize: '11px', color: badgeColor, fontWeight: 500 }}>
                                {badge}
                              </span>
                            </label>
                          );
                        })}
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
                        {/* Master checkbox — viď komentár v Calendar sekcii. */}
                        {workspaces.length > 1 && (() => {
                          const disabled = (googleTasks.syncDisabledWorkspaces || []).map(String);
                          const totalCount = workspaces.length;
                          const enabledCount = workspaces.filter(w => !disabled.includes(String(w.id || w._id))).length;
                          const allChecked = enabledCount === totalCount;
                          const noneChecked = enabledCount === 0;
                          return (
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', marginBottom: '6px', borderBottom: '1px dashed #E5E7EB', paddingBottom: '6px', fontSize: '13px', fontWeight: 600, color: '#4B5563', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={allChecked}
                                ref={el => { if (el) el.indeterminate = !allChecked && !noneChecked; }}
                                disabled={googleTasks.syncing}
                                onChange={(e) => handleToggleAllTasksWorkspaces(e.target.checked)}
                              />
                              <span style={{ flex: 1 }}>Označiť všetky</span>
                              <span style={{ fontSize: '11px', color: '#6B7280', fontWeight: 400 }}>
                                {enabledCount} / {totalCount}
                              </span>
                            </label>
                          );
                        })()}
                        {workspaces.map(ws => {
                          const wsId = String(ws.id || ws._id);
                          const disabled = (googleTasks.syncDisabledWorkspaces || []).map(String);
                          const enabled = !disabled.includes(wsId);
                          const status = tasksWsStatus[wsId];
                          let badge = '';
                          let badgeColor = '#6B7280';
                          if (status === 'busy') { badge = '⏳ pracujem…'; badgeColor = '#6366F1'; }
                          else if (status === 'done-off') { badge = '✓ vypnuté a vyčistené'; badgeColor = '#10B981'; }
                          else if (typeof status === 'string' && status.startsWith('done-off-')) {
                            const n = status.slice('done-off-'.length);
                            badge = `✓ zmazaných ${n}`;
                            badgeColor = '#10B981';
                          } else if (status === 'error') { badge = '⚠ chyba'; badgeColor = '#DC2626'; }
                          return (
                            <label key={wsId} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={enabled}
                                disabled={googleTasks.syncing}
                                onChange={(e) => handleToggleTasksWorkspace(wsId, e.target.checked, ws.name)}
                              />
                              <span style={{ flex: 1 }}>{ws.name}</span>
                              <span style={{ minWidth: '150px', textAlign: 'right', fontSize: '11px', color: badgeColor, fontWeight: 500 }}>
                                {badge}
                              </span>
                            </label>
                          );
                        })}
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

      {showNotifPrefs && (
        <NotificationPreferences onClose={() => setShowNotifPrefs(false)} />
      )}

      <ConnectedAccounts
        open={showConnectedAccounts}
        onClose={() => setShowConnectedAccounts(false)}
      />
    </div>
  );
}

export default UserMenu;
