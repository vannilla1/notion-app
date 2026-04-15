const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const PushSubscription = require('../../models/PushSubscription');
const APNsDevice = require('../../models/APNsDevice');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * /api/push route testy — Web Push + APNs device registration.
 *
 * Testujeme:
 *   - auth gate na všetkých chránených endpointoch
 *   - endpoint URL validácia (musí byť https://)
 *   - keys format validácia (base64url regex)
 *   - upsert správanie na duplicate endpoint (update namiesto create)
 *   - APNs token normalization (hex-only, lowercase, min 32 chars)
 *   - tenant isolation: DELETE cudziu subscription = no-op (0 deleted)
 *   - admin-only endpointy (403 pre bežného usera)
 */
describe('/api/push route', () => {
  let app;
  let ctx;
  let otherCtx;
  let pushRouter;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    await PushSubscription.init();
    await APNsDevice.init();
    pushRouter = require('../../routes/push');
    ({ app } = createTestApp('/api/push', pushRouter));
  });

  beforeEach(async () => {
    await PushSubscription.deleteMany({});
    await APNsDevice.deleteMany({});
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    ctx = await createUserWithWorkspace({
      username: 'user1', email: 'u1@test.com', role: 'member', workspaceName: 'WS 1'
    });
    otherCtx = await createUserWithWorkspace({
      username: 'user2', email: 'u2@test.com', role: 'member', workspaceName: 'WS 2'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('GET /vapid-public-key', () => {
    it('503 ak VAPID nie je nakonfigurovaný (žiadny auth required)', async () => {
      const originalPub = process.env.VAPID_PUBLIC_KEY;
      const originalPriv = process.env.VAPID_PRIVATE_KEY;
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;

      const res = await request(app).get('/api/push/vapid-public-key');
      expect(res.status).toBe(503);

      if (originalPub) process.env.VAPID_PUBLIC_KEY = originalPub;
      if (originalPriv) process.env.VAPID_PRIVATE_KEY = originalPriv;
    });
  });

  describe('POST /subscribe', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).post('/api/push/subscribe').send({});
      expect(res.status).toBe(401);
    });

    it('vytvorí novú subscription', async () => {
      const res = await request(app)
        .post('/api/push/subscribe')
        .set(authHeader(ctx.token))
        .send({
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc-123',
          keys: { p256dh: 'BBase64UrlKey_abc-_', auth: 'AuthToken_xyz' }
        });

      expect(res.status).toBe(200);
      expect(res.body.subscriptionId).toBeDefined();

      const inDb = await PushSubscription.findOne({ userId: ctx.user._id });
      expect(inDb).not.toBeNull();
      expect(inDb.endpoint).toContain('fcm.googleapis.com');
    });

    it('400 pri non-https endpointe', async () => {
      const res = await request(app)
        .post('/api/push/subscribe')
        .set(authHeader(ctx.token))
        .send({
          endpoint: 'http://insecure.example.com/x',
          keys: { p256dh: 'a', auth: 'b' }
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/endpoint/i);
    });

    it('400 pri chýbajúcich keys', async () => {
      const res = await request(app)
        .post('/api/push/subscribe')
        .set(authHeader(ctx.token))
        .send({ endpoint: 'https://push.example.com/x' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/keys/i);
    });

    it('400 pri invalid key formáte (non-base64url znaky)', async () => {
      const res = await request(app)
        .post('/api/push/subscribe')
        .set(authHeader(ctx.token))
        .send({
          endpoint: 'https://push.example.com/x',
          keys: { p256dh: 'has spaces and special chars!', auth: 'xyz' }
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/format/i);
    });

    it('upsert: duplicate endpoint aktualizuje existujúcu subscription', async () => {
      const shared = 'https://push.example.com/shared';
      await request(app)
        .post('/api/push/subscribe')
        .set(authHeader(ctx.token))
        .send({ endpoint: shared, keys: { p256dh: 'key1', auth: 'auth1' } });

      // Druhýkrát s iným user tokenom + novými keys
      const res = await request(app)
        .post('/api/push/subscribe')
        .set(authHeader(otherCtx.token))
        .send({ endpoint: shared, keys: { p256dh: 'key2', auth: 'auth2' } });

      expect(res.status).toBe(200);
      // Stále existuje len jedna subscription s týmto endpointom
      const all = await PushSubscription.find({ endpoint: shared });
      expect(all).toHaveLength(1);
      expect(all[0].userId.toString()).toBe(otherCtx.user._id.toString());
      expect(all[0].keys.p256dh).toBe('key2');
    });
  });

  describe('POST /unsubscribe', () => {
    it('zmaže moju subscription', async () => {
      await PushSubscription.create({
        userId: ctx.user._id,
        endpoint: 'https://push.example.com/mine',
        keys: { p256dh: 'a', auth: 'b' }
      });

      const res = await request(app)
        .post('/api/push/unsubscribe')
        .set(authHeader(ctx.token))
        .send({ endpoint: 'https://push.example.com/mine' });

      expect(res.status).toBe(200);
      expect(await PushSubscription.countDocuments({ userId: ctx.user._id })).toBe(0);
    });

    it('tenant isolation: unsubscribe cudziu subscription = no-op', async () => {
      await PushSubscription.create({
        userId: otherCtx.user._id,
        endpoint: 'https://push.example.com/other',
        keys: { p256dh: 'a', auth: 'b' }
      });

      const res = await request(app)
        .post('/api/push/unsubscribe')
        .set(authHeader(ctx.token))
        .send({ endpoint: 'https://push.example.com/other' });

      expect(res.status).toBe(200); // idempotent
      // Cudzia subscription existuje ďalej
      expect(await PushSubscription.countDocuments({ userId: otherCtx.user._id })).toBe(1);
    });

    it('400 bez endpointu', async () => {
      const res = await request(app)
        .post('/api/push/unsubscribe')
        .set(authHeader(ctx.token))
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /subscriptions', () => {
    it('spočíta iba moje subscriptions', async () => {
      await PushSubscription.create([
        { userId: ctx.user._id, endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } },
        { userId: ctx.user._id, endpoint: 'https://push.example.com/2', keys: { p256dh: 'a', auth: 'b' } },
        { userId: otherCtx.user._id, endpoint: 'https://push.example.com/3', keys: { p256dh: 'a', auth: 'b' } }
      ]);

      const res = await request(app)
        .get('/api/push/subscriptions')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
    });
  });

  describe('POST /apns/register', () => {
    it('400 pri príliš krátkom tokene', async () => {
      const res = await request(app)
        .post('/api/push/apns/register')
        .set(authHeader(ctx.token))
        .send({ deviceToken: 'ab12' });
      expect(res.status).toBe(400);
    });

    it('400 ak deviceToken chýba', async () => {
      const res = await request(app)
        .post('/api/push/apns/register')
        .set(authHeader(ctx.token))
        .send({});
      expect(res.status).toBe(400);
    });

    it('normalizuje token na lowercase hex', async () => {
      const rawToken = 'AB' + 'cd'.repeat(31) + 'EF'; // 64 chars with mixed case
      const res = await request(app)
        .post('/api/push/apns/register')
        .set(authHeader(ctx.token))
        .send({ deviceToken: rawToken });

      expect(res.status).toBe(200);
      const dev = await APNsDevice.findOne({ userId: ctx.user._id });
      expect(dev).not.toBeNull();
      // Všetky chars musia byť hex + lowercase
      expect(dev.deviceToken).toMatch(/^[0-9a-f]+$/);
      expect(dev.deviceToken).toBe(rawToken.toLowerCase());
    });

    it('upsert: re-register rovnakého tokenu neduplikuje device', async () => {
      const token = 'a'.repeat(64);
      await request(app)
        .post('/api/push/apns/register')
        .set(authHeader(ctx.token))
        .send({ deviceToken: token });

      await request(app)
        .post('/api/push/apns/register')
        .set(authHeader(ctx.token))
        .send({ deviceToken: token });

      expect(await APNsDevice.countDocuments({ userId: ctx.user._id })).toBe(1);
    });

    it('cleanup: zmaže iOS web push subscriptions pri APNs registrácii', async () => {
      // iOS web push má endpoint na web.push.apple.com — duplikoval by notifikácie
      await PushSubscription.create({
        userId: ctx.user._id,
        endpoint: 'https://web.push.apple.com/abc',
        keys: { p256dh: 'a', auth: 'b' }
      });
      // Non-iOS web push zostane (Chrome)
      await PushSubscription.create({
        userId: ctx.user._id,
        endpoint: 'https://fcm.googleapis.com/fcm/send/xyz',
        keys: { p256dh: 'a', auth: 'b' }
      });

      await request(app)
        .post('/api/push/apns/register')
        .set(authHeader(ctx.token))
        .send({ deviceToken: 'f'.repeat(64) });

      const subs = await PushSubscription.find({ userId: ctx.user._id });
      expect(subs).toHaveLength(1);
      expect(subs[0].endpoint).toContain('fcm.googleapis.com');
    });
  });

  describe('POST /apns/unregister', () => {
    it('zmaže môj device', async () => {
      const token = 'b'.repeat(64);
      await APNsDevice.create({ userId: ctx.user._id, deviceToken: token });

      const res = await request(app)
        .post('/api/push/apns/unregister')
        .set(authHeader(ctx.token))
        .send({ deviceToken: token });

      expect(res.status).toBe(200);
      expect(await APNsDevice.countDocuments({ userId: ctx.user._id })).toBe(0);
    });

    it('tenant isolation: cudzí device sa NESMIE zmazať', async () => {
      const token = 'c'.repeat(64);
      await APNsDevice.create({ userId: otherCtx.user._id, deviceToken: token });

      await request(app)
        .post('/api/push/apns/unregister')
        .set(authHeader(ctx.token))
        .send({ deviceToken: token });

      // Existuje ďalej
      expect(await APNsDevice.countDocuments({ userId: otherCtx.user._id })).toBe(1);
    });
  });

  describe('GET /apns/status', () => {
    it('vráti môj zoznam zariadení (iba vlastné)', async () => {
      const myToken = 'd'.repeat(64);
      const otherToken = 'e'.repeat(64);
      await APNsDevice.create([
        { userId: ctx.user._id, deviceToken: myToken, bundleId: 'sk.perunelectromobility.prplcrm' },
        { userId: otherCtx.user._id, deviceToken: otherToken }
      ]);

      const res = await request(app)
        .get('/api/push/apns/status')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      expect(res.body.registeredDevices).toBe(1);
      expect(res.body.devices[0].tokenPrefix).toBe('dddddddd...');
    });
  });

  describe('Admin-only endpoints', () => {
    it('POST /check-due-dates → 403 pre member', async () => {
      const res = await request(app)
        .post('/api/push/check-due-dates')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(403);
    });

    it('GET /metrics → 403 pre member', async () => {
      const res = await request(app)
        .get('/api/push/metrics')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(403);
    });

    it('POST /metrics/reset → 403 pre member', async () => {
      const res = await request(app)
        .post('/api/push/metrics/reset')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(403);
    });

    it('POST /cleanup-subscriptions → 403 pre member', async () => {
      const res = await request(app)
        .post('/api/push/cleanup-subscriptions')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(403);
    });
  });
});
