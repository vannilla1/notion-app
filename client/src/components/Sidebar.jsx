import { NavLink } from 'react-router-dom';

function Sidebar({ user, pages, onCreatePage, onDeletePage, onLogout, loading }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-user">
          <div
            className="user-avatar"
            style={{ backgroundColor: user?.color || '#3B82F6' }}
          >
            {user?.username?.[0]?.toUpperCase() || 'U'}
          </div>
          <span style={{ fontWeight: 500, fontSize: '14px' }}>
            {user?.username}'s Workspace
          </span>
        </div>
        <button className="logout-btn" onClick={onLogout} title="Logout">
          ↪
        </button>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-title">Pages</div>

          {loading ? (
            <div style={{ padding: '8px', color: 'var(--text-muted)', fontSize: '14px' }}>
              Loading...
            </div>
          ) : pages.length === 0 ? (
            <div style={{ padding: '8px', color: 'var(--text-muted)', fontSize: '14px' }}>
              No pages yet
            </div>
          ) : (
            pages.map((page) => (
              <NavLink
                key={page.id}
                to={`/page/${page.id}`}
                className={({ isActive }) =>
                  `nav-item ${isActive ? 'active' : ''}`
                }
              >
                <span className="nav-item-icon">{page.icon || '📄'}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {page.title || 'Untitled'}
                </span>
                {page.ownerId === user?.id && (
                  <button
                    className="delete-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (window.confirm('Delete this page?')) {
                        onDeletePage(page.id);
                      }
                    }}
                  >
                    ×
                  </button>
                )}
              </NavLink>
            ))
          )}

          <button className="add-page-btn" onClick={onCreatePage}>
            <span>+</span>
            <span>Add a page</span>
          </button>
        </div>
      </nav>
    </aside>
  );
}

export default Sidebar;
