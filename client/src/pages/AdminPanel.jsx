import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import adminApi, { API_BASE_URL } from '@/api/adminApi';

const TABS = [
  { id: 'overview', label: 'Prehľad', icon: '📊' },
  { id: 'users', label: 'Používatelia', icon: '👥' },
  { id: 'workspaces', label: 'Workspace-y', icon: '🏢' },
  { id: 'audit', label: 'Audit log', icon: '📋' },
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
        {activeTab === 'audit' && <AuditLogTab />}
        {activeTab === 'sync' && <SyncTab />}
      </div>
    </div>
  );
}

// ─── OVERVIEW TAB ───────────────────────────────────────────────
function OverviewTab() {
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminApi.get('/api/admin/stats').then(res => res.data).catch(() => null),
      adminApi.get('/api/admin/health').then(res => res.data).catch(() => null)
    ]).then(([s, h]) => {
      setStats(s);
      setHealth(h);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="sa-loading">Načítavam štatistiky...</div>;
  if (!stats) return <div className="sa-error">Nepodarilo sa načítať štatistiky</div>;

  const planLabels = { free: 'Free', team: 'Tím', pro: 'Pro', trial: 'Trial' };

  const formatUptime = (seconds) => {
    if (!seconds) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const formatMB = (bytes) => bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : '—';

  return (
    <div className="sa-overview">
      {/* System Health */}
      {health && (
        <div className="sa-health-card" style={{ marginBottom: '20px', padding: '16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: health.database?.status === 'connected' ? '#22C55E' : '#EF4444' }}></span>
              Stav systému
            </h3>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{new Date(health.timestamp).toLocaleString('sk-SK')}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Uptime</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{formatUptime(health.uptime)}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>RAM (heap)</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{formatMB(health.memory?.heapUsed)} / {formatMB(health.memory?.heapTotal)}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>RAM (RSS)</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{formatMB(health.memory?.rss)}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>MongoDB</div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: health.database?.status === 'connected' ? '#22C55E' : '#EF4444' }}>{health.database?.status === 'connected' ? 'OK' : 'Offline'}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Node.js</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{health.nodeVersion || '—'}</div>
            </div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Prostredie</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{health.environment || '—'}</div>
            </div>
          </div>
        </div>
      )}

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
  const [selectedUser, setSelectedUser] = useState(null);
  const [userDetail, setUserDetail] = useState(null);
  const [userDetailLoading, setUserDetailLoading] = useState(false);
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  const openUserDetail = (userId) => {
    setSelectedUser(userId);
    setUserDetailLoading(true);
    adminApi.get(`/api/admin/users/${userId}`)
      .then(res => setUserDetail(res.data))
      .catch(() => {})
      .finally(() => setUserDetailLoading(false));
  };

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

  const toggleCheck = (id, e) => {
    e.stopPropagation();
    setCheckedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const selectableIds = filtered.filter(u => u.email !== 'support@prplcrm.eu').map(u => u.id);
    setCheckedIds(prev => prev.size === selectableIds.length ? new Set() : new Set(selectableIds));
  };

  const handleBulkApply = async () => {
    if (!bulkAction || !bulkValue || checkedIds.size === 0) return;
    const label = bulkAction === 'plan' ? 'plán' : 'rolu';
    if (!window.confirm(`Zmeniť ${label} pre ${checkedIds.size} používateľov na "${bulkValue}"?`)) return;
    setBulkLoading(true);
    try {
      await adminApi.put('/api/admin/users/bulk', {
        userIds: [...checkedIds],
        action: bulkAction,
        value: bulkValue
      });
      setUsers(prev => prev.map(u => checkedIds.has(u.id) ? { ...u, [bulkAction]: bulkValue } : u));
      setCheckedIds(new Set());
      setBulkAction('');
      setBulkValue('');
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri hromadnej akcii');
    } finally {
      setBulkLoading(false);
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
        <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 10px', marginLeft: 'auto' }}
          onClick={() => adminApi.get('/api/admin/export/users', { responseType: 'blob' }).then(res => {
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a'); a.href = url; a.download = 'users-export.csv'; a.click(); URL.revokeObjectURL(url);
          })}>
          📥 Export CSV
        </button>
      </div>

      {/* Bulk action bar */}
      {checkedIds.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', marginBottom: '12px', background: 'var(--primary-light, #EDE9FE)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--primary, #8B5CF6)' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{checkedIds.size} vybraných</span>
          <select value={bulkAction} onChange={e => { setBulkAction(e.target.value); setBulkValue(''); }}
            style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
            <option value="">Hromadná akcia...</option>
            <option value="plan">Zmeniť plán</option>
            <option value="role">Zmeniť rolu</option>
          </select>
          {bulkAction === 'plan' && (
            <select value={bulkValue} onChange={e => setBulkValue(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
              <option value="">Vybrať plán...</option>
              <option value="free">Free</option>
              <option value="team">Tím</option>
              <option value="pro">Pro</option>
            </select>
          )}
          {bulkAction === 'role' && (
            <select value={bulkValue} onChange={e => setBulkValue(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
              <option value="">Vybrať rolu...</option>
              <option value="admin">Admin</option>
              <option value="manager">Manažér</option>
              <option value="user">Používateľ</option>
            </select>
          )}
          <button className="btn btn-primary" style={{ fontSize: '12px', padding: '4px 12px' }}
            disabled={!bulkAction || !bulkValue || bulkLoading}
            onClick={handleBulkApply}>
            {bulkLoading ? 'Aplikujem...' : 'Aplikovať'}
          </button>
          <button style={{ background: 'none', border: 'none', fontSize: '13px', cursor: 'pointer', color: 'var(--text-muted)', marginLeft: 'auto' }}
            onClick={() => { setCheckedIds(new Set()); setBulkAction(''); setBulkValue(''); }}>
            Zrušiť výber
          </button>
        </div>
      )}

      <div className="users-table-wrapper">
        <table className="users-table">
          <thead>
            <tr>
              <th style={{ width: '36px' }}>
                <input type="checkbox" onChange={toggleAll}
                  checked={filtered.filter(u => u.email !== 'support@prplcrm.eu').length > 0 && filtered.filter(u => u.email !== 'support@prplcrm.eu').every(u => checkedIds.has(u.id))} />
              </th>
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
              <tr key={u.id} className={u.email === 'support@prplcrm.eu' ? 'current-user' : ''} onClick={() => openUserDetail(u.id)} style={{ cursor: 'pointer' }}>
                <td onClick={e => e.stopPropagation()}>
                  {u.email !== 'support@prplcrm.eu' && (
                    <input type="checkbox" checked={checkedIds.has(u.id)} onChange={e => toggleCheck(u.id, e)} />
                  )}
                </td>
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
                  {u.email !== 'support@prplcrm.eu' && (
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

      {/* User Detail Modal */}
      {selectedUser && (
        <div className="modal-overlay" onClick={() => { setSelectedUser(null); setUserDetail(null); }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '700px', maxHeight: '85vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 600 }}>Detail používateľa</h3>
              <button onClick={() => { setSelectedUser(null); setUserDetail(null); }} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)' }}>✕</button>
            </div>
            {userDetailLoading ? <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Načítavam...</div> : userDetail ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* User info */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: userDetail.user.color || '#8B5CF6', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: '18px', flexShrink: 0 }}>
                    {(userDetail.user.username || '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '16px' }}>{userDetail.user.username}</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{userDetail.user.email}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Role: <strong>{userDetail.user.role}</strong> · Plán: <strong>{userDetail.user.subscription?.plan || 'free'}</strong> · Registrovaný {new Date(userDetail.user.createdAt).toLocaleDateString('sk-SK')}
                    </div>
                  </div>
                </div>

                {/* Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                  {[
                    { label: 'Kontakty', value: userDetail.stats.contactCount },
                    { label: 'Úlohy', value: userDetail.stats.taskCount },
                    { label: 'Odoslané', value: userDetail.stats.messagesSent },
                    { label: 'Prijaté', value: userDetail.stats.messagesReceived },
                  ].map(s => (
                    <div key={s.label} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '18px', fontWeight: 700 }}>{s.value}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                {/* Workspaces */}
                <div>
                  <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Workspace-y ({userDetail.memberships.length})</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {userDetail.memberships.map(m => (
                      <div key={m._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: m.workspace?.color || '#6B7280', flexShrink: 0 }}></span>
                          <span style={{ fontWeight: 500 }}>{m.workspace?.name || '—'}</span>
                        </div>
                        <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', background: m.role === 'owner' ? '#8B5CF6' : m.role === 'manager' ? '#F59E0B' : '#6B7280', color: 'white' }}>{m.role}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Devices */}
                {(userDetail.devices?.pushSubscriptions?.length > 0 || userDetail.devices?.apnsDevices?.length > 0) && (
                  <div>
                    <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Zariadenia</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                      {userDetail.devices.apnsDevices?.map((d, i) => (
                        <div key={i} style={{ padding: '4px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                          📱 iOS ({d.apnsEnvironment || 'unknown'}) · Token: ...{d.deviceToken?.slice(-8)} · Posledné použitie: {d.lastUsed ? new Date(d.lastUsed).toLocaleDateString('sk-SK') : '—'}
                        </div>
                      ))}
                      {userDetail.devices.pushSubscriptions?.map((d, i) => (
                        <div key={i} style={{ padding: '4px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                          🌐 Web Push · {d.endpoint?.includes('apple.com') ? 'Safari' : d.endpoint?.includes('google') ? 'Chrome' : 'Browser'} · Posledné použitie: {d.lastUsed ? new Date(d.lastUsed).toLocaleDateString('sk-SK') : '—'}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent activity */}
                {userDetail.recentActivity?.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Posledná aktivita</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '200px', overflow: 'auto' }}>
                      {userDetail.recentActivity.map((a, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '3px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                          <span>{ACTION_LABELS[a.action] || a.action} {a.targetName ? `— ${a.targetName}` : ''}</span>
                          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', marginLeft: '8px' }}>{new Date(a.createdAt).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Subscription management */}
                <SubscriptionEditor user={userDetail.user} onUpdate={(sub) => {
                  setUserDetail(prev => ({ ...prev, user: { ...prev.user, subscription: sub } }));
                  setUsers(prev => prev.map(u => u.id === userDetail.user._id ? { ...u, plan: sub.plan } : u));
                }} />

                {/* Google integrations */}
                {(userDetail.user.googleCalendar?.enabled || userDetail.user.googleTasks?.enabled) && (
                  <div>
                    <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Integrácie</h4>
                    <div style={{ display: 'flex', gap: '8px', fontSize: '12px' }}>
                      {userDetail.user.googleCalendar?.enabled && <span style={{ padding: '4px 10px', background: '#DBEAFE', borderRadius: 'var(--radius-sm)' }}>📅 Google Calendar · od {new Date(userDetail.user.googleCalendar.connectedAt).toLocaleDateString('sk-SK')}</span>}
                      {userDetail.user.googleTasks?.enabled && <span style={{ padding: '4px 10px', background: '#D1FAE5', borderRadius: 'var(--radius-sm)' }}>✅ Google Tasks · od {new Date(userDetail.user.googleTasks.connectedAt).toLocaleDateString('sk-SK')}</span>}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── WORKSPACES TAB ─────────────────────────────────────────────
function WorkspacesTab() {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedWs, setSelectedWs] = useState(null);
  const [wsDetail, setWsDetail] = useState(null);
  const [wsDetailLoading, setWsDetailLoading] = useState(false);

  useEffect(() => {
    adminApi.get('/api/admin/workspaces')
      .then(res => setWorkspaces(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const openWsDetail = (wsId) => {
    setSelectedWs(wsId);
    setWsDetailLoading(true);
    adminApi.get(`/api/admin/workspaces/${wsId}`)
      .then(res => setWsDetail(res.data))
      .catch(() => {})
      .finally(() => setWsDetailLoading(false));
  };

  const handleDeleteWorkspace = async () => {
    if (!wsDetail) return;
    const name = wsDetail.workspace.name;
    if (!window.confirm(`Naozaj vymazať workspace "${name}"?\n\nToto vymaže VŠETKY kontakty, úlohy, správy a členstvá v tomto workspace. Táto akcia je NEVRATNÁ.`)) return;
    try {
      await adminApi.delete(`/api/admin/workspaces/${selectedWs}`);
      setWorkspaces(prev => prev.filter(w => w.id !== selectedWs));
      setSelectedWs(null);
      setWsDetail(null);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri mazaní workspace');
    }
  };

  if (loading) return <div className="sa-loading">Načítavam workspace-y...</div>;

  return (
    <div className="sa-workspaces">
      <div className="sa-toolbar">
        <span className="sa-count">{workspaces.length} workspace-ov</span>
        <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 10px', marginLeft: 'auto' }}
          onClick={() => adminApi.get('/api/admin/export/workspaces', { responseType: 'blob' }).then(res => {
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a'); a.href = url; a.download = 'workspaces-export.csv'; a.click(); URL.revokeObjectURL(url);
          })}>
          📥 Export CSV
        </button>
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
              <tr key={w.id} onClick={() => openWsDetail(w.id)} style={{ cursor: 'pointer' }}>
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

      {/* Workspace Detail Modal */}
      {selectedWs && (
        <div className="modal-overlay" onClick={() => { setSelectedWs(null); setWsDetail(null); }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '700px', maxHeight: '85vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 600 }}>Detail workspace</h3>
              <button onClick={() => { setSelectedWs(null); setWsDetail(null); }} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)' }}>✕</button>
            </div>
            {wsDetailLoading ? <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Načítavam...</div> : wsDetail ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* Workspace info */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ width: '14px', height: '14px', borderRadius: '50%', background: wsDetail.workspace.color || '#8B5CF6', flexShrink: 0 }}></span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '16px' }}>{wsDetail.workspace.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>/{wsDetail.workspace.slug} · Vytvorený {new Date(wsDetail.workspace.createdAt).toLocaleDateString('sk-SK')}</div>
                  </div>
                </div>

                {/* Stats grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                  {[
                    { label: 'Kontakty', value: wsDetail.stats.contactCount },
                    { label: 'Úlohy', value: `${wsDetail.stats.completedTasks}/${wsDetail.stats.taskCount}` },
                    { label: 'Správy', value: wsDetail.stats.messageCount },
                  ].map(s => (
                    <div key={s.label} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px', textAlign: 'center' }}>
                      <div style={{ fontSize: '20px', fontWeight: 700 }}>{s.value}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                {/* Members */}
                <div>
                  <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Členovia ({wsDetail.members.length})</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {wsDetail.members.map(m => (
                      <div key={m._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
                        <div>
                          <span style={{ fontWeight: 500 }}>{m.user?.username || '—'}</span>
                          <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>{m.user?.email || ''}</span>
                        </div>
                        <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', background: m.role === 'owner' ? '#8B5CF6' : m.role === 'manager' ? '#F59E0B' : '#6B7280', color: 'white' }}>{m.role}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Recent contacts */}
                {wsDetail.recentContacts?.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Posledné kontakty</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {wsDetail.recentContacts.slice(0, 10).map(c => (
                        <div key={c._id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '4px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                          <span>{c.name || '—'} {c.company ? `(${c.company})` : ''}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{new Date(c.createdAt).toLocaleDateString('sk-SK')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Delete workspace */}
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', marginTop: '8px' }}>
                  <button className="btn btn-danger" style={{ fontSize: '13px', width: '100%' }} onClick={handleDeleteWorkspace}>
                    Vymazať workspace a všetky dáta
                  </button>
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '6px' }}>
                    Táto akcia je nevratná. Vymaže kontakty, úlohy, správy a členstvá.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SUBSCRIPTION EDITOR ─────────────────────────────────────────
function SubscriptionEditor({ user, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState(user.subscription?.plan || 'free');
  const [paidUntil, setPaidUntil] = useState(user.subscription?.paidUntil ? new Date(user.subscription.paidUntil).toISOString().split('T')[0] : '');
  const [trialEndsAt, setTrialEndsAt] = useState(user.subscription?.trialEndsAt ? new Date(user.subscription.trialEndsAt).toISOString().split('T')[0] : '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await adminApi.put(`/api/admin/users/${user._id}/subscription`, {
        plan,
        paidUntil: paidUntil || null,
        trialEndsAt: trialEndsAt || null
      });
      onUpdate(res.data.subscription);
      setEditing(false);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní');
    } finally {
      setSaving(false);
    }
  };

  const sub = user.subscription || {};
  const formatDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '—';

  if (!editing) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h4 style={{ fontSize: '14px', fontWeight: 600 }}>Predplatné</h4>
          <button onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', fontSize: '12px', cursor: 'pointer', color: 'var(--primary, #8B5CF6)', fontWeight: 500 }}>Upraviť</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '12px' }}>
          <div style={{ padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Plán</div>
            <div style={{ fontWeight: 600 }}>{(sub.plan || 'free').toUpperCase()}</div>
          </div>
          <div style={{ padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Platené do</div>
            <div style={{ fontWeight: 600 }}>{formatDate(sub.paidUntil)}</div>
          </div>
          <div style={{ padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Stripe</div>
            <div style={{ fontWeight: 600 }}>{sub.stripeSubscriptionId ? 'Aktívne' : '—'}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Predplatné — úprava</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', width: '80px', color: 'var(--text-muted)' }}>Plán</label>
          <select value={plan} onChange={e => setPlan(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }}>
            <option value="free">Free</option>
            <option value="team">Tím</option>
            <option value="pro">Pro</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', width: '80px', color: 'var(--text-muted)' }}>Platené do</label>
          <input type="date" value={paidUntil} onChange={e => setPaidUntil(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }} />
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', width: '80px', color: 'var(--text-muted)' }}>Trial do</label>
          <input type="date" value={trialEndsAt} onChange={e => setTrialEndsAt(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1 }} />
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 12px' }} onClick={() => setEditing(false)}>Zrušiť</button>
          <button className="btn btn-primary" style={{ fontSize: '12px', padding: '4px 12px' }} disabled={saving} onClick={handleSave}>
            {saving ? 'Ukladám...' : 'Uložiť'}
          </button>
        </div>
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

// ─── AUDIT LOG TAB ──────────────────────────────────────────────
const ACTION_LABELS = {
  'user.role_changed': '🔑 Zmena role', 'user.plan_changed': '💳 Zmena plánu', 'user.deleted': '🗑️ Vymazaný užívateľ',
  'auth.login': '🔓 Prihlásenie', 'auth.register': '📝 Registrácia',
  'contact.created': '➕ Nový kontakt', 'contact.updated': '✏️ Úprava kontaktu', 'contact.deleted': '🗑️ Vymazaný kontakt',
  'task.created': '➕ Nová úloha', 'task.completed': '✅ Dokončená úloha', 'task.deleted': '🗑️ Vymazaná úloha',
  'message.created': '📨 Nová správa', 'message.approved': '✅ Schválená správa', 'message.rejected': '❌ Zamietnutá správa',
};

const CATEGORY_LABELS = {
  user: '👤 Používateľ', workspace: '🏢 Workspace', contact: '📇 Kontakt',
  task: '📋 Úloha', message: '✉️ Správa', auth: '🔐 Auth', billing: '💳 Fakturácia', system: '⚙️ Systém'
};

function AuditLogTab() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ category: '', search: '', from: '', to: '' });

  const fetchLogs = () => {
    setLoading(true);
    const params = { page, limit: 30 };
    if (filters.category) params.category = filters.category;
    if (filters.search) params.search = filters.search;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;

    adminApi.get('/api/admin/audit-log', { params })
      .then(res => {
        setLogs(res.data.logs || []);
        setTotalPages(res.data.pages || 1);
        setTotal(res.data.total || 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchLogs(); }, [page, filters.category]);

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    fetchLogs();
  };

  const formatDateTime = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const renderDetails = (log) => {
    if (!log.details) return null;
    const d = log.details;
    const parts = [];
    if (d.oldRole && d.newRole) parts.push(`${d.oldRole} → ${d.newRole}`);
    if (d.oldPlan && d.newPlan) parts.push(`${d.oldPlan} → ${d.newPlan}`);
    if (d.subject) parts.push(`"${d.subject}"`);
    if (d.recipient) parts.push(`→ ${d.recipient}`);
    if (d.reason) parts.push(`Dôvod: ${d.reason}`);
    if (d.changedFields) parts.push(`Polia: ${d.changedFields.join(', ')}`);
    if (d.email && !d.oldRole && !d.oldPlan) parts.push(d.email);
    return parts.length > 0 ? <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{parts.join(' · ')}</span> : null;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Audit Log <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '14px' }}>({total} záznamov)</span></h2>
      </div>

      <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <select value={filters.category} onChange={e => { setFilters(f => ({ ...f, category: e.target.value })); setPage(1); }}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', background: 'var(--bg-primary)' }}>
          <option value="">Všetky kategórie</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}
          placeholder="Od" />
        <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))}
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}
          placeholder="Do" />
        <input type="text" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
          placeholder="Hľadať meno, email, akciu..."
          style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px', flex: 1, minWidth: '150px' }} />
        <button type="submit" className="btn btn-primary" style={{ fontSize: '13px', padding: '6px 14px' }}>Hľadať</button>
      </form>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Načítavam...</div>
      ) : logs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Žiadne záznamy</div>
      ) : (
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Dátum</th>
                <th>Používateľ</th>
                <th>Akcia</th>
                <th>Cieľ</th>
                <th>Detaily</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id || log._id}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '12px' }}>{formatDateTime(log.createdAt)}</td>
                  <td>
                    <div style={{ fontSize: '13px', fontWeight: 500 }}>{log.username || '—'}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{log.email || ''}</div>
                  </td>
                  <td>
                    <span style={{ fontSize: '13px' }}>{ACTION_LABELS[log.action] || log.action}</span>
                  </td>
                  <td>
                    <div style={{ fontSize: '13px' }}>{log.targetName || '—'}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{log.targetType || ''}</div>
                  </td>
                  <td>{renderDetails(log)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '16px' }}>
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={{ fontSize: '13px', padding: '4px 12px' }}>←</button>
          <span style={{ fontSize: '13px', padding: '4px 8px', color: 'var(--text-secondary)' }}>{page} / {totalPages}</span>
          <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} style={{ fontSize: '13px', padding: '4px 12px' }}>→</button>
        </div>
      )}
    </div>
  );
}

export default AdminPanel;
