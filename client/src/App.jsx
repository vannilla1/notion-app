import { useEffect, useLayoutEffect, useState, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { WorkspaceProvider, useWorkspace } from './context/WorkspaceContext';
import NotificationToast from './components/NotificationToast';
import PushPermissionBanner from './components/PushPermissionBanner';
import BottomNav from './components/BottomNav';
import api from './api/api';
import { useSocket } from './hooks/useSocket';
import WorkspaceSetup from './components/WorkspaceSetup';
import { initializePush } from './services/pushNotifications';
import { isIosNativeApp } from './utils/platform';

// Lazy-load all routes. On iOS WKWebView, loading all pages + their
// dependencies (heavy editors, recharts, etc.) at once pushes WebContent
// process over the memory limit → jetsam → full reload to /app (the
// "scroll jumps to dashboard" bug). Code splitting keeps each section's
// code in its own chunk, loaded only when navigated to.
const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const CRM = lazy(() => import('./pages/CRM'));
const Tasks = lazy(() => import('./pages/Tasks'));
const WorkspaceMembers = lazy(() => import('./pages/WorkspaceMembers'));
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const TermsOfService = lazy(() => import('./pages/TermsOfService'));
const Messages = lazy(() => import('./pages/Messages'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
const AdminPanel = lazy(() => import('./pages/AdminPanel'));
const AdminLogin = lazy(() => import('./pages/AdminLogin'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));

const RouteFallback = () => (
  <div style={{
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100vh', background: 'var(--bg-secondary, #f8fafc)',
    color: 'var(--text-secondary, #64748b)'
  }}>
    Načítavam…
  </div>
);

const typeToSection = (type) => {
  if (!type) return null;
  if (type.startsWith('contact.')) return 'crm';
  if (type.startsWith('task.') || type.startsWith('subtask.')) return 'tasks';
  if (type.startsWith('message.')) return 'messages';
  return null;
};

function AppContent() {
  const { isAuthenticated, loading } = useAuth();
  const { needsWorkspace, loading: workspaceLoading, currentWorkspaceId, switchWorkspace, workspaces } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const { socket, isConnected } = useSocket();

  // Navigate to a deep-link path, switching workspace first if the link
  // carries a `ws=` query param that differs from the active workspace.
  // Used by: iOS cold/hot start deep links, bell clicks, web push clicks.
  const navigateWithWorkspace = useCallback(async (rawPath) => {
    if (!rawPath) return;
    try {
      const full = new URL(rawPath, window.location.origin);
      const targetWs = full.searchParams.get('ws');
      // Strip `ws=` from the URL we navigate to — it was only a transport hint
      full.searchParams.delete('ws');
      const cleanPath = full.pathname + (full.searchParams.toString() ? '?' + full.searchParams.toString() : '');

      if (targetWs && targetWs !== (currentWorkspaceId?.toString?.() || currentWorkspaceId)) {
        // Membership check optimalizuje len UX case — keď klient vie že
        // nie som člen (workspace opustený), skipneme HTTP round-trip.
        // ALE: lokálny `workspaces` list môže byť stale (notifikácia prišla
        // pred fetchWorkspaces, alebo user bol práve pozvaný). V tom prípade
        // skúsime switch aj tak — server je source of truth, vráti 403 iba
        // keď naozaj nemám membership.
        const isMember = (workspaces || []).some(w => (w.id || w._id)?.toString() === targetWs);
        const listLikelyStale = !workspaces || workspaces.length === 0;

        if (isMember || listLikelyStale) {
          try {
            await switchWorkspace(targetWs);
          } catch {
            // Switch zlyhal → NEPRECHÁDZAME na cleanPath. Keby sme šli bez ws=,
            // `pendingWsSwitch` gate v AppContent by odomkol a user by skončil
            // v zlom workspace ("correct section, wrong workspace" bug).
            // ws= necháme v URL, gate drží "Načítavam..." kým sa switch retryne.
            return;
          }
        } else {
          // Nie som člen — fallthrough na plain navigate by spôsobil "wrong workspace"
          // bug lebo ws= by sa zmazalo a gate by odomkol. Ponechávame ws= v URL,
          // gate zostane, useLayoutEffect sa re-fires po ďalšom fetchWorkspaces.
          return;
        }
      }
      navigate(cleanPath, { replace: true });
    } catch {
      navigate(rawPath, { replace: true });
    }
  }, [navigate, currentWorkspaceId, switchWorkspace, workspaces]);

  const [unreadCounts, setUnreadCounts] = useState({ crm: 0, tasks: 0, messages: 0 });

  // Admin panel má vlastnú session cez AdminLogin + adminApi — s regulárnym
  // user účtom nemá nič spoločné. Keď je user prihlásený cez oba entry pointy
  // (regulárny AuthContext + admin session), bez tejto gating podmienky by
  // NotificationToast, PushPermissionBanner aj socket listener pokračovali
  // v behu nad regulárnou identitou aj na admin-route → admin by na /admin
  // videl popup notifikácie z úplne iného účtu. Ľahšie je zakázať notifikačnú
  // UI vrstvu pre celý `/admin*` namespace.
  const isAdminRoute = location.pathname.startsWith('/admin');

  const fetchUnreadCounts = useCallback(async () => {
    try {
      const res = await api.get('/api/notifications/unread-by-section');
      setUnreadCounts(res.data);
    } catch (err) { /* ignore */ }
  }, []);

  useEffect(() => {
    if (isAuthenticated && !isAdminRoute) fetchUnreadCounts();
  }, [isAuthenticated, isAdminRoute, fetchUnreadCounts]);

  // Periodic poll — mirrors NotificationBell's 30s interval so that BottomNav
  // section badges stay in sync with the bell. Previously section counts
  // only refreshed on the `notifications-updated` event; if an event was
  // dropped (iOS backgrounded WKWebView, socket reconnect, race) the
  // BottomNav badge drifted higher than the bell and never self-corrected.
  useEffect(() => {
    if (!isAuthenticated || isAdminRoute) return;
    const interval = setInterval(fetchUnreadCounts, 30000);
    return () => clearInterval(interval);
  }, [isAuthenticated, isAdminRoute, fetchUnreadCounts]);

  // Refresh section counts when any component marks notifications as read
  useEffect(() => {
    if (!isAuthenticated || isAdminRoute) return;
    const handler = () => fetchUnreadCounts();
    window.addEventListener('notifications-updated', handler);
    return () => window.removeEventListener('notifications-updated', handler);
  }, [isAuthenticated, isAdminRoute, fetchUnreadCounts]);

  useEffect(() => {
    if (!socket || !isConnected || !isAuthenticated || isAdminRoute) return;
    const handleNotification = (notification) => {
      const section = typeToSection(notification.type);
      if (section) {
        // Always increment — even when the user is currently viewing the
        // section. Being on a list page is not the same as reading a
        // specific item. Individual notifications are marked read only when
        // the user opens that item (task/contact/message expand) or clicks
        // the notification in the bell — never implicitly by section entry.
        setUnreadCounts(prev => ({ ...prev, [section]: prev[section] + 1 }));
      }
    };
    socket.on('notification', handleNotification);
    return () => socket.off('notification', handleNotification);
  }, [socket, isConnected, isAuthenticated, isAdminRoute]);

  // NOTE: previously we auto-marked every notification in a section as read
  // the moment the user tapped that section in the bottom nav — that's a lie
  // about what the user has actually seen, so it's been removed. Mark-as-read
  // now happens only when the user opens a specific item (see the useEffects
  // on expandedTask / expandedContact / selectedMessage in the page
  // components) or taps a notification in the bell dropdown.

  useEffect(() => {
    // initializePush na `/admin*` nepúšťame — admin login neznamená že má
    // user aj regulárny push subscription, a keby sme ho teraz zaregistrovali,
    // admin by začal dostávať system notifikácie z pôvodného user účtu.
    if (isAuthenticated && !isAdminRoute) {
      initializePush().catch(() => {});
    }
  }, [isAuthenticated, isAdminRoute]);

  // Modal scroll-lock: prevent body scroll behind open modals (iOS-safe).
  // Uses a local `isLocked` flag (not the body class) as source of truth, so
  // class desync can never trigger a stray window.scrollTo. Throttles via rAF
  // so scroll-driven mutations (sticky headers, list virtualization, socket
  // updates) don't hammer the callback. The scroll-restore is guarded by
  // savedScrollY > 0, so a transient .modal-overlay opening at scroll=0 can
  // never snap a deeply-scrolled page back to top — which was the root cause
  // of the iOS "scroll-down jumps to dashboard" bug.
  useEffect(() => {
    let isLocked = false;
    let savedScrollY = 0;
    let scheduledCheck = null;

    const checkAndUpdate = () => {
      const hasModal = !!document.querySelector('.modal-overlay');
      if (hasModal && !isLocked) {
        isLocked = true;
        savedScrollY = window.scrollY;
        document.body.classList.add('modal-open');
        document.body.style.top = `-${savedScrollY}px`;
      } else if (!hasModal && isLocked) {
        isLocked = false;
        document.body.classList.remove('modal-open');
        document.body.style.top = '';
        if (savedScrollY > 0) {
          window.scrollTo(0, savedScrollY);
        }
      }
    };

    const observer = new MutationObserver(() => {
      if (scheduledCheck !== null) return;
      scheduledCheck = requestAnimationFrame(() => {
        scheduledCheck = null;
        checkAndUpdate();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (scheduledCheck !== null) cancelAnimationFrame(scheduledCheck);
    };
  }, []);

  // Deep-link priamo z URL (iOS APNs tap — cold aj hot start). Ak URL má `ws=`
  // odlišný od aktívneho, prepneme workspace ešte pred tým ako child stránky
  // fetchnú dáta. useLayoutEffect aby bežal PRED child page effectmi (tie
  // strippujú URL parametre).
  // Idempotentné: navigateWithWorkspace prepne iba ak targetWs !== current,
  // a následne strippne ws=, takže effect sa re-fired presne raz per deep-link.
  useLayoutEffect(() => {
    if (!isAuthenticated || workspaceLoading) return;
    const params = new URLSearchParams(location.search);
    if (!params.get('ws')) return;
    navigateWithWorkspace(location.pathname + location.search);
  }, [isAuthenticated, workspaceLoading, location.pathname, location.search, navigateWithWorkspace]);

  // Save deep link to sessionStorage before auth redirect loses it.
  // Must NOT require !loading — during cold start loading=true and the URL
  // params would be lost by the time loading finishes.
  useEffect(() => {
    if (!isAuthenticated) {
      const params = new URLSearchParams(location.search);
      if ((location.pathname === '/crm' && params.get('expandContact')) ||
          (location.pathname === '/tasks' && params.get('highlightTask')) ||
          (location.pathname === '/messages' && params.get('highlight'))) {
        sessionStorage.setItem('pendingDeepLink', location.pathname + location.search);
      }
    }
  }, [location.pathname, location.search, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;

    // Check immediately
    const checkAndNavigate = () => {
      const pendingLink = sessionStorage.getItem('pendingDeepLink');
      if (pendingLink) {
        sessionStorage.removeItem('pendingDeepLink');
        const sep = pendingLink.includes('?') ? '&' : '?';
        // navigateWithWorkspace handles workspace switch if link has ws=
        navigateWithWorkspace(pendingLink + sep + '_t=' + Date.now());
        return true;
      }
      return false;
    };

    if (checkAndNavigate()) return;

    // Retry a few times — on iOS cold start, the Swift JS that sets
    // sessionStorage may fire AFTER this effect runs (race condition).
    // Polling for 3 seconds covers the deferred deep link path.
    let attempts = 0;
    const maxAttempts = 6;
    const interval = setInterval(() => {
      attempts++;
      if (checkAndNavigate() || attempts >= maxAttempts) {
        clearInterval(interval);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [isAuthenticated, navigateWithWorkspace]);

  useEffect(() => {
    if (!isAuthenticated) return;

    let lastHidden = 0;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        lastHidden = Date.now();
      } else {
        const hiddenFor = Date.now() - lastHidden;
        if (lastHidden > 0 && hiddenFor > 3000) {
          window.dispatchEvent(new CustomEvent('app-resumed', {
            detail: { timestamp: Date.now(), hiddenFor }
          }));
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const handleServiceWorkerMessage = (event) => {
      if (event.data?.type === 'NOTIFICATION_CLICK') {
        const { url, data, timestamp } = event.data;

        try {
          const urlObj = new URL(url);
          const path = urlObj.pathname;
          const params = new URLSearchParams(urlObj.search);
          const navTs = (timestamp || Date.now()).toString();
          const ws = params.get('ws') || data?.workspaceId;
          const wsSuffix = ws ? `&ws=${ws}` : '';

          if (path === '/crm' && (params.get('expandContact') || data?.contactId)) {
            const contactId = params.get('expandContact') || data.contactId;
            navigateWithWorkspace(`/crm?expandContact=${contactId}&_t=${navTs}${wsSuffix}`);
          } else if (path === '/tasks' && (params.get('highlightTask') || data?.taskId)) {
            const taskId = params.get('highlightTask') || data.taskId;
            const subtaskId = params.get('subtask') || data.subtaskId || null;
            let taskUrl = `/tasks?highlightTask=${taskId}&_t=${navTs}`;
            if (subtaskId) taskUrl += `&subtask=${subtaskId}`;
            navigateWithWorkspace(taskUrl + wsSuffix);
          } else if (path === '/messages' && (params.get('highlight') || data?.messageId)) {
            const messageId = params.get('highlight') || data.messageId;
            const commentId = params.get('comment') || data?.commentId;
            let msgUrl = `/messages?highlight=${messageId}&_t=${navTs}`;
            if (commentId) msgUrl += `&comment=${commentId}`;
            navigateWithWorkspace(msgUrl + wsSuffix);
          } else {
            navigateWithWorkspace(path + (urlObj.search || ''));
          }
        } catch {
          if (url.startsWith('/')) navigateWithWorkspace(url);
        }
      }
    };

    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [isAuthenticated, navigateWithWorkspace]);

  const publicPages = ['/', '/login', '/forgot-password', '/reset-password', '/ochrana-udajov', '/vop', '/invite', '/admin'];
  const isPublicPage = publicPages.some(p => location.pathname === p || location.pathname.startsWith('/invite/'));

  // Blok renderu child route kým sa deep-link workspace switch nedokončí.
  // Inak Tasks/CRM/Messages mountnú so starým workspacom a fetchnú dáta
  // proti nemu (wrong data). Blok je len pre authenticated routes.
  const urlParams = new URLSearchParams(location.search);
  const urlWs = urlParams.get('ws');
  const pendingWsSwitch = !!urlWs && !!currentWorkspaceId &&
    urlWs !== (currentWorkspaceId?.toString?.() || currentWorkspaceId);

  if (!isPublicPage && (loading || (isAuthenticated && workspaceLoading) || (isAuthenticated && pendingWsSwitch))) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--bg-secondary, #f8fafc)',
        color: 'var(--text-secondary, #64748b)'
      }}>
        Načítavam...
      </div>
    );
  }

  if (isAuthenticated && needsWorkspace) {
    return <WorkspaceSetup />;
  }

  return (
    <>
      {/* In iOS native app, APNs system banners already show notifications —
          mounting NotificationToast would duplicate every notification.
          Web/Android (no APNs) still get the in-app toast.
          Na `/admin*` toast nikdy — admin má vlastnú session a notifikácie
          z regulárneho AuthContextu tam nepatria. */}
      {isAuthenticated && !isIosNativeApp() && !isAdminRoute && <NotificationToast />}
      {/* Android/PWA first-run push permission banner. Skip v iOS native app —
          APNs tam rieši permission cez systémovú Swift vrstvu (UNUserNotificationCenter).
          Na `/admin*` banner tiež nie — viď komentár pri NotificationToast. */}
      {isAuthenticated && !isIosNativeApp() && !isAdminRoute && <PushPermissionBanner />}
      {/* BottomNav je user-app navigácia — admin panel má vlastný tab-bar, takže
          na `/admin*` by bol BottomNav vizuálne rušivý aj zavádzajúci. */}
      {isAuthenticated && !isAdminRoute && <BottomNav unreadCounts={unreadCounts} />}
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/app" /> : <Login />}
        />
        <Route
          path="/forgot-password"
          element={isAuthenticated ? <Navigate to="/app" /> : <ForgotPassword />}
        />
        <Route
          path="/reset-password"
          element={<ResetPassword />}
        />
        <Route
          path="/app"
          element={isAuthenticated ? <Dashboard /> : <Navigate to="/login" />}
        />
        <Route
          path="/crm"
          element={isAuthenticated ? <CRM /> : <Navigate to="/login" />}
        />
        <Route
          path="/tasks"
          element={isAuthenticated ? <Tasks /> : <Navigate to="/login" />}
        />
        <Route
          path="/workspace/members"
          element={isAuthenticated ? <WorkspaceMembers /> : <Navigate to="/login" />}
        />
        <Route
          path="/messages"
          element={isAuthenticated ? <Messages /> : <Navigate to="/login" />}
        />
        <Route
          path="/app/billing"
          element={isAuthenticated ? <BillingPage /> : <Navigate to="/login" />}
        />
        <Route path="/admin" element={<AdminLogin />} />
        <Route path="/admin/dashboard" element={<AdminPanel />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/ochrana-udajov" element={<PrivacyPolicy />} />
        <Route path="/vop" element={<TermsOfService />} />
      </Routes>
      </Suspense>
    </>
  );
}

function App() {
  return (
    <WorkspaceProvider>
      <AppContent />
    </WorkspaceProvider>
  );
}

export default App;
