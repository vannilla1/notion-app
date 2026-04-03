import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import adminApi, { API_BASE_URL } from '@/api/adminApi';

const TABS = [
  { id: 'overview', label: 'Prehľad', icon: '📊' },
  { id: 'users', label: 'Používatelia', icon: '👥' },
  { id: 'workspaces', label: 'Workspace-y', icon: '🏢' },
  { id: 'sync', label: 'Sync diagnostika', icon: '🔄' }
];

function AdminPanel() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    const token = localStorage.getItem('adminToken');
    if (!token) {
      navigate('/admin');
    }
  }, [navigate]);

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    navigate('/admin');
  };

  if (!localStorage.getItem('adminToken')) {
    return null;
  }

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <h1 className="header-title-link">
            <img src="/icons/icon-96x96.png" alt="" width="28" height="28" className="header-logo-icon" />
            Super Admin
          </h1>
        </div>
        <div className="crm-header-right">
          <button className="btn btn-secondary" onClick={handleLogout}>
            Odhlásiť sa
          </button>
        </div>
      </header>

      <div className="sa-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`sa-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="sa-tab-icon">{tab.icon}</span>
            <span className="sa-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="sa-content">
        {activeTab === 'overview' && <OverviewTab />}
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'workspaces' && <WorkspacesTab />}
        {activeTab === 'sync' && <SyncTab />}
      </div>
    </div>
  );
}

