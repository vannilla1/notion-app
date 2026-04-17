const express = require('express');
const jwt = require('jsonwebtoken');
const { recordClientError } = require('../services/serverErrorService');
const { errorReportLimiter } = require('../middleware/rateLimiter');
const { JWT_SECRET } = require('../middleware/auth');
const User = require('../models/User');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Public endpoint pre client-side chyby.
 *
 * Zámerne BEZ povinnej autentifikácie — potrebujeme zachytiť aj chyby na
 * Login/Register stránke (pred prihlásením). Ak Authorization header je
 * prítomný a validný, obohacujeme záznam o userId/workspaceId; inak sa
 * zapíše len IP/userAgent + payload.
 *
 * Payload (best-effort — všetky polia voliteľné okrem message):
 *   { name, message, stack, componentStack, url, userAgent,
 *     line, column, release }
 */
router.post('/client', errorReportLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.message || typeof body.message !== 'string') {
      return res.status(400).json({ ok: false, reason: 'message-required' });
    }

    // Optional auth — parse token ak je prítomný, nikdy neblokuj
    const context = {
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('user-agent')
    };

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        const user = await User.findById(decoded.id).select('_id').lean();
        if (user) context.userId = user._id;
      } catch {
        // Ignoruj — nevalidný token neznamená že chybu nemáme zaznamenať
      }
    }

    // Fire-and-forget aby sme nespozdili klienta (ten je už v error state)
    recordClientError(body, context).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    logger.error('POST /api/errors/client failed', { error: err.message });
    // Nevracia 500 aby sme nevyvolali ďalší error loop u klienta
    res.status(202).json({ ok: false });
  }
});

module.exports = router;
