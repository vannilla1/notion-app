import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { WorkspaceProvider, useWorkspace } from './context/WorkspaceContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CRM from './pages/CRM';
import Tasks from './pages/Tasks';
import AdminPanel from './pages/AdminPanel';
import NotificationToast from './components/NotificationToast';
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
      initializePush().catch(err => {
        console.log('Push notifications not initialized:', err.message);
      });
    }
  }, [isAuthenticated]);

  // Handle URL query params for deep linking from push notifications
  // Store pending navigation while not authenticated
  useEffect(() => {
    const params = new URLSearchParams(location.search);

    // Get the timestamp param (used to force re-navigation)
    const navTimestamp = params.get('_t');

    // If we have deep link params but not authenticated, store them for later
    if (!isAuthenticated && !loading) {
      if ((location.pathname === '/crm' && params.get('expandContact')) ||
          (location.pathname === '/tasks' && params.get('highlightTask'))) {
        // Store the full URL for after login
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

  // Listen for messages from service worker (push notification clicks)
  useEffect(() => {
    if (!isAuthenticated) return;

    const handleServiceWorkerMessage = (event) => {
      console.log('[App] Message from service worker:', event.data);

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
            console.log('[App] Dispatching crm-highlight event for contact:', contactId);
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
            console.log('[App] Dispatching task-highlight event for task:', taskId);
            window.dispatchEvent(new CustomEvent('task-highlight', {
              detail: { taskId, subtaskId, timestamp: navTimestamp }
            }));
            // Also navigate in case we're on a different page
            if (location.pathname !== '/tasks') {
              navigate('/tasks', {
                state: { highlightTaskId: taskId, highlightSubtaskId: subtaskId, navTimestamp }
              });
            }
          } else {
            // Fallback: navigate to the path
            navigate(path);
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
        background: '#0c0c10',
        color: '#9b96c4',
        fontFamily: "'DM Sans', sans-serif",
        fontSize: '14px',
        gap: '10px'
      }}>
        <div style={{
          width: '18px', height: '18px', borderRadius: '50%',
          border: '2px solid rgba(139, 92, 246, 0.2)',
          borderTopColor: '#8b5cf6',
          animation: 'spin 0.8s linear infinite'
        }}/>
        Načítavam...
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
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
      <Routes>
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/" /> : <Login />}
        />
        <Route
          path="/"
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
          path="/admin"
          element={isAuthenticated ? <AdminPanel /> : <Navigate to="/login" />}
        />
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
