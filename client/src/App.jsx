import { useEffect, useState, useCallback, useRef } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { WorkspaceProvider, useWorkspace } from './context/WorkspaceContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CRM from './pages/CRM';
import Tasks from './pages/Tasks';
import WorkspaceMembers from './pages/WorkspaceMembers';
import AcceptInvite from './pages/AcceptInvite';
import PrivacyPolicy from './pages/PrivacyPolicy';
import TermsOfService from './pages/TermsOfService';
import Messages from './pages/Messages';
import BillingPage from './pages/BillingPage';
import LandingPage from './pages/LandingPage';
import AdminPanel from './pages/AdminPanel';
import AdminLogin from './pages/AdminLogin';
import NotificationToast from './components/NotificationToast';
import BottomNav from './components/BottomNav';
import api from './api/api';
import { useSocket } from './hooks/useSocket';
import WorkspaceSetup from './components/WorkspaceSetup';
import { initializePush } from './services/pushNotifications';

const typeToSection = (type) => {
  if (!type) return null;
  if (type.startsWith('contact.')) return 'crm';
  if (type.startsWith('task.') || type.startsWith('subtask.')) return 'tasks';
  if (type.startsWith('message.')) return 'messages';
  return null;
};

const pathToSection = (path) => {
  if (path === '/crm') return 'crm';
  if (path === '/tasks') return 'tasks';
  if (path === '/messages') return 'messages';
  return null;
};

