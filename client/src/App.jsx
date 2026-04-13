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

  useEffect(() => {
    let scrollY = 0;
    const observer = new MutationObserver(() => {
      const hasModal = document.querySelector('.modal-overlay');
      if (hasModal && !document.body.classList.contains('modal-open')) {
        scrollY = window.scrollY;
        document.body.classList.add('modal-open');
        document.body.style.top = `-${scrollY}px`;
      } else if (!hasModal && document.body.classList.contains('modal-open')) {
        document.body.classList.remove('modal-open');
        document.body.style.top = '';
        window.scrollTo(0, scrollY);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
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
