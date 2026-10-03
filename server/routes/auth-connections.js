/**
 * Auth connections routes — pre Settings page (správa pripojených OAuth
 * accountov + odpojenie + vrátenie zoznamu).
 *
 * Endpointy (všetko vyžaduje JWT auth):
 *   GET    /api/auth/connections                    → { providers: [...], hasPassword: bool }
 *   POST   /api/auth/connections/complete           → dokončí OAuth prepojenie (pending token z callbacku)
 *   DELETE /api/auth/connections/:provider          → odpojí provider (s last-method guardom;
 *                                                     pri účte s heslom vyžaduje currentPassword)
 *
 * Disconnect používa oauthService.disconnectProvider, ktorý hodí 400
 * LAST_LOGIN_METHOD ak by pokus odpojil poslednú prihlasovaciu metódu.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
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

// Dokončenie OAuth prepojenia. Callback (connect mód) vydal pending token
// s userId zo state a overeným profilom providera; prepojíme LEN ak JWT
// volajúceho patrí rovnakému používateľovi (CSRF ochrana — útočník nevie
// obeti podstrčiť svoju connect URL a pripojiť jej identitu k sebe).
router.post('/complete', authenticateToken, async (req, res) => {
  try {
    const pending = req.body && req.body.pending;
    let data;
    try {
      data = oauthService.verifyConnectPending(pending);
    } catch (err) {
      return res.status(400).json({ message: 'Odkaz na pripojenie je neplatný alebo vypršal. Skús to znova.', code: err.code || 'STATE_INVALID' });
    }
    if (String(req.user.id) !== String(data.userId)) {
      logger.warn('[auth-connections] connect-complete user mismatch', { userId: String(req.user.id) });
      return res.status(403).json({ message: 'Pripojenie bolo spustené z iného účtu.', code: 'STATE_INVALID' });
    }
    const updated = await oauthService.connectProvider(String(req.user.id), data.provider, data.profile);
    auditService.logAction({
      userId: String(req.user.id),
      action: 'auth.oauth.connect',
      category: 'auth',
      details: { provider: data.provider },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });
    res.json({ provider: data.provider, user: oauthService.shapeUserResponse(updated) });
  } catch (err) {
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message, code: err.code });
    }
    logger.error('[auth-connections] complete error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.delete('/:provider', authenticateToken, async (req, res) => {
  const { provider } = req.params;
  try {
    // Re-autentifikácia: odpojenie prihlasovacej metódy je citlivá zmena —
    // ukradnutý JWT by inak stačil na odpojenie hesla/providera obete.
    // Účet s heslom ho musí zadať; OAuth-only účet (bez hesla) nemá čím.
    const current = await User.findById(req.user.id, 'password').lean();
    if (!current) {
      return res.status(404).json({ message: 'Používateľ neexistuje' });
    }
    if (current.password) {
      const pw = req.body && req.body.currentPassword;
      if (typeof pw !== 'string' || !pw || !(await bcrypt.compare(pw, current.password))) {
        return res.status(400).json({ message: 'Pre potvrdenie zadaj správne aktuálne heslo.', code: 'REAUTH_REQUIRED' });
      }
    }
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
