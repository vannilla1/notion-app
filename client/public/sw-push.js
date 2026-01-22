// Push notification service worker
// Version: 2.0 - Deep linking support

const SW_VERSION = '2.0';
console.log('[SW] Push service worker loaded, version:', SW_VERSION);

self.addEventListener('push', (event) => {
  console.log('[SW] Push received:', event);

  let data = {
    title: 'Purple CRM',
    body: 'Nová notifikácia',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    data: {}
  };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch (e) {
      console.error('[SW] Error parsing push data:', e);
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192x192.png',
    badge: data.badge || '/icons/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: data.data || {},
    actions: data.actions || [],
    tag: data.tag || 'default',
    renotify: true,
    requireInteraction: data.requireInteraction || false
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event);
  console.log('[SW] Notification data:', event.notification.data);

  event.notification.close();

  // Get the URL to open - could be relative or absolute
  let urlToOpen = event.notification.data?.url || '/';

  // Make sure we have a full URL
  if (urlToOpen.startsWith('/')) {
    urlToOpen = self.location.origin + urlToOpen;
  }

  console.log('[SW] Opening URL:', urlToOpen);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        console.log('[SW] Found clients:', windowClients.length);

        // On mobile, we should prefer opening a new window/tab for reliable navigation
        // Check if there's already a window open with our app
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin)) {
            console.log('[SW] Found existing client:', client.url);
            // Focus the existing window and navigate to the new URL
            return client.focus().then(() => {
              // Use postMessage to navigate within the SPA
              client.postMessage({
                type: 'NOTIFICATION_CLICK',
                url: urlToOpen,
                data: event.notification.data
              });
              return client;
            }).catch(() => {
              // If focus fails, open new window
              return clients.openWindow(urlToOpen);
            });
          }
        }

        // If no window is open, open a new one
        console.log('[SW] No existing client, opening new window');
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
      .catch((error) => {
        console.error('[SW] Error handling notification click:', error);
        // Fallback: try to open new window
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Notification closed:', event);
});

// Force activation of new service worker
self.addEventListener('install', (event) => {
  console.log('[SW] Installing new version:', SW_VERSION);
  // Skip waiting to activate immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating new version:', SW_VERSION);
  // Take control of all clients immediately
  event.waitUntil(clients.claim());
});

// Handle subscription change
self.addEventListener('pushsubscriptionchange', (event) => {
  console.log('[SW] Push subscription changed');

  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: self.VAPID_PUBLIC_KEY
    })
    .then((subscription) => {
      // Send new subscription to server
      return fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(subscription)
      });
    })
  );
});
