import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './AuthContext';
import * as workspaceApi from '../api/workspaces';
import { APP_EVENTS } from '../utils/constants';
import { reportError } from '../utils/reportError';
import {
  getStoredWorkspaceId,
  setStoredWorkspaceId,
  setSessionOnlyWorkspaceId,
  removeStoredWorkspaceId
} from '../utils/workspaceStorage';

// Čítať `ws=` z aktuálnej URL pri boot-e / fetchWorkspaces. Pre push notification
// deep linky toto MUSÍ vyhrať nad localStorage (per-device) aj DB default —
// inak by fetchWorkspaces nastavilo `currentWorkspace` na stale A-object z DB
// defaultu a následný switchWorkspace(X) by v race-window nechal header visieť
// so starým názvom (observed: "po kliknutí na notifikáciu otvorí správny
// workspace + úlohu, ale názov workspace v headeri je zlý — je to prvý
// workspace v poradí").
const readUrlWsId = () => {
  try {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('ws');
  } catch {
    return null;
  }
};

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
  // Inicializujeme z URL `ws=` (deep link priorita) alebo per-device storage —
  // prvý render má správny workspaceId hneď, čím sa axios interceptor pošle
  // s headerom aj na prvý fetchWorkspaces() a server vie, ktorý workspace sme
  // mali "otvorený" pred reloadom. Push notification tap (iOS cold start) má
  // URL už s `ws=X` v čase ReactDOM mount — tu to zachytíme, aby po fetchu
  // detailov bol currentWorkspace hneď X-object a nie DB-default-object.
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState(() => {
    const urlWs = readUrlWsId();
    if (urlWs) {
      // Sync do storage okamžite — axios interceptor číta z storage, takže
      // prvý GET /workspaces/current pošle X-Workspace-Id=X a server vráti
      // správny workspace namiesto DB defaultu.
      try { setStoredWorkspaceId(urlWs); } catch { /* noop */ }
      return urlWs;
    }
    return getStoredWorkspaceId();
  });
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

      // KROK 2: Workspace priority — URL `ws=` > localStorage > DB default.
      // - URL `ws=` (deep link) MUSÍ vyhrať — inak by fetchWorkspaces nastavilo
      //   currentWorkspace na DB-default-object, potom by switchWorkspace(X)
      //   v useLayoutEffect race-window nechal header zobrazený s A-name.
      //   (Bug report: "názov workspace je zlý — je to prvý workspace v poradí"
      //   = DB default.)
      // - Inak localStorage — device ostáva v "svojom" workspace aj keď user
      //   prepol na inom zariadení.
      // - Inak (prvý login / nové zariadenie / stale storage) → DB default.
      const urlWsId = readUrlWsId();
      const memberIdSet = new Set((data.workspaces || []).map(
        w => (w.id || w._id)?.toString()
      ));
      const urlIsMember = urlWsId && memberIdSet.has(urlWsId.toString());
      const localWsId = getStoredWorkspaceId();
      const localIsMember = localWsId && memberIdSet.has(localWsId.toString());

      const effectiveWsId = urlIsMember
        ? urlWsId
        : (localIsMember ? localWsId : data.currentWorkspaceId);

      // Storage MUSÍ byť nastavený PRED ďalším API callom — axios interceptor
      // číta storage, takže getCurrentWorkspace dostane správny X-Workspace-Id.
      //
      // KRITICKÉ rozlíšenie zdroja:
      //  - URL `ws=` alebo localStorage → USER INTENT → device-wide persist
      //    (dual-write session + local).
      //  - DB default → iba sessionStorage. Inak by sme stale DB hodnotu
      //    zapísali do localStorage a "zacementovali" ju naprieč refreshmi
      //    aj keď user medzitým prepol na inom zariadení.
      if (urlIsMember || localIsMember) {
        setStoredWorkspaceId(effectiveWsId);
      } else {
        setSessionOnlyWorkspaceId(effectiveWsId);
      }
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

  // Tracking: bol user prihlásený v predchádzajúcom renderi? Rozlíšenie medzi:
  //  A) Bootstrap: AuthContext ešte neresolvol → isAuthenticated=false DEFAULT.
  //     V tomto stave NECHCEME mazať storage, lebo prerušíme workspace state
  //     užívateľa medzi refreshmi. Práve toto spôsobovalo, že refresh desktopu
  //     vyčistil session/localStorage a fetchWorkspaces padol na stale DB
  //     default (= iOS workspace po switchoch).
  //  B) Explicit logout: isAuthenticated true → false transition. Vtedy chceme
  //     zmazať všetko, lebo ďalší prihlásený user by zdedil cudzí workspaceId.
  const wasAuthenticatedRef = useRef(false);

  useEffect(() => {
    if (isAuthenticated) {
      wasAuthenticatedRef.current = true;
      fetchWorkspaces();
    } else {
      setWorkspaces([]);
      setCurrentWorkspace(null);
      setCurrentWorkspaceId(null);
      setNeedsWorkspace(false);
      // Iba ak bol user v predchádzajúcom renderi prihlásený (skutočný logout).
      // Boot-time false → false hýbať storage-om nesmieme.
      if (wasAuthenticatedRef.current) {
        removeStoredWorkspaceId();
        wasAuthenticatedRef.current = false;
      }
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
    } else {
      // Diagnostika: server MÁ vždy vrátiť workspace field. Ak ho nevráti,
      // currentWorkspace ostane stale a header zobrazí starý názov. Logujeme,
      // aby sme vedeli, keby sa to v proďákcii stalo.
      reportError({
        name: 'SwitchWorkspaceMissingWorkspace',
        message: `POST /switch/${workspaceId} returned result without workspace field. result=${JSON.stringify(result)?.slice(0, 200)}`,
        level: 'warn'
      });
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

  /**
   * Delete current workspace (owner only — server enforces).
   * After deletion, returns { nextWorkspaceId } pointing to another workspace
   * the user is still a member of, or null if they have no other workspaces.
   * Caller is responsible for the actual redirect (typically a hard navigation
   * to /app?ws=<id> to ensure all in-memory state is rebuilt with the new ws).
   */
  const deleteWorkspace = async () => {
    const deletedId = currentWorkspace?.id || currentWorkspaceId;
    await workspaceApi.deleteWorkspace();
    // Refetch workspaces — server-side deleteWorkspace clears
    // currentWorkspaceId for affected users, takže `getWorkspaces()` vráti
    // všetky zostávajúce v ktorých má user membership.
    const data = await workspaceApi.getWorkspaces();
    const remaining = (data.workspaces || []).filter(
      (w) => (w.id || w._id)?.toString() !== deletedId?.toString()
    );
    setWorkspaces(remaining);
    if (remaining.length === 0) {
      // Žiadne ďalšie workspaces → user uvidí WorkspaceSetup screen.
      setCurrentWorkspace(null);
      setCurrentWorkspaceId(null);
      return { nextWorkspaceId: null };
    }
    // Vráti najnovší (alebo prvý) zo zostávajúcich — caller si zariadi
    // switch + redirect (window.location.href = `/app?ws=${id}`).
    const next = remaining[0];
    return { nextWorkspaceId: next.id || next._id };
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
    deleteWorkspace,
    refreshCurrentWorkspace
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
};
