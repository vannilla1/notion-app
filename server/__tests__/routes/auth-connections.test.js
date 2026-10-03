/**
 * auth-connections route tests — list providerov + disconnect.
 */
require('../helpers/testApp'); // setne JWT_SECRET

const request = require('supertest');
const User = require('../../models/User');
const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const authConnectionsRoutes = require('../../routes/auth-connections');
const oauthService = require('../../services/oauthService');
const bcrypt = require('bcryptjs');

describe('auth-connections routes', () => {
  let app;

  beforeAll(async () => {
    await User.init();
    ({ app } = createTestApp('/api/auth/connections', authConnectionsRoutes));
  });

  // ───────────────────────────────────────────────────────────────────
  describe('GET /', () => {
    it('vyžaduje JWT auth', async () => {
      const res = await request(app).get('/api/auth/connections');
      expect(res.status).toBe(401);
    });

    it('vráti providers, hasGoogle/hasApple/hasPassword flagy', async () => {
      const { user, token } = await createUserWithWorkspace({
        username: 'multi',
        email: 'multi@test.com'
      });
      // Pridaj googleId manuálne
      user.googleId = 'multi-google-id';
      user.authProviders = ['password', 'google'];
      user.avatarUrl = 'https://lh3/x';
      await user.save();

      const res = await request(app)
        .get('/api/auth/connections')
        .set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.providers.sort()).toEqual(['google', 'password']);
      expect(res.body.hasGoogle).toBe(true);
      expect(res.body.hasApple).toBe(false);
      expect(res.body.hasPassword).toBe(true);
      expect(res.body.avatarUrl).toBe('https://lh3/x');
    });
  });

  describe('DELETE /:provider', () => {
    it('vyžaduje JWT auth', async () => {
      const res = await request(app).delete('/api/auth/connections/google');
      expect(res.status).toBe(401);
    });

    it('odpojí Google keď user má aj password', async () => {
      const { user, token } = await createUserWithWorkspace({
        username: 'unlink',
        email: 'unlink@test.com'
      });
      user.googleId = 'unlink-google';
      user.authProviders = ['password', 'google'];
      user.password = await bcrypt.hash('Sprav1eHeslo', 4);
      await user.save();

      // Bez aktuálneho hesla → re-autentifikácia
      const denied = await request(app)
        .delete('/api/auth/connections/google')
        .set(authHeader(token));
      expect(denied.status).toBe(400);
      expect(denied.body.code).toBe('REAUTH_REQUIRED');

      const res = await request(app)
        .delete('/api/auth/connections/google')
        .set(authHeader(token))
        .send({ currentPassword: 'Sprav1eHeslo' });
      expect(res.status).toBe(200);
      expect(res.body.providers).toEqual(['password']);

      const refreshed = await User.findById(user._id);
      expect(refreshed.googleId).toBeUndefined();
    });

    it('400 LAST_LOGIN_METHOD keď je posledná metóda', async () => {
      const { user, token } = await createUserWithWorkspace({
        username: 'onlypw',
        email: 'opw@test.com'
      });
      user.password = await bcrypt.hash('Sprav1eHeslo', 4);
      await user.save();
      // Default user má authProviders=['password'] (nepridali sme google)
      const res = await request(app)
        .delete('/api/auth/connections/password')
        .set(authHeader(token))
        .send({ currentPassword: 'Sprav1eHeslo' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LAST_LOGIN_METHOD');
    });

    it('400 INVALID_PROVIDER pre neznámy provider', async () => {
      const { user, token } = await createUserWithWorkspace({
        username: 'badprov',
        email: 'bp@test.com'
      });
      user.password = await bcrypt.hash('Sprav1eHeslo', 4);
      await user.save();
      const res = await request(app)
        .delete('/api/auth/connections/facebook')
        .set(authHeader(token))
        .send({ currentPassword: 'Sprav1eHeslo' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PROVIDER');
    });
  });

  describe('POST /complete', () => {
    it('pripojí identitu len vlastníkovi pending tokenu', async () => {
      const { user, token } = await createUserWithWorkspace({ username: 'owner1', email: 'owner1@test.com' });
      const { token: otherToken } = await createUserWithWorkspace({ username: 'other1', email: 'other1@test.com' });
      const pending = oauthService.signConnectPending({
        userId: user._id.toString(),
        provider: 'google',
        profile: { providerId: 'g-complete-1', email: 'owner1@test.com', emailVerified: true }
      });

      // Iný prihlásený používateľ (CSRF scenár) → 403, nič sa nepripojí
      const mismatch = await request(app)
        .post('/api/auth/connections/complete')
        .set(authHeader(otherToken))
        .send({ pending });
      expect(mismatch.status).toBe(403);
      expect((await User.findById(user._id)).googleId).toBeUndefined();

      const ok = await request(app)
        .post('/api/auth/connections/complete')
        .set(authHeader(token))
        .send({ pending });
      expect(ok.status).toBe(200);
      expect((await User.findById(user._id)).googleId).toBe('g-complete-1');
    });

    it('400 pre neplatný alebo login state namiesto pending tokenu', async () => {
      const { token } = await createUserWithWorkspace({ username: 'owner2', email: 'owner2@test.com' });
      const res = await request(app)
        .post('/api/auth/connections/complete')
        .set(authHeader(token))
        .send({ pending: oauthService.signState({ mode: 'login' }) });
      expect(res.status).toBe(400);
    });
  });
});
