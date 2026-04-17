import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';
import * as workspaceApi from '../api/workspaces';
import { APP_EVENTS } from '../utils/constants';
import {
  getStoredWorkspaceId,
  setStoredWorkspaceId,
  removeStoredWorkspaceId
} from '../utils/workspaceStorage';

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
  // Inicializujeme z per-device storage — prvý render má správny workspaceId
  // hneď, čím sa axios interceptor pošle s headerom aj na prvý fetchWorkspaces()
  // a server vie, ktorý workspace sme mali "otvorený" pred reloadom.
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState(() => getStoredWorkspaceId());
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

      // KROK 1: Memberships + server-side default current (z User.currentWorkspaceId).
      // `getWorkspaces()` nepoužíva requireWorkspace middleware, takže tu header
      // nerobí nič — dostaneme vždy zoznam membership-ov + DB default.
      const data = await workspaceApi.getWorkspaces();
      setWorkspaces(data.workspaces || []);

      // KROK 2: Per-device workspace selection.
      // - Ak máme lokálny workspaceId (z storage) a je v memberships → rešpektujeme
      //   ho; device ostáva v "svojom" workspace aj keď user prepol na inom zariadení.
      // - Inak (prvý login / nové zariadenie / stale storage po leave workspace) →
      //   fallback na server-returned currentWorkspaceId.
      const localWsId = getStoredWorkspaceId();
      const localIsMember = localWsId && (data.workspaces || []).some(
        w => (w.id || w._id)?.toString() === localWsId.toString()
      );
      const effectiveWsId = localIsMember ? localWsId : data.currentWorkspaceId;

      // Storage MUSÍ byť nastavený PRED ďalším API callom — axios interceptor
      // číta storage, takže getCurrentWorkspace dostane správny X-Workspace-Id.
      setStoredWorkspaceId(effectiveWsId);
      setCurrentWorkspaceId(effectiveWsId);

      if (!data.workspaces || data.workspaces.length === 0 || !effectiveWsId) {
        setNeedsWorkspace(true);
        setCurrentWorkspace(null);
      } else {
        setNeedsWorkspace(false);
        // KROK 3: Načítame details pre effectiveWsId (backend honorí header).
        try {
          const current = await workspaceApi.getCurrentWorkspace();
          setCurrentWorkspace(current);
        } catch (err) {
          if (err.response?.data?.code === 'NO_WORKSPACE') {
            setNeedsWorkspace(true);
            setCurrentWorkspace(null);
          } else {
            throw err;
          }
        }
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
      removeStoredWorkspaceId();
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
    setStoredWorkspaceId(workspaceId);
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
