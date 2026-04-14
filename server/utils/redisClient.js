/**
 * Shared Redis client. Used for cross-instance caches (user cache,
 * notification counts, etc.) so horizontal scaling works — otherwise each
 * Node process has its own Map and they drift out of sync.
 *
 * Config:
 *   REDIS_URL   e.g. rediss://default:pass@host:6379  (Upstash, Redis Cloud, ...)
 *
 * Graceful degradation:
 *   If REDIS_URL is not set, `getRedis()` returns null and callers fall back
 *   to an in-process Map. This keeps local dev working without a Redis
 *   server running. **Production MUST set REDIS_URL** if running more than
 *   one instance, otherwise cache coherence is lost.
 */
const Redis = require('ioredis');
const logger = require('./logger');

let client = null;
let initialized = false;

function getRedis() {
  if (initialized) return client;
  initialized = true;

  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('[Redis] REDIS_URL not set in production — multi-instance deployments will have incoherent caches');
    } else {
      logger.info('[Redis] REDIS_URL not set — using in-memory fallback (dev mode)');
    }
    client = null;
    return null;
  }

  try {
    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
      connectTimeout: 5000
    });

    client.on('error', (err) => {
      // Avoid log flood; only log distinct error messages every ~60s
      const now = Date.now();
      if (!client._lastErrLog || now - client._lastErrLog > 60000) {
        logger.warn('[Redis] Connection error', { error: err.message });
        client._lastErrLog = now;
      }
    });
    client.on('connect', () => logger.info('[Redis] Connected'));
    client.on('reconnecting', () => logger.info('[Redis] Reconnecting'));

    return client;
  } catch (err) {
    logger.error('[Redis] Failed to initialize', { error: err.message });
    client = null;
    return null;
  }
}

module.exports = { getRedis };
