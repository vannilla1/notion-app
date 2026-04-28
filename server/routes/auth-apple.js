/**
 * Apple Sign In routes — Sign in with Apple.
 *
 * Apple flow má niekoľko zvláštností oproti Google:
 *   1. Web flow používa response_mode=form_post → Apple POST-uje na callback
 *   2. Client secret nie je plain string, ale ES256 JWT signed s .p8 key-om
 *   3. ID token sa overuje cez Apple JWKS (https://appleid.apple.com/auth/keys)
 *   4. "Hide my email" → relay adresa @privaterelay.appleid.com
 *   5. User name appearuje LEN PRI PRVOM sign-in (potom musíme cache-ovať/
 *      ignorovať — Apple ho viac nepošle)
 *
 * Endpointy:
 *   GET  /api/auth/apple/login          → 302 redirect na Apple authorize URL
 *   POST /api/auth/apple/connect-init   → JSON { url } pre logged-in usera
 *   POST /api/auth/apple/callback       → form_post od Apple, redirect do FE
 *   POST /api/auth/apple/native         → JSON { token, user } (iOS native flow)
 *   POST /api/auth/apple/connect-native → JSON { user } (iOS s auth)
 *
 * Env vars:
 *   APPLE_TEAM_ID         → 10-char Team ID z Apple Developer
 *   APPLE_KEY_ID          → 10-char Key ID pre Sign In private key
 *   APPLE_PRIVATE_KEY     → PEM content z .p8 file (\n medzi riadkami)
 *   APPLE_SERVICE_ID      → Service ID pre web flow (audience)
 *   APPLE_APP_BUNDLE_ID   → Bundle ID pre iOS native (alt. audience)
 *   APPLE_OAUTH_REDIRECT_URI → backend callback URL (musí sedieť so Service ID config)
 *   CLIENT_URL            → FE URL pre post-auth redirect
 */
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const oauthService = require('../services/oauthService');
const { authenticateToken } = require('../middleware/auth');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Konfigurácia ───────────────────────────────────────────────────
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID;
const APPLE_KEY_ID = process.env.APPLE_KEY_ID;
const APPLE_PRIVATE_KEY = process.env.APPLE_PRIVATE_KEY;
const APPLE_SERVICE_ID = process.env.APPLE_SERVICE_ID;
const APPLE_APP_BUNDLE_ID = process.env.APPLE_APP_BUNDLE_ID;
// Backend hostname je perun-crm-api.onrender.com (match s ostatnými Google
// Calendar/Tasks redirect URI defaultami).
const APPLE_OAUTH_REDIRECT_URI = process.env.APPLE_OAUTH_REDIRECT_URI ||
  'https://perun-crm-api.onrender.com/api/auth/apple/callback';
const CLIENT_URL = process.env.CLIENT_URL || 'https://prplcrm.eu';

const APPLE_AUTH_URL = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

const isConfiguredWeb = () => !!(APPLE_TEAM_ID && APPLE_KEY_ID && APPLE_PRIVATE_KEY && APPLE_SERVICE_ID);
const isConfiguredNative = () => !!(APPLE_APP_BUNDLE_ID);

if (!isConfiguredWeb()) {
  logger.warn('[auth-apple] Web flow nie je nakonfigurovaný (APPLE_TEAM_ID/KEY_ID/PRIVATE_KEY/SERVICE_ID chýbajú)');
}
if (!isConfiguredNative()) {
  logger.warn('[auth-apple] Native flow nie je nakonfigurovaný (APPLE_APP_BUNDLE_ID chýba)');
}

// ─── Pomocky ─────────────────────────────────────────────────────────

// Apple client secret JWT — ES256 podpísaný .p8 key-om. Apple vyžaduje:
//   iss = Team ID
//   iat = teraz
//   exp = teraz + max 6 mesiacov (my dáme 1 hodinu — generujeme per-request)
//   aud = 'https://appleid.apple.com'
//   sub = Service ID (web) alebo App ID (native — ale native client secret
//         neposiela, takže toto je len pre web)
function generateClientSecret() {
  if (!isConfiguredWeb()) {
    throw new Error('Apple web flow not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: APPLE_TEAM_ID,
      iat: now,
      exp: now + 3600, // 1h
      aud: APPLE_ISSUER,
      sub: APPLE_SERVICE_ID
    },
    APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    {
      algorithm: 'ES256',
      header: { kid: APPLE_KEY_ID, alg: 'ES256' }
    }
  );
}

