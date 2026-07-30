const ServerError = require('../models/ServerError');
const { sendAdminEmail } = require('../services/adminEmailService');
const logger = require('../utils/logger');

/**
 * Error alerting — každú hodinu vyhodnotí dve nezávislé podmienky a pri
 * ktorejkoľvek pošle súhrnný email SuperAdminovi (ADMIN_EMAIL):
 *
 *  1. NOVÉ DRUHY chýb: > NEW_THRESHOLD nových fingerprintov za hodinu.
 *     Nový druh chyby po deployi = regresia. Zámerne cez firstSeen, takže
 *     re-opened chyby (posunutý lastSeen, pôvodný firstSeen) sa nerátajú.
 *
 *  2. NÁRAST VÝSKYTOV: celkový počet výskytov (suma `count` naprieč
 *     fingerprintmi) narástol od minulého behu o > SPIKE_THRESHOLD.
 *     Pokrýva scenár, ktorý podmienka 1 nevidí: JEDNA známa chyba začne
 *     po deployi padať stovky ráz za hodinu (0 nových fingerprintov).
 *     Baseline žije v pamäti procesu — po reštarte servera prvý beh len
 *     založí baseline a spike nevyhodnocuje (deploy tak sám o sebe alert
 *     nespustí). TTL mazanie starých dokumentov môže sumu znížiť —
 *     záporná delta sa berie ako 0 a baseline sa preloží nižšie.
 *
 * Prečo email a nie push: alert má prekĺznuť aj keď je appka zavretá;
 * push sa mimo appky stráca.
 */

const INTERVAL_MS = 60 * 60 * 1000; // 1h
const LOOKBACK_MS = INTERVAL_MS; // pozri poslednú hodinu

// Prahy sa dajú prestaviť bez deployu kódu cez env (Render dashboard).
const NEW_THRESHOLD = parseInt(process.env.ERROR_ALERT_THRESHOLD, 10) || 10;
const SPIKE_THRESHOLD = parseInt(process.env.ERROR_ALERT_SPIKE_THRESHOLD, 10) || 100;

// Baseline pre spike detekciu — { total, docCount } z minulého behu.
// null = ešte nebol beh (po boote) → prvý beh len založí baseline.
let occurrenceBaseline = null;

/** Suma všetkých výskytov + počet dokumentov (jeden aggregate roundtrip). */
async function readOccurrenceTotals() {
  const agg = await ServerError.aggregate([
    { $group: { _id: null, total: { $sum: '$count' }, docCount: { $sum: 1 } } }
  ]);
  return agg[0] ? { total: agg[0].total, docCount: agg[0].docCount } : { total: 0, docCount: 0 };
}

async function checkAndAlert(threshold = NEW_THRESHOLD, spikeThreshold = SPIKE_THRESHOLD) {
  try {
    const since = new Date(Date.now() - LOOKBACK_MS);

    // ── Podmienka 1: nové fingerprinty za poslednú hodinu ──
    // countDocuments zvlášť — limit(20) na liste by pri väčšom náraze
    // skreslil vykazovaný počet (visel by na "20").
    const newCount = await ServerError.countDocuments({ firstSeen: { $gte: since } });
    const newErrors = newCount > 0
      ? await ServerError.find(
          { firstSeen: { $gte: since } },
          { name: 1, message: 1, source: 1, path: 1, count: 1, statusCode: 1 }
        ).sort({ count: -1 }).limit(15).lean()
      : [];

    // ── Podmienka 2: nárast celkových výskytov od minulého behu ──
    const totals = await readOccurrenceTotals();
    let spikeDelta = null; // null = baseline ešte nebola (prvý beh po boote)
    if (occurrenceBaseline !== null) {
      spikeDelta = Math.max(0, totals.total - occurrenceBaseline.total);
    }
    occurrenceBaseline = totals;

    const newTripped = newCount > threshold;
    const spikeTripped = spikeDelta !== null && spikeDelta > spikeThreshold;

    if (!newTripped && !spikeTripped) {
      logger.info('[ErrorAlerter] No alert', {
        newFingerprints: newCount, threshold,
        occurrenceDelta: spikeDelta, spikeThreshold
      });
      return { alerted: false, newCount, spikeDelta };
    }

    // Pri spike-u bez nových fingerprintov ukáž, ČO prší — chyby aktívne
    // v poslednej hodine (lastSeen), zoradené podľa kumulatívneho count.
    const activeErrors = (spikeTripped && newErrors.length === 0)
      ? await ServerError.find(
          { lastSeen: { $gte: since } },
          { name: 1, message: 1, source: 1, path: 1, count: 1, statusCode: 1 }
        ).sort({ count: -1 }).limit(15).lean()
      : [];

    const listed = newErrors.length > 0 ? newErrors : activeErrors;
    const listLabel = newErrors.length > 0 ? 'Nové chyby' : 'Aktívne chyby (posledná hodina)';

    // Jednoduchá tabuľka s inline styles — väčšina mail klientov ignoruje
    // <style> bloky.
    const rows = listed.map(e => `
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

    const reasons = [];
    if (newTripped) {
      reasons.push(`<strong>${newCount}</strong> nových druhov chýb (limit ${threshold})`);
    }
    if (spikeTripped) {
      reasons.push(`<strong>+${spikeDelta}</strong> výskytov spolu (limit ${spikeThreshold})`);
    }

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:640px">
        <h2 style="color:#dc2626;margin-bottom:4px">⚠️ Nový náraz chýb v Prpl CRM</h2>
        <p style="color:#64748b;margin-top:0">
          Za poslednú hodinu: ${reasons.join(' a ')}.
        </p>
        <p style="color:#475569;font-size:13px;margin:12px 0 0">${listLabel}:</p>
        <table style="width:100%;border-collapse:collapse;margin-top:6px">
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

    const subjectParts = [];
    if (newTripped) subjectParts.push(`${newCount} nových chýb`);
    if (spikeTripped) subjectParts.push(`+${spikeDelta} výskytov`);
    await sendAdminEmail(`⚠️ ${subjectParts.join(', ')} za 1h`, html);
    logger.warn('[ErrorAlerter] Alert sent', {
      newFingerprints: newCount, threshold,
      occurrenceDelta: spikeDelta, spikeThreshold
    });
    return { alerted: true, newCount, spikeDelta };
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
 * Schedule každú hodinu. Prvé spustenie za 10 min po boote servera —
 * založí spike baseline a nechá procesu čas na stabilizáciu (errory
 * z cold-cache boot problémov nespustia alert hneď po deployi).
 */
function scheduleErrorAlerter() {
  setTimeout(() => {
    checkAndAlert().catch(() => {});
  }, 10 * 60 * 1000);

  setInterval(() => {
    checkAndAlert().catch(() => {});
  }, INTERVAL_MS);

  logger.info(`[ErrorAlerter] Scheduled — every 1h, new>${NEW_THRESHOLD} fingerprints alebo +${SPIKE_THRESHOLD} výskytov`);
}

module.exports = {
  scheduleErrorAlerter,
  checkAndAlert, // exportované pre testy / manual trigger
};
