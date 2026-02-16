import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../api/api';
import PushNotificationToggle from './PushNotificationToggle';
import { useWorkspace } from '../context/WorkspaceContext';

/**
 * Translate common API error messages to Slovak
 */
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
  const { currentWorkspace } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
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
    loading: false,
    syncing: false
  });
  const [googleTasks, setGoogleTasks] = useState({
    connected: false,
    connectedAt: null,
    loading: false,
    syncing: false,
    pendingTasks: null,
    quota: null
  });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [googleTasksMessage, setGoogleTasksMessage] = useState('');
  const [deleteSearchTerm, setDeleteSearchTerm] = useState('');
  const [avatarTimestamp, setAvatarTimestamp] = useState(Date.now());
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

  const fetchProfile = async () => {
    try {
      setLoading(true);
      setErrors({});
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/auth/profile`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setProfile(response.data);
      setFormData({
        username: response.data.username,
        email: response.data.email,
        color: response.data.color
      });
    } catch (error) {
      console.error('Error fetching profile:', error);
      // Fallback - použiť lokálneho usera ak server zlyhá
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
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/tasks/calendar/feed/status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCalendarFeed({
        enabled: response.data.enabled,
        feedUrl: response.data.feedUrl,
        loading: false
      });
    } catch (error) {
      console.error('Error fetching calendar feed status:', error);
      setCalendarFeed(prev => ({ ...prev, loading: false }));
    }
  };

  const handleEnableCalendarFeed = async () => {
    try {
      setCalendarFeed(prev => ({ ...prev, loading: true }));
      const token = localStorage.getItem('token');
      const response = await axios.post(`${API_URL}/tasks/calendar/feed/generate`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCalendarFeed({
        enabled: true,
        feedUrl: response.data.feedUrl,
        loading: false
      });
      setMessage('Kalendár feed bol aktivovaný');
    } catch (error) {
      console.error('Error enabling calendar feed:', error);
      setErrors({ general: 'Chyba pri aktivácii kalendár feedu' });
      setCalendarFeed(prev => ({ ...prev, loading: false }));
    }
  };

  const handleDisableCalendarFeed = async () => {
    try {
      setCalendarFeed(prev => ({ ...prev, loading: true }));
      const token = localStorage.getItem('token');
      await axios.post(`${API_URL}/tasks/calendar/feed/disable`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCalendarFeed({
        enabled: false,
        feedUrl: null,
        loading: false
      });
      setMessage('Kalendár feed bol deaktivovaný');
    } catch (error) {
      console.error('Error disabling calendar feed:', error);
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
      const token = localStorage.getItem('token');
      const response = await axios.post(`${API_URL}/tasks/calendar/feed/regenerate`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCalendarFeed({
        enabled: true,
        feedUrl: response.data.feedUrl,
        loading: false
      });
      setMessage('Nový kalendár feed bol vygenerovaný');
    } catch (error) {
      console.error('Error regenerating calendar feed:', error);
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

  // Google Calendar functions
  const fetchGoogleCalendarStatus = async () => {
    try {
      setGoogleCalendar(prev => ({ ...prev, loading: true }));
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/google-calendar/status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setGoogleCalendar({
        connected: response.data.connected,
        connectedAt: response.data.connectedAt,
        loading: false,
        syncing: false
      });
    } catch (error) {
      console.error('Error fetching Google Calendar status:', error);
      setGoogleCalendar(prev => ({ ...prev, loading: false }));
    }
  };

  const handleConnectGoogleCalendar = async () => {
    try {
      setGoogleCalendar(prev => ({ ...prev, loading: true }));
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/google-calendar/auth-url`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      // Redirect to Google OAuth
      window.location.href = response.data.authUrl;
    } catch (error) {
      console.error('Error connecting Google Calendar:', error);
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
      const token = localStorage.getItem('token');
      await axios.post(`${API_URL}/google-calendar/disconnect`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setGoogleCalendar({
        connected: false,
        connectedAt: null,
        loading: false,
        syncing: false
      });
      setMessage('Google Calendar bol odpojený');
    } catch (error) {
      console.error('Error disconnecting Google Calendar:', error);
      setErrors({ general: 'Chyba pri odpájaní' });
      setGoogleCalendar(prev => ({ ...prev, loading: false }));
    }
  };

  const handleSyncGoogleCalendar = async () => {
    try {
      setGoogleCalendar(prev => ({ ...prev, syncing: true }));
      const token = localStorage.getItem('token');
      const response = await axios.post(`${API_URL}/google-calendar/sync`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMessage(response.data.message);
      setGoogleCalendar(prev => ({ ...prev, syncing: false }));
    } catch (error) {
      console.error('Error syncing Google Calendar:', error);
      const errorMsg = error.response?.data?.message || error.message || 'Chyba pri synchronizácii';
      setErrors({ general: translateErrorMessage(errorMsg) });
      setGoogleCalendar(prev => ({ ...prev, syncing: false }));
    }
  };

  const handleCleanupGoogleCalendar = async () => {
    try {
      setGoogleCalendar(prev => ({ ...prev, syncing: true }));
      const token = localStorage.getItem('token');
      const response = await axios.post(`${API_URL}/google-calendar/cleanup`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMessage(response.data.message);
      setGoogleCalendar(prev => ({ ...prev, syncing: false }));
    } catch (error) {
      console.error('Error cleaning up Google Calendar:', error);
      const errorMsg = error.response?.data?.message || error.message || 'Chyba pri čistení';
      setErrors({ general: translateErrorMessage(errorMsg) });
      setGoogleCalendar(prev => ({ ...prev, syncing: false }));
    }
  };

  // Google Tasks functions
  const fetchGoogleTasksStatus = async () => {
    try {
      setGoogleTasks(prev => ({ ...prev, loading: true }));
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/google-tasks/status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setGoogleTasks({
        connected: response.data.connected,
        connectedAt: response.data.connectedAt,
        loading: false,
        syncing: false,
        pendingTasks: response.data.pendingTasks || null,
        quota: response.data.quota || null
      });
    } catch (error) {
      console.error('Error fetching Google Tasks status:', error);
      setGoogleTasks(prev => ({ ...prev, loading: false }));
    }
  };

  const handleConnectGoogleTasks = async () => {
    try {
      setGoogleTasks(prev => ({ ...prev, loading: true }));
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/google-tasks/auth-url`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      window.location.href = response.data.authUrl;
    } catch (error) {
      console.error('Error connecting Google Tasks:', error);
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
      const token = localStorage.getItem('token');
      await axios.post(`${API_URL}/google-tasks/disconnect`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setGoogleTasks({
        connected: false,
        connectedAt: null,
        loading: false,
        syncing: false
      });
      setMessage('Google Tasks bol odpojený');
    } catch (error) {
      console.error('Error disconnecting Google Tasks:', error);
      setErrors({ general: 'Chyba pri odpájaní' });
      setGoogleTasks(prev => ({ ...prev, loading: false }));
    }
  };

  const handleSyncGoogleTasks = async () => {
    try {
      setGoogleTasks(prev => ({ ...prev, syncing: true }));
      setGoogleTasksMessage('');
      const token = localStorage.getItem('token');

      // First sync FROM Google (completed tasks) THEN sync TO Google
      // This ensures bi-directional sync
      try {
        await axios.post(`${API_URL}/google-tasks/sync-completed`, {}, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 30000 // 30 second timeout
        });
      } catch (e) {
        console.log('Sync completed from Google skipped:', e.message);
      }

      const response = await axios.post(`${API_URL}/google-tasks/sync`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 330000 // 5.5 min timeout (server has 5 min limit + buffer)
      });
      setGoogleTasksMessage(response.data.message);
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
      // Refresh status to show updated quota and sync counts
      await fetchGoogleTasksStatus();
    } catch (error) {
      console.error('Error syncing Google Tasks:', error);
      let errorMsg;
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        errorMsg = 'Synchronizácia trvala príliš dlho. Skúste to znova.';
      } else {
        errorMsg = error.response?.data?.message || error.message || 'Chyba pri synchronizácii';
      }
      setGoogleTasksMessage(translateErrorMessage(errorMsg));
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
    }
  };

  const handleResetAndSyncGoogleTasks = async () => {
    try {
      setGoogleTasks(prev => ({ ...prev, syncing: true }));
      setGoogleTasksMessage('');
      const token = localStorage.getItem('token');

      // Step 1: Reset sync state
      await axios.post(`${API_URL}/google-tasks/reset-sync`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });

      // Step 2: Run full sync
      const response = await axios.post(`${API_URL}/google-tasks/sync`, { force: true }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 330000
      });
      setGoogleTasksMessage(response.data.message);
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
      await fetchGoogleTasksStatus();
    } catch (error) {
      console.error('Error in reset and sync:', error);
      let errorMsg;
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        errorMsg = 'Synchronizácia trvala príliš dlho. Skúste to znova.';
      } else {
        errorMsg = error.response?.data?.message || error.message || 'Chyba pri synchronizácii';
      }
      setGoogleTasksMessage(translateErrorMessage(errorMsg));
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
    }
  };

  const handleCleanupGoogleTasks = async () => {
    try {
      setGoogleTasks(prev => ({ ...prev, syncing: true }));
      setGoogleTasksMessage('');
      const token = localStorage.getItem('token');
      const response = await axios.post(`${API_URL}/google-tasks/cleanup`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setGoogleTasksMessage(response.data.message);
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
      // Refresh status to show updated counts
      await fetchGoogleTasksStatus();
    } catch (error) {
      console.error('Error cleaning up Google Tasks:', error);
      const errorMsg = error.response?.data?.message || error.message || 'Chyba pri čistení';
      setGoogleTasksMessage(translateErrorMessage(errorMsg));
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
    }
  };

  const handleDeleteBySearch = async (searchTerm) => {
    if (!searchTerm || searchTerm.length < 2) {
      setGoogleTasksMessage('Zadajte aspoň 2 znaky pre vyhľadávanie');
      return;
    }

    if (!confirm(`Naozaj chcete vymazať všetky úlohy obsahujúce "${searchTerm}" z Google Tasks?`)) {
      return;
    }

    try {
      setGoogleTasks(prev => ({ ...prev, syncing: true }));
      setGoogleTasksMessage('');
      const token = localStorage.getItem('token');
      const response = await axios.post(`${API_URL}/google-tasks/delete-by-search`,
        { searchTerm },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setGoogleTasksMessage(response.data.message);
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
      await fetchGoogleTasksStatus();
    } catch (error) {
      console.error('Error deleting by search:', error);
      const errorMsg = error.response?.data?.message || error.message || 'Chyba pri mazaní';
      setGoogleTasksMessage(translateErrorMessage(errorMsg));
      setGoogleTasks(prev => ({ ...prev, syncing: false }));
    }
  };

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
      const token = localStorage.getItem('token');
      const response = await axios.put(`${API_URL}/auth/profile`, formData, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setProfile(response.data);
      if (onUserUpdate) {
        onUserUpdate(response.data);
      }
      // Zavrieť modálne okno po úspešnom uložení
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
      const token = localStorage.getItem('token');
      await axios.put(`${API_URL}/auth/password`, {
        currentPassword: passwordData.currentPassword,
        newPassword: passwordData.newPassword
      }, {
        headers: { Authorization: `Bearer ${token}` }
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

    const token = localStorage.getItem('token');
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
      const token = localStorage.getItem('token');
      await axios.delete(`${API_URL}/auth/avatar`, {
        headers: { Authorization: `Bearer ${token}` }
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
        <span className="user-name">{user?.username}</span>
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
          {/* Mobile-only workspace info */}
          {currentWorkspace && (
            <div className="user-menu-workspace-mobile">
              <span
                className="workspace-color-dot"
                style={{ backgroundColor: currentWorkspace.color || '#6366f1' }}
              />
              <span className="workspace-name-mobile">{currentWorkspace.name}</span>
              <span className="workspace-role-mobile">
                {currentWorkspace.role === 'owner' ? 'Vlastník' : currentWorkspace.role === 'admin' ? 'Admin' : 'Člen'}
              </span>
            </div>
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
          {user?.role === 'admin' && (
            <>
              <div className="user-menu-divider"></div>
              <button className="user-menu-item" onClick={() => { setIsOpen(false); navigate('/admin'); }}>
                <span className="menu-icon">⚙️</span>
                Správa používateľov
              </button>
            </>
          )}
          <div className="user-menu-divider"></div>
          <button className="user-menu-item logout" onClick={onLogout}>
            <span className="menu-icon">🚪</span>
            Odhlásiť sa
          </button>
        </div>
      )}

      {/* Profile Modal */}
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
                {/* Avatar Section */}
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

                {/* Profile Form */}
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

      {/* Password Change Modal */}
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

      {/* Calendar Settings Modal */}
      {showCalendarSettings && (
        <div className="modal-overlay" onClick={handleCloseCalendarSettings}>
          <div className="modal-content calendar-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Synchronizácia kalendára</h2>
              <button className="modal-close" onClick={handleCloseCalendarSettings}>×</button>
            </div>

            <div className="modal-body">
              {/* Push Notifications */}
              <div className="calendar-section push-notifications-section">
                <h3>🔔 Push notifikácie</h3>
                <p className="section-description">
                  Dostávajte notifikácie aj keď máte aplikáciu zatvorenú.
                </p>
                <PushNotificationToggle />
              </div>

              {/* Google Calendar - Okamžitá synchronizácia */}
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
                      </p>
                    )}
                    <div className="calendar-actions" style={{ marginTop: '12px' }}>
                      <button
                        className="btn btn-primary"
                        onClick={handleSyncGoogleCalendar}
                        disabled={googleCalendar.syncing}
                      >
                        {googleCalendar.syncing ? '⏳ Synchronizujem...' : '🔄 Synchronizovať teraz'}
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={handleCleanupGoogleCalendar}
                        disabled={googleCalendar.syncing}
                        title="Odstráni z kalendára udalosti, ktoré už nemajú zodpovedajúcu úlohu"
                      >
                        Vycistit stare
                      </button>
                      <button className="btn btn-danger" onClick={handleDisconnectGoogleCalendar}>
                        Odpojiť
                      </button>
                    </div>
                    {message && (
                      <div className="form-success" style={{ marginTop: '12px' }}>
                        {message}
                      </div>
                    )}
                    {errors.general && (
                      <div className="form-error" style={{ marginTop: '12px' }}>
                        {errors.general}
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

              {/* Google Tasks - Úlohy s odškrtávaním */}
              <div className="calendar-section google-tasks-section" style={{ marginTop: '24px' }}>
                <h3>✅ Google Tasks (Úlohy s odškrtávaním)</h3>
                <p className="section-description">
                  Synchronizácia do Google Tasks. Úlohy sa dajú <strong>odškrtnúť</strong> priamo v kalendári.
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
                      </p>
                    )}

                    {/* Pending tasks info */}
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
                            ⏳ Čaká na synchronizáciu: {googleTasks.pendingTasks.pending} úloh
                          </div>
                        )}
                        {googleTasks.pendingTasks.pending === 0 && (
                          <div style={{ color: '#059669', fontWeight: '500' }}>
                            ✅ Všetky úlohy sú synchronizované
                          </div>
                        )}
                      </div>
                    )}

                    {/* Quota info */}
                    {googleTasks.quota && (
                      <div style={{
                        marginTop: '12px',
                        padding: '12px',
                        backgroundColor: googleTasks.quota.remaining < 1000 ? '#FEE2E2' : '#F3F4F6',
                        borderRadius: '8px',
                        fontSize: '13px'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span>Denná kvóta API:</span>
                          <strong>{googleTasks.quota.used.toLocaleString()} / {googleTasks.quota.limit.toLocaleString()}</strong>
                        </div>
                        <div style={{
                          width: '100%',
                          height: '6px',
                          backgroundColor: '#E5E7EB',
                          borderRadius: '3px',
                          marginBottom: '6px'
                        }}>
                          <div style={{
                            width: `${Math.min(googleTasks.quota.percentUsed, 100)}%`,
                            height: '100%',
                            backgroundColor: googleTasks.quota.percentUsed > 80 ? '#EF4444' : googleTasks.quota.percentUsed > 50 ? '#F59E0B' : '#10B981',
                            borderRadius: '3px',
                            transition: 'width 0.3s ease'
                          }} />
                        </div>
                        <div style={{ color: '#6B7280', fontSize: '12px' }}>
                          Zostáva: {googleTasks.quota.remaining.toLocaleString()} volaní
                          <span style={{ float: 'right' }}>
                            Reset: {new Date(googleTasks.quota.resetsAt).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' })} UTC
                          </span>
                        </div>
                        {googleTasks.pendingTasks && googleTasks.pendingTasks.pending > 0 && (
                          <div style={{ marginTop: '8px', color: '#6B7280', fontSize: '12px', fontStyle: 'italic' }}>
                            Tip: Ak kvóta nestačí, zvyšné úlohy sa dosyncujú zajtra automaticky pri ďalšej synchronizácii.
                          </div>
                        )}
                      </div>
                    )}

                    <div className="calendar-actions" style={{ marginTop: '12px' }}>
                      <button
                        className="btn btn-primary"
                        onClick={handleSyncGoogleTasks}
                        disabled={googleTasks.syncing}
                      >
                        {googleTasks.syncing ? '⏳ Synchronizujem...' : '🔄 Synchronizovať'}
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={handleResetAndSyncGoogleTasks}
                        disabled={googleTasks.syncing}
                        title="Vymaže staré sync dáta a synchronizuje všetko odznova"
                      >
                        🔃 Plná sync
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={handleCleanupGoogleTasks}
                        disabled={googleTasks.syncing}
                        title="Odstráni úlohy, ktoré už nemajú zodpovedajúcu úlohu v CRM"
                      >
                        Vyčistiť
                      </button>
                      <button className="btn btn-danger" onClick={handleDisconnectGoogleTasks}>
                        Odpojiť
                      </button>
                    </div>
                    <div style={{ marginTop: '12px', padding: '10px', background: '#f8f9fa', borderRadius: '6px' }}>
                      <label style={{ fontSize: '12px', color: '#666', marginBottom: '4px', display: 'block' }}>
                        Vymazať z Google Tasks podľa názvu:
                      </label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                          type="text"
                          value={deleteSearchTerm}
                          onChange={(e) => setDeleteSearchTerm(e.target.value)}
                          placeholder="napr. vzor"
                          style={{ flex: 1, padding: '6px 10px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
                          disabled={googleTasks.syncing}
                        />
                        <button
                          className="btn btn-warning"
                          onClick={() => handleDeleteBySearch(deleteSearchTerm)}
                          disabled={googleTasks.syncing || deleteSearchTerm.length < 2}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          Vymazať
                        </button>
                      </div>
                    </div>
                    {googleTasksMessage && !googleTasks.syncing && (
                      <div className="form-success" style={{ marginTop: '12px' }}>
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
                      Úlohy sa zobrazia v Google Tasks a na bočnom paneli Google Calendar.
                    </p>
                  </div>
                )}
              </div>

              <div className="calendar-divider">
                <span>alebo</span>
              </div>

              {/* ICS Feed - Klasická synchronizácia */}
              <div className="calendar-section ics-feed-section">
                <h3>📅 ICS Feed (Všetky kalendáre)</h3>
                <p className="section-description">
                  Univerzálny odkaz pre Apple Calendar, Outlook a iné. Aktualizácia každých 15-60 minút.
                </p>

              {calendarFeed.loading ? (
                <div className="calendar-loading">Načítavam...</div>
              ) : calendarFeed.enabled ? (
                <div className="calendar-enabled">
                  <div className="calendar-status">
                    <span className="status-indicator active"></span>
                    <span>Synchronizácia je aktívna</span>
                  </div>

                  <div className="calendar-feed-url">
                    <label>Odkaz pre kalendár:</label>
                    <input
                      type="text"
                      value={calendarFeed.feedUrl || ''}
                      readOnly
                      className="form-input"
                      style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px', marginBottom: '8px' }}
                      onClick={(e) => e.target.select()}
                    />
                    <button className="btn btn-primary" onClick={handleCopyFeedUrl} style={{ width: '100%' }}>
                      📋 Kopírovať odkaz
                    </button>
                  </div>

                  <div className="calendar-instructions">
                    <h4>Ako pridať do kalendára:</h4>
                    <div className="instructions-tabs">
                      <details>
                        <summary>Google Calendar (Web)</summary>
                        <ol>
                          <li>Otvorte <a href="https://calendar.google.com" target="_blank" rel="noopener noreferrer">calendar.google.com</a></li>
                          <li>V ľavom paneli nájdite "Ďalšie kalendáre"</li>
                          <li>Kliknite na <strong>+</strong> a vyberte <strong>"Z webovej adresy"</strong></li>
                          <li>Vložte skopírovaný odkaz do poľa "URL kalendára"</li>
                          <li>Kliknite <strong>"Pridať kalendár"</strong></li>
                        </ol>
                        <p className="instruction-note">Kalendár sa aktualizuje automaticky každých 15-30 minút.</p>
                      </details>
                      <details>
                        <summary>Google Calendar (Android)</summary>
                        <ol>
                          <li>Na Androide nie je možné pridať priamo - použite webovú verziu</li>
                          <li>Otvorte <a href="https://calendar.google.com" target="_blank" rel="noopener noreferrer">calendar.google.com</a> v prehliadači</li>
                          <li>Postupujte podľa návodu pre Web vyššie</li>
                          <li>Kalendár sa automaticky zobrazí v Android aplikácii</li>
                        </ol>
                      </details>
                      <details>
                        <summary>Apple Calendar (iPhone)</summary>
                        <ol>
                          <li>Otvorte <strong>Nastavenia</strong> na iPhone</li>
                          <li>Prejdite na <strong>Kalendár → Účty</strong></li>
                          <li>Kliknite <strong>"Pridať účet"</strong></li>
                          <li>Vyberte <strong>"Iné"</strong></li>
                          <li>Kliknite <strong>"Pridať odber kalendára"</strong></li>
                          <li>Vložte skopírovaný odkaz do poľa "Server"</li>
                          <li>Kliknite <strong>"Ďalej"</strong> a potom <strong>"Uložiť"</strong></li>
                        </ol>
                        <p className="instruction-note">Kalendár sa aktualizuje automaticky každých 15-60 minút.</p>
                      </details>
                      <details>
                        <summary>Apple Calendar (Mac)</summary>
                        <ol>
                          <li>Otvorte aplikáciu <strong>Kalendár</strong></li>
                          <li>V menu kliknite <strong>Súbor → Nový odber kalendára...</strong></li>
                          <li>Vložte skopírovaný odkaz</li>
                          <li>Kliknite <strong>"Prihlásiť sa"</strong></li>
                          <li>Nastavte automatickú aktualizáciu a kliknite <strong>"OK"</strong></li>
                        </ol>
                      </details>
                      <details>
                        <summary>Outlook (Web - outlook.com)</summary>
                        <ol>
                          <li>Otvorte <a href="https://outlook.live.com/calendar" target="_blank" rel="noopener noreferrer">outlook.live.com/calendar</a></li>
                          <li>Kliknite na <strong>"Pridať kalendár"</strong> v ľavom paneli</li>
                          <li>Vyberte <strong>"Prihlásiť sa na odber z webu"</strong></li>
                          <li>Vložte skopírovaný odkaz</li>
                          <li>Zadajte názov kalendára (napr. "Purple CRM")</li>
                          <li>Kliknite <strong>"Importovať"</strong></li>
                        </ol>
                        <p className="instruction-note">Kalendár sa aktualizuje automaticky každých 30-60 minút.</p>
                      </details>
                      <details>
                        <summary>Outlook (Desktop aplikácia)</summary>
                        <ol>
                          <li>Otvorte Outlook a prejdite do <strong>Kalendára</strong></li>
                          <li>Kliknite pravým na <strong>"Moje kalendáre"</strong></li>
                          <li>Vyberte <strong>"Pridať kalendár" → "Z Internetu..."</strong></li>
                          <li>Vložte skopírovaný odkaz</li>
                          <li>Kliknite <strong>"OK"</strong></li>
                        </ol>
                      </details>
                      <details>
                        <summary>Iné kalendáre (CalDAV)</summary>
                        <ol>
                          <li>Väčšina kalendárových aplikácií podporuje ICS/iCalendar formát</li>
                          <li>Hľadajte možnosť "Pridať kalendár z URL" alebo "Subscribe"</li>
                          <li>Vložte skopírovaný odkaz</li>
                          <li>Kalendár sa bude automaticky aktualizovať</li>
                        </ol>
                        <p className="instruction-note">Podporované: Thunderbird, Nextcloud, Synology Calendar, Fastmail a ďalšie.</p>
                      </details>
                    </div>
                    <div className="calendar-sync-info">
                      <strong>Čo sa synchronizuje:</strong>
                      <ul>
                        <li>Všetky úlohy s termínom (vrátane podúloh)</li>
                        <li>Dokončené úlohy sú označené ✓</li>
                        <li>Priorita a popis úlohy</li>
                        <li>Prepojený kontakt</li>
                      </ul>
                    </div>
                  </div>

                  {message && <div className="form-success">{message}</div>}
                  {errors.general && <div className="form-error">{errors.general}</div>}

                  <div className="calendar-actions">
                    <button className="btn btn-secondary" onClick={handleRegenerateCalendarFeed}>
                      Vygenerovať nový odkaz
                    </button>
                    <button className="btn btn-danger" onClick={handleDisableCalendarFeed}>
                      Deaktivovať
                    </button>
                  </div>
                </div>
              ) : (
                <div className="calendar-disabled">
                  <div className="calendar-status">
                    <span className="status-indicator inactive"></span>
                    <span>Synchronizácia nie je aktívna</span>
                  </div>

                  <p className="calendar-description">
                    Po aktivácii získate unikátny odkaz, ktorý môžete pridať do svojho kalendára.
                    Kalendár sa bude automaticky aktualizovať pri každej zmene úloh.
                  </p>

                  {message && <div className="form-success">{message}</div>}
                  {errors.general && <div className="form-error">{errors.general}</div>}

                  <button className="btn btn-primary" onClick={handleEnableCalendarFeed}>
                    Aktivovať synchronizáciu
                  </button>
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
    </div>
  );
}

export default UserMenu;
