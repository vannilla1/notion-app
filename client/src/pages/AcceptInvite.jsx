import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { getInvitationByToken, acceptInvitation } from '../api/workspaces';
import { getWorkspaceRoleLabel } from '../utils/constants';
import { isIosNativeApp } from '../utils/platform';

function AcceptInvite() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, user } = useAuth();
  const { fetchWorkspaces, switchWorkspace } = useWorkspace();

  const [invitation, setInvitation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [alreadyAccepted, setAlreadyAccepted] = useState(false);

  useEffect(() => {
    const fetchInvitation = async () => {
      try {
        const data = await getInvitationByToken(token);
        setInvitation(data);
      } catch (err) {
        // If invitation was already accepted
        if (err.response?.data?.alreadyAccepted) {
          if (isAuthenticated && err.response?.data?.workspaceId) {
            try {
              await switchWorkspace(err.response.data.workspaceId);
            } catch { /* ignore */ }
            navigate('/app');
            return;
          }
          setAlreadyAccepted(true);
          setError(err.response?.data?.message);
        } else {
          setError(err.response?.data?.message || 'Pozvánka nenájdená alebo vypršala');
        }
      } finally {
        setLoading(false);
      }
    };
    fetchInvitation();
  }, [token, isAuthenticated, switchWorkspace, navigate]);

  const handleAccept = async () => {
    setAccepting(true);
    setError('');
    try {
      const result = await acceptInvitation(token);
      setSuccess(result.message);
      if (result.workspaceId) {
        await switchWorkspace(result.workspaceId);
      } else {
        await fetchWorkspaces();
      }
      setTimeout(() => navigate('/app'), 2000);
    } catch (err) {
      setError(err.response?.data?.message || 'Chyba pri prijímaní pozvánky');
    } finally {
      setAccepting(false);
    }
  };

  if (loading) {
    return (
      <div className="invite-page">
        <div className="invite-card">
          <div className="loading">Načítavam pozvánku...</div>
        </div>
      </div>
    );
  }

  if (error && !invitation) {
    return (
      <div className="invite-page">
        <div className="invite-card">
          <div className="invite-icon">{alreadyAccepted ? '✅' : '❌'}</div>
          <h2>{alreadyAccepted ? 'Pozvánka prijatá' : 'Neplatná pozvánka'}</h2>
          <p className={alreadyAccepted ? 'invite-success-text' : 'invite-error'}>{error}</p>
          {alreadyAccepted ? (
            <Link to="/login" className="btn btn-primary" style={{ marginTop: '16px', display: 'inline-block' }}>
              Prihlásiť sa a pokračovať
            </Link>
          ) : (
            <Link to="/login" className="btn btn-primary" style={{ marginTop: '16px', display: 'inline-block' }}>
              Prihlásiť sa
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="invite-page">
      <div className="invite-card">
        <div className="invite-icon" style={{ color: invitation?.workspaceColor || '#6366f1' }}>🏢</div>
        <h2>Pozvánka do prostredia</h2>

        <div className="invite-details">
          <div className="invite-workspace-name" style={{ borderLeftColor: invitation?.workspaceColor || '#6366f1' }}>
            {invitation?.workspaceName}
          </div>
          <p>Pozval vás: <strong>{invitation?.invitedBy}</strong></p>
          <p>Rola: <strong>{getWorkspaceRoleLabel(invitation?.role)}</strong></p>
        </div>

        {success ? (
          <div className="invite-success">
            <span>✅</span> {success}
            <p style={{ fontSize: '13px', marginTop: '8px', color: '#64748b' }}>Presmerovanie...</p>
          </div>
        ) : error ? (
          <div className="invite-error-box">{error}</div>
        ) : null}

        {!success && (
          isAuthenticated ? (
            <div className="invite-actions">
              <p className="invite-logged-as">Prihlásený ako <strong>{user?.username}</strong> ({user?.email})</p>
              <button
                className="btn btn-primary invite-accept-btn"
                onClick={handleAccept}
                disabled={accepting}
              >
                {accepting ? 'Prijímam...' : 'Prijať pozvánku'}
              </button>
            </div>
          ) : (
            <div className="invite-actions">
              {/* App Store 3.1.1: na iOS native nezobrazujeme "Vytvoriť účet"
                  CTA — registrácia musí prebiehať na webe. Text inštrukcie
                  upravený aby user vedel kam ísť. Pre lepšiu UX pri iOS
                  appke pridáme číslovaný step-by-step namiesto jedného
                  riadku — užívateľ jasne vidí 3 kroky čo má spraviť. */}
              {isIosNativeApp() ? (
                <div className="invite-ios-steps">
                  <p className="invite-not-logged">Pre prijatie pozvánky postupujte podľa krokov:</p>
                  <ol style={{ margin: '8px 0 0', paddingLeft: '20px', fontSize: '14px', lineHeight: 1.6, color: 'var(--text-muted, #64748b)' }}>
                    <li>Otvorte vo Safari adresu <a href="https://prplcrm.eu" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-color, #6366f1)', fontWeight: 600 }}>prplcrm.eu</a> a vytvorte si zdarma účet.</li>
                    <li>Vráťte sa do tejto aplikácie a prihláste sa.</li>
                    <li>Pozvánka sa potom automaticky prijme — alebo ju otvorte z emailu znova.</li>
                  </ol>
                </div>
              ) : (
                <p className="invite-not-logged">
                  Pre prijatie pozvánky sa musíte prihlásiť alebo zaregistrovať.
                </p>
              )}
              <div className="invite-auth-buttons">
                <Link to={`/login?invite=${token}`} className="btn btn-primary">
                  Prihlásiť sa
                </Link>
                {!isIosNativeApp() && (
                  <Link to={`/login?register=true&invite=${token}`} className="btn btn-secondary">
                    Vytvoriť účet
                  </Link>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

export default AcceptInvite;
