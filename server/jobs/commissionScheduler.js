const logger = require('../utils/logger');

/**
 * Commission scheduler — denný job ktorý prepína affiliate commissions zo
 * stavu `pending` (čaká na uplynutie 30-day refund window) do `eligible`
 * (pripravené na vyplácanie).
 *
 * Refund window logika:
 *   Pri vytvorení Commission v billing.js sa nastaví eligibleAfter =
 *   paymentDate + 30 dní. Tento cron prepne všetky commissions kde
 *   eligibleAfter < now a status = 'pending' → status = 'eligible'.
 *
 *   Ak medzitým prišiel Stripe refund webhook (charge.refunded), commission
 *   status bol prepnutý na 'revoked' a tento cron sa ho už netýka.
 *
 * Interval: raz denne (24 hodín). Nemusí to bežať v presnom čase — len
 * raz za deň. Použijeme jednoduchý setInterval na startup-e.
 *
 * Side-effect: po prepnutí na 'eligible' sa updatuje User.affiliate.totalEarnedEur
 * counter (denormalized) — slúži pre rýchly UI dashboard render bez aggregations.
 */

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hodín
const FIRST_RUN_DELAY_MS = 60 * 1000;          // 1 min po server starte

let intervalHandle = null;

const runOnce = async () => {
  try {
    const Commission = require('../models/Commission');
    const User = require('../models/User');

    const now = new Date();

    // Nájdi všetky pending commissions kde eligibleAfter už uplynulo
    const toEligible = await Commission.find({
      status: 'pending',
      eligibleAfter: { $lte: now }
    }).lean();

    if (toEligible.length === 0) {
      logger.debug('[CommissionScheduler] No commissions to promote');
      return;
    }

    // Bulk update na 'eligible'
    const ids = toEligible.map((c) => c._id);
    await Commission.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'eligible' } }
    );

    // Aktualizuj denormalized counter User.affiliate.totalEarnedEur per referrer
    // (sum commissions ktoré sú teraz eligible alebo paid pre konkrétneho usera).
    // Skupujeme commissions podľa referrera + suma.
    const sumByReferrer = new Map();
    for (const c of toEligible) {
      const refId = c.referrerId.toString();
      sumByReferrer.set(refId, (sumByReferrer.get(refId) || 0) + c.commissionAmount);
    }

    for (const [refId, deltaAmount] of sumByReferrer.entries()) {
      await User.findByIdAndUpdate(refId, {
        $inc: { 'affiliate.totalEarnedEur': Math.round(deltaAmount * 100) / 100 }
      });
    }

    logger.info('[CommissionScheduler] Promoted commissions pending → eligible', {
      count: toEligible.length,
      affiliatesAffected: sumByReferrer.size,
      totalAmount: Array.from(sumByReferrer.values()).reduce((a, b) => a + b, 0)
    });
  } catch (err) {
    logger.error('[CommissionScheduler] Run failed', { error: err.message, stack: err.stack });
  }
};

const start = () => {
  if (intervalHandle) return; // už beží
  // Prvý beh o minútu po starte (aby sme nezablokovali boot)
  setTimeout(() => {
    runOnce();
    intervalHandle = setInterval(runOnce, CHECK_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS).unref();
  logger.info('[CommissionScheduler] Scheduled — daily, threshold 30 days refund window');
};

const stop = () => {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
};

module.exports = { start, stop, runOnce };
