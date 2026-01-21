import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
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

  // Initialize push notifications when user is authenticated
  useEffect(() => {
    if (isAuthenticated) {
      initializePush().catch(err => {
        console.log('Push notifications not initialized:', err.message);
      });
    }
  }, [isAuthenticated]);

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
