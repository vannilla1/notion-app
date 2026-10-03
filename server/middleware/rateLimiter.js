const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const logger = require('../utils/logger');
const { logSecurityEvent } = require('../services/securityAudit');

// ─────────────────────────────────────────────────────────────────────────
// Trust proxy konfigurácia
//
// `app.set('trust proxy', 1)` v index.js → Express si pre `req.ip` berie
// posledný (najpravejší) IP z X-Forwarded-For chainu, čo je Render load
// balancer. Klient X-Forwarded-For nemôže spoofovať, lebo proxy ho prepíše
// (insertne svoju ako poslednú).
//
// Predtým bol na rate limiteroch `validate: { xForwardedForHeader: false,
// trustProxy: false }` — tieto flagy LEN potláčali startup warningy
// express-rate-limit, nemenili behavior. Po overení že trust proxy=1 je
// Render-correct (jediný hop pred app), validate overrides odstránené.
// ─────────────────────────────────────────────────────────────────────────

// Skip rate limit pre dev mode (musí matchnúť explicitnú env premennú).
const skipInDev = (req) => {
  return process.env.NODE_ENV === 'development' && process.env.SKIP_RATE_LIMIT === 'true';
};

// Rate limiter for login attempts — per-IP layer
// 10 attempts per 15 minutes per IP
// Defense-in-depth: kombinuje sa s loginEmailLimiter (per-email) v auth.js
// route handleri. Útočník musí prejsť obidvomi limitermi:
//   - Per-IP zastaví single-IP brute force
//   - Per-email zastaví distribuovaný útok zo 100 IP na 1 účet
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts (higher due to cold-start retries)
  message: {
    message: 'Príliš veľa pokusov o prihlásenie. Skúste znova o 15 minút.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: login (per-IP)', {
      ip: req.ip,
      email: req.body?.email
    });
    logSecurityEvent('security.rate_limited', req, { limiter: 'login_ip' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// Per-email login limiter — defense proti distribuovanému brute force.
// 5 pokusov za 15 min per email, bez ohľadu na IP. Útočník s rotujúcou
// IP môže obísť per-IP limiter, ale nie tento — kľúčom je email.
//
// Pozor na enumeration: kľúč generujeme z lowercased trimmed email-u.
// Ak útočník odpošle ten istý email s rôznym casing-om, doje to na ten
// istý counter — nedá sa to obísť.
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    message: 'Príliš veľa pokusov o prihlásenie pre tento účet. Skúste znova o 15 minút.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // keyGenerator dostane req → vrátime email ako primary key.
  // Ak email chýba (malformed request), spadneme na req.ip — neobíde to limit.
  // ipKeyGenerator je helper z express-rate-limit ktorý správne handluje IPv6
  // (zoskupí adresy v rovnakej /64 podsieti, aby útočník nemohol obísť limit
  // jednoduchou rotáciou suffixu IPv6 adresy v /64 ktoré má pridelené ISP).
  keyGenerator: (req) => {
    // Email musí byť string — pri `{"email": {"$gt": ""}}`, poli alebo čísle
    // (NoSQL-injection probe / chybný klient) by `.toLowerCase` hodil
    // TypeError, express-rate-limit ho pošle do next(err) a klient dostane
    // 500 namiesto 400 z validácie v route. Nestring → IP fallback.
    const raw = req.body?.email;
    const email = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
    return email ? `email:${email}` : `ip:${ipKeyGenerator(req.ip)}`;
  },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: login (per-email)', {
      ip: req.ip,
      email: req.body?.email
    });
    logSecurityEvent('security.rate_limited', req, { limiter: 'login_email' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// Rate limiter for registration
// 3 registrations per hour per IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 registrations
  message: {
    message: 'Príliš veľa registrácií z tejto IP adresy. Skúste znova neskôr.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: registration', {
      ip: req.ip,
      email: req.body?.email
    });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// Kľúč pre limitery za authenticateToken: per používateľ (nie per IP —
// za jednou NAT/CGNAT IP sú celé firmy a mobilní operátori), bez prihlásenia
// fallback na IP (IPv6 zoskupené do /64).
const userOrIpKey = (req) => (req.user?.id ? `user:${String(req.user.id)}` : `ip:${ipKeyGenerator(req.ip)}`);

// Rate limiter for password change
// 3 attempts per hour per user (beží za authenticateToken → req.user existuje)
const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 attempts
  message: {
    message: 'Príliš veľa pokusov o zmenu hesla. Skúste znova neskôr.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: password change', {
      ip: req.ip,
      userId: req.user?.id
    });
    logSecurityEvent('security.rate_limited', req, { limiter: 'password_change' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// Pripojenie do workspace cez kód pozvánky — brute-force ochrana kódov.
// 10 pokusov / 15 min per používateľ (+ samostatne per IP nižšie).
const joinWorkspaceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    message: 'Príliš veľa pokusov o pripojenie. Skúste znova o 15 minút.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: workspace join', { ip: req.ip, userId: req.user?.id });
    logSecurityEvent('security.rate_limited', req, { limiter: 'workspace_join' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// Súborové endpointy (upload/download/rename/delete príloh) — štedrejší
// limit než apiLimiter (galéria/preview načíta veľa súborov naraz), ale
// nie úplne bez limitu ako predtým.
const filesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: {
    message: 'Príliš veľa požiadaviek na súbory. Skúste znova o chvíľu.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logSecurityEvent('security.rate_limited', req, { limiter: 'files' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// /files ako path segment (pred/za '/' alebo koniec) — nie substring.
const isFilesPath = (path) => /\/files(\/|$)/.test(path);

// Rate limiter for "Forgot password" requests.
// 5 per hour per IP (balance: user zabudne, ale útočník nemôže spamovať).
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: {
    message: 'Príliš veľa žiadostí o obnovenie hesla. Skúste znova o hodinu.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: forgot-password', {
      ip: req.ip,
      email: req.body?.email
    });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// Rate limiter for password reset confirmation (POST /reset-password).
// 10 per hour per IP — vyššia tolerancia lebo user môže mistype nové heslo.
const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: {
    message: 'Príliš veľa pokusov. Skúste znova o hodinu.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: reset-password', { ip: req.ip });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// General API rate limiter
// 100 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests
  message: {
    message: 'Príliš veľa požiadaviek. Skúste znova o chvíľu.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Predtým apiLimiter NEMAL handler → general API 429 (scraping / DoS) boli
  // úplne neviditeľné (ani v logoch). Throttled durable security stopa.
  handler: (req, res, next, options) => {
    logSecurityEvent('security.rate_limited', req, { limiter: 'api_general' });
    res.status(options.statusCode).json(options.message);
  },
  // Súborové endpointy (req.path relatívne k /api, napr.
  // /tasks/<id>/files/<fileId>/download) majú vlastný filesLimiter —
  // apiLimiter ich preskočí, aby galéria príloh nevyčerpala bežný limit.
  // (/health a /uploads sú mimo /api, preto tu podmienky nie sú.)
  skip: (req) => skipInDev(req) || isFilesPath(req.path)
});

// Mount pre /api: súborové cesty → filesLimiter, ostatné → apiLimiter.
const apiAndFilesLimiter = (req, res, next) =>
  (isFilesPath(req.path) ? filesLimiter : apiLimiter)(req, res, next);

// Rate limiter for client error reporting
// 60 per minute per IP — dostatočne štedré aby ErrorBoundary + window.onerror
// + unhandledrejection mohli paralelne reportovať, ale tesne blokuje infinite
// render loopy (tie by mali byť dedup-nuté v reportError.js aj tak).
const errorReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { message: 'Too many error reports' },
  standardHeaders: false,
  legacyHeaders: false,
  skip: skipInDev
});

// Rate limiter pre super admin login. Prísnejší než loginLimiter, lebo
// admin endpoint je single-account a strata kompromituje celý systém
// (všetci users, billing, audit logs). 5 pokusov / 30 minút je v praxi
// neprekročiteľný limit pre legitimného admina (vie heslo) a brutálne
// obmedzí brute-force tempo na ~240 pokusov/deň zo single IP.
const adminLoginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 minutes
  max: 5,
  message: {
    message: 'Príliš veľa pokusov o admin prihlásenie. Skúste znova o 30 minút.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: admin login', {
      ip: req.ip,
      email: req.body?.email
    });
    logSecurityEvent('security.rate_limited', req, { limiter: 'admin_login' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// Obnova prihlásenia z Block Store (Android zero-tap sign-in). Verejné
// endpointy chránené len tokenom → 10 pokusov / 15 min / IP.
const restoreLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    message: 'Príliš veľa pokusov o obnovu prihlásenia. Skúste znova o 15 minút.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: restore', { ip: req.ip });
    logSecurityEvent('security.rate_limited', req, { limiter: 'restore' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

// Vydanie obnovovacieho tokenu (autentifikované) — 20 / hod / IP.
const restoreTokenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: {
    message: 'Príliš veľa požiadaviek. Skúste znova o hodinu.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: restore token issue', { ip: req.ip });
    logSecurityEvent('security.rate_limited', req, { limiter: 'restore_token' });
    res.status(options.statusCode).json(options.message);
  },
  skip: skipInDev
});

module.exports = {
  loginLimiter,
  loginEmailLimiter,
  adminLoginLimiter,
  registerLimiter,
  passwordChangeLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  apiLimiter,
  filesLimiter,
  apiAndFilesLimiter,
  joinWorkspaceLimiter,
  errorReportLimiter,
  restoreLimiter,
  restoreTokenLimiter
};
