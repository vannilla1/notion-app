import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { API_BASE_URL } from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useWorkspace } from '../context/WorkspaceContext';
import {
  getWorkspaceMembers, updateMemberRole, removeMember,
  sendInvitation, getInvitations, cancelInvitation,
  leaveWorkspace as leaveWorkspaceApi
} from '../api/workspaces';
import { setStoredWorkspaceId } from '../utils/workspaceStorage';
import UserMenu from '../components/UserMenu';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import HeaderLogo from '../components/HeaderLogo';
import NotificationBell from '../components/NotificationBell';

function WorkspaceMembers() {
  const { user, logout, updateUser } = useAuth();
  const { currentWorkspace, refreshCurrentWorkspace, deleteWorkspace } = useWorkspace();
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
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [leavingWorkspace, setLeavingWorkspace] = useState(false);
  // Delete workspace flow — owner-only. Vyžaduje typed-in confirmation
  // (názov workspace) aby sa zabránilo náhodnému kliku v tomto destruktívnom
  // toku — všetky kontakty, projekty, úlohy, správy a členstvá sa zmažú,
  // server endpoint je nevratný (žiadny soft-delete / undo window).
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);
  const [deleteError, setDeleteError] = useState('');

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
    } catch {
      // Silently fail — members list shows empty state
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
        emailSent: result.emailSent,
        link: result.invitation?.inviteLink,
        email: inviteEmail.trim()
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
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <HeaderLogo />
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
          <button className="btn btn-secondary" onClick={() => navigate('/crm')}>
            Kontakty
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/tasks')}>
            Projekty
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/messages')}>
            Správy
          </button>
          <NotificationBell />
          <UserMenu user={user} onLogout={logout} onUpdateUser={updateUser} />
        </div>
      </header>

      <div className="crm-content">
        <main className="crm-main">
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
                {inviteResult.type === 'success' && inviteResult.emailSent ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <span style={{ fontSize: '20px' }}>✅</span>
                      <strong style={{ fontSize: '14px' }}>Pozvánka odoslaná na {inviteResult.email}</strong>
                    </div>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>
                      Pozvaný dostane email s odkazom na prijatie pozvánky. Pozvánka je platná 7 dní.
                    </p>
                    {inviteResult.link && (
                      <details style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        <summary style={{ cursor: 'pointer', userSelect: 'none' }}>Zobraziť odkaz na pozvánku (záloha)</summary>
                        <div className="wm-invite-link-row" style={{ marginTop: '6px' }}>
                          <input type="text" value={inviteResult.link} readOnly className="form-input wm-invite-link-input" />
                          <button className="btn btn-secondary btn-sm" onClick={() => handleCopyLink(inviteResult.link)}>
                            {copiedLink === inviteResult.link ? '✓ Skopírované' : 'Kopírovať'}
                          </button>
                        </div>
                      </details>
                    )}
                  </div>
                ) : (
                  <div>
                    <span>{inviteResult.message}</span>
                    {inviteResult.link && (
                      <div className="wm-invite-link-box">
                        <span className="wm-invite-link-label">⚠️ Email sa nepodarilo odoslať. Pošlite tento odkaz manuálne:</span>
                        <div className="wm-invite-link-row">
                          <input type="text" value={inviteResult.link} readOnly className="form-input wm-invite-link-input" />
                          <button className="btn btn-secondary btn-sm" onClick={() => handleCopyLink(inviteResult.link)}>
                            {copiedLink === inviteResult.link ? '✓ Skopírované' : 'Kopírovať'}
                          </button>
                        </div>
                      </div>
                    )}
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
          {/* Leave workspace - non-owners only */}
          {currentWorkspace?.role !== 'owner' && (
            <div className="wm-leave-section">
              <button
                className="wm-leave-btn"
                onClick={() => setShowLeaveConfirm(true)}
              >
                🚪 Opustiť prostredie
              </button>
            </div>
          )}
          {/* Delete workspace - owner only. Destruktívna akcia, server endpoint
              robí cascade delete (memberships, contacts, tasks, messages,
              invitations + samotný workspace). Nevratné — preto modal
              vyžaduje typed-in confirmation názvu workspace. */}
          {currentWorkspace?.role === 'owner' && (
            <div className="wm-leave-section">
              <button
                className="wm-leave-btn"
                style={{ background: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5' }}
                onClick={() => {
                  setDeleteError('');
                  setDeleteConfirmText('');
                  setShowDeleteConfirm(true);
                }}
              >
                🗑️ Vymazať prostredie
              </button>
            </div>
          )}
          </div>
        </main>
      </div>

      {/* Leave confirm modal */}
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

      {/* Delete workspace confirm modal — owner only */}
      {showDeleteConfirm && currentWorkspace && (
        <div className="workspace-leave-overlay" onClick={() => !deletingWorkspace && setShowDeleteConfirm(false)}>
          <div className="workspace-leave-modal" onClick={e => e.stopPropagation()}>
            <div className="workspace-leave-modal-icon">⚠️</div>
            <h3 className="workspace-leave-modal-title">Vymazať prostredie?</h3>
            <p className="workspace-leave-modal-text">
              Naozaj chceš natrvalo vymazať prostredie <strong>{currentWorkspace.name}</strong>?
            </p>
            <p className="workspace-leave-modal-text" style={{ color: '#b91c1c', fontWeight: 600 }}>
              ⚠️ Táto akcia je <strong>nevratná</strong>. Vymažú sa všetky kontakty,
              projekty, úlohy, správy, pozvánky aj členstvá. Ostatní členovia stratia
              prístup okamžite.
            </p>
            <p className="workspace-leave-modal-text" style={{ fontSize: '13px' }}>
              Pre potvrdenie napíš názov prostredia: <strong>{currentWorkspace.name}</strong>
            </p>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => { setDeleteConfirmText(e.target.value); setDeleteError(''); }}
              placeholder={currentWorkspace.name}
              disabled={deletingWorkspace}
              autoFocus
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '6px',
                border: '1px solid var(--border-color, #e2e8f0)',
                fontSize: '14px',
                marginTop: '8px',
                marginBottom: '8px',
                boxSizing: 'border-box',
              }}
            />
            {deleteError && (
              <div style={{ color: '#b91c1c', fontSize: '13px', marginBottom: '8px' }}>
                {deleteError}
              </div>
            )}
            <div className="workspace-leave-modal-actions">
              <button
                className="workspace-leave-modal-btn cancel"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deletingWorkspace}
              >
                Zrušiť
              </button>
              <button
                className="workspace-leave-modal-btn confirm"
                style={{ background: '#dc2626' }}
                onClick={async () => {
                  // Strict equality s názvom workspace — žiadne case-insensitive
                  // ani trim, aby user reálne pozorne prečítal čo maže.
                  if (deleteConfirmText !== currentWorkspace.name) {
                    setDeleteError('Názov nesúhlasí. Prepíš ho presne tak ako je vyššie.');
                    return;
                  }
                  try {
                    setDeletingWorkspace(true);
                    setDeleteError('');
                    const { nextWorkspaceId } = await deleteWorkspace();
                    if (nextWorkspaceId) {
                      // Switch + hard reload na ďalší workspace. Hard reload
                      // (window.location) namiesto navigate aby všetky in-memory
                      // listy / sockety prebehli rebuild s novým wsId.
                      setStoredWorkspaceId(nextWorkspaceId);
                      window.location.href = `/app?ws=${encodeURIComponent(nextWorkspaceId)}`;
                    } else {
                      // Žiadny ďalší workspace — user uvidí WorkspaceSetup po /app.
                      window.location.href = '/app';
                    }
                  } catch (err) {
                    setDeleteError(err?.response?.data?.message || 'Chyba pri mazaní prostredia');
                    setDeletingWorkspace(false);
                  }
                }}
                disabled={deletingWorkspace || deleteConfirmText !== currentWorkspace.name}
              >
                {deletingWorkspace ? 'Mažem...' : 'Áno, vymazať natrvalo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkspaceMembers;
