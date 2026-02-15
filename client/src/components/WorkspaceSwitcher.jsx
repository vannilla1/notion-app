import { useState, useRef, useEffect } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import './WorkspaceSwitcher.css';

const WorkspaceSwitcher = () => {
  const { workspaces, currentWorkspace, switchWorkspace, loading } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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

  if (loading || !currentWorkspace) {
    return null;
  }

  // Only show switcher if user has multiple workspaces
  if (workspaces.length <= 1) {
    return (
      <div className="workspace-indicator">
        <span
          className="workspace-color"
          style={{ backgroundColor: currentWorkspace.color || '#6366f1' }}
        />
        <span className="workspace-name">{currentWorkspace.name}</span>
      </div>
    );
  }

  return (
    <div className="workspace-switcher" ref={dropdownRef}>
      <button
        className="workspace-switcher-btn"
        onClick={() => setIsOpen(!isOpen)}
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
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              className={`workspace-dropdown-item ${ws.id === currentWorkspace.id ? 'active' : ''}`}
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
              {ws.id === currentWorkspace.id && (
                <span className="workspace-check">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default WorkspaceSwitcher;
