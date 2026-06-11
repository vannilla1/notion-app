const auditService = require('./auditService');

/**
 * Throttled security-event logger → durable AuditLog stopa pre post-auth abuse
 * signály (neplatný JWT, cross-workspace IDOR, rate-limit), ktoré predtým
 * končili len v logoch a boli neviditeľné v admin Diagnostike.
 *
 * PREČO THROTTLE: credential stuffing / scraping môže vygenerovať tisíce
 * 401/403/429 za minútu. auditService.logAction je fire-and-forget save bez
 * throttle, takže bez tohto by sa AuditLog nafúkol (512MB Atlas free tier je
 * historicky takmer plný). Logneme max 1 event per (action, IP) za okno —
 * prvý hit stačí ako signál; opakované sú v apiMetrics počítadlách + logoch.
 */
const THROTTLE_MS = 60 * 1000;
const MAX_KEYS = 5000;
const seen = new Map(); // `${action}:${ip}` -> lastLoggedAt (ms)

// Periodické čistenie starých kľúčov, nech mapa nerastie donekonečna.
setInterval(() => {
  const cutoff = Date.now() - THROTTLE_MS;
  for (const [k, ts] of seen.entries()) {
    if (ts < cutoff) seen.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

/**
 * @param {string} action  napr. 'security.token_invalid' | 'security.cross_workspace_denied' | 'security.rate_limited'
 * @param {object} req     Express request
 * @param {object} [details] voliteľný kontext (reason, requestedWsId, limiter…)
 */
function logSecurityEvent(action, req, details) {
  try {
    const ip = req?.ip || req?.connection?.remoteAddress || 'unknown';
    const key = `${action}:${ip}`;
    const now = Date.now();
    const last = seen.get(key);
    if (last && now - last < THROTTLE_MS) return; // throttled — okno ešte beží
    if (seen.size > MAX_KEYS) seen.clear(); // tvrdý cap proti pamäti
    seen.set(key, now);

    auditService.logAction({
      userId: req?.user?.id || null,
      username: req?.user?.username,
      action,
      category: 'security',
      ipAddress: ip,
      userAgent: req?.get?.('user-agent')?.slice(0, 300),
      workspaceId: req?.user?.workspaceId || null,
      details
    });
  } catch {
    // security logger sa nesmie nikdy sám rozbiť / hodiť do request flow
  }
}

module.exports = { logSecurityEvent };
