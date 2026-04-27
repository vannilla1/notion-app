const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' });
const User = require('../models/User');
const PromoCode = require('../models/PromoCode');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

// ===== Plan prices (for discount calculations) =====
const PLAN_DISPLAY_PRICES = {
  team: { monthly: 4.99, yearly: 49.00 },
  pro: { monthly: 9.99, yearly: 99.00 }
};

// ===== Plan ↔ Price mapping =====

const PLAN_PRICES = {
  team: {
    monthly: process.env.STRIPE_PRICE_TEAM_MONTHLY,
    yearly: process.env.STRIPE_PRICE_TEAM_YEARLY
  },
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
    yearly: process.env.STRIPE_PRICE_PRO_YEARLY
  }
};

// Reverse lookup: priceId → plan name
const getPlanByPriceId = (priceId) => {
  for (const [plan, prices] of Object.entries(PLAN_PRICES)) {
    if (prices.monthly === priceId || prices.yearly === priceId) {
      return plan;
    }
  }
  return null;
};

const getBillingPeriod = (priceId) => {
  for (const prices of Object.values(PLAN_PRICES)) {
    if (prices.monthly === priceId) return 'monthly';
    if (prices.yearly === priceId) return 'yearly';
  }
  return null;
};

// ===== Helper: get or create Stripe customer =====

const getOrCreateCustomer = async (user) => {
  if (user.subscription?.stripeCustomerId) {
    return user.subscription.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.username,
    metadata: { userId: user._id.toString() }
  });

  user.subscription = user.subscription || {};
  user.subscription.stripeCustomerId = customer.id;
  await user.save();

  return customer.id;
};

// ===== Check if Stripe is configured =====

const isStripeConfigured = () => {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);
};

// ===== Routes =====

