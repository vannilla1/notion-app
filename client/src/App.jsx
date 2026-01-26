import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CRM from './pages/CRM';
import Tasks from './pages/Tasks';
import AdminPanel from './pages/AdminPanel';
import NotificationToast from './components/NotificationToast';
import { initializePush } from './services/pushNotifications';

function App() {
  const { isAuthenticated, loading } = useAuth();
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
          state: { expandContactId: pendingParams.get('expandContact') },
          replace: true
        });
        return;
      }
      if (pendingUrl.pathname === '/tasks' && pendingParams.get('highlightTask')) {
        navigate('/tasks', {
          state: {
            highlightTaskId: pendingParams.get('highlightTask'),
            highlightSubtaskId: pendingParams.get('subtask') || null
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
        state: { expandContactId: contactId },
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
          highlightSubtaskId: subtaskId || null
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
        const { url, data } = event.data;

        // Parse URL to extract path and params
        try {
          const urlObj = new URL(url);
          const path = urlObj.pathname;
          const params = new URLSearchParams(urlObj.search);

          // Navigate based on notification data
          if (path === '/crm' && (params.get('expandContact') || data?.contactId)) {
            navigate('/crm', {
              state: { expandContactId: params.get('expandContact') || data.contactId }
            });
          } else if (path === '/tasks' && (params.get('highlightTask') || data?.taskId)) {
            navigate('/tasks', {
              state: {
                highlightTaskId: params.get('highlightTask') || data.taskId,
                highlightSubtaskId: params.get('subtask') || data.subtaskId || null
              }
            });
          } else {
            // Fallback: navigate to the path
            navigate(path);
          }
        } catch (e) {
          console.error('[App] Error parsing notification URL:', e);
          // Fallback: try to navigate directly
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
  }, [isAuthenticated, navigate]);

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh'
      }}>
        Nacitavam...
      </div>
    );
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

export default App;
