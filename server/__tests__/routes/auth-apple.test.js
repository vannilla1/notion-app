/**
 * auth-apple route tests — mockuje jose (Apple JWKS verification) a global fetch
 * (Apple token exchange).
 *
 * Pokrýva:
 *   - 503 keď nie je nakonfigurované (APPLE_TEAM_ID/SERVICE_ID/PRIVATE_KEY chýba)
 *   - GET /login → 302 redirect na Apple
 *   - POST /callback (form_post) → handle invalid state, valid login flow
 *   - POST /native → invalid identityToken, new user, returning user
 *   - POST /connect-native → auth required, connect existing user
 */

// Set Apple env BEFORE requiring routes. Generate real test ECDSA P-256 key
// pre client_secret JWT signing — jwt.sign(ES256) odmietne fake key.
const { generateKeyPairSync } = require('crypto');
const { privateKey: testEcKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const TEST_PEM = testEcKey.export({ format: 'pem', type: 'pkcs8' });

process.env.APPLE_TEAM_ID = 'TEAM123ABC';
process.env.APPLE_KEY_ID = 'KEY456DEF';
process.env.APPLE_PRIVATE_KEY = TEST_PEM;
process.env.APPLE_SERVICE_ID = 'eu.prplcrm.signin';
process.env.APPLE_APP_BUNDLE_ID = 'eu.prplcrm.app';
process.env.APPLE_OAUTH_REDIRECT_URI = 'https://api.test/api/auth/apple/callback';
process.env.CLIENT_URL = 'https://app.test';

require('../helpers/testApp'); // setne JWT_SECRET

// Mock jose (dynamic import). Apple route lazy-loaduje jose cez `await import('jose')`.
const mockJwtVerify = jest.fn();
const mockCreateRemoteJWKSet = jest.fn(() => 'mock-jwks-instance');
jest.mock('jose', () => ({
  createRemoteJWKSet: mockCreateRemoteJWKSet,
  jwtVerify: mockJwtVerify
}), { virtual: false });

// Mock global fetch (pre Apple token exchange POST)
global.fetch = jest.fn();

const request = require('supertest');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const oauthService = require('../../services/oauthService');
const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const authAppleRoutes = require('../../routes/auth-apple');

describe('auth-apple routes', () => {
  let app;

  beforeAll(async () => {
    await User.init();
    ({ app } = createTestApp('/api/auth/apple', authAppleRoutes));
  });

  beforeEach(() => {
    mockJwtVerify.mockReset();
    global.fetch.mockReset();
  });

  // ───────────────────────────────────────────────────────────────────
  describe('GET /login', () => {
    it('redirectuje na Apple authorize URL s state', async () => {
      const res = await request(app).get('/api/auth/apple/login');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^https:\/\/appleid\.apple\.com\/auth\/authorize/);
      const url = new URL(res.headers.location);
      expect(url.searchParams.get('client_id')).toBe('eu.prplcrm.signin');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('response_mode')).toBe('form_post');
      expect(url.searchParams.get('scope')).toBe('name email');
      const state = url.searchParams.get('state');
      const decoded = oauthService.verifyState(state);
      expect(decoded.mode).toBe('login');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('POST /callback (form_post)', () => {
    it('redirectuje s USER_CANCELLED keď Apple pošle error', async () => {
      const res = await request(app)
        .post('/api/auth/apple/callback')
        .type('form')
        .send({ error: 'user_cancelled_authorize' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=USER_CANCELLED/);
    });

    it('redirectuje s MISSING_PARAMS keď chýba code', async () => {
      const res = await request(app)
        .post('/api/auth/apple/callback')
        .type('form')
        .send({});
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=MISSING_PARAMS/);
    });

    it('LOGIN flow — vytvorí new user-a (Apple relay email)', async () => {
      // Apple token exchange vráti id_token
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id_token: 'fake-apple-id-token' })
      });
      mockJwtVerify.mockResolvedValue({
        payload: {
          sub: 'apple-sub-001',
          email: 'aaa-bbb@privaterelay.appleid.com',
          email_verified: true,
          is_private_email: true
        }
      });
      const state = oauthService.signState({ mode: 'login', returnUrl: '/app/dashboard' });
      const userJson = JSON.stringify({ name: { firstName: 'Apple', lastName: 'User' } });

      const res = await request(app)
        .post('/api/auth/apple/callback')
        .type('form')
        .send({ code: 'apple-code-001', state, user: userJson });

      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^https:\/\/app\.test\/auth\/callback/);
      expect(res.headers.location).toMatch(/isNew=1/);
      expect(res.headers.location).toMatch(/provider=apple/);
      expect(res.headers.location).toMatch(/#token=/);

      const created = await User.findOne({ appleId: 'apple-sub-001' });
      expect(created).toBeDefined();
      expect(created.email).toBe('aaa-bbb@privaterelay.appleid.com');
      expect(created.authProviders).toEqual(['apple']);

      // Apple token exchange bol volaný s correct params
      expect(global.fetch).toHaveBeenCalledWith(
        'https://appleid.apple.com/auth/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' })
        })
      );
    });

    it('redirectuje s STATE_INVALID keď state je tampered', async () => {
      const res = await request(app)
        .post('/api/auth/apple/callback')
        .type('form')
        .send({ code: 'c', state: 'tampered.sig' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=STATE_INVALID/);
    });

    it('CONNECT flow — pripojí Apple k existujúcemu user-ovi', async () => {
      const user = await User.create({
        username: 'connecttoapple',
        email: 'cta@test.com',
        password: 'h',
        authProviders: ['password']
      });
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id_token: 'idt' })
      });
      mockJwtVerify.mockResolvedValue({
        payload: {
          sub: 'apple-conn-x',
          email: 'cta-real@test.com',
          email_verified: true
        }
      });
      const state = oauthService.signState({
        mode: 'connect',
        userId: user._id.toString()
      });
      const res = await request(app)
        .post('/api/auth/apple/callback')
        .type('form')
        .send({ code: 'c', state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/connected=1/);
      const refreshed = await User.findById(user._id);
      expect(refreshed.appleId).toBe('apple-conn-x');
    });

    it('redirectuje s CALLBACK_FAILED keď token exchange zlyhá', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant'
      });
      const state = oauthService.signState({ mode: 'login' });
      const res = await request(app)
        .post('/api/auth/apple/callback')
        .type('form')
        .send({ code: 'bad', state });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=CALLBACK_FAILED/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('POST /native', () => {
    it('400 keď chýba identityToken', async () => {
      const res = await request(app)
        .post('/api/auth/apple/native')
        .send({});
      expect(res.status).toBe(400);
    });

    it('401 keď identityToken nie je verifikovateľný', async () => {
      mockJwtVerify.mockRejectedValue(new Error('JWS signature mismatch'));
      const res = await request(app)
        .post('/api/auth/apple/native')
        .send({ identityToken: 'bad' });
      expect(res.status).toBe(401);
    });

    it('200 + token (new user, real email)', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          sub: 'apple-native-001',
          email: 'realapple@icloud.com',
          email_verified: true,
          is_private_email: false
        }
      });
      const res = await request(app)
        .post('/api/auth/apple/native')
        .send({
          identityToken: 'ok',
          fullName: 'Real Apple',
          email: 'realapple@icloud.com'
        });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.email).toBe('realapple@icloud.com');
      expect(res.body.isNew).toBe(true);

      const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
      expect(decoded.id).toBeDefined();
    });

    it('200 returning user (provider ID match)', async () => {
      const u = await User.create({
        username: 'applereturn',
        email: 'returnapple@icloud.com',
        appleId: 'apple-native-returning',
        authProviders: ['apple']
      });
      mockJwtVerify.mockResolvedValue({
        payload: {
          sub: 'apple-native-returning',
          email: 'returnapple@icloud.com',
          email_verified: true
        }
      });
      const res = await request(app)
        .post('/api/auth/apple/native')
        .send({ identityToken: 'ok' });
      expect(res.status).toBe(200);
      expect(res.body.isNew).toBe(false);
      expect(res.body.user.id.toString()).toBe(u._id.toString());
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('POST /connect-native', () => {
    it('vyžaduje JWT auth', async () => {
      const res = await request(app)
        .post('/api/auth/apple/connect-native')
        .send({ identityToken: 'x' });
      expect(res.status).toBe(401);
    });

    it('pripojí Apple k logged-in user-ovi', async () => {
      const { user, token } = await createUserWithWorkspace({
        username: 'wantapple',
        email: 'wantapple@test.com'
      });
      mockJwtVerify.mockResolvedValue({
        payload: {
          sub: 'wantapple-apple-id',
          email: 'wantapple@privaterelay.appleid.com',
          email_verified: true,
          is_private_email: true
        }
      });
      const res = await request(app)
        .post('/api/auth/apple/connect-native')
        .set(authHeader(token))
        .send({ identityToken: 'ok' });
      expect(res.status).toBe(200);
      expect(res.body.user.authProviders).toContain('apple');
      const refreshed = await User.findById(user._id);
      expect(refreshed.appleId).toBe('wantapple-apple-id');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('POST /connect-init', () => {
    it('vyžaduje JWT auth', async () => {
      const res = await request(app)
        .post('/api/auth/apple/connect-init')
        .send({});
      expect(res.status).toBe(401);
    });

    it('vráti URL s connect mode + userId v state', async () => {
      const { user, token } = await createUserWithWorkspace({
        username: 'appleinit',
        email: 'ai@test.com'
      });
      const res = await request(app)
        .post('/api/auth/apple/connect-init')
        .set(authHeader(token))
        .send({ returnUrl: '/settings/apple' });
      expect(res.status).toBe(200);
      expect(res.body.url).toMatch(/^https:\/\/appleid\.apple\.com\/auth\/authorize/);
      const url = new URL(res.body.url);
      const state = url.searchParams.get('state');
      const decoded = oauthService.verifyState(state);
      expect(decoded.mode).toBe('connect');
      expect(decoded.userId).toBe(user._id.toString());
    });
  });
});
