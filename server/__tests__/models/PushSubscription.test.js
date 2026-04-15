const mongoose = require('mongoose');
const User = require('../../models/User');
const PushSubscription = require('../../models/PushSubscription');

/**
 * PushSubscription model testy — Web Push API subscription storage.
 *
 * Invariants (viď server/models/PushSubscription.js):
 *   - userId, endpoint sú required
 *   - endpoint je unique (jeden browser = jedna subscription)
 *   - keys.p256dh + keys.auth sú required (šifrovanie payloadu)
 *   - lastUsed default now — sledované pre subscriptionCleanup service
 *     (30-day stale threshold → viď services/subscriptionCleanup.js)
 */
describe('PushSubscription model', () => {
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

  describe('Creation & required fields', () => {
    it('should create a push subscription with required fields', async () => {
      const sub = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
        keys: {
          p256dh: 'p256dh-public-key-string',
          auth: 'auth-secret-string'
        }
      });

      expect(sub._id).toBeDefined();
      expect(sub.endpoint).toContain('fcm.googleapis.com');
      expect(sub.keys.p256dh).toBe('p256dh-public-key-string');
      expect(sub.keys.auth).toBe('auth-secret-string');
      expect(sub.createdAt).toBeInstanceOf(Date);
      expect(sub.lastUsed).toBeInstanceOf(Date);
      expect(sub.userAgent).toBe('');
    });

    it('should enforce userId as required', async () => {
      await expect(
        PushSubscription.create({
          endpoint: 'https://push.example.com/x',
          keys: { p256dh: 'a', auth: 'b' }
        })
      ).rejects.toThrow();
    });

    it('should enforce endpoint as required', async () => {
      await expect(
        PushSubscription.create({
          userId: userA._id,
          keys: { p256dh: 'a', auth: 'b' }
        })
      ).rejects.toThrow();
    });

    it('should enforce keys.p256dh as required', async () => {
      await expect(
        PushSubscription.create({
          userId: userA._id,
          endpoint: 'https://push.example.com/x',
          keys: { auth: 'b' }
        })
      ).rejects.toThrow();
    });

    it('should enforce keys.auth as required', async () => {
      await expect(
        PushSubscription.create({
          userId: userA._id,
          endpoint: 'https://push.example.com/x',
          keys: { p256dh: 'a' }
        })
      ).rejects.toThrow();
    });

    it('should accept optional userAgent for diagnostics', async () => {
      const sub = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://push.example.com/chrome',
        keys: { p256dh: 'a', auth: 'b' },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120'
      });
      expect(sub.userAgent).toContain('Chrome');
    });
  });

  describe('Unique endpoint constraint', () => {
    it('should enforce unique endpoint across subscriptions', async () => {
      const shared = 'https://fcm.googleapis.com/fcm/send/unique-xyz';
      await PushSubscription.create({
        userId: userA._id,
        endpoint: shared,
        keys: { p256dh: 'a', auth: 'b' }
      });

      await expect(
        PushSubscription.create({
          userId: userB._id,
          endpoint: shared,
          keys: { p256dh: 'c', auth: 'd' }
        })
      ).rejects.toThrow(/duplicate key|E11000/i);
    });

    it('should allow one user to have multiple distinct subscriptions (multi-browser)', async () => {
      const chrome = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://fcm.googleapis.com/fcm/send/chrome-id',
        keys: { p256dh: 'a', auth: 'b' }
      });
      const firefox = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://updates.push.services.mozilla.com/firefox-id',
        keys: { p256dh: 'c', auth: 'd' }
      });
      expect(chrome._id.toString()).not.toBe(firefox._id.toString());

      const mine = await PushSubscription.find({ userId: userA._id });
      expect(mine).toHaveLength(2);
    });
  });

  describe('Common queries', () => {
    it('should find all subscriptions for a user (fanout on notification)', async () => {
      await PushSubscription.create([
        { userId: userA._id, endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } },
        { userId: userA._id, endpoint: 'https://push.example.com/2', keys: { p256dh: 'c', auth: 'd' } },
        { userId: userB._id, endpoint: 'https://push.example.com/3', keys: { p256dh: 'e', auth: 'f' } }
      ]);

      const aSubs = await PushSubscription.find({ userId: userA._id });
      expect(aSubs).toHaveLength(2);
    });

    it('should update lastUsed timestamp on successful send', async () => {
      const sub = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://push.example.com/tracked',
        keys: { p256dh: 'a', auth: 'b' }
      });
      const originalLastUsed = sub.lastUsed.getTime();

      await new Promise((r) => setTimeout(r, 30));
      sub.lastUsed = new Date();
      await sub.save();

      const refetched = await PushSubscription.findById(sub._id);
      expect(refetched.lastUsed.getTime()).toBeGreaterThan(originalLastUsed);
    });
  });

  describe('Cleanup query (stale detection)', () => {
    it('should identify subscriptions older than threshold via lastUsed', async () => {
      const fresh = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://push.example.com/fresh',
        keys: { p256dh: 'a', auth: 'b' }
      });

      const stale = await PushSubscription.create({
        userId: userA._id,
        endpoint: 'https://push.example.com/stale',
        keys: { p256dh: 'c', auth: 'd' }
      });
      // Force stale lastUsed: 31 days ago
      stale.lastUsed = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await stale.save();

      const threshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const staleList = await PushSubscription.find({ lastUsed: { $lt: threshold } });
      expect(staleList).toHaveLength(1);
      expect(staleList[0]._id.toString()).toBe(stale._id.toString());
    });
  });
});
