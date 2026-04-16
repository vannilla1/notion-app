const crypto = require('crypto');
const ServerError = require('../models/ServerError');
const logger = require('../utils/logger');

/**
 * Paralelný server-side error mirror popri Sentry.
 *
 * Flow:
 *   Express error → errorMiddleware() → recordError() → Mongo upsert
 *                                     → next(err) → sentry.errorHandler
 *
 * Zámerne neblokujeme Sentry — errorMiddleware vždy volá next(err).
 * Ak zápis do Mongo zlyhá, chybu len zalogujeme a pokračujeme.
 *
 * Anti-spam:
 *  - Sampling 1:10 ak z jedného fingerprintu pribudlo > 100 zápisov za minútu
 *    (mohla by byť reálna katastrofa alebo zlý klient v slučke — tak či tak
 *    nechceme 10000 zápisov za minútu)
 */

// In-memory bucket pre rate limit per fingerprint (kľúč: fingerprint, hodnota: { count, windowStart })
const rateWindowMs = 60 * 1000;
const rateThreshold = 100;
const sampleRate = 10; // 1 z 10
const rateBuckets = new Map();

// Občasné čistenie starých buckets (raz za 5 min)
setInterval(() => {
  const cutoff = Date.now() - rateWindowMs * 5;
  for (const [fp, bucket] of rateBuckets.entries()) {
    if (bucket.windowStart < cutoff) rateBuckets.delete(fp);
  }
}, 5 * 60 * 1000).unref?.();

function shouldSample(fingerprint) {
  const now = Date.now();
  let bucket = rateBuckets.get(fingerprint);
  if (!bucket || now - bucket.windowStart > rateWindowMs) {
    bucket = { count: 0, windowStart: now, sampleCounter: 0 };
    rateBuckets.set(fingerprint, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= rateThreshold) return true;
  // Nad threshold — sample 1 z N
  bucket.sampleCounter = (bucket.sampleCounter + 1) % sampleRate;
  return bucket.sampleCounter === 0;
}

/**
 * Normalizuje stack trace aby rovnaké chyby z rôznych lokácií
 * nemali odlišný fingerprint (mení absolútne cesty na relatívne,
 * odstraňuje čísla riadkov ktoré sa menia s každým redeploy-om).
 */
function normalizeStack(stack) {
  if (!stack) return '';
  return stack
    .split('\n')
    .slice(0, 10) // zober len prvých 10 frame-ov
    .map(line => line
      .replace(/\/[^\s:)]+/g, '') // strip absolute paths
      .replace(/:\d+:\d+/g, '') // strip :line:col
      .trim())
    .join('|');
}

/**
 * Normalizuje cestu — /users/6412af... → /users/:id (inak by každý
 * request s iným ID dal iný fingerprint).
 */
function normalizePath(path) {
  if (!path) return '';
  return path
    .replace(/\/[a-f0-9]{24}/gi, '/:id') // Mongo ObjectId
    .replace(/\/\d+/g, '/:id') // číselné ID
    .replace(/\?.*$/, ''); // strip query string
}

function computeFingerprint(err, req) {
  const normStack = normalizeStack(err?.stack || '');
  const method = req?.method || '';
  const path = normalizePath(req?.path || '');
  const name = err?.name || 'Error';
  const input = `${name}::${method}::${path}::${normStack || err?.message || 'unknown'}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Scrub request body — odstráni citlivé polia pred uložením do Mongo.
 * Sentry beforeSend robí to isté, ale tu je vlastná cesta.
 */
function scrubBody(body) {
  if (!body || typeof body !== 'object') return undefined;
  const clone = {};
  const sensitive = ['password', 'currentPassword', 'newPassword', 'token', 'refreshToken', 'accessToken', 'secret', 'creditCard', 'cardNumber', 'cvv'];
  for (const [k, v] of Object.entries(body)) {
    if (sensitive.includes(k)) {
      clone[k] = '[FILTERED]';
    } else if (typeof v === 'string' && v.length > 500) {
      clone[k] = v.slice(0, 500) + '…[truncated]';
    } else if (typeof v === 'object' && v !== null) {
      clone[k] = '[object]'; // nejdeme hlboko
    } else {
      clone[k] = v;
    }
  }
  return clone;
}

async function recordError(err, req) {
  try {
    const fingerprint = computeFingerprint(err, req);
    if (!shouldSample(fingerprint)) return;

    const now = new Date();
    const existing = await ServerError.findOne({ fingerprint });

    if (existing) {
      // Update only aggregation fields
      existing.count += 1;
      existing.lastSeen = now;
      // Ak bola resolved a opäť sa objavila → re-open
      if (existing.resolved) {
        existing.resolved = false;
        existing.resolvedAt = null;
      }
      await existing.save();
    } else {
      const doc = new ServerError({
        fingerprint,
        message: err?.message?.slice(0, 1000) || 'Unknown error',
        stack: err?.stack?.slice(0, 10000) || '',
        name: err?.name || 'Error',
        method: req?.method,
        path: req?.path,
        statusCode: err?.status || err?.statusCode || 500,
        userId: req?.user?.id || null,
        workspaceId: req?.user?.workspaceId || null,
        userAgent: req?.get?.('user-agent')?.slice(0, 500),
        ipAddress: req?.ip || req?.connection?.remoteAddress,
        context: {
          query: req?.query && Object.keys(req.query).length ? req.query : undefined,
          body: scrubBody(req?.body),
          params: req?.params && Object.keys(req.params).length ? req.params : undefined
        },
        firstSeen: now,
        lastSeen: now,
        count: 1
      });
      await doc.save();
    }
  } catch (dbErr) {
    // Watcher sa nesmie sám rozbiť. Len zaloguj a pokračuj.
    logger.error('serverErrorService: failed to record error', {
      recordError: dbErr.message,
      originalError: err?.message
    });
  }
}

/**
 * Express error-handling middleware. Volá recordError pre unhandled 5xx
 * a delegate next(err). MUSÍ mať 4 parametre aby Express rozpoznal že
 * je to error handler.
 */
function errorMiddleware(err, req, res, next) {
  // Len neočakávané chyby (bez status = crash, alebo 5xx)
  const status = err?.status || err?.statusCode;
  if (!status || status >= 500) {
    // Fire and forget — nepočkáme na Mongo aby sme nespozdili response
    recordError(err, req).catch(() => {});
  }
  next(err);
}

module.exports = {
  errorMiddleware,
  recordError,
  // Exports pre testy / manual use
  _computeFingerprint: computeFingerprint,
  _normalizeStack: normalizeStack,
  _normalizePath: normalizePath
};
