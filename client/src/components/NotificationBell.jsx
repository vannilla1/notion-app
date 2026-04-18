import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { useWorkspace } from '../context/WorkspaceContext';
import api from '../api/api';

// Stránkovanie notifikácií v belli. Používame offset-based pagination
// (nie cursor) — backend akceptuje `?limit=&offset=` a vracia `total` +
// `unreadCount` v každej odpovedi, takže ľahko vieme, či sa má zobraziť
// "Zobraziť viac" tlačidlo.
//
// 30 per page je dobrý default — prvý fetch je rýchly (menej DB work,
// menej JSON payloadu), a user zvyčajne klikne 1-2x load-more ak sa chce
// dostať hlbšie. Infinite scroll v tak malom popover paneli (max-height
// 460px) by bol zmätočný, lebo user nie vždy rozozná, že tam niečo
// dole pribúda.
const PAGE_SIZE = 30;

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const panelRef = useRef(null);
  const bellRef = useRef(null);
  const navigate = useNavigate();
  const { socket, isConnected } = useSocket();
  const { currentWorkspaceId, switchWorkspace, workspaces } = useWorkspace();

  // Switch workspace if notif belongs to a different one, then navigate.
  // Critical for multi-workspace users: a bell click on a notification
  // from another workspace must first switch the workspace context.
  const navigateForNotif = useCallback(async (url, notifWorkspaceId) => {
    const targetWs = notifWorkspaceId?.toString?.() || notifWorkspaceId;
    const currentWs = currentWorkspaceId?.toString?.() || currentWorkspaceId;
    if (targetWs && targetWs !== currentWs) {
      const isMember = (workspaces || []).some(w => (w.id || w._id)?.toString() === targetWs);
      if (isMember) {
        try { await switchWorkspace(targetWs); } catch {}
      }
    }
    navigate(url);
  }, [navigate, currentWorkspaceId, switchWorkspace, workspaces]);

  // Fetch unread count
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await api.get('/api/notifications/unread-count');
      setUnreadCount(res.data.count || 0);
    } catch {}
  }, []);

  // Fetch prvej stránky notifikácií — volá sa pri otvorení panelu alebo
  // pri socket `notification` evente. Reset-uje pagination od začiatku.
  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/api/notifications?limit=${PAGE_SIZE}&offset=0`);
      setNotifications(res.data.notifications || []);
      setUnreadCount(res.data.unreadCount ?? 0);
      setTotal(res.data.total ?? 0);
    } catch {}
    setLoading(false);
  }, []);

  // Load-more tlačidlo → appenduje ďalšiu stránku 30 notifikácií.
  // Offset je `notifications.length` (nie fixný page number) — tak nám
  // neprekáža ani real-time socket event medzi stránkami; ak by sa v
  // medzi-stránkovej medziere objavila nová notifikácia, hrozí duplicit
  // v zozname. Dedupujeme podľa `id` cez Map, aby sme sa tomu vyhli.
  const loadMore = useCallback(async () => {
    if (loadingMore || loading) return;
    setLoadingMore(true);
    try {
      const res = await api.get(`/api/notifications?limit=${PAGE_SIZE}&offset=${notifications.length}`);
      const newItems = res.data.notifications || [];
      setNotifications(prev => {
        // Dedup podľa id — socket event mohol medzi-tým vložiť novú notifikáciu
        // pred aktuálny zoznam, a server by ju vrátil druhý krát na novom
        // offsete. Map zachová poradie (najnovšie prvé).
        const map = new Map();
        [...prev, ...newItems].forEach(n => {
          const key = n.id || n._id;
          if (key && !map.has(key)) map.set(key, n);
        });
        return Array.from(map.values());
      });
      setTotal(res.data.total ?? 0);
      setUnreadCount(res.data.unreadCount ?? 0);
    } catch {}
    setLoadingMore(false);
  }, [notifications.length, loadingMore, loading]);

  // Initial load + periodic refresh
  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  // Refresh immediately when another component marks notifications as read
  // (e.g. opening a message detail via deep link clears that message's notifs)
  useEffect(() => {
    const handler = () => {
      fetchUnreadCount();
      if (open) fetchNotifications();
    };
    window.addEventListener('notifications-updated', handler);
    return () => window.removeEventListener('notifications-updated', handler);
  }, [fetchUnreadCount, fetchNotifications, open]);

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
      setNotifications(prev => prev.map(n =>
        (n.id || n._id) === (notif.id || notif._id) ? { ...n, read: true } : n
      ));
      // Let App.jsx refetch section counts so BottomNav badge drops immediately
      window.dispatchEvent(new Event('notifications-updated'));
    }
    setOpen(false);

    const ts = Date.now();
    const data = notif.data || {};
    const related = notif.relatedType || '';
    const type = notif.type || '';
    const notifWs = notif.workspaceId || data.workspaceId || null;

    // Use relatedType first (reliable), then fall back to type prefix
    if ((related === 'message' || type.startsWith('message')) && data.messageId) {
      let url = `/messages?highlight=${data.messageId}&_t=${ts}`;
      if (data.commentId) url += `&comment=${data.commentId}`;
      navigateForNotif(url, notifWs);
    } else if ((related === 'contact' || type.startsWith('contact')) && data.contactId) {
      // Contact-embedded tasks: if we also have taskId, include it
      let url = `/crm?expandContact=${data.contactId}&_t=${ts}`;
      if (data.taskId) url += `&highlightTask=${data.taskId}`;
      if (data.subtaskId) url += `&subtask=${data.subtaskId}`;
      navigateForNotif(url, notifWs);
    } else if ((related === 'task' || related === 'subtask' || type.startsWith('task') || type.startsWith('subtask')) && data.taskId) {
      let url = `/tasks?highlightTask=${data.taskId}&_t=${ts}`;
      if (data.subtaskId) url += `&subtask=${data.subtaskId}`;
      if (data.contactId) url += `&contactId=${data.contactId}`;
      navigateForNotif(url, notifWs);
    } else if (notif.relatedId) {
      // Fallback: use relatedType + relatedId
      if (related === 'message') navigateForNotif(`/messages?highlight=${notif.relatedId}&_t=${ts}`, notifWs);
      else if (related === 'contact') navigateForNotif(`/crm?expandContact=${notif.relatedId}&_t=${ts}`, notifWs);
      else if (related === 'task' || related === 'subtask') navigateForNotif(`/tasks?highlightTask=${notif.relatedId}&_t=${ts}`, notifWs);
    }
  }, [navigateForNotif]);

  const markAllRead = async () => {
    try {
      await api.put('/api/notifications/read-all');
      setUnreadCount(0);
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      // Same as handleClick — tell App.jsx to refetch BottomNav section counts
      window.dispatchEvent(new Event('notifications-updated'));
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
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
                <div className="notif-item-meta">
                  <span className="notif-item-time">{timeAgo(notif.createdAt)}</span>
                  {!notif.read && <span className="notif-unread-dot" />}
                </div>
              </div>
            ))}
            {/* Load-more — zobrazíme iba ak server hlási viac položiek
                než máme aktuálne v zozname. Počet zostávajúcich ukážeme
                v labeli, aby user vedel, koľko ešte čaká. */}
            {!loading && total > notifications.length && (
              <button
                type="button"
                className="notif-load-more"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore
                  ? 'Načítavam…'
                  : `Zobraziť ďalšie (${Math.min(PAGE_SIZE, total - notifications.length)})`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
