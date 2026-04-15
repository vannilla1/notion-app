const { createTestApp, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const PromoCode = require('../../models/PromoCode');

/**
 * /api/billing route testy — Stripe integration + promo code validation.
 *
 * Stripe je mockované aby testy nezavolali skutočné Stripe API.
 * Zameranie:
 *   - /status: vráti plan + billingPeriod (fallback na 'free')
 *   - /plans: verejný endpoint, vráti 3 plány s limitmi
 *   - /checkout: 400 pri neznámom plane/period, 503 ak Stripe nie je konfigurovaný
 *   - /validate-promo: lookup podľa uppercase code, isValid/canBeUsedBy/isValidForPlan checks
 */

// Mock Stripe — žiadne reálne API volania
jest.mock('stripe', () => {
  return jest.fn(() => ({
    subscriptions: {
      retrieve: jest.fn().mockResolvedValue({
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        cancel_at_period_end: false
      })
    },
    billingPortal: {
      sessions: {
        create: jest.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal-mock' })
      }
    },
    customers: {
      create: jest.fn().mockResolvedValue({ id: 'cus_test_123' })
    },
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          id: 'cs_test_456',
          url: 'https://checkout.stripe.com/pay-mock'
        }),
        retrieve: jest.fn().mockResolvedValue({ payment_status: 'paid' })
      }
    },
    webhooks: {
      constructEvent: jest.fn()
    }
  }));
});

