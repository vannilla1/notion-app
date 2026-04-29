const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const logger = require('../utils/logger');

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
    const email = (req.body?.email || '').toLowerCase().trim();
    return email ? `email:${email}` : `ip:${ipKeyGenerator(req.ip)}`;
  },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: login (per-email)', {
      ip: req.ip,
      email: req.body?.email
    });
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

// Rate limiter for password change
// 3 attempts per hour per user
const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 attempts
  message: {
    message: 'Príliš veľa pokusov o zmenu hesla. Skúste znova neskôr.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: password change', {
      ip: req.ip,
      userId: req.user?.id
    });
    res.status(options.statusCode).json(options.message);
  }
});

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
  skip: (req) => {
    // Skip rate limiting iba pre legitímne file upload/download endpointy
    // (Tasks/Contacts/Messages mountované na /api, takže req.path tu má
    // tvar /<resource>/<id>/files alebo .../files/<fileId>/download).
    // Predtým bol `req.path.includes('/files')` substring match — útočník
    // by vedel obísť limiter na akomkoľvek endpointe ak by URL obsahovala
    // segment `/files` v inom kontexte. Teraz vyžadujeme `/files` ako
    // path segment (pred/za '/' alebo koniec stringu).
    return req.path === '/health' ||
           req.path.startsWith('/uploads/') ||
           req.path === '/uploads' ||
           /\/files(\/|$)/.test(req.path);
  }
});

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
  errorReportLimiter
};