function AppContent() {
  const { isAuthenticated, loading } = useAuth();
  const { needsWorkspace, loading: workspaceLoading } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const { socket, isConnected } = useSocket();

  const [unreadCounts, setUnreadCounts] = useState({ crm: 0, tasks: 0, messages: 0 });
  const prevPathRef = useRef(location.pathname);

  // DIAGNOSTIC: iOS scroll→dashboard bug. Patch history methods to capture
  // stack trace of EVERY navigation, and show it on-screen so the user can
  // report exactly what triggers the jump. Remove once root cause found.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.__navDiagInstalled) return;
    window.__navDiagInstalled = true;

    // Track page loads via sessionStorage counter — survives full reloads
    const loadCount = parseInt(sessionStorage.getItem('nav_diag_loads') || '0', 10) + 1;
    sessionStorage.setItem('nav_diag_loads', String(loadCount));
    const lastUnload = sessionStorage.getItem('nav_diag_last_unload');
    const lastPath = sessionStorage.getItem('nav_diag_last_path') || '(none)';

    const showOverlay = (title, detail) => {
      try {
        let el = document.getElementById('nav-diag-overlay');
        if (!el) {
          el = document.createElement('div');
          el.id = 'nav-diag-overlay';
          el.style.cssText = 'position:fixed;top:8px;left:8px;right:8px;z-index:99999;background:rgba(220,38,38,0.95);color:#fff;font:11px/1.3 monospace;padding:8px;border-radius:6px;max-height:50vh;overflow:auto;white-space:pre-wrap;word-break:break-all;';
          el.addEventListener('click', () => el.remove());
          document.body.appendChild(el);
        }
        el.textContent = `[${new Date().toISOString().slice(11,19)}] ${title}\n${detail}\n\n(tap to dismiss)`;
      } catch {}
    };

    const log = (kind, arg) => {
      const stack = new Error().stack || '';
      const from = window.location.pathname + window.location.search;
      const to = typeof arg === 'string' ? arg : (arg?.pathname || JSON.stringify(arg));
      // eslint-disable-next-line no-console
      console.warn('[NAV-DIAG]', kind, 'from=', from, 'to=', to, '\n', stack);
      if (String(to).includes('/app') && !from.startsWith('/app')) {
        showOverlay(`${kind} → ${to}`, `from: ${from}\n\n${stack.split('\n').slice(1, 8).join('\n')}`);
      }
    };

    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;
    window.history.pushState = function (...args) {
      log('pushState', args[2]);
      return origPush.apply(this, args);
    };
    window.history.replaceState = function (...args) {
      log('replaceState', args[2]);
      return origReplace.apply(this, args);
    };
    const onPop = (e) => log('popstate', window.location.pathname);
    window.addEventListener('popstate', onPop);

    // Catch full-page reloads
    const onBeforeUnload = () => {
      sessionStorage.setItem('nav_diag_last_unload', new Date().toISOString());
      sessionStorage.setItem('nav_diag_last_path', window.location.pathname + window.location.search);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onBeforeUnload);

    // Always show overlay with load count — so user sees if page reloads
    showOverlay(
      `LOAD #${loadCount} @ ${window.location.pathname}`,
      `last unload: ${lastUnload || '(none)'}\nlast path: ${lastPath}\n` +
      `iosNative: ${!!window.__iosNative}  SW-ctrl: ${!!window.__iosSwController}\n` +
      `SW-regs: ${window.__iosSwRegCount ?? '?'}  cleaned: ${!!window.__iosSwCleaned}\n` +
      `controller-now: ${!!(navigator.serviceWorker && navigator.serviceWorker.controller)}\n` +
      `ua: ${navigator.userAgent.slice(0, 60)}`
    );

    // Detect component/route remount on scroll
    let scrollCount = 0;
    const onAnyScroll = () => {
      scrollCount++;
      if (scrollCount === 1 || scrollCount % 20 === 0) {
        // eslint-disable-next-line no-console
        console.warn('[NAV-DIAG] scroll #', scrollCount, 'path=', window.location.pathname);
      }
    };
    window.addEventListener('scroll', onAnyScroll, true);

    // Log pageshow (fires on bfcache restore / reload)
    const onPageShow = (e) => {
      showOverlay(`pageshow persisted=${e.persisted} load=#${loadCount}`, `path=${window.location.pathname}`);
    };
    window.addEventListener('pageshow', onPageShow);

    // Also log scroll resets on main scroll container
    const onScroll = (e) => {
      const t = e.target;
      if (t && t.scrollTop === 0 && t.__prevScrollTop > 50) {
        // eslint-disable-next-line no-console
        console.warn('[NAV-DIAG] scrollTop reset from', t.__prevScrollTop, 'on', t.className);
      }
      if (t) t.__prevScrollTop = t.scrollTop;
    };
    document.addEventListener('scroll', onScroll, true);

    return () => {
      window.history.pushState = origPush;
      window.history.replaceState = origReplace;
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onBeforeUnload);
      window.removeEventListener('scroll', onAnyScroll, true);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('scroll', onScroll, true);
      window.__navDiagInstalled = false;
    };
  }, []);

  const fetchUnreadCounts = useCallback(async () => {
    try {
      const res = await api.get('/api/notifications/unread-by-section');
      setUnreadCounts(res.data);
    } catch (err) { /* ignore */ }
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchUnreadCounts();
  }, [isAuthenticated, fetchUnreadCounts]);

  useEffect(() => {
    if (!socket || !isConnected || !isAuthenticated) return;
    const handleNotification = (notification) => {
      const section = typeToSection(notification.type);
      if (section) {
        // Don't increment if user is already viewing that section
        const currentSection = pathToSection(location.pathname);
        if (currentSection !== section) {
          setUnreadCounts(prev => ({ ...prev, [section]: prev[section] + 1 }));
        }
      }
    };
    socket.on('notification', handleNotification);
    return () => socket.off('notification', handleNotification);
  }, [socket, isConnected, isAuthenticated, location.pathname]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const section = pathToSection(location.pathname);
    const prevSection = pathToSection(prevPathRef.current);
    prevPathRef.current = location.pathname;

    if (section && section !== prevSection && unreadCounts[section] > 0) {
      setUnreadCounts(prev => ({ ...prev, [section]: 0 }));
      api.put(`/api/notifications/read-by-section/${section}`).catch(() => {});
    }
  }, [location.pathname, isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      initializePush().catch(() => {});
    }
  }, [isAuthenticated]);

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
        navigate(pendingLink + sep + '_t=' + Date.now(), { replace: true });
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
  }, [isAuthenticated, navigate]);

  // iOS hot-start deep link: Swift injects JS that dispatches this event
  // instead of window.location.href (which would cause a full page reload).
  // If authenticated, navigate immediately via React Router.
  // If not yet authenticated, sessionStorage backup is already set by the
  // Swift JS — Effect B above will pick it up after auth resolves.
  useEffect(() => {
    const handler = (e) => {
      const path = e.detail;
      if (path && isAuthenticated) {
        sessionStorage.removeItem('pendingDeepLink');
        navigate(path, { replace: true });
      }
    };
    window.addEventListener('iosDeepLink', handler);
    return () => window.removeEventListener('iosDeepLink', handler);
  }, [navigate, isAuthenticated]);

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

          if (path === '/crm' && (params.get('expandContact') || data?.contactId)) {
            const contactId = params.get('expandContact') || data.contactId;
            navigate(`/crm?expandContact=${contactId}&_t=${navTs}`);
          } else if (path === '/tasks' && (params.get('highlightTask') || data?.taskId)) {
            const taskId = params.get('highlightTask') || data.taskId;
            const subtaskId = params.get('subtask') || data.subtaskId || null;
            let taskUrl = `/tasks?highlightTask=${taskId}&_t=${navTs}`;
            if (subtaskId) taskUrl += `&subtask=${subtaskId}`;
            navigate(taskUrl);
          } else if (path === '/messages' && (params.get('highlight') || data?.messageId)) {
            const messageId = params.get('highlight') || data.messageId;
            navigate(`/messages?highlight=${messageId}&_t=${navTs}`);
          } else {
            navigate(path + (urlObj.search || ''));
          }
        } catch {
          if (url.startsWith('/')) navigate(url);
        }
      }
    };

    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [isAuthenticated, navigate]);

  const publicPages = ['/', '/login', '/ochrana-udajov', '/vop', '/invite', '/admin'];
  const isPublicPage = publicPages.some(p => location.pathname === p || location.pathname.startsWith('/invite/'));

  if (!isPublicPage && (loading || (isAuthenticated && workspaceLoading))) {
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
      {isAuthenticated && <NotificationToast />}
      {isAuthenticated && <BottomNav unreadCounts={unreadCounts} />}
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/app" /> : <Login />}
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
