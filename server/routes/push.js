const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const APNsDevice = require('../models/APNsDevice');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const { isVapidConfigured, getMetrics, resetMetrics } = require('../services/notificationService');
const { getSubscriptionStats, cleanupStaleSubscriptions } = require('../services/subscriptionCleanup');

// Rate limiting for push endpoints (simple in-memory implementation)
const rateLimiter = {
  requests: new Map(),
  limit: 10, // max requests per window
  windowMs: 60000, // 1 minute window

  check(userId) {
    const now = Date.now();
    const userRequests = this.requests.get(userId) || [];

    // Clean old requests
    const validRequests = userRequests.filter(time => now - time < this.windowMs);

    if (validRequests.length >= this.limit) {
      return false;
    }

    validRequests.push(now);
    this.requests.set(userId, validRequests);
    return true;
  },

  // Cleanup old entries periodically
  cleanup() {
    const now = Date.now();
    for (const [userId, requests] of this.requests.entries()) {
      const validRequests = requests.filter(time => now - time < this.windowMs);
      if (validRequests.length === 0) {
        this.requests.delete(userId);
      } else {
        this.requests.set(userId, validRequests);
      }
    }
  }
};

// Cleanup rate limiter every 5 minutes
setInterval(() => rateLimiter.cleanup(), 5 * 60 * 1000);

// Validate endpoint URL
const isValidEndpoint = (endpoint) => {
  if (!endpoint || typeof endpoint !== 'string') return false;
  try {
    const url = new URL(endpoint);
    // Only allow HTTPS endpoints (required for web push)
    return url.protocol === 'https:';
  } catch {
    return false;
  }
};

