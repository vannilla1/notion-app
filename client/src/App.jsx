import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CRM from './pages/CRM';
import Tasks from './pages/Tasks';

function App() {
  const { isAuthenticated, loading } = useAuth();

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
    </Routes>
  );
}

export default App;
