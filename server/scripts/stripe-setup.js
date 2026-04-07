#!/usr/bin/env node
/**
 * Stripe Product & Price Setup Script
 *
 * Run once to create products and prices in Stripe Dashboard.
 * Copy the output price IDs to your .env file.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_xxx node server/scripts/stripe-setup.js
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function setup() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('ERROR: Set STRIPE_SECRET_KEY environment variable');
    process.exit(1);
  }

  console.log('Creating Stripe products and prices for Prpl CRM...\n');

  // --- Team Plan ---
  const teamProduct = await stripe.products.create({
    name: 'Prpl CRM — Tim',
    description: '25 kontaktov, 25 projektov/kontakt, 10 clenov, 2 prostredia',
    metadata: { plan: 'team' }
  });
  console.log(`Team product: ${teamProduct.id}`);

  const teamMonthly = await stripe.prices.create({
    product: teamProduct.id,
    unit_amount: 499, // 4.99 EUR in cents
    currency: 'eur',
    recurring: { interval: 'month' },
    metadata: { plan: 'team', period: 'monthly' }
  });
  console.log(`Team monthly price: ${teamMonthly.id}  (4.99 EUR/month)`);

  const teamYearly = await stripe.prices.create({
    product: teamProduct.id,
    unit_amount: 4900, // 49.00 EUR in cents
    currency: 'eur',
    recurring: { interval: 'year' },
    metadata: { plan: 'team', period: 'yearly' }
  });
  console.log(`Team yearly price:  ${teamYearly.id}  (49.00 EUR/year)\n`);

  // --- Pro Plan ---
  const proProduct = await stripe.products.create({
    name: 'Prpl CRM — Pro',
    description: 'Neobmedzene kontakty, projekty, clenovia, prostredia',
    metadata: { plan: 'pro' }
  });
  console.log(`Pro product: ${proProduct.id}`);

  const proMonthly = await stripe.prices.create({
    product: proProduct.id,
    unit_amount: 999, // 9.99 EUR in cents
    currency: 'eur',
    recurring: { interval: 'month' },
    metadata: { plan: 'pro', period: 'monthly' }
  });
  console.log(`Pro monthly price: ${proMonthly.id}  (9.99 EUR/month)`);

  const proYearly = await stripe.prices.create({
    product: proProduct.id,
    unit_amount: 9900, // 99.00 EUR in cents
    currency: 'eur',
    recurring: { interval: 'year' },
    metadata: { plan: 'pro', period: 'yearly' }
  });
  console.log(`Pro yearly price:  ${proYearly.id}  (99.00 EUR/year)\n`);

  // --- Output for .env ---
  console.log('='.repeat(60));
  console.log('Add these to your .env file:\n');
  console.log(`STRIPE_PRICE_TEAM_MONTHLY=${teamMonthly.id}`);
  console.log(`STRIPE_PRICE_TEAM_YEARLY=${teamYearly.id}`);
  console.log(`STRIPE_PRICE_PRO_MONTHLY=${proMonthly.id}`);
  console.log(`STRIPE_PRICE_PRO_YEARLY=${proYearly.id}`);
  console.log('='.repeat(60));
}

setup().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
