const Notification = require('../models/Notification');
const User = require('../models/User');
const WorkspaceMember = require('../models/WorkspaceMember');
const PushSubscription = require('../models/PushSubscription');
const APNsDevice = require('../models/APNsDevice');
const webpush = require('web-push');
const http2 = require('http2');
const crypto = require('crypto');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Notification Service
 * Handles creating and sending notifications to users
 */

// Store io instance
let io = null;

// VAPID configuration status
let vapidConfigured = false;

// Metrics for monitoring
const metrics = {
  notifications: {
    created: 0,
    socketEmitted: 0,
    pushSent: 0,
    pushFailed: 0,
    subscriptionsRemoved: 0
  },
  lastReset: new Date(),
  errors: []
};

// Keep only last 50 errors
const MAX_ERRORS = 50;

// Configure web-push with VAPID keys (if available)
const initializeVapid = () => {
  if (vapidConfigured) return true;

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@prplcrm.sk',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
      vapidConfigured = true;
      logger.info('[NotificationService] VAPID configured successfully');
    } catch (error) {
      logger.error('[NotificationService] Failed to configure VAPID', { error: error.message });
      vapidConfigured = false;
    }
  } else {
    logger.warn('[NotificationService] VAPID keys not configured - push notifications disabled');
  }

  return vapidConfigured;
};

// Initialize VAPID on module load
initializeVapid();

// ===== APNs via native HTTP/2 (replaces unmaintained 'apn' library) =====

let apnConfigured = false;
let apnKeyId = null;
let apnTeamId = null;
let apnPrivateKey = null;
let apnJwtToken = null;
let apnJwtIssuedAt = 0;

const APNS_TOPIC = 'sk.perunelectromobility.prplcrm';
const APNS_HOST_PRODUCTION = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';

const initializeAPNs = () => {
  if (apnConfigured) return true;

  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;

  if (keyId && teamId) {
    try {
      let keyContent;
      if (process.env.APNS_KEY_BASE64) {
        keyContent = Buffer.from(process.env.APNS_KEY_BASE64, 'base64').toString('utf8');
      } else if (process.env.APNS_KEY) {
        keyContent = process.env.APNS_KEY.replace(/\\n/g, '\n');
      } else {
        const fs = require('fs');
        const keyPath = process.env.APNS_KEY_PATH || path.join(__dirname, '..', 'config', 'AuthKey.p8');
        keyContent = fs.readFileSync(keyPath, 'utf8');
      }

      // Verify key is valid by creating a test key object
      crypto.createPrivateKey(keyContent);

      apnKeyId = keyId;
      apnTeamId = teamId;
      apnPrivateKey = keyContent;
      apnConfigured = true;
      logger.info('[APNs] Configured with native HTTP/2', { keyId, teamId });
    } catch (err) {
      logger.warn('[APNs] Initialization failed', { error: err.message });
    }
  } else {
    logger.debug('[APNs] Not configured (missing APNS_KEY_ID or APNS_TEAM_ID)');
  }
  return apnConfigured;
};

// Generate JWT for APNs authentication (refreshed every 30 minutes)
const getApnJwt = () => {
  const now = Math.floor(Date.now() / 1000);
  // Refresh every 30 minutes (Apple tokens valid for 1 hour)
  if (apnJwtToken && (now - apnJwtIssuedAt) < 1800) {
    return apnJwtToken;
  }

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: apnKeyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: apnTeamId, iat: now })).toString('base64url');
  const signingInput = `${header}.${claims}`;

  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  const signature = sign.sign(apnPrivateKey);

  // Convert DER signature to raw r||s format for JWT ES256
  const derToRaw = (derSig) => {
    let offset = 2;
    const rLen = derSig[offset + 1];
    offset += 2;
    let r = derSig.slice(offset, offset + rLen);
    offset += rLen + 2;
    const sLen = derSig[offset - 1];
    let s = derSig.slice(offset, offset + sLen);
    // Ensure 32 bytes each
    if (r.length > 32) r = r.slice(r.length - 32);
    if (s.length > 32) s = s.slice(s.length - 32);
    if (r.length < 32) r = Buffer.concat([Buffer.alloc(32 - r.length), r]);
    if (s.length < 32) s = Buffer.concat([Buffer.alloc(32 - s.length), s]);
    return Buffer.concat([r, s]);
  };

  const rawSig = derToRaw(signature);
  const sig64 = rawSig.toString('base64url');

  apnJwtToken = `${signingInput}.${sig64}`;
  apnJwtIssuedAt = now;
  return apnJwtToken;
};

