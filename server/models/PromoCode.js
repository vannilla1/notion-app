const mongoose = require('mongoose');

const promoCodeSchema = new mongoose.Schema({
  // The actual code users type in (uppercase, alphanumeric)
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    index: true
  },
  // Display name for admin reference
  name: {
    type: String,
    required: true,
    trim: true
  },
  // Discount type
  type: {
    type: String,
    enum: ['percentage', 'fixed', 'freeMonths'],
    required: true
  },
  // Discount value (percentage: 1-100, fixed: € amount, freeMonths: number of months)
  value: {
    type: Number,
    required: true
  },
  // How long the discount applies to the Stripe subscription:
  //   'once'      — only the first invoice (default for backwards compat)
  //   'repeating' — the first `durationInMonths` invoices
  //   'forever'   — every invoice while the subscription is active
  //
  // Pre freeMonths typ má fixný význam 'repeating' s durationInMonths=value,
  // toto pole sa vtedy ignoruje na serveri.
  duration: {
    type: String,
    enum: ['once', 'repeating', 'forever'],
    default: 'once'
  },
  // Required when duration === 'repeating'. Počet fakturačných období,
  // počas ktorých sa zľava uplatní (Stripe interpretuje ako mesiace pre
  // monthly subscription aj pre yearly — "forever" je pre yearly rozumnejšie).
  durationInMonths: {
    type: Number,
    default: null
  },
  // Which plans this code is valid for (empty = all paid plans)
  validForPlans: {
    type: [String],
    enum: ['team', 'pro'],
    default: []
  },
  // Which billing periods this code is valid for (empty = both)
  validForPeriods: {
    type: [String],
    enum: ['monthly', 'yearly'],
    default: []
  },
  // Maximum number of times this code can be used (0 = unlimited)
  maxUses: {
    type: Number,
    default: 0
  },
  // How many times this code has been used
  usedCount: {
    type: Number,
    default: 0
  },
  // Maximum uses per single user (0 = unlimited, typically 1)
  maxUsesPerUser: {
    type: Number,
    default: 1
  },
  // Expiration date (null = no expiration)
  expiresAt: {
    type: Date,
    default: null
  },
  // Whether this code is active
  isActive: {
    type: Boolean,
    default: true
  },
  // Stripe Coupon ID (created when promo code is created)
  stripeCouponId: {
    type: String,
    default: null
  },
  // Stripe Promotion Code ID (allows customers to use code at checkout)
  stripePromotionCodeId: {
    type: String,
    default: null
  },
  // Who created this code
  createdBy: {
    type: String,
    required: true
  },
  // Users who have redeemed this code
  redemptions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    redeemedAt: { type: Date, default: Date.now },
    plan: String,
    period: String
  }]
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      ret.id = ret._id.toString();
      return ret;
    }
  }
});

// Check if code is currently valid
promoCodeSchema.methods.isValid = function() {
  if (!this.isActive) return false;
  if (this.expiresAt && new Date() > this.expiresAt) return false;
  if (this.maxUses > 0 && this.usedCount >= this.maxUses) return false;
  return true;
};

// Check if a specific user can use this code
promoCodeSchema.methods.canBeUsedBy = function(userId) {
  if (!this.isValid()) return false;
  if (this.maxUsesPerUser > 0) {
    const userUses = this.redemptions.filter(r => r.userId.toString() === userId.toString()).length;
    if (userUses >= this.maxUsesPerUser) return false;
  }
  return true;
};

// Check if code is valid for a specific plan and period
promoCodeSchema.methods.isValidForPlan = function(plan, period) {
  if (this.validForPlans.length > 0 && !this.validForPlans.includes(plan)) return false;
  if (this.validForPeriods.length > 0 && !this.validForPeriods.includes(period)) return false;
  return true;
};

// Calculate discounted price
promoCodeSchema.methods.calculateDiscount = function(originalPrice) {
  switch (this.type) {
    case 'percentage':
      return {
        discount: Math.round(originalPrice * (this.value / 100) * 100) / 100,
        finalPrice: Math.round(originalPrice * (1 - this.value / 100) * 100) / 100
      };
    case 'fixed':
      const discount = Math.min(this.value, originalPrice);
      return {
        discount,
        finalPrice: Math.round((originalPrice - discount) * 100) / 100
      };
    case 'freeMonths':
      return {
        discount: 0,
        finalPrice: originalPrice,
        freeMonths: this.value
      };
    default:
      return { discount: 0, finalPrice: originalPrice };
  }
};

module.exports = mongoose.model('PromoCode', promoCodeSchema);
