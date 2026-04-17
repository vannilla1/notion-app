/**
 * Firebase Cloud Messaging service — Android native push transport.
 *
 * Parallel to APNs (iOS): sendFCMNotification(userId, payload) → loads all FCM
 * devices for user and publishes data-only message via Admin SDK. FCM handles
 * delivery even when app is background-killed (systémový FCM daemon ma higher
 * priority ako Chrome backgr. procesy ktoré OEMs killujú v TWA).
 *
 * Credential loading (env fallback):
 *   1. FIREBASE_SERVICE_ACCOUNT_BASE64 — JSON súbor zakódovaný v base64 (pre Render env var)
 *   2. FIREBASE_SERVICE_ACCOUNT_PATH   — filesystem cesta (lokálny dev)
 *   3. secrets/firebase-admin.json     — default path (v .gitignore)
 *
 * Init je lazy — ak žiadny credential nie je dostupný, modul sa nenainicializuje
 * a sendFCMNotification vráti no-op { sent: 0, failed: 0 }. Backend fungje
 * bez Android push (iOS + web push ostávajú).
 */

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const FcmDevice = require('../models/FcmDevice');

let admin = null;
let fcmApp = null;
let fcmConfigured = false;

const initializeFCM = () => {
  if (fcmConfigured) return true;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    logger.warn('[FCM] firebase-admin package not installed — Android push disabled');
    return false;
  }

  let serviceAccount = null;

  // 1. Base64-encoded JSON v env (preferované pre Render / Heroku)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
      const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    } catch (err) {
      logger.error('[FCM] Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64', { error: err.message });
    }
  }

  // 2. JSON inline string v env
  if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      logger.error('[FCM] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON', { error: err.message });
    }
  }

  // 3. Filesystem (lokálny dev)
  if (!serviceAccount) {
    const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      || path.join(__dirname, '..', '..', 'secrets', 'firebase-admin.json');
    if (fs.existsSync(filePath)) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        logger.error('[FCM] Failed to read service account file', { filePath, error: err.message });
      }
    }
  }

  if (!serviceAccount) {
    logger.warn('[FCM] No Firebase service account available — Android push disabled');
    return false;
  }

  try {
    fcmApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    }, 'prpl-fcm');
    fcmConfigured = true;
    logger.info('[FCM] Configured with project', { projectId: serviceAccount.project_id });
    return true;
  } catch (err) {
    logger.error('[FCM] initializeApp failed', { error: err.message });
    return false;
  }
};

initializeFCM();

const isFCMConfigured = () => fcmConfigured;

const getFCMStatus = () => ({
  configured: fcmConfigured,
  projectId: fcmApp?.options?.credential?.projectId || null
});

/**
 * Send FCM push to all Android-native devices registered for this user.
 *
 * Payload shape (data-only — nezobrazuje sa cez systémový FCM renderer, náš
 * PrplFcmService v appke renderuje NotificationCompat sám):
 *   { title, body, url, notificationId?, ...payload.data }
 *
 * `generateNotificationUrl` sa volá z caller-a (notificationService) a URL
 * sa pošle v data.url — appka ju použije ako EXTRA_DEEP_LINK.
 */
const sendFCMNotification = async (userId, payload, urlFromCaller = null) => {
  const result = { sent: 0, failed: 0, removed: 0 };
  if (!fcmConfigured) return result;

  try {
    const devices = await FcmDevice.find({ userId });
    if (devices.length === 0) return result;

    const title = String(payload.title || '').slice(0, 100);
    const body = String(payload.body || payload.message || '').slice(0, 200);
    const data = {
      title,
      body,
      type: String(payload.type || ''),
      url: String(urlFromCaller || payload.url || ''),
      workspaceId: payload.data?.workspaceId ? String(payload.data.workspaceId) : '',
      notificationId: payload.data?.notificationId ? String(payload.data.notificationId) : '',
    };
    // FCM data values must be strings. Flatten additional payload.data fields.
    if (payload.data && typeof payload.data === 'object') {
      for (const [k, v] of Object.entries(payload.data)) {
        if (v === null || v === undefined) continue;
        if (data[k] !== undefined) continue; // don't overwrite structured fields
        data[k] = String(v);
      }
    }

    for (const device of devices) {
      try {
        const message = {
          token: device.fcmToken,
          data,
          android: {
            priority: 'high',
            ttl: 3600_000,
            // Žiadny `notification` field — data-only = delivered even if user force-stopped.
            // Náš PrplFcmService vezme data a zobrazí cez NotificationCompat.
          }
        };
        await admin.messaging(fcmApp).send(message);
        result.sent++;
        device.lastUsed = new Date();
        await device.save();
      } catch (err) {
        const code = err?.errorInfo?.code || err?.code || '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          await FcmDevice.deleteOne({ _id: device._id });
          result.removed++;
          logger.info('[FCM] Removed invalid token', { userId, code });
        } else {
          result.failed++;
          logger.warn('[FCM] Send failed', { userId, code, message: err.message });
        }
      }
    }

    if (result.sent > 0 || result.failed > 0 || result.removed > 0) {
      logger.info('[FCM] Results', { userId, ...result });
    }
  } catch (error) {
    logger.error('[FCM] Error', { error: error.message, userId });
  }
  return result;
};

module.exports = {
  isFCMConfigured,
  getFCMStatus,
  sendFCMNotification
};
