import { useState, useRef, useEffect, useCallback } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { switchWorkspace as switchWorkspaceApi } from '../api/workspaces';
import { setStoredWorkspaceId } from '../utils/workspaceStorage';
import api from '../api/api';
import { getWorkspaceRoleLabel, WORKSPACE_COLORS } from '../utils/constants';
import './WorkspaceSwitcher.css';

const WorkspaceSwitcher = () => {
  const { workspaces, currentWorkspace, switchWorkspace, updateWorkspace, createWorkspace, reorderWorkspaces, loading } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [saving, setSaving] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [colorPickerFor, setColorPickerFor] = useState(null);
  const [unreadByWs, setUnreadByWs] = useState({});
  const [reordering, setReordering] = useState(false); // in-flight reorder guard
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);
  const createInputRef = useRef(null);

  // Fetch unread counts per workspace so we can badge other workspaces
  // when they have unread notifications (multi-workspace awareness)
  const fetchUnreadByWs = useCallback(async () => {
    try {
      const res = await api.get('/api/notifications/unread-by-workspace');
      setUnreadByWs(res.data || {});
    } catch {}
  }, []);

  useEffect(() => {
    fetchUnreadByWs();
    const interval = setInterval(fetchUnreadByWs, 30000);
    return () => clearInterval(interval);
  }, [fetchUnreadByWs]);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

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

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (isCreating && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [isCreating]);

  const handleSwitch = async (workspaceId) => {
    if (workspaceId === currentWorkspace?.id) {
      setIsOpen(false);
      return;
    }

    try {
      await switchWorkspaceApi(workspaceId);
      // 1) Per-device storage + native Android bridge write-through.
      setStoredWorkspaceId(workspaceId);
      // 2) `ws=` URL param — WorkspaceContext má URL prioritu vyššiu ako
      //    localStorage aj DB default, takže aj keby Android MainActivity
      //    stihol re-injectnuť stale wsId z TokenStore do localStorage pred
      //    React bootom, URL param vyhrá. Bulletproof pre Android race.
      window.location.href = `/app?ws=${encodeURIComponent(workspaceId)}`;
    } catch {
      // Switch failed — stay on current workspace
    }
  };

  const canEdit = currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'manager';
  const colorOptions = WORKSPACE_COLORS;

  // Reorder poradia prostredí (per-user). Current je pripnutý hore; šípkami
  // usporadúvaš ostatné. Persistuje sa celé poradie [current, ...ostatné].
  const moveOther = async (others, index, dir) => {
    if (reordering) return; // nečakať na prekrývajúce sa požiadavky (out-of-order)
    const j = index + dir;
    if (j < 0 || j >= others.length) return;
    const arr = [...others];
    [arr[index], arr[j]] = [arr[j], arr[index]];
    const orderedIds = [currentWorkspace.id, ...arr.map(w => w.id)];
    setReordering(true);
    try {
      await reorderWorkspaces(orderedIds);
    } catch {
      // rollback rieši context; UI ostane konzistentné
    } finally {
      setReordering(false);
    }
  };

  const handleColorChange = async (color) => {
    try {
      await updateWorkspace({ color });
      setColorPickerFor(null);
    } catch {
      // Color update failed
    }
  };

  const startCreating = () => {
    setNewWorkspaceName('');
    setIsCreating(true);
  };

  const cancelCreating = () => {
    setIsCreating(false);
    setNewWorkspaceName('');
  };

  const handleCreateWorkspace = async () => {
    if (!newWorkspaceName.trim()) {
      cancelCreating();
      return;
    }

    try {
      setSaving(true);
      await createWorkspace({ name: newWorkspaceName.trim() });
      setIsCreating(false);
      setNewWorkspaceName('');
      setIsOpen(false);
      window.location.href = '/app';
    } catch {
      alert('Chyba pri vytváraní prostredia');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleCreateWorkspace();
    } else if (e.key === 'Escape') {
      cancelCreating();
    }
  };

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
    } catch {
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

  if (isMobile || loading || !currentWorkspace) {
    return null;
  }

  // Sum unread for workspaces OTHER than the current one — shown as a
  // red dot on the switcher button so user knows another ws has activity
  const otherUnreadTotal = Object.entries(unreadByWs).reduce((sum, [wsId, c]) => {
    return wsId !== currentWorkspace.id ? sum + c : sum;
  }, 0);

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
        {otherUnreadTotal > 0 && (
          <span className="workspace-unread-dot" title={`${otherUnreadTotal} neprečítaných v iných prostrediach`} />
        )}
        <span className="workspace-arrow">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="workspace-dropdown">
          <div className="workspace-dropdown-header">
            Pracovné prostredia
          </div>

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
              <>
                <div className="workspace-dropdown-item active">
                  <span
                    className={`workspace-color ${canEdit ? 'clickable' : ''}`}
                    style={{ backgroundColor: currentWorkspace.color || '#6366f1' }}
                    onClick={(e) => {
                      if (canEdit) {
                        e.stopPropagation();
                        setColorPickerFor(colorPickerFor === 'current' ? null : 'current');
                      }
                    }}
                    title={canEdit ? 'Zmeniť farbu' : undefined}
                  />
                  <span className="workspace-info">
                    <span className="workspace-item-name">{currentWorkspace.name}</span>
                    <span className="workspace-item-role">
                      {getWorkspaceRoleLabel(currentWorkspace.role)}
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
                {colorPickerFor === 'current' && canEdit && (
                  <div className="workspace-color-picker">
                    {colorOptions.map(color => (
                      <span
                        key={color}
                        className={`workspace-color-option ${(currentWorkspace.color || '#6366f1').toLowerCase() === color.toLowerCase() ? 'selected' : ''}`}
                        style={{ backgroundColor: color }}
                        onClick={() => handleColorChange(color)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {workspaces.filter(ws => ws.id !== currentWorkspace.id).map((ws, index, others) => {
            const unread = unreadByWs[ws.id] || 0;
            const isFirst = index === 0;
            const isLast = index === others.length - 1;
            return (
              <div
                key={ws.id}
                className="workspace-dropdown-item"
                onClick={() => handleSwitch(ws.id)}
                onKeyDown={(e) => {
                  // Ignoruj klávesy z detí (šípky) — inak by Enter/Space na šípke
                  // prepol prostredie namiesto posunu.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSwitch(ws.id); }
                }}
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer' }}
              >
                <span
                  className="workspace-color"
                  style={{ backgroundColor: ws.color || '#6366f1' }}
                />
                <span className="workspace-info">
                  <span className="workspace-item-name">{ws.name}</span>
                  <span className="workspace-item-role">
                    {getWorkspaceRoleLabel(ws.role)}
                  </span>
                </span>
                {unread > 0 && (
                  <span className="workspace-unread-badge">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
                {others.length > 1 && (
                  <span className="workspace-reorder" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="workspace-reorder-btn"
                      title="Posunúť vyššie"
                      aria-label={`Posunúť „${ws.name}" vyššie`}
                      disabled={isFirst || reordering}
                      onClick={(e) => { e.stopPropagation(); moveOther(others, index, -1); }}
                    >▲</button>
                    <button
                      type="button"
                      className="workspace-reorder-btn"
                      title="Posunúť nižšie"
                      aria-label={`Posunúť „${ws.name}" nižšie`}
                      disabled={isLast || reordering}
                      onClick={(e) => { e.stopPropagation(); moveOther(others, index, 1); }}
                    >▼</button>
                  </span>
                )}
              </div>
            );
          })}

          <div className="workspace-create-section">
            {isCreating ? (
              <div className="workspace-create-row">
                <input
                  ref={createInputRef}
                  type="text"
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  onKeyDown={handleCreateKeyDown}
                  className="workspace-edit-input"
                  placeholder="Názov nového prostredia"
                  disabled={saving}
                  maxLength={100}
                />
                <button
                  onClick={handleCreateWorkspace}
                  className="workspace-edit-btn save"
                  disabled={saving || !newWorkspaceName.trim()}
                  title="Vytvoriť"
                >
                  ✓
                </button>
                <button
                  onClick={cancelCreating}
                  className="workspace-edit-btn cancel"
                  disabled={saving}
                  title="Zrušiť"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                className="workspace-dropdown-item workspace-create-btn"
                onClick={startCreating}
              >
                <span className="workspace-create-icon">+</span>
                <span className="workspace-info">
                  <span className="workspace-item-name">Nové prostredie</span>
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkspaceSwitcher;
