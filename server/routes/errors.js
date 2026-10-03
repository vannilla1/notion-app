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

/**
 * CSP violation reporty (report-uri zo statického webu — render.yaml,
 * Content-Security-Policy-Report-Only). Prehliadač posiela
 * `application/csp-report` bez CORS preflightu; globálny express.json ho
 * neparsuje, preto vlastný parser s malým limitom.
 *
 * Ukladá sa ako klientska chyba (Diagnostika) — rovnaký dedup cez
 * fingerprint (direktíva + blokovaný origin), rovnaký strop nových
 * fingerprintov per IP. Slúži na overenie politiky pred jej vynútením.
 */
const cspReportParser = express.json({
  type: ['application/csp-report', 'application/reports+json', 'application/json'],
  limit: '16kb'
});

const originOf = (value) => {
  if (typeof value !== 'string' || !value) return 'unknown';
  try { return new URL(value).origin; } catch { return value.slice(0, 60); }
};

router.post('/csp', errorReportLimiter, cspReportParser, (req, res) => {
  try {
    const raw = req.body?.['csp-report']
      || (Array.isArray(req.body) ? req.body[0]?.body : null)
      || {};
    const directive = String(raw['effective-directive'] || raw.effectiveDirective
      || raw['violated-directive'] || 'unknown').split(' ')[0].slice(0, 60);
    const blocked = originOf(raw['blocked-uri'] || raw.blockedURL);
    const documentUri = String(raw['document-uri'] || raw.documentURL || '').slice(0, 500);
    const sourceFile = String(raw['source-file'] || raw.sourceFile || '').slice(0, 300);
    const line = Number(raw['line-number'] || raw.lineNumber) || undefined;

    recordClientError({
      name: 'CSPViolation',
      message: `CSP ${directive} blocked ${blocked}`,
      url: documentUri,
      // Zdroj ide do componentStack (nefiguruje vo fingerprinte) — jedno
      // porušenie z rôznych riadkov bundla = jeden záznam s count.
      componentStack: sourceFile ? `source: ${sourceFile}:${line || 0}` : '',
      line,
      release: 'csp-report-only'
    }, {
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('user-agent')
    }).catch(() => {});
  } catch (err) {
    logger.warn('POST /api/errors/csp failed', { error: err.message });
  }
  res.status(204).end();
});

module.exports = router;
