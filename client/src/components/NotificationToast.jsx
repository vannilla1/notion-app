import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useNavigate } from 'react-router-dom';

// Check if notifications are enabled in localStorage
const areNotificationsEnabled = () => {
  const setting = localStorage.getItem('notificationsEnabled');
  // Default to true if not set
  return setting === null ? true : setting === 'true';
};

function NotificationToast() {
  const [toasts, setToasts] = useState([]);
  const [notificationsEnabled, setNotificationsEnabled] = useState(areNotificationsEnabled());
  const { socket, isConnected } = useSocket();
  const navigate = useNavigate();

  // Listen for changes to notification settings
  useEffect(() => {
    const handleStorageChange = () => {
      setNotificationsEnabled(areNotificationsEnabled());
    };

    // Listen for custom event from PushNotificationToggle
    window.addEventListener('notificationSettingChanged', handleStorageChange);
    // Also listen for storage changes from other tabs
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('notificationSettingChanged', handleStorageChange);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  // Add a new toast
  const addToast = useCallback((notification) => {
    // Check if notifications are enabled (read fresh value)
    if (!areNotificationsEnabled()) {
      return;
    }

    const id = notification.id || Date.now().toString();
    setToasts(prev => {
      // Prevent duplicates
      if (prev.some(t => t.id === id)) return prev;
      // Limit to 5 toasts
      const newToasts = [...prev, { ...notification, id }];
      return newToasts.slice(-5);
    });

    // Auto-remove after 5 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  // Remove a toast
  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Handle click on toast
  const handleClick = useCallback((toast) => {
    removeToast(toast.id);

    // Navigate based on notification type
    if (toast.relatedType === 'contact' && toast.data?.contactId) {
      navigate('/crm', { state: { expandContactId: toast.data.contactId } });
    } else if (toast.relatedType === 'task' && toast.data?.taskId) {
      navigate('/tasks', { state: { highlightTaskId: toast.data.taskId } });
    } else if (toast.relatedType === 'subtask' && toast.data?.taskId) {
      navigate('/tasks', { state: { highlightTaskId: toast.data.taskId } });
    }
  }, [navigate, removeToast]);

  // Listen for notifications from socket
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

  // Get icon based on notification type
  const getIcon = (type) => {
    if (type?.startsWith('contact')) return '👤';
    if (type?.startsWith('task')) return '✅';
    if (type?.startsWith('subtask')) return '📝';
    return '🔔';
  };

  // Get color class based on notification type
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
