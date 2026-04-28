/**
 * OAuth Service — Sign in with Google / Apple support.
 *
 * Tento modul obsahuje BACKEND-side logiku, ktorá je spoločná pre Google aj
 * Apple OAuth flow:
 *
 *   1. State HMAC sign/verify — ochrana pred CSRF útokom počas redirect-flow.
 *      Klient dostane signed state, ktorý server overí v callbacku.
 *
 *   2. Account linking matrix — keď OAuth profile prichádza pre email, ktorý
 *      v DB už existuje. Pravidlá:
 *        a) provider ID match           → login (returning OAuth user)
 *        b) email match + email_verified → AUTO-LINK existujúci password účet
 *           ku Google/Apple (provider zaručil, že email patrí tomu istému)
 *        c) email match + NEPOTVRDENÝ   → 409 EMAIL_EXISTS_UNVERIFIED
 *           (anti-takeover: útočník by mohol vytvoriť Google účet s cudzím
 *           emailom a získať cudzí account)
 *        d) Apple "hide my email" relay → ALWAYS new user (relay adresa
 *           nepatrí žiadnemu existujúcemu účtu)
 *        e) no match                     → create new user
 *
 *   3. Connect/disconnect provider — užívateľ pripojí/odpojí Google/Apple
 *      v Settings. Disconnect má guard: nikdy nesmie zostať bez prihlasovacej
 *      metódy (last login method check cez authProviders array).
 *
 * Provider-specific HTTP volania (token exchange, profile fetch) sú v
 * routes/auth-google.js a routes/auth-apple.js. Tento service iba dostane
 * normalizovaný profile objekt.
 *
 * Env vars:
 *   - JWT_SECRET (mandatory, validovaný v middleware/auth.js)
 *   - OAUTH_STATE_SECRET (optional — keď chýba, deriveme z JWT_SECRET cez
 *     HMAC s domain-separator stringom, takže state HMAC vždy funguje)
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT_SECRET, invalidateUserCache } = require('../middleware/auth');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────
// State HMAC — CSRF ochrana pre OAuth redirect flow.
// ─────────────────────────────────────────────────────────────────────
//
// Princip: pri /auth/google/init server vygeneruje state string (signed).
// Klient ho pošle ako query param do Google. Google ho vráti naspäť
// v callbacku. Server ho overí — ak HMAC sedí, vieme že žiadosť pochádza
// z nášho init-u a nie zo zhubného linku v emaili od útočníka.
//
// State payload obsahuje:
//   - nonce (proti replay attack)
//   - iat   (proti expirácii — max 10 min)
//   - v     (versioning, pre prípad budúcej migrácie formátu)
//   - + ľubovoľné domain dáta (napr. returnUrl, mode='login'|'connect')
//
// HMAC SHA-256 cez OAUTH_STATE_SECRET (alebo derived z JWT_SECRET).

const STATE_VERSION = 'v1';
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minút — po expirácii treba znova init

// Derive state secret: prefer explicit env, else HMAC(JWT_SECRET, "oauth-state")
// Domain separation zaručí, že kompromitovaný state secret neumožní forge JWT
// a naopak (oba secrety sú "independent" aj keď delia ten istý zdroj entropy).
function getStateSecret() {
  if (process.env.OAUTH_STATE_SECRET && process.env.OAUTH_STATE_SECRET.length >= 32) {
    return process.env.OAUTH_STATE_SECRET;
  }
  return crypto.createHmac('sha256', JWT_SECRET).update('oauth-state-domain').digest('hex');
}

function signState(payload = {}) {
  const data = {
    ...payload,
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: Date.now(),
    v: STATE_VERSION
  };
  const json = JSON.stringify(data);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', getStateSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyState(stateString) {
  if (!stateString || typeof stateString !== 'string') {
    throw new OAuthError('STATE_INVALID', 'Neplatný state parameter');
  }
  const parts = stateString.split('.');
  if (parts.length !== 2) {
    throw new OAuthError('STATE_INVALID', 'Neplatný formát state');
  }
  const [b64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', getStateSecret()).update(b64).digest('base64url');

  // timingSafeEqual vyžaduje rovnakú dĺžku — ak sa nelíšia, vykoná
  // konštantno-časové porovnanie (ochrana pred timing-side-channel).
  let sigBuf, expectedBuf;
  try {
    sigBuf = Buffer.from(sig, 'base64url');
    expectedBuf = Buffer.from(expectedSig, 'base64url');
  } catch {
    throw new OAuthError('STATE_INVALID', 'State decode failed');
  }
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new OAuthError('STATE_INVALID', 'Neplatný podpis state');
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch {
    throw new OAuthError('STATE_INVALID', 'State JSON decode failed');
  }

  if (data.v !== STATE_VERSION) {
    throw new OAuthError('STATE_INVALID', 'State version mismatch');
  }
  if (typeof data.iat !== 'number' || Date.now() - data.iat > STATE_MAX_AGE_MS) {
    throw new OAuthError('STATE_EXPIRED', 'State expired (10 min)');
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────
// Pomocky
// ─────────────────────────────────────────────────────────────────────

class OAuthError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Apple "hide my email" → emailová relay adresa. Tieto adresy nikdy NEpatrí
// existujúcemu password-flow účtu, takže auto-link je bezpečnostné riziko.
// Always treat as new user.
function isAppleRelayEmail(email) {
  return typeof email === 'string' &&
         email.toLowerCase().endsWith('@privaterelay.appleid.com');
}

// JWT pre auth — match s /login pattern (id v payloade, 7d expiry, HS256 implicit)
function issueAuthToken(user) {
  return jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
}

// User shape pre HTTP odpoveď — match s /login response (id, username, email,
// color, avatar, role) + OAuth-špecifické polia (avatarUrl, authProviders).
function shapeUserResponse(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    color: user.color,
    avatar: user.avatar,
    role: user.role,
    avatarUrl: user.avatarUrl || null,
    authProviders: Array.isArray(user.authProviders) ? user.authProviders : []
  };
}

// Z emailu/mena vyrobí jedinečný username. Použité pri create-new-user-from-OAuth
// keď user nikdy nezadal username (Google/Apple flow ho nepýta).
async function generateUniqueUsername(seed) {
  const baseRaw = (seed || '').split('@')[0];
  // Sanitize: len alphanumerics + _ - (zhodne s typickými usernames v aplikácii)
  const base = baseRaw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'user';

  // 1. pokus — base bez suffixu
  if (!(await User.findOne({ username: base }))) return base;

  // 2-100 — base + suffix
  for (let i = 1; i <= 100; i++) {
    const candidate = `${base}${i}`;
    if (!(await User.findOne({ username: candidate }))) return candidate;
  }

  // Fallback (extrémne nepravdepodobné) — random 6-char hex suffix
  return `${base}${crypto.randomBytes(3).toString('hex')}`;
}

// ─────────────────────────────────────────────────────────────────────
// Account linking matrix — hlavná logika OAuth flow-u.
//
// Vstup:
//   provider: 'google' | 'apple'
//   profile: {
//     providerId,         (sub claim z Google/Apple JWT)
//     email,              (email z profile, môže byť null pri Apple bez scope)
//     emailVerified,      (true/false — Apple vždy true; Google email_verified)
//     name?,              (display name z profile)
//     picture?,           (URL na avatar — Google poskytuje, Apple nie)
//     isAppleRelay?       (true ak email končí @privaterelay.appleid.com)
//   }
//
// Návrat: { user, isNew, linked? }
// Throws: OAuthError s code & statusCode
// ─────────────────────────────────────────────────────────────────────

async function findOrCreateUserFromProfile(provider, profile) {
  if (!['google', 'apple'].includes(provider)) {
    throw new OAuthError('INVALID_PROVIDER', `Neznámy provider: ${provider}`);
  }
  if (!profile || !profile.providerId) {
    throw new OAuthError('MISSING_PROVIDER_ID', 'Chýba ID účtu od provider-a');
  }
  const idField = provider === 'google' ? 'googleId' : 'appleId';
  const emailLower = (profile.email || '').toLowerCase().trim();

  // 1. Returning OAuth user — provider ID match má najvyššiu prioritu, aj
  // keď user-ovi medzitým provider zmenil email, naviazanie cez stable
  // providerId ostáva platné.
  const byProviderId = await User.findOne({ [idField]: profile.providerId });
  if (byProviderId) {
    let dirty = false;
    // Aktualizuj avatar URL ak prišiel nový (Google ho vždy posiela)
    if (profile.picture && byProviderId.avatarUrl !== profile.picture) {
      byProviderId.avatarUrl = profile.picture;
      dirty = true;
    }
    if (dirty) {
      await byProviderId.save();
      await invalidateUserCache(byProviderId._id);
    }
    return { user: byProviderId, isNew: false };
  }

  // 2. Apple relay email → vždy nový user (relay adresa nemôže linknúť
  // existujúci email-based účet). Force-skip email match step.
  const isAppleRelay = profile.isAppleRelay || isAppleRelayEmail(emailLower);
  if (provider === 'apple' && isAppleRelay) {
    return await createNewUserFromOAuth(provider, profile);
  }

  // 3. Email match → AUTO-LINK len ak provider potvrdí email_verified.
  // Ináč 409 EMAIL_EXISTS_UNVERIFIED (anti-takeover).
  if (emailLower) {
    const byEmail = await User.findOne({ email: emailLower });
    if (byEmail) {
      if (!profile.emailVerified) {
        throw new OAuthError(
          'EMAIL_EXISTS_UNVERIFIED',
          'S týmto emailom existuje účet. Prihlás sa heslom a v Nastaveniach pripoj Google/Apple účet.',
          409
        );
      }
      // Auto-link
      byEmail[idField] = profile.providerId;
      const providers = new Set(byEmail.authProviders || []);
      providers.add(provider);
      byEmail.authProviders = Array.from(providers);
      if (!byEmail.emailVerified) byEmail.emailVerified = true;
      if (profile.picture && !byEmail.avatarUrl) byEmail.avatarUrl = profile.picture;
      await byEmail.save();
      await invalidateUserCache(byEmail._id);
      logger.info('[oauth] auto-linked existing account', {
        userId: byEmail._id.toString(),
        provider,
        email: emailLower
      });
      return { user: byEmail, isNew: false, linked: true };
    }
  }

  // 4. No match → create new user
  return await createNewUserFromOAuth(provider, profile);
}

async function createNewUserFromOAuth(provider, profile) {
  const idField = provider === 'google' ? 'googleId' : 'appleId';
  const emailLower = (profile.email || '').toLowerCase().trim();

  // Username generovanie — ak email chýba (Apple s relay-skip), použi name.
  const seed = emailLower || profile.name || 'user';
  const username = await generateUniqueUsername(seed);

  // Random color (rovnaký pattern ako v /register)
  const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  // Email je required v schéme + unique. Apple bez .email scope by mohol
  // dorazť bez emailu — vtedy nemôžeme vytvoriť user. Throwneme jasný error,
  // route handler ho prepíše do redirect s code=NO_EMAIL.
  if (!emailLower) {
    throw new OAuthError(
      'NO_EMAIL',
      'Provider neposlal email — vyžadovaný je email scope. Skús to znova a povol zdielanie emailu.',
      400
    );
  }

  const userData = {
    username,
    email: emailLower,
    [idField]: profile.providerId,
    authProviders: [provider],
    emailVerified: profile.emailVerified === true,
    avatarUrl: profile.picture || null,
    color,
    role: 'user'
  };

  const user = new User(userData);
  await user.save();

  logger.info('[oauth] created new user', {
    userId: user._id.toString(),
    provider,
    email: emailLower
  });

  return { user, isNew: true };
}

// ─────────────────────────────────────────────────────────────────────
// Connect / disconnect — pre prihláseného používateľa pripojiť/odpojiť
// OAuth identity v Nastaveniach.
// ─────────────────────────────────────────────────────────────────────

async function connectProvider(userId, provider, profile) {
  if (!['google', 'apple'].includes(provider)) {
    throw new OAuthError('INVALID_PROVIDER', `Neznámy provider: ${provider}`);
  }
  if (!profile || !profile.providerId) {
    throw new OAuthError('MISSING_PROVIDER_ID', 'Chýba ID účtu od provider-a');
  }

  const idField = provider === 'google' ? 'googleId' : 'appleId';
  const user = await User.findById(userId);
  if (!user) {
    throw new OAuthError('USER_NOT_FOUND', 'Používateľ neexistuje', 404);
  }

  // Hard fail: providerId už pripojený k inému user-ovi.
  // (User si nemôže "ukradnúť" Google účet niekoho iného.)
  const otherUser = await User.findOne({
    [idField]: profile.providerId,
    _id: { $ne: user._id }
  });
  if (otherUser) {
    throw new OAuthError(
      'PROVIDER_ID_TAKEN',
      `Tento ${provider === 'google' ? 'Google' : 'Apple'} účet je pripojený k inému používateľovi.`,
      409
    );
  }

  user[idField] = profile.providerId;
  const providers = new Set(user.authProviders || []);
  providers.add(provider);
  user.authProviders = Array.from(providers);
  if (profile.picture && !user.avatarUrl) user.avatarUrl = profile.picture;
  await user.save();
  await invalidateUserCache(user._id);

  logger.info('[oauth] connected provider', {
    userId: user._id.toString(),
    provider
  });

  return user;
}

async function disconnectProvider(userId, provider) {
  if (!['password', 'google', 'apple'].includes(provider)) {
    throw new OAuthError('INVALID_PROVIDER', `Neznámy provider: ${provider}`);
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new OAuthError('USER_NOT_FOUND', 'Používateľ neexistuje', 404);
  }

  // Last-method guard — bez tohto by user mohol odpojiť všetky metódy a
  // zostal by uväznený mimo svoj účet.
  const remaining = (user.authProviders || []).filter(p => p !== provider);
  if (remaining.length === 0) {
    throw new OAuthError(
      'LAST_LOGIN_METHOD',
      'Nemôžeš odpojiť poslednú prihlasovaciu metódu. Najprv si nastav iný spôsob prihlásenia.',
      400
    );
  }

  // Wipe field-level data podľa provider-a:
  if (provider === 'google') {
    user.googleId = undefined;
  } else if (provider === 'apple') {
    user.appleId = undefined;
  } else if (provider === 'password') {
    user.password = null;
  }
  user.authProviders = remaining;
  await user.save();
  await invalidateUserCache(user._id);

  logger.info('[oauth] disconnected provider', {
    userId: user._id.toString(),
    provider
  });

  return user;
}

module.exports = {
  // State HMAC
  signState,
  verifyState,
  STATE_VERSION,
  STATE_MAX_AGE_MS,

  // Helpers
  isAppleRelayEmail,
  issueAuthToken,
  shapeUserResponse,
  generateUniqueUsername,

  // Account linking
  findOrCreateUserFromProfile,
  createNewUserFromOAuth,
  connectProvider,
  disconnectProvider,

  OAuthError
};
