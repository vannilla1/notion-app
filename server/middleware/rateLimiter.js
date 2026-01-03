const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

// Rate limiter for login attempts
// 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: {
    message: 'Príliš veľa pokusov o prihlásenie. Skúste znova o 15 minút.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, trustProxy: false },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: login', {
      ip: req.ip,
      email: req.body?.email
    });
    res.status(options.statusCode).json(options.message);
  },
  skip: (req) => {
    return process.env.NODE_ENV === 'development' && process.env.SKIP_RATE_LIMIT === 'true';
  }
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
  validate: { xForwardedForHeader: false, trustProxy: false },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: registration', {
      ip: req.ip,
      email: req.body?.email
    });
    res.status(options.statusCode).json(options.message);
  },
  skip: (req) => {
    return process.env.NODE_ENV === 'development' && process.env.SKIP_RATE_LIMIT === 'true';
  }
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
  validate: { xForwardedForHeader: false, trustProxy: false },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded: password change', {
      ip: req.ip,
      userId: req.user?.id
    });
    res.status(options.statusCode).json(options.message);
  }
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
  validate: { xForwardedForHeader: false, trustProxy: false },
  skip: (req) => {
    return req.path === '/health' || req.path.startsWith('/uploads');
  }
});

module.exports = {
  loginLimiter,
  registerLimiter,
  passwordChangeLimiter,
  apiLimiter
};
