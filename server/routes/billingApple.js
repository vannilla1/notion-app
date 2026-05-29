/**
 * billingApple.js — Apple In-App Purchase endpoints (iOS only).
 *
 * Tri endpointy:
 *   GET  /api/billing/apple/products       — product IDs + plan/period (iOS fetch)
 *   POST /api/billing/apple/verify         — iOS pošle signed transaction po nákupe
 *   POST /api/billing/apple/notifications  — App Store Server Notifications V2 webhook
 *
 * Stripe ostáva pre web + Android (billing.js). Toto je čisto iOS vrstva.
 * Commission/affiliate systém je zatiaľ Stripe-only (Apple nepodporuje naše
 * promo kódy rovnako; Apple Offer Codes sú iný mechanizmus) — Apple nákupy
 * negenerujú províziu.
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const User = require('../models/User');
const appleIap = require('../services/appleIap');
const { APPLE_PRODUCTS, getProductInfo, allProductIds } = require('../config/appleProducts');
const logger = require('../utils/logger');

// ── Helper: aplikuj overenú Apple transakciu na usera ──
//
// Mapuje productId → plan/period a nastaví subscription polia. Spoločné pre
// /verify (priamy nákup) aj notification webhook (renewal/change).
//
// expiresDate je v ms (Apple JWS timestamp). paidUntil = expiresDate.
// Pri downgrade na free (refund/expiry) zavolaj downgradeUserToFree() namiesto tohto.
async function applyTransactionToUser(user, txPayload, environment) {
  const info = getProductInfo(txPayload.productId);
  if (!info) {
    logger.warn('[AppleIAP] Unknown productId, skipping', { productId: txPayload.productId });
    return false;
  }

  // expiresDate môže chýbať pri ne-subscription type — pre nás sú to vždy
  // auto-renewable subscriptions, takže by tam mal byť.
  const paidUntil = txPayload.expiresDate ? new Date(txPayload.expiresDate) : null;

  const sub = user.subscription;
  sub.plan = info.plan;
  sub.source = 'apple';
  sub.billingPeriod = info.period;
  sub.appleOriginalTransactionId = txPayload.originalTransactionId;
  sub.appleProductId = txPayload.productId;
  sub.appleEnvironment = environment;
  sub.paidUntil = paidUntil;
  // Apple renewal status sa rieši cez notifikácie (DID_CHANGE_RENEWAL_STATUS).
  // Pri čerstvom nákupe je auto-renew zapnutý → cancelAtPeriodEnd = false.
  sub.cancelAtPeriodEnd = false;

  await user.save();
  logger.info('[AppleIAP] Applied transaction', {
    userId: user._id.toString(),
    plan: info.plan,
    period: info.period,
    paidUntil,
    environment,
    originalTransactionId: txPayload.originalTransactionId
  });
  return true;
}

// Downgrade na free — refund / expiry / revoke. Zachová stripeCustomerId
// (môže mať aj Stripe históriu), ale zruší Apple subscription state.
async function downgradeUserToFree(user, reason) {
  const sub = user.subscription;
  sub.plan = 'free';
  sub.source = null;
  sub.billingPeriod = null;
  sub.appleProductId = null;
  // appleOriginalTransactionId ZÁMERNE ponechávame — ďalšie notifikácie
  // (napr. neskôr re-subscribe) sa stále viažu na rovnaké original ID a
  // vieme usera nájsť. Vymaže sa len ak by sa účet zmazal.
  sub.paidUntil = null;
  sub.cancelAtPeriodEnd = false;
  await user.save();
  logger.info('[AppleIAP] Downgraded to free', {
    userId: user._id.toString(),
    reason
  });
}

/**
 * GET /api/billing/apple/products
 * Vráti zoznam product IDs + plan/period mapping. iOS appka si potom cez
 * StoreKit fetchne reálne ceny/lokalizáciu pre tieto IDs z App Store.
 */
router.get('/products', authenticateToken, (req, res) => {
  res.json({
    available: appleIap.isAvailable(),
    products: Object.entries(APPLE_PRODUCTS).map(([productId, info]) => ({
      productId,
      plan: info.plan,
      period: info.period
    }))
  });
});

/**
 * POST /api/billing/apple/verify
 * Body: { signedTransaction: "<JWS>" }
 *
 * iOS appka po úspešnom StoreKit nákupe pošle signed transaction. Overíme
 * podpis (Apple root chain), namapujeme na plán a aktivujeme. Idempotentné —
 * opakované volanie s rovnakou transakciou len re-aplikuje rovnaký stav.
 */
