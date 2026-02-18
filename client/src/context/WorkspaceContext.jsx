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

  // Fetch workspaces
  const fetchWorkspaces = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
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
      console.error('Error fetching workspaces:', err);
      if (err.response?.data?.code === 'NO_WORKSPACE') {
        setNeedsWorkspace(true);
      } else {
        setError(err.response?.data?.message || 'Chyba pri načítavaní pracovných prostredí');
      }
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  // Load workspaces on auth change
  useEffect(() => {
    if (isAuthenticated) {
      fetchWorkspaces();
    } else {
      setWorkspaces([]);
      setCurrentWorkspace(null);
      setCurrentWorkspaceId(null);
      setNeedsWorkspace(false);
      setLoading(false);
    }
  }, [isAuthenticated, fetchWorkspaces]);

  // Create workspace
  const createWorkspace = async (data) => {
    const result = await workspaceApi.createWorkspace(data);
    await fetchWorkspaces();
    return result;
  };

  // Join workspace
  const joinWorkspace = async (inviteCode) => {
    const result = await workspaceApi.joinWorkspace(inviteCode);
    await fetchWorkspaces();
    return result;
  };

  // Switch workspace
  const switchWorkspace = async (workspaceId) => {
    const result = await workspaceApi.switchWorkspace(workspaceId);
    setCurrentWorkspaceId(workspaceId);
    await fetchWorkspaces();
    return result;
  };

  // Update workspace
  const updateWorkspace = async (data) => {
    const result = await workspaceApi.updateWorkspace(data);
    setCurrentWorkspace(prev => ({ ...prev, ...result }));
    return result;
  };

  // Regenerate invite code
  const regenerateInviteCode = async () => {
    const result = await workspaceApi.regenerateInviteCode();
    setCurrentWorkspace(prev => ({ ...prev, inviteCode: result.inviteCode }));
    return result;
  };

  // Leave workspace
  const leaveWorkspace = async () => {
    const result = await workspaceApi.leaveWorkspace();
    await fetchWorkspaces();
    return result;
  };

  // Refresh current workspace
  const refreshCurrentWorkspace = async () => {
    try {
      const current = await workspaceApi.getCurrentWorkspace();
      setCurrentWorkspace(current);
      return current;
    } catch (err) {
      console.error('Error refreshing workspace:', err);
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