// Send a single notification to APNs via HTTP/2
const sendToAPNs = (deviceToken, payload, sandbox = false) => {
  return new Promise((resolve, reject) => {
    const host = sandbox ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;
    const jwt = getApnJwt();

    let client;
    try {
      client = http2.connect(`https://${host}`);
    } catch (err) {
      return reject(new Error(`HTTP/2 connect failed: ${err.message}`));
    }

    client.on('error', (err) => {
      logger.warn('[APNs HTTP/2] Connection error', { error: err.message, host });
      reject(err);
    });

    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': APNS_TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
      'content-type': 'application/json'
    };

    const req = client.request(headers);
    let responseData = '';
    let statusCode = 0;

    req.on('response', (hdrs) => {
      statusCode = hdrs[':status'];
    });

    req.on('data', (chunk) => {
      responseData += chunk;
    });

    req.on('end', () => {
      client.close();
      if (statusCode === 200) {
        resolve({ success: true, status: statusCode });
      } else {
        let reason = 'Unknown';
        try {
          const parsed = JSON.parse(responseData);
          reason = parsed.reason || reason;
        } catch {}
        resolve({ success: false, status: statusCode, reason });
      }
    });

    req.on('error', (err) => {
      client.close();
      reject(err);
    });

    req.write(JSON.stringify(payload));
    req.end();

    // Timeout after 10s
    setTimeout(() => {
      try { client.close(); } catch {}
      reject(new Error('APNs request timeout'));
    }, 10000);
  });
};

// Initialize APNs on module load
initializeAPNs();

const getAPNsStatus = () => ({
  configured: apnConfigured,
  topic: APNS_TOPIC,
  keyId: process.env.APNS_KEY_ID ? '***' + process.env.APNS_KEY_ID.slice(-4) : null,
  teamId: process.env.APNS_TEAM_ID ? '***' + process.env.APNS_TEAM_ID.slice(-4) : null,
  providers: { production: apnConfigured, sandbox: apnConfigured }
});

/**
 * Send APNs push notification to iOS devices via native HTTP/2
 */
const sendAPNsNotification = async (userId, payload) => {
  if (!apnConfigured) return { sent: 0, failed: 0 };

  const result = { sent: 0, failed: 0, removed: 0 };

  try {
    const devices = await APNsDevice.find({ userId });
    if (devices.length === 0) return result;

    const url = generateNotificationUrl(payload.type, payload.data);
    const baseUrl = process.env.CLIENT_URL || 'https://prplcrm.eu';

    const apnsPayload = {
      aps: {
        alert: {
          title: String(payload.title).slice(0, 100),
          body: String(payload.body || payload.message || '').slice(0, 200)
        },
        badge: 1,
        sound: 'default',
        'mutable-content': 1,
        'interruption-level': 'active',
        'relevance-score': 1.0,
        'thread-id': payload.type || 'default'
      },
      url: url,
      type: payload.type,
      ...(payload.data || {})
    };

    for (const device of devices) {
      try {
        // Try primary environment (saved or sandbox for Xcode builds)
        const primarySandbox = device.apnsEnvironment === 'sandbox' || !device.apnsEnvironment;
        let res = await sendToAPNs(device.deviceToken, apnsPayload, primarySandbox);

        if (res.success) {
          result.sent++;
          device.lastUsed = new Date();
          if (!device.apnsEnvironment) {
            device.apnsEnvironment = primarySandbox ? 'sandbox' : 'production';
          }
          await device.save();
          continue;
        }

        // If primary failed with token error, try the other environment
        if (res.reason === 'BadDeviceToken' || res.reason === 'DeviceTokenNotForTopic' || res.reason === 'Unregistered') {
          logger.info('[APNs] Primary failed, trying fallback', { reason: res.reason, primarySandbox });
          const fallbackRes = await sendToAPNs(device.deviceToken, apnsPayload, !primarySandbox);

          if (fallbackRes.success) {
            result.sent++;
            device.lastUsed = new Date();
            device.apnsEnvironment = !primarySandbox ? 'sandbox' : 'production';
            await device.save();
            logger.info('[APNs] Fallback succeeded', { env: device.apnsEnvironment });
            continue;
          }
        }

        // Both failed — remove truly invalid tokens
        result.failed++;
        if (res.status === 410 || res.reason === 'Unregistered') {
          await APNsDevice.deleteOne({ _id: device._id });
          result.removed++;
          logger.info('[APNs] Removed invalid device', { reason: res.reason });
        } else {
          logger.warn('[APNs] Send failed', { reason: res.reason, status: res.status });
        }
      } catch (err) {
        result.failed++;
        logger.warn('[APNs] Send error', { error: err.message });
      }
    }

    if (result.sent > 0 || result.failed > 0) {
      logger.info('[APNs] Results', { userId, ...result });
    }
  } catch (error) {
    logger.error('[APNs] Error', { error: error.message, userId });
  }

  return result;
};

