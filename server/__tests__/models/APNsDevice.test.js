const mongoose = require('mongoose');
const User = require('../../models/User');
const APNsDevice = require('../../models/APNsDevice');

/**
 * APNsDevice model testy — iOS push notifikácie.
 *
 * Invariants (viď server/models/APNsDevice.js):
 *   - deviceToken je unique (1 zariadenie = 1 záznam; ak si používateľ
 *     reinštaluje appku, Apple vygeneruje nový token a starý sa má
 *     zmazať cez cleanup)
 *   - userId je required a index (najčastejší query: "all devices for user")
 *   - apnsEnvironment enum: production | sandbox | null (null = auto-detekcia
 *     pri prvom sende)
 *   - bundleId default = 'sk.perunelectromobility.prplcrm' (produkčný
 *     bundle; musí sa zhodovať s iOS app bundle ID inak APNs odmietne)
 */
describe('APNsDevice model', () => {
  let user;
  let otherUser;

  beforeAll(async () => {
    await User.init();
    await APNsDevice.init();
  });

  beforeEach(async () => {
    await APNsDevice.deleteMany({});
    await User.deleteMany({});

    user = await User.create({
      username: 'iosuser',
      email: 'ios@test.com',
      password: 'hashedpw'
    });
    otherUser = await User.create({
      username: 'otheruser',
      email: 'other@test.com',
      password: 'hashedpw'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Creation & defaults', () => {
    it('should create a device with required fields', async () => {
      const dev = await APNsDevice.create({
        userId: user._id,
        deviceToken: 'a'.repeat(64) // typický APNs token formát (64 hex chars)
      });

      expect(dev._id).toBeDefined();
      expect(dev.userId.toString()).toBe(user._id.toString());
      expect(dev.deviceToken).toBe('a'.repeat(64));
      expect(dev.bundleId).toBe('sk.perunelectromobility.prplcrm'); // default
      expect(dev.apnsEnvironment).toBeNull(); // auto-detect
      expect(dev.createdAt).toBeInstanceOf(Date);
      expect(dev.lastUsed).toBeInstanceOf(Date);
    });

    it('should enforce userId as required', async () => {
      await expect(
        APNsDevice.create({ deviceToken: 'token-no-user' })
      ).rejects.toThrow();
    });

    it('should enforce deviceToken as required', async () => {
      await expect(
        APNsDevice.create({ userId: user._id })
      ).rejects.toThrow();
    });

    it('should accept apnsEnvironment "production"', async () => {
      const dev = await APNsDevice.create({
        userId: user._id,
        deviceToken: 'prod-token-1',
        apnsEnvironment: 'production'
      });
      expect(dev.apnsEnvironment).toBe('production');
    });

    it('should accept apnsEnvironment "sandbox"', async () => {
      const dev = await APNsDevice.create({
        userId: user._id,
        deviceToken: 'sandbox-token-1',
        apnsEnvironment: 'sandbox'
      });
      expect(dev.apnsEnvironment).toBe('sandbox');
    });

    it('should reject invalid apnsEnvironment', async () => {
      await expect(
        APNsDevice.create({
          userId: user._id,
          deviceToken: 'bad-env-token',
          apnsEnvironment: 'testflight' // not in enum
        })
      ).rejects.toThrow();
    });
  });

  describe('Unique deviceToken constraint', () => {
    it('should NOT allow two records with the same deviceToken', async () => {
      // Kritické: ak by deviceToken nebol unique, push by išiel viacnásobne
      // tomu istému zariadeniu (user by dostal duplicitné notifikácie).
      await APNsDevice.create({
        userId: user._id,
        deviceToken: 'shared-token'
      });

      await expect(
        APNsDevice.create({
          userId: otherUser._id, // iný user, rovnaký token
          deviceToken: 'shared-token'
        })
      ).rejects.toThrow(/duplicate key|E11000/i);
    });

    it('should allow multiple devices per user (iPhone + iPad)', async () => {
      // Jeden user môže mať viacero zariadení (iPhone + iPad + iPhone SE…).
      await APNsDevice.create({
        userId: user._id,
        deviceToken: 'iphone-token'
      });
      await APNsDevice.create({
        userId: user._id,
        deviceToken: 'ipad-token'
      });

      const devices = await APNsDevice.find({ userId: user._id });
      expect(devices).toHaveLength(2);
    });
  });

  describe('Common queries', () => {
    it('should find all devices for a user', async () => {
      await APNsDevice.create([
        { userId: user._id, deviceToken: 'dev-1' },
        { userId: user._id, deviceToken: 'dev-2' },
        { userId: otherUser._id, deviceToken: 'dev-3' }
      ]);

      const mine = await APNsDevice.find({ userId: user._id });
      expect(mine).toHaveLength(2);
      expect(mine.every(d => d.userId.toString() === user._id.toString())).toBe(true);
    });

    it('should update lastUsed timestamp', async () => {
      const dev = await APNsDevice.create({
        userId: user._id,
        deviceToken: 'last-used-token'
      });
      const original = dev.lastUsed;

      await new Promise((resolve) => setTimeout(resolve, 20));

      dev.lastUsed = new Date();
      await dev.save();

      expect(dev.lastUsed.getTime()).toBeGreaterThan(original.getTime());
    });

    it('should remove device on cleanup (invalid token scenario)', async () => {
      // Simulácia cleanup po APNs BadDeviceToken response.
      const dev = await APNsDevice.create({
        userId: user._id,
        deviceToken: 'stale-token'
      });

      const res = await APNsDevice.deleteOne({ deviceToken: 'stale-token' });
      expect(res.deletedCount).toBe(1);

      const notThere = await APNsDevice.findById(dev._id);
      expect(notThere).toBeNull();
    });
  });
});
