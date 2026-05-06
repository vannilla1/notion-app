const Notification = require('../models/Notification');
const User = require('../models/User');
const WorkspaceMember = require('../models/WorkspaceMember');
const PushSubscription = require('../models/PushSubscription');
const APNsDevice = require('../models/APNsDevice');
const FcmDevice = require('../models/FcmDevice');
const { sendFCMNotification, isFCMConfigured, getFCMStatus } = require('./fcmService');
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

    // Diagnostic logging — verify ws= is actually in the URL we send.
    // Appears in Render logs so we can confirm the server side of the
    // cross-workspace deep-link flow is correct.
    logger.info('[APNs] Sending push', {
      userId: String(userId),
      type: payload.type,
      url,
      hasWs: url.includes('ws='),
      dataWorkspaceId: payload.data?.workspaceId || null
    });

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
        // Group notifications by workspace so iOS stacks per workspace
        'thread-id': payload.data?.workspaceId
          ? `ws-${payload.data.workspaceId}`
          : (payload.type || 'default')
      },
      url: url,
      type: payload.type,
      workspaceId: payload.data?.workspaceId ? String(payload.data.workspaceId) : undefined,
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

  // Helper: append ws=<workspaceId> so the client can switch workspace
  // before navigating to the target entity. Required for multi-workspace users.
  const withWs = (url) => {
    if (!data.workspaceId) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}ws=${data.workspaceId}`;
  };

  // Contact notifications -> /crm with contact expansion
  if (type?.startsWith('contact') && data.contactId) {
    return withWs(`/crm?expandContact=${data.contactId}`);
  }

  // Task notifications -> /tasks with task highlight
  // NOTE: úmyselne NEpridávame &contactId — Tasks.jsx by ho interpretoval ako
  // contactFilter a volal navigate('/tasks', { replace: true }), čo zmaže
  // highlightTask a user by skončil vo filtrovanom zozname bez zvýraznenia.
  // highlightTask stačí na scroll + flash animáciu.
  if (type?.startsWith('task') && data.taskId) {
    return withWs(`/tasks?highlightTask=${data.taskId}`);
  }

  // Subtask notifications -> /tasks with parent task highlight (rovnaký dôvod
  // ako vyššie — žiadny contactId v notifikačnej URL).
  if (type?.startsWith('subtask') && data.taskId) {
    return withWs(`/tasks?highlightTask=${data.taskId}&subtask=${data.subtaskId || ''}`);
  }

  // Message notifications -> /messages with message highlight (+ comment scroll)
  if (type?.startsWith('message') && data.messageId) {
    let url = `/messages?highlight=${data.messageId}`;
    if (data.commentId) url += `&comment=${data.commentId}`;
    return withWs(url);
  }

  // Workspace notifications -> /app (dashboard)
  if (type?.startsWith('workspace')) {
    return withWs('/app');
  }

  // Fallback: try to determine URL from data fields alone
  if (data.messageId) {
    let url = `/messages?highlight=${data.messageId}`;
    if (data.commentId) url += `&comment=${data.commentId}`;
    return withWs(url);
  }
  if (data.contactId && !data.taskId) return withWs(`/crm?expandContact=${data.contactId}`);
  if (data.taskId) {
    // Viď poznámku vyššie — contactId do task URL nedávame.
    return withWs(`/tasks?highlightTask=${data.taskId}`);
  }

  logger.warn('[NotificationService] No URL match, returning /app', { type, data });
  return withWs('/app');
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

// ─────────────────────────────────────────────────────────────────────────
// Notification classification + push gating
// ─────────────────────────────────────────────────────────────────────────
//
// 'direct'  — explicit assignment for THIS user, completion of THIS user's
//             assigned task by someone else, or message addressed to them.
//             Always sends push regardless of preferences.
// 'general' — passive team activity, deadline reminders, member events,
//             overdue. Push only if user opted in via notificationPreferences.
//
// `classifyByType()` covers the 90 % case (assignment events). Per-recipient
// nuance (e.g. task.completed where the recipient is the assignee) is
// handled in notify* helpers, which pass an explicit `category` parameter.

const DIRECT_TYPES = new Set([
  'task.assigned',
  'subtask.assigned',
  'message.created',
  'message.commented',
  'message.comment.reacted'
]);

const classifyByType = (type) => (DIRECT_TYPES.has(type) ? 'direct' : 'general');

// Map a notification type to the user-preference key that gates its push.
// Returns null for types that are always pushed (direct).
const getPushPrefKey = (type, category) => {
  if (category === 'direct') return null; // direct is always pushed
  if (type === 'task.dueDate' || type === 'subtask.dueDate') return 'pushDeadlines';
  if (type === 'task.overdue' || type === 'subtask.overdue') return 'pushOverdue';
  if (type === 'workspace.memberAdded') return 'pushNewMember';
  return 'pushTeamActivity'; // default bucket for everything else general
};

// Trim notification history to the most recent N per user. Runs after every
// insert so the table stays bounded. Older notifications are deleted.
const HISTORY_LIMIT_PER_USER = 150;

const trimUserHistory = async (userId) => {
  try {
    const count = await Notification.countDocuments({ userId });
    if (count <= HISTORY_LIMIT_PER_USER) return;

    const excess = count - HISTORY_LIMIT_PER_USER;
    const oldest = await Notification.find({ userId })
      .sort({ createdAt: 1 })
      .limit(excess)
      .select('_id')
      .lean();

    if (oldest.length > 0) {
      await Notification.deleteMany({ _id: { $in: oldest.map(n => n._id) } });
    }
  } catch (err) {
    logger.warn('[NotificationService] history trim failed', { error: err.message, userId });
  }
};

/**
 * Create a notification for a specific user
 */
const createNotification = async ({
  userId,
  workspaceId = null,
  type,
  title,
  message = '',
  actorId = null,
  actorName = null,
  relatedType = null,
  relatedId = null,
  relatedName = null,
  data = {},
  category = null  // explicit override; otherwise classifyByType(type) is used
}) => {
  try {
    // Ensure workspaceId is also available inside data so push payloads
    // (which use data as the payload envelope) carry workspace context
    const dataWithWs = workspaceId
      ? { ...data, workspaceId: workspaceId.toString() }
      : data;

    const resolvedCategory = category || classifyByType(type);

    const notification = new Notification({
      userId,
      workspaceId: workspaceId || undefined,
      type,
      title,
      message,
      actorId,
      actorName,
      relatedType,
      relatedId,
      relatedName,
      data: dataWithWs,
      category: resolvedCategory
    });

    await notification.save();
    metrics.notifications.created++;

    // Trim user's notification history to last 150 (fire-and-forget).
    setImmediate(() => trimUserHistory(userId));

    // Send real-time notification via Socket.IO
    if (io) {
      io.to(`user-${userId}`).emit('notification', {
        id: notification._id.toString(),
        workspaceId: notification.workspaceId ? notification.workspaceId.toString() : null,
        type: notification.type,
        category: notification.category,
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

    // Send push notifications — prefer APNs for iOS, web push for desktop.
    // CRITICAL PERF FIX: push sends (APNs round-trip to Apple + web push VAPID
    // signing/POST) take 5-15s per device. Previously these were awaited,
    // blocking the HTTP response of every route that created a notification
    // (comment submit taking "tens of seconds" = classic symptom).
    // Socket.IO emit above stays synchronous so in-app real-time works
    // instantly; push fan-out now runs fire-and-forget on the next tick.
    const pushPayload = {
      title: notification.title,
      body: notification.message,
      type: notification.type,
      data: notification.data
    };

    setImmediate(async () => {
      try {
        // ─── Push gating ────────────────────────────────────────────────
        // Direct → vždy posielame push (priradenia, dokončenie mojej úlohy
        // niekým iným, správa pre mňa). General → len ak má user explicitne
        // zapnutý príslušný toggle vo svojich notificationPreferences.
        const prefKey = getPushPrefKey(notification.type, notification.category);
        if (prefKey) {
          const recipient = await User.findById(userId, 'notificationPreferences').lean();
          const enabled = recipient?.notificationPreferences?.[prefKey];
          if (!enabled) {
            // User has not opted in for this kind of general notification —
            // still saved to the bell panel (Socket.IO emit už prebehol),
            // ale push na telefón / web sa nepošle.
            return;
          }
        }

        // Pre-compute URL once so všetky platformy dostanú identický deep link.
        const url = generateNotificationUrl(pushPayload.type, pushPayload.data);

        const [apnsDevices, fcmDevices] = await Promise.all([
          apnConfigured ? APNsDevice.find({ userId }) : Promise.resolve([]),
          isFCMConfigured() ? FcmDevice.find({ userId }) : Promise.resolve([])
        ]);

        const jobs = [];

        // iOS native
        if (apnsDevices.length > 0) {
          jobs.push(sendAPNsNotification(userId, pushPayload));
        }

        // Android native (FCM data-only) — podobná rola ako APNs pre iOS
        if (fcmDevices.length > 0) {
          jobs.push(sendFCMNotification(userId, pushPayload, url));
        }

        // Web Push — ak má user iOS devices, vynechaj Apple web push endpointy
        // (APNs ich už pokrýva). Ak nemá žiadne native devices, pošli na všetky
        // webové subscriptiony.
        if (apnsDevices.length > 0) {
          jobs.push(sendPushNotificationExcludeIOS(userId, pushPayload));
        } else {
          jobs.push(sendPushNotification(userId, pushPayload));
        }

        await Promise.all(jobs);
      } catch (pushErr) {
        logger.error('[NotificationService] Async push send failed', {
          error: pushErr.message,
          userId,
          type
        });
      }
    });

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
  // Titulok notifikácie má actor-first formát:
  //   "<Kto> <čo urobil> <s čím>: <názov>"
  // Ak relatedName chýba, vynecháme aj dvojbodku (prirodzenejšie znenie v push).
  //
  // Terminológia projektu (viď GEMMA_PROJECT_GUIDE.md §1):
  //   Task (model)    → "projekt" v UI
  //   Subtask (nested) → "úloha" v UI
  //
  // Format notifikácie sa premieta aj do iOS push a web-push titulkov, takže
  // musí byť konzistentný s terminológiou vo zvyšku aplikácie.
  const actor = actorName || 'Niekto';
  const related = relatedName || '';
  const suffix = related ? `: ${related}` : '';

  switch (type) {
    case 'contact.created':
      return `${actor} vytvoril nový kontakt${suffix}`;
    case 'contact.updated':
      return `${actor} upravil kontakt${suffix}`;
    case 'contact.deleted':
      return `${actor} vymazal kontakt${suffix}`;
    case 'task.created':
      return `${actor} vytvoril nový projekt${suffix}`;
    case 'task.updated':
      return `${actor} upravil projekt${suffix}`;
    case 'task.completed':
      return `${actor} dokončil projekt${suffix}`;
    case 'task.deleted':
      return `${actor} vymazal projekt${suffix}`;
    case 'task.assigned':
      return `${actor} vám priradil projekt${suffix}`;
    case 'task.priority_changed':
      return `${actor} upravil prioritu projektu${suffix}`;
    case 'subtask.created':
      return `${actor} pridal úlohu${suffix}`;
    case 'subtask.updated':
      return `${actor} upravil úlohu${suffix}`;
    case 'subtask.completed':
      return `${actor} dokončil úlohu${suffix}`;
    case 'subtask.deleted':
      return `${actor} vymazal úlohu${suffix}`;
    case 'subtask.assigned':
      return `${actor} vám priradil úlohu${suffix}`;
    case 'task.dueDate':
    case 'subtask.dueDate':
      return related || 'Blíži sa termín';
    case 'workspace.memberAdded':
      return related ? `Nový člen workspace: ${related}` : 'Nový člen workspace';
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
    case 'task.priority_changed': {
      // data.newPriority preložené na slovenský label (low/medium/high
      // → Nízku/Strednú/Vysokú v akuzatíve). Acc-pad dôležitý: "zmenená NA
      // <prioritu-acc>". Pre fallback (chýbajúca data) vrátime generic vetu.
      const labels = { low: 'Nízku', medium: 'Strednú', high: 'Vysokú' };
      const label = labels[data.newPriority];
      if (!label) return `${actor} zmenil prioritu projektu`;
      return contactName
        ? `${actor} zmenil prioritu projektu v kontakte "${contactName}" na ${label}`
        : `${actor} zmenil prioritu projektu na ${label}`;
    }
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
    workspaceId,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'contact',
    relatedId: contact._id?.toString() || contact.id,
    relatedName: contact.name,
    data: {
      contactId: contact._id?.toString() || contact.id,
      workspaceId: workspaceId ? workspaceId.toString() : undefined
    }
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
    workspaceId,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'task',
    relatedId: task._id?.toString() || task.id,
    relatedName: task.title,
    data: {
      taskId: task._id?.toString() || task.id,
      contactId: task.contactId,
      contactName: task.contactName,
      workspaceId: workspaceId ? workspaceId.toString() : undefined
    }
  };

  // Per-recipient categorization for completion events: ak príjemca je
  // assignee tej úlohy, je to "direct" (treba mu o tom dať vedieť), inak
  // "general" (passive team activity).
  const isCompletionEvent = type === 'task.completed' || type === 'subtask.completed';
  const assignedSet = new Set(
    (task.assignedTo || []).map(id => id?.toString()).filter(Boolean)
  );
  const categoryForRecipient = (id) => {
    if (isCompletionEvent && assignedSet.has(id)) return 'direct';
    return 'general';
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
      // Per-recipient notify so completion events can carry the right category.
      const out = [];
      for (const id of recipientIds) {
        const n = await createNotification({
          ...notificationData,
          userId: id,
          category: categoryForRecipient(id)
        });
        if (n) out.push(n);
      }
      return out;
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
  const out = [];
  for (const id of Array.from(recipientIds)) {
    const n = await createNotification({
      ...notificationData,
      userId: id,
      category: categoryForRecipient(id)
    });
    if (n) out.push(n);
  }
  return out;
};

/**
 * Notify about task priority change. Posiela všetkým členom workspace okrem
 * actora (ktorý zmenu vykonal). Notifikácia obsahuje data.newPriority +
 * data.oldPriority pre frontend rendering farebného badge-u.
 *
 * Kategória 'general' aj pre assignee — zmena priority je informačná, nie
 * action item. Ak by sme to chceli spraviť 'direct' pre assignee, treba
 * upraviť categoryForRecipient.
 */
const notifyTaskPriorityChanged = async (task, oldPriority, newPriority, actor, workspaceId = null) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle('task.priority_changed', actorName, task.title);
  const message = getNotificationMessage('task.priority_changed', actorName, {
    contactName: task.contactName,
    oldPriority,
    newPriority
  });

  logger.debug('[NotificationService] Priority changed', {
    taskTitle: task.title, oldPriority, newPriority, actorName, workspaceId
  });

  const notificationData = {
    type: 'task.priority_changed',
    title,
    message,
    workspaceId,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'task',
    relatedId: task._id?.toString() || task.id,
    relatedName: task.title,
    data: {
      taskId: task._id?.toString() || task.id,
      contactId: task.contactId,
      contactName: task.contactName,
      workspaceId: workspaceId ? workspaceId.toString() : undefined,
      // Frontend NotificationBell použije newPriority na vykreslenie
      // farebného badge-u (low=šedá, medium=oranžová, high=červená).
      oldPriority,
      newPriority
    }
  };

  if (workspaceId) {
    try {
      const members = await WorkspaceMember.find({ workspaceId }, 'userId').lean();
      const recipientIds = members
        .map((m) => m.userId.toString())
        .filter((id) => !actor || id !== (actor._id || actor.id).toString());

      if (recipientIds.length === 0) return [];

      const out = [];
      for (const id of recipientIds) {
        const n = await createNotification({
          ...notificationData,
          userId: id,
          category: 'general'
        });
        if (n) out.push(n);
      }
      return out;
    } catch (error) {
      logger.error('[NotificationService] Error fetching workspace members for priority notification', { error: error.message });
      return [];
    }
  }

  return [];
};

/**
 * Notify about task assignment
 */
const notifyTaskAssignment = async (task, assignedUserIds, actor, workspaceId = null) => {
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
    workspaceId,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'task',
    relatedId: task._id?.toString() || task.id,
    relatedName: task.title,
    data: {
      taskId: task._id?.toString() || task.id,
      contactId: task.contactId,
      contactName: task.contactName,
      workspaceId: workspaceId ? workspaceId.toString() : undefined
    }
  };

  // Filter out the actor from recipients
  const recipients = assignedUserIds.filter(id =>
    id && id.toString() !== (actor?._id || actor?.id)?.toString()
  );

  // task.assigned je vždy direct — explicit assignment patrí na vrch zvončeka.
  return await notifyUsers(recipients, { ...notificationData, category: 'direct' });
};

/**
 * Notify about subtask assignment
 */
const notifySubtaskAssignment = async (subtask, parentTask, assignedUserIds, actor, workspaceId = null) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle('subtask.assigned', actorName, subtask.title);
  const message = getNotificationMessage('subtask.assigned', actorName, { taskTitle: parentTask.title });

  logger.debug('[NotificationService] Subtask assignment', { subtaskTitle: subtask.title, parentTaskTitle: parentTask.title, assignedUserIds, actorName });

  const notificationData = {
    type: 'subtask.assigned',
    title,
    message,
    workspaceId,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'subtask',
    relatedId: subtask.id,
    relatedName: subtask.title,
    data: {
      subtaskId: subtask.id,
      taskId: parentTask._id?.toString() || parentTask.id,
      taskTitle: parentTask.title,
      contactId: parentTask.contactId,
      workspaceId: workspaceId ? workspaceId.toString() : undefined
    }
  };

  // Filter out the actor from recipients
  const recipients = assignedUserIds.filter(id =>
    id && id.toString() !== (actor?._id || actor?.id)?.toString()
  );

  // subtask.assigned je vždy direct.
  return await notifyUsers(recipients, { ...notificationData, category: 'direct' });
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
    workspaceId,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'subtask',
    relatedId: subtask.id,
    relatedName: subtask.title,
    data: {
      subtaskId: subtask.id,
      taskId: parentTask._id?.toString() || parentTask.id,
      taskTitle: parentTask.title,
      contactId: parentTask.contactId,
      workspaceId: workspaceId ? workspaceId.toString() : undefined
    }
  };

  // Per-recipient categorization for subtask.completed: ak príjemca je
  // assignee tej PODÚLOHY, dostáva 'direct' (jeho úlohu dokončil iný); ostatní
  // dostávajú 'general'.
  const isCompletionEvent = type === 'subtask.completed';
  const assignedSet = new Set(
    (subtask.assignedTo || []).map(id => id?.toString()).filter(Boolean)
  );
  const categoryForRecipient = (id) => {
    if (isCompletionEvent && assignedSet.has(id)) return 'direct';
    return 'general';
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
      const out = [];
      for (const id of recipientIds) {
        const n = await createNotification({
          ...notificationData,
          userId: id,
          category: categoryForRecipient(id)
        });
        if (n) out.push(n);
      }
      return out;
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
  const out = [];
  for (const id of Array.from(recipientIds)) {
    const n = await createNotification({
      ...notificationData,
      userId: id,
      category: categoryForRecipient(id)
    });
    if (n) out.push(n);
  }
  return out;
};

/**
 * Notify all members of a workspace that a new member has joined.
 * Pošle 'general' notifikáciu s typom 'workspace.memberAdded' všetkým
 * existujúcim členom (okrem nového člena samotného).
 *
 * @param {Object} params
 * @param {Object} params.workspace — workspace doc { _id, name }
 * @param {Object} params.newMember — newly added user { _id, username }
 * @param {Object} [params.actor]   — invoker (vlastník/manažér ktorý pozval)
 */
const notifyWorkspaceMemberAdded = async ({ workspace, newMember, actor }) => {
  if (!workspace?._id || !newMember?._id) return [];
  try {
    const members = await WorkspaceMember.find({ workspaceId: workspace._id }, 'userId').lean();
    const recipientIds = members
      .map(m => m.userId.toString())
      .filter(id => id !== newMember._id.toString());

    if (recipientIds.length === 0) return [];

    const memberName = newMember.username || newMember.email || 'Nový člen';
    const actorName = actor?.username || 'Systém';

    const notificationData = {
      type: 'workspace.memberAdded',
      title: getNotificationTitle('workspace.memberAdded', actorName, memberName),
      message: `${memberName} sa pridal/a do workspace "${workspace.name || ''}"`,
      workspaceId: workspace._id,
      actorId: actor?._id || actor?.id || null,
      actorName,
      relatedType: null,
      relatedId: null,
      relatedName: memberName,
      data: {
        memberId: newMember._id.toString(),
        memberName,
        workspaceId: workspace._id.toString(),
        workspaceName: workspace.name
      },
      category: 'general' // member events sú general — neidú push (default)
    };

    return await notifyUsers(recipientIds, notificationData);
  } catch (error) {
    logger.error('[NotificationService] notifyWorkspaceMemberAdded failed', {
      error: error.message,
      workspaceId: workspace._id
    });
    return [];
  }
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
  notifyTaskPriorityChanged,
  notifyAllExcept,
  notifyContactChange,
  notifyTaskChange,
  notifyTaskAssignment,
  notifySubtaskChange,
  notifySubtaskAssignment,
  notifyWorkspaceMemberAdded,
  classifyByType,
  trimUserHistory,
  getNotificationTitle,
  getNotificationMessage,
  generateNotificationUrl,
  sendPushNotification,
  isVapidConfigured: () => vapidConfigured,
  isAPNsConfigured: () => apnConfigured,
  getAPNsStatus,
  sendAPNsNotification,
  sendAPNsDebug,
  isFCMConfigured,
  getFCMStatus,
  sendFCMNotification,
  getMetrics,
  resetMetrics
};