/**
 * Debug version of sendAPNsNotification — returns detailed info for each device
 */
const sendAPNsDebug = async (userId, payload) => {
  const debug = { apnConfigured, devices: [], results: [] };

  if (!apnConfigured) {
    debug.error = 'APNs not configured';
    return debug;
  }

  try {
    const devices = await APNsDevice.find({ userId });
    debug.deviceCount = devices.length;
    debug.devices = devices.map(d => ({
      tokenPrefix: d.deviceToken.substring(0, 16),
      environment: d.apnsEnvironment || 'unknown',
      bundleId: d.bundleId,
      lastUsed: d.lastUsed
    }));

    if (devices.length === 0) {
      debug.error = 'No registered devices';
      return debug;
    }

    const apnsPayload = {
      aps: {
        alert: {
          title: String(payload.title).slice(0, 100),
          body: String(payload.body || '').slice(0, 200)
        },
        badge: 1,
        sound: 'default',
        'mutable-content': 1
      },
      type: payload.type || 'test'
    };

    for (const device of devices) {
      const deviceDebug = {
        tokenPrefix: device.deviceToken.substring(0, 16),
        savedEnv: device.apnsEnvironment || 'unknown',
        attempts: []
      };

      // Try primary (default to sandbox for Xcode builds)
      const primarySandbox = device.apnsEnvironment === 'sandbox' || !device.apnsEnvironment;
      const primaryEnv = primarySandbox ? 'sandbox' : 'production';

      try {
        const res1 = await sendToAPNs(device.deviceToken, apnsPayload, primarySandbox);
        deviceDebug.attempts.push({
          provider: primaryEnv,
          success: res1.success,
          status: res1.status,
          reason: res1.reason || null
        });

        if (res1.success) {
          deviceDebug.result = 'SUCCESS via ' + primaryEnv;
          debug.results.push(deviceDebug);
          continue;
        }

        // Try fallback environment
        const fallbackEnv = primarySandbox ? 'production' : 'sandbox';
        const res2 = await sendToAPNs(device.deviceToken, apnsPayload, !primarySandbox);
        deviceDebug.attempts.push({
          provider: fallbackEnv,
          success: res2.success,
          status: res2.status,
          reason: res2.reason || null
        });

        if (res2.success) {
          deviceDebug.result = 'SUCCESS via ' + fallbackEnv;
        } else {
          deviceDebug.result = 'FAILED both environments';
        }
      } catch (err) {
        deviceDebug.attempts.push({ error: err.message });
        deviceDebug.result = 'ERROR: ' + err.message;
      }

      debug.results.push(deviceDebug);
    }
  } catch (error) {
    debug.error = error.message;
  }

  return debug;
};

/**
 * Initialize the notification service with Socket.IO instance
 */
const initialize = (socketIo) => {
  io = socketIo;
};

/**
 * Generate URL for navigation based on notification type and data
 */
