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

// Map notification type prefix to section key
const typeToSection = (type) => {
  if (!type) return null;
  if (type.startsWith('contact.')) return 'crm';
  if (type.startsWith('task.') || type.startsWith('subtask.')) return 'tasks';
  if (type.startsWith('message.')) return 'messages';
  return null;
};

// Map route path to section key
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

  // Unread notification counts per section
  const [unreadCounts, setUnreadCounts] = useState({ crm: 0, tasks: 0, messages: 0 });
  const prevPathRef = useRef(location.pathname);

  const fetchUnreadCounts = useCallback(async () => {
    try {
      const res = await api.get('/api/notifications/unread-by-section');
      setUnreadCounts(res.data);
    } catch (err) { /* ignore */ }
  }, []);

  // Fetch unread counts on auth
  useEffect(() => {
    if (isAuthenticated) fetchUnreadCounts();
  }, [isAuthenticated, fetchUnreadCounts]);

  // Increment count on new notification via socket
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

  // Mark section as read when navigating to it
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

  // Initialize push notifications when user is authenticated
  useEffect(() => {
    if (isAuthenticated) {
      initializePush().catch(() => {});
    }
  }, [isAuthenticated]);

  // Block background scroll when any modal is open (fixes iOS scroll-through)
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

  // Deep link handling for push notifications
  // Each page (CRM, Tasks, Messages) handles its own URL params via location.search useEffects.
  // App.jsx only handles: (1) storing deep links when not authenticated, (2) restoring them after login.
  useEffect(() => {
    // Store deep link if user lands on a deep link URL but isn't authenticated yet
    if (!isAuthenticated && !loading) {
      const params = new URLSearchParams(location.search);
      if ((location.pathname === '/crm' && params.get('expandContact')) ||
          (location.pathname === '/tasks' && params.get('highlightTask')) ||
          (location.pathname === '/messages' && params.get('highlight'))) {
        sessionStorage.setItem('pendingDeepLink', location.pathname + location.search);
      }
    }
  }, [location.pathname, location.search, isAuthenticated, loading]);

  // Restore pending deep link after login
  useEffect(() => {
    if (!isAuthenticated) return;
    const pendingLink = sessionStorage.getItem('pendingDeepLink');
    if (pendingLink) {
      sessionStorage.removeItem('pendingDeepLink');
      // Navigate using URL params — target pages handle the rest
      const sep = pendingLink.includes('?') ? '&' : '?';
      navigate(pendingLink + sep + '_t=' + Date.now(), { replace: true });
    }
  }, [isAuthenticated, navigate]);

  // Refresh data when app returns from background (iOS / tab switch)
  useEffect(() => {
    if (!isAuthenticated) return;

    let lastHidden = 0;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        lastHidden = Date.now();
      } else {
        // Only refresh if was hidden for at least 3 seconds
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

  // Listen for messages from service worker (push notification clicks)
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

          // ALWAYS navigate via URL with _t param — this triggers useEffect in target page
          // The _t param forces React Router to treat it as a new navigation even on same page
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
        } catch (e) {
          console.error('[App] Error parsing notification URL:', e);
          if (url.startsWith('/')) navigate(url);
        }
      }
    };

    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [isAuthenticated, navigate]);

  // Public pages render immediately without waiting for auth/workspace
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

  // Show workspace setup if authenticated but needs workspace
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

// Wrap with WorkspaceProvider
function App() {
  return (
    <WorkspaceProvider>
      <AppContent />
    </WorkspaceProvider>
  );
}

export default App;
