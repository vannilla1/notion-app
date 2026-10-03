const crypto = require('crypto');
const ServerError = require('../models/ServerError');
const logger = require('../utils/logger');

/**
 * In-house server-side error tracker (nahrada Sentry).
 *
 * Flow:
 *   Express error → errorMiddleware() → recordError() → Mongo upsert
 *                                     → next(err) → finálny error handler
 *
 * Ak zápis do Mongo zlyhá, chybu len zalogujeme a pokračujeme — middleware
 * musí vždy volať next(err), nikdy neblokovať response.
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
    // UUID (úlohy v kontaktoch, fileId príloh) — MUSÍ byť pred číselným
    // pravidlom: to by zjedlo len úvodné číslice („/3f1c…" → „/:idf1c…")
    // a každá úloha by v Diagnostike dostala vlastný riadok s count 1.
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$|\?)/gi, '/:id')
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
 * Fingerprint pre client-side chyby — nemáme Express req, kombinujeme
 * normalized stack + normalized URL pathname + error name. Prefix 'client::'
 * aby sa nikdy nekolidoval so server fingerprintom pre rovnakú message.
 */
function computeClientFingerprint({ name, message, stack, url }) {
  const normStack = normalizeStack(stack || '');
  const urlPath = normalizePath((() => {
    try { return new URL(url || '').pathname; } catch { return url || ''; }
  })());
  const input = `client::${name || 'Error'}::${urlPath}::${normStack || message || 'unknown'}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Scrub request body — odstráni citlivé polia pred uložením do Mongo.
 */
function scrubBody(body) {
  if (!body || typeof body !== 'object') return undefined;
  const clone = {};
  // customName / originalName = používateľom napísaný názov prílohy (môže
  // niesť meno klienta, číslo faktúry…) — do Diagnostiky nepatrí.
  // code / state = OAuth callback parametre (prichádzajú v query),
  // signedPayload = Apple App Store Server Notification JWS.
  const sensitive = ['password', 'currentPassword', 'newPassword', 'token', 'refreshToken', 'accessToken', 'secret', 'creditCard', 'cardNumber', 'cvv', 'customName', 'originalName', 'code', 'state', 'signedPayload'];
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

/**
 * extraContext (voliteľné) — doplnkové polia do `context` NOVÉHO záznamu,
 * napr. { upload: { multerCode, contentLength, … } } pri odmietnutom
 * nahrávaní. Nesmie niesť tokeny, heslá ani obsah súborov. Existujúci
 * záznam (rovnaký fingerprint) len zvýši count — context sa neprepisuje.
 */
async function recordError(err, req, extraContext) {
  try {
    const fingerprint = computeFingerprint(err, req);
    if (!shouldSample(fingerprint)) return;

    const now = new Date();

    // Atomický update agregačných polí ($inc) namiesto findOne → save:
    // pri súbežných výskytoch (hromadný 5xx po výpadku externej služby) sa
    // paralelné `count += 1; save()` navzájom prepisovali a count
    // podhodnocoval. Ak bola resolved a opäť sa objavila → re-open
    // (admin pri unresolve tiež nastavuje resolvedAt: null).
    const updated = await ServerError.findOneAndUpdate(
      { fingerprint },
      { $inc: { count: 1 }, $set: { lastSeen: now, resolved: false, resolvedAt: null } },
      { new: true }
    );
    if (updated) return;

    const doc = new ServerError({
      fingerprint,
      message: err?.message?.slice(0, 1000) || 'Unknown error',
      stack: err?.stack?.slice(0, 10000) || '',
      name: err?.name || 'Error',
      method: req?.method,
      path: req?.path,
      statusCode: err?.status || err?.statusCode || 500,
      userId: req?.user?.id || null,
      // req.user workspaceId nemá — správne pole je req.workspaceId
      // (middleware/workspace.js); inak bol každý záznam workspaceId: null.
      workspaceId: req?.workspaceId || req?.workspace?._id || null,
      userAgent: req?.get?.('user-agent')?.slice(0, 500),
      ipAddress: req?.ip || req?.connection?.remoteAddress,
      context: {
        // Scrub aj query a params, nielen body — napr. emailUnsubscribe berie
        // token z req.query; pri 5xx by sa inak uložil na 90 dní do Mongo
        // a zobrazil v admin Diagnostike.
        query: req?.query && Object.keys(req.query).length ? scrubBody(req.query) : undefined,
        body: scrubBody(req?.body),
        params: req?.params && Object.keys(req.params).length ? scrubBody(req.params) : undefined,
        ...(extraContext && typeof extraContext === 'object' ? extraContext : {})
      },
      firstSeen: now,
      lastSeen: now,
      count: 1
    });
    try {
      await doc.save();
    } catch (saveErr) {
      // Dva súbežné PRVÉ výskyty: oba prešli findOneAndUpdate ako null,
      // druhý insert padne na unique fingerprint (E11000). Namiesto
      // zahodenia výskytu ho pripočítame k práve vloženému záznamu.
      if (saveErr?.code !== 11000) throw saveErr;
      await ServerError.updateOne(
        { fingerprint },
        { $inc: { count: 1 }, $set: { lastSeen: now } }
      );
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
    // Marker pre captureResponseErrors finish-hook — tento request už má
    // recordnutý SKUTOČNÝ error (so stackom), nech ho hook nezdvojí synteticky.
    if (res?.locals) res.locals.__errorRecorded = true;
  }
  next(err);
}

// Boot okno — počas prvých 30s po štarte ignorujeme 503 (DB ešte connectuje,
// readiness middleware vracia 503 — nie je to aplikačná chyba). Zhodné s
// apiMetrics STARTUP_GRACE.
const CAPTURE_BOOT_TIME = Date.now();
const CAPTURE_STARTUP_GRACE_MS = 30 * 1000;

/**
 * Finish-hook middleware — zachytí KAŽDÚ 5xx odpoveď, ktorú handler poslal
 * PRIAMO cez res.status(5xx) bez next(err).
 *
 * PREČO: v celej appke nikto nevolá next(err) — všetkých ~245 catch blokov
 * robí res.status(500).json(...) priamo. errorMiddleware (ktorý plní ServerError)
 * sa preto nikdy nespustí a reálne 500-tky boli NEVIDITEĽNÉ v Diagnostike →
 * admin videl falošné "takmer žiadne chyby". Tento hook to rieši plošne.
 *
 * Limit: nemáme pôvodný Error objekt (handler ho odchytil lokálne), takže
 * stack chýba — ale route + status + frekvencia (cez fingerprint dedup podľa
 * method+path) je hlavný signál "čo a kde zlyháva". Pre kritické cesty
 * (billing webhooky) voláme recordError explicitne so stackom samostatne.
 */
function captureResponseErrors(req, res, next) {
  res.on('finish', () => {
    const status = res.statusCode;
    if (status < 500) return;
    // Startup 503 = boot artifact, nie chyba.
    if (status === 503 && Date.now() - CAPTURE_BOOT_TIME < CAPTURE_STARTUP_GRACE_MS) return;
    // DB readiness 503 = krátky reconnect blip (replica set failover, sieťový
    // výpadok) MIMO štartu. Appka sa zachovala správne — degradovala a klient
    // request zopakuje. Dlhší výpadok si middleware ohlási sám cez logger.error,
    // takže tu ho už netreba duplikovať do Diagnostiky.
    if (status === 503 && res.locals && res.locals.__dbNotReady) return;
    // Už recordnuté so skutočným stackom cez errorMiddleware → nezdvojuj.
    if (res.locals && res.locals.__errorRecorded) return;
    const err = new Error(`HTTP ${status} ${req.method} ${req.originalUrl || req.url}`);
    err.name = 'UnhandledServerResponse';
    err.status = status;
    recordError(err, req).catch(() => {});
  });
  next();
}

/**
 * Record chyby reportovanej z browsera (ErrorBoundary, window.onerror,
 * unhandledrejection). Rovnaký anti-spam mechanizmus ako pre server chyby
 * (per-fingerprint sampling), rovnaký dedup cez fingerprint.
 *
 * payload: { name, message, stack, componentStack, url, userAgent,
 *            line, column }
 * context: { userId, workspaceId, ipAddress } — voliteľne z autentifikácie
 */
async function recordClientError(payload, context = {}) {
  try {
    const fingerprint = computeClientFingerprint(payload);
    if (!shouldSample(fingerprint)) return null;

    const now = new Date();
    const existing = await ServerError.findOne({ fingerprint });

    // Verzia appky z tohto výskytu (natívny shell posiela payload.release).
    // Normalizujeme na krátky string; prázdne = web bez verzie → 'web'.
    const release = (typeof payload.release === 'string' && payload.release.trim())
      ? payload.release.trim().slice(0, 40)
      : 'web';

    // Agregačná vetva pre existujúci záznam. Ostáva findOne + save (nie
    // atomický $inc) kvôli kľúčom releaseCounts s bodkami ("1.2.3"), ktoré
    // by $inc interpretoval ako vnorenú cestu; používa sa aj pri E11000
    // retry nižšie.
    const bumpExisting = async (doc) => {
      doc.count += 1;
      doc.lastSeen = now;
      // Per-release rozpad + posledná videná verzia — kľúčové, aby panel vedel
      // rozlíšiť "prší na opravenej verzii" od "dokvapkávajú staré buildy".
      doc.lastRelease = release;
      if (!doc.firstRelease) doc.firstRelease = release; // backfill starých
      const counts = (doc.releaseCounts && typeof doc.releaseCounts === 'object')
        ? doc.releaseCounts : {};
      counts[release] = (counts[release] || 0) + 1;
      doc.releaseCounts = counts;
      doc.markModified('releaseCounts'); // Mixed — inak sa zmena neuloží
      // Ak bola resolved a opäť sa objavila → re-open
      if (doc.resolved) {
        doc.resolved = false;
        doc.resolvedAt = null;
      }
      await doc.save();
      return doc;
    };

    if (existing) {
      return await bumpExisting(existing);
    }

    // Z URL urob path pre UI ("Route" stĺpec)
    let urlPath = '';
    try { urlPath = new URL(payload.url || '').pathname; } catch { urlPath = payload.url || ''; }

    // Breadcrumbs — najviac 30 posledných udalostí pred chybou (navigation,
     // fetch, clicks, console.warn/error). Scrubneme dlhé stringy a cap-neme
     // počet — defenzívne, payload môže byť zmanipulovaný klientom.
    let breadcrumbs;
    if (Array.isArray(payload.breadcrumbs)) {
      breadcrumbs = payload.breadcrumbs.slice(-30).map(b => ({
        ts: typeof b?.ts === 'number' ? b.ts : Date.now(),
        category: typeof b?.category === 'string' ? b.category.slice(0, 40) : 'unknown',
        level: typeof b?.level === 'string' ? b.level.slice(0, 20) : 'info',
        message: typeof b?.message === 'string' ? b.message.slice(0, 300) : undefined
      }));
    }

    const doc = new ServerError({
      fingerprint,
      source: 'client',
      message: (payload.message || 'Unknown client error').slice(0, 1000),
      stack: (payload.stack || '').slice(0, 10000),
      name: payload.name || 'Error',
      method: 'GET',
      path: urlPath.slice(0, 500),
      statusCode: 0,
      componentStack: (payload.componentStack || '').slice(0, 5000) || undefined,
      url: (payload.url || '').slice(0, 500) || undefined,
      userId: context.userId || null,
      workspaceId: context.workspaceId || null,
      userAgent: (payload.userAgent || context.userAgent || '').slice(0, 500),
      ipAddress: context.ipAddress,
      context: {
        line: payload.line,
        column: payload.column,
        release: payload.release, // napr. git SHA z buildu ak posielaš
        breadcrumbs
      },
      firstRelease: release,
      lastRelease: release,
      releaseCounts: { [release]: 1 },
      firstSeen: now,
      lastSeen: now,
      count: 1
    });
    try {
      await doc.save();
      return doc;
    } catch (saveErr) {
      // Dva súbežné PRVÉ výskyty: oba prešli findOne ako null, druhý insert
      // padne na unique fingerprint (E11000) → pripočítaj k vloženému záznamu.
      if (saveErr?.code !== 11000) throw saveErr;
      const raced = await ServerError.findOne({ fingerprint });
      return raced ? await bumpExisting(raced) : null;
    }
  } catch (dbErr) {
    logger.error('serverErrorService: failed to record client error', {
      recordError: dbErr.message,
      originalError: payload?.message
    });
    return null;
  }
}

module.exports = {
  errorMiddleware,
  captureResponseErrors,
  recordError,
  recordClientError,
  // Exports pre testy / manual use
  _computeFingerprint: computeFingerprint,
  _computeClientFingerprint: computeClientFingerprint,
  _normalizeStack: normalizeStack,
  _normalizePath: normalizePath
};