const generateNotificationUrl = (type, data = {}) => {
  logger.debug('[NotificationService] generateNotificationUrl', { type, data });

  // Contact notifications -> /crm with contact expansion
  if (type?.startsWith('contact') && data.contactId) {
    const url = `/crm?expandContact=${data.contactId}`;
    logger.debug('[NotificationService] Generated contact URL', { url });
    return url;
  }

  // Task notifications -> /tasks with task highlight
  if (type?.startsWith('task') && data.taskId) {
    let url = `/tasks?highlightTask=${data.taskId}`;
    if (data.contactId) {
      url += `&contactId=${data.contactId}`;
    }
    logger.debug('[NotificationService] Generated task URL', { url });
    return url;
  }

  // Subtask notifications -> /tasks with parent task highlight
  if (type?.startsWith('subtask') && data.taskId) {
    let url = `/tasks?highlightTask=${data.taskId}&subtask=${data.subtaskId || ''}`;
    if (data.contactId) {
      url += `&contactId=${data.contactId}`;
    }
    logger.debug('[NotificationService] Generated subtask URL', { url });
    return url;
  }

  // Message notifications -> /messages with message highlight
  if (type?.startsWith('message') && data.messageId) {
    const url = `/messages?highlight=${data.messageId}`;
    logger.debug('[NotificationService] Generated message URL', { url });
    return url;
  }

  // Workspace notifications -> /app (dashboard)
  if (type?.startsWith('workspace')) {
    logger.debug('[NotificationService] Workspace notification, returning /app');
    return '/app';
  }

  // Fallback: try to determine URL from data fields alone
  if (data.messageId) {
    const url = `/messages?highlight=${data.messageId}`;
    logger.debug('[NotificationService] Fallback: generated message URL from data', { url });
    return url;
  }
  if (data.contactId && !data.taskId) {
    const url = `/crm?expandContact=${data.contactId}`;
    logger.debug('[NotificationService] Fallback: generated contact URL from data', { url });
    return url;
  }
  if (data.taskId) {
    let url = `/tasks?highlightTask=${data.taskId}`;
    if (data.contactId) url += `&contactId=${data.contactId}`;
    logger.debug('[NotificationService] Fallback: generated task URL from data', { url });
    return url;
  }

  logger.warn('[NotificationService] No URL match, returning /app', { type, data });
  return '/app';
};

/**
 * Send push notification to a user
 * @param {string} userId - User ID to send notification to
 * @param {Object} payload - Notification payload
 * @returns {Object} Result with sent/failed counts
 */
const sendPushNotification = async (userId, payload) => {
  const result = { sent: 0, failed: 0, removed: 0 };

  // Check VAPID configuration
  if (!vapidConfigured) {
    logger.debug('[Push] VAPID not configured, skipping push notification');
    return result;
  }

  // Validate payload
  if (!payload || !payload.title) {
    logger.warn('[Push] Invalid payload - missing title');
    return result;
  }

  try {
    const subscriptions = await PushSubscription.find({ userId });

    if (subscriptions.length === 0) {
      logger.debug('[Push] No subscriptions found for user', { userId });
      return result;
    }

    // Generate URL based on notification type
    const url = generateNotificationUrl(payload.type, payload.data);

    // Sanitize and limit payload sizes
    const sanitizedTitle = String(payload.title).slice(0, 100);
    const sanitizedBody = String(payload.body || payload.message || '').slice(0, 200);

    const pushPayload = JSON.stringify({
      title: sanitizedTitle,
      body: sanitizedBody,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      data: {
        url,
        type: payload.type,
        ...payload.data
      },
      tag: payload.tag || payload.type || 'default'
    });

    for (const sub of subscriptions) {
      let sent = false;
      const maxRetries = 2;

      for (let attempt = 0; attempt <= maxRetries && !sent; attempt++) {
        try {
          await webpush.sendNotification({
            endpoint: sub.endpoint,
            keys: sub.keys
          }, pushPayload);

          // Update last used timestamp
          sub.lastUsed = new Date();
          await sub.save();
          result.sent++;
          metrics.notifications.pushSent++;
          sent = true;
        } catch (error) {
          // Remove invalid subscriptions immediately — no retry needed
          if (error.statusCode === 410 || error.statusCode === 404) {
            await PushSubscription.deleteOne({ _id: sub._id });
            result.removed++;
            metrics.notifications.subscriptionsRemoved++;
            logger.info('[Push] Removed invalid subscription', {
              endpoint: sub.endpoint.substring(0, 50) + '...'
            });
            break;
          }

          // Retry on transient errors (429, 5xx, network)
          const isRetryable = !error.statusCode || error.statusCode === 429 || error.statusCode >= 500;
          if (isRetryable && attempt < maxRetries) {
            const delay = Math.pow(2, attempt + 1) * 500; // 1s, 2s
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          // Final failure
          result.failed++;
          metrics.notifications.pushFailed++;
          logger.warn('[Push] Notification failed', {
            endpoint: sub.endpoint.substring(0, 50) + '...',
            statusCode: error.statusCode,
            message: error.message,
            attempts: attempt + 1
          });
        }
      }
    }

    logger.debug('[Push] Notification batch completed', { userId, ...result });
    return result;
  } catch (error) {
    logger.error('[Push] Error sending notifications', { error: error.message, userId });
    return result;
  }
};

/**
 * Send web push only to non-iOS subscriptions (desktop browsers)
 * iOS WKWebView push subscriptions use web.push.apple.com endpoints
 */
const sendPushNotificationExcludeIOS = async (userId, payload) => {
  const result = { sent: 0, failed: 0, removed: 0 };
  if (!vapidConfigured || !payload?.title) return result;

  try {
    const subscriptions = await PushSubscription.find({ userId });
    if (subscriptions.length === 0) return result;

    // Filter out iOS subscriptions (Apple push endpoints)
    const desktopSubs = subscriptions.filter(sub =>
      !sub.endpoint.includes('web.push.apple.com') &&
      !sub.endpoint.includes('windows.push.apple.com')
    );

    if (desktopSubs.length === 0) return result;

    const url = generateNotificationUrl(payload.type, payload.data);
    const pushPayload = JSON.stringify({
      title: String(payload.title).slice(0, 100),
      body: String(payload.body || payload.message || '').slice(0, 200),
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      data: { url, type: payload.type, ...payload.data },
      tag: payload.tag || payload.type || 'default'
    });

    for (const sub of desktopSubs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, pushPayload);
        sub.lastUsed = new Date();
        await sub.save();
        result.sent++;
      } catch (error) {
        if (error.statusCode === 410 || error.statusCode === 404) {
          await PushSubscription.deleteOne({ _id: sub._id });
          result.removed++;
        } else {
          result.failed++;
        }
      }
    }
  } catch (error) {
    logger.error('[Push] Error sending desktop notifications', { error: error.message, userId });
  }

  return result;
};

