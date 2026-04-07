#!/usr/bin/env node
/**
 * Stripe Sync Script
 *
 * Fixes user subscription state by syncing with Stripe.
 * Cancels duplicate subscriptions, keeps the latest one.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_xxx MONGODB_URI=mongodb+srv://... node server/scripts/stripe-sync.js <stripeCustomerId>
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mongoose = require('mongoose');

const PLAN_PRICES = {
  team: {
    monthly: process.env.STRIPE_PRICE_TEAM_MONTHLY || 'price_1TJaVg0GElOl3x7Z85I7EsZP',
    yearly: process.env.STRIPE_PRICE_TEAM_YEARLY || 'price_1TJaVh0GElOl3x7ZvHNJeSF3'
  },
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_1TJaVh0GElOl3x7ZMqz2qu6D',
    yearly: process.env.STRIPE_PRICE_PRO_YEARLY || 'price_1TJaVi0GElOl3x7ZDGb9tqly'
  }
};

const getPlanByPriceId = (priceId) => {
  for (const [plan, prices] of Object.entries(PLAN_PRICES)) {
    if (prices.monthly === priceId || prices.yearly === priceId) return plan;
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

async function sync() {
  const customerId = process.argv[2];
  if (!customerId) {
    console.error('Usage: node stripe-sync.js <stripeCustomerId>');
    process.exit(1);
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.MONGODB_URI) {
    console.error('Set STRIPE_SECRET_KEY and MONGODB_URI');
    process.exit(1);
  }

  // Connect to MongoDB
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');

  // Find user
  const user = await User.findOne({ 'subscription.stripeCustomerId': customerId });
  if (!user) {
    console.error('No user found with stripeCustomerId:', customerId);
    process.exit(1);
  }
  console.log(`User: ${user.email} (${user._id})`);
  console.log(`Current plan: ${user.subscription?.plan}, paidUntil: ${user.subscription?.paidUntil}`);

  // Get all subscriptions from Stripe
  const subs = await stripe.subscriptions.list({ customer: customerId, limit: 10 });
  console.log(`\nStripe subscriptions: ${subs.data.length}`);

  const activeSubs = subs.data.filter(s => ['active', 'trialing'].includes(s.status));
  console.log(`Active subscriptions: ${activeSubs.length}`);

  if (activeSubs.length === 0) {
    console.log('No active subscriptions — setting plan to free');
    user.subscription.plan = 'free';
    user.subscription.stripeSubscriptionId = null;
    user.subscription.stripePriceId = null;
    user.subscription.billingPeriod = null;
    await user.save();
    process.exit(0);
  }

  // Cancel all but the latest subscription
  if (activeSubs.length > 1) {
    // Sort by created date, keep newest
    activeSubs.sort((a, b) => b.created - a.created);
    const keep = activeSubs[0];
    console.log(`\nKeeping subscription: ${keep.id} (created: ${new Date(keep.created * 1000).toISOString()})`);

    for (let i = 1; i < activeSubs.length; i++) {
      const cancel = activeSubs[i];
      console.log(`Canceling duplicate: ${cancel.id} (created: ${new Date(cancel.created * 1000).toISOString()})`);
      await stripe.subscriptions.cancel(cancel.id);
    }
  }

  // Sync with the active subscription
  const activeSub = activeSubs[0];
  const priceId = activeSub.items.data[0]?.price?.id;
  const plan = getPlanByPriceId(priceId);
  const period = getBillingPeriod(priceId);

  console.log(`\nSyncing to DB:`);
  console.log(`  Subscription: ${activeSub.id}`);
  console.log(`  Price: ${priceId}`);
  console.log(`  Plan: ${plan}`);
  console.log(`  Period: ${period}`);
  const periodEnd = activeSub.current_period_end
    ? new Date(activeSub.current_period_end * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // fallback: +30 days
  console.log(`  Period end: ${periodEnd.toISOString()}`);

  user.subscription.plan = plan || 'team';
  user.subscription.stripeSubscriptionId = activeSub.id;
  user.subscription.stripePriceId = priceId;
  user.subscription.billingPeriod = period;
  user.subscription.paidUntil = periodEnd;
  user.subscription.cancelAtPeriodEnd = activeSub.cancel_at_period_end || false;

  await user.save();
  console.log('\nUser subscription synced successfully!');
  console.log(`  Plan: ${user.subscription.plan}`);
  console.log(`  Paid until: ${user.subscription.paidUntil}`);

  await mongoose.disconnect();
}

sync().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
