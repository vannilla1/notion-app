const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const User = require('../models/User');
const mongoose = require('mongoose');
const { authenticateToken, invalidateUserCache, signAuthToken } = require('../middleware/auth');
const { requireWorkspace } = require('../middleware/workspace');
const {
  loginLimiter,
  loginEmailLimiter,
  registerLimiter,
  passwordChangeLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  restoreLimiter,
  restoreTokenLimiter
} = require('../middleware/rateLimiter');
const auditService = require('../services/auditService');
const {
  notifyNewRegistration,
  sendWelcomeEmail,
  sendPasswordResetEmail
} = require('../services/adminEmailService');
const logger = require('../utils/logger');
const { validatePassword } = require('../utils/passwordPolicy');
const { normalizeEmail, normalizeUsername, isHexColor } = require('../utils/inputValidation');
const {
  issueRestoreToken,
  consumeRestoreToken,
  revokeRestoreToken,
  revokeAllRestoreTokens
} = require('../utils/restoreTokens');

const router = express.Router();

// Module-level avatar cache (audit LOW-003 fix). Predtým bolo cez `global._avatarCache`,
// čo je anti-pattern — global namespace v Node module systéme nie je
// potrebný a sťažuje testovanie/refactoring. Module-level Map drží
// rovnaké semantiky (process-wide singleton, FIFO eviction, TTL),
// ale je explicitne scope-ovaný k tomuto modulu.
//
// FIFO eviction (Map.keys() iteruje v insertion order) bráni OOM crashu
// keby útočník v slučke poslal random ObjectId-čka — bez stropu by každý
// miss zapísal null entry, ktorá by inak nikdy nebola odstránená.
const AVATAR_CACHE_MAX = 500;
const AVATAR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const _avatarCache = new Map();
const evictAvatarCacheIfFull = () => {
  while (_avatarCache.size >= AVATAR_CACHE_MAX) {
    const oldestKey = _avatarCache.keys().next().value;
    if (oldestKey === undefined) break;
    _avatarCache.delete(oldestKey);
  }
};

// Configure multer for avatar uploads - using memory storage for Base64
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Neplatný typ súboru. Povolené sú len obrázky (JPEG, PNG, GIF, WebP).'));
    }
  }
});

// Skutočný typ obrázka podľa magic bytes (JPEG, PNG, GIF, WebP) alebo null.
const sniffImageMime = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

// Časovo konštantné porovnanie tajomstiev (ADMIN_SECRET).
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

// Register - with rate limiting
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { password } = req.body;

    // Validation
    if (!req.body.username || !req.body.email || !password) {
      return res.status(400).json({ message: 'Všetky polia sú povinné' });
    }

    // Typ + formát: ne-string (`{"$gt": ""}`, pole) by sa inak dostal do
    // User.findOne ako operátor, resp. spadol na .toLowerCase() → 500.
    const email = normalizeEmail(req.body.email);
    if (!email) {
      return res.status(400).json({ message: 'Zadajte platný e-mail' });
    }
    const username = normalizeUsername(req.body.username);
    if (!username) {
      return res.status(400).json({ message: 'Meno musí mať 2–50 znakov (písmená, číslice, medzera, _ . - \')' });
    }

    // Password policy — min 8 znakov, písmeno + číslo/špec, HIBP check.
    // Async kvôli HIBP API call (k-anonymity, posiela len 5-char SHA1 prefix).
    // Fail-open pri sieťovej chybe HIBP — neblokuje registráciu, len loguje warning.
    const passwordError = await validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    // Block registration with super admin email
    if (email === 'support@prplcrm.eu') {
      return res.status(400).json({ message: 'Registrácia zlyhala. Skúste iný email alebo používateľské meno.' });
    }

    // Check if user exists (generic message to prevent email/username enumeration)
    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      logger.auth('register', null, null, false, req.ip);
      return res.status(400).json({ message: 'Registrácia zlyhala. Skúste iný email alebo používateľské meno.' });
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      logger.auth('register', null, null, false, req.ip);
      return res.status(400).json({ message: 'Registrácia zlyhala. Skúste iný email alebo používateľské meno.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate random color for user
    const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];
    const color = colors[Math.floor(Math.random() * colors.length)];

    // All users register as regular users. Admin is set only via seed script.
    const role = 'user';

    // Create user
    const user = new User({
      username,
      email,
      password: hashedPassword,
      color,
      role
    });
    try {
      await user.save();
    } catch (saveErr) {
      // Súbežná registrácia s rovnakým e-mailom/menom → unique index E11000.
      if (saveErr.code === 11000) {
        logger.auth('register', null, null, false, req.ip);
        return res.status(400).json({ message: 'Registrácia zlyhala. Skúste iný email alebo používateľské meno.' });
      }
      throw saveErr;
    }

    // Generate token
    const token = signAuthToken(user);

    logger.auth('register', user._id, username, true, req.ip);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        color: user.color,
        role: user.role
      }
    });

    // Audit log (fire and forget)
    auditService.logAction({
      userId: user._id.toString(),
      username: user.username,
      email: user.email,
      action: 'auth.register',
      category: 'auth',
      targetType: 'user',
      targetId: user._id.toString(),
      targetName: user.username,
      details: { username: user.username, email: user.email },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: null
    });

    // Admin email notification (fire and forget)
    notifyNewRegistration(user);

    // Welcome email for the new user (fire and forget) — neblokuje
    // HTTP odpoveď, aby SMTP latency nespomalovala registráciu.
    sendWelcomeEmail({ toEmail: user.email, username: user.username })
      .catch(err => logger.error('Welcome email failed', {
        error: err.message, userId: user._id.toString()
      }));
  } catch (error) {
    logger.error('Registration error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Forgot / reset password flow
//
// Bezpečnostné pravidlá:
//   1. Nikdy neprezraď, či email v DB existuje (prevencia user enumeration).
//      Vždy vráť 200 s rovnakou správou, bez ohľadu na to, či sme email
//      našli alebo nie.
//   2. Token je kryptograficky bezpečný (crypto.randomBytes(32) = 256 bit
//      entropy). V DB uchovávame SHA-256 hash, nie plain token — plain ide
//      len do emailu (linku), ktorý user dostane. Keď útočník získa DB
//      dump, nevie z hash-u odvodiť plain token.
//   3. Expiry 1 hodina od vytvorenia.
//   4. Jednorázové použitie — token sa maže pri úspešnom resete aj pri
//      chybnom pokuse s expirovaným tokenom (cleanup).
//   5. Super-admin (support@prplcrm.eu) nemôže používať password reset flow
//      — musí používať admin panel.
// ─────────────────────────────────────────────────────────────────────────

const hashResetToken = (plainToken) =>
  crypto.createHash('sha256').update(plainToken).digest('hex');

// POST /api/auth/forgot-password — user zadá email, pošleme mu reset link
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const genericResponse = {
    message: 'Ak je tento email zaregistrovaný, poslali sme na neho odkaz na obnovenie hesla.'
  };

  try {
    const { email } = req.body || {};

    if (!email || typeof email !== 'string') {
      // Stále vrátime generickú odpoveď — útočník nemá vedieť, že email
      // chýba vs. neexistuje. Minimálna validácia len aby sme nespustili
      // DB lookup na absurdný payload.
      return res.json(genericResponse);
    }

    // Super-admin nemôže používať reset flow
    if (email.toLowerCase() === 'support@prplcrm.eu') {
      logger.warn('forgot-password: super admin attempted', { ip: req.ip });
      return res.json(genericResponse);
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Ak nenájdeme, stále vrátime "success" odpoveď — ale nič neposielame.
    if (!user) {
      // Neoverený vstup od anonyma (aj cudzie e-maily pri enumeration
      // pokusoch) — do logu len skrátený hash, nie PII.
      logger.info('forgot-password: user not found', {
        emailHash: crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 12),
        ip: req.ip
      });
      return res.json(genericResponse);
    }

    // Vygeneruj plain token (ide len do emailu) + ulož hash do DB.
    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(plainToken);
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h

    user.resetPasswordTokenHash = tokenHash;
    user.resetPasswordExpires = expires;
    await user.save();

    const clientUrl = process.env.CLIENT_URL || 'https://prplcrm.eu';
    const resetLink = `${clientUrl}/reset-password?token=${plainToken}`;

    // Fire and forget — neblokujeme odpoveď kvôli SMTP latency.
    sendPasswordResetEmail({
      toEmail: user.email,
      username: user.username,
      resetLink
    }).catch(err => logger.error('Reset email failed', {
      error: err.message, userId: user._id.toString()
    }));

    logger.info('forgot-password: reset link generated', {
      userId: user._id.toString(), ip: req.ip
    });

    return res.json(genericResponse);
  } catch (error) {
    logger.error('Forgot password error', { error: error.message, ip: req.ip });
    // Aj pri chybe vrátime generickú odpoveď — útočník nemá rozlišovať
    // infrastructure error vs. "user nenájdený".
    return res.json(genericResponse);
  }
});