/**
 * Create a notification for a specific user
 */
const createNotification = async ({
  userId,
  type,
  title,
  message = '',
  actorId = null,
  actorName = null,
  relatedType = null,
  relatedId = null,
  relatedName = null,
  data = {}
}) => {
  try {
    const notification = new Notification({
      userId,
      type,
      title,
      message,
      actorId,
      actorName,
      relatedType,
      relatedId,
      relatedName,
      data
    });

    await notification.save();
    metrics.notifications.created++;

    // Send real-time notification via Socket.IO
    if (io) {
      io.to(`user-${userId}`).emit('notification', {
        id: notification._id.toString(),
        type: notification.type,
        title: notification.title,
        message: notification.message,
        actorName: notification.actorName,
        relatedType: notification.relatedType,
        relatedId: notification.relatedId,
        relatedName: notification.relatedName,
        data: notification.data,
        read: notification.read,
        createdAt: notification.createdAt
      });
      metrics.notifications.socketEmitted++;
    }

    // Send push notifications — prefer APNs for iOS, web push for desktop
    const pushPayload = {
      title: notification.title,
      body: notification.message,
      type: notification.type,
      data: notification.data
    };

    // Check if user has APNs devices — if so, use APNs only (avoid duplicate on iOS)
    const apnsDevices = apnConfigured ? await APNsDevice.find({ userId }) : [];
    if (apnsDevices.length > 0) {
      await sendAPNsNotification(userId, pushPayload);
      // Send web push only to non-iOS subscriptions (desktop browsers)
      await sendPushNotificationExcludeIOS(userId, pushPayload);
    } else {
      // No APNs devices — send web push to all subscriptions
      await sendPushNotification(userId, pushPayload);
    }

    return notification;
  } catch (error) {
    logger.error('[NotificationService] Error creating notification', { error: error.message, userId, type });
    // Track error
    metrics.errors.push({
      timestamp: new Date(),
      type: 'createNotification',
      message: error.message,
      context: { userId, type }
    });
    if (metrics.errors.length > MAX_ERRORS) {
      metrics.errors.shift();
    }
    return null;
  }
};

/**
 * Notify multiple users about an event
 */
const notifyUsers = async (userIds, notificationData) => {
  const notifications = [];
  for (const userId of userIds) {
    const notification = await createNotification({
      ...notificationData,
      userId
    });
    if (notification) {
      notifications.push(notification);
    }
  }
  return notifications;
};

/**
 * Notify all workspace members except the actor
 * @param {string} excludeUserId - User ID to exclude (the actor)
 * @param {string} workspaceId - Workspace ID to filter members
 * @param {Object} notificationData - Notification payload
 */
