/**
 * Auth connections routes — pre Settings page (správa pripojených OAuth
 * accountov + odpojenie + vrátenie zoznamu).
 *
 * Endpointy (všetko vyžaduje JWT auth):
 *   GET    /api/auth/connections                    → { providers: [...], hasPassword: bool }
 *   DELETE /api/auth/connections/:provider          → odpojí provider (s last-method guardom)
 *
 * Disconnect používa oauthService.disconnectProvider, ktorý hodí 400
 * LAST_LOGIN_METHOD ak by pokus odpojil poslednú prihlasovaciu metódu.
 */
const express = require('express');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
const oauthService = require('../services/oauthService');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');

const router = express.Router();

// Vráti aktuálny stav OAuth connectionov pre prihláseného usera.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id, 'authProviders googleId appleId password emailVerified avatarUrl').lean();
    if (!user) {
      return res.status(404).json({ message: 'Používateľ neexistuje' });
    }
    res.json({
      providers: Array.isArray(user.authProviders) ? user.authProviders : [],
      hasGoogle: !!user.googleId,
      hasApple: !!user.appleId,
      hasPassword: !!user.password,
      emailVerified: user.emailVerified === true,
      avatarUrl: user.avatarUrl || null
    });
  } catch (err) {
    logger.error('[auth-connections] list error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.delete('/:provider', authenticateToken, async (req, res) => {
  const { provider } = req.params;
  try {
    const updated = await oauthService.disconnectProvider(req.user.id.toString(), provider);
    auditService.logAction({
      userId: req.user.id.toString(),
      action: 'auth.oauth.disconnect',
      category: 'auth',
      details: { provider },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });
    res.json({
      message: `${provider} účet bol odpojený.`,
      providers: updated.authProviders
    });
  } catch (err) {
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message, code: err.code });
    }
    logger.error('[auth-connections] disconnect error', { error: err.message, provider });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
