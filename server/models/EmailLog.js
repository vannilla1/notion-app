const mongoose = require('mongoose');

/**
 * EmailLog — záznam o každom maile odoslanom systémom.
 *
 * Volá sa centrálne z `subscriptionEmailService.sendAndLog()` a z legacy
 * volaní v `adminEmailService` (welcome / invitation / password reset /
 * admin notify). Každý záznam obsahuje plnú kópiu HTML body — admin v
 * super admin paneli si vie zobraziť presne čo user dostal (debug pre
 * support, transparentnosť pre audity).
 *
 * Status logika:
 *  - sent     → nodemailer resolve, mail odišiel cez SMTP
 *  - failed   → nodemailer reject (s `error` field)
 *  - skipped_cooldown → pokus zablokovaný 24h frequency cap
 *  - skipped_optout   → user má vypnuté marketingEmails (len pre marketing typy)
 *  - skipped_no_smtp  → SMTP nie je nakonfigurované (dev / misconfig)
 *
 * Retention: zatiaľ neobmedzené. Ak by sa kolekcia zväčšila > 100k záznamov,
 * pridáme TTL index (90 dní) cez { sentAt: 1 } a expireAfterSeconds.
 */
const emailLogSchema = new mongoose.Schema({
  // Recipient — môže byť null pre system maily (notifyError → support@)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  toEmail: { type: String, required: true, index: true },

  // Email category — drives filtering in admin UI a allowed list pre
  // manual triggers. Nové typy treba pridať aj do client filter dropdown.
  type: {
    type: String,
    required: true,
    index: true,
    enum: [
      // Transactional (subscription)
      'subscription_assigned',
      'discount_assigned',
      'expired',
      'welcome_pro',
      // Marketing (reminders, winback)
      'reminder_t7',
      'reminder_t1',
      'winback',
      // Other transactional (existing flows)
      'welcome',
      'invitation',
      'password_reset',
      // Admin / system
      'admin_notify'
    ]
  },

  subject: { type: String, default: null },
  fromAddress: { type: String, default: null },

  status: {
    type: String,
    required: true,
    enum: ['sent', 'failed', 'skipped_cooldown', 'skipped_optout', 'skipped_no_smtp'],
    index: true
  },

  // Error message (only for status=failed)
  error: { type: String, default: null },

  // Snapshot of the rendered HTML — admin preview shows this. Limited
  // implicitly by Mongo doc size (16 MB) which is way more than any email.
  htmlSnapshot: { type: String, default: null },

  // Optional: subscription/discount context at send time. Helpful for
  // post-mortem ("which plan did the reminder reference?").
  context: {
    plan: { type: String, default: null },
    paidUntil: { type: Date, default: null },
    discountType: { type: String, default: null },
    discountValue: { type: Number, default: null },
    promoCode: { type: String, default: null }
  },

  // Was this triggered by a human admin (for audit clarity)?
  triggeredBy: {
    type: String, // 'system' | 'cron' | 'admin:<username>'
    default: 'system'
  },

  sentAt: { type: Date, default: Date.now, index: true }
}, {
  // Disable Mongoose auto __v — we never increment this doc after insert.
  versionKey: false
});

// Compound index pre admin filter (type + sentAt DESC)
emailLogSchema.index({ type: 1, sentAt: -1 });
// Compound pre per-user view (userId + sentAt DESC)
emailLogSchema.index({ userId: 1, sentAt: -1 });

module.exports = mongoose.model('EmailLog', emailLogSchema);
