import { useState, useEffect } from 'react';
import {
  isPushSupported,
  getPermissionStatus,
  subscribeToPush,
  unsubscribeFromPush,
  isSubscribedToPush,
  sendTestPush
} from '../services/pushNotifications';

// Check if notifications are enabled in localStorage
const areNotificationsEnabled = () => {
  const setting = localStorage.getItem('notificationsEnabled');
  // Default to true if not set
  return setting === null ? true : setting === 'true';
};

// Set notification enabled state
const setNotificationsEnabled = (enabled) => {
  localStorage.setItem('notificationsEnabled', enabled.toString());
  // Dispatch custom event for NotificationToast to listen
  window.dispatchEvent(new Event('notificationSettingChanged'));
};

const PushNotificationToggle = () => {
  const [pushSupported, setPushSupported] = useState(false);
  const [permission, setPermission] = useState('default');
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [notificationsEnabled, setNotificationsEnabledState] = useState(areNotificationsEnabled());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [testSent, setTestSent] = useState(false);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    setLoading(true);
    try {
      // Check in-app notification setting
      setNotificationsEnabledState(areNotificationsEnabled());

      // Check push notification support
      const isSupported = isPushSupported();
      setPushSupported(isSupported);

      if (isSupported) {
        setPermission(getPermissionStatus());
        const isSub = await isSubscribedToPush();
        setPushSubscribed(isSub);
      }
    } catch (err) {
      console.error('Error checking push status:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async () => {
    setLoading(true);
    setError(null);

    try {
      const newEnabled = !notificationsEnabled;

      // Toggle in-app notifications
      setNotificationsEnabled(newEnabled);
      setNotificationsEnabledState(newEnabled);

      // Also toggle push notifications if supported
      if (pushSupported && permission !== 'denied') {
        if (newEnabled && !pushSubscribed) {
          try {
            await subscribeToPush();
            setPushSubscribed(true);
            setPermission('granted');
          } catch (pushErr) {
            // Push subscription failed but in-app notifications are still enabled
            console.log('Push subscription failed:', pushErr.message);
          }
        } else if (!newEnabled && pushSubscribed) {
          try {
            await unsubscribeFromPush();
            setPushSubscribed(false);
          } catch (pushErr) {
            console.log('Push unsubscription failed:', pushErr.message);
          }
        }
      }
    } catch (err) {
      console.error('Error toggling notifications:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTestPush = async () => {
    setLoading(true);
    try {
      await sendTestPush();
      setTestSent(true);
      setTimeout(() => setTestSent(false), 3000);
    } catch (err) {
      console.error('Error sending test push:', err);
      setError('Nepodarilo sa odoslať testovaciu notifikáciu');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="push-notification-toggle">
      <div className="push-header">
        <div className="push-info">
          <span className="icon">{notificationsEnabled ? '🔔' : '🔕'}</span>
          <div>
            <strong>Notifikácie</strong>
            <p>{notificationsEnabled ? 'Aktívne' : 'Neaktívne'}</p>
          </div>
        </div>
        <button
          className={`toggle-btn ${notificationsEnabled ? 'active' : ''}`}
          onClick={handleToggle}
          disabled={loading}
        >
          <span className="toggle-slider"></span>
        </button>
      </div>

      {/* Show push status info */}
      {notificationsEnabled && (
        <div className="push-status-info">
          {!pushSupported ? (
            <span className="status-note warning">⚠️ Push notifikácie nie sú podporované v tomto prehliadači</span>
          ) : permission === 'denied' ? (
            <span className="status-note warning">⚠️ Push notifikácie sú zablokované v prehliadači</span>
          ) : pushSubscribed ? (
            <span className="status-note success">✓ Push notifikácie aktívne (aj pre zatvorenú aplikáciu)</span>
          ) : (
            <span className="status-note">In-app notifikácie aktívne</span>
          )}
        </div>
      )}

      {error && (
        <div className="push-error">
          {error}
        </div>
      )}

      {notificationsEnabled && pushSubscribed && (
        <button
          className="test-btn"
          onClick={handleTestPush}
          disabled={loading}
        >
          {testSent ? '✓ Odoslané' : 'Odoslať testovaciu notifikáciu'}
        </button>
      )}

      <style>{styles}</style>
    </div>
  );
};

const styles = `
  .push-notification-toggle {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 16px;
  }

  .push-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .push-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .push-info .icon {
    font-size: 24px;
  }

  .push-info strong {
    display: block;
    color: #fff;
    font-size: 14px;
  }

  .push-info p {
    color: #888;
    font-size: 12px;
    margin: 2px 0 0 0;
  }

  .toggle-btn {
    width: 50px;
    height: 28px;
    background: #333;
    border: none;
    border-radius: 14px;
    position: relative;
    cursor: pointer;
    transition: background 0.3s;
  }

  .toggle-btn.active {
    background: #6366f1;
  }

  .toggle-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toggle-slider {
    position: absolute;
    width: 22px;
    height: 22px;
    background: #fff;
    border-radius: 50%;
    top: 3px;
    left: 3px;
    transition: transform 0.3s;
  }

  .toggle-btn.active .toggle-slider {
    transform: translateX(22px);
  }

  .push-status {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border-radius: 8px;
  }

  .push-status.unsupported {
    color: #ffa500;
  }

  .push-status.denied {
    color: #ff6b6b;
  }

  .push-status .icon {
    font-size: 20px;
  }

  .push-status p {
    margin: 4px 0 0 0;
    font-size: 12px;
    opacity: 0.8;
  }

  .push-status-info {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .status-note {
    font-size: 12px;
    color: #888;
  }

  .status-note.warning {
    color: #ffa500;
  }

  .status-note.success {
    color: #10b981;
  }

  .push-error {
    background: rgba(255, 107, 107, 0.1);
    color: #ff6b6b;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    margin-top: 12px;
  }

  .test-btn {
    width: 100%;
    margin-top: 12px;
    padding: 10px;
    background: rgba(99, 102, 241, 0.2);
    border: 1px solid rgba(99, 102, 241, 0.3);
    border-radius: 8px;
    color: #6366f1;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .test-btn:hover:not(:disabled) {
    background: rgba(99, 102, 241, 0.3);
  }

  .test-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

export default PushNotificationToggle;
