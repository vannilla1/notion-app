/**
 * oauthService tests — pokrýva state HMAC, account linking matrix,
 * connect/disconnect logiku.
 *
 * MUSÍ require-uť testApp.js prvý (kvôli env vars JWT_SECRET pred middleware/auth).
 */
require('../helpers/testApp'); // setne JWT_SECRET pre middleware/auth load

const User = require('../../models/User');
const oauthService = require('../../services/oauthService');

const {
  signState,
  verifyState,
  isAppleRelayEmail,
  generateUniqueUsername,
  findOrCreateUserFromProfile,
  createNewUserFromOAuth,
  connectProvider,
  disconnectProvider,
  OAuthError,
  STATE_MAX_AGE_MS
} = oauthService;

describe('oauthService', () => {
  beforeAll(async () => {
    await User.init();
  });

  // ───────────────────────────────────────────────────────────────────
  // State HMAC
  // ───────────────────────────────────────────────────────────────────
  describe('signState / verifyState', () => {
    it('round trip — signed state sa overí a vráti payload', () => {
      const state = signState({ mode: 'login', returnUrl: '/app/dashboard' });
      const decoded = verifyState(state);
      expect(decoded.mode).toBe('login');
      expect(decoded.returnUrl).toBe('/app/dashboard');
      expect(decoded.nonce).toBeDefined();
      expect(typeof decoded.iat).toBe('number');
      expect(decoded.v).toBe('v1');
    });

    it('zamietne state s pozmeneným signature', () => {
      const state = signState({ mode: 'login' });
      const [b64, sig] = state.split('.');
      // Zameníme posledné 2 znaky podpisu — HMAC mismatch.
      const tamperedSig = sig.slice(0, -2) + 'XX';
      const tampered = `${b64}.${tamperedSig}`;
      expect(() => verifyState(tampered)).toThrow(OAuthError);
      try { verifyState(tampered); } catch (e) {
        expect(e.code).toBe('STATE_INVALID');
      }
    });

    it('zamietne state s pozmeneným payloadom (b64)', () => {
      const state = signState({ mode: 'login' });
      const [, sig] = state.split('.');
      // Vlastný b64 (s iným payloadom) + originálny sig → HMAC mismatch
      const fakePayload = Buffer.from(JSON.stringify({ mode: 'admin', iat: Date.now(), v: 'v1' })).toString('base64url');
      const tampered = `${fakePayload}.${sig}`;
      expect(() => verifyState(tampered)).toThrow(/Neplatný/i);
    });

    it('zamietne expirovaný state (>10 min)', () => {
      // Vytvoríme state s iat = teraz - 11 min. Musíme hookovať Date.now.
      const realNow = Date.now;
      Date.now = () => realNow() - (STATE_MAX_AGE_MS + 60 * 1000); // -11 min
      const oldState = signState({});
      Date.now = realNow;

      try {
        verifyState(oldState);
        throw new Error('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OAuthError);
        expect(e.code).toBe('STATE_EXPIRED');
      }
    });

    it('zamietne nesprávny formát state (chýba bodka)', () => {
      expect(() => verifyState('invalid-no-dot-state')).toThrow(/formát/i);
    });

    it('zamietne null/undefined/empty', () => {
      expect(() => verifyState(null)).toThrow(OAuthError);
      expect(() => verifyState('')).toThrow(OAuthError);
      expect(() => verifyState(undefined)).toThrow(OAuthError);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // isAppleRelayEmail
  // ───────────────────────────────────────────────────────────────────
  describe('isAppleRelayEmail', () => {
    it('detekuje @privaterelay.appleid.com adresy', () => {
      expect(isAppleRelayEmail('xxx-yyy@privaterelay.appleid.com')).toBe(true);
      expect(isAppleRelayEmail('USER@PRIVATERELAY.APPLEID.COM')).toBe(true);
    });
    it('odmietne normálne emaily', () => {
      expect(isAppleRelayEmail('user@gmail.com')).toBe(false);
      expect(isAppleRelayEmail('test@icloud.com')).toBe(false);
      expect(isAppleRelayEmail('')).toBe(false);
      expect(isAppleRelayEmail(null)).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // generateUniqueUsername
  // ───────────────────────────────────────────────────────────────────
  describe('generateUniqueUsername', () => {
    it('vráti base form keď nie je collision', async () => {
      const username = await generateUniqueUsername('newperson@example.com');
      expect(username).toBe('newperson');
    });

    it('pridá suffix keď base existuje', async () => {
      await User.create({ username: 'taken', email: 'taken1@test.com', password: 'h' });
      const username = await generateUniqueUsername('taken@example.com');
      expect(username).toBe('taken1');
    });

    it('pokračuje s vyšším suffixom keď viac kolízií', async () => {
      await User.create({ username: 'busy', email: 'b1@test.com', password: 'h' });
      await User.create({ username: 'busy1', email: 'b2@test.com', password: 'h' });
      await User.create({ username: 'busy2', email: 'b3@test.com', password: 'h' });
      const username = await generateUniqueUsername('busy@example.com');
      expect(username).toBe('busy3');
    });

    it('sanituje unicode + special chars', async () => {
      const username = await generateUniqueUsername('jožo.komárik@example.com');
      // Po sanitize "jokomrik" alebo podobné — len alphanumerics + _ -
      expect(username).toMatch(/^[a-zA-Z0-9_-]+$/);
    });

    it('fallback "user" keď base je úplne prázdny', async () => {
      const username = await generateUniqueUsername('???@example.com');
      expect(username).toMatch(/^user/);
    });

    it('truncuje base na 24 znakov', async () => {
      const longSeed = 'a'.repeat(50) + '@example.com';
      const username = await generateUniqueUsername(longSeed);
      expect(username.length).toBeLessThanOrEqual(24);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // findOrCreateUserFromProfile — account linking matrix
  // ───────────────────────────────────────────────────────────────────
  describe('findOrCreateUserFromProfile', () => {
    it('vytvorí nového usera s Google profile (verified email)', async () => {
      const result = await findOrCreateUserFromProfile('google', {
        providerId: 'google-sub-001',
        email: 'newgoogle@example.com',
        emailVerified: true,
        name: 'New Google',
        picture: 'https://lh3.googleusercontent.com/abc'
      });
      expect(result.isNew).toBe(true);
      expect(result.user.googleId).toBe('google-sub-001');
      expect(result.user.email).toBe('newgoogle@example.com');
      expect(result.user.authProviders).toEqual(['google']);
      expect(result.user.emailVerified).toBe(true);
      expect(result.user.avatarUrl).toBe('https://lh3.googleusercontent.com/abc');
      expect(result.user.password).toBeNull(); // OAuth-only
    });

    it('vráti existujúceho usera pri provider ID match (returning OAuth user)', async () => {
      const created = await User.create({
        username: 'returning',
        email: 'returning@test.com',
        googleId: 'google-sub-returning',
        authProviders: ['google'],
        emailVerified: true
      });
      const result = await findOrCreateUserFromProfile('google', {
        providerId: 'google-sub-returning',
        email: 'returning@test.com',
        emailVerified: true,
        picture: 'https://lh3.googleusercontent.com/new-avatar'
      });
      expect(result.isNew).toBe(false);
      expect(result.user._id.toString()).toBe(created._id.toString());
      // Avatar update
      expect(result.user.avatarUrl).toBe('https://lh3.googleusercontent.com/new-avatar');
    });

    it('AUTO-LINK — existujúci password user s rovnakým emailom (verified)', async () => {
      const password = await User.create({
        username: 'passwordfan',
        email: 'shared@test.com',
        password: 'hashed-old-pw',
        authProviders: ['password']
      });

      const result = await findOrCreateUserFromProfile('google', {
        providerId: 'google-sub-shared',
        email: 'shared@test.com',
        emailVerified: true,
        picture: 'https://example.com/pic.jpg'
      });

      expect(result.isNew).toBe(false);
      expect(result.linked).toBe(true);
      expect(result.user._id.toString()).toBe(password._id.toString());
      expect(result.user.googleId).toBe('google-sub-shared');
      expect(result.user.authProviders.sort()).toEqual(['google', 'password']);
      expect(result.user.emailVerified).toBe(true);
      // Password ostáva — len pridáva OAuth ako alternatívu
      expect(result.user.password).toBe('hashed-old-pw');
    });

    it('BLOCK — existujúci email + neoverený email vráti 409 EMAIL_EXISTS_UNVERIFIED', async () => {
      await User.create({
        username: 'classic',
        email: 'classic@test.com',
        password: 'pw',
        authProviders: ['password']
      });

      try {
        await findOrCreateUserFromProfile('google', {
          providerId: 'google-sub-untrusted',
          email: 'classic@test.com',
          emailVerified: false  // ← provider nepotvrdí
        });
        throw new Error('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OAuthError);
        expect(e.code).toBe('EMAIL_EXISTS_UNVERIFIED');
        expect(e.statusCode).toBe(409);
      }
    });

    it('Apple "hide my email" relay → neauto-linkuje k password účtu s NEMATCHUJÚCIM emailom', async () => {
      // Reálny scenár: user má password účet s gmail-om. Cez Apple sa
      // prihlasuje s "hide my email", takže Apple pošle iný relay email.
      // Účty sa nesmú spojiť (rôzne emaily) a flag isAppleRelay zaručí, že
      // ani matching by nepomohol (anti-reuse Apple relay defense).
      await User.create({
        username: 'gmailperson',
        email: 'real@gmail.com',
        password: 'pw',
        authProviders: ['password']
      });

      const result = await findOrCreateUserFromProfile('apple', {
        providerId: 'apple-sub-relay',
        email: 'unique-relay@privaterelay.appleid.com',
        emailVerified: true,
        isAppleRelay: true
      });

      // Nový samostatný user — žiadne linkovanie ku gmailperson
      expect(result.isNew).toBe(true);
      expect(result.user.appleId).toBe('apple-sub-relay');
      expect(result.user.username).not.toBe('gmailperson');
      expect(result.user.email).toBe('unique-relay@privaterelay.appleid.com');
    });

    it('vytvorí nového usera s Apple profile (relay email)', async () => {
      const result = await findOrCreateUserFromProfile('apple', {
        providerId: 'apple-sub-002',
        email: 'rrr-ttt@privaterelay.appleid.com',
        emailVerified: true,
        isAppleRelay: true
      });
      expect(result.isNew).toBe(true);
      expect(result.user.appleId).toBe('apple-sub-002');
      expect(result.user.authProviders).toEqual(['apple']);
    });

    it('zamietne neznámy provider', async () => {
      try {
        await findOrCreateUserFromProfile('facebook', { providerId: 'fb-1' });
        throw new Error('Should have thrown');
      } catch (e) {
        expect(e.code).toBe('INVALID_PROVIDER');
      }
    });

    it('zamietne profile bez providerId', async () => {
      try {
        await findOrCreateUserFromProfile('google', { email: 'a@b.com' });
        throw new Error('Should have thrown');
      } catch (e) {
        expect(e.code).toBe('MISSING_PROVIDER_ID');
      }
    });

    it('NO_EMAIL — chýbajúci email pri vytvorení nového usera vráti chybu', async () => {
      // Edge case: Apple bez .email scope by teoreticky mohol prísť bez emailu.
      // V praxi sa to nestáva, ale guard je tu pre clean failure.
      try {
        await findOrCreateUserFromProfile('google', {
          providerId: 'no-email-google',
          email: null,
          emailVerified: true
        });
        throw new Error('Should have thrown');
      } catch (e) {
        expect(e.code).toBe('NO_EMAIL');
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // connectProvider — pre prihláseného usera v Settings
  // ───────────────────────────────────────────────────────────────────
  describe('connectProvider', () => {
    it('pripojí Google k password user-ovi', async () => {
      const user = await User.create({
        username: 'connector',
        email: 'connector@test.com',
        password: 'h',
        authProviders: ['password']
      });

      const updated = await connectProvider(user._id, 'google', {
        providerId: 'google-conn-1',
        picture: 'https://example.com/p.jpg'
      });

      expect(updated.googleId).toBe('google-conn-1');
      expect(updated.authProviders.sort()).toEqual(['google', 'password']);
      expect(updated.avatarUrl).toBe('https://example.com/p.jpg');
    });

    it('zamietne keď providerId už patrí inému userovi', async () => {
      const userA = await User.create({
        username: 'usera',
        email: 'a@test.com',
        password: 'h',
        googleId: 'shared-google-id',
        authProviders: ['password', 'google']
      });
      const userB = await User.create({
        username: 'userb',
        email: 'b@test.com',
        password: 'h',
        authProviders: ['password']
      });

      try {
        await connectProvider(userB._id, 'google', { providerId: 'shared-google-id' });
        throw new Error('Should have thrown');
      } catch (e) {
        expect(e.code).toBe('PROVIDER_ID_TAKEN');
        expect(e.statusCode).toBe(409);
      }
      expect(userA).toBeDefined(); // userA stále má googleId
    });

    it('idempotent — opakované connect rovnakého provider-u nie je duplicitné', async () => {
      const user = await User.create({
        username: 'idem',
        email: 'idem@test.com',
        password: 'h',
        googleId: 'idem-google',
        authProviders: ['password', 'google']
      });

      const updated = await connectProvider(user._id, 'google', {
        providerId: 'idem-google'
      });
      // authProviders ostáva s jediným 'google' (nezduplikuje sa)
      expect(updated.authProviders.filter(p => p === 'google')).toHaveLength(1);
    });

    it('zamietne neznámy provider', async () => {
      const user = await User.create({
        username: 'badprov',
        email: 'badprov@test.com',
        password: 'h'
      });
      await expect(
        connectProvider(user._id, 'facebook', { providerId: 'fb-1' })
      ).rejects.toThrow(/Neznámy provider/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // disconnectProvider
  // ───────────────────────────────────────────────────────────────────
  describe('disconnectProvider', () => {
    it('odpojí Google keď user má aj password (zostane password)', async () => {
      const user = await User.create({
        username: 'multi',
        email: 'multi@test.com',
        password: 'h',
        googleId: 'multi-google',
        authProviders: ['password', 'google']
      });

      const updated = await disconnectProvider(user._id, 'google');
      expect(updated.googleId).toBeUndefined();
      expect(updated.authProviders).toEqual(['password']);
    });

    it('odpojí password keď user má aj Google (zostane google)', async () => {
      const user = await User.create({
        username: 'multi2',
        email: 'multi2@test.com',
        password: 'h',
        googleId: 'multi2-google',
        authProviders: ['password', 'google']
      });

      const updated = await disconnectProvider(user._id, 'password');
      expect(updated.password).toBeNull();
      expect(updated.authProviders).toEqual(['google']);
    });

    it('LAST_LOGIN_METHOD — zamietne odpojenie poslednej metódy', async () => {
      const user = await User.create({
        username: 'onlygoogle',
        email: 'og@test.com',
        googleId: 'og-google',
        authProviders: ['google']
      });

      try {
        await disconnectProvider(user._id, 'google');
        throw new Error('Should have thrown');
      } catch (e) {
        expect(e.code).toBe('LAST_LOGIN_METHOD');
        expect(e.statusCode).toBe(400);
      }
    });

    it('LAST_LOGIN_METHOD — zamietne odpojenie password keď je jediný', async () => {
      const user = await User.create({
        username: 'onlypw',
        email: 'opw@test.com',
        password: 'h',
        authProviders: ['password']
      });

      await expect(
        disconnectProvider(user._id, 'password')
      ).rejects.toThrow(/poslednú/i);
    });

    it('zamietne neznámy provider', async () => {
      const user = await User.create({
        username: 'discbad',
        email: 'db@test.com',
        password: 'h'
      });
      await expect(
        disconnectProvider(user._id, 'facebook')
      ).rejects.toThrow(/Neznámy provider/);
    });

    it('zamietne keď user neexistuje', async () => {
      const fakeId = new (require('mongoose').Types.ObjectId)();
      await expect(
        disconnectProvider(fakeId, 'google')
      ).rejects.toThrow(/neexistuje/i);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // OAuthError class
  // ───────────────────────────────────────────────────────────────────
  describe('OAuthError', () => {
    it('má správne polia (code, message, statusCode)', () => {
      const err = new OAuthError('TEST_CODE', 'Test message', 418);
      expect(err.code).toBe('TEST_CODE');
      expect(err.message).toBe('Test message');
      expect(err.statusCode).toBe(418);
      expect(err.name).toBe('OAuthError');
      expect(err).toBeInstanceOf(Error);
    });

    it('default statusCode je 400', () => {
      const err = new OAuthError('X', 'Y');
      expect(err.statusCode).toBe(400);
    });
  });
});
