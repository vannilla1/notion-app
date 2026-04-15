const mongoose = require('mongoose');
const User = require('../../models/User');
const PromoCode = require('../../models/PromoCode');

/**
 * PromoCode model testy — billing zľavové kódy (Stripe integrácia).
 *
 * Kľúčové invarianty (viď server/models/PromoCode.js):
 *   - code je unique + uppercase + trim (case-insensitive lookup)
 *   - type enum: percentage | fixed | freeMonths
 *   - validForPlans: team | pro (prázdne pole = všetky)
 *   - validForPeriods: monthly | yearly (prázdne pole = obe)
 *   - Instance methods: isValid(), canBeUsedBy(userId), isValidForPlan(plan, period),
 *     calculateDiscount(originalPrice)
 *   - maxUses=0 → unlimited; maxUsesPerUser=0 → unlimited
 *   - redemptions[] stopuje kto a kedy kód použil
 */
describe('PromoCode model', () => {
  let user;
  let otherUser;

  beforeAll(async () => {
    await User.init();
    await PromoCode.init();
  });

  beforeEach(async () => {
    await PromoCode.deleteMany({});
    await User.deleteMany({});

    user = await User.create({
      username: 'buyer',
      email: 'buyer@test.com',
      password: 'hashedpw'
    });
    otherUser = await User.create({
      username: 'other',
      email: 'other@test.com',
      password: 'hashedpw'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  const basePromo = () => ({
    code: 'SUMMER2026',
    name: 'Summer promo',
    type: 'percentage',
    value: 20,
    createdBy: 'admin@test.com'
  });

  describe('Creation & defaults', () => {
    it('should create a promo code with required fields and defaults', async () => {
      const p = await PromoCode.create(basePromo());

      expect(p._id).toBeDefined();
      expect(p.code).toBe('SUMMER2026');
      expect(p.maxUses).toBe(0); // unlimited
      expect(p.usedCount).toBe(0);
      expect(p.maxUsesPerUser).toBe(1);
      expect(p.isActive).toBe(true);
      expect(p.expiresAt).toBeNull();
      expect(p.validForPlans).toEqual([]);
      expect(p.validForPeriods).toEqual([]);
      expect(p.redemptions).toHaveLength(0);
      expect(p.stripeCouponId).toBeNull();
      expect(p.stripePromotionCodeId).toBeNull();
    });

    it('should uppercase the code automatically', async () => {
      const p = await PromoCode.create({ ...basePromo(), code: 'summer2026' });
      expect(p.code).toBe('SUMMER2026');
    });

    it('should trim whitespace from the code', async () => {
      const p = await PromoCode.create({ ...basePromo(), code: '  TRIMMED  ' });
      expect(p.code).toBe('TRIMMED');
    });

    it('should enforce code as required', async () => {
      const p = basePromo();
      delete p.code;
      await expect(PromoCode.create(p)).rejects.toThrow();
    });

    it('should enforce type as required', async () => {
      const p = basePromo();
      delete p.type;
      await expect(PromoCode.create(p)).rejects.toThrow();
    });

    it('should enforce value as required', async () => {
      const p = basePromo();
      delete p.value;
      await expect(PromoCode.create(p)).rejects.toThrow();
    });

    it('should enforce createdBy as required', async () => {
      const p = basePromo();
      delete p.createdBy;
      await expect(PromoCode.create(p)).rejects.toThrow();
    });

    it('should reject unknown type', async () => {
      await expect(
        PromoCode.create({ ...basePromo(), type: 'lifetime' })
      ).rejects.toThrow();
    });
  });

  describe('Unique code constraint', () => {
    it('should enforce unique code (case-insensitive via uppercase)', async () => {
      await PromoCode.create(basePromo());

      await expect(
        PromoCode.create({ ...basePromo(), code: 'summer2026' }) // auto-uppercased
      ).rejects.toThrow(/duplicate key|E11000/i);
    });
  });

  describe('validForPlans / validForPeriods enums', () => {
    it('should accept team + yearly combination', async () => {
      const p = await PromoCode.create({
        ...basePromo(),
        validForPlans: ['team'],
        validForPeriods: ['yearly']
      });
      expect(p.validForPlans).toEqual(['team']);
      expect(p.validForPeriods).toEqual(['yearly']);
    });

    it('should reject unknown plan', async () => {
      await expect(
        PromoCode.create({ ...basePromo(), validForPlans: ['enterprise'] })
      ).rejects.toThrow();
    });

    it('should reject unknown period', async () => {
      await expect(
        PromoCode.create({ ...basePromo(), validForPeriods: ['weekly'] })
      ).rejects.toThrow();
    });
  });

  describe('isValid() instance method', () => {
    it('should return true for active, unexpired, within-limits code', async () => {
      const p = await PromoCode.create(basePromo());
      expect(p.isValid()).toBe(true);
    });

    it('should return false when isActive=false', async () => {
      const p = await PromoCode.create({ ...basePromo(), isActive: false });
      expect(p.isValid()).toBe(false);
    });

    it('should return false when expiresAt is in the past', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000); // včera
      const p = await PromoCode.create({ ...basePromo(), expiresAt: past });
      expect(p.isValid()).toBe(false);
    });

    it('should return true when expiresAt is in the future', async () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // zajtra
      const p = await PromoCode.create({ ...basePromo(), expiresAt: future });
      expect(p.isValid()).toBe(true);
    });

    it('should return false when maxUses reached', async () => {
      const p = await PromoCode.create({
        ...basePromo(),
        maxUses: 5,
        usedCount: 5
      });
      expect(p.isValid()).toBe(false);
    });

    it('should return true when maxUses=0 (unlimited) regardless of usedCount', async () => {
      const p = await PromoCode.create({
        ...basePromo(),
        maxUses: 0,
        usedCount: 999
      });
      expect(p.isValid()).toBe(true);
    });
  });

  describe('canBeUsedBy() instance method', () => {
    it('should return true for a fresh user', async () => {
      const p = await PromoCode.create(basePromo());
      expect(p.canBeUsedBy(user._id)).toBe(true);
    });

    it('should return false if user already reached maxUsesPerUser', async () => {
      const p = await PromoCode.create({
        ...basePromo(),
        maxUsesPerUser: 1,
        redemptions: [
          { userId: user._id, redeemedAt: new Date(), plan: 'pro', period: 'monthly' }
        ]
      });
      expect(p.canBeUsedBy(user._id)).toBe(false);
      // Iný user ešte môže
      expect(p.canBeUsedBy(otherUser._id)).toBe(true);
    });

    it('should cascade false from isValid() when code is inactive', async () => {
      const p = await PromoCode.create({ ...basePromo(), isActive: false });
      expect(p.canBeUsedBy(user._id)).toBe(false);
    });

    it('should allow multiple uses per user when maxUsesPerUser=0', async () => {
      const p = await PromoCode.create({
        ...basePromo(),
        maxUsesPerUser: 0,
        redemptions: [
          { userId: user._id, redeemedAt: new Date(), plan: 'pro' },
          { userId: user._id, redeemedAt: new Date(), plan: 'team' }
        ]
      });
      expect(p.canBeUsedBy(user._id)).toBe(true);
    });
  });

  describe('isValidForPlan() instance method', () => {
    it('should return true when validForPlans is empty (all plans)', async () => {
      const p = await PromoCode.create(basePromo());
      expect(p.isValidForPlan('team', 'monthly')).toBe(true);
      expect(p.isValidForPlan('pro', 'yearly')).toBe(true);
    });

    it('should return false when plan not in validForPlans', async () => {
      const p = await PromoCode.create({
        ...basePromo(),
        validForPlans: ['pro']
      });
      expect(p.isValidForPlan('team', 'monthly')).toBe(false);
      expect(p.isValidForPlan('pro', 'monthly')).toBe(true);
    });

    it('should return false when period not in validForPeriods', async () => {
      const p = await PromoCode.create({
        ...basePromo(),
        validForPeriods: ['yearly']
      });
      expect(p.isValidForPlan('pro', 'monthly')).toBe(false);
      expect(p.isValidForPlan('pro', 'yearly')).toBe(true);
    });
  });

  describe('calculateDiscount() instance method', () => {
    it('should calculate percentage discount correctly', async () => {
      const p = await PromoCode.create({ ...basePromo(), type: 'percentage', value: 20 });
      const { discount, finalPrice } = p.calculateDiscount(100);
      expect(discount).toBe(20);
      expect(finalPrice).toBe(80);
    });

    it('should round percentage discount to 2 decimals', async () => {
      const p = await PromoCode.create({ ...basePromo(), type: 'percentage', value: 33 });
      const { discount, finalPrice } = p.calculateDiscount(99.99);
      // 99.99 * 0.33 = 32.9967 → 33.00
      expect(discount).toBe(33);
      // 99.99 * 0.67 = 66.9933 → 66.99
      expect(finalPrice).toBe(66.99);
    });

    it('should calculate fixed discount and cap at originalPrice', async () => {
      const p = await PromoCode.create({ ...basePromo(), type: 'fixed', value: 15 });
      const res1 = p.calculateDiscount(50);
      expect(res1.discount).toBe(15);
      expect(res1.finalPrice).toBe(35);

      // Fixed discount > originalPrice → cap at originalPrice
      const res2 = p.calculateDiscount(10);
      expect(res2.discount).toBe(10);
      expect(res2.finalPrice).toBe(0);
    });

    it('should handle freeMonths type without modifying price', async () => {
      const p = await PromoCode.create({ ...basePromo(), type: 'freeMonths', value: 3 });
      const { discount, finalPrice, freeMonths } = p.calculateDiscount(25);
      expect(discount).toBe(0);
      expect(finalPrice).toBe(25);
      expect(freeMonths).toBe(3);
    });
  });

  describe('toJSON transform', () => {
    it('should expose id as string', async () => {
      const p = await PromoCode.create(basePromo());
      const json = p.toJSON();
      expect(json.id).toBe(p._id.toString());
    });
  });
});
