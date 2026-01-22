const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const { authenticateToken } = require('../middleware/auth');

// Configure web-push with VAPID keys (if available)
const vapidConfigured = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY;
if (vapidConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@purplecrm.sk',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('VAPID keys not configured - push notifications will not work');
}

// Get VAPID public key
router.get('/vapid-public-key', (req, res) => {
  if (!vapidConfigured) {
    return res.status(503).json({ message: 'Push notifications not configured' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Subscribe to push notifications
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    const userId = req.user.id;

    console.log('[Push] Subscribe request from user:', userId);
    console.log('[Push] Endpoint:', endpoint ? endpoint.substring(0, 80) + '...' : 'missing');
    console.log('[Push] Keys present:', { p256dh: !!keys?.p256dh, auth: !!keys?.auth });

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      console.log('[Push] Invalid subscription data');
      return res.status(400).json({ message: 'Invalid subscription data' });
    }

    // Check if subscription already exists
    let subscription = await PushSubscription.findOne({ endpoint });

    if (subscription) {
      // Update existing subscription
      console.log('[Push] Updating existing subscription');
      subscription.userId = userId;
      subscription.keys = keys;
      subscription.userAgent = req.headers['user-agent'] || '';
      subscription.lastUsed = new Date();
      await subscription.save();
    } else {
      // Create new subscription
      console.log('[Push] Creating new subscription');
      subscription = new PushSubscription({
        userId,
        endpoint,
        keys,
        userAgent: req.headers['user-agent'] || ''
      });
      await subscription.save();
    }

    console.log('[Push] Subscription saved:', subscription._id);
    res.json({ message: 'Subscription saved', subscriptionId: subscription._id });
  } catch (error) {
    console.error('[Push] Error saving subscription:', error.message);
    console.error('[Push] Full error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Unsubscribe from push notifications
router.post('/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const { endpoint } = req.body;
    const userId = req.user.id;

    if (!endpoint) {
      return res.status(400).json({ message: 'Endpoint is required' });
    }

    await PushSubscription.deleteOne({ endpoint, userId });

    res.json({ message: 'Subscription removed' });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get user's subscriptions count
router.get('/subscriptions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const count = await PushSubscription.countDocuments({ userId });
    res.json({ count });
  } catch (error) {
    console.error('Error getting subscriptions:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Test push notification (for debugging)
router.post('/test', authenticateToken, async (req, res) => {
  try {
    if (!vapidConfigured) {
      console.log('[Push Test] VAPID not configured');
      return res.status(503).json({ message: 'Push notifications not configured' });
    }

    const userId = req.user.id;
    console.log('[Push Test] Testing for user:', userId);

    const subscriptions = await PushSubscription.find({ userId });
    console.log('[Push Test] Found subscriptions:', subscriptions.length);

    if (subscriptions.length === 0) {
      return res.status(404).json({ message: 'No subscriptions found' });
    }

    // Log subscription details
    subscriptions.forEach((sub, i) => {
      console.log(`[Push Test] Subscription ${i + 1}:`, {
        endpoint: sub.endpoint.substring(0, 80) + '...',
        hasP256dh: !!sub.keys?.p256dh,
        hasAuth: !!sub.keys?.auth,
        userAgent: sub.userAgent?.substring(0, 50) || 'unknown',
        createdAt: sub.createdAt
      });
    });

    const payload = JSON.stringify({
      title: 'Test notifikácia',
      body: 'Toto je testovacia push notifikácia z Purple CRM',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      data: {
        url: '/',
        type: 'test',
        timestamp: Date.now()
      }
    });

    console.log('[Push Test] Sending payload:', payload.substring(0, 100) + '...');

    const results = [];
    for (const sub of subscriptions) {
      try {
        console.log('[Push Test] Sending to:', sub.endpoint.substring(0, 50) + '...');
        const sendResult = await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: sub.keys
        }, payload);
        console.log('[Push Test] Success! Status:', sendResult.statusCode);
        results.push({ endpoint: sub.endpoint.substring(0, 50), success: true });
      } catch (error) {
        console.error('[Push Test] Failed:', error.statusCode, error.message);
        console.error('[Push Test] Full error:', JSON.stringify(error, null, 2));
        results.push({
          endpoint: sub.endpoint.substring(0, 50),
          success: false,
          error: error.message,
          statusCode: error.statusCode
        });

        // Remove invalid subscriptions (410 Gone or 404 Not Found)
        if (error.statusCode === 410 || error.statusCode === 404) {
          console.log('[Push Test] Removing invalid subscription');
          await PushSubscription.deleteOne({ _id: sub._id });
        }
      }
    }

    console.log('[Push Test] Results:', JSON.stringify(results));
    res.json({ message: 'Test notifications sent', results });
  } catch (error) {
    console.error('[Push Test] Error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Manually trigger due date check (admin only)
router.post('/check-due-dates', authenticateToken, async (req, res) => {
  try {
    // Only allow admins to trigger this
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { checkDueDates } = require('../services/dueDateChecker');
    const result = await checkDueDates();

    res.json({
      message: 'Due date check completed',
      ...result
    });
  } catch (error) {
    console.error('[Due Date Check] Error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
