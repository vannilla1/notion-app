import { useState, useRef, useEffect } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import './WorkspaceSwitcher.css';

const WorkspaceSwitcher = () => {
  const { workspaces, currentWorkspace, switchWorkspace, updateWorkspace, loading } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);

  // Detect mobile screen size
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
        setIsEditing(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSwitch = async (workspaceId) => {
    if (workspaceId === currentWorkspace?.id) {
      setIsOpen(false);
      return;
    }

    try {
      await switchWorkspace(workspaceId);
      setIsOpen(false);
      // Reload the page to refresh all data for new workspace
      window.location.reload();
    } catch (err) {
      console.error('Error switching workspace:', err);
    }
  };

  const canEdit = currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'admin';

  const startEditing = (e) => {
    e.stopPropagation();
    setEditName(currentWorkspace.name);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditName('');
  };

  const saveWorkspaceName = async () => {
    if (!editName.trim() || editName.trim() === currentWorkspace.name) {
      cancelEditing();
      return;
    }

    try {
      setSaving(true);
      await updateWorkspace({ name: editName.trim() });
      setIsEditing(false);
      setEditName('');
    } catch (err) {
      console.error('Error updating workspace:', err);
      alert('Chyba pri ukladaní názvu');
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      saveWorkspaceName();
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };

  // Don't render on mobile - workspace info is shown in UserMenu instead
  if (isMobile || loading || !currentWorkspace) {
    return null;
  }

  // Only show switcher if user has multiple workspaces
  if (workspaces.length <= 1) {
    return (
      <div className="workspace-indicator" ref={dropdownRef}>
        {isEditing ? (
          <div className="workspace-edit-inline">
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={handleKeyDown}
              className="workspace-edit-input"
              placeholder="Názov workspace"
              disabled={saving}
            />
            <button
              onClick={saveWorkspaceName}
              className="workspace-edit-btn save"
              disabled={saving}
              title="Uložiť"
            >
              ✓
            </button>
            <button
              onClick={cancelEditing}
              className="workspace-edit-btn cancel"
              disabled={saving}
              title="Zrušiť"
            >
              ✕
            </button>
          </div>
        ) : (
          <>
            <span
              className="workspace-color"
              style={{ backgroundColor: currentWorkspace.color || '#6366f1' }}
            />
            <span className="workspace-name">{currentWorkspace.name}</span>
            {canEdit && (
              <button
                className="workspace-edit-icon"
                onClick={startEditing}
                title="Upraviť názov"
              >
                ✏️
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="workspace-switcher" ref={dropdownRef}>
      <button
        className="workspace-switcher-btn"
        onClick={() => !isEditing && setIsOpen(!isOpen)}
        title="Prepnúť pracovné prostredie"
      >
        <span
          className="workspace-color"
          style={{ backgroundColor: currentWorkspace.color || '#6366f1' }}
        />
        <span className="workspace-name">{currentWorkspace.name}</span>
        <span className="workspace-arrow">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="workspace-dropdown">
          <div className="workspace-dropdown-header">
            Pracovné prostredia
          </div>

          {/* Current workspace with edit option */}
          <div className="workspace-current-section">
            {isEditing ? (
              <div className="workspace-edit-row">
                <input
                  ref={inputRef}
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="workspace-edit-input"
                  placeholder="Názov workspace"
                  disabled={saving}
                />
                <button
                  onClick={saveWorkspaceName}
                  className="workspace-edit-btn save"
                  disabled={saving}
                  title="Uložiť"
                >
                  ✓
                </button>
                <button
                  onClick={cancelEditing}
                  className="workspace-edit-btn cancel"
                  disabled={saving}
                  title="Zrušiť"
                >
                  ✕
                </button>
              </div>
            ) : (
              <div className="workspace-dropdown-item active">
                <span
                  className="workspace-color"
                  style={{ backgroundColor: currentWorkspace.color || '#6366f1' }}
                />
                <span className="workspace-info">
                  <span className="workspace-item-name">{currentWorkspace.name}</span>
                  <span className="workspace-item-role">
                    {currentWorkspace.role === 'owner' ? 'Vlastník' : currentWorkspace.role === 'admin' ? 'Admin' : 'Člen'}
                  </span>
                </span>
                {canEdit && (
                  <button
                    className="workspace-edit-icon"
                    onClick={startEditing}
                    title="Upraviť názov"
                  >
                    ✏️
                  </button>
                )}
                <span className="workspace-check">✓</span>
              </div>
            )}
          </div>

          {/* Other workspaces */}
          {workspaces.filter(ws => ws.id !== currentWorkspace.id).map((ws) => (
            <button
              key={ws.id}
              className="workspace-dropdown-item"
              onClick={() => handleSwitch(ws.id)}
            >
              <span
                className="workspace-color"
                style={{ backgroundColor: ws.color || '#6366f1' }}
              />
              <span className="workspace-info">
                <span className="workspace-item-name">{ws.name}</span>
                <span className="workspace-item-role">
                  {ws.role === 'owner' ? 'Vlastník' : ws.role === 'admin' ? 'Admin' : 'Člen'}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default WorkspaceSwitcher;