const notifyAllExcept = async (excludeUserId, notificationData, workspaceId) => {
  try {
    if (!workspaceId) {
      logger.warn('[NotificationService] notifyAllExcept called without workspaceId, skipping');
      return [];
    }
    const members = await WorkspaceMember.find({ workspaceId }, 'userId').lean();
    const userIds = members
      .map(m => m.userId.toString())
      .filter(id => id !== excludeUserId?.toString());
    return await notifyUsers(userIds, notificationData);
  } catch (error) {
    logger.error('[NotificationService] Error notifying workspace members', { error: error.message, workspaceId });
    return [];
  }
};

/**
 * Get notification title based on type
 */
const getNotificationTitle = (type, actorName, relatedName) => {
  const actor = actorName || 'Niekto';
  const related = relatedName || '';

  switch (type) {
    case 'contact.created':
      return `Nový kontakt: ${related || 'bez názvu'}`;
    case 'contact.updated':
      return `Kontakt upravený: ${related || 'bez názvu'}`;
    case 'contact.deleted':
      return `Kontakt vymazaný: ${related || 'bez názvu'}`;
    case 'task.created':
      return `Nový projekt: ${related || 'bez názvu'}`;
    case 'task.updated':
      return `Projekt upravený: ${related || 'bez názvu'}`;
    case 'task.completed':
      return `Projekt dokončený: ${related || 'bez názvu'}`;
    case 'task.deleted':
      return `Projekt vymazaný: ${related || 'bez názvu'}`;
    case 'task.assigned':
      return `Priradený projekt: ${related || 'bez názvu'}`;
    case 'subtask.created':
      return `Nová úloha: ${related || 'bez názvu'}`;
    case 'subtask.updated':
      return `Úloha upravená: ${related || 'bez názvu'}`;
    case 'subtask.completed':
      return `Úloha dokončená: ${related || 'bez názvu'}`;
    case 'subtask.deleted':
      return `Úloha vymazaná: ${related || 'bez názvu'}`;
    case 'subtask.assigned':
      return `Priradená úloha: ${related || 'bez názvu'}`;
    case 'task.dueDate':
    case 'subtask.dueDate':
      return related || 'Blíži sa termín';
    default:
      return 'Nová notifikácia';
  }
};

/**
 * Get notification message (description) based on type
 */
const getNotificationMessage = (type, actorName, data = {}) => {
  const actor = actorName || 'Niekto';
  const contactName = data.contactName || '';
  const taskTitle = data.taskTitle || '';

  switch (type) {
    case 'contact.created':
      return `${actor} vytvoril nový kontakt`;
    case 'contact.updated':
      return `${actor} upravil tento kontakt`;
    case 'contact.deleted':
      return `${actor} vymazal tento kontakt`;
    case 'task.created':
      return contactName
        ? `${actor} vytvoril projekt pre kontakt "${contactName}"`
        : `${actor} vytvoril nový projekt`;
    case 'task.updated':
      return contactName
        ? `${actor} upravil projekt v kontakte "${contactName}"`
        : `${actor} upravil tento projekt`;
    case 'task.completed':
      return contactName
        ? `${actor} dokončil projekt v kontakte "${contactName}"`
        : `${actor} dokončil tento projekt`;
    case 'task.deleted':
      return contactName
        ? `${actor} vymazal projekt z kontaktu "${contactName}"`
        : `${actor} vymazal tento projekt`;
    case 'task.assigned':
      return contactName
        ? `${actor} vám priradil projekt v kontakte "${contactName}"`
        : `${actor} vám priradil tento projekt`;
    case 'subtask.created':
      return taskTitle
        ? `${actor} pridal úlohu k projektu "${taskTitle}"`
        : `${actor} pridal novú úlohu`;
    case 'subtask.updated':
      return taskTitle
        ? `${actor} upravil úlohu v projekte "${taskTitle}"`
        : `${actor} upravil úlohu`;
    case 'subtask.completed':
      return taskTitle
        ? `${actor} dokončil úlohu v projekte "${taskTitle}"`
        : `${actor} dokončil úlohu`;
    case 'subtask.deleted':
      return taskTitle
        ? `${actor} vymazal úlohu z projektu "${taskTitle}"`
        : `${actor} vymazal úlohu`;
    case 'subtask.assigned':
      return taskTitle
        ? `${actor} vám priradil úlohu v projekte "${taskTitle}"`
        : `${actor} vám priradil túto úlohu`;
    default:
      return '';
  }
};

/**
 * Helper to create contact notification
 * @param {string} type - Notification type
 * @param {Object} contact - Contact object
 * @param {Object} actor - User who performed the action
 * @param {string} workspaceId - Workspace ID to filter recipients
 * @param {boolean} excludeActorId - Whether to exclude the actor from recipients
 */