describe('/api/billing route', () => {
  let app;
  let user;
  let token;

  beforeAll(async () => {
    await User.init();
    await PromoCode.init();
    // Billing route potrebuje Stripe price IDs — nastavíme dummy env vars
    process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_monthly_mock';
    process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_yearly_mock';
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_mock';
    process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_yearly_mock';
    // isStripeConfigured() vyžaduje obe — bez toho endpointy vracajú 503
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy_mock';
    process.env.CORS_ORIGIN = 'http://localhost:3000';

    // Require AŽ TERAZ — aby billing.js načítal price env vars
    const billingRouter = require('../../routes/billing');
    ({ app } = createTestApp('/api/billing', billingRouter));
  });

  beforeEach(async () => {
    await PromoCode.deleteMany({});
    await User.deleteMany({});

    user = await User.create({
      username: 'buyer',
      email: 'buyer@test.com',
      password: 'hashed',
      subscription: { plan: 'free' }
    });
    token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('GET /plans (verejný)', () => {
    it('vráti 3 plány bez auth requirement', async () => {
      const res = await request(app).get('/api/billing/plans');
      expect(res.status).toBe(200);
      expect(res.body.plans).toHaveLength(3);
      const ids = res.body.plans.map(p => p.id);
      expect(ids).toEqual(['free', 'team', 'pro']);
    });

    it('Free plán limits: 5 kontaktov, 10 projektov, 2 členovia', async () => {
      const res = await request(app).get('/api/billing/plans');
      const free = res.body.plans.find(p => p.id === 'free');
      expect(free.limits.contacts).toBe(5);
      expect(free.limits.projectsPerContact).toBe(10);
      expect(free.limits.members).toBe(2);
    });

    it('Pro plán má unlimited limity (-1)', async () => {
      const res = await request(app).get('/api/billing/plans');
      const pro = res.body.plans.find(p => p.id === 'pro');
      expect(pro.limits.contacts).toBe(-1);
      expect(pro.limits.members).toBe(-1);
    });
  });

  describe('GET /status', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/billing/status');
      expect(res.status).toBe(401);
    });

    it('vráti plan="free" pre čerstvého usera', async () => {
      const res = await request(app)
        .get('/api/billing/status')
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe('free');
      expect(res.body.hasStripeCustomer).toBe(false);
      expect(res.body.hasSubscription).toBe(false);
    });

    it('vráti info zo subscription objektu', async () => {
      user.subscription = {
        plan: 'team',
        billingPeriod: 'monthly',
        stripeCustomerId: 'cus_existing'
      };
      await user.save();

      const res = await request(app)
        .get('/api/billing/status')
        .set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe('team');
      expect(res.body.billingPeriod).toBe('monthly');
      expect(res.body.hasStripeCustomer).toBe(true);
    });
  });

  describe('POST /checkout', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app)
        .post('/api/billing/checkout')
        .send({ plan: 'team', period: 'monthly' });
      expect(res.status).toBe(401);
    });

    it('400 pri neznámom plane', async () => {
      const res = await request(app)
        .post('/api/billing/checkout')
        .set(authHeader(token))
        .send({ plan: 'enterprise', period: 'monthly' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/plán/i);
    });

    it('400 pri neznámom period', async () => {
      const res = await request(app)
        .post('/api/billing/checkout')
        .set(authHeader(token))
        .send({ plan: 'team', period: 'weekly' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/obdobie/i);
    });

    it('vráti checkout URL pre nového usera (team monthly)', async () => {
      const res = await request(app)
        .post('/api/billing/checkout')
        .set(authHeader(token))
        .send({ plan: 'team', period: 'monthly' });
      expect(res.status).toBe(200);
      expect(res.body.url).toContain('checkout.stripe.com');
    });

    it('existujúca subscription → redirect na billing portal', async () => {
      user.subscription = {
        plan: 'team',
        stripeCustomerId: 'cus_existing',
        stripeSubscriptionId: 'sub_active_123'
      };
      await user.save();

      const res = await request(app)
        .post('/api/billing/checkout')
        .set(authHeader(token))
        .send({ plan: 'pro', period: 'monthly' });

      expect(res.status).toBe(200);
      expect(res.body.type).toBe('portal');
      expect(res.body.url).toContain('billing.stripe.com');
    });
  });

  describe('POST /validate-promo', () => {
    beforeEach(async () => {
      await PromoCode.create({
        code: 'SUMMER20',
        name: 'Summer Sale',
        type: 'percentage',
        value: 20,
        validForPlans: ['team', 'pro'],
        validForPeriods: ['monthly', 'yearly'],
        active: true,
        createdBy: user._id
      });
    });

    it('400 bez code', async () => {
      const res = await request(app)
        .post('/api/billing/validate-promo')
        .set(authHeader(token))
        .send({});
      expect(res.status).toBe(400);
    });

    it('404 pri neznámom kóde', async () => {
      const res = await request(app)
        .post('/api/billing/validate-promo')
        .set(authHeader(token))
        .send({ code: 'DOESNOTEXIST' });
      expect(res.status).toBe(404);
    });

    it('auto-uppercase: "summer20" nájde "SUMMER20"', async () => {
      const res = await request(app)
        .post('/api/billing/validate-promo')
        .set(authHeader(token))
        .send({ code: 'summer20' });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.code).toBe('SUMMER20');
    });

    it('vráti discountPreview pre team a pro', async () => {
      const res = await request(app)
        .post('/api/billing/validate-promo')
        .set(authHeader(token))
        .send({ code: 'SUMMER20' });
      expect(res.status).toBe(200);
      expect(res.body.discountPreview.team).toBeDefined();
      expect(res.body.discountPreview.pro).toBeDefined();
    });

    it('400 ak expirovaný', async () => {
      await PromoCode.findOneAndUpdate(
        { code: 'SUMMER20' },
        { expiresAt: new Date(Date.now() - 86400000) }  // včera
      );

      const res = await request(app)
        .post('/api/billing/validate-promo')
        .set(authHeader(token))
        .send({ code: 'SUMMER20' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/expir/i);
    });

    it('400 ak už vyčerpaný (maxUses dosiahnutý)', async () => {
      await PromoCode.findOneAndUpdate(
        { code: 'SUMMER20' },
        { maxUses: 5, usedCount: 5 }
      );

      const res = await request(app)
        .post('/api/billing/validate-promo')
        .set(authHeader(token))
        .send({ code: 'SUMMER20' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/vyčerpan/i);
    });

    it('400 ak user už použil promo code (maxUsesPerUser=1)', async () => {
      // PromoCode model používa `redemptions` array, nie `usedByUsers`
      await PromoCode.findOneAndUpdate(
        { code: 'SUMMER20' },
        { maxUsesPerUser: 1, redemptions: [{ userId: user._id, usedAt: new Date() }] }
      );

      const res = await request(app)
        .post('/api/billing/validate-promo')
        .set(authHeader(token))
        .send({ code: 'SUMMER20' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/už použili/);
    });

    it('400 pri pláne ktorý promo kod nepodporuje', async () => {
      await PromoCode.findOneAndUpdate(
        { code: 'SUMMER20' },
        { validForPlans: ['pro'] }  // len pro
      );

      const res = await request(app)
        .post('/api/billing/validate-promo')
        .set(authHeader(token))
        .send({ code: 'SUMMER20', plan: 'team', period: 'monthly' });
      expect(res.status).toBe(400);
    });
  });
});
