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
    const userId = req.user.userId;

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ message: 'Invalid subscription data' });
    }

    // Check if subscription already exists
    let subscription = await PushSubscription.findOne({ endpoint });

    if (subscription) {
      // Update existing subscription
      subscription.userId = userId;
      subscription.keys = keys;
      subscription.userAgent = req.headers['user-agent'] || '';
      subscription.lastUsed = new Date();
      await subscription.save();
    } else {
      // Create new subscription
      subscription = new PushSubscription({
        userId,
        endpoint,
        keys,
        userAgent: req.headers['user-agent'] || ''
      });
      await subscription.save();
    }

    res.json({ message: 'Subscription saved', subscriptionId: subscription._id });
  } catch (error) {
    console.error('Error saving push subscription:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Unsubscribe from push notifications
router.post('/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const { endpoint } = req.body;
    const userId = req.user.userId;

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
    const userId = req.user.userId;
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
      return res.status(503).json({ message: 'Push notifications not configured' });
    }

    const userId = req.user.userId;
    const subscriptions = await PushSubscription.find({ userId });

    if (subscriptions.length === 0) {
      return res.status(404).json({ message: 'No subscriptions found' });
    }

    const payload = JSON.stringify({
      title: 'Test notifikácia',
      body: 'Toto je testovacia push notifikácia z Purple CRM',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      data: {
        url: '/'
      }
    });

    const results = [];
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: sub.keys
        }, payload);
        results.push({ endpoint: sub.endpoint, success: true });
      } catch (error) {
        console.error('Push failed for endpoint:', sub.endpoint, error);
        results.push({ endpoint: sub.endpoint, success: false, error: error.message });

        // Remove invalid subscriptions
        if (error.statusCode === 410 || error.statusCode === 404) {
          await PushSubscription.deleteOne({ _id: sub._id });
        }
      }
    }

    res.json({ message: 'Test notifications sent', results });
  } catch (error) {
    console.error('Error sending test notification:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