// Get VAPID public key
router.get('/vapid-public-key', (req, res) => {
  if (!isVapidConfigured()) {
    return res.status(503).json({ message: 'Push notifications not configured' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Subscribe to push notifications
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    const userId = req.user.id;

    logger.debug('[Push] Subscribe request', { userId });

    // Validate endpoint URL
    if (!isValidEndpoint(endpoint)) {
      logger.warn('[Push] Invalid endpoint URL', { userId });
      return res.status(400).json({ message: 'Invalid endpoint URL' });
    }

    // Validate keys
    if (!keys || !keys.p256dh || !keys.auth) {
      logger.warn('[Push] Missing subscription keys', { userId });
      return res.status(400).json({ message: 'Missing subscription keys' });
    }

    // Validate key formats (base64url)
    const base64urlRegex = /^[A-Za-z0-9_-]+$/;
    if (!base64urlRegex.test(keys.p256dh) || !base64urlRegex.test(keys.auth)) {
      logger.warn('[Push] Invalid key format', { userId });
      return res.status(400).json({ message: 'Invalid key format' });
    }

    // Check if subscription already exists
    let subscription = await PushSubscription.findOne({ endpoint });

    if (subscription) {
      // Update existing subscription
      subscription.userId = userId;
      subscription.keys = keys;
      subscription.userAgent = (req.headers['user-agent'] || '').substring(0, 500);
      subscription.lastUsed = new Date();
      await subscription.save();
      logger.info('[Push] Subscription updated', { userId, subscriptionId: subscription._id });
    } else {
      // Create new subscription
      subscription = new PushSubscription({
        userId,
        endpoint,
        keys,
        userAgent: (req.headers['user-agent'] || '').substring(0, 500)
      });
      await subscription.save();
      logger.info('[Push] Subscription created', { userId, subscriptionId: subscription._id });
    }

    res.json({ message: 'Subscription saved', subscriptionId: subscription._id });
  } catch (error) {
    logger.error('[Push] Error saving subscription', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Unsubscribe from push notifications
router.post('/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const { endpoint } = req.body;
    const userId = req.user.id;

    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ message: 'Endpoint is required' });
    }

    const result = await PushSubscription.deleteOne({ endpoint, userId });
    logger.info('[Push] Subscription removed', { userId, deleted: result.deletedCount });

    res.json({ message: 'Subscription removed' });
  } catch (error) {
    logger.error('[Push] Error removing subscription', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get user's subscriptions count
router.get('/subscriptions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const count = await PushSubscription.countDocuments({ userId });
    res.json({ count });
  } catch (error) {
    logger.error('[Push] Error getting subscriptions', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Test push notification (with rate limiting)
router.post('/test', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Rate limiting - prevent abuse
    if (!rateLimiter.check(userId)) {
      logger.warn('[Push Test] Rate limit exceeded', { userId });
      return res.status(429).json({ message: 'Too many requests. Please wait a moment.' });
    }

    if (!isVapidConfigured()) {
      return res.status(503).json({ message: 'Push notifications not configured' });
    }

    const subscriptions = await PushSubscription.find({ userId });

    if (subscriptions.length === 0) {
      return res.status(404).json({ message: 'No subscriptions found' });
    }

    logger.debug('[Push Test] Testing notifications', { userId, subscriptionCount: subscriptions.length });

    const payload = JSON.stringify({
      title: 'Test notifikácia',
      body: 'Toto je testovacia push notifikácia z Prpl CRM',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      data: {
        url: '/',
        type: 'test',
        timestamp: Date.now()
      }
    });

    const results = [];
    for (const sub of subscriptions) {
      try {
        logger.debug('[Push Test] Sending to endpoint', {
          endpoint: sub.endpoint.substring(0, 80),
          userAgent: sub.userAgent?.substring(0, 50)
        });
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: sub.keys
        }, payload);
        results.push({ success: true, endpoint: sub.endpoint.substring(0, 50) });
        logger.debug('[Push Test] Sent successfully', { endpoint: sub.endpoint.substring(0, 50) });
      } catch (error) {
        logger.warn('[Push Test] Failed', {
          endpoint: sub.endpoint.substring(0, 50),
          statusCode: error.statusCode,
          message: error.message
        });
        results.push({ success: false, statusCode: error.statusCode, endpoint: sub.endpoint.substring(0, 50) });

        // Remove invalid subscriptions (410 Gone or 404 Not Found)
        if (error.statusCode === 410 || error.statusCode === 404) {
          await PushSubscription.deleteOne({ _id: sub._id });
          logger.info('[Push Test] Removed invalid subscription', { userId });
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    logger.info('[Push Test] Test completed', { userId, sent: successCount, failed: results.length - successCount });

    res.json({
      message: 'Test notifications sent',
      sent: successCount,
      failed: results.length - successCount
    });
  } catch (error) {
    logger.error('[Push Test] Error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Manually trigger due date check (admin only)
router.post('/check-due-dates', authenticateToken, async (req, res) => {
  try {
    // Only allow admins to trigger this
    if (req.user.role !== 'admin') {
      logger.warn('[Due Date Check] Unauthorized access attempt', { userId: req.user.id });
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { checkDueDates } = require('../services/dueDateChecker');
    const result = await checkDueDates();

    logger.info('[Due Date Check] Manual check completed', { userId: req.user.id, ...result });

    res.json({
      message: 'Due date check completed',
      ...result
    });
  } catch (error) {
    logger.error('[Due Date Check] Error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get notification metrics (admin only)
router.get('/metrics', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const notificationMetrics = getMetrics();
    const subscriptionStats = await getSubscriptionStats();

    res.json({
      notifications: notificationMetrics,
      subscriptions: subscriptionStats
    });
  } catch (error) {
    logger.error('[Metrics] Error getting metrics', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Reset notification metrics (admin only)
router.post('/metrics/reset', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    resetMetrics();
    logger.info('[Metrics] Metrics reset by admin', { userId: req.user.id });

    res.json({ message: 'Metrics reset successfully' });
  } catch (error) {
    logger.error('[Metrics] Error resetting metrics', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Manually trigger subscription cleanup (admin only)
router.post('/cleanup-subscriptions', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const result = await cleanupStaleSubscriptions();
    logger.info('[Cleanup] Manual cleanup completed', { userId: req.user.id, ...result });

    res.json({
      message: 'Subscription cleanup completed',
      ...result
    });
  } catch (error) {
    logger.error('[Cleanup] Error during manual cleanup', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ===== APNs (iOS) Device Registration =====

// Register iOS device for push notifications
router.post('/apns/register', authenticateToken, async (req, res) => {
  try {
    const { deviceToken } = req.body;
    const userId = req.user.id;

    if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.length < 32) {
      return res.status(400).json({ message: 'Invalid device token' });
    }

    const normalized = deviceToken.replace(/[^a-fA-F0-9]/g, '').toLowerCase();

    await APNsDevice.findOneAndUpdate(
      { deviceToken: normalized },
      { userId, deviceToken: normalized, lastUsed: new Date() },
      { upsert: true, new: true }
    );

    logger.info('[APNs] Device registered', { userId, tokenPrefix: normalized.substring(0, 8) });
    res.json({ message: 'Device registered' });
  } catch (error) {
    logger.error('[APNs] Register error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Unregister iOS device
router.post('/apns/unregister', authenticateToken, async (req, res) => {
  try {
    const { deviceToken } = req.body;
    const normalized = (deviceToken || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();

    await APNsDevice.deleteOne({ deviceToken: normalized, userId: req.user.id });

    logger.info('[APNs] Device unregistered', { userId: req.user.id });
    res.json({ message: 'Device unregistered' });
  } catch (error) {
    logger.error('[APNs] Unregister error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// APNs status & test endpoint
router.get('/apns/status', authenticateToken, async (req, res) => {
  try {
    const devices = await APNsDevice.find({ userId: req.user.id });
    const { sendAPNsNotification, getAPNsStatus } = require('../services/notificationService');
    const status = getAPNsStatus();

    res.json({
      apnsConfigured: status.configured,
      apnsProduction: status.production,
      apnsTopic: status.topic,
      registeredDevices: devices.length,
      devices: devices.map(d => ({
        tokenPrefix: d.deviceToken.substring(0, 8) + '...',
        bundleId: d.bundleId,
        lastUsed: d.lastUsed,
        createdAt: d.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Test APNs push to current user
router.post('/apns/test', authenticateToken, async (req, res) => {
  try {
    const { sendAPNsNotification } = require('../services/notificationService');
    const result = await sendAPNsNotification(req.user.id, {
      title: 'Test notifikácie',
      body: 'Ak vidíte túto správu, iOS push notifikácie fungujú správne.',
      type: 'test',
      data: {}
    });
    res.json({ message: 'Test odoslaný', result });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

module.exports = router;
