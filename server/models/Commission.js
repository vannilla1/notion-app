const mongoose = require('mongoose');

/**
 * Commission — záznam o provízii pre affiliateho z konkrétnej Stripe platby.
 *
 * Vytvorenie:
 *   Stripe webhook `invoice.payment_succeeded` → ak je subscription pod
 *   promo kódom ktorého `referrerId` != null, vznikne nový Commission doc.
 *   RECURRING: každá platba (mesačná renewal) generuje samostatný Commission
 *   row. User explicitne potvrdil tento model 2026-05-19.
 *
 * Životný cyklus:
 *   `pending`  — platba prebehla, ale ešte je v refund window (30 dní).
 *                Provízia sa NEsmie vyplatiť — môže byť revoked refundom.
 *   `eligible` — refund window uplynul, provízia môže ísť do bank prevodu.
 *                Daily cron `commissionScheduler` posúva pending→eligible.
 *   `paid`     — admin označil ako vyplatené (po manuálnom bank prevode).
 *                paidAt + paidReference (číslo transakcie) povinné.
 *   `revoked`  — Stripe refund webhook (`charge.refunded`) nastáva pred
 *                eligibleAfter dátumom. Provízia sa neaktivuje.
 *
 * Idempotency:
 *   stripeInvoiceId má UNIQUE index — zabraňuje vytvoreniu 2 commission
 *   rowov pre rovnakú platbu pri webhook retry-och (Stripe občas pošle
 *   ten istý event 2× kvôli network glitchom).
 *
 * Min payout threshold:
 *   20 EUR. Backend bulk-pay endpoint filtruje commissions s
 *   sum(eligible.commissionAmount) >= 20 pre konkrétneho affiliateho.
 *   User rozhodnutie 2026-05-19.
 */
const commissionSchema = new mongoose.Schema({
  // Foreign keys
  promoCodeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PromoCode',
    required: true,
    index: true
  },
  referrerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  referredUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Stripe link — idempotency key proti duplicate commission per invoice
  stripeInvoiceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  stripeSubscriptionId: {
    type: String,
    default: null
  },

  // Sumy v EUR (po Stripe currency conversion ak treba — typicky vždy EUR
  // pre slovenský Stripe account)
  paymentAmount: {
    type: Number,
    required: true
  },
  commissionAmount: {
    type: Number,
    required: true
  },
  commissionPercent: {
    type: Number,
    required: true
  },

  // Lifecycle status
  status: {
    type: String,
    enum: ['pending', 'eligible', 'paid', 'revoked'],
    default: 'pending',
    index: true
  },

  // Dates
  paymentDate: {
    type: Date,
    required: true
  },
  eligibleAfter: {
    type: Date,
    required: true,
    index: true
  },
  paidAt: {
    type: Date,
    default: null
  },

  // Payout tracking (manual bank transfer)
  paidMethod: {
    type: String,
    enum: ['bank', 'stripe', 'paypal', null],
    default: null
  },
  paidReference: {
    type: String,
    default: null  // bank transaction ID / Stripe transfer ID
  },
  notes: {
    type: String,
    default: ''
  },

  // Plan info (snapshot pri vzniku — neskoršie plan changes nemajú vplyv)
  plan: { type: String, default: null },
  period: { type: String, default: null }
}, {
  timestamps: true
});

// Compound index pre admin dashboard query
// "Eligible commissions per referrer sorted by date"
commissionSchema.index({ referrerId: 1, status: 1, eligibleAfter: 1 });

// Static helper: aggregate sum pre konkrétneho referrera podľa statusu
commissionSchema.statics.totalsForReferrer = async function(referrerId) {
  const pipeline = [
    { $match: { referrerId: new mongoose.Types.ObjectId(referrerId) } },
    { $group: { _id: '$status', total: { $sum: '$commissionAmount' }, count: { $sum: 1 } } }
  ];
  const results = await this.aggregate(pipeline);
  const totals = { pending: 0, eligible: 0, paid: 0, revoked: 0 };
  const counts = { pending: 0, eligible: 0, paid: 0, revoked: 0 };
  for (const r of results) {
    totals[r._id] = Math.round(r.total * 100) / 100;
    counts[r._id] = r.count;
  }
  return { totals, counts };
};

module.exports = mongoose.model('Commission', commissionSchema);
