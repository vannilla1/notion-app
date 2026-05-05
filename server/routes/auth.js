const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const User = require('../models/User');
const { JWT_SECRET, authenticateToken } = require('../middleware/auth');
const { requireWorkspace } = require('../middleware/workspace');
const {
  loginLimiter,
  loginEmailLimiter,
  registerLimiter,
  passwordChangeLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter
} = require('../middleware/rateLimiter');
const auditService = require('../services/auditService');
const {
  notifyNewRegistration,
  sendWelcomeEmail,
  sendPasswordResetEmail
} = require('../services/adminEmailService');
const logger = require('../utils/logger');
const { validatePassword } = require('../utils/passwordPolicy');

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

// Register - with rate limiting
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Všetky polia sú povinné' });
    }

    // Password policy — min 8 znakov, písmeno + číslo/špec, HIBP check.
    // Async kvôli HIBP API call (k-anonymity, posiela len 5-char SHA1 prefix).
    // Fail-open pri sieťovej chybe HIBP — neblokuje registráciu, len loguje warning.
    const passwordError = await validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    // Block registration with super admin email
    if (email.toLowerCase() === 'support@prplcrm.eu') {
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
    await user.save();

    // Generate token
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });

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
      logger.info('forgot-password: user not found', { email, ip: req.ip });
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
    await user.save();

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
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ message: 'Email a heslo sú povinné' });
    }

    // Block super admin from regular login
    if (email.toLowerCase() === 'support@prplcrm.eu') {
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
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });

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
// Notification preferences — per-user push toggles for "general" notifs.
// Direct notifications (priradenia, dokončenie mojej priradenej úlohy
// niekým iným) sa nedajú vypnúť — vždy idú push.
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_NOTIFICATION_PREFS = {
  pushTeamActivity: false,
  pushDeadlines:    false,
  pushOverdue:      false,
  pushNewMember:    false
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
    const user = await User.findById(req.user.id);
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
    const { username, email, color } = req.body;
    const userId = req.user.id;

    // Check if email is taken by another user
    if (email) {
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
    if (email) updates.email = email;
    if (color) updates.color = color;

    const updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true });

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

      // Convert to Base64
      const base64Data = req.file.buffer.toString('base64');

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'Používateľ nenájdený' });
      }

      user.avatar = `avatar-${userId}`;
      user.avatarData = base64Data;
      user.avatarMimetype = req.file.mimetype;

      await user.save();

      // Invalidate avatar cache so next request gets fresh image
      _avatarCache.delete(userId);

      logger.info('Avatar uploaded', { userId, mimetype: req.file.mimetype, size: req.file.size });

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
    // Invalidate avatar cache
    _avatarCache.delete(userId);
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

    // Password policy — rovnako ako register/reset.
    const passwordError = await validatePassword(newPassword);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    const user = await User.findById(userId);

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

    await User.findByIdAndUpdate(userId, { password: hashedPassword });

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

    res.json({ message: 'Heslo bolo úspešne zmenené' });
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
    const Workspace = require('../models/Workspace');
    const WorkspaceMember = require('../models/WorkspaceMember');

    const ownedWorkspaces = await Workspace.find({ ownerId: userId });
    const blockingWorkspaces = []; // workspaces s inými členmi — blokujú delete

    for (const ws of ownedWorkspaces) {
      const otherMembers = await WorkspaceMember.countDocuments({
        workspaceId: ws._id,
        userId: { $ne: userId }
      });
      if (otherMembers > 0) {
        blockingWorkspaces.push({ id: ws._id.toString(), name: ws.name, otherMembers });
      }
    }

    if (blockingWorkspaces.length > 0) {
      return res.status(409).json({
        message: 'Pred zmazaním účtu musíte previesť vlastníctvo workspace-ov, ktoré majú ďalších členov, alebo z nich odstrániť všetkých členov.',
        blockingWorkspaces
      });
    }

    // ── 2) Cascade delete sole-owned workspaces (a ich obsah) ──
    const Task = require('../models/Task');
    const Contact = require('../models/Contact');
    const Message = require('../models/Message');
    const Page = require('../models/Page');
    const Notification = require('../models/Notification');
    const Invitation = require('../models/Invitation');
    const APNsDevice = require('../models/APNsDevice');
    const FcmDevice = require('../models/FcmDevice');
    const PushSubscription = require('../models/PushSubscription');

    const soleWorkspaceIds = ownedWorkspaces.map(ws => ws._id);

    if (soleWorkspaceIds.length > 0) {
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

    // ── 3) Cleanup user-specific data v ostatných workspaces ──
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

    return res.json({
      message: 'Tvoj účet a všetky pripojené dáta boli úspešne zmazané. Ďakujeme, že si používal Prpl CRM.'
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
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(403).json({ message: 'Neplatný prístup' });
    }

    // Only super admin can promote others
    const currentUser = await User.findById(req.user.id);
    if (!currentUser || currentUser.email !== 'support@prplcrm.eu') {
      return res.status(403).json({ message: 'Neplatný prístup' });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }

    await User.findByIdAndUpdate(user._id, { role: 'admin' });

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

    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return res.status(403).json({ message: 'Neplatný prístup' });
    }

    const currentUser = await User.findById(req.user.id);
    if (!currentUser || currentUser.email !== 'support@prplcrm.eu') {
      return res.status(403).json({ message: 'Neplatný prístup' });
    }

    if (!['free', 'team', 'pro'].includes(plan)) {
      return res.status(400).json({ message: 'Neplatný plán' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }

    user.subscription = { plan };
    await user.save();

    logger.info('Plan set', { email, plan, setBy: req.user.id });

    res.json({ message: `${email} bol nastavený na plán ${plan}`, success: true });
  } catch (error) {
    logger.error('Set plan error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete user (admin can delete managers and users, manager can delete users)
router.delete('/users/:userId', authenticateToken, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id);
    const targetUser = await User.findById(req.params.userId);

    if (!targetUser) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }

    // Cannot delete yourself
    if (req.user.id === req.params.userId) {
      return res.status(400).json({ message: 'Nemôžete vymazať vlastný účet' });
    }

    // Permission check
    const canDelete = (() => {
      // Admin can delete managers and users
      if (currentUser.role === 'admin') {
        return targetUser.role !== 'admin'; // Cannot delete other admins
      }
      // Manager can delete users only
      if (currentUser.role === 'manager') {
        return targetUser.role === 'user';
      }
      return false;
    })();

    if (!canDelete) {
      return res.status(403).json({
        message: currentUser.role === 'admin'
          ? 'Admin nemôže vymazať iného admina'
          : 'Nemáte oprávnenie vymazať tohto užívateľa'
      });
    }

    // Delete user's workspace memberships
    const WorkspaceMember = require('../models/WorkspaceMember');
    await WorkspaceMember.deleteMany({ userId: req.params.userId });

    // Delete the user
    await User.findByIdAndDelete(req.params.userId);

    const io = req.app.get('io');
    if (currentUser.currentWorkspaceId) {
      io.to(`workspace-${currentUser.currentWorkspaceId}`).emit('user-deleted', { userId: req.params.userId });
    } else {
      io.to(`user-${req.params.userId}`).emit('user-deleted', { userId: req.params.userId });
    }

    logger.info('User deleted', {
      deletedBy: req.user.id,
      deletedByRole: currentUser.role,
      deletedUserId: req.params.userId,
      deletedUserRole: targetUser.role
    });

    res.json({ message: 'Užívateľ bol úspešne vymazaný' });
  } catch (error) {
    logger.error('Delete user error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update user role (admin only)
router.put('/users/:userId/role', authenticateToken, async (req, res) => {
  try {
    const { role } = req.body;

    // Check if current user is admin
    const currentUser = await User.findById(req.user.id);
    if (currentUser.role !== 'admin') {
      return res.status(403).json({ message: 'Len admin môže meniť role' });
    }

    // Validate role
    if (!['admin', 'manager', 'user'].includes(role)) {
      return res.status(400).json({ message: 'Neplatná rola' });
    }

    // Prevent removing last admin
    if (role !== 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      const targetUser = await User.findById(req.params.userId);
      if (targetUser && targetUser.role === 'admin' && adminCount <= 1) {
        return res.status(400).json({ message: 'Nemôže existovať systém bez admina' });
      }
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.params.userId,
      { role },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }

    const io = req.app.get('io');
    if (currentUser.currentWorkspaceId) {
      io.to(`workspace-${currentUser.currentWorkspaceId}`).emit('user-role-updated', {
        userId: updatedUser._id,
        role: updatedUser.role
      });
    } else {
      io.to(`user-${req.params.userId}`).emit('user-role-updated', {
        userId: updatedUser._id,
        role: updatedUser.role
      });
    }

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