const notifyContactChange = async (type, contact, actor, workspaceId, excludeActorId = true) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle(type, actorName, contact.name);
  const message = getNotificationMessage(type, actorName, {});

  const notificationData = {
    type,
    title,
    message,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'contact',
    relatedId: contact._id?.toString() || contact.id,
    relatedName: contact.name,
    data: { contactId: contact._id?.toString() || contact.id }
  };

  if (!workspaceId) {
    logger.warn('[NotificationService] notifyContactChange called without workspaceId, skipping');
    return [];
  }

  if (excludeActorId && actor) {
    return await notifyAllExcept(actor._id || actor.id, notificationData, workspaceId);
  } else {
    const members = await WorkspaceMember.find({ workspaceId }, 'userId').lean();
    return await notifyUsers(members.map(m => m.userId.toString()), notificationData);
  }
};

/**
 * Helper to create task notification
 * @param {string} type - Notification type
 * @param {Object} task - Task object
 * @param {Object} actor - User who performed the action
 * @param {Array} excludeUserIds - User IDs to exclude from notification (e.g., newly assigned users who get separate notification)
 */
const notifyTaskChange = async (type, task, actor, excludeUserIds = [], workspaceId = null) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle(type, actorName, task.title);
  const message = getNotificationMessage(type, actorName, { contactName: task.contactName });

  logger.debug('[NotificationService] Task change', { type, taskTitle: task.title, actorName, excludeUserIds, workspaceId });

  const notificationData = {
    type,
    title,
    message,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'task',
    relatedId: task._id?.toString() || task.id,
    relatedName: task.title,
    data: {
      taskId: task._id?.toString() || task.id,
      contactId: task.contactId,
      contactName: task.contactName
    }
  };

  // Use workspace-based notification if workspaceId is available
  if (workspaceId) {
    try {
      const members = await WorkspaceMember.find({ workspaceId }, 'userId').lean();
      const recipientIds = members
        .map(m => m.userId.toString())
        .filter(id => {
          if (actor && id === (actor._id || actor.id).toString()) return false;
          if (excludeUserIds && Array.isArray(excludeUserIds)) {
            return !excludeUserIds.some(exId => exId && exId.toString() === id);
          }
          return true;
        });

      if (recipientIds.length === 0) {
        logger.debug('[NotificationService] No workspace recipients for task notification');
        return [];
      }
      return await notifyUsers(recipientIds, notificationData);
    } catch (error) {
      logger.error('[NotificationService] Error fetching workspace members for task notification', { error: error.message });
      return [];
    }
  }

  // Fallback: notify assigned users only (legacy behavior)
  const recipientIds = new Set();
  if (task.assignedTo && Array.isArray(task.assignedTo)) {
    task.assignedTo.forEach(id => {
      if (id) recipientIds.add(id.toString());
    });
  }
  if (actor) recipientIds.delete((actor._id || actor.id).toString());
  if (excludeUserIds && Array.isArray(excludeUserIds)) {
    excludeUserIds.forEach(id => { if (id) recipientIds.delete(id.toString()); });
  }

  if (recipientIds.size === 0) return [];
  return await notifyUsers(Array.from(recipientIds), notificationData);
};

/**
 * Notify about task assignment
 */
const notifyTaskAssignment = async (task, assignedUserIds, actor) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle('task.assigned', actorName, task.title);
  const message = getNotificationMessage('task.assigned', actorName, { contactName: task.contactName });

  logger.info('[NotificationService] Task assignment notification', {
    actorName,
    actorId: actor?.id || actor?._id,
    taskTitle: task.title,
    contactName: task.contactName,
    title,
    message,
    assignedUserIds
  });

  const notificationData = {
    type: 'task.assigned',
    title,
    message,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'task',
    relatedId: task._id?.toString() || task.id,
    relatedName: task.title,
    data: {
      taskId: task._id?.toString() || task.id,
      contactId: task.contactId,
      contactName: task.contactName
    }
  };

  // Filter out the actor from recipients
  const recipients = assignedUserIds.filter(id =>
    id && id.toString() !== (actor?._id || actor?.id)?.toString()
  );

  return await notifyUsers(recipients, notificationData);
};

/**
 * Notify about subtask assignment
 */
