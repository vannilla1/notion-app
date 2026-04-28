/**
 * Google OAuth routes — Sign in with Google.
 *
 * Endpointy:
 *   GET  /api/auth/google/login          → 302 redirect na Google authorize URL (anonymous)
 *   POST /api/auth/google/connect-init   → JSON { url } pre logged-in usera (link account)
 *   GET  /api/auth/google/callback       → 302 redirect späť do FE (po Google authorize)
 *   POST /api/auth/google/native         → JSON { token, user } pre iOS Google SDK (anonymous)
 *   POST /api/auth/google/connect-native → JSON { user } pre iOS s auth tokenom
 *
 * Bezpečnostné prvky:
 *   - State HMAC: oauthService.signState/verifyState (CSRF + replay protection)
 *   - audience verification cez google-auth-library OAuth2.verifyIdToken
 *   - 503 keď nie sú nakonfigurované GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   - Email_verified gate v oauthService.findOrCreateUserFromProfile
 *
 * Env vars (vyžadované pred deploy):
 *   GOOGLE_CLIENT_ID            → Web client ID z Google Cloud Console
 *   GOOGLE_CLIENT_SECRET        → Web client secret
 *   GOOGLE_OAUTH_REDIRECT_URI   → musí presne sedieť s Authorized redirect URI
 *                                 v Google Cloud Console (default: prod backend URL)
 *   GOOGLE_IOS_CLIENT_ID        → iOS client ID (audience pre native flow)
 *   CLIENT_URL                  → FE URL pre post-auth redirect (default: https://prplcrm.eu)
 */
const express = require('express');
const { google } = require('googleapis');
const { authenticateToken } = require('../middleware/auth');
const oauthService = require('../services/oauthService');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Konfigurácia ───────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI ||
  'https://prplcrm-api.onrender.com/api/auth/google/callback';
const GOOGLE_IOS_CLIENT_ID = process.env.GOOGLE_IOS_CLIENT_ID || null;
const CLIENT_URL = process.env.CLIENT_URL || 'https://prplcrm.eu';

// Scopes pre OpenID Connect — minimum pre login flow.
// 'openid' aktivuje id_token v response, 'email' a 'profile' poskytnú claims.
const SCOPES = ['openid', 'email', 'profile'];

const isConfigured = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

if (!isConfigured()) {
  logger.warn('[auth-google] GOOGLE_CLIENT_ID/SECRET nie sú nastavené — Google Sign-In je vypnutý');
}

// Vytvor fresh OAuth2 client per request (NIKDY nie module-level singleton —
// concurrent requesty by si delili credentials a leakli by data medzi userov).
const createOAuth2Client = () => {
  if (!isConfigured()) return null;
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI
  );
};

// ─── Helpers ─────────────────────────────────────────────────────────

// Sanituj returnUrl — musí byť relatívna URL alebo z nášho domain-u, ináč
// open-redirect attack (útočník pošle `returnUrl=https://evil.com`).
function sanitizeReturnUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) {
    return '/app/dashboard';
  }
  // Iba relative paths začínajúce '/' (a nie '//').
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/app/dashboard';
}

// Verify ID token z Google — musí byť signed Google JWKS-om a audience musí
// byť náš client ID. verifyIdToken throwne pri akejkoľvek chybe.
async function verifyGoogleIdToken(idToken, allowedAudiences) {
  const client = createOAuth2Client();
  if (!client) throw new Error('Google OAuth nie je nakonfigurované');

  const audiences = Array.isArray(allowedAudiences)
    ? allowedAudiences.filter(Boolean)
    : [allowedAudiences].filter(Boolean);
  if (audiences.length === 0) audiences.push(GOOGLE_CLIENT_ID);

  const ticket = await client.verifyIdToken({ idToken, audience: audiences });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new Error('Invalid Google ID token payload');
  }
  return {
    providerId: payload.sub,
    email: payload.email || null,
    emailVerified: payload.email_verified === true,
    name: payload.name || null,
    picture: payload.picture || null
  };
}

