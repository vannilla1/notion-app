import { useState, useEffect } from 'react';
import {
  isPushSupported,
  getPermissionStatus,
  subscribeToPush,
  unsubscribeFromPush,
  isSubscribedToPush,
  sendTestPush
} from '../services/pushNotifications';
import api from '../api/api';
import { isNativeAndroidApp } from '../utils/nativeBridge';

const areNotificationsEnabled = () => {
  const setting = localStorage.getItem('notificationsEnabled');
  return setting === null ? true : setting === 'true';
};

const setNotificationsEnabled = (enabled) => {
  localStorage.setItem('notificationsEnabled', enabled.toString());
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
  // Android native — diagnostické info pre FCM push (na diagnostiku problémov
  // s notifikáciami medzi Android zariadeniami).
  const isAndroid = isNativeAndroidApp();
  const [fcmStatus, setFcmStatus] = useState(null); // { fcmConfigured, registeredDevices, devices[] }
  const [fcmError, setFcmError] = useState(null);
  const [fcmTestResult, setFcmTestResult] = useState(null);
  const [forceRegisterResult, setForceRegisterResult] = useState(null);
  // APK verzia z NativeBridge (teraz zahŕňa aj versionCode: "1.0.0 (106)")
  const nativeAppVersion = isAndroid && window.NativeBridge?.getAppVersion
    ? window.NativeBridge.getAppVersion()
    : null;
  const hasForceFcmRegister = isAndroid
    && typeof window.NativeBridge?.forceFcmRegister === 'function';

  useEffect(() => {
    checkStatus();
    if (isAndroid) fetchFcmStatus();
  }, [isAndroid]);

  const fetchFcmStatus = async () => {
    try {
      const res = await api.get('/api/push/fcm/status');
      setFcmStatus(res.data);
      setFcmError(null);
    } catch (err) {
      setFcmError(err.response?.data?.message || err.message || 'Chyba pri načítaní FCM stavu');
    }
  };

  const handleForceRegister = async () => {
    setForceRegisterResult(null);
    setFcmError(null);
    try {
      const result = window.NativeBridge?.forceFcmRegister?.() || 'unknown';
      setForceRegisterResult(result);
      // Po 2s refresh status (FCM register je async, dáme backendu chvíľu na uloženie)
      setTimeout(() => fetchFcmStatus(), 2500);
    } catch (err) {
      setFcmError('Force register error: ' + (err.message || 'unknown'));
    }
  };

  const handleFcmTest = async () => {
    setFcmTestResult(null);
    setFcmError(null);
    try {
      const res = await api.post('/api/push/fcm/test');
      setFcmTestResult(res.data.result || { sent: 0, failed: 0, removed: 0 });
      // Refresh status after test (tokens môžu byť auto-removed ak padli)
      await fetchFcmStatus();
    } catch (err) {
      setFcmError(err.response?.data?.message || err.message || 'Chyba pri odoslaní test push');
    }
  };

  const checkStatus = async () => {
    setLoading(true);
    try {
      setNotificationsEnabledState(areNotificationsEnabled());

      const isSupported = isPushSupported();
      setPushSupported(isSupported);

      if (isSupported) {
        const perm = getPermissionStatus();
        setPermission(perm);

        const isSub = await isSubscribedToPush();
        setPushSubscribed(isSub);
      }
    } catch {
      // Status check failed
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async () => {
    setLoading(true);
    setError(null);

    try {
      const newEnabled = !notificationsEnabled;

      setNotificationsEnabled(newEnabled);
      setNotificationsEnabledState(newEnabled);

      if (pushSupported && permission !== 'denied') {
        if (newEnabled && !pushSubscribed) {
          try {
            await subscribeToPush();
            setPushSubscribed(true);
            setPermission('granted');
          } catch (pushErr) {
            // Push subscription failed but in-app notifications are still enabled
          }
        } else if (!newEnabled && pushSubscribed) {
          try {
            await unsubscribeFromPush();
            setPushSubscribed(false);
          } catch (pushErr) {
            // Push unsubscription failed
          }
        }
      }
    } catch (err) {
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
    } catch {
      setError('Nepodarilo sa odoslať testovaciu notifikáciu');
    } finally {
      setLoading(false);
    }
  };

  // Android native appka — samostatné renderovanie. Web push (service worker /
  // VAPID) sa v WebView nepoužíva; notifikácie idú cez natívny FCM kanál, takže
  // toggle "Aktívne/Neaktívne" ani "nie sú podporované" upozornenie tu nemá zmysel.
  if (isAndroid) {
    return (
      <div className="push-notification-toggle">
        <div className="push-header">
          <div className="push-info">
            <span className="icon">🔔</span>
            <div>
              <strong>Notifikácie (Android)</strong>
              <p>Riadia sa cez systémové nastavenia a FCM</p>
            </div>
          </div>
        </div>

        <div className="fcm-diag">
          <div className="fcm-diag-header">Diagnostika</div>
          {nativeAppVersion && (
            <div className="fcm-diag-row">
              <span>Verzia appky:</span>
              <code>{nativeAppVersion}</code>
            </div>
          )}
          {hasForceFcmRegister && (
            <>
              <button
                className="test-btn"
                style={{ marginTop: 8, marginBottom: 8 }}
                onClick={handleForceRegister}
              >
                Vynútiť FCM registráciu
              </button>
              {forceRegisterResult && (
                <div className="fcm-diag-row">
                  <span>Stav:</span>
                  <code>{forceRegisterResult}</code>
                </div>
              )}
            </>
          )}
          {!fcmStatus && !fcmError && <div className="fcm-diag-row">Načítavam…</div>}
          {fcmStatus && (
            <>
              <div className="fcm-diag-row">
                <span>FCM na serveri:</span>
                <strong className={fcmStatus.fcmConfigured ? 'ok' : 'bad'}>
                  {fcmStatus.fcmConfigured ? '✓ aktívne' : '✗ neaktívne'}
                </strong>
              </div>
              {fcmStatus.fcmConfigured && fcmStatus.projectId && (
                <div className="fcm-diag-row">
                  <span>Firebase projekt:</span>
                  <code>{fcmStatus.projectId}</code>
                </div>
              )}
              <div className="fcm-diag-row">
                <span>Registrované zariadenia:</span>
                <strong className={fcmStatus.registeredDevices > 0 ? 'ok' : 'bad'}>
                  {fcmStatus.registeredDevices}
                </strong>
              </div>
              {fcmStatus.devices?.map((d, i) => (
                <div key={i} className="fcm-diag-device">
                  <div>Token: <code>{d.tokenPrefix}</code></div>
                  <div>Verzia: {d.appVersion || '—'} · {d.packageName || '—'}</div>
                  <div>Naposledy: {d.lastUsed ? new Date(d.lastUsed).toLocaleString('sk-SK') : '—'}</div>
                </div>
              ))}
              <button
                className="test-btn"
                style={{ marginTop: 12 }}
                onClick={handleFcmTest}
                disabled={!fcmStatus.fcmConfigured || fcmStatus.registeredDevices === 0}
              >
                Odoslať test notifikáciu na moje zariadenia
              </button>
              {fcmTestResult && (
                <div className="fcm-diag-row" style={{ marginTop: 8 }}>
                  <span>Výsledok:</span>
                  <span>
                    odoslané {fcmTestResult.sent} ·
                    zlyhali {fcmTestResult.failed} ·
                    odstránené {fcmTestResult.removed}
                  </span>
                </div>
              )}
            </>
          )}
          {fcmError && <div className="push-error">{fcmError}</div>}
        </div>

        <style>{styles}</style>
      </div>
    );
  }

  // Desktop / web browser — pôvodné web-push UI (service worker + VAPID).
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

      {notificationsEnabled && (
        <div className="push-status-info">
          {!pushSupported ? (
            <span className="status-note warning">
              ⚠️ Push notifikácie nie sú podporované.
              {/iPhone|iPad|iPod/.test(navigator.userAgent) && (
                <> Pre iOS: otvorte aplikáciu cez ikonu na ploche (PWA).</>
              )}
            </span>
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

  .fcm-diag {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .fcm-diag-header {
    font-size: 12px;
    font-weight: 600;
    color: #aaa;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .fcm-diag-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #ccc;
    padding: 4px 0;
  }

  .fcm-diag-row code {
    font-family: monospace;
    font-size: 11px;
    color: #8b9eff;
    background: rgba(99, 102, 241, 0.1);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .fcm-diag-row strong.ok {
    color: #10b981;
  }

  .fcm-diag-row strong.bad {
    color: #ef4444;
  }

  .fcm-diag-device {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 6px;
    padding: 8px;
    margin-top: 6px;
    font-size: 11px;
    color: #999;
    line-height: 1.5;
  }

  .fcm-diag-device code {
    font-family: monospace;
    font-size: 10px;
    color: #8b9eff;
  }
`;

export default PushNotificationToggle;
