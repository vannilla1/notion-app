/**
 * auth-google route tests — mockuje googleapis OAuth2 client.
 *
 * Pokrýva:
 *   - 503 keď nie je nakonfigurované
 *   - GET /login → 302 redirect na Google
 *   - GET /callback → handle tampered state, missing params, valid login, connect
 *   - POST /native → invalid idToken, valid idToken (new + existing user)
 */

// Set Google env BEFORE requiring routes (lib reads them at module load)
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/api/auth/google/callback';
process.env.CLIENT_URL = 'https://app.test';

require('../helpers/testApp'); // setne JWT_SECRET

// Mock googleapis pred require routes
const mockGenerateAuthUrl = jest.fn();
const mockVerifyIdToken = jest.fn();
const mockGetToken = jest.fn();
const mockOAuth2Constructor = jest.fn(() => ({
  generateAuthUrl: mockGenerateAuthUrl,
  verifyIdToken: mockVerifyIdToken,
  getToken: mockGetToken
}));

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: mockOAuth2Constructor
    }
  }
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const oauthService = require('../../services/oauthService');
const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const authGoogleRoutes = require('../../routes/auth-google');

describe('auth-google routes', () => {
  let app;

  beforeAll(async () => {
    await User.init();
    ({ app } = createTestApp('/api/auth/google', authGoogleRoutes));
  });

  beforeEach(() => {
    mockGenerateAuthUrl.mockReset();
    mockVerifyIdToken.mockReset();
    mockGetToken.mockReset();
    // Default: generateAuthUrl vráti URL postavenú zo state
    mockGenerateAuthUrl.mockImplementation((opts) =>
      `https://accounts.google.com/oauth?state=${encodeURIComponent(opts.state)}`);
  });

  // ───────────────────────────────────────────────────────────────────
  describe('GET /login', () => {
    it('redirectuje na Google s podpísaným state v URL', async () => {
      const res = await request(app).get('/api/auth/google/login');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/oauth/);
      expect(mockGenerateAuthUrl).toHaveBeenCalled();
    });

    it('akceptuje returnUrl a propaguje ho do state', async () => {
      const res = await request(app)
        .get('/api/auth/google/login')
        .query({ returnUrl: '/app/projects' });
      expect(res.status).toBe(302);
      // Zo state by sme vedeli verifyState a získať returnUrl
      const url = new URL(res.headers.location);
      const state = url.searchParams.get('state');
      const decoded = oauthService.verifyState(state);
      expect(decoded.returnUrl).toBe('/app/projects');
      expect(decoded.mode).toBe('login');
    });

    it('returnUrl s absolútnou URL je ignorovaný (open redirect protection)', async () => {
      const res = await request(app)
        .get('/api/auth/google/login')
        .query({ returnUrl: 'https://evil.com/steal' });
      expect(res.status).toBe(302);
      const url = new URL(res.headers.location);
      const state = url.searchParams.get('state');
      const decoded = oauthService.verifyState(state);
      expect(decoded.returnUrl).toBe('/app/dashboard'); // sanitize fallback
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('GET /callback', () => {
    it('redirectuje s error keď user zruší v Google', async () => {
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ error: 'access_denied' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=USER_CANCELLED');
    });

    it('redirectuje s error keď chýba code/state', async () => {
      const res = await request(app).get('/api/auth/google/callback');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=MISSING_PARAMS');
    });

    it('redirectuje s STATE_INVALID keď state je tampered', async () => {
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'fake-code', state: 'tampered.signature' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=STATE_INVALID/);
    });

    it('LOGIN flow — vytvorí new user-a a redirectuje s token v hash', async () => {
      // Setup mocky
      mockGetToken.mockResolvedValue({
        tokens: { id_token: 'fake-id-token' }
      });
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-sub-12345',
          email: 'newuser@test.com',
          email_verified: true,
          name: 'New User',
          picture: 'https://lh3.googleusercontent.com/abc'
        })
      });

      const state = oauthService.signState({ mode: 'login', returnUrl: '/app/dashboard' });
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code-001', state });

      expect(res.status).toBe(302);
      const loc = res.headers.location;
      expect(loc).toMatch(/^https:\/\/app\.test\/auth\/callback/);
      expect(loc).toMatch(/isNew=1/);
      expect(loc).toMatch(/provider=google/);
      // Token je vo fragmente (#hash)
      expect(loc).toMatch(/#token=/);

      // User skutočne vytvorený v DB
      const created = await User.findOne({ googleId: 'google-sub-12345' });
      expect(created).toBeDefined();
      expect(created.email).toBe('newuser@test.com');
      expect(created.authProviders).toEqual(['google']);
    });

    it('LOGIN flow — auto-link existing password user (verified email)', async () => {
      const existing = await User.create({
        username: 'classic',
        email: 'classic@test.com',
        password: 'h',
        authProviders: ['password']
      });

      mockGetToken.mockResolvedValue({ tokens: { id_token: 'idt' } });
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-classic',
          email: 'classic@test.com',
          email_verified: true
        })
      });

      const state = oauthService.signState({ mode: 'login' });
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'c', state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/linked=1/);

      const refreshed = await User.findById(existing._id);
      expect(refreshed.googleId).toBe('google-classic');
      expect(refreshed.authProviders.sort()).toEqual(['google', 'password']);
    });

    it('LOGIN flow — block unverified email', async () => {
      await User.create({
        username: 'unver',
        email: 'unver@test.com',
        password: 'h',
        authProviders: ['password']
      });
      mockGetToken.mockResolvedValue({ tokens: { id_token: 'idt' } });
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-unver',
          email: 'unver@test.com',
          email_verified: false
        })
      });
      const state = oauthService.signState({ mode: 'login' });
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'c', state });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=EMAIL_EXISTS_UNVERIFIED/);
    });

    it('CONNECT flow — pripojí Google k existing user-ovi', async () => {
      const user = await User.create({
        username: 'connectme',
        email: 'connectme@test.com',
        password: 'h',
        authProviders: ['password']
      });

      mockGetToken.mockResolvedValue({ tokens: { id_token: 'idt' } });
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-conn-x',
          email: 'connectme@test.com',
          email_verified: true,
          picture: 'https://lh3.googleusercontent.com/xyz'
        })
      });

      const state = oauthService.signState({
        mode: 'connect',
        userId: user._id.toString(),
        returnUrl: '/settings/connections'
      });
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'c', state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/connected=1/);
      expect(res.headers.location).toMatch(/provider=google/);

      const refreshed = await User.findById(user._id);
      expect(refreshed.googleId).toBe('google-conn-x');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('POST /native', () => {
    it('400 keď chýba idToken', async () => {
      const res = await request(app)
        .post('/api/auth/google/native')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/idToken/i);
    });

    it('401 keď je idToken neplatný', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('Invalid token'));
      const res = await request(app)
        .post('/api/auth/google/native')
        .send({ idToken: 'bad-token' });
      expect(res.status).toBe(401);
    });

    it('200 + token pri valid idToken (new user)', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'native-sub-001',
          email: 'native@test.com',
          email_verified: true,
          name: 'Native User',
          picture: 'https://lh3.googleusercontent.com/n'
        })
      });
      const res = await request(app)
        .post('/api/auth/google/native')
        .send({ idToken: 'valid-token' });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.email).toBe('native@test.com');
      expect(res.body.isNew).toBe(true);

      // Token je validný
      const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
      expect(decoded.id).toBeDefined();
    });

    it('200 pri valid idToken (returning user)', async () => {
      const existing = await User.create({
        username: 'returning',
        email: 'ret@test.com',
        googleId: 'native-returning',
        authProviders: ['google']
      });
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'native-returning',
          email: 'ret@test.com',
          email_verified: true
        })
      });
      const res = await request(app)
        .post('/api/auth/google/native')
        .send({ idToken: 'valid-token' });
      expect(res.status).toBe(200);
      expect(res.body.isNew).toBe(false);
      expect(res.body.user.id.toString()).toBe(existing._id.toString());
    });

    it('409 EMAIL_EXISTS_UNVERIFIED keď email match ale neoverený', async () => {
      await User.create({
        username: 'pwonly',
        email: 'pw@test.com',
        password: 'h',
        authProviders: ['password']
      });
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'native-pw',
          email: 'pw@test.com',
          email_verified: false
        })
      });
      const res = await request(app)
        .post('/api/auth/google/native')
        .send({ idToken: 'valid-token' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EMAIL_EXISTS_UNVERIFIED');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('POST /connect-native', () => {
    it('vyžaduje JWT auth', async () => {
      const res = await request(app)
        .post('/api/auth/google/connect-native')
        .send({ idToken: 'x' });
      expect(res.status).toBe(401);
    });

    it('pripojí Google k logged-in user-ovi', async () => {
      const { user, token } = await createUserWithWorkspace({
        username: 'connectauth',
        email: 'connectauth@test.com'
      });
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'connect-auth-google',
          email: 'connectauth@test.com',
          email_verified: true,
          picture: 'https://lh3.googleusercontent.com/x'
        })
      });
      const res = await request(app)
        .post('/api/auth/google/connect-native')
        .set(authHeader(token))
        .send({ idToken: 'valid-token' });
      expect(res.status).toBe(200);
      expect(res.body.user.authProviders).toContain('google');
      const refreshed = await User.findById(user._id);
      expect(refreshed.googleId).toBe('connect-auth-google');
    });

    it('409 PROVIDER_ID_TAKEN keď providerId patrí inému user-ovi', async () => {
      const { token } = await createUserWithWorkspace({
        username: 'fightuser',
        email: 'fight@test.com'
      });
      // Iný user už má tento googleId
      await User.create({
        username: 'owner',
        email: 'owner@test.com',
        password: 'h',
        googleId: 'shared-google-id',
        authProviders: ['password', 'google']
      });
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'shared-google-id',
          email: 'fight@test.com',
          email_verified: true
        })
      });
      const res = await request(app)
        .post('/api/auth/google/connect-native')
        .set(authHeader(token))
        .send({ idToken: 'valid' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PROVIDER_ID_TAKEN');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('POST /connect-init', () => {
    it('vyžaduje JWT auth', async () => {
      const res = await request(app)
        .post('/api/auth/google/connect-init')
        .send({});
      expect(res.status).toBe(401);
    });

    it('vráti URL s connect mode v state', async () => {
      const { user, token } = await createUserWithWorkspace({
        username: 'connectinit',
        email: 'connectinit@test.com'
      });
      const res = await request(app)
        .post('/api/auth/google/connect-init')
        .set(authHeader(token))
        .send({ returnUrl: '/settings' });
      expect(res.status).toBe(200);
      expect(res.body.url).toMatch(/^https:\/\/accounts\.google\.com\/oauth/);
      // Decode state
      const url = new URL(res.body.url);
      const state = url.searchParams.get('state');
      const decoded = oauthService.verifyState(state);
      expect(decoded.mode).toBe('connect');
      expect(decoded.userId).toBe(user._id.toString());
      expect(decoded.returnUrl).toBe('/settings');
    });
  });
});
