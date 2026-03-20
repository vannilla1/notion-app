import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { API_BASE_URL } from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useWorkspace } from '../context/WorkspaceContext';
import {
  getWorkspaceMembers, updateMemberRole, removeMember,
  sendInvitation, getInvitations, cancelInvitation
} from '../api/workspaces';
import UserMenu from '../components/UserMenu';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';

function WorkspaceMembers() {
  const { user, logout, updateUser } = useAuth();
  const { currentWorkspace, refreshCurrentWorkspace } = useWorkspace();
  const navigate = useNavigate();

  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [sending, setSending] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);
  const [copiedLink, setCopiedLink] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const isAdmin = currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'admin';

  const fetchData = useCallback(async () => {
    try {
      const [membersData, invitationsData] = await Promise.all([
        getWorkspaceMembers(),
        isAdmin ? getInvitations().catch(() => []) : Promise.resolve([])
      ]);
      setMembers(membersData);
      setInvitations(invitationsData);
    } catch (error) {
      console.error('Failed to fetch members:', error);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSendInvite = async (e) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setSending(true);
    setInviteResult(null);

    try {
      const result = await sendInvitation(inviteEmail.trim(), inviteRole);
      setInviteResult({
        type: 'success',
        message: result.message,
        link: result.invitation?.inviteLink
      });
      setInviteEmail('');
      fetchData();
    } catch (error) {
      setInviteResult({
        type: 'error',
        message: error.response?.data?.message || 'Chyba pri odosielaní pozvánky'
      });
    } finally {
      setSending(false);
    }
  };

  const handleCopyLink = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLink(link);
      setTimeout(() => setCopiedLink(null), 2000);
    } catch {
      // Fallback
      const input = document.createElement('input');
      input.value = link;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopiedLink(link);
      setTimeout(() => setCopiedLink(null), 2000);
    }
  };

  const handleRoleChange = async (memberId, newRole) => {
    try {
      await updateMemberRole(memberId, newRole);
      fetchData();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri zmene role');
    }
  };

  const handleRemoveMember = async (memberId, username) => {
    if (!window.confirm(`Naozaj chcete odstrániť ${username} z prostredia?`)) return;
    try {
      await removeMember(memberId);
      fetchData();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri odstraňovaní člena');
    }
  };

  const handleCancelInvite = async (invitationId) => {
    try {
      await cancelInvitation(invitationId);
      fetchData();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri rušení pozvánky');
    }
  };

  const getRoleBadge = (role) => {
    switch (role) {
      case 'owner': return { label: 'Vlastník', color: '#f59e0b' };
      case 'admin': return { label: 'Admin', color: '#6366f1' };
      default: return { label: 'Člen', color: '#64748b' };
    }
  };

  return (
    <div className="tasks-page">
      <div className="crm-layout">
        <aside className={`crm-sidebar ${sidebarOpen ? 'open' : ''}`}>
          <button className="btn btn-primary add-contact-btn" onClick={() => navigate('/app')}>
            ← Späť na Dashboard
          </button>
          <div className="dashboard-stats">
            <h3>Prostredie</h3>
            <div className="stat-item">
              <span className="stat-label">Názov</span>
              <span className="stat-value" style={{ fontSize: '14px' }}>{currentWorkspace?.name || '—'}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Členovia</span>
              <span className="stat-value">{members.length}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Pozvánky</span>
              <span className="stat-value">{invitations.length}</span>
            </div>
          </div>
        </aside>

        <main className="crm-main">
          <header className="crm-header">
            <div className="crm-header-left">
              <button className="hamburger-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
                <span></span><span></span><span></span>
              </button>
              <h1 className="header-title-link" onClick={() => navigate('/app')}>Prpl CRM</h1>
            </div>
            <div className="crm-header-right">
              <WorkspaceSwitcher />
              <UserMenu user={user} onLogout={logout} onUpdateUser={updateUser} />
            </div>
          </header>

          <div className="workspace-members-content">
            <h2 className="wm-title">Členovia prostredia</h2>

            {/* Invite form */}
            {isAdmin && (
              <div className="wm-invite-section">
                <h3 className="wm-section-title">Pozvať nového člena</h3>
                <form onSubmit={handleSendInvite} className="wm-invite-form">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="Email používateľa..."
                    className="form-input"
                    required
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    className="form-input wm-role-select"
                  >
                    <option value="member">Člen</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button type="submit" className="btn btn-primary" disabled={sending}>
                    {sending ? 'Odosielam...' : 'Pozvať'}
                  </button>
                </form>

                {inviteResult && (
                  <div className={`wm-invite-result ${inviteResult.type}`}>
                    <span>{inviteResult.message}</span>
                    {inviteResult.link && (
                      <div className="wm-invite-link-box">
                        <span className="wm-invite-link-label">Odkaz na pozvánku:</span>
                        <div className="wm-invite-link-row">
                          <input
                            type="text"
                            value={inviteResult.link}
                            readOnly
                            className="form-input wm-invite-link-input"
                          />
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleCopyLink(inviteResult.link)}
                          >
                            {copiedLink === inviteResult.link ? '✓ Skopírované' : 'Kopírovať'}
                          </button>
                        </div>
                        <p className="wm-invite-link-hint">
                          Pošlite tento odkaz pozvanému. Ak ešte nemá konto, zaregistruje sa a automaticky sa pridá do prostredia.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Pending invitations */}
            {isAdmin && invitations.length > 0 && (
              <div className="wm-section">
                <h3 className="wm-section-title">Čakajúce pozvánky</h3>
                <div className="wm-list">
                  {invitations.map(inv => (
                    <div key={inv.id} className="wm-member-card">
                      <div className="wm-member-info">
                        <div className="wm-member-avatar wm-avatar-pending">✉</div>
                        <div className="wm-member-details">
                          <span className="wm-member-name">{inv.email}</span>
                          <span className="wm-member-meta">
                            Pozval: {inv.invitedBy} · {new Date(inv.createdAt).toLocaleDateString('sk-SK')}
                          </span>
                        </div>
                      </div>
                      <div className="wm-member-actions">
                        <span className="wm-role-badge" style={{ backgroundColor: '#f59e0b20', color: '#f59e0b' }}>
                          Čaká
                        </span>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleCancelInvite(inv.id)}
                        >
                          Zrušiť
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Members list */}
            <div className="wm-section">
              <h3 className="wm-section-title">Aktívni členovia ({members.length})</h3>
              {loading ? (
                <div className="loading">Načítavam...</div>
              ) : (
                <div className="wm-list">
                  {members.map(member => {
                    const badge = getRoleBadge(member.role);
                    return (
                      <div key={member.id} className="wm-member-card">
                        <div className="wm-member-info">
                          {member.user?.avatarData || member.user?.avatar ? (
                            <img
                              src={`${API_BASE_URL}/api/auth/avatar/${member.user.id}`}
                              alt={member.user.username}
                              className="wm-member-avatar-img"
                            />
                          ) : (
                            <div
                              className="wm-member-avatar"
                              style={{ backgroundColor: member.user?.color || '#6366f1' }}
                            >
                              {member.user?.username?.charAt(0).toUpperCase() || '?'}
                            </div>
                          )}
                          <div className="wm-member-details">
                            <span className="wm-member-name">
                              {member.user?.username || 'Neznámy'}
                              {member.user?.id === user?.id && ' (vy)'}
                            </span>
                            <span className="wm-member-meta">{member.user?.email}</span>
                          </div>
                        </div>
                        <div className="wm-member-actions">
                          <span
                            className="wm-role-badge"
                            style={{ backgroundColor: badge.color + '20', color: badge.color }}
                          >
                            {badge.label}
                          </span>
                          {isAdmin && member.role !== 'owner' && member.user?.id !== user?.id && (
                            <>
                              <select
                                value={member.role}
                                onChange={(e) => handleRoleChange(member.id, e.target.value)}
                                className="form-input wm-role-select-sm"
                              >
                                <option value="member">Člen</option>
                                <option value="admin">Admin</option>
                              </select>
                              <button
                                className="btn-icon wm-remove-btn"
                                onClick={() => handleRemoveMember(member.id, member.user?.username)}
                                title="Odstrániť"
                              >
                                ×
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default WorkspaceMembers;
