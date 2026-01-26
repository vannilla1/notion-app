// Push notification service worker
// Version: 2.1 - Production ready with improved error handling

const SW_VERSION = '2.1';

// Debug logging - disabled in production
const DEBUG = false;
const log = (...args) => DEBUG && console.log('[SW]', ...args);
const logError = (...args) => console.error('[SW]', ...args);

log('Push service worker loaded, version:', SW_VERSION);

self.addEventListener('push', (event) => {
  log('Push received');

  let data = {
    title: 'Purple CRM',
    body: 'Nová notifikácia',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    data: {}
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      // Sanitize and merge payload
      data = {
        ...data,
        title: String(payload.title || data.title).slice(0, 100),
        body: String(payload.body || data.body).slice(0, 200),
        icon: payload.icon || data.icon,
        badge: payload.badge || data.badge,
        data: payload.data || {},
        tag: payload.tag,
        actions: payload.actions,
        requireInteraction: payload.requireInteraction
      };
    } catch (e) {
      logError('Error parsing push data:', e.message);
    }
  }

  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    vibrate: [100, 50, 100],
    data: data.data,
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
  log('Notification clicked');

  event.notification.close();

  // Get the URL to open - could be relative or absolute
  let urlToOpen = event.notification.data?.url || '/';

  // Validate URL to prevent open redirect attacks
  try {
    if (urlToOpen.startsWith('/')) {
      urlToOpen = self.location.origin + urlToOpen;
    }
    const url = new URL(urlToOpen);
    // Only allow same-origin URLs
    if (url.origin !== self.location.origin) {
      logError('Blocked cross-origin URL:', urlToOpen);
      urlToOpen = self.location.origin + '/';
    }
  } catch (e) {
    logError('Invalid URL:', urlToOpen);
    urlToOpen = self.location.origin + '/';
  }

  log('Opening URL:', urlToOpen);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        log('Found clients:', windowClients.length);

        // Check if there's already a window open with our app
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin)) {
            log('Found existing client');
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
        log('No existing client, opening new window');
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
      .catch((error) => {
        logError('Error handling notification click:', error.message);
        // Fallback: try to open new window
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

self.addEventListener('notificationclose', (event) => {
  log('Notification closed');
});

// Force activation of new service worker
self.addEventListener('install', (event) => {
  log('Installing new version:', SW_VERSION);
  // Skip waiting to activate immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  log('Activating new version:', SW_VERSION);
  // Take control of all clients immediately
  event.waitUntil(clients.claim());
});

// Handle subscription change
// Note: This handler cannot send authenticated requests from the service worker.
// The subscription will need to be re-established by the main app on next load.
self.addEventListener('pushsubscriptionchange', (event) => {
  log('Push subscription changed - user will need to re-subscribe on next app load');

  // Notify the app that subscription changed (if any window is open)
  event.waitUntil(
    clients.matchAll({ type: 'window' })
      .then((windowClients) => {
        windowClients.forEach((client) => {
          client.postMessage({
            type: 'PUSH_SUBSCRIPTION_CHANGED',
            message: 'Push subscription expired or changed'
          });
        });
      })
      .catch((error) => {
        logError('Error notifying clients about subscription change:', error.message);
      })
  );
});
