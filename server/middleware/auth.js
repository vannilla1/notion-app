const jwt = require('jsonwebtoken');
const User = require('../models/User');
const logger = require('../utils/logger');
const { getRedis } = require('../utils/redisClient');

// JWT_SECRET is MANDATORY. No dev fallback, no silent insecure defaults —
// either the operator configures it explicitly (in .env / platform secrets)
// or the server refuses to start. Previously an unset secret in dev silently
// used "dev-only-secret", which is a footgun: the same default could leak
// into a misconfigured staging/prod and accept forged tokens.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  logger.error('FATAL: JWT_SECRET env var is required and must be at least 32 characters');
  // eslint-disable-next-line no-process-exit
  process.exit(1);
}

// Redis-backed user cache (30s TTL). Falls back to an in-process Map when
// REDIS_URL is unset (local dev). In production with multiple instances,
// Redis keeps all processes coherent — otherwise instance A would still
// serve stale user data after instance B mutated the user record.
const USER_CACHE_TTL_SEC = 30;
const KEY = (id) => `user:${id}`;

// In-memory fallback used only when Redis is unavailable.
const memCache = new Map();

const getCachedUser = async (userId) => {
  const redis = getRedis();
  const idStr = String(userId);

  if (redis) {
    try {
      const cached = await redis.get(KEY(idStr));
      if (cached) {
        try { return JSON.parse(cached); } catch { /* fall through on corrupt cache */ }
      }
      const user = await User.findById(idStr).lean();
      if (user) {
        // SET with EX in a single call (atomic) — avoids the race between
        // SET + EXPIRE. setex is the ioredis convenience.
        try {
          await redis.setex(KEY(idStr), USER_CACHE_TTL_SEC, JSON.stringify(user));
        } catch (cacheErr) {
          // Never let cache errors break auth — just log once in a while.
          logger.warn('[Auth] Redis setex failed', { error: cacheErr.message });
        }
      }
      return user;
    } catch (redisErr) {
      // Redis blipped — degrade to DB read (no mem fallback writes to avoid
      // coherence issues once Redis is back).
      logger.warn('[Auth] Redis get failed, bypassing cache', { error: redisErr.message });
      return User.findById(idStr).lean();
    }
  }

  // No Redis configured → in-process fallback (dev single-instance only)
  const entry = memCache.get(idStr);
  if (entry && Date.now() - entry.ts < USER_CACHE_TTL_SEC * 1000) return entry.user;
  const user = await User.findById(idStr).lean();
  if (user) memCache.set(idStr, { user, ts: Date.now() });
  return user;
};

// Explicit invalidation — call after user profile update / delete / role change
// so the next request on any instance fetches fresh data.
const invalidateUserCache = async (userId) => {
  const idStr = String(userId);
  memCache.delete(idStr);
  const redis = getRedis();
  if (redis) {
    try { await redis.del(KEY(idStr)); } catch (err) {
      logger.warn('[Auth] Redis del failed', { error: err.message });
    }
  }
};

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Prístupový token je povinný' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    let user = await getCachedUser(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'Neplatný token' });
    }

    // Lazy plan expiration — when a user's paidUntil has elapsed and the
    // plan isn't backed by an active Stripe subscription, atomically
    // downgrade to 'free' before any limit-checking endpoint sees stale
    // premium state. Pre-check via isExpired() is a pure read so we don't
    // pay a DB write on the 99.99% of requests that don't need it.
    // Lazy require avoids circular import (planExpiration -> auth.invalidateUserCache).
    const { isExpired, expireUserIfNeeded } = require('../services/planExpiration');
    if (isExpired(user)) {
      const downgraded = await expireUserIfNeeded(user._id);
      if (downgraded) {
        // Re-read fresh state. Cache was invalidated inside expireUserIfNeeded,
        // so getCachedUser will hit the DB and re-cache the new (free) state.
        const fresh = await getCachedUser(decoded.id);
        if (fresh) user = fresh;
      }
    }

    req.user = {
      id: user._id,
      username: user.username,
      email: user.email,
      color: user.color,
      avatar: user.avatar,
      role: user.role
    };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Neplatný alebo expirovaný token' });
  }
};

const authenticateSocket = async (socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = await getCachedUser(decoded.id);

    if (!user) {
      return next(new Error('User not found'));
    }

    socket.user = {
      id: user._id,
      username: user.username,
      email: user.email,
      color: user.color,
      role: user.role
    };
    next();
  } catch (err) {
    return next(new Error('Invalid token'));
  }
};

module.exports = { authenticateToken, authenticateSocket, invalidateUserCache, JWT_SECRET };
