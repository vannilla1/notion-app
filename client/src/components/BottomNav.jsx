import { useNavigate, useLocation } from 'react-router-dom';

const icons = {
  dashboard: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  contacts: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  projects: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  messages: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  ),
};

const tabs = [
  { path: '/app', icon: icons.dashboard, label: 'Prehľad', section: null },
  { path: '/crm', icon: icons.contacts, label: 'Kontakty', section: 'crm' },
  { path: '/tasks', icon: icons.projects, label: 'Projekty', section: 'tasks' },
  { path: '/messages', icon: icons.messages, label: 'Správy', section: 'messages' },
];

function BottomNav({ unreadCounts = {} }) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="bottom-nav">
      {tabs.map(tab => {
        const count = tab.section ? (unreadCounts[tab.section] || 0) : 0;
        return (
          <button
            key={tab.path}
            className={`bottom-nav-tab ${location.pathname === tab.path ? 'active' : ''}`}
            onClick={() => navigate(tab.path)}
          >
            <span className="bottom-nav-icon" style={{ position: 'relative' }}>
              {tab.icon}
              {count > 0 && (
                <span style={{
                  position: 'absolute', top: '-6px', right: '-10px',
                  background: '#EF4444', color: 'white', fontSize: '10px',
                  fontWeight: 700, minWidth: '16px', height: '16px',
                  borderRadius: '8px', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', padding: '0 4px', lineHeight: 1
                }}>
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </span>
            <span className="bottom-nav-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default BottomNav;