// Build redirect URL pre úspešný login — token + flagy. Token IDE V FRAGMENTE
// (#hash) aby nešiel do server logov a referrer headerov.
function buildSuccessRedirect(token, opts = {}) {
  const url = new URL(`${CLIENT_URL}/auth/callback`);
  // Returns/info v query (nie sensitive), token vo fragmente.
  if (opts.returnUrl) url.searchParams.set('returnUrl', opts.returnUrl);
  if (opts.isNew) url.searchParams.set('isNew', '1');
  if (opts.linked) url.searchParams.set('linked', '1');
  url.searchParams.set('provider', opts.provider || 'google');
  // Hash fragment — nie je odoslaný v HTTP requestoch, len ostane v browseri.
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
// GET /api/auth/google/login
// Anonymous flow — redirect na Google authorize URL s podpísaným state.
// ─────────────────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ message: 'Google Sign-In nie je nakonfigurovaný' });
  }
  try {
    const returnUrl = sanitizeReturnUrl(req.query.returnUrl);
    const state = oauthService.signState({ mode: 'login', returnUrl });
    const client = createOAuth2Client();
    const authUrl = client.generateAuthUrl({
      access_type: 'online',  // login-only — nepotrebujeme refresh token
      scope: SCOPES,
      include_granted_scopes: true,
      prompt: 'select_account',  // umožni výber účtu (UX)
      state
    });
    return res.redirect(authUrl);
  } catch (err) {
    logger.error('[auth-google] login init failed', { error: err.message });
    return res.redirect(buildErrorRedirect('INIT_FAILED', 'Nepodarilo sa spustiť Google login'));
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/auth/google/connect-init
// Auth required — generuje URL pre LINK existujúceho účtu k Google.
// Vráti { url } a frontend redirectuje cez window.location.assign(url).
// ─────────────────────────────────────────────────────────────────────
router.post('/connect-init', authenticateToken, async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ message: 'Google Sign-In nie je nakonfigurovaný' });
  }
  try {
    const userId = req.user.id.toString();
    const returnUrl = sanitizeReturnUrl(req.body && req.body.returnUrl);
    const state = oauthService.signState({ mode: 'connect', userId, returnUrl });
    const client = createOAuth2Client();
    const authUrl = client.generateAuthUrl({
      access_type: 'online',
      scope: SCOPES,
      include_granted_scopes: true,
      prompt: 'select_account',
      state
    });
    res.json({ url: authUrl });
  } catch (err) {
    logger.error('[auth-google] connect init failed', { error: err.message });
    res.status(500).json({ message: 'Nepodarilo sa pripraviť pripojenie Google účtu' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/auth/google/callback
// Google redirectuje sem s code + state. Odpoveď: 302 na CLIENT_URL/auth/callback.
// ─────────────────────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  if (!isConfigured()) {
    return res.redirect(buildErrorRedirect('NOT_CONFIGURED'));
  }
  const { code, state, error: googleError } = req.query;

  // User zrušil autorizáciu v Google → redirect bez tokenu, FE ukáže neutral message.
  if (googleError) {
    logger.info('[auth-google] user cancelled', { error: googleError });
    return res.redirect(buildErrorRedirect('USER_CANCELLED', String(googleError)));
  }
  if (!code || !state) {
    return res.redirect(buildErrorRedirect('MISSING_PARAMS'));
  }

  let stateData;
  try {
    stateData = oauthService.verifyState(state);
  } catch (err) {
    logger.warn('[auth-google] invalid state', { error: err.message });
    return res.redirect(buildErrorRedirect(err.code || 'STATE_INVALID', err.message));
  }

  try {
    const client = createOAuth2Client();
    const { tokens } = await client.getToken({ code, redirect_uri: GOOGLE_OAUTH_REDIRECT_URI });
    if (!tokens.id_token) {
      throw new Error('Missing id_token in Google response');
    }
    const profile = await verifyGoogleIdToken(tokens.id_token, [GOOGLE_CLIENT_ID]);

    // ─── Connect flow ────────────────────────────────────────────────
    if (stateData.mode === 'connect') {
      if (!stateData.userId) {
        return res.redirect(buildErrorRedirect('STATE_INVALID', 'Missing userId'));
      }
      try {
        await oauthService.connectProvider(stateData.userId, 'google', profile);
        auditService.logAction({
          userId: stateData.userId,
          action: 'auth.oauth.connect',
          category: 'auth',
          details: { provider: 'google' },
          ipAddress: req.ip
        });
        // Connect-mode redirect na settings page s flagom
        const url = new URL(`${CLIENT_URL}/auth/callback`);
        url.searchParams.set('mode', 'connect');
        url.searchParams.set('provider', 'google');
        url.searchParams.set('connected', '1');
        if (stateData.returnUrl) url.searchParams.set('returnUrl', stateData.returnUrl);
        return res.redirect(url.toString());
      } catch (err) {
        logger.warn('[auth-google] connect failed', {
          error: err.message,
          code: err.code,
          userId: stateData.userId
        });
        return res.redirect(buildErrorRedirect(err.code || 'CONNECT_FAILED', err.message));
      }
    }

    // ─── Login flow ──────────────────────────────────────────────────
    let result;
    try {
      result = await oauthService.findOrCreateUserFromProfile('google', profile);
    } catch (err) {
      logger.warn('[auth-google] login findOrCreate failed', { error: err.message, code: err.code });
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
      details: { provider: 'google', linked: result.linked === true },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    return res.redirect(buildSuccessRedirect(token, {
      returnUrl: stateData.returnUrl,
      isNew: result.isNew,
      linked: result.linked === true,
      provider: 'google'
    }));
  } catch (err) {
    logger.error('[auth-google] callback error', {
      error: err.message,
      stack: err.stack
    });
    return res.redirect(buildErrorRedirect('CALLBACK_FAILED', 'Google login zlyhal'));
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/auth/google/native
// iOS Google SDK pošle id_token. Anonymous endpoint — vráti { token, user }.
// Audience: GOOGLE_IOS_CLIENT_ID (iOS client ID, nie web).
// ─────────────────────────────────────────────────────────────────────
router.post('/native', async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ message: 'Google Sign-In nie je nakonfigurovaný' });
  }
  try {
    const { idToken } = req.body || {};
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ message: 'Chýba idToken' });
    }
    // Akceptujeme aj web aj iOS client ID — iOS appka by mala posielať svoj
    // iOS client ID, ale pre flexibilitu (e.g. testovanie z desktop browser)
    // akceptujeme oba.
    const allowedAudiences = [GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID].filter(Boolean);
    let profile;
    try {
      profile = await verifyGoogleIdToken(idToken, allowedAudiences);
    } catch (err) {
      logger.warn('[auth-google] native idToken verify failed', { error: err.message });
      return res.status(401).json({ message: 'Neplatný Google token' });
    }

    let result;
    try {
      result = await oauthService.findOrCreateUserFromProfile('google', profile);
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
      details: { provider: 'google', native: true, linked: result.linked === true },
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
    logger.error('[auth-google] native error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/auth/google/connect-native
// iOS auth-required flow pre LINK existing account k Google.
// ─────────────────────────────────────────────────────────────────────
router.post('/connect-native', authenticateToken, async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ message: 'Google Sign-In nie je nakonfigurovaný' });
  }
  try {
    const { idToken } = req.body || {};
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ message: 'Chýba idToken' });
    }
    const allowedAudiences = [GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID].filter(Boolean);
    let profile;
    try {
      profile = await verifyGoogleIdToken(idToken, allowedAudiences);
    } catch (err) {
      return res.status(401).json({ message: 'Neplatný Google token' });
    }

    let updated;
    try {
      updated = await oauthService.connectProvider(req.user.id.toString(), 'google', profile);
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
      details: { provider: 'google', native: true },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.json({ user: oauthService.shapeUserResponse(updated) });
  } catch (err) {
    logger.error('[auth-google] connect-native error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
