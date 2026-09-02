const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const authRouter = require('../../routes/auth');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const { MAX_RESTORE_TOKENS, hashRestoreToken } = require('../../utils/restoreTokens');

/**
 * Google Play zero-tap sign-in (Block Store) — obnovovacie tokeny.
 * Invarianty:
 *   - plaintext tokenu nikdy nie je v DB ani v /me, /login
 *   - token je jednorazový, pri použití sa rotuje
 *   - zmena aj reset hesla zrušia všetky tokeny
 */
describe('/api/auth restore tokeny (Block Store)', () => {
  let app;
  const loadTokens = async (id) => (await User.findById(id).select('+restoreTokens')).restoreTokens;

  beforeAll(async () => {
    await User.init(); await Workspace.init(); await WorkspaceMember.init();
    ({ app } = createTestApp('/api/auth', authRouter));
  });
  beforeEach(async () => {
    await WorkspaceMember.deleteMany({}); await Workspace.deleteMany({}); await User.deleteMany({});
  });
  afterAll(async () => { await mongoose.connection.close(); });

  const issue = async (token, deviceLabel = 'Pixel 8') =>
    request(app).post('/api/auth/restore-token').set(authHeader(token)).send({ deviceLabel });

  describe('POST /restore-token', () => {
    it('vydá token (200), v DB je len hash, expiresAt ≈ 180 dní', async () => {
      const { user, token } = await createUserWithWorkspace();
      const res = await issue(token);
      expect(res.status).toBe(200);
      expect(typeof res.body.restoreToken).toBe('string');
      expect(res.body.restoreToken.length).toBeGreaterThanOrEqual(40);
      const days = (new Date(res.body.expiresAt) - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(179);
      expect(days).toBeLessThanOrEqual(180);

      const tokens = await loadTokens(user._id);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].tokenHash).toBe(hashRestoreToken(res.body.restoreToken));
      expect(tokens[0].deviceLabel).toBe('Pixel 8');
    });

    it('401 bez JWT', async () => {
      const res = await request(app).post('/api/auth/restore-token').send({});
      expect(res.status).toBe(401);
    });

    it('403 pre super admina', async () => {
      const { token } = await createUserWithWorkspace({ username: 'sa', email: 'support@prplcrm.eu' });
      expect((await issue(token)).status).toBe(403);
    });

    it('drží strop MAX_RESTORE_TOKENS', async () => {
      const { user, token } = await createUserWithWorkspace();
      for (let i = 0; i <= MAX_RESTORE_TOKENS; i++) await issue(token, `d${i}`);
      expect(await loadTokens(user._id)).toHaveLength(MAX_RESTORE_TOKENS);
    });
  });

  describe('POST /restore', () => {
    it('vráti nový JWT (funguje na /me) + rotovaný token; starý token už neplatí', async () => {
      const { user, token } = await createUserWithWorkspace({ email: 'r@test.com' });
      const first = (await issue(token)).body.restoreToken;

      const res = await request(app).post('/api/auth/restore').send({ restoreToken: first });
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual(expect.objectContaining({ email: 'r@test.com', username: 'testuser' }));
      expect(res.body.user.password).toBeUndefined();
      expect(res.body.user.restoreTokens).toBeUndefined();
      expect(res.body.restoreToken).not.toBe(first);

      const me = await request(app).get('/api/auth/me').set(authHeader(res.body.token));
      expect(me.status).toBe(200);
      expect(me.body.email).toBe('r@test.com');
      expect(me.body.restoreTokens).toBeUndefined();

      expect((await request(app).post('/api/auth/restore').send({ restoreToken: first })).status).toBe(401);
      const again = await request(app).post('/api/auth/restore').send({ restoreToken: res.body.restoreToken });
      expect(again.status).toBe(200);
      expect(await loadTokens(user._id)).toHaveLength(1);
    });

    it('401 pre expirovaný token a záznam sa odstráni', async () => {
      const { user, token } = await createUserWithWorkspace();
      const plain = (await issue(token)).body.restoreToken;
      await User.updateOne(
        { _id: user._id, 'restoreTokens.tokenHash': hashRestoreToken(plain) },
        { $set: { 'restoreTokens.$.expiresAt': new Date(Date.now() - 1000) } }
      );
      expect((await request(app).post('/api/auth/restore').send({ restoreToken: plain })).status).toBe(401);
      expect(await loadTokens(user._id)).toHaveLength(0);
    });

    it('401 pre neznámy token, 400 pre chýbajúci', async () => {
      expect((await request(app).post('/api/auth/restore').send({ restoreToken: 'x'.repeat(43) })).status).toBe(401);
      expect((await request(app).post('/api/auth/restore').send({})).status).toBe(400);
    });

    it('token zrušený cez DELETE /restore-token už neobnoví; DELETE je idempotentný', async () => {
      const { user, token } = await createUserWithWorkspace();
      const plain = (await issue(token)).body.restoreToken;
      const del = await request(app).delete('/api/auth/restore-token').send({ restoreToken: plain });
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ ok: true });
      expect(await loadTokens(user._id)).toHaveLength(0);
      expect((await request(app).post('/api/auth/restore').send({ restoreToken: plain })).status).toBe(401);
      expect((await request(app).delete('/api/auth/restore-token').send({ restoreToken: plain })).status).toBe(200);
      expect((await request(app).delete('/api/auth/restore-token').send({})).status).toBe(200);
    });
  });

  describe('revokácia pri zmene / resete hesla', () => {
    it('PUT /password vyprázdni restoreTokens', async () => {
      const { user, token } = await createUserWithWorkspace();
      await User.updateOne({ _id: user._id }, { password: await bcrypt.hash('Kr4sn0hOrsk3!x', 12) });
      await issue(token);
      const res = await request(app).put('/api/auth/password').set(authHeader(token))
        .send({ currentPassword: 'Kr4sn0hOrsk3!x', newPassword: 'N0veHesl0Silne!x' });
      expect(res.status).toBe(200);
      expect(await loadTokens(user._id)).toHaveLength(0);
    });

    it('POST /reset-password vyprázdni restoreTokens', async () => {
      const { user, token } = await createUserWithWorkspace();
      await issue(token);
      const raw = crypto.randomBytes(32).toString('hex');
      await User.updateOne({ _id: user._id }, {
        resetPasswordTokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
        resetPasswordExpires: new Date(Date.now() + 3600000)
      });
      const res = await request(app).post('/api/auth/reset-password').send({ token: raw, newPassword: 'N0veHesl0Silne!x' });
      expect(res.status).toBe(200);
      expect(await loadTokens(user._id)).toHaveLength(0);
    });
  });
});
