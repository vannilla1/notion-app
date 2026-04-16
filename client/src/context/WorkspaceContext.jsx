import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';
import * as workspaceApi from '../api/workspaces';

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
    if (!isAuthenticated) {
      // Don't set loading=false here — App.jsx only checks workspaceLoading
      // when isAuthenticated is true, so keeping it true prevents flash
      // between auth resolving and workspace fetch starting.
      return;
    }

    try {
      setLoading(true);
      setError(null);
      // Fetch workspaces and current workspace in parallel
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
      // Don't set loading=false — App.jsx condition: loading || (isAuthenticated && workspaceLoading)
      // When isAuthenticated=false, workspaceLoading is irrelevant, so keeping it true is safe
      // and prevents the 1-frame flash when auth resolves before workspace fetch starts.
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
    // CRITICAL: update currentWorkspaceId AND currentWorkspace (details)
    // ATOMICALLY from the single POST /switch response. React batches both
    // setState calls into one render — so every component that reads either
    // value sees a consistent workspace state in the next paint.
    //
    // Previously this function did:
    //   setCurrentWorkspaceId(B)            ← id flipped to B
    //   await getCurrentWorkspace()         ← yields a render tick
    //   ... React renders here with:
    //     currentWorkspaceId = B
    //     currentWorkspace   = A (still!)   ← race window
    //   setCurrentWorkspace(current)        ← finally updates details
    //
    // During the race window, the `pendingWsSwitch` gate in App.jsx (which
    // only checks currentWorkspaceId) opened and unblocked child routes.
    // Tasks/CRM/Messages mounted, but the header/sidebar kept showing the
    // OLD workspace's name and color. That is the "push notification opens
    // right section in wrong workspace" symptom users reported.
    //
    // POST /switch now returns the full workspace shape (matches GET /current),
    // so we never need a second roundtrip for the critical path.
    setCurrentWorkspaceId(workspaceId);
    if (result?.workspace) {
      setCurrentWorkspace(result.workspace);
    }
    // Tell every mounted page (Dashboard/CRM/Tasks/Messages) to refetch +
    // reset expanded/modal state. Without this, switching workspace via a
    // deep-link (push notification tap) changes the header but leaves the
    // page showing data from the previous workspace — because the page
    // component doesn't remount when only location.search changes.
    window.dispatchEvent(new CustomEvent('workspace-switched', { detail: { workspaceId } }));
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
