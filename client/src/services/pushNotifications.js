import api from '../api/api';

const PUSH_SW_PATH = '/sw-push.js';

export const isNativeIOSApp = () => {
  return !!(window.webkit?.messageHandlers);
};

export const isPushSupported = () => {
  // Skip web push in native iOS app — APNs handles push notifications there
  if (isNativeIOSApp()) return false;

  const hasServiceWorker = 'serviceWorker' in navigator;
  const hasPushManager = 'PushManager' in window;
  const hasNotification = 'Notification' in window;

  return hasServiceWorker && hasPushManager && hasNotification;
};

export const getPermissionStatus = () => {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
};

export const requestPermission = async () => {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported');
  }

  const permission = await Notification.requestPermission();
  return permission;
};

export const registerPushServiceWorker = async () => {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported');
  }

  const registration = await navigator.serviceWorker.register(PUSH_SW_PATH, {
    scope: '/'
  });

  return registration;
};

export const getVapidPublicKey = async () => {
  const response = await api.get('/api/push/vapid-public-key');
  return response.data.publicKey;
};

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

export const subscribeToPush = async () => {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported');
  }

  if (Notification.permission === 'default') {
    const permission = await requestPermission();
    if (permission !== 'granted') {
      throw new Error('Notification permission denied');
    }
  }

  if (Notification.permission !== 'granted') {
    throw new Error('Notification permission not granted');
  }

  const registration = await registerPushServiceWorker();
  await navigator.serviceWorker.ready;

  const vapidPublicKey = await getVapidPublicKey();
  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey
  });

  await api.post('/api/push/subscribe', subscription.toJSON());

  return subscription;
};

export const unsubscribeFromPush = async () => {
  const registration = await navigator.serviceWorker.getRegistration(PUSH_SW_PATH);

  if (!registration) {
    return;
  }

  const subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    try {
      await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
    } catch {
      // Server notification failed — proceed with local unsubscribe
    }

    await subscription.unsubscribe();
  }
};

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

export const getSubscriptionCount = async () => {
  const response = await api.get('/api/push/subscriptions');
  return response.data.count;
};

export const sendTestPush = async () => {
  const response = await api.post('/api/push/test');
  return response.data;
};

export const initializePush = async () => {
  if (!isPushSupported()) {
    return false;
  }

  navigator.serviceWorker.addEventListener('message', async (event) => {
    if (event.data?.type === 'PUSH_SUBSCRIPTION_CHANGED') {
      if (event.data.newSubscription) {
        try {
          await api.post('/api/push/subscribe', event.data.newSubscription);
        } catch {
          // Failed to persist renewed subscription
        }
      } else {
        try {
          await subscribeToPush();
        } catch {
          // Failed to re-subscribe after subscription change
        }
      }
    }
  });

  try {
    const cache = await caches.open('push-subscription-cache');
    const cached = await cache.match('/_push_resubscribe');
    if (cached) {
      const newSub = await cached.json();
      await api.post('/api/push/subscribe', newSub);
      await cache.delete('/_push_resubscribe');
    }
  } catch {
    // Failed to process cached re-subscription
  }

  const subscribed = await isSubscribedToPush();

  if (subscribed) {
    return true;
  }

  // If permission is granted but not subscribed, re-subscribe
  if (Notification.permission === 'granted') {
    try {
      await subscribeToPush();
      return true;
    } catch {
      return false;
    }
  }

  return false;
};
