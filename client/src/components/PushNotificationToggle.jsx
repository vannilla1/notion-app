import { useState, useEffect } from 'react';
import {
  isPushSupported,
  getPermissionStatus,
  subscribeToPush,
  unsubscribeFromPush,
  isSubscribedToPush,
  sendTestPush
} from '../services/pushNotifications';

const PushNotificationToggle = () => {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState('default');
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [testSent, setTestSent] = useState(false);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    setLoading(true);
    try {
      const isSupported = isPushSupported();
      setSupported(isSupported);

      if (isSupported) {
        setPermission(getPermissionStatus());
        const isSub = await isSubscribedToPush();
        setSubscribed(isSub);
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
      if (subscribed) {
        await unsubscribeFromPush();
        setSubscribed(false);
      } else {
        await subscribeToPush();
        setSubscribed(true);
        setPermission('granted');
      }
    } catch (err) {
      console.error('Error toggling push notifications:', err);
      setError(err.message);
      setPermission(getPermissionStatus());
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

  if (!supported) {
    return (
      <div className="push-notification-toggle">
        <div className="push-status unsupported">
          <span className="icon">&#x26A0;</span>
          <span>Push notifikácie nie sú podporované na tomto zariadení</span>
        </div>
        <style>{styles}</style>
      </div>
    );
  }

  if (permission === 'denied') {
    return (
      <div className="push-notification-toggle">
        <div className="push-status denied">
          <span className="icon">&#x1F6AB;</span>
          <div>
            <strong>Push notifikácie sú zablokované</strong>
            <p>Povoľte notifikácie v nastaveniach prehliadača</p>
          </div>
        </div>
        <style>{styles}</style>
      </div>
    );
  }

  return (
    <div className="push-notification-toggle">
      <div className="push-header">
        <div className="push-info">
          <span className="icon">{subscribed ? '🔔' : '🔕'}</span>
          <div>
            <strong>Push notifikácie</strong>
            <p>{subscribed ? 'Aktívne' : 'Neaktívne'}</p>
          </div>
        </div>
        <button
          className={`toggle-btn ${subscribed ? 'active' : ''}`}
          onClick={handleToggle}
          disabled={loading}
        >
          <span className="toggle-slider"></span>
        </button>
      </div>

      {error && (
        <div className="push-error">
          {error}
        </div>
      )}

      {subscribed && (
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