// jose má CJS export (`main: dist/node/cjs/index.js`), takže ho dáme normálne
// cez require. Predtým sme pre istotu používali dynamic import, ale Jest
// dynamic import-y v sandboxe nepodporuje bez --experimental-vm-modules flagu.
const jose = require('jose');

let _jwks = null;
function getJWKS() {
  if (!_jwks) {
    _jwks = jose.createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  }
  return _jwks;
}

// Verify Apple ID token cez JWKS. Audience akceptujeme Service ID aj Bundle ID
// (web flow vs native) — oba sú validné podľa toho, odkiaľ idToken pochádza.
async function verifyAppleIdToken(idToken) {
  const allowedAudiences = [APPLE_SERVICE_ID, APPLE_APP_BUNDLE_ID].filter(Boolean);
  if (allowedAudiences.length === 0) {
    throw new Error('Apple Sign In nie je nakonfigurovaný (chýba SERVICE_ID alebo APP_BUNDLE_ID)');
  }
  const jwks = getJWKS();
  const { payload } = await jose.jwtVerify(idToken, jwks, {
    issuer: APPLE_ISSUER,
    audience: allowedAudiences
  });
  if (!payload.sub) {
    throw new Error('Invalid Apple ID token (missing sub)');
  }
  return {
    providerId: payload.sub,
    email: payload.email || null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    isAppleRelay: payload.is_private_email === true || payload.is_private_email === 'true' ||
                  oauthService.isAppleRelayEmail(payload.email)
  };
}

