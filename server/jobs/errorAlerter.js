const ServerError = require('../models/ServerError');
const { sendAdminEmail } = require('../services/adminEmailService');
const logger = require('../utils/logger');

/**
 * Error alerting — každú hodinu pozrie koľko NOVÝCH fingerprintov vzniklo
 * za posledných 60 min. Ak > threshold → pošle súhrný email SuperAdminovi.
 *
 * Prečo nie "koľko errorov celkovo": jedna chyba z divokej slučky by
 * spamovala alerty. Nás zaujíma RÔZNORODOSŤ (nový druh chyby po deploy-i =
 * regresia), nie opakovanie toho istého.
 *
 * Prečo email a nie push: alert by mal prekľuchnúť cez poľa (aj keď user
 * zatvoril PWA), push sa stráca mimo appky.
 */

const INTERVAL_MS = 60 * 60 * 1000; // 1h
const LOOKBACK_MS = INTERVAL_MS; // pozri poslednú hodinu
const DEFAULT_THRESHOLD = 10; // > 10 nových fingerprintov / h = alert

async function checkAndAlert(threshold = DEFAULT_THRESHOLD) {
  try {
    const since = new Date(Date.now() - LOOKBACK_MS);

    // Nové fingerprinty = firstSeen v poslednom okne.
    // Toto zámerne vynecháva re-open-ed chyby (lastSeen sa posunie, ale
    // firstSeen zostáva pôvodný) — chceme signalizovať iba NOVÉ druhy chýb.
    const newErrors = await ServerError.find(
      { firstSeen: { $gte: since } },
      { name: 1, message: 1, source: 1, path: 1, count: 1, statusCode: 1 }
    ).sort({ count: -1 }).limit(20).lean();

    if (newErrors.length <= threshold) {
      logger.info('[ErrorAlerter] No alert', { newFingerprints: newErrors.length, threshold });
      return { alerted: false, count: newErrors.length };
    }

    // Zostav HTML — jednoduchá tabuľka, inline styles (väčšina mail klientov
    // ignoruje <style> bloky).
    const rows = newErrors.slice(0, 15).map(e => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">
          <span style="background:${e.source === 'client' ? '#dbeafe' : '#fee2e2'};padding:2px 6px;border-radius:3px;font-size:11px">
            ${e.source}
          </span>
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px">
          ${escapeHtml(e.name || 'Error')}
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">
          ${escapeHtml((e.message || '').slice(0, 120))}
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#64748b;font-size:12px">
          ${escapeHtml(e.path || '—')}
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">
          ${e.count}×
        </td>
      </tr>
    `).join('');

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:640px">
        <h2 style="color:#dc2626;margin-bottom:4px">⚠️ Nový náraz chýb v Prpl CRM</h2>
        <p style="color:#64748b;margin-top:0">
          Za poslednú hodinu pribudlo <strong>${newErrors.length}</strong> nových fingerprintov
          (threshold = ${threshold}). Najčastejšie:
        </p>
        <table style="width:100%;border-collapse:collapse;margin-top:12px">
          <thead>
            <tr style="background:#f8fafc;text-align:left">
              <th style="padding:6px 10px;font-size:12px;color:#475569">Zdroj</th>
              <th style="padding:6px 10px;font-size:12px;color:#475569">Type</th>
              <th style="padding:6px 10px;font-size:12px;color:#475569">Message</th>
              <th style="padding:6px 10px;font-size:12px;color:#475569">Route</th>
              <th style="padding:6px 10px;font-size:12px;color:#475569;text-align:right">Count</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:16px;font-size:13px">
          <a href="https://prplcrm.eu/admin/dashboard"
             style="color:#6366f1;text-decoration:none;font-weight:500">
            → Otvoriť Diagnostics v AdminPanel
          </a>
        </p>
      </div>
    `;

    await sendAdminEmail(`⚠️ ${newErrors.length} nových chýb za 1h`, html);
    logger.warn('[ErrorAlerter] Alert sent', { newFingerprints: newErrors.length, threshold });
    return { alerted: true, count: newErrors.length };
  } catch (err) {
    logger.error('[ErrorAlerter] Check failed', { error: err.message, stack: err.stack });
    return { alerted: false, error: err.message };
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Schedule každú hodinu. Prvé spustenie za 10 min po bootu servera
 * (dá čas stabilne zapnutému procesu).
 */
function scheduleErrorAlerter() {
  // Delay prvého spustenia aby sme neposielali alert hneď po deploy-i
  // (keď sa počas boot-u nahromadili errory z cold cache problémov).
  setTimeout(() => {
    checkAndAlert().catch(() => {});
  }, 10 * 60 * 1000);

  setInterval(() => {
    checkAndAlert().catch(() => {});
  }, INTERVAL_MS);

  logger.info('[ErrorAlerter] Scheduled — every 1h, threshold=' + DEFAULT_THRESHOLD + ' new fingerprints');
}

module.exports = {
  scheduleErrorAlerter,
  checkAndAlert, // exportované pre testy / manual trigger
};
