const express = require('express');
const router = express.Router();
const User = require('../models/User');
const PromoCode = require('../models/PromoCode');
const Commission = require('../models/Commission');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * Affiliate user-side endpointy — pre samotných affiliateov ktorí sa
 * prihlásia do Prpl CRM. Admin endpointy sú v admin.js (/api/admin/affiliates*).
 *
 * Routes:
 *   GET  /api/affiliate/me              — vlastný dashboard (stats + codes + recent commissions)
 *   PUT  /api/affiliate/payout-info     — update IBAN/banka/poznámka
 *   GET  /api/affiliate/commissions     — vlastné commissions (paginated)
 *
 * Iba enrolled affiliates môžu pristúpiť — kontrola User.affiliate.enrolled.
 * Ne-enrolled user dostane 403 AFFILIATE_NOT_ENROLLED (aby UI mohol zobraziť
 * upozornenie "kontaktuj admina pre prihlásenie do programu").
 */

// Middleware — kontroluje že volajúci je enrolled affiliate
const requireAffiliate = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('affiliate').lean();
    if (!user) return res.status(404).json({ message: 'User nenájdený' });
    if (!user.affiliate?.enrolled || user.affiliate?.status !== 'active') {
      return res.status(403).json({
        message: 'Nie ste prihlásený v affiliate programe. Kontaktujte admina (support@prplcrm.eu).',
        code: 'AFFILIATE_NOT_ENROLLED'
      });
    }
    req.affiliateUser = user;
    next();
  } catch (err) {
    logger.error('[Affiliate Middleware] Error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
};

// GET /api/affiliate/me — vlastný overview
router.get('/me', authenticateToken, requireAffiliate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Stats z Commission collection (authoritative, nie denormalized)
    const { totals, counts } = await Commission.totalsForReferrer(userId);

    // Vlastné kódy (read-only — admin ich vytvára)
    const codes = await PromoCode.find({ referrerId: userId })
      .select('code name type value duration durationInMonths commissionPercent validForPlans validForPeriods maxUses usedCount expiresAt isActive createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // Recent commissions (top 20 pre rýchly náhľad)
    const recentCommissions = await Commission.find({ referrerId: userId })
      .sort({ paymentDate: -1 })
      .limit(20)
      .populate('promoCodeId', 'code')
      .populate('referredUserId', 'username')
      .select('paymentAmount commissionAmount commissionPercent status paymentDate eligibleAfter paidAt plan period')
      .lean();

    res.json({
      affiliate: req.affiliateUser.affiliate,
      totals,
      counts,
      codes,
      recentCommissions
    });
  } catch (err) {
    logger.error('[Affiliate] /me error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// PUT /api/affiliate/payout-info — update bank info
router.put('/payout-info', authenticateToken, requireAffiliate, async (req, res) => {
  try {
    const { payoutIban, payoutBankName, payoutNote } = req.body || {};
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User nenájdený' });
    user.affiliate = user.affiliate || {};
    if (payoutIban !== undefined) {
      // Light IBAN sanity check (SK má 24 znakov bez medzier; všeobecne 15-34
      // alfanumerické). Tu len strip whitespace a validuj dĺžku, plnú IBAN
      // validáciu má banka.
      const clean = String(payoutIban).replace(/\s+/g, '').toUpperCase();
      if (clean && (clean.length < 15 || clean.length > 34 || !/^[A-Z0-9]+$/.test(clean))) {
        return res.status(400).json({ message: 'IBAN formát nesprávny' });
      }
      user.affiliate.payoutIban = clean;
    }
    if (payoutBankName !== undefined) user.affiliate.payoutBankName = String(payoutBankName).trim();
    if (payoutNote !== undefined) user.affiliate.payoutNote = String(payoutNote).trim();
    await user.save();
    res.json({ success: true, affiliate: user.affiliate });
  } catch (err) {
    logger.error('[Affiliate] payout-info update error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/affiliate/commissions — paginated vlastné provízie
router.get('/commissions', authenticateToken, requireAffiliate, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 30));
    const { status } = req.query;

    const q = { referrerId: userId };
    if (status) q.status = status;

    const [commissions, total] = await Promise.all([
      Commission.find(q)
        .sort({ paymentDate: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('promoCodeId', 'code')
        .populate('referredUserId', 'username')
        .lean(),
      Commission.countDocuments(q)
    ]);

    res.json({ commissions, total, page, limit });
  } catch (err) {
    logger.error('[Affiliate] commissions list error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
