const mongoose = require('mongoose');
const subscriptionCleanup = require('../../services/subscriptionCleanup');
const PushSubscription = require('../../models/PushSubscription');
const User = require('../../models/User');

/**
 * subscriptionCleanup testy — denný cron na mazanie stale Web Push subskripcií.
 *
 * Testujeme:
 *   - STALE_THRESHOLD_DAYS = 30
 *   - cleanupStaleSubscriptions() maže iba lastUsed < teraz - 30d
 *   - getSubscriptionStats() vracia total, uniqueUsers, activeLastDay/Week, stale
 *   - getSubscriptionStats() zaokrúhľuje avgSubscriptionsPerUser na 2 desatinné miesta
 */
describe('subscriptionCleanup service', () => {
  let userA;
  let userB;

  beforeAll(async () => {
    await User.init();
    await PushSubscription.init();
  });

  beforeEach(async () => {
    await PushSubscription.deleteMany({});
    await User.deleteMany({});

    userA = await User.create({
      username: 'alice',
      email: 'alice@test.com',
      password: 'hashedpw'
    });
    userB = await User.create({
      username: 'bob',
      email: 'bob@test.com',
      password: 'hashedpw'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('STALE_THRESHOLD_DAYS', () => {
    it('should export a 30-day threshold constant', () => {
      expect(subscriptionCleanup.STALE_THRESHOLD_DAYS).toBe(30);
    });
  });

  describe('cleanupStaleSubscriptions', () => {
    it('should delete subscriptions older than 30 days', async () => {
      // Čerstvá (dnes)
      await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://push.example.com/fresh',
        keys: { p256dh: 'a', auth: 'b' }
      });

      // Stará 40 dní
      const stale40 = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://push.example.com/stale40',
        keys: { p256dh: 'c', auth: 'd' }
      });
      stale40.lastUsed = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await stale40.save();

      // Stará 31 dní
      const stale31 = await PushSubscription.create({
        userId: userB._id,
        endpoint: 'https://push.example.com/stale31',
        keys: { p256dh: 'e', auth: 'f' }
      });
      stale31.lastUsed = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await stale31.save();

      const result = await subscriptionCleanup.cleanupStaleSubscriptions();
      expect(result.deleted).toBe(2);

      const remaining = await PushSubscription.find({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].endpoint).toContain('fresh');
    });

    it('should NOT delete subscriptions exactly 29 days old', async () => {
      const sub = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://push.example.com/edge',
        keys: { p256dh: 'a', auth: 'b' }
      });
      sub.lastUsed = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
      await sub.save();

      const result = await subscriptionCleanup.cleanupStaleSubscriptions();
      expect(result.deleted).toBe(0);
      expect(await PushSubscription.countDocuments({})).toBe(1);
    });

    it('should return {deleted: 0} when no stale subscriptions exist', async () => {
      await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://push.example.com/x',
        keys: { p256dh: 'a', auth: 'b' }
      });

      const result = await subscriptionCleanup.cleanupStaleSubscriptions();
      expect(result.deleted).toBe(0);
    });

    it('should return {deleted: 0} on empty collection', async () => {
      const result = await subscriptionCleanup.cleanupStaleSubscriptions();
      expect(result.deleted).toBe(0);
    });
  });

  describe('getSubscriptionStats', () => {
    it('should report zeros on empty collection', async () => {
      const stats = await subscriptionCleanup.getSubscriptionStats();
      expect(stats).not.toBeNull();
      expect(stats.total).toBe(0);
      expect(stats.uniqueUsers).toBe(0);
      expect(stats.activeLastDay).toBe(0);
      expect(stats.activeLastWeek).toBe(0);
      expect(stats.stale).toBe(0);
      expect(stats.avgSubscriptionsPerUser).toBe(0);
    });

    it('should report totals and unique users', async () => {
      // userA = 2 zariadenia, userB = 1 zariadenie
      await PushSubscription.create([
        { userId: userA._id, endpoint: 'e1', keys: { p256dh: 'a', auth: 'b' } },
        { userId: userA._id, endpoint: 'e2', keys: { p256dh: 'a', auth: 'b' } },
        { userId: userB._id, endpoint: 'e3', keys: { p256dh: 'a', auth: 'b' } }
      ]);

      const stats = await subscriptionCleanup.getSubscriptionStats();
      expect(stats.total).toBe(3);
      expect(stats.uniqueUsers).toBe(2);
      expect(stats.avgSubscriptionsPerUser).toBe('1.50');
    });

    it('should classify subs by lastUsed timeframes', async () => {
      // recent (today)
      await PushSubscription.create({
        userId: userA._id,
        endpoint: 'recent',
        keys: { p256dh: 'a', auth: 'b' }
      });

      // 3 days old — mimo "last day", vnútri "last week"
      const s3d = await PushSubscription.create({
        userId: userA._id,
        endpoint: '3d',
        keys: { p256dh: 'a', auth: 'b' }
      });
      s3d.lastUsed = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      await s3d.save();

      // 40 dní stará
      const stale = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'stale',
        keys: { p256dh: 'a', auth: 'b' }
      });
      stale.lastUsed = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await stale.save();

      const stats = await subscriptionCleanup.getSubscriptionStats();
      expect(stats.total).toBe(3);
      expect(stats.activeLastDay).toBe(1);
      expect(stats.activeLastWeek).toBe(2);
      expect(stats.stale).toBe(1);
    });
  });
});
