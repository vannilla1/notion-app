import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import api from '../api/api';

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef(null);
  const bellRef = useRef(null);
  const navigate = useNavigate();
  const { socket, isConnected } = useSocket();

  // Fetch unread count
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await api.get('/api/notifications/unread-count');
      setUnreadCount(res.data.count || 0);
    } catch {}
  }, []);

  // Fetch notifications list
  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/notifications?limit=30');
      setNotifications(res.data.notifications || []);
      setUnreadCount(res.data.unreadCount ?? 0);
    } catch {}
    setLoading(false);
  }, []);

  // Initial load + periodic refresh
  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  // Socket: real-time notification updates
  useEffect(() => {
    if (!socket || !isConnected) return;
    const handler = () => {
      setUnreadCount(c => c + 1);
      if (open) fetchNotifications();
    };
    socket.on('notification', handler);
    return () => socket.off('notification', handler);
  }, [socket, isConnected, open, fetchNotifications]);

  // Load list when panel opens
  useEffect(() => {
    if (open) fetchNotifications();
  }, [open, fetchNotifications]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) &&
          bellRef.current && !bellRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleClick = useCallback(async (notif) => {
    // Mark as read
    if (!notif.read) {
      try { await api.put(`/api/notifications/${notif.id || notif._id}/read`); } catch {}
      setUnreadCount(c => Math.max(0, c - 1));
    }
    setOpen(false);

    // Navigate to the relevant content
    const ts = Date.now();
    const data = notif.data || {};
    const type = notif.type || '';

    if (type.startsWith('message') && data.messageId) {
      navigate(`/messages?highlight=${data.messageId}&_t=${ts}`);
    } else if (type.startsWith('contact') && data.contactId) {
      navigate(`/crm?expandContact=${data.contactId}&_t=${ts}`);
    } else if ((type.startsWith('task') || type.startsWith('subtask')) && data.taskId) {
      let url = `/tasks?highlightTask=${data.taskId}&_t=${ts}`;
      if (data.subtaskId) url += `&subtask=${data.subtaskId}`;
      if (data.contactId) url += `&contactId=${data.contactId}`;
      navigate(url);
    }
  }, [navigate]);

  const markAllRead = async () => {
    try {
      await api.put('/api/notifications/read-all');
      setUnreadCount(0);
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch {}
  };

  const getIcon = (type) => {
    if (type?.startsWith('contact')) return '👤';
    if (type?.startsWith('task')) return '✅';
    if (type?.startsWith('subtask')) return '📝';
    if (type?.startsWith('message')) return '📨';
    if (type?.startsWith('workspace')) return '🏢';
    return '🔔';
  };

  const timeAgo = (date) => {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'teraz';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  return (
    <div className="notif-bell-wrapper">
      <button
        ref={bellRef}
        className="notif-bell-btn"
        onClick={() => setOpen(!open)}
        aria-label="Notifikácie"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="notif-bell-badge">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div ref={panelRef} className="notif-panel">
          <div className="notif-panel-header">
            <span className="notif-panel-title">Notifikácie</span>
            {unreadCount > 0 && (
              <button className="notif-mark-all" onClick={markAllRead}>
                Označiť všetky
              </button>
            )}
          </div>

          <div className="notif-panel-list">
            {loading && notifications.length === 0 && (
              <div className="notif-panel-empty">Načítavam...</div>
            )}
            {!loading && notifications.length === 0 && (
              <div className="notif-panel-empty">Žiadne notifikácie</div>
            )}
            {notifications.map(notif => (
              <div
                key={notif.id || notif._id}
                className={`notif-item ${notif.read ? '' : 'unread'}`}
                onClick={() => handleClick(notif)}
              >
                <span className="notif-item-icon">{getIcon(notif.type)}</span>
                <div className="notif-item-content">
                  <div className="notif-item-title">{notif.title}</div>
                  {notif.message && (
                    <div className="notif-item-msg">{notif.message}</div>
                  )}
                </div>
                <span className="notif-item-time">{timeAgo(notif.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
