// Push notification service worker
// Version: 2.6 - Improved subscription change handling, URL validation

const SW_VERSION = '2.6';

// Debug logging - enabled temporarily for troubleshooting
const DEBUG = true;
const log = (...args) => DEBUG && console.log('[SW]', ...args);
const logError = (...args) => console.error('[SW]', ...args);

log('Push service worker loaded, version:', SW_VERSION);

// Allowed route prefixes for notification deep links
const ALLOWED_ROUTES = ['/app', '/crm', '/tasks', '/messages', '/admin', '/pages', '/settings'];

self.addEventListener('push', (event) => {
  log('Push received');

  let data = {
    title: 'Prpl CRM',
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

// Validate and sanitize notification URL
function sanitizeNotificationUrl(rawUrl) {
  try {
    let url = rawUrl || '/app';

    // Ensure it starts with /
    if (!url.startsWith('/') && !url.startsWith(self.location.origin)) {
      return self.location.origin + '/app';
    }

    // Make absolute
    if (url.startsWith('/')) {
      url = self.location.origin + url;
    }

    const parsed = new URL(url);

    // Block cross-origin
    if (parsed.origin !== self.location.origin) {
      logError('Blocked cross-origin URL:', url);
      return self.location.origin + '/app';
    }

    // Normalize path — resolve ../ and double slashes
    const normalizedPath = parsed.pathname.replace(/\/+/g, '/');

    // Whitelist check — must start with an allowed route (or be /)
    if (normalizedPath !== '/' && !ALLOWED_ROUTES.some(route => normalizedPath.startsWith(route))) {
      logError('Blocked non-whitelisted route:', normalizedPath);
      return self.location.origin + '/app';
    }

    // Reconstruct safe URL
    parsed.pathname = normalizedPath;
    return parsed.toString();
  } catch (e) {
    logError('Invalid URL:', rawUrl);
    return self.location.origin + '/app';
  }
}

self.addEventListener('notificationclick', (event) => {
  log('Notification clicked');
  log('Notification data:', JSON.stringify(event.notification.data));

  event.notification.close();

  let urlToOpen = sanitizeNotificationUrl(event.notification.data?.url);
  log('Sanitized URL:', urlToOpen);

  // Add timestamp to URL to force navigation even when app is already on the same page
  const urlWithTimestamp = new URL(urlToOpen);
  urlWithTimestamp.searchParams.set('_t', Date.now().toString());
  urlToOpen = urlWithTimestamp.toString();

  log('Final URL to open:', urlToOpen);

  // For PWA: find existing window and use postMessage, or open new window
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        log('Found clients:', windowClients.length);

        // Find a client that belongs to our app
        for (const client of windowClients) {
          log('Checking client:', client.url, 'visibilityState:', client.visibilityState);
          if (client.url.includes(self.location.origin)) {
            log('Found existing PWA client, sending message');
            // Send navigation message to the client
            client.postMessage({
              type: 'NOTIFICATION_CLICK',
              url: urlToOpen,
              data: event.notification.data,
              timestamp: Date.now()
            });
            // Focus the window
            if (client.focus) {
              return client.focus().catch(err => {
                log('Focus failed:', err.message);
                return client;
              });
            }
            return client;
          }
        }

        // No existing window found, open new one
        log('No existing client, opening new window');
        return clients.openWindow(urlToOpen);
      })
      .catch((error) => {
        logError('Error handling notification click:', error.message);
        return clients.openWindow(urlToOpen);
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
// Try to re-subscribe automatically using the existing VAPID key from old subscription.
// If no window is open, save a flag so the app re-subscribes on next load.
self.addEventListener('pushsubscriptionchange', (event) => {
  log('Push subscription changed - attempting auto-resubscribe');

  event.waitUntil(
    (async () => {
      try {
        // Try to resubscribe with the old subscription's options
        const oldSub = event.oldSubscription;
        if (oldSub) {
          const newSub = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: oldSub.options.applicationServerKey
          });
          log('Auto-resubscribed successfully');

          // Notify open windows to persist the new subscription to server
          const windowClients = await clients.matchAll({ type: 'window' });
          for (const client of windowClients) {
            client.postMessage({
              type: 'PUSH_SUBSCRIPTION_CHANGED',
              newSubscription: newSub.toJSON(),
              message: 'Push subscription auto-renewed'
            });
          }

          // If no window open, cache in IndexedDB for next app load
          if (windowClients.length === 0) {
            log('No window open — caching new subscription for next load');
            // Use a simple cache approach
            const cache = await caches.open('push-subscription-cache');
            await cache.put(
              new Request('/_push_resubscribe'),
              new Response(JSON.stringify(newSub.toJSON()))
            );
          }
        }
      } catch (error) {
        logError('Auto-resubscribe failed:', error.message);
        // Notify clients to handle manually
        const windowClients = await clients.matchAll({ type: 'window' });
        for (const client of windowClients) {
          client.postMessage({
            type: 'PUSH_SUBSCRIPTION_CHANGED',
            error: error.message,
            message: 'Push subscription expired - please re-enable notifications'
          });
        }
      }
    })()
  );
});