// Code exchange POST → /auth/token. Vráti tokens object (id_token, refresh_token, access_token).
async function exchangeCodeForTokens(code) {
  if (!isConfiguredWeb()) {
    throw new Error('Apple web flow not configured');
  }
  const clientSecret = generateClientSecret();
  const params = new URLSearchParams({
    client_id: APPLE_SERVICE_ID,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: APPLE_OAUTH_REDIRECT_URI
  });
  const res = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apple token exchange failed: ${res.status} ${text}`);
  }
  return await res.json();
}

function sanitizeReturnUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return '/app/dashboard';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/app/dashboard';
}

function buildSuccessRedirect(token, opts = {}) {
  const url = new URL(`${CLIENT_URL}/auth/callback`);
  if (opts.returnUrl) url.searchParams.set('returnUrl', opts.returnUrl);
  if (opts.isNew) url.searchParams.set('isNew', '1');
  if (opts.linked) url.searchParams.set('linked', '1');
  url.searchParams.set('provider', 'apple');
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

function buildErrorRedirect(code, message) {
  const url = new URL(`${CLIENT_URL}/auth/callback`);
  url.searchParams.set('error', code);
  if (message) url.searchParams.set('message', message);
  return url.toString();
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/auth/apple/login
// Anonymous flow — redirect na Apple authorize URL.
// ─────────────────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  if (!isConfiguredWeb()) {
    return res.status(503).json({ message: 'Apple Sign In nie je nakonfigurované' });
  }
  try {
    const returnUrl = sanitizeReturnUrl(req.query.returnUrl);
    const state = oauthService.signState({ mode: 'login', returnUrl });
    const url = new URL(APPLE_AUTH_URL);
    url.searchParams.set('client_id', APPLE_SERVICE_ID);
    url.searchParams.set('redirect_uri', APPLE_OAUTH_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('response_mode', 'form_post');
    url.searchParams.set('scope', 'name email');
    url.searchParams.set('state', state);
    return res.redirect(url.toString());
  } catch (err) {
    logger.error('[auth-apple] login init failed', { error: err.message });
    return res.redirect(buildErrorRedirect('INIT_FAILED'));
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/auth/apple/connect-init
// Auth required — vráti URL pre LINK existujúceho účtu k Apple.
// ─────────────────────────────────────────────────────────────────────
router.post('/connect-init', authenticateToken, async (req, res) => {
  if (!isConfiguredWeb()) {
    return res.status(503).json({ message: 'Apple Sign In nie je nakonfigurovaný' });
  }
  try {
    const userId = req.user.id.toString();
    const returnUrl = sanitizeReturnUrl(req.body && req.body.returnUrl);
    const state = oauthService.signState({ mode: 'connect', userId, returnUrl });
    const url = new URL(APPLE_AUTH_URL);
    url.searchParams.set('client_id', APPLE_SERVICE_ID);
    url.searchParams.set('redirect_uri', APPLE_OAUTH_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('response_mode', 'form_post');
    url.searchParams.set('scope', 'name email');
    url.searchParams.set('state', state);
    res.json({ url: url.toString() });
  } catch (err) {
    logger.error('[auth-apple] connect-init failed', { error: err.message });
    res.status(500).json({ message: 'Nepodarilo sa pripraviť Apple connect' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/auth/apple/callback
// Apple POST-uje sem (response_mode=form_post). Express musí mať
// urlencoded body parser MOUNTED na tomto routeri (server/index.js
// app.use(express.urlencoded({ extended: false })) musí existovať
// alebo sa pridá inline tu).
// ─────────────────────────────────────────────────────────────────────
const urlencoded = express.urlencoded({ extended: false });
router.post('/callback', urlencoded, async (req, res) => {
  if (!isConfiguredWeb()) {
    return res.redirect(buildErrorRedirect('NOT_CONFIGURED'));
  }
  const { code, state, error: appleError, user: userJson } = req.body || {};

  if (appleError) {
    return res.redirect(buildErrorRedirect('USER_CANCELLED', String(appleError)));
  }
  if (!code || !state) {
    return res.redirect(buildErrorRedirect('MISSING_PARAMS'));
  }

  let stateData;
  try {
    stateData = oauthService.verifyState(state);
  } catch (err) {
    logger.warn('[auth-apple] invalid state', { error: err.message });
    return res.redirect(buildErrorRedirect(err.code || 'STATE_INVALID', err.message));
  }

  // First-time user JSON môže prísť — Apple ho posiela LEN PRI PRVOM sign-in.
  // Štruktúra: { name: { firstName, lastName }, email }
  // Použijeme len ako display fallback, NE-overený, ne-stable. Reálna identita
  // ide z id_token (sub claim).
  let firstTimeName = null;
  if (userJson) {
    try {
      const parsed = typeof userJson === 'string' ? JSON.parse(userJson) : userJson;
      if (parsed && parsed.name) {
        const fn = parsed.name.firstName || '';
        const ln = parsed.name.lastName || '';
        firstTimeName = `${fn} ${ln}`.trim() || null;
      }
    } catch {
      // Ignore — name je nice-to-have
    }
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.id_token) {
      throw new Error('Missing id_token in Apple response');
    }
    const profile = await verifyAppleIdToken(tokens.id_token);
    if (firstTimeName) profile.name = firstTimeName;

    if (stateData.mode === 'connect') {
      if (!stateData.userId) {
        return res.redirect(buildErrorRedirect('STATE_INVALID', 'Missing userId'));
      }
      try {
        await oauthService.connectProvider(stateData.userId, 'apple', profile);
        auditService.logAction({
          userId: stateData.userId,
          action: 'auth.oauth.connect',
          category: 'auth',
          details: { provider: 'apple' },
          ipAddress: req.ip
        });
        const url = new URL(`${CLIENT_URL}/auth/callback`);
        url.searchParams.set('mode', 'connect');
        url.searchParams.set('provider', 'apple');
        url.searchParams.set('connected', '1');
        if (stateData.returnUrl) url.searchParams.set('returnUrl', stateData.returnUrl);
        return res.redirect(url.toString());
      } catch (err) {
        logger.warn('[auth-apple] connect failed', {
          error: err.message,
          code: err.code,
          userId: stateData.userId
        });
        return res.redirect(buildErrorRedirect(err.code || 'CONNECT_FAILED', err.message));
      }
    }

    // Login flow
    let result;
    try {
      result = await oauthService.findOrCreateUserFromProfile('apple', profile);
    } catch (err) {
      logger.warn('[auth-apple] login findOrCreate failed', { error: err.message, code: err.code });
      return res.redirect(buildErrorRedirect(err.code || 'LOGIN_FAILED', err.message));
    }

    const token = oauthService.issueAuthToken(result.user);
    auditService.logAction({
      userId: result.user._id.toString(),
      username: result.user.username,
      email: result.user.email,
      action: result.isNew ? 'auth.oauth.register' : 'auth.oauth.login',
      category: 'auth',
      targetType: 'user',
      targetId: result.user._id.toString(),
      targetName: result.user.username,
      details: { provider: 'apple', linked: result.linked === true },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    return res.redirect(buildSuccessRedirect(token, {
      returnUrl: stateData.returnUrl,
      isNew: result.isNew,
      linked: result.linked === true
    }));
  } catch (err) {
    logger.error('[auth-apple] callback error', {
      error: err.message,
      stack: err.stack
    });
    return res.redirect(buildErrorRedirect('CALLBACK_FAILED', 'Apple Sign In zlyhal'));
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/auth/apple/native
// iOS Sign in with Apple — appka pošle identityToken priamo. Anonymous.
// ─────────────────────────────────────────────────────────────────────
router.post('/native', async (req, res) => {
  if (!isConfiguredNative() && !isConfiguredWeb()) {
    return res.status(503).json({ message: 'Apple Sign In nie je nakonfigurovaný' });
  }
  try {
    const { identityToken, fullName, email } = req.body || {};
    if (!identityToken || typeof identityToken !== 'string') {
      return res.status(400).json({ message: 'Chýba identityToken' });
    }

    let profile;
    try {
      profile = await verifyAppleIdToken(identityToken);
    } catch (err) {
      logger.warn('[auth-apple] native idToken verify failed', { error: err.message });
      return res.status(401).json({ message: 'Neplatný Apple token' });
    }
    // First-time fields z iOS — Apple ich pošle LEN PRI PRVOM sign-in.
    if (fullName && typeof fullName === 'string') profile.name = fullName.trim().slice(0, 100);
    // Email z native môže byť aj keď id_token nemá email claim (Apple to vyžaduje
    // pre prvý sign-in keď user nepoužije Hide My Email).
    if (email && typeof email === 'string' && !profile.email) {
      profile.email = email.toLowerCase().trim();
      profile.isAppleRelay = oauthService.isAppleRelayEmail(profile.email);
    }

    let result;
    try {
      result = await oauthService.findOrCreateUserFromProfile('apple', profile);
    } catch (err) {
      return res.status(err.statusCode || 400).json({
        message: err.message,
        code: err.code
      });
    }

    const token = oauthService.issueAuthToken(result.user);
    auditService.logAction({
      userId: result.user._id.toString(),
      username: result.user.username,
      email: result.user.email,
      action: result.isNew ? 'auth.oauth.register' : 'auth.oauth.login',
      category: 'auth',
      targetType: 'user',
      targetId: result.user._id.toString(),
      targetName: result.user.username,
      details: { provider: 'apple', native: true, linked: result.linked === true },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.json({
      token,
      user: oauthService.shapeUserResponse(result.user),
      isNew: result.isNew,
      linked: result.linked === true
    });
  } catch (err) {
    logger.error('[auth-apple] native error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/auth/apple/connect-native
// iOS auth-required pre LINK existing account k Apple.
// ─────────────────────────────────────────────────────────────────────
router.post('/connect-native', authenticateToken, async (req, res) => {
  if (!isConfiguredNative() && !isConfiguredWeb()) {
    return res.status(503).json({ message: 'Apple Sign In nie je nakonfigurovaný' });
  }
  try {
    const { identityToken } = req.body || {};
    if (!identityToken || typeof identityToken !== 'string') {
      return res.status(400).json({ message: 'Chýba identityToken' });
    }
    let profile;
    try {
      profile = await verifyAppleIdToken(identityToken);
    } catch (err) {
      return res.status(401).json({ message: 'Neplatný Apple token' });
    }
    let updated;
    try {
      updated = await oauthService.connectProvider(req.user.id.toString(), 'apple', profile);
    } catch (err) {
      return res.status(err.statusCode || 400).json({
        message: err.message,
        code: err.code
      });
    }
    auditService.logAction({
      userId: req.user.id.toString(),
      action: 'auth.oauth.connect',
      category: 'auth',
      details: { provider: 'apple', native: true },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });
    res.json({ user: oauthService.shapeUserResponse(updated) });
  } catch (err) {
    logger.error('[auth-apple] connect-native error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