// Get billing status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ message: 'Billing not configured' });
    }

    const user = await User.findById(req.user.id);
    const sub = user.subscription || {};

    const result = {
      plan: sub.plan || 'free',
      billingPeriod: sub.billingPeriod || null,
      paidUntil: sub.paidUntil || null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd || false,
      hasStripeCustomer: !!sub.stripeCustomerId,
      hasSubscription: !!sub.stripeSubscriptionId
    };

    // If active Stripe subscription, fetch latest info
    if (sub.stripeSubscriptionId) {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
        result.stripeStatus = stripeSub.status;
        result.currentPeriodEnd = new Date(stripeSub.current_period_end * 1000);
        result.cancelAtPeriodEnd = stripeSub.cancel_at_period_end;
      } catch (err) {
        logger.warn('[Billing] Failed to fetch Stripe subscription', {
          error: err.message,
          subscriptionId: sub.stripeSubscriptionId
        });
      }
    }

    res.json(result);
  } catch (error) {
    logger.error('[Billing] Status error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get available plans and prices
router.get('/plans', (req, res) => {
  res.json({
    plans: [
      {
        id: 'free',
        name: 'Free',
        price: { monthly: 0, yearly: 0 },
        limits: { contacts: 5, projectsPerContact: 10, members: 2, workspaces: 1 }
      },
      {
        id: 'team',
        name: 'Tim',
        price: { monthly: 4.99, yearly: 49.00 },
        limits: { contacts: 25, projectsPerContact: 25, members: 10, workspaces: 2 },
        stripePrices: PLAN_PRICES.team
      },
      {
        id: 'pro',
        name: 'Pro',
        price: { monthly: 9.99, yearly: 99.00 },
        limits: { contacts: -1, projectsPerContact: -1, members: -1, workspaces: -1 },
        stripePrices: PLAN_PRICES.pro
      }
    ],
    stripeConfigured: isStripeConfigured()
  });
});

// Create Checkout Session (upgrade/subscribe)
router.post('/checkout', authenticateToken, async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ message: 'Billing not configured' });
    }

    const { plan, period, promoCode: promoCodeStr } = req.body; // plan: 'team'|'pro', period: 'monthly'|'yearly'

    if (!['team', 'pro'].includes(plan)) {
      return res.status(400).json({ message: 'Neplatný plán' });
    }
    if (!['monthly', 'yearly'].includes(period)) {
      return res.status(400).json({ message: 'Neplatné obdobie' });
    }

    const priceId = PLAN_PRICES[plan]?.[period];
    if (!priceId) {
      return res.status(400).json({ message: 'Cenový plán nie je nakonfigurovaný' });
    }

    const user = await User.findById(req.user.id);
    const customerId = await getOrCreateCustomer(user);

    // If user already has an active subscription, use Stripe billing portal instead
    if (user.subscription?.stripeSubscriptionId) {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(user.subscription.stripeSubscriptionId);
        if (['active', 'trialing', 'past_due'].includes(stripeSub.status)) {
          // Redirect to billing portal for plan change
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${process.env.CORS_ORIGIN}/app/billing`
          });
          return res.json({ url: portalSession.url, type: 'portal' });
        }
      } catch (err) {
        // Subscription might be deleted, continue to create new checkout
        logger.warn('[Billing] Existing subscription check failed', { error: err.message });
      }
    }

    // Build checkout session options
    const checkoutOptions = {
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      success_url: `${process.env.CORS_ORIGIN}/app/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CORS_ORIGIN}/app/billing?canceled=true`,
      metadata: {
        userId: user._id.toString(),
        plan,
        period
      },
      subscription_data: {
        metadata: {
          userId: user._id.toString(),
          plan
        }
      },
      billing_address_collection: 'auto'
    };

    // If user provided a promo code, attach Stripe promotion code
    let appliedPromoCode = null;
    if (promoCodeStr) {
      const promoDoc = await PromoCode.findOne({ code: promoCodeStr.toUpperCase() });
      if (promoDoc && promoDoc.isValid() && promoDoc.canBeUsedBy(req.user.id) && promoDoc.isValidForPlan(plan, period)) {
        if (promoDoc.stripePromotionCodeId) {
          // Use specific promotion code — disables manual entry
          checkoutOptions.discounts = [{ promotion_code: promoDoc.stripePromotionCodeId }];
        } else {
          // No Stripe promo code — let user enter codes manually
          checkoutOptions.allow_promotion_codes = true;
        }
        appliedPromoCode = promoDoc;
        checkoutOptions.metadata.promoCodeId = promoDoc._id.toString();
        checkoutOptions.metadata.promoCode = promoDoc.code;
      } else {
        // Invalid promo code — proceed without it but allow manual codes
        checkoutOptions.allow_promotion_codes = true;
      }
    } else {
      // No promo code provided — allow manual entry at Stripe checkout
      checkoutOptions.allow_promotion_codes = true;
    }

    const session = await stripe.checkout.sessions.create(checkoutOptions);

    // Record promo code usage after successful session creation
    if (appliedPromoCode) {
      appliedPromoCode.usedCount += 1;
      appliedPromoCode.redemptions.push({
        userId: user._id,
        plan,
        period
      });
      await appliedPromoCode.save();
      logger.info('[Billing] Promo code applied to checkout', {
        code: appliedPromoCode.code,
        userId: user._id.toString(),
        sessionId: session.id
      });
    }

    logger.info('[Billing] Checkout session created', {
      userId: user._id.toString(),
      plan,
      period,
      sessionId: session.id
    });

    res.json({ url: session.url, sessionId: session.id, type: 'checkout' });
  } catch (error) {
    logger.error('[Billing] Checkout error', { error: error.message, stack: error.stack, userId: req.user.id });
    // Bezpečnostná hygiena: error.message zo Stripe SDK môže obsahovať
    // citlivé info o konfigurácii (API key hints, account state). Detail
    // posielame len v dev/staging prostrediach pre debug; v produkcii
    // zostáva user-facing iba generická správa, plný error je v logger-i.
    res.status(500).json({
      message: 'Chyba pri vytváraní platby',
      ...(process.env.NODE_ENV !== 'production' && { detail: error.message })
    });
  }
});

// Customer Portal (manage subscription, invoices, payment methods)
router.post('/portal', authenticateToken, async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ message: 'Billing not configured' });
    }

    const user = await User.findById(req.user.id);
    if (!user.subscription?.stripeCustomerId) {
      return res.status(400).json({ message: 'Nemáte žiadnu platobnú históriu' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.subscription.stripeCustomerId,
      return_url: `${process.env.CORS_ORIGIN}/app/billing`
    });

    res.json({ url: portalSession.url });
  } catch (error) {
    logger.error('[Billing] Portal error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Verify checkout session (called after redirect from Stripe)
router.get('/verify-session/:sessionId', authenticateToken, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);

    if (session.metadata?.userId !== req.user.id) {
      return res.status(403).json({ message: 'Neplatná session' });
    }

    res.json({
      status: session.status,
      paymentStatus: session.payment_status,
      plan: session.metadata?.plan,
      period: session.metadata?.period
    });
  } catch (error) {
    logger.error('[Billing] Verify session error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Debug: check subscription state (admin only)
router.get('/debug', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin only' });
    }

    const sub = user.subscription || {};
    const result = {
      userId: user._id,
      email: user.email,
      subscription: {
        plan: sub.plan,
        stripeCustomerId: sub.stripeCustomerId || null,
        stripeSubscriptionId: sub.stripeSubscriptionId || null,
        stripePriceId: sub.stripePriceId || null,
        billingPeriod: sub.billingPeriod || null,
        paidUntil: sub.paidUntil,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd
      }
    };

    // Check Stripe for customer's subscriptions
    if (sub.stripeCustomerId) {
      try {
        const subs = await stripe.subscriptions.list({ customer: sub.stripeCustomerId, limit: 5 });
        result.stripeSubscriptions = subs.data.map(s => ({
          id: s.id,
          status: s.status,
          plan: s.items.data[0]?.price?.id,
          currentPeriodEnd: new Date(s.current_period_end * 1000)
        }));
      } catch (err) {
        result.stripeError = err.message;
      }
    }

    res.json(result);
  } catch (error) {
    logger.error('[Billing] Debug endpoint error', { error: error.message, userId: req.user.id });
    res.status(500).json({
      message: 'Chyba pri načítaní debug údajov',
      ...(process.env.NODE_ENV !== 'production' && { detail: error.message })
    });
  }
});

// Validate promo code (user-facing)
router.post('/validate-promo', authenticateToken, async (req, res) => {
  try {
    const { code, plan, period } = req.body;

    if (!code) {
      return res.status(400).json({ message: 'Zadajte promo kód' });
    }

    const promoCode = await PromoCode.findOne({ code: code.toUpperCase() });
    if (!promoCode) {
      return res.status(404).json({ message: 'Neplatný promo kód' });
    }

    if (!promoCode.isValid()) {
      if (promoCode.expiresAt && new Date() > promoCode.expiresAt) {
        return res.status(400).json({ message: 'Promo kód expiroval' });
      }
      if (promoCode.maxUses > 0 && promoCode.usedCount >= promoCode.maxUses) {
        return res.status(400).json({ message: 'Promo kód bol už vyčerpaný' });
      }
      return res.status(400).json({ message: 'Promo kód nie je aktívny' });
    }

    if (!promoCode.canBeUsedBy(req.user.id)) {
      return res.status(400).json({ message: 'Tento promo kód ste už použili' });
    }

    if (plan && period && !promoCode.isValidForPlan(plan, period)) {
      return res.status(400).json({ message: 'Promo kód nie je platný pre tento plán alebo obdobie' });
    }

    // Calculate discount for each plan/period combination
    const discountPreview = {};
    for (const [planKey, prices] of Object.entries(PLAN_DISPLAY_PRICES)) {
      if (promoCode.validForPlans.length > 0 && !promoCode.validForPlans.includes(planKey)) continue;
      discountPreview[planKey] = {};
      for (const [periodKey, price] of Object.entries(prices)) {
        if (promoCode.validForPeriods.length > 0 && !promoCode.validForPeriods.includes(periodKey)) continue;
        discountPreview[planKey][periodKey] = promoCode.calculateDiscount(price);
      }
    }

    res.json({
      valid: true,
      code: promoCode.code,
      name: promoCode.name,
      type: promoCode.type,
      value: promoCode.value,
      validForPlans: promoCode.validForPlans,
      validForPeriods: promoCode.validForPeriods,
      discountPreview
    });
  } catch (error) {
    logger.error('[Billing] Validate promo error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;

// ===== Webhook handler (called from index.js with raw body) =====

module.exports.handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw body
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.error('[Stripe Webhook] Signature verification failed', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logger.info('[Stripe Webhook] Event received', { type: event.type, id: event.id });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        await handleSubscriptionUpdated(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        await handleInvoicePaid(invoice);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await handlePaymentFailed(invoice);
        break;
      }

      default:
        logger.debug('[Stripe Webhook] Unhandled event type', { type: event.type });
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('[Stripe Webhook] Processing error', {
      type: event.type,
      error: error.message,
      stack: error.stack
    });
    // Return 200 to prevent Stripe from retrying (we logged the error)
    res.json({ received: true, error: error.message });
  }
};

// ===== Webhook handlers =====

async function handleCheckoutCompleted(session) {
  const userId = session.metadata?.userId;
  if (!userId) {
    logger.warn('[Stripe Webhook] No userId in checkout session metadata');
    return;
  }

  const user = await User.findById(userId);
  if (!user) {
    logger.warn('[Stripe Webhook] User not found', { userId });
    return;
  }

  const subscriptionId = session.subscription;
  if (!subscriptionId) return;

  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = stripeSub.items.data[0]?.price?.id;
  const plan = session.metadata?.plan || getPlanByPriceId(priceId);
  const period = session.metadata?.period || getBillingPeriod(priceId);

  user.subscription = {
    ...user.subscription.toObject(),
    plan: plan || user.subscription.plan,
    stripeCustomerId: session.customer,
    stripeSubscriptionId: subscriptionId,
    stripePriceId: priceId,
    billingPeriod: period,
    paidUntil: new Date(stripeSub.current_period_end * 1000),
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end
  };

  await user.save();
  logger.info('[Stripe Webhook] Checkout completed — plan activated', {
    userId,
    plan,
    period,
    paidUntil: user.subscription.paidUntil
  });
}

async function handleSubscriptionUpdated(subscription) {
  const user = await User.findOne({ 'subscription.stripeSubscriptionId': subscription.id });
  if (!user) {
    // Try by customer ID
    const byCustomer = await User.findOne({ 'subscription.stripeCustomerId': subscription.customer });
    if (!byCustomer) {
      logger.warn('[Stripe Webhook] No user found for subscription', { subscriptionId: subscription.id });
      return;
    }
    return updateUserSubscription(byCustomer, subscription);
  }
  return updateUserSubscription(user, subscription);
}

async function updateUserSubscription(user, subscription) {
  const priceId = subscription.items.data[0]?.price?.id;
  const plan = getPlanByPriceId(priceId);
  const period = getBillingPeriod(priceId);

  const isActive = ['active', 'trialing'].includes(subscription.status);

  user.subscription = {
    ...user.subscription.toObject(),
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: subscription.customer,
    stripePriceId: priceId,
    plan: isActive ? (plan || user.subscription.plan) : 'free',
    billingPeriod: period || user.subscription.billingPeriod,
    paidUntil: new Date(subscription.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end
  };

  // If subscription is past_due, keep the plan but log warning
  if (subscription.status === 'past_due') {
    user.subscription.plan = plan || user.subscription.plan;
    logger.warn('[Stripe Webhook] Subscription past due', {
      userId: user._id.toString(),
      subscriptionId: subscription.id
    });
  }

  await user.save();
  logger.info('[Stripe Webhook] Subscription updated', {
    userId: user._id.toString(),
    plan: user.subscription.plan,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end
  });
}

async function handleSubscriptionDeleted(subscription) {
  const user = await User.findOne({ 'subscription.stripeSubscriptionId': subscription.id });
  if (!user) {
    logger.warn('[Stripe Webhook] No user for deleted subscription', { subscriptionId: subscription.id });
    return;
  }

  // Downgrade to free
  user.subscription.plan = 'free';
  user.subscription.stripeSubscriptionId = null;
  user.subscription.stripePriceId = null;
  user.subscription.billingPeriod = null;
  user.subscription.cancelAtPeriodEnd = false;
  // Keep stripeCustomerId for future use

  await user.save();
  logger.info('[Stripe Webhook] Subscription deleted — downgraded to free', {
    userId: user._id.toString(),
    subscriptionId: subscription.id
  });
}

async function handleInvoicePaid(invoice) {
  if (!invoice.subscription) return;

  const user = await User.findOne({ 'subscription.stripeCustomerId': invoice.customer });
  if (!user) return;

  const stripeSub = await stripe.subscriptions.retrieve(invoice.subscription);
  user.subscription.paidUntil = new Date(stripeSub.current_period_end * 1000);
  await user.save();

  logger.info('[Stripe Webhook] Invoice paid — paidUntil updated', {
    userId: user._id.toString(),
    paidUntil: user.subscription.paidUntil
  });
}

async function handlePaymentFailed(invoice) {
  const user = await User.findOne({ 'subscription.stripeCustomerId': invoice.customer });
  if (!user) return;

  logger.warn('[Stripe Webhook] Payment failed', {
    userId: user._id.toString(),
    invoiceId: invoice.id,
    attemptCount: invoice.attempt_count
  });

  // Stripe will automatically retry and eventually cancel — we don't downgrade immediately
  // The subscription.deleted event will handle the final downgrade
}
