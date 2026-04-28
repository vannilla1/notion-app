/**
 * auth-connections route tests — list providerov + disconnect.
 */
require('../helpers/testApp'); // setne JWT_SECRET

const request = require('supertest');
const User = require('../../models/User');
const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const authConnectionsRoutes = require('../../routes/auth-connections');

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
      await user.save();

      const res = await request(app)
        .delete('/api/auth/connections/google')
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.providers).toEqual(['password']);

      const refreshed = await User.findById(user._id);
      expect(refreshed.googleId).toBeUndefined();
    });

    it('400 LAST_LOGIN_METHOD keď je posledná metóda', async () => {
      const { token } = await createUserWithWorkspace({
        username: 'onlypw',
        email: 'opw@test.com'
      });
      // Default user má authProviders=['password'] (nepridali sme google)
      const res = await request(app)
        .delete('/api/auth/connections/password')
        .set(authHeader(token));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LAST_LOGIN_METHOD');
    });

    it('400 INVALID_PROVIDER pre neznámy provider', async () => {
      const { token } = await createUserWithWorkspace({
        username: 'badprov',
        email: 'bp@test.com'
      });
      const res = await request(app)
        .delete('/api/auth/connections/facebook')
        .set(authHeader(token));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PROVIDER');
    });
  });
});