// ─── OVERVIEW TAB ───────────────────────────────────────────────
function OverviewTab() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.get('/api/admin/stats')
      .then(res => setStats(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam štatistiky...</div>;
  if (!stats) return <div className="sa-error">Nepodarilo sa načítať štatistiky</div>;

  const planLabels = { free: 'Free', team: 'Tím', pro: 'Pro', trial: 'Trial' };

  return (
    <div className="sa-overview">
      <div className="sa-stats-grid">
        <StatCard icon="👥" label="Používatelia" value={stats.totalUsers} sub={`+${stats.recentRegistrations} za 30 dní`} />
        <StatCard icon="🏢" label="Workspace-y" value={stats.totalWorkspaces} sub={`${stats.activeWorkspaces} aktívnych`} />
        <StatCard icon="📋" label="Projekty" value={stats.totalTasks} />
        <StatCard icon="👤" label="Kontakty" value={stats.totalContacts} />
        <StatCard icon="📅" label="Google Calendar" value={stats.usersWithGoogleCalendar} sub="pripojených" />
        <StatCard icon="✅" label="Google Tasks" value={stats.usersWithGoogleTasks} sub="pripojených" />
      </div>

      <div className="sa-breakdowns">
        <div className="sa-breakdown-card">
          <h3>Plány</h3>
          <div className="sa-breakdown-list">
            {Object.entries(stats.planBreakdown).map(([plan, count]) => (
              <div key={plan} className="sa-breakdown-item">
                <span className={`sa-plan-badge plan-${plan}`}>{planLabels[plan] || plan}</span>
                <span className="sa-breakdown-count">{count}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="sa-breakdown-card">
          <h3>Role</h3>
          <div className="sa-breakdown-list">
            {Object.entries(stats.roleBreakdown).map(([role, count]) => (
              <div key={role} className="sa-breakdown-item">
                <span className={`role-badge role-${role}`}>{role === 'admin' ? 'Admin' : role === 'manager' ? 'Manažér' : 'Používateľ'}</span>
                <span className="sa-breakdown-count">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, sub }) {
  return (
    <div className="sa-stat-card">
      <div className="sa-stat-icon">{icon}</div>
      <div className="sa-stat-info">
        <div className="sa-stat-value">{value}</div>
        <div className="sa-stat-label">{label}</div>
        {sub && <div className="sa-stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

// ─── USERS TAB ──────────────────────────────────────────────────
function UsersTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [updating, setUpdating] = useState(null);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = () => {
    adminApi.get('/api/admin/users')
      .then(res => setUsers(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleRoleChange = async (userId, newRole) => {
    setUpdating(userId);
    try {
      await adminApi.put(`/api/admin/users/${userId}/role`, { role: newRole });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri zmene role');
    } finally {
      setUpdating(null);
    }
  };

  const handlePlanChange = async (userId, newPlan) => {
    setUpdating(userId);
    try {
      await adminApi.put(`/api/admin/users/${userId}/plan`, { plan: newPlan });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, plan: newPlan } : u));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri zmene plánu');
    } finally {
      setUpdating(null);
    }
  };

  const handleDeleteUser = async (targetUser) => {
    if (!window.confirm(`Naozaj vymazať "${targetUser.username}"? Táto akcia je nevratná.`)) return;
    try {
      await adminApi.delete(`/api/admin/users/${targetUser.id}`);
      setUsers(prev => prev.filter(u => u.id !== targetUser.id));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri mazaní');
    }
  };

  const filtered = users.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <div className="sa-loading">Načítavam používateľov...</div>;

  return (
    <div className="sa-users">
      <div className="sa-toolbar">
        <input
          type="text"
          placeholder="Hľadať používateľov..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="form-input sa-search"
        />
        <span className="sa-count">{filtered.length} z {users.length}</span>
      </div>

      <div className="users-table-wrapper">
        <table className="users-table">
          <thead>
            <tr>
              <th>Používateľ</th>
              <th>Email</th>
              <th>Rola</th>
              <th>Plán</th>
              <th>Sync</th>
              <th>Workspace-y</th>
              <th>Registrácia</th>
              <th>Akcie</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(u => (
              <tr key={u.id} className={u.email === 'support@prplcrm.eu' ? 'current-user' : ''}>
                <td>
                  <div className="user-cell">
                    {u.avatar ? (
                      <img
                        src={`${API_BASE_URL}/api/auth/avatar/${u.id}`}
                        alt={u.username}
                        className="table-avatar-img"
                      />
                    ) : (
                      <span className="table-avatar" style={{ backgroundColor: u.color }}>
                        {u.username.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="user-name-cell">
                      {u.username}
                      {u.email === 'support@prplcrm.eu' && <span className="you-badge">(vy)</span>}
                    </span>
                  </div>
                </td>
                <td className="sa-email-cell">{u.email}</td>
                <td>
                  <select
                    value={u.role}
                    onChange={e => handleRoleChange(u.id, e.target.value)}
                    disabled={updating === u.id || u.email === 'support@prplcrm.eu'}
                    className="sa-select"
                  >
                    <option value="admin">Admin</option>
                    <option value="manager">Manažér</option>
                    <option value="user">Používateľ</option>
                  </select>
                </td>
                <td>
                  <select
                    value={u.plan}
                    onChange={e => handlePlanChange(u.id, e.target.value)}
                    disabled={updating === u.id}
                    className="sa-select"
                  >
                    <option value="free">Free</option>
                    <option value="team">Tím</option>
                    <option value="pro">Pro</option>
                    <option value="trial">Trial</option>
                  </select>
                </td>
                <td>
                  <div className="sa-sync-badges">
                    {u.googleCalendar && <span className="sa-sync-badge cal" title="Google Calendar">📅</span>}
                    {u.googleTasks && <span className="sa-sync-badge tasks" title="Google Tasks">✅</span>}
                    {!u.googleCalendar && !u.googleTasks && <span className="sa-sync-none">—</span>}
                  </div>
                </td>
                <td>
                  <div className="sa-workspace-list">
                    {u.workspaces.length === 0 && <span className="sa-sync-none">—</span>}
                    {u.workspaces.map((w, i) => (
                      <span key={i} className="sa-ws-chip" title={`Rola: ${w.role}`}>
                        {w.name}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="sa-date-cell">
                  {u.createdAt ? new Date(u.createdAt).toLocaleDateString('sk-SK') : '—'}
                </td>
                <td>
                  {u.email !== 'support@prplcrm.eu' && u.role !== 'admin' && (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDeleteUser(u)}
                      title="Vymazať"
                    >
                      Vymazať
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── WORKSPACES TAB ─────────────────────────────────────────────
function WorkspacesTab() {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.get('/api/admin/workspaces')
      .then(res => setWorkspaces(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam workspace-y...</div>;

  return (
    <div className="sa-workspaces">
      <div className="sa-toolbar">
        <span className="sa-count">{workspaces.length} workspace-ov</span>
      </div>

      <div className="users-table-wrapper">
        <table className="users-table">
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Vlastník</th>
              <th>Členovia</th>
              <th>Kontakty</th>
              <th>Projekty</th>
              <th>Platené miesta</th>
              <th>Vytvorený</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map(w => (
              <tr key={w.id}>
                <td>
                  <div className="sa-ws-name">
                    <span className="sa-ws-color" style={{ backgroundColor: w.color }}></span>
                    <div>
                      <div className="sa-ws-title">{w.name}</div>
                      <div className="sa-ws-slug">/{w.slug}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="sa-owner-cell">
                    <div>{w.owner.username}</div>
                    <div className="sa-sub-text">{w.owner.email}</div>
                  </div>
                </td>
                <td className="sa-center">{w.memberCount}</td>
                <td className="sa-center">{w.contactCount}</td>
                <td className="sa-center">{w.taskCount}</td>
                <td className="sa-center">{w.paidSeats || 0}</td>
                <td className="sa-date-cell">
                  {new Date(w.createdAt).toLocaleDateString('sk-SK')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── SYNC DIAGNOSTICS TAB ───────────────────────────────────────
function SyncTab() {
  const [diagnostics, setDiagnostics] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.get('/api/admin/sync-diagnostics')
      .then(res => setDiagnostics(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam diagnostiku...</div>;

  if (diagnostics.length === 0) {
    return <div className="sa-empty">Žiadny používateľ nemá prepojenú Google synchronizáciu.</div>;
  }

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="sa-sync-diag">
      <div className="sa-toolbar">
        <span className="sa-count">{diagnostics.length} používateľov so synchronizáciou</span>
      </div>

      <div className="sa-sync-cards">
        {diagnostics.map(d => (
          <div key={d.id} className="sa-sync-card">
            <div className="sa-sync-card-header">
              <strong>{d.username}</strong>
              <span className="sa-sub-text">{d.email}</span>
            </div>

            <div className="sa-sync-sections">
              {d.calendar.enabled && (
                <div className="sa-sync-section">
                  <div className="sa-sync-section-title">📅 Google Calendar</div>
                  <div className="sa-sync-detail">
                    <span>Pripojené:</span>
                    <span>{formatDate(d.calendar.connectedAt)}</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Synchronizovaných:</span>
                    <span>{d.calendar.syncedCount} udalostí</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Watch:</span>
                    <span className={d.calendar.watchActive ? 'sa-status-ok' : 'sa-status-warn'}>
                      {d.calendar.watchActive ? 'Aktívny' : 'Neaktívny'}
                    </span>
                  </div>
                  {d.calendar.watchExpiry && (
                    <div className="sa-sync-detail">
                      <span>Watch expiry:</span>
                      <span>{formatDate(d.calendar.watchExpiry)}</span>
                    </div>
                  )}
                </div>
              )}

              {d.tasks.enabled && (
                <div className="sa-sync-section">
                  <div className="sa-sync-section-title">✅ Google Tasks</div>
                  <div className="sa-sync-detail">
                    <span>Pripojené:</span>
                    <span>{formatDate(d.tasks.connectedAt)}</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Synchronizovaných:</span>
                    <span>{d.tasks.syncedCount} úloh</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Posledný sync:</span>
                    <span>{formatDate(d.tasks.lastSyncAt)}</span>
                  </div>
                  <div className="sa-sync-detail">
                    <span>Kvóta dnes:</span>
                    <span>{d.tasks.quotaUsedToday}/100</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AdminPanel;
