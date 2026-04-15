import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../context/WorkspaceContext';
import api from '../api/api';

const HeaderLogo = ({ active, onClick }) => {
  const navigate = useNavigate();
  const { currentWorkspace } = useWorkspace();
  const [otherUnreadTotal, setOtherUnreadTotal] = useState(0);

  // Fetch unread counts per workspace so we can show the red dot next to the
  // workspace name on mobile/iOS too (WorkspaceSwitcher handles desktop but
  // returns null on mobile, so the dot was invisible in the iOS WKWebView).
  const fetchUnread = useCallback(async () => {
    if (!currentWorkspace?.id) return;
    try {
      const res = await api.get('/api/notifications/unread-by-workspace');
      const data = res.data || {};
      const total = Object.entries(data).reduce((sum, [wsId, c]) => (
        wsId !== currentWorkspace.id ? sum + (c || 0) : sum
      ), 0);
      setOtherUnreadTotal(total);
    } catch {
      // swallow — transient; next poll will retry
    }
  }, [currentWorkspace?.id]);

  useEffect(() => {
    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    return () => clearInterval(interval);
  }, [fetchUnread]);

  // Click header → go to dashboard. On iOS WKWebView there was a past bug
  // where scroll-start taps synthesized a click; that was fixed by the modal
  // scroll-lock guard in App.jsx, so it's safe to re-enable navigation here.
  // Use pointer tracking to ignore taps that moved significantly (scroll gesture).
  const handlePointerDown = (e) => {
    e.currentTarget._pointerStart = { x: e.clientX, y: e.clientY };
  };
  const handleClick = onClick || ((e) => {
    const start = e.currentTarget._pointerStart;
    if (start) {
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > 8 || dy > 8) return; // was a scroll, not a tap
    }
    navigate('/app');
  });

  return (
    <div
      className="header-brand"
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      style={{ cursor: 'pointer' }}
    >
      <img src="/icons/icon-96x96.png" alt="" width="28" height="28" className="header-logo-icon" />
      <div className="header-brand-text">
        <h1 className={`header-title-link${active ? ' active' : ''}`}>
          Prpl CRM
        </h1>
        {currentWorkspace && (
          <span className="header-workspace-name">
            <span className="header-workspace-dot" style={{ backgroundColor: currentWorkspace.color || '#6366f1' }} />
            {currentWorkspace.name}
            {otherUnreadTotal > 0 && (
              <span
                className="header-workspace-unread-dot"
                title={`${otherUnreadTotal} neprečítaných v iných prostrediach`}
              />
            )}
          </span>
        )}
      </div>
    </div>
  );
};

export default HeaderLogo;
