import { useEffect } from 'react';
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
import WorkspaceSetup from './components/WorkspaceSetup';
import { initializePush } from './services/pushNotifications';

function AppContent() {
  const { isAuthenticated, loading } = useAuth();
  const { needsWorkspace, loading: workspaceLoading } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();

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

  // Handle URL query params for deep linking from push notifications
  // Store pending navigation while not authenticated
  useEffect(() => {
    const params = new URLSearchParams(location.search);

    // Get the timestamp param (used to force re-navigation)
    const navTimestamp = params.get('_t');

    // If we have deep link params but not authenticated, store them for later
    if (!isAuthenticated && !loading) {
      if ((location.pathname === '/crm' && params.get('expandContact')) ||
          (location.pathname === '/tasks' && params.get('highlightTask')) ||
          (location.pathname === '/messages' && params.get('highlight'))) {
        sessionStorage.setItem('pendingDeepLink', location.pathname + location.search);
      }
      return;
    }

    if (!isAuthenticated) return;

    // Check for pending deep link from before login
    const pendingLink = sessionStorage.getItem('pendingDeepLink');
    if (pendingLink) {
      sessionStorage.removeItem('pendingDeepLink');
      const pendingUrl = new URL(pendingLink, window.location.origin);
      const pendingParams = new URLSearchParams(pendingUrl.search);

      if (pendingUrl.pathname === '/crm' && pendingParams.get('expandContact')) {
        navigate('/crm', {
          state: {
            expandContactId: pendingParams.get('expandContact'),
            navTimestamp: Date.now()
          },
          replace: true
        });
        return;
      }
      if (pendingUrl.pathname === '/tasks' && pendingParams.get('highlightTask')) {
        navigate('/tasks', {
          state: {
            highlightTaskId: pendingParams.get('highlightTask'),
            highlightSubtaskId: pendingParams.get('subtask') || null,
            navTimestamp: Date.now()
          },
          replace: true
        });
        return;
      }
      if (pendingUrl.pathname === '/messages' && pendingParams.get('highlight')) {
        navigate('/messages?highlight=' + pendingParams.get('highlight') + '&_t=' + Date.now(), { replace: true });
        return;
      }
    }

    // Handle CRM contact expansion
    if (location.pathname === '/crm' && params.get('expandContact')) {
      const contactId = params.get('expandContact');
      // Navigate with state and clear the query param
      navigate('/crm', {
        state: {
          expandContactId: contactId,
          navTimestamp: navTimestamp || Date.now()
        },
        replace: true
      });
    }

    // Handle task highlighting
    if (location.pathname === '/tasks' && params.get('highlightTask')) {
      const taskId = params.get('highlightTask');
      const subtaskId = params.get('subtask');
      // Navigate with state and clear the query param
      navigate('/tasks', {
        state: {
          highlightTaskId: taskId,
          highlightSubtaskId: subtaskId || null,
          navTimestamp: navTimestamp || Date.now()
        },
        replace: true
      });
    }
  }, [location, isAuthenticated, loading, navigate]);

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
          console.log('[App] Resuming from background, refreshing data...');
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

        // Parse URL to extract path and params
        try {
          const urlObj = new URL(url);
          const path = urlObj.pathname;
          const params = new URLSearchParams(urlObj.search);

          const navTimestamp = timestamp || Date.now();

          // Dispatch custom event that pages can listen to
          // This works even when we're already on the target page
          if (path === '/crm' && (params.get('expandContact') || data?.contactId)) {
            const contactId = params.get('expandContact') || data.contactId;
            window.dispatchEvent(new CustomEvent('crm-highlight', {
              detail: { contactId, timestamp: navTimestamp }
            }));
            // Also navigate in case we're on a different page
            if (location.pathname !== '/crm') {
              navigate('/crm', {
                state: { expandContactId: contactId, navTimestamp }
              });
            }
          } else if (path === '/tasks' && (params.get('highlightTask') || data?.taskId)) {
            const taskId = params.get('highlightTask') || data.taskId;
            const subtaskId = params.get('subtask') || data.subtaskId || null;
            window.dispatchEvent(new CustomEvent('task-highlight', {
              detail: { taskId, subtaskId, timestamp: navTimestamp }
            }));
            // Also navigate in case we're on a different page
            if (location.pathname !== '/tasks') {
              navigate('/tasks', {
                state: { highlightTaskId: taskId, highlightSubtaskId: subtaskId, navTimestamp }
              });
            }
          } else if (path === '/messages' && (params.get('highlight') || data?.messageId)) {
            const messageId = params.get('highlight') || data.messageId;
            window.dispatchEvent(new CustomEvent('message-highlight', {
              detail: { messageId, timestamp: navTimestamp }
            }));
            if (location.pathname !== '/messages') {
              navigate('/messages?highlight=' + messageId + '&_t=' + navTimestamp);
            }
          } else {
            // Fallback: navigate to the path with query params preserved
            navigate(path + (urlObj.search || ''));
          }
        } catch (e) {
          console.error('[App] Error parsing notification URL:', e);
          if (url.startsWith('/')) {
            navigate(url);
          }
        }
      }
    };

    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [isAuthenticated, navigate, location.pathname]);

  if (loading || (isAuthenticated && workspaceLoading)) {
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
      {isAuthenticated && <BottomNav />}
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
        <Route path="/privacy" element={<PrivacyPolicy />} />
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
