import { useNavigate, useLocation } from 'react-router-dom';

const tabs = [
  { path: '/app', icon: '📊', label: 'Prehľad' },
  { path: '/crm', icon: '👥', label: 'Kontakty' },
  { path: '/tasks', icon: '📋', label: 'Projekty' },
  { path: '/messages', icon: '✉️', label: 'Správy' },
];

function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="bottom-nav">
      {tabs.map(tab => (
        <button
          key={tab.path}
          className={`bottom-nav-tab ${location.pathname === tab.path ? 'active' : ''}`}
          onClick={() => navigate(tab.path)}
        >
          <span className="bottom-nav-icon">{tab.icon}</span>
          <span className="bottom-nav-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

export default BottomNav;
