import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../api/api';

function UserMenu({ user, onLogout, onUserUpdate }) {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
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
    </div>
  );
}

export default UserMenu;