// POST /api/auth/reset-password — user zadá plain token + nové heslo
router.post('/reset-password', resetPasswordLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ message: 'Neplatný alebo chýbajúci token.' });
    }

    // Aplikuj rovnakú policy ako pri register-i — min 8 znakov, písmeno+číslo,
    // HIBP check. Bez tohto by si user mohol cez reset link nastaviť slabé heslo.
    const passwordError = await validatePassword(newPassword);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    const tokenHash = hashResetToken(token);

    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!user) {
      logger.warn('reset-password: invalid or expired token', { ip: req.ip });
      return res.status(400).json({
        message: 'Odkaz na obnovenie hesla je neplatný alebo expiroval.'
      });
    }

    // Hashni nové heslo
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    user.password = hashedPassword;
    user.resetPasswordTokenHash = null;
    user.resetPasswordExpires = null;
    // OAuth-only používateľ si týmto nastavil heslo → odteraz je to aj
    // prihlasovacia metóda (inak by disconnect Google hlásil LAST_LOGIN_METHOD).
    if (!user.authProviders.includes('password')) user.authProviders.push('password');
    // Reset hesla zneplatní všetky existujúce JWT relácie (claim `tv`).
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await invalidateUserCache(user._id);
    // Reset hesla = zneplatniť všetky Block Store obnovovacie tokeny (Android).
    await revokeAllRestoreTokens(user._id);

    logger.auth('password-reset', user._id, user.username, true, req.ip);

    // Audit log
    auditService.logAction({
      userId: user._id.toString(),
      username: user.username,
      email: user.email,
      action: 'auth.password-reset',
      category: 'auth',
      targetType: 'user',
      targetId: user._id.toString(),
      targetName: user.username,
      details: {},
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: null
    });

    return res.json({
      message: 'Heslo bolo úspešne zmenené. Môžete sa prihlásiť.'
    });
  } catch (error) {
    logger.error('Reset password error', { error: error.message, ip: req.ip });
    return res.status(500).json({ message: 'Chyba servera' });
  }
});