const notifySubtaskAssignment = async (subtask, parentTask, assignedUserIds, actor) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle('subtask.assigned', actorName, subtask.title);
  const message = getNotificationMessage('subtask.assigned', actorName, { taskTitle: parentTask.title });

  logger.debug('[NotificationService] Subtask assignment', { subtaskTitle: subtask.title, parentTaskTitle: parentTask.title, assignedUserIds, actorName });

  const notificationData = {
    type: 'subtask.assigned',
    title,
    message,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'subtask',
    relatedId: subtask.id,
    relatedName: subtask.title,
    data: {
      subtaskId: subtask.id,
      taskId: parentTask._id?.toString() || parentTask.id,
      taskTitle: parentTask.title,
      contactId: parentTask.contactId
    }
  };

  // Filter out the actor from recipients
  const recipients = assignedUserIds.filter(id =>
    id && id.toString() !== (actor?._id || actor?.id)?.toString()
  );

  return await notifyUsers(recipients, notificationData);
};

/**
 * Helper to create subtask notification
 * @param {string} type - Notification type
 * @param {Object} subtask - Subtask object
 * @param {Object} parentTask - Parent task object
 * @param {Object} actor - User who performed the action
 * @param {Array} excludeUserIds - User IDs to exclude from notification (e.g., newly assigned users who get separate notification)
 */
const notifySubtaskChange = async (type, subtask, parentTask, actor, excludeUserIds = [], workspaceId = null) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle(type, actorName, subtask.title);
  const message = getNotificationMessage(type, actorName, { taskTitle: parentTask.title });

  logger.debug('[NotificationService] Subtask change', { type, subtaskTitle: subtask.title, parentTaskTitle: parentTask.title, actorName, excludeUserIds, workspaceId });

  const notificationData = {
    type,
    title,
    message,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'subtask',
    relatedId: subtask.id,
    relatedName: subtask.title,
    data: {
      subtaskId: subtask.id,
      taskId: parentTask._id?.toString() || parentTask.id,
      taskTitle: parentTask.title,
      contactId: parentTask.contactId
    }
  };

  // Use workspace-based notification if workspaceId is available
  if (workspaceId) {
    try {
      const members = await WorkspaceMember.find({ workspaceId }, 'userId').lean();
      const recipientIds = members
        .map(m => m.userId.toString())
        .filter(id => {
          if (actor && id === (actor._id || actor.id).toString()) return false;
          if (excludeUserIds && Array.isArray(excludeUserIds)) {
            return !excludeUserIds.some(exId => exId && exId.toString() === id);
          }
          return true;
        });

      if (recipientIds.length === 0) return [];
      return await notifyUsers(recipientIds, notificationData);
    } catch (error) {
      logger.error('[NotificationService] Error fetching workspace members for subtask notification', { error: error.message });
      return [];
    }
  }

  // Fallback: notify parent task's assigned users only
  const recipientIds = new Set();
  if (parentTask.assignedTo && Array.isArray(parentTask.assignedTo)) {
    parentTask.assignedTo.forEach(id => { if (id) recipientIds.add(id.toString()); });
  }
  if (actor) recipientIds.delete((actor._id || actor.id).toString());
  if (excludeUserIds && Array.isArray(excludeUserIds)) {
    excludeUserIds.forEach(id => { if (id) recipientIds.delete(id.toString()); });
  }

  if (recipientIds.size === 0) return [];
  return await notifyUsers(Array.from(recipientIds), notificationData);
};

/**
 * Get notification metrics for monitoring
 * @returns {Object} Current metrics
 */
const getMetrics = () => {
  return {
    ...metrics,
    uptime: Date.now() - metrics.lastReset.getTime(),
    vapidConfigured
  };
};

/**
 * Reset notification metrics
 */
const resetMetrics = () => {
  metrics.notifications = {
    created: 0,
    socketEmitted: 0,
    pushSent: 0,
    pushFailed: 0,
    subscriptionsRemoved: 0
  };
  metrics.lastReset = new Date();
  metrics.errors = [];
  logger.info('[NotificationService] Metrics reset');
};

module.exports = {
  initialize,
  createNotification,
  notifyUsers,
  notifyAllExcept,
  notifyContactChange,
  notifyTaskChange,
  notifyTaskAssignment,
  notifySubtaskChange,
  notifySubtaskAssignment,
  getNotificationTitle,
  getNotificationMessage,
  sendPushNotification,
  isVapidConfigured: () => vapidConfigured,
  isAPNsConfigured: () => apnConfigured,
  getAPNsStatus,
  sendAPNsNotification,
  sendAPNsDebug,
  getMetrics,
  resetMetrics
};
