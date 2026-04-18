import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useNavigate } from 'react-router-dom';

const areNotificationsEnabled = () => {
  const setting = localStorage.getItem('notificationsEnabled');
  return setting === null ? true : setting === 'true';
};

function NotificationToast() {
  const [toasts, setToasts] = useState([]);
  const [notificationsEnabled, setNotificationsEnabled] = useState(areNotificationsEnabled());
  const { socket, isConnected } = useSocket();
  const navigate = useNavigate();

  useEffect(() => {
    const handleStorageChange = () => {
      setNotificationsEnabled(areNotificationsEnabled());
    };

    window.addEventListener('notificationSettingChanged', handleStorageChange);
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('notificationSettingChanged', handleStorageChange);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  const addToast = useCallback((notification) => {
    if (!areNotificationsEnabled()) {
      return;
    }

    const id = notification.id || Date.now().toString();
    setToasts(prev => {
      if (prev.some(t => t.id === id)) return prev;
      const newToasts = [...prev, { ...notification, id }];
      return newToasts.slice(-5);
    });

    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const handleClick = useCallback((toast) => {
    removeToast(toast.id);
    const ts = Date.now();
    const type = toast.type || '';
    const related = toast.relatedType || '';
    const data = toast.data || {};

    // Route priority: message > task/subtask > contact.
    // Task ide PRED contact lebo due-date notifikácie pre contact-embedded
    // úlohy majú `relatedType='contact'` (historicky), ale `type='task.dueDate'`
    // + `data.taskId`. User chce otvoriť úlohu, nie kontakt. Tasks page vie
    // zobraziť aj contact-embedded úlohy (server routes/tasks.js zlučuje oba
    // zdroje), takže highlight + scroll funguje bez ohľadu na zdroj úlohy.
    // Viď identickú logiku v NotificationBell.jsx.
    if ((related === 'message' || type.startsWith('message')) && data.messageId) {
      navigate(`/messages?highlight=${data.messageId}&_t=${ts}`);
    } else if ((related === 'task' || related === 'subtask' || type.startsWith('task') || type.startsWith('subtask')) && data.taskId) {
      let url = `/tasks?highlightTask=${data.taskId}&_t=${ts}`;
      if (data.subtaskId) url += `&subtask=${data.subtaskId}`;
      if (data.contactId) url += `&contactId=${data.contactId}`;
      navigate(url);
    } else if ((related === 'contact' || type.startsWith('contact')) && data.contactId) {
      navigate(`/crm?expandContact=${data.contactId}&_t=${ts}`);
    }
  }, [navigate, removeToast]);

  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleNotification = (notification) => {
      addToast(notification);
    };

    socket.on('notification', handleNotification);

    return () => {
      socket.off('notification', handleNotification);
    };
  }, [socket, isConnected, addToast]);

  const getIcon = (type) => {
    if (type?.startsWith('contact')) return '👤';
    if (type?.startsWith('task')) return '✅';
    if (type?.startsWith('subtask')) return '📝';
    if (type?.startsWith('message')) return '📨';
    if (type?.startsWith('workspace')) return '🏢';
    return '🔔';
  };

  const getColorClass = (type) => {
    if (type?.includes('created')) return 'toast-success';
    if (type?.includes('deleted')) return 'toast-danger';
    if (type?.includes('assigned')) return 'toast-info';
    if (type?.includes('completed')) return 'toast-success';
    return 'toast-default';
  };

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast ${getColorClass(toast.type)}`}
          onClick={() => handleClick(toast)}
        >
          <div className="toast-icon">{getIcon(toast.type)}</div>
          <div className="toast-content">
            <div className="toast-title">{toast.title}</div>
            {toast.message && (
              <div className="toast-message">{toast.message}</div>
            )}
          </div>
          <button
            className="toast-close"
            onClick={(e) => {
              e.stopPropagation();
              removeToast(toast.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default NotificationToast;
