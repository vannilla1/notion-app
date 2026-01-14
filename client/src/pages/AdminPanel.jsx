import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import UserMenu from '../components/UserMenu';

function AdminPanel() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);

  useEffect(() => {
    // Redirect non-admin users
    if (user && user.role !== 'admin') {
      navigate('/');
    }
  }, [user, navigate]);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const res = await api.get('/api/auth/users');
      setUsers(res.data);
    } catch (error) {
      console.error('Failed to fetch users:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    if (userId === user.id && newRole !== 'admin') {
      if (!window.confirm('Naozaj chcete odstrániť svoje admin práva? Túto akciu nebude možné vrátiť späť bez pomoci iného admina.')) {
        return;
      }
    }

    setUpdating(userId);
    try {
      await api.put(`/api/auth/users/${userId}/role`, { role: newRole });
      setUsers(prev => prev.map(u =>
        u.id === userId ? { ...u, role: newRole } : u
      ));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri zmene role');
    } finally {
      setUpdating(null);
    }
  };

  const getRoleLabel = (role) => {
    switch (role) {
      case 'admin': return 'Admin';
      case 'manager': return 'Manažér';
      case 'user': return 'Používateľ';
      default: return role;
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString('sk-SK');
  };

  if (user?.role !== 'admin') {
    return null;
  }

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <button
            className="btn btn-secondary"
            onClick={() => navigate('/')}
          >
            ← Späť
          </button>
          <h1 className="header-title-link" onClick={() => navigate('/')}>Perun CRM</h1>
        </div>
        <div className="crm-header-right">
          <UserMenu
            user={user}
            onLogout={logout}
            onUserUpdate={updateUser}
          />
        </div>
      </header>

      <div className="admin-content">
        <div className="admin-panel">
          <h2>Správa používateľov</h2>
          <p className="admin-description">
            Spravujte role používateľov v systéme. Admin má plný prístup, Manažér môže spravovať úlohy a kontakty, Používateľ môže pracovať s úlohami.
          </p>

          {loading ? (
            <div className="loading">Načítavam...</div>
          ) : (
            <div className="users-table-wrapper">
              <table className="users-table">
                <thead>
                  <tr>
                    <th>Používateľ</th>
                    <th>Email</th>
                    <th>Rola</th>
                    <th>Akcie</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id} className={u.id === user.id ? 'current-user' : ''}>
                      <td>
                        <div className="user-cell">
                          {u.avatar ? (
                            <img
                              src={`${api.defaults.baseURL}/auth/avatar/${u.id}`}
                              alt={u.username}
                              className="table-avatar-img"
                            />
                          ) : (
                            <span
                              className="table-avatar"
                              style={{ backgroundColor: u.color }}
                            >
                              {u.username.charAt(0).toUpperCase()}
                            </span>
                          )}
                          <span className="user-name-cell">
                            {u.username}
                            {u.id === user.id && <span className="you-badge">(vy)</span>}
                          </span>
                        </div>
                      </td>
                      <td>{u.email}</td>
                      <td>
                        <span className={`role-badge role-${u.role}`}>
                          {getRoleLabel(u.role)}
                        </span>
                      </td>
                      <td>
                        <select
                          value={u.role}
                          onChange={(e) => handleRoleChange(u.id, e.target.value)}
                          disabled={updating === u.id}
                          className="role-select"
                        >
                          <option value="admin">Admin</option>
                          <option value="manager">Manažér</option>
                          <option value="user">Používateľ</option>
                        </select>
                        {updating === u.id && <span className="updating-spinner">...</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminPanel;
