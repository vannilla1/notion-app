import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';
import * as workspaceApi from '../api/workspaces';
import { APP_EVENTS } from '../utils/constants';

const WorkspaceContext = createContext(null);

export const useWorkspace = () => {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within WorkspaceProvider');
  }
  return context;
};

export const WorkspaceProvider = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const [workspaces, setWorkspaces] = useState([]);
  const [currentWorkspace, setCurrentWorkspace] = useState(null);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsWorkspace, setNeedsWorkspace] = useState(false);

  const fetchWorkspaces = useCallback(async () => {
    // Loading=true držíme aj keď nie sme authenticated — App.jsx gate kontroluje
    // workspaceLoading iba pri isAuthenticated=true, takže to nespôsobí blok,
    // ale zabráni 1-frame flashu medzi auth-resolved a workspace-fetch-started.
    if (!isAuthenticated) return;

    try {
      setLoading(true);
      setError(null);
      const [data, current] = await Promise.all([
        workspaceApi.getWorkspaces(),
        workspaceApi.getCurrentWorkspace().catch(err => {
          if (err.response?.data?.code === 'NO_WORKSPACE') return null;
          throw err;
        })
      ]);
      setWorkspaces(data.workspaces || []);
      setCurrentWorkspaceId(data.currentWorkspaceId);

      if (data.workspaces.length === 0 || !data.currentWorkspaceId) {
        setNeedsWorkspace(true);
        setCurrentWorkspace(null);
      } else {
        setNeedsWorkspace(false);
        setCurrentWorkspace(current);
      }
    } catch (err) {
      if (err.response?.data?.code === 'NO_WORKSPACE') {
        setNeedsWorkspace(true);
      } else {
        setError(err.response?.data?.message || 'Chyba pri načítavaní pracovných prostredí');
      }
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchWorkspaces();
    } else {
      setWorkspaces([]);
      setCurrentWorkspace(null);
      setCurrentWorkspaceId(null);
      setNeedsWorkspace(false);
      // loading=true zachovávame zámerne — viď komentár v fetchWorkspaces.
    }
  }, [isAuthenticated, fetchWorkspaces]);

  const createWorkspace = async (data) => {
    const result = await workspaceApi.createWorkspace(data);
    await fetchWorkspaces();
    return result;
  };

  const joinWorkspace = async (inviteCode) => {
    const result = await workspaceApi.joinWorkspace(inviteCode);
    await fetchWorkspaces();
    return result;
  };

  const switchWorkspace = async (workspaceId) => {
    const result = await workspaceApi.switchWorkspace(workspaceId);
    // CRITICAL: id + details meníme ATOMICKY z jedného POST /switch response.
    // React batchne oba setState volania do jedného renderu, takže header /
    // sidebar / children vidia konzistentný workspace v ďalšom paint.
    // (Druhý fetch GET /current by otvoril race window medzi id a details,
    // čím by `pendingWsSwitch` gate v App.jsx odomkol stránku so stale headerom
    // — to bola "cross-workspace push notification" regresia, commit c18a9b2.)
    setCurrentWorkspaceId(workspaceId);
    if (result?.workspace) {
      setCurrentWorkspace(result.workspace);
    }
    // Stránky (Dashboard/CRM/Tasks/Messages) nie sú odpojené od toho istého
    // URL pri `ws=` zmene, preto im eventom povieme: refetch + reset modalov.
    window.dispatchEvent(new CustomEvent(APP_EVENTS.WORKSPACE_SWITCHED, { detail: { workspaceId } }));
    return result;
  };

  const updateWorkspace = async (data) => {
    const result = await workspaceApi.updateWorkspace(data);
    setCurrentWorkspace(prev => ({ ...prev, ...result }));
    return result;
  };

  const regenerateInviteCode = async () => {
    const result = await workspaceApi.regenerateInviteCode();
    setCurrentWorkspace(prev => ({ ...prev, inviteCode: result.inviteCode }));
    return result;
  };

  const leaveWorkspace = async () => {
    const result = await workspaceApi.leaveWorkspace();
    await fetchWorkspaces();
    return result;
  };

  const refreshCurrentWorkspace = async () => {
    try {
      const current = await workspaceApi.getCurrentWorkspace();
      setCurrentWorkspace(current);
      return current;
    } catch (err) {
      throw err;
    }
  };

  const value = {
    workspaces,
    currentWorkspace,
    currentWorkspaceId,
    loading,
    error,
    needsWorkspace,
    fetchWorkspaces,
    createWorkspace,
    joinWorkspace,
    switchWorkspace,
    updateWorkspace,
    regenerateInviteCode,
    leaveWorkspace,
    refreshCurrentWorkspace
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
};
