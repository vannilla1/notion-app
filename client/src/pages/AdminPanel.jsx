import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { API_BASE_URL } from '@/api/api';
import { useAuth } from '../context/AuthContext';
import UserMenu from '../components/UserMenu';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';

function AdminPanel() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    // Redirect if not admin or manager
    if (user && user.role !== 'admin' && user.role !== 'manager') {
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

  const handleDeleteUser = async (targetUser) => {
    const confirmMessage = `Naozaj chcete vymazať účet používateľa "${targetUser.username}"?\n\nTáto akcia je nevratná a používateľ stratí prístup do systému.`;

    if (!window.confirm(confirmMessage)) {
      return;
    }

    setDeleting(targetUser.id);
    try {
      await api.delete(`/api/auth/users/${targetUser.id}`);
      setUsers(prev => prev.filter(u => u.id !== targetUser.id));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri mazaní používateľa');
    } finally {
      setDeleting(null);
    }
  };

  // Check if current user can delete target user
  const canDeleteUser = (targetUser) => {
    // Cannot delete yourself
    if (targetUser.id === user.id) return false;

    // Admin can delete managers and users
    if (user.role === 'admin') {
      return targetUser.role !== 'admin';
    }

    // Manager can delete users only
    if (user.role === 'manager') {
      return targetUser.role === 'user';
    }

    return false;
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

  // Only admin and manager can access
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
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
          <h1 className="header-title-link" onClick={() => navigate('/')}>Purple CRM</h1>
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
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
            {user.role === 'admin'
              ? 'Spravujte role používateľov v systéme. Admin má plný prístup, Manažér môže spravovať úlohy a kontakty, Používateľ môže pracovať s úlohami.'
              : 'Ako manažér môžete vymazať účty bežných používateľov.'
            }
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
                              src={`${API_BASE_URL}/api/auth/avatar/${u.id}`}
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
                        <div className="actions-cell">
                          {user.role === 'admin' && (
                            <>
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
                            </>
                          )}
                          {canDeleteUser(u) && (
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => handleDeleteUser(u)}
                              disabled={deleting === u.id}
                              title="Vymazať používateľa"
                            >
                              {deleting === u.id ? '...' : '🗑️'}
                            </button>
                          )}
                        </div>
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