// Login - with two-layer rate limiting (per-IP + per-email).
// Per-IP zastaví single-IP brute force, per-email distribuovaný útok zo
// rotujúcich IP. Útočník musí prejsť obidvomi limitermi.
router.post('/login', loginLimiter, loginEmailLimiter, async (req, res) => {
  try {
    const { password } = req.body;

    // Validation — len stringy (objekt by bol Mongo operátor v dotaze,
    // bcrypt.compare s ne-stringom hodí → 500). E-mail bez prísneho regexu:
    // staré účty mohli vzniknúť s ľubovoľným reťazcom.
    if (typeof req.body.email !== 'string' || typeof password !== 'string' ||
        !req.body.email.trim() || !password || req.body.email.length > 254 || password.length > 1024) {
      return res.status(400).json({ message: 'Email a heslo sú povinné' });
    }
    // E-mail je v DB lowercase (schéma) — bez normalizácie „Jan@Firma.sk“ neprešiel.
    const email = req.body.email.trim().toLowerCase();

    // Block super admin from regular login
    if (email === 'support@prplcrm.eu') {
      return res.status(400).json({ message: 'Nesprávny email alebo heslo' });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      logger.auth('login', null, email, false, req.ip);
      // Audit log failed login — email not found (pre SuperAdmin Diagnostics)
      auditService.logAction({
        action: 'auth.login_failed',
        category: 'auth',
        email,
        details: { reason: 'email_not_found' },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
      return res.status(400).json({ message: 'Nesprávny email alebo heslo' });
    }

    // OAuth-only useri (Google/Apple) nemajú heslo (user.password = null).
    // Bez tohto guardu by bcrypt.compare(plain, null) hodil exception. Vraciame
    // generic message aby sme nepresne neprezradili "tento email má len Google
    // login" — to by bol enumeration leak. User uvidí "nesprávny email alebo
    // heslo" a sám si uvedomí, že sa má prihlásiť cez Google/Apple tlačítko.
    if (!user.password) {
      logger.auth('login', user._id, user.username, false, req.ip);
      auditService.logAction({
        userId: user._id.toString(),
        username: user.username,
        email: user.email,
        action: 'auth.login_failed',
        category: 'auth',
        targetType: 'user',
        targetId: user._id.toString(),
        details: { reason: 'oauth_only_no_password' },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
      return res.status(400).json({ message: 'Nesprávny email alebo heslo' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      logger.auth('login', user._id, user.username, false, req.ip);
      // Audit log failed login — wrong password
      auditService.logAction({
        userId: user._id.toString(),
        username: user.username,
        email: user.email,
        action: 'auth.login_failed',
        category: 'auth',
        targetType: 'user',
        targetId: user._id.toString(),
        details: { reason: 'wrong_password' },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
      return res.status(400).json({ message: 'Nesprávny email alebo heslo' });
    }

    // Generate token
    const token = signAuthToken(user);

    logger.auth('login', user._id, user.username, true, req.ip);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        color: user.color,
        avatar: user.avatar,
        role: user.role
      }
    });

    // Audit log (fire and forget)
    auditService.logAction({
      userId: user._id.toString(),
      username: user.username,
      email: user.email,
      action: 'auth.login',
      category: 'auth',
      targetType: 'user',
      targetId: user._id.toString(),
      targetName: user.username,
      details: { email: user.email },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: null
    });
  } catch (error) {
    logger.error('Login error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get current user
router.get('/me', authenticateToken, (req, res) => {
  res.json(req.user);
});

// ─────────────────────────────────────────────────────────────────────
// Google Play zero-tap sign-in (Block Store) — obnovovacie tokeny Android
// appky. Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
//   POST   /restore-token  (JWT)      → vydá 180-dňový jednorazový token
//   POST   /restore        (verejný)  → token → nový JWT + rotovaný token
//   DELETE /restore-token  (verejný)  → zruší token (dôkaz vlastníctvom,
//                                      funguje aj po expirácii JWT pri logoute)
// Plaintext tokenu sa nikdy neloguje ani neukladá.
// ─────────────────────────────────────────────────────────────────────

const RESTORE_TOKEN_MIN = 32;
const RESTORE_TOKEN_MAX = 128;
const isRestoreTokenShape = (t) =>
  typeof t === 'string' && t.length >= RESTORE_TOKEN_MIN && t.length <= RESTORE_TOKEN_MAX;

const publicUser = (user) => ({
  id: user._id,
  username: user.username,
  email: user.email,
  color: user.color,
  avatar: user.avatar,
  role: user.role
});

router.post('/restore-token', authenticateToken, restoreTokenLimiter, async (req, res) => {
  try {
    if (String(req.user.email || '').toLowerCase() === 'support@prplcrm.eu') {
      return res.status(403).json({ message: 'Nedostupné pre tento účet' });
    }
    const deviceLabel = typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel : '';
    const issued = await issueRestoreToken(req.user.id, deviceLabel);
    if (!issued) {
      return res.status(401).json({ message: 'Neplatný token' });
    }

    auditService.logAction({
      userId: req.user.id.toString(),
      username: req.user.username,
      email: req.user.email,
      action: 'auth.restore_token_issued',
      category: 'auth',
      targetType: 'user',
      targetId: req.user.id.toString(),
      details: { deviceLabel: deviceLabel.slice(0, 120) },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.json({ restoreToken: issued.plaintext, expiresAt: issued.expiresAt });
  } catch (error) {
    logger.error('Restore token issue error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.post('/restore', restoreLimiter, async (req, res) => {
  try {
    const { restoreToken } = req.body || {};
    if (!isRestoreTokenShape(restoreToken)) {
      return res.status(400).json({ message: 'Obnovovací token je povinný' });
    }

    const consumed = await consumeRestoreToken(restoreToken);
    if (!consumed.ok) {
      auditService.logAction({
        action: 'auth.restore_failed',
        category: 'auth',
        details: { reason: consumed.reason },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
      return res.status(401).json({ message: 'Neplatný alebo expirovaný obnovovací token' });
    }

    const { user, entry } = consumed;
    if (String(user.email || '').toLowerCase() === 'support@prplcrm.eu') {
      return res.status(401).json({ message: 'Neplatný alebo expirovaný obnovovací token' });
    }

    const deviceLabel = entry?.deviceLabel || '';
    const rotated = await issueRestoreToken(user._id, deviceLabel);
    const token = signAuthToken(user);

    logger.auth('restore', user._id, user.username, true, req.ip);
    auditService.logAction({
      userId: user._id.toString(),
      username: user.username,
      email: user.email,
      action: 'auth.restore',
      category: 'auth',
      targetType: 'user',
      targetId: user._id.toString(),
      targetName: user.username,
      details: { deviceLabel },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: null
    });

    res.json({
      token,
      restoreToken: rotated ? rotated.plaintext : null,
      expiresAt: rotated ? rotated.expiresAt : null,
      user: publicUser(user)
    });
  } catch (error) {
    logger.error('Restore error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.delete('/restore-token', restoreLimiter, async (req, res) => {
  try {
    const { restoreToken } = req.body || {};
    if (isRestoreTokenShape(restoreToken)) {
      const owner = await revokeRestoreToken(restoreToken);
      if (owner) {
        auditService.logAction({
          userId: owner._id.toString(),
          username: owner.username,
          email: owner.email,
          action: 'auth.restore_token_revoked',
          category: 'auth',
          targetType: 'user',
          targetId: owner._id.toString(),
          details: {},
          ipAddress: req.ip,
          userAgent: req.get('user-agent')
        });
      }
    }
    // Idempotentné — klient (logout) nepotrebuje rozlišovať.
    res.json({ ok: true });
  } catch (error) {
    logger.error('Restore token revoke error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Notification preferences — per-user push toggles for "general" notifs.
// Direct notifications (priradenia, dokončenie mojej priradenej úlohy
// niekým iným) sa nedajú vypnúť — vždy idú push.
// ─────────────────────────────────────────────────────────────────────

// Zhodné s defaultmi v models/User.js (OPT-OUT model 2026-07: všetko true) —
// inak UI používateľovi bez uložených preferencií ukazovalo „vypnuté“, kým
// server push reálne posielal.
const DEFAULT_NOTIFICATION_PREFS = {
  pushTeamActivity: true,
  pushDeadlines:    true,
  pushOverdue:      true,
  pushNewMember:    true
};

router.get('/notification-preferences', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id, 'notificationPreferences preferences').lean();
    res.json({
      ...DEFAULT_NOTIFICATION_PREFS,
      ...(user?.notificationPreferences || {}),
      // marketingEmails ide v rovnakom payloade — UI komponent ho zobrazuje
      // v sekcii "Marketing & pripomienky", default je true (opt-in by default,
      // user môže vypnúť cez UI toggle alebo unsubscribe link v emaili).
      marketingEmails: user?.preferences?.marketingEmails !== false
    });
  } catch (error) {
    logger.error('Get notification preferences error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.put('/notification-preferences', authenticateToken, async (req, res) => {
  try {
    const allowedKeys = Object.keys(DEFAULT_NOTIFICATION_PREFS);
    const updates = {};
    for (const key of allowedKeys) {
      if (typeof req.body?.[key] === 'boolean') {
        updates[`notificationPreferences.${key}`] = req.body[key];
      }
    }
    // marketingEmails sedí v inom path-e (preferences.*) lebo to nie je push
    // toggle — je to email-channel opt-out. Spracovaný v rovnakom requeste,
    // aby UI nemuselo viesť dva paralelné PUT-y.
    if (typeof req.body?.marketingEmails === 'boolean') {
      updates['preferences.marketingEmails'] = req.body.marketingEmails;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'Žiadne platné nastavenia v requeste' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, projection: 'notificationPreferences preferences' }
    ).lean();

    // Invalidate Redis user cache — middleware/auth cachuje User na 30s,
    // bez tohto by ostatné requesty v okne stále videli staré preferences.
    await invalidateUserCache(req.user.id);

    res.json({
      ...DEFAULT_NOTIFICATION_PREFS,
      ...(user?.notificationPreferences || {}),
      marketingEmails: user?.preferences?.marketingEmails !== false
    });
  } catch (error) {
    logger.error('Update notification preferences error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    // Len vracané polia — plný dokument by ťahal avatarData (až ~6.7 MB)
    // a Google sync mapy a spúšťal dešifrovanie tokenov.
    const user = await User.findById(req.user.id).select('username email color avatar role createdAt').lean();
    if (!user) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }
    res.json({
      id: user._id,
      username: user.username,
      email: user.email,
      color: user.color,
      avatar: user.avatar || null,
      role: user.role,
      createdAt: user.createdAt
    });
  } catch (error) {
    logger.error('Get profile error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update user profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { username: rawUsername, email: rawEmail, color } = req.body;

    // Validácia typov a formátu (ne-string = Mongo operátor v dotaze / 500)
    let email = null;
    if (rawEmail !== undefined && rawEmail !== null && rawEmail !== '') {
      email = normalizeEmail(rawEmail);
      if (!email) return res.status(400).json({ message: 'Zadajte platný e-mail' });
    }
    let username = null;
    if (rawUsername !== undefined && rawUsername !== null && rawUsername !== '') {
      username = normalizeUsername(rawUsername);
      if (!username) return res.status(400).json({ message: 'Meno musí mať 2–50 znakov (písmená, číslice, medzera, _ . - \')' });
    }
    if (color !== undefined && color !== null && color !== '' && !isHexColor(color)) {
      return res.status(400).json({ message: 'Neplatná farba' });
    }
    if (email === 'support@prplcrm.eu') {
      return res.status(400).json({ message: 'Email je už registrovaný' });
    }

    const current = await User.findById(userId).select('email').lean();
    if (!current) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }
    const emailChanged = !!email && email !== current.email;

    // Check if email is taken by another user
    if (emailChanged) {
      const existingUser = await User.findOne({ email, _id: { $ne: userId } });
      if (existingUser) {
        return res.status(400).json({ message: 'Email je už registrovaný' });
      }
    }

    // Check if username is taken by another user
    if (username) {
      const existingUser = await User.findOne({ username, _id: { $ne: userId } });
      if (existingUser) {
        return res.status(400).json({ message: 'Užívateľské meno je už obsadené' });
      }
    }

    const updates = {};
    if (username) updates.username = username;
    if (emailChanged) {
      updates.email = email;
      // Nový e-mail nie je overený — inak by ďalší Google login cez
      // byProviderId s emailVerified=true automaticky prijal cudzie
      // pozvánky na tento e-mail (únos workspace) a OAuth auto-link by
      // dôveroval neoverenej adrese.
      updates.emailVerified = false;
    }
    if (color) updates.color = color;

    let updatedUser;
    try {
      updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true })
        .select('username email color avatar role');
    } catch (updateErr) {
      if (updateErr.code === 11000) {
        return res.status(400).json({ message: 'Email alebo meno je už obsadené' });
      }
      throw updateErr;
    }

    // Invalidate Redis user cache — username/email/color sa môžu zmeniť, bez
    // invalidation by ostatné requesty 30s ďalej videli staré hodnoty (auth
    // middleware cachuje User po každom token validate).
    await invalidateUserCache(userId);

    logger.info('Profile updated', { userId, updates: Object.keys(updates) });

    res.json({
      id: updatedUser._id,
      username: updatedUser.username,
      email: updatedUser.email,
      color: updatedUser.color,
      avatar: updatedUser.avatar || null,
      role: updatedUser.role
    });
  } catch (error) {
    logger.error('Update profile error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Upload avatar - stores Base64 in MongoDB
router.post('/avatar', authenticateToken, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      logger.error('Avatar upload multer error', { error: err.message, userId: req.user?.id });
      return res.status(400).json({ message: err.message || 'Chyba pri nahrávaní avatara' });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Žiadny súbor nebol nahraný' });
      }

      const userId = req.user.id;

      // MIME z multipart hlavičky si určuje klient — skutočný typ odvodíme
      // z magic bytes a uložíme ten (Content-Type pri servírovaní avatara).
      const sniffedMime = sniffImageMime(req.file.buffer);
      if (!sniffedMime) {
        return res.status(400).json({ message: 'Neplatný typ súboru. Povolené sú len obrázky (JPEG, PNG, GIF, WebP).' });
      }

      // Convert to Base64
      const base64Data = req.file.buffer.toString('base64');

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'Používateľ nenájdený' });
      }

      user.avatar = `avatar-${userId}`;
      user.avatarData = base64Data;
      user.avatarMimetype = sniffedMime;

      await user.save();

      // Invalidate avatar cache so next request gets fresh image.
      // Kľúč je string z URL — req.user.id môže byť ObjectId (bez Redisu).
      _avatarCache.delete(String(userId));
      // Invalidate Redis user cache — user.avatar field (filename pointer)
      // sa zmenil, ostatné requesty by inak vrátili stale starý filename
      // počas 30s TTL window.
      await invalidateUserCache(userId);

      logger.info('Avatar uploaded', { userId, mimetype: sniffedMime, size: req.file.size });

      res.json({
        message: 'Avatar bol úspešne nahraný',
        avatar: user.avatar
      });
    } catch (error) {
      logger.error('Avatar upload error', { error: error.message, userId: req.user.id });
      res.status(500).json({ message: 'Chyba pri nahrávaní avatara' });
    }
  });
});

// Get avatar image (no auth - loaded via <img src>)
router.get('/avatar/:userId', async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.userId)) {
      return res.status(400).json({ message: 'Neplatné ID' });
    }

    // In-memory avatar cache (5 min TTL) — viď komentár pri _avatarCache deklarácii.
    const cacheKey = req.params.userId;
    const cached = _avatarCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < AVATAR_CACHE_TTL_MS) {
      if (!cached.data) {
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({ message: 'Avatar nenájdený' });
      }
      res.set('Content-Type', cached.mimetype);
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(cached.data);
    }

    const user = await User.findById(req.params.userId).select('avatarData avatarMimetype').lean();

    if (!user || !user.avatarData) {
      evictAvatarCacheIfFull();
      _avatarCache.set(cacheKey, { data: null, ts: Date.now() });
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({ message: 'Avatar nenájdený' });
    }

    const buffer = Buffer.from(user.avatarData, 'base64');
    evictAvatarCacheIfFull();
    _avatarCache.set(cacheKey, { data: buffer, mimetype: user.avatarMimetype || 'image/jpeg', ts: Date.now() });
    res.set('Content-Type', user.avatarMimetype || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (error) {
    logger.error('Avatar get error', { error: error.message, userId: req.params.userId });
    res.status(500).json({ message: 'Chyba pri načítaní avatara' });
  }
});

// Delete avatar
router.delete('/avatar', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    await User.findByIdAndUpdate(userId, {
      avatar: null,
      avatarData: null,
      avatarMimetype: null
    });
    // Invalidate avatar cache + Redis user cache (analogicky k POST /avatar)
    _avatarCache.delete(String(userId));
    await invalidateUserCache(userId);
    logger.info('Avatar deleted', { userId });

    res.json({ message: 'Avatar bol odstránený' });
  } catch (error) {
    logger.error('Avatar delete error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba pri odstraňovaní avatara' });
  }
});

// Change password - with rate limiting
router.put('/password', authenticateToken, passwordChangeLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ message: 'Zadajte aktuálne heslo' });
    }

    // Password policy — rovnako ako register/reset.
    const passwordError = await validatePassword(newPassword);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    const user = await User.findById(userId).select('password username email authProviders tokenVersion');
    if (!user) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }
    // OAuth-only účet heslo nemá — bcrypt.compare(s, null) by hodil → 500.
    if (!user.password) {
      return res.status(400).json({ message: 'Účet nemá nastavené heslo — použite „Zabudnuté heslo“ na prihlasovacej stránke.' });
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      logger.auth('password-change', userId, user.username, false, req.ip);
      // Audit log failed password change — pre SuperAdmin Diagnostics aby
      // bolo vidieť pokus s neplatným currentPassword (potenciálny indikátor
      // session-jacking — niekto sa pokúša zmeniť heslo bez znalosti starého).
      auditService.logAction({
        userId: userId.toString(),
        username: user.username,
        email: user.email,
        action: 'auth.password-change_failed',
        category: 'auth',
        targetType: 'user',
        targetId: userId.toString(),
        details: { reason: 'wrong_current_password' },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
      return res.status(400).json({ message: 'Aktuálne heslo nie je správne' });
    }

    // Detekuj "no-op" zmenu — nové heslo == staré. Zbytočne by sme spamovali
    // audit log pri user "musí zmeniť heslo" enforcement-och kde user oklamal.
    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return res.status(400).json({ message: 'Nové heslo musí byť odlišné od aktuálneho.' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // tokenVersion++ zneplatní všetky existujúce JWT (aj ukradnutý token,
    // kvôli ktorému sa heslo typicky mení). Aktuálna relácia dostane nový
    // token v odpovedi, takže používateľ ostane prihlásený.
    const updated = await User.findByIdAndUpdate(
      userId,
      {
        $set: { password: hashedPassword },
        $inc: { tokenVersion: 1 },
        $addToSet: { authProviders: 'password' }
      },
      { new: true, projection: { tokenVersion: 1 } }
    );
    await invalidateUserCache(userId);
    // Zmena hesla = zneplatniť všetky Block Store obnovovacie tokeny (Android).
    await revokeAllRestoreTokens(userId);

    logger.auth('password-change', userId, user.username, true, req.ip);

    // Audit log password change — predtým len logger.auth (do file),
    // teraz aj cez auditService (do MongoDB pre SuperAdmin Audit Trail).
    // Compliance: GDPR Art. 32 vyžaduje audit security-relevant events.
    auditService.logAction({
      userId: userId.toString(),
      username: user.username,
      email: user.email,
      action: 'auth.password-change',
      category: 'auth',
      targetType: 'user',
      targetId: userId.toString(),
      targetName: user.username,
      details: {},
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: null
    });

    res.json({
      message: 'Heslo bolo úspešne zmenené. Ostatné zariadenia boli odhlásené.',
      token: signAuthToken({ _id: userId, tokenVersion: updated?.tokenVersion || 0 })
    });
  } catch (error) {
    logger.error('Password change error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba pri zmene hesla' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Account deletion — Apple App Store Guideline 5.1.1(v) compliance.
//
// Apps that support account creation MUST offer in-app account deletion.
// Tento endpoint poskytuje hard-delete účtu používateľa s týmito krokmi:
//
//   1. AUTORIZÁCIA — vyžaduje confirm: 'DELETE' v tele requestu (anti-fat-fingers).
//      Pre password-only userov navyše overujeme heslo (znižuje riziko
//      session-hijacking → permanentné zničenie dát).
//
//   2. WORKSPACE OWNERSHIP CHECK — ak user vlastní workspace s INÝMI členmi,
//      nepovolíme mazanie kým neprevedie vlastníctvo na manažéra. Bez tohto
//      by sa stratila celá tímová práca pri delete-e jediného Vlastníka.
//      Workspaces kde je sole member — bezpečne zmazané.
//
//   3. CASCADE DELETE — atomicky:
//      - Workspaces (sole-member only) + ich Tasks, Contacts, Messages, Pages
//      - WorkspaceMember záznamy v cudzích workspaces
//      - Notifications adresované userovi
//      - APNs/FCM device tokens, PushSubscriptions (web push)
//      - Invitations (sent + received)
//      - User document
//
//   4. ANONYMIZE refs v cudzích workspaces — Messages, Tasks, Contacts ktoré
//      user vytvoril v iných workspaces sa NEzmažu (patrí to tímu), ale
//      `userId` reference ostane orphan. FE handluje "Zmazaný používateľ"
//      gracefully cez null-check pri populate-e.
//
//   5. AUDIT LOG — záznam o delete-e s userId (pre forenzné pátranie ak by
//      sa neskôr objavili problémy "moje dáta zmizli"). User už neexistuje,
//      ale audit log si zachová username + email pre dohľadanie.
//
// Po delete-e klient musí zmazať lokálny token (frontend sa o to postará).
// ─────────────────────────────────────────────────────────────────────────

// ─── Spoločná kaskáda mazania používateľa (DELETE /account aj admin DELETE /users/:id)

// Vlastnené workspaces s inými členmi — blokujú zmazanie (strata tímovej práce).
const findBlockingWorkspaces = async (userId) => {
  const Workspace = require('../models/Workspace');
  const WorkspaceMember = require('../models/WorkspaceMember');
  const ownedWorkspaces = await Workspace.find({ ownerId: userId }).select('_id name').lean();
  const blocking = [];
  for (const ws of ownedWorkspaces) {
    const otherMembers = await WorkspaceMember.countDocuments({ workspaceId: ws._id, userId: { $ne: userId } });
    if (otherMembers > 0) blocking.push({ id: ws._id.toString(), name: ws.name, otherMembers });
  }
  return blocking;
};

// Zruší Stripe predplatné (okamžite). Apple sa zo servera zrušiť nedá —
// vráti appleActive, aby ho UI vedelo upozorniť.
const cancelBillingForDeletion = async (user) => {
  const sub = user.subscription || {};
  const appleActive = sub.source === 'apple' && sub.plan !== 'free' &&
    !!sub.paidUntil && new Date(sub.paidUntil) > new Date();
  if (!sub.stripeSubscriptionId) return { ok: true, appleActive };
  if (!process.env.STRIPE_SECRET_KEY) {
    logger.error('account-delete: user has Stripe subscription but Stripe is not configured', { userId: String(user._id) });
    return { ok: false, appleActive };
  }
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-11-20.acacia', timeout: 15000, maxNetworkRetries: 2
    });
    await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
    logger.info('account-delete: Stripe subscription canceled', { userId: String(user._id), subscriptionId: sub.stripeSubscriptionId });
    return { ok: true, appleActive };
  } catch (err) {
    // Už zrušené/neexistujúce predplatné nie je prekážka.
    if (err.code === 'resource_missing' || err.statusCode === 404) return { ok: true, appleActive };
    logger.error('account-delete: Stripe cancel failed', { userId: String(user._id), error: err.message });
    return { ok: false, appleActive };
  }
};

// Zmaže sole-owned workspaces s obsahom (vrátane príloh v R2) a dáta
// používateľa v ostatných workspaces. Idempotentné — pri čiastočnom
// zlyhaní ho opakovanie dokončí.
const cascadeDeleteUserData = async (user) => {
  const userId = user._id;
  const Workspace = require('../models/Workspace');
  const WorkspaceMember = require('../models/WorkspaceMember');
  const Task = require('../models/Task');
  const Contact = require('../models/Contact');
  const Message = require('../models/Message');
  const Page = require('../models/Page');
  const Notification = require('../models/Notification');
  const Invitation = require('../models/Invitation');
  const APNsDevice = require('../models/APNsDevice');
  const FcmDevice = require('../models/FcmDevice');
  const PushSubscription = require('../models/PushSubscription');

  const ownedWorkspaces = await Workspace.find({ ownerId: userId }).select('_id').lean();
  const soleWorkspaceIds = ownedWorkspaces.map(ws => ws._id);

  if (soleWorkspaceIds.length > 0) {
    // Bloby príloh správ aj kontaktov/projektov (R2 + ContactFile) PRED
    // deleteMany — po ňom už kľúče niet odkiaľ prečítať. Best-effort.
    const { deleteMessageBlobs } = require('../services/messageFiles');
    const { deleteWorkspaceFileBlobs } = require('../services/workspaceFiles');
    await deleteMessageBlobs({ workspaceId: { $in: soleWorkspaceIds } });
    await deleteWorkspaceFileBlobs(soleWorkspaceIds);
    await Promise.all([
      Task.deleteMany({ workspaceId: { $in: soleWorkspaceIds } }),
      Contact.deleteMany({ workspaceId: { $in: soleWorkspaceIds } }),
      Message.deleteMany({ workspaceId: { $in: soleWorkspaceIds } }),
      Page.deleteMany({ workspaceId: { $in: soleWorkspaceIds } }),
      Notification.deleteMany({ workspaceId: { $in: soleWorkspaceIds } }),
      Invitation.deleteMany({ workspaceId: { $in: soleWorkspaceIds } }),
      WorkspaceMember.deleteMany({ workspaceId: { $in: soleWorkspaceIds } }),
      Workspace.deleteMany({ _id: { $in: soleWorkspaceIds } })
    ]);
  }

  // Dáta používateľa v ostatných workspaces
  await Promise.all([
    // Memberships v cudzích workspaces (kde user nie je owner)
    WorkspaceMember.deleteMany({ userId }),
    // Notifications adresované userovi (vo všetkých workspaces)
    Notification.deleteMany({ userId }),
    // Push device tokens
    APNsDevice.deleteMany({ userId }),
    FcmDevice.deleteMany({ userId }),
    PushSubscription.deleteMany({ userId }),
    // Invitations sent BY userovi alebo TO userovmu emailu
    Invitation.deleteMany({ $or: [{ invitedBy: userId }, { email: user.email }] })
  ]);

  // POZN: Tasks/Contacts/Messages ktoré user vytvoril v cudzích workspaces
  // NEMAŽEME — patria tímu. FE handluje orphan userId references gracefully
  // (zobrazí "[Zmazaný používateľ]" pri populate null).
  return { soleWorkspaceIds };
};

router.delete('/account', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  let user; // declared outside try aby bol dostupný v catch pre audit log

  try {
    const { confirm, password } = req.body || {};

    // Anti-fat-fingers — explicit confirmation string
    if (confirm !== 'DELETE') {
      return res.status(400).json({
        message: 'Pre potvrdenie zmazania účtu pošli { confirm: "DELETE" } v tele requestu.'
      });
    }

    user = await User.findById(userId);
    if (!user) {
      // Token je validný ale user už neexistuje — vraciame 404, klient si zmaže token
      return res.status(404).json({ message: 'Používateľ nenájdený' });
    }

    // Super-admin nesmie mazať vlastný účet cez tento endpoint
    if (user.email === 'support@prplcrm.eu') {
      return res.status(403).json({ message: 'Super-admin účet nemožno zmazať týmto spôsobom.' });
    }

    // Pre password-only userov vyžadujeme heslo aby sme zabránili
    // ukradnutý-token-driven destruction. OAuth-only useri (googleId/appleId
    // bez password) prechádzajú bez heslo-kontroly — token na sebe je dôkaz
    // že user prešiel OAuth flow (ekvivalent re-autentifikácie).
    if (user.password) {
      if (!password || typeof password !== 'string') {
        return res.status(400).json({ message: 'Pre potvrdenie zadajte heslo.' });
      }
      const passwordOk = await bcrypt.compare(password, user.password);
      if (!passwordOk) {
        logger.warn('account-delete: wrong password', { userId, ip: req.ip });
        return res.status(400).json({ message: 'Nesprávne heslo.' });
      }
    }

    // ── 1) Workspace ownership check ──
    const blockingWorkspaces = await findBlockingWorkspaces(userId);
    if (blockingWorkspaces.length > 0) {
      return res.status(409).json({
        message: 'Pred zmazaním účtu musíte previesť vlastníctvo workspace-ov, ktoré majú ďalších členov, alebo z nich odstrániť všetkých členov.',
        blockingWorkspaces
      });
    }

    // ── 1b) Predplatné — Stripe zrušíme PRED zmazaním dát. Po zmazaní
    // User dokumentu by renewal webhooky používateľa nenašli a Stripe by
    // ďalej strhával platby za neexistujúci účet. Zlyhanie = 502, účet
    // ostáva nedotknutý a používateľ môže akciu zopakovať.
    const billing = await cancelBillingForDeletion(user);
    if (!billing.ok) {
      return res.status(502).json({
        message: 'Nepodarilo sa zrušiť predplatné. Účet nebol zmazaný — skúste to o chvíľu znova alebo kontaktujte support@prplcrm.eu.'
      });
    }

    // ── 2) + 3) Kaskáda dát ──
    const { soleWorkspaceIds } = await cascadeDeleteUserData(user);

    // ── 4) Audit log PRED delete-om user dokumentu ──
    // Audit log si zapamätá username + email aj keď user record už neexistuje.
    auditService.logAction({
      userId: userId.toString(),
      username: user.username,
      email: user.email,
      action: 'auth.account-deleted',
      category: 'auth',
      targetType: 'user',
      targetId: userId.toString(),
      targetName: user.username,
      details: {
        deletedWorkspaces: soleWorkspaceIds.length,
        ownedWorkspaceIds: soleWorkspaceIds.map(id => id.toString())
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: null
    });

    // ── 5) Final delete user document ──
    await User.findByIdAndDelete(userId);

    logger.info('Account deleted by user', {
      userId,
      username: user.username,
      email: user.email,
      deletedWorkspaces: soleWorkspaceIds.length
    });

    await invalidateUserCache(userId);

    return res.json({
      message: 'Tvoj účet a všetky pripojené dáta boli úspešne zmazané. Ďakujeme, že si používal Prpl CRM.',
      // Apple predplatné server zrušiť nevie — App Store ho ďalej obnovuje,
      // kým ho používateľ nezruší v iOS Nastaveniach (Guideline 5.1.1(v)).
      ...(billing.appleActive && {
        notice: 'Predplatné cez App Store sa nezrušilo automaticky. Zrušte ho v iPhone v Nastaveniach → Apple ID → Predplatné.'
      })
    });
  } catch (error) {
    logger.error('Account deletion error', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id
    });
    return res.status(500).json({ message: 'Chyba pri mazaní účtu. Skús znova alebo kontaktuj support@prplcrm.eu.' });
  }
});

// Get all users in current workspace (for sharing/assignment)
// CRITICAL: `role` MUSÍ byť workspace-scoped (WorkspaceMember.role), NIKDY globálne
// User.role — inak sa pri picker-i používateľov v jednom workspace zobrazí rola
// z iného workspacu (napr. "Admin" pri mene, keď je človek v tomto workspace len
// member). Enum hodnoty: 'owner' | 'manager' | 'member' (pozri WorkspaceMember.js).
// Listuje členov AKTUÁLNE OTVORENÉHO workspace-u (z X-Workspace-Id headera).
// Predtým sme čítali user.currentWorkspaceId — to ale nereflektuje workspace
// switching v UI (klient drží otvorený WS v lokálnom state, kým DB má len
// "default workspace"). Dôsledok: ak má user 2 workspaces a aktuálne má
// otvorený nie-default, picker príjemcov v Správach a priraďovaní v Úlohách
// vracal členov default workspace-u (často len seba). Cez requireWorkspace
// middleware je teraz behavior konzistentný s /api/workspaces/current/members.
router.get('/users', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const WorkspaceMember = require('../models/WorkspaceMember');
    const members = await WorkspaceMember.find({ workspaceId: req.workspace._id })
      .populate('userId', 'username email color avatar');

    res.json(members
      .filter(m => m.userId) // defensívne: ak je user deleted, populate vráti null
      .map(m => ({
        id: m.userId._id,
        username: m.userId.username,
        email: m.userId.email,
        color: m.userId.color,
        avatar: m.userId.avatar,
        role: m.role // workspace-scoped: 'owner' | 'manager' | 'member'
      })));
  } catch (error) {
    logger.error('Get users error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Set admin by username (requires authentication + admin role + separate secret)
router.post('/set-admin', authenticateToken, async (req, res) => {
  try {
    const { username, secret } = req.body;
    const ADMIN_SECRET = process.env.ADMIN_SECRET;

    // Require separate ADMIN_SECRET (not JWT_SECRET)
    if (!ADMIN_SECRET || !safeEqual(secret, ADMIN_SECRET)) {
      return res.status(403).json({ message: 'Neplatný prístup' });
    }

    // Only super admin can promote others
    const currentUser = await User.findById(req.user.id);
    if (!currentUser || currentUser.email !== 'support@prplcrm.eu') {
      return res.status(403).json({ message: 'Neplatný prístup' });
    }

    if (typeof username !== 'string' || !username) {
      return res.status(400).json({ message: 'Neplatné meno' });
    }
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }

    await User.findByIdAndUpdate(user._id, { role: 'admin' });
    await invalidateUserCache(user._id);

    logger.info('Admin set', { username, setBy: req.user.id });

    res.json({ message: `Užívateľ ${username} bol nastavený ako admin`, success: true });
  } catch (error) {
    logger.error('Set admin error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Set subscription plan (admin only)
router.post('/set-plan', authenticateToken, async (req, res) => {
  try {
    const { email, plan, secret } = req.body;
    const ADMIN_SECRET = process.env.ADMIN_SECRET;

    if (!ADMIN_SECRET || !safeEqual(secret, ADMIN_SECRET)) {
      return res.status(403).json({ message: 'Neplatný prístup' });
    }

    const currentUser = await User.findById(req.user.id);
    if (!currentUser || currentUser.email !== 'support@prplcrm.eu') {
      return res.status(403).json({ message: 'Neplatný prístup' });
    }

    if (!['free', 'team', 'pro'].includes(plan)) {
      return res.status(400).json({ message: 'Neplatný plán' });
    }

    const normalized = normalizeEmail(email);
    if (!normalized) {
      return res.status(400).json({ message: 'Neplatný e-mail' });
    }
    const user = await User.findOne({ email: normalized }).select('_id subscription.stripeSubscriptionId subscription.source');
    if (!user) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }

    // Len pole plan — priradenie celého `subscription` objektu by zmazalo
    // Stripe/Apple väzby (webhooky by usera nenašli), paidUntil, zľavu aj
    // stav pripomienok.
    await User.updateOne({ _id: user._id }, { $set: { 'subscription.plan': plan } });
    await invalidateUserCache(user._id);

    logger.info('Plan set', { email, plan, setBy: req.user.id });

    res.json({ message: `${email} bol nastavený na plán ${plan}`, success: true });
  } catch (error) {
    logger.error('Set plan error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete user — len globálny admin. Predtým to vedela aj globálna rola
// 'manager' naprieč VŠETKÝMI tenantmi a mazalo sa len User + členstvá
// (vlastnené workspaces ostali so sirotským ownerId, predplatné bežalo
// ďalej). Teraz rovnaká kaskáda ako DELETE /account.
router.delete('/users/:userId', authenticateToken, async (req, res) => {
  try {
    const targetId = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ message: 'Neplatné ID používateľa' });
    }

    const currentUser = await User.findById(req.user.id).select('role').lean();
    if (!currentUser || currentUser.role !== 'admin') {
      return res.status(403).json({ message: 'Nemáte oprávnenie vymazať tohto užívateľa' });
    }

    // Cannot delete yourself — req.user.id môže byť ObjectId (bez Redisu)
    if (String(req.user.id) === targetId) {
      return res.status(400).json({ message: 'Nemôžete vymazať vlastný účet' });
    }

    const targetUser = await User.findById(targetId).select('-avatarData');
    if (!targetUser) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }
    if (targetUser.role === 'admin') {
      return res.status(403).json({ message: 'Admin nemôže vymazať iného admina' });
    }
    if (targetUser.email === 'support@prplcrm.eu') {
      return res.status(403).json({ message: 'Super-admin účet nemožno zmazať' });
    }

    const blockingWorkspaces = await findBlockingWorkspaces(targetUser._id);
    if (blockingWorkspaces.length > 0) {
      return res.status(409).json({
        message: 'Používateľ vlastní workspace s ďalšími členmi — najprv treba previesť vlastníctvo.',
        blockingWorkspaces
      });
    }

    const billing = await cancelBillingForDeletion(targetUser);
    if (!billing.ok) {
      return res.status(502).json({ message: 'Nepodarilo sa zrušiť predplatné používateľa. Skúste znova.' });
    }

    const { soleWorkspaceIds } = await cascadeDeleteUserData(targetUser);

    auditService.logAction({
      userId: String(req.user.id),
      username: req.user.username,
      email: req.user.email,
      action: 'auth.user-deleted-by-admin',
      category: 'auth',
      targetType: 'user',
      targetId,
      targetName: targetUser.username,
      details: { deletedWorkspaces: soleWorkspaceIds.length, email: targetUser.email },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: null
    });

    await User.findByIdAndDelete(targetId);
    // JWT zmazaného používateľa inak funguje ešte do vypršania auth cache (30 s)
    await invalidateUserCache(targetId);

    const io = req.app.get('io');
    io.to(`user-${targetId}`).emit('user-deleted', { userId: targetId });

    logger.info('User deleted', {
      deletedBy: req.user.id,
      deletedUserId: targetId,
      deletedUserRole: targetUser.role,
      deletedWorkspaces: soleWorkspaceIds.length
    });

    res.json({
      message: 'Užívateľ bol úspešne vymazaný',
      ...(billing.appleActive && { notice: 'Používateľ má aktívne Apple predplatné — zrušiť ho môže len on v App Store.' })
    });
  } catch (error) {
    logger.error('Delete user error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update user role (admin only)
router.put('/users/:userId/role', authenticateToken, async (req, res) => {
  try {
    const { role } = req.body;
    const targetId = req.params.userId;

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ message: 'Neplatné ID používateľa' });
    }

    // Check if current user is admin
    const currentUser = await User.findById(req.user.id).select('role').lean();
    if (!currentUser || currentUser.role !== 'admin') {
      return res.status(403).json({ message: 'Len admin môže meniť role' });
    }

    // Validate role
    if (!['admin', 'manager', 'user'].includes(role)) {
      return res.status(400).json({ message: 'Neplatná rola' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      targetId,
      { role },
      { new: true, projection: { username: 1, email: 1, color: 1, avatar: 1, role: 1 } }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }

    // Nikdy bez admina. Kontrola PO zápise (check-then-act pred zápisom
    // nechal dve súbežné degradácie prejsť) — ak by sme zostali bez admina,
    // zmenu vrátime.
    if (role !== 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount === 0) {
        await User.updateOne({ _id: targetId }, { $set: { role: 'admin' } });
        await invalidateUserCache(targetId);
        return res.status(400).json({ message: 'Nemôže existovať systém bez admina' });
      }
    }

    // Cieľ má inak starú rolu v req.user ešte 30 s (auth cache).
    await invalidateUserCache(targetId);

    // Emit cieľovému používateľovi (predtým išlo do workspace ADMINA).
    const io = req.app.get('io');
    io.to(`user-${targetId}`).emit('user-role-updated', {
      userId: updatedUser._id,
      role: updatedUser.role
    });

    logger.info('User role updated', {
      adminId: req.user.id,
      targetUserId: req.params.userId,
      newRole: role
    });

    res.json({
      id: updatedUser._id,
      username: updatedUser.username,
      email: updatedUser.email,
      color: updatedUser.color,
      avatar: updatedUser.avatar,
      role: updatedUser.role
    });
  } catch (error) {
    logger.error('Update user role error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
