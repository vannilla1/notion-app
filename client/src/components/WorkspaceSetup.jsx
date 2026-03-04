import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import './WorkspaceSetup.css';

const WorkspaceSetup = () => {
  const { createWorkspace, joinWorkspace, loading } = useWorkspace();
  const [mode, setMode] = useState('choose'); // 'choose', 'create', 'join'
  const [workspaceName, setWorkspaceName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreateWorkspace = async (e) => {
    e.preventDefault();
    if (!workspaceName.trim()) {
      setError('Názov pracovného prostredia je povinný');
      return;
    }

    try {
      setIsSubmitting(true);
      setError('');
      await createWorkspace({ name: workspaceName.trim() });
      // Context will handle redirect/refresh
    } catch (err) {
      setError(err.response?.data?.message || 'Chyba pri vytváraní pracovného prostredia');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleJoinWorkspace = async (e) => {
    e.preventDefault();
    if (!inviteCode.trim()) {
      setError('Kód pozvánky je povinný');
      return;
    }

    try {
      setIsSubmitting(true);
      setError('');
      await joinWorkspace(inviteCode.trim().toUpperCase());
      // Context will handle redirect/refresh
    } catch (err) {
      setError(err.response?.data?.message || 'Neplatný kód pozvánky');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="workspace-setup">
        <div className="workspace-setup-card">
          <div className="workspace-loading">
            <div className="spinner"></div>
            <p>Načítavam...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-setup">
      <div className="workspace-setup-card">
        <div className="workspace-setup-header">
          <h1>🏢 Vitajte v Prpl CRM</h1>
          <p>Pre pokračovanie si vytvorte pracovné prostredie alebo sa pripojte k existujúcemu.</p>
        </div>

        {mode === 'choose' && (
          <div className="workspace-setup-options">
            <button
              className="workspace-option-btn create"
              onClick={() => setMode('create')}
            >
              <span className="option-icon">✨</span>
              <span className="option-title">Vytvoriť nové</span>
              <span className="option-desc">Vytvorte si vlastné pracovné prostredie a pozvite kolegov</span>
            </button>

            <div className="workspace-option-divider">
              <span>alebo</span>
            </div>

            <button
              className="workspace-option-btn join"
              onClick={() => setMode('join')}
            >
              <span className="option-icon">🔗</span>
              <span className="option-title">Pripojiť sa</span>
              <span className="option-desc">Máte kód pozvánky? Pripojte sa k existujúcemu tímu</span>
            </button>
          </div>
        )}

        {mode === 'create' && (
          <form className="workspace-form" onSubmit={handleCreateWorkspace}>
            <button
              type="button"
              className="back-btn"
              onClick={() => { setMode('choose'); setError(''); }}
            >
              ← Späť
            </button>

            <h2>Vytvoriť pracovné prostredie</h2>

            <div className="form-group">
              <label htmlFor="workspaceName">Názov</label>
              <input
                type="text"
                id="workspaceName"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="napr. Moja firma s.r.o."
                maxLength={100}
                autoFocus
              />
            </div>

            {error && <div className="error-message">{error}</div>}

            <button
              type="submit"
              className="submit-btn"
              disabled={isSubmitting || !workspaceName.trim()}
            >
              {isSubmitting ? 'Vytváranie...' : 'Vytvoriť'}
            </button>
          </form>
        )}

        {mode === 'join' && (
          <form className="workspace-form" onSubmit={handleJoinWorkspace}>
            <button
              type="button"
              className="back-btn"
              onClick={() => { setMode('choose'); setError(''); }}
            >
              ← Späť
            </button>

            <h2>Pripojiť sa k tímu</h2>

            <div className="form-group">
              <label htmlFor="inviteCode">Kód pozvánky</label>
              <input
                type="text"
                id="inviteCode"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="napr. ABC12345"
                maxLength={20}
                autoFocus
                style={{ textTransform: 'uppercase', letterSpacing: '2px' }}
              />
              <small>Kód vám poskytne správca pracovného prostredia</small>
            </div>

            {error && <div className="error-message">{error}</div>}

            <button
              type="submit"
              className="submit-btn"
              disabled={isSubmitting || !inviteCode.trim()}
            >
              {isSubmitting ? 'Pripájanie...' : 'Pripojiť sa'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default WorkspaceSetup;
