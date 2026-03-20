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
  const [transferring, setTransferring] = useState(null);

  const isOwner = currentWorkspace?.role === 'owner';
  const canManage = currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'manager';

  const fetchData = useCallback(async () => {
    try {
      const [membersData, invitationsData] = await Promise.all([
        getWorkspaceMembers(),
        canManage ? getInvitations().catch(() => []) : Promise.resolve([])
      ]);
      setMembers(membersData);
      setInvitations(invitationsData);
    } catch (error) {
      console.error('Failed to fetch members:', error);
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ===== Invitation handlers =====
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

  // ===== Transfer ownership (owner only, to manager) =====
  const handleTransferOwnership = async (member) => {
    if (!window.confirm(
      `Naozaj chcete previesť vlastníctvo prostredia na ${member.username}?\n\n` +
      `Stanete sa Členom a ${member.username} sa stane Vlastníkom.\n` +
      `Táto akcia je nevratná.`
    )) return;

    setTransferring(member.userId);
    try {
      await api.post(`/api/workspaces/current/transfer-ownership/${member.userId}`);
      await refreshCurrentWorkspace();
      fetchData();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri prevode vlastníctva');
    } finally {
      setTransferring(null);
    }
  };

  const getRoleBadge = (role) => {
    switch (role) {
      case 'owner': return { label: 'Vlastník', color: '#f59e0b' };
      case 'manager': return { label: 'Manažér', color: '#8b5cf6' };
      default: return { label: 'Člen', color: '#64748b' };
    }
  };

  return (
    <div className="wm-page">
      <header className="crm-header">
        <div className="crm-header-left">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => navigate('/app')}
          >
            ← Späť
          </button>
          <h1 className="header-title-link" onClick={() => navigate('/app')}>Prpl CRM</h1>
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
          <button className="btn btn-secondary" onClick={() => navigate('/crm')}>
            Kontakty
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/tasks')}>
            Úlohy
          </button>
          <UserMenu user={user} onLogout={logout} onUpdateUser={updateUser} />
        </div>
      </header>

      <div className="workspace-members-content">
        <div className="wm-header-info">
          <h2 className="wm-title">Členovia prostredia</h2>
          <div className="wm-stats-row">
            <span className="wm-stat-chip">
              {currentWorkspace?.name || '—'}
            </span>
            <span className="wm-stat-chip">
              👥 {members.length} {members.length === 1 ? 'člen' : members.length < 5 ? 'členovia' : 'členov'}
            </span>
            {invitations.length > 0 && (
              <span className="wm-stat-chip wm-stat-pending">
                ✉ {invitations.length} {invitations.length === 1 ? 'pozvánka' : invitations.length < 5 ? 'pozvánky' : 'pozvánok'}
              </span>
            )}
          </div>
        </div>

        {/* Invite form - owner & manager only */}
        {canManage && (
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
                <option value="manager">Manažér</option>
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
        {canManage && invitations.length > 0 && (
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
                  <div key={member.id} className={`wm-member-card ${member.userId === user?.id ? 'wm-current-user' : ''}`}>
                    <div className="wm-member-info">
                      {member.avatar ? (
                        <img
                          src={`${API_BASE_URL}/api/auth/avatar/${member.userId}`}
                          alt={member.username}
                          className="wm-member-avatar-img"
                        />
                      ) : (
                        <div
                          className="wm-member-avatar"
                          style={{ backgroundColor: member.color || '#6366f1' }}
                        >
                          {member.username?.charAt(0).toUpperCase() || '?'}
                        </div>
                      )}
                      <div className="wm-member-details">
                        <span className="wm-member-name">
                          {member.username || 'Neznámy'}
                          {member.userId === user?.id && ' (vy)'}
                        </span>
                        <span className="wm-member-meta">{member.email}</span>
                      </div>
                    </div>
                    <div className="wm-member-actions">
                      {/* Role badge */}
                      <span
                        className="wm-role-badge"
                        style={{ backgroundColor: badge.color + '20', color: badge.color }}
                      >
                        {badge.label}
                      </span>

                      {/* Role change - owner & manager can change non-owner roles */}
                      {canManage && member.role !== 'owner' && member.userId !== user?.id && (
                        <select
                          value={member.role}
                          onChange={(e) => handleRoleChange(member.id, e.target.value)}
                          className="form-input wm-role-select-sm"
                        >
                          <option value="member">Člen</option>
                          <option value="manager">Manažér</option>
                        </select>
                      )}

                      {/* Transfer ownership - only owner can transfer to managers */}
                      {isOwner && member.role === 'manager' && (
                        <button
                          className="btn btn-secondary btn-sm wm-transfer-btn"
                          onClick={() => handleTransferOwnership(member)}
                          disabled={transferring === member.userId}
                          title="Previesť vlastníctvo"
                        >
                          {transferring === member.userId ? '...' : '👑 Previesť'}
                        </button>
                      )}

                      {/* Remove from workspace */}
                      {canManage && member.role !== 'owner' && member.userId !== user?.id && (
                        <button
                          className="btn-icon wm-remove-btn"
                          onClick={() => handleRemoveMember(member.id, member.username)}
                          title="Odstrániť z prostredia"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default WorkspaceMembers;
