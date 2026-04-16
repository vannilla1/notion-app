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
    setCurrentWorkspaceId(workspaceId);
    // DO NOT call fetchWorkspaces() here. Previously we did, for "freshness",
    // but on Render (potential multi-instance + 60s workspace middleware cache)
    // the subsequent GET /workspaces can hit an instance whose cache still holds
    // the PREVIOUS currentWorkspaceId. That stale value then overwrote the
    // just-set target via setCurrentWorkspaceId(data.currentWorkspaceId) —
    // which is the exact "push notification opens correct section but wrong
    // workspace (first in list)" bug users reported.
    //
    // A workspace switch does not change the workspaces list or the user's
    // memberships — only currentWorkspaceId changes. We already have the new
    // value (Y) from the successful POST, so we trust it. For the current
    // workspace DETAILS (name, color, role, memberCount...) we do a targeted
    // fetch via getCurrentWorkspace(), which reads through requireWorkspace
    // middleware — but even if that's briefly stale, the workspace-scoped data
    // fetches (tasks/contacts/messages) triggered by the `workspace-switched`
    // event below will hit the correct workspace because they use
    // currentWorkspaceId from React state, which is Y.
    try {
      const current = await workspaceApi.getCurrentWorkspace();
      setCurrentWorkspace(current);
    } catch (err) {
      // Non-fatal: currentWorkspace details stay stale (wrong name/color in
      // header briefly) but currentWorkspaceId is correct, so data loading
      // works. A manual refresh or next fetchWorkspaces call will reconcile.
      console.warn('[Workspace] getCurrentWorkspace after switch failed:', err?.response?.status);
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
