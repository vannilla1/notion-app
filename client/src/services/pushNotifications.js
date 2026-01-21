import api from '../api/axios';

const PUSH_SW_PATH = '/sw-push.js';

/**
 * Check if push notifications are supported
 */
export const isPushSupported = () => {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
};

/**
 * Get current notification permission status
 */
export const getPermissionStatus = () => {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
};

/**
 * Request notification permission
 */
export const requestPermission = async () => {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported');
  }

  const permission = await Notification.requestPermission();
  return permission;
};

/**
 * Register the push service worker
 */
export const registerPushServiceWorker = async () => {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported');
  }

  try {
    const registration = await navigator.serviceWorker.register(PUSH_SW_PATH, {
      scope: '/'
    });

    console.log('Push service worker registered:', registration);
    return registration;
  } catch (error) {
    console.error('Push service worker registration failed:', error);
    throw error;
  }
};

/**
 * Get VAPID public key from server
 */
export const getVapidPublicKey = async () => {
  const response = await api.get('/push/vapid-public-key');
  return response.data.publicKey;
};

/**
 * Convert VAPID key to Uint8Array
 */
const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
};

/**
 * Subscribe to push notifications
 */
export const subscribeToPush = async () => {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported');
  }

  // Request permission if not granted
  if (Notification.permission === 'default') {
    const permission = await requestPermission();
    if (permission !== 'granted') {
      throw new Error('Notification permission denied');
    }
  }

  if (Notification.permission !== 'granted') {
    throw new Error('Notification permission not granted');
  }

  // Register service worker
  const registration = await registerPushServiceWorker();

  // Wait for the service worker to be ready
  await navigator.serviceWorker.ready;

  // Get VAPID public key
  const vapidPublicKey = await getVapidPublicKey();
  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

  // Subscribe to push
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey
  });

  // Send subscription to server
  const response = await api.post('/push/subscribe', subscription.toJSON());

  console.log('Push subscription saved:', response.data);
  return subscription;
};

/**
 * Unsubscribe from push notifications
 */
export const unsubscribeFromPush = async () => {
  const registration = await navigator.serviceWorker.getRegistration(PUSH_SW_PATH);

  if (!registration) {
    return;
  }

  const subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    // Notify server
    try {
      await api.post('/push/unsubscribe', { endpoint: subscription.endpoint });
    } catch (error) {
      console.error('Error notifying server about unsubscribe:', error);
    }

    // Unsubscribe locally
    await subscription.unsubscribe();
    console.log('Push subscription removed');
  }
};

/**
 * Check if user is subscribed to push
 */
export const isSubscribedToPush = async () => {
  if (!isPushSupported()) {
    return false;
  }

  const registration = await navigator.serviceWorker.getRegistration(PUSH_SW_PATH);

  if (!registration) {
    return false;
  }

  const subscription = await registration.pushManager.getSubscription();
  return !!subscription;
};

/**
 * Get subscription count from server
 */
export const getSubscriptionCount = async () => {
  const response = await api.get('/push/subscriptions');
  return response.data.count;
};

/**
 * Send test push notification
 */
export const sendTestPush = async () => {
  const response = await api.post('/push/test');
  return response.data;
};

/**
 * Initialize push notifications (call this on app load)
 */
export const initializePush = async () => {
  if (!isPushSupported()) {
    console.log('Push notifications are not supported on this device');
    return false;
  }

  // Check if already subscribed
  const subscribed = await isSubscribedToPush();

  if (subscribed) {
    console.log('Already subscribed to push notifications');
    return true;
  }

  // If permission is granted but not subscribed, re-subscribe
  if (Notification.permission === 'granted') {
    try {
      await subscribeToPush();
      return true;
    } catch (error) {
      console.error('Error re-subscribing to push:', error);
      return false;
    }
  }

  return false;
};
