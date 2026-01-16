import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../api/api';

function UserMenu({ user, onLogout, onUserUpdate }) {
  const navigate = useNavigate();
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
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
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
    await fetchCalendarFeedStatus();
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
              <div className="calendar-info">
                <p>
                  Prepojte svoje úlohy s externým kalendárom (Google Calendar, Apple Calendar, Outlook a ďalšie).
                  Všetky zmeny v CRM sa automaticky premietnu do vášho kalendára.
                </p>
              </div>

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
                          <li>Zadajte názov kalendára (napr. "Perun CRM")</li>
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