router.post('/verify', authenticateToken, async (req, res) => {
  if (!appleIap.isAvailable()) {
    return res.status(503).json({ message: 'Apple IAP nie je nakonfigurované na serveri' });
  }

  const { signedTransaction } = req.body || {};
  if (!signedTransaction || typeof signedTransaction !== 'string') {
    return res.status(400).json({ message: 'Chýba signedTransaction' });
  }

  try {
    const { payload, environment } = await appleIap.verifyTransaction(signedTransaction);

    // Anti-fraud: over že transakcia je pre náš bundle + známy product.
    if (!getProductInfo(payload.productId)) {
      logger.warn('[AppleIAP] /verify unknown product', { productId: payload.productId, userId: req.user.id });
      return res.status(400).json({ message: 'Neznámy produkt' });
    }

    // Anti-hijack: ak je táto originalTransactionId už priradená INÉMU userovi,
    // odmietni (zabráni tomu aby si user "ukradol" cudziu subscription poslaním
    // jej JWS). Apple transaction je viazaná na Apple ID, nie na náš účet, takže
    // first-come-first-served binding + tento check je rozumná ochrana.
    const existing = await User.findOne({
      'subscription.appleOriginalTransactionId': payload.originalTransactionId,
      _id: { $ne: req.user.id }
    }).select('_id');
    if (existing) {
      logger.warn('[AppleIAP] /verify transaction belongs to another user', {
        originalTransactionId: payload.originalTransactionId,
        requestUser: req.user.id,
        ownerUser: existing._id.toString()
      });
      return res.status(409).json({ message: 'Táto transakcia je už priradená inému účtu' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'Používateľ nenájdený' });

    // Ak je expiresDate v minulosti, transakcia je expirovaná — neaktivuj.
    if (payload.expiresDate && payload.expiresDate < Date.now()) {
      logger.info('[AppleIAP] /verify expired transaction', { userId: user._id.toString(), expiresDate: payload.expiresDate });
      return res.status(400).json({ message: 'Transakcia je expirovaná' });
    }

    await applyTransactionToUser(user, payload, environment);

    res.json({
      success: true,
      subscription: {
        plan: user.subscription.plan,
        period: user.subscription.billingPeriod,
        paidUntil: user.subscription.paidUntil,
        source: user.subscription.source
      }
    });
  } catch (err) {
    logger.error('[AppleIAP] /verify error', { error: err.message, userId: req.user?.id });
    res.status(400).json({ message: 'Overenie transakcie zlyhalo' });
  }
});

/**
 * POST /api/billing/apple/notifications
 * App Store Server Notifications V2 webhook. Apple sem posiela JSON
 * { signedPayload: "<JWS>" } pri renewal / cancel / refund / expiry / atď.
 *
 * BEZ authenticateToken — autenticita sa overuje cez JWS podpis (Apple root
 * chain), nie cez náš JWT. Vrátime 200 vždy keď sme správu spracovali (aj keď
 * user nenájdený) aby Apple neretryoval donekonečna; 500 len pri našej chybe.
 */
router.post('/notifications', async (req, res) => {
  if (!appleIap.isAvailable()) {
    logger.warn('[AppleIAP] Notification received but IAP not configured');
    return res.status(503).end();
  }

  const { signedPayload } = req.body || {};
  if (!signedPayload) {
    return res.status(400).json({ message: 'Chýba signedPayload' });
  }

  try {
    const { payload, environment } = await appleIap.verifyNotification(signedPayload);
    const notificationType = payload.notificationType;
    const subtype = payload.subtype;

    logger.info('[AppleIAP] Notification', { notificationType, subtype, environment });

    // Dekóduj vnorené transaction + renewal info
    const decoded = await appleIap.decodeNotificationPayloads(payload.data || {}, environment);
    const tx = decoded.transactionInfo;
    const renewal = decoded.renewalInfo;

    if (!tx) {
      logger.warn('[AppleIAP] Notification without transaction info', { notificationType });
      return res.status(200).end();
    }

    // Nájdi usera podľa stabilného originalTransactionId
    const user = await User.findOne({
      'subscription.appleOriginalTransactionId': tx.originalTransactionId
    });
    if (!user) {
      // Môže nastať pri SUBSCRIBED notifikácii ktorá príde skôr než /verify
      // stihne uložiť usera — Apple retryuje, takže pri ďalšom pokuse už
      // user bude existovať. Logujeme a vrátime 200.
      logger.info('[AppleIAP] No user for notification (may resolve on retry)', {
        notificationType,
        originalTransactionId: tx.originalTransactionId
      });
      return res.status(200).end();
    }

    // ── Notification type routing ──
    switch (notificationType) {
      case 'SUBSCRIBED':
      case 'DID_RENEW':
      case 'OFFER_REDEEMED':
      case 'DID_CHANGE_RENEWAL_PREF': // upgrade/downgrade/crossgrade — nový productId
        // Aktivuj/predĺž podľa aktuálnej transakcie
        await applyTransactionToUser(user, tx, environment);
        break;

      case 'DID_CHANGE_RENEWAL_STATUS':
        // AUTO_RENEW_DISABLED → user zrušil auto-renew (ale plán beží do expiry)
        // AUTO_RENEW_ENABLED → znova zapol
        user.subscription.cancelAtPeriodEnd = (subtype === 'AUTO_RENEW_DISABLED');
        await user.save();
        logger.info('[AppleIAP] Renewal status changed', {
          userId: user._id.toString(),
          cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd
        });
        break;

      case 'EXPIRED':
      case 'GRACE_PERIOD_EXPIRED':
        // Subscription definitívne skončila — downgrade na free
        await downgradeUserToFree(user, `${notificationType}/${subtype}`);
        break;

      case 'REFUND':
      case 'REVOKE':
        // Apple refundoval / Family Sharing revoke → odober prístup
        await downgradeUserToFree(user, `${notificationType}/${subtype}`);
        break;

      case 'DID_FAIL_TO_RENEW':
        // Billing retry beží (grace period). Neděláme nič drastické — ak
        // grace period zlyhá, príde GRACE_PERIOD_EXPIRED. Ak je v grace
        // period s aktívnym prístupom, ponecháme plán.
        logger.info('[AppleIAP] Failed to renew (billing retry / grace)', {
          userId: user._id.toString(),
          subtype
        });
        break;

      default:
        logger.info('[AppleIAP] Unhandled notification type', { notificationType, subtype });
    }

    res.status(200).end();
  } catch (err) {
    logger.error('[AppleIAP] Notification processing error', { error: err.message, stack: err.stack?.substring(0, 300) });
    // 500 → Apple retryuje neskôr (užitočné pri tranzientných chybách)
    res.status(500).json({ message: 'Notification processing failed' });
  }
});

module.exports = router;
