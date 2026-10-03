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
const User = require('../models/User');
const WorkspaceMember = require('../models/WorkspaceMember');
const Invitation = require('../models/Invitation');
const Workspace = require('../models/Workspace');
const { JWT_SECRET, invalidateUserCache, signAuthToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const { isProEmail, getBaseSeatLimit } = require('../utils/planLimits');

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
// Výsledok sa počíta raz pri štarte; príliš krátky OAUTH_STATE_SECRET sa
// predtým potichu ignoroval — teraz o tom varujeme.
const STATE_SECRET = (() => {
  const explicit = process.env.OAUTH_STATE_SECRET;
  if (explicit && explicit.length >= 32) return explicit;
  if (explicit) {
    logger.warn('[oauth] OAUTH_STATE_SECRET je kratší ako 32 znakov — ignorujem ho a odvodzujem secret z JWT_SECRET');
  }
  return crypto.createHmac('sha256', JWT_SECRET).update('oauth-state-domain').digest('hex');
})();
function getStateSecret() {
  return STATE_SECRET;
}

// ─────────────────────────────────────────────────────────────────────
// Väzba OAuth flow na prehliadač, ktorý ho spustil (login-CSRF ochrana).
//
// Aplikácia nepoužíva cookies (API a SPA sú na rôznych doménach a natívne
// shelly dokončujú flow v systémovom prehliadači), preto väzbu drží FE:
// pred navigáciou na /login vygeneruje náhodný `cnonce`, uloží ho do
// localStorage a pošle ho sem; nonce ide v podpísanom state a callback ho
// vráti vo fragmente spolu s tokenom. AuthCallback token prijme LEN ak sa
// zhoduje s uloženým nonce — URL callbacku podstrčená útočníkom (s jeho
// code+state) sa v prehliadači obete zahodí.
// ─────────────────────────────────────────────────────────────────────
function normalizeClientNonce(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(raw) ? raw : null;
}

// ─────────────────────────────────────────────────────────────────────
// Odložené prepojenie (connect) — CSRF ochrana pri linkovaní účtov.
//
// Callback v connect móde už identitu NEPRIPÁJA. Vydá krátkodobý podpísaný
// „pending“ token (userId zo state + overený profil od providera), ktorý FE
// pošle na POST /api/auth/connections/complete so svojím JWT. Server
// prepojí len ak JWT patrí rovnakému userId ako state. Útočník, ktorý obeti
// podstrčí svoju connect URL, tak jej Google/Apple identitu k svojmu účtu
// nepripojí (obeť má iný JWT alebo žiadny).
// ─────────────────────────────────────────────────────────────────────
const PENDING_KIND = 'connect-pending';

function signConnectPending({ userId, provider, profile }) {
  return signState({
    kind: PENDING_KIND,
    userId: String(userId),
    provider,
    profile: {
      providerId: profile.providerId,
      email: profile.email || null,
      emailVerified: profile.emailVerified === true,
      name: profile.name || null,
      picture: profile.picture || null,
      isAppleRelay: profile.isAppleRelay === true
    }
  });
}

function verifyConnectPending(token) {
  const data = verifyState(token);
  if (data.kind !== PENDING_KIND || !data.userId || !['google', 'apple'].includes(data.provider) || !data.profile?.providerId) {
    throw new OAuthError('STATE_INVALID', 'Neplatný token prepojenia');
  }
  return data;
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

// JWT pre auth — rovnaký helper ako /login (id + tokenVersion `tv`, 7d)
function issueAuthToken(user) {
  return signAuthToken(user);
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
  let base = baseRaw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'user';
  if (base.length < 2) base = `${base}user`;

  // Jeden dopyt na všetky obsadené varianty base, base1, base2… namiesto
  // až 101 sekvenčných findOne. base je len [A-Za-z0-9_-], takže regex je
  // bezpečný (pomlčka mimo triedy znakov nie je metaznak).
  const taken = new Set(
    (await User.find({ username: { $regex: `^${base}\\d*$` } }, 'username').lean())
      .map(u => u.username)
  );
  if (!taken.has(base)) return base;
  for (let i = 1; i <= 100; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
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

// Public entry — resolve usera A potom auto-akceptuj pending pozvánky.
// Wrapper drží invite-accept STRIKTNE non-fatal: ak zlyhá, login pokračuje.
async function findOrCreateUserFromProfile(provider, profile) {
  const result = await resolveUserFromProfile(provider, profile);
  try {
    await autoAcceptPendingInvites(result.user);
  } catch (err) {
    logger.warn('[oauth] autoAcceptPendingInvites wrapper failed', { error: err.message });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Auto-accept pending workspace invitations on OAuth login/registration.
//
// PROBLÉM (iOS bug — pozvaný user + Apple/Google native login):
// Pozvaný user, ktorý sa prihlási cez Apple/Google v native appke, NIKDY
// neprejde cez AcceptInvite stránku ani cez Login formulár — native bridge
// (window.__nativeAuthLogin) ho tvrdo redirectne na /app. Pending pozvánka
// tak ostane neprijatá → user nemá žiadny workspace → namiesto prostredia,
// do ktorého bol pozvaný, uvidí WorkspaceSetup (alebo pri Render cold-starte
// dlhý "Načítavam..." spinner). Toto to rieši pri zdroji.
//
// BEZPEČNOSŤ (auto-accept beží BEZ tokenu, takže email je jediná autorizácia):
//   - len keď user.emailVerified === true (provider potvrdil vlastníctvo),
//   - len EXACT email match invitation.email === user.email (na rozdiel od
//     token-based /invitation/:token/accept route, kde token je dôkaz),
//   - Apple relay (Hide My Email) preskakujeme — relay adresa sa nikdy
//     nezhoduje s reálnou pozvánkou.
//
// Robustnosť: per-invitation try/catch, NIKDY nehádže (login sa nesmie
// zablokovať). Rešpektuje seat capacity (mirror accept route — plné
// prostredie nechá pending, user dostane jasný error pri manuálnom accepte).
// ─────────────────────────────────────────────────────────────────────
async function autoAcceptPendingInvites(user) {
  if (!user || user.emailVerified !== true) return;
  const emailLower = (user.email || '').toLowerCase().trim();
  if (!emailLower || isAppleRelayEmail(emailLower)) return;

  let pending;
  try {
    pending = await Invitation.find({
      email: emailLower,
      status: 'pending',
      expiresAt: { $gt: new Date() }
    });
  } catch (err) {
    logger.warn('[oauth] autoAccept: invitation lookup failed', { error: err.message });
    return;
  }
  if (!pending || pending.length === 0) return;

  let firstAcceptedWsId = null;
  for (const invitation of pending) {
    try {
      // Už člen? → len označ accepted (idempotentné).
      const existing = await WorkspaceMember.findOne({
        workspaceId: invitation.workspaceId,
        userId: user._id
      });
      if (existing) {
        invitation.status = 'accepted';
        await invitation.save();
        if (!firstAcceptedWsId) firstAcceptedWsId = invitation.workspaceId;
        continue;
      }

      const workspace = await Workspace.findById(invitation.workspaceId);
      if (!workspace) {
        invitation.status = 'expired';
        await invitation.save();
        continue;
      }

      // Seat capacity (mirror /invitation/:token/accept).
      const owner = await User.findById(workspace.ownerId).select('email subscription');
      const isTeamPro = isProEmail(owner?.email);
      if (!isTeamPro) {
        const ownerPlan = owner?.subscription?.plan || 'free';
        const baseSeatLimit = getBaseSeatLimit(ownerPlan);
        if (baseSeatLimit !== Infinity) {
          const memberCount = await WorkspaceMember.countDocuments({ workspaceId: invitation.workspaceId });
          const maxSeats = baseSeatLimit + (workspace.paidSeats || 0);
          if (memberCount >= maxSeats) {
            // Plné — nechaj pending (user dostane jasný error pri manuálnom accepte).
            continue;
          }
        }
      }

      await WorkspaceMember.create({
        workspaceId: invitation.workspaceId,
        userId: user._id,
        role: invitation.role,
        invitedBy: invitation.invitedBy
      });
      invitation.status = 'accepted';
      await invitation.save();
      if (!firstAcceptedWsId) firstAcceptedWsId = invitation.workspaceId;

      logger.info('[oauth] auto-accepted pending invitation', {
        userId: user._id.toString(),
        workspaceId: invitation.workspaceId.toString(),
        email: emailLower
      });
    } catch (err) {
      // Duplicate-key (race: dva paralelné loginy) je benígny — membership existuje.
      logger.warn('[oauth] autoAccept: invitation processing failed', {
        error: err.message,
        invitationId: invitation?._id?.toString()
      });
    }
  }

  // currentWorkspaceId nastavíme na prvý prijatý workspace IBA ak user ešte
  // žiadny nemá — nikdy neprepisujeme existujúci aktívny workspace.
  if (firstAcceptedWsId && !user.currentWorkspaceId) {
    try {
      user.currentWorkspaceId = firstAcceptedWsId;
      await user.save();
      await invalidateUserCache(user._id);
    } catch (err) {
      logger.warn('[oauth] autoAccept: set currentWorkspaceId failed', { error: err.message });
    }
  }
}

async function resolveUserFromProfile(provider, profile) {
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
      // Auto-link vyžaduje overenie na OBOCH stranách: provider potvrdil
      // e-mail A existujúci účet má e-mail overený (alebo nemá heslo).
      // Registrácia heslom vlastníctvo e-mailu neoveruje — útočník by si inak
      // vopred založil účet s e-mailom obete a jej neskorší Google/Apple
      // login by sa pripojil k nemu (pre-account hijack s trvalým prístupom
      // útočníka cez heslo). Legitímny používateľ sa prihlási heslom a
      // pripojí účet v Nastaveniach; po resete hesla je e-mail overený.
      const accountTrusted = byEmail.emailVerified === true || !byEmail.password;
      if (!profile.emailVerified || !accountTrusted) {
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

  let user = new User(userData);
  try {
    await user.save();
  } catch (err) {
    // Súbežné prihlásenie dvoch nových používateľov s rovnakým base menom →
    // E11000 na username. Raz zopakujeme s náhodným suffixom (e-mail /
    // providerId duplicita je skutočný konflikt a ide ďalej).
    if (err.code === 11000 && err.keyPattern && err.keyPattern.username) {
      userData.username = `${username.slice(0, 24)}${crypto.randomBytes(3).toString('hex')}`;
      user = new User(userData);
      await user.save();
    } else {
      throw err;
    }
  }

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
  normalizeClientNonce,
  signConnectPending,
  verifyConnectPending,

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
