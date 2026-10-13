/**
 * Zdieľaný Stripe klient (lazy).
 *
 * `require('stripe')(undefined)` hodí výnimku už pri načítaní modulu — bez
 * STRIPE_SECRET_KEY (lokálny vývoj, staging, CI) by server vôbec
 * nenaštartoval a guardy `if (process.env.STRIPE_SECRET_KEY)` v kóde boli
 * mŕtve. Klient sa vytvorí až pri prvom použití; bez kľúča použitie hodí
 * zrozumiteľnú chybu (volajúce miesta sú guardované isStripeConfigured).
 */
const STRIPE_OPTIONS = {
  apiVersion: '2024-11-20.acacia',
  // timeout: default SDK je 80 s; 2 retry pri sieťových chybách / 409 / 5xx
  // s Idempotency-Key.
  timeout: 15000,
  maxNetworkRetries: 2
};

let instance = null;
let instanceKey = null;

const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!instance || instanceKey !== key) {
    instance = require('stripe')(key, STRIPE_OPTIONS);
    instanceKey = key;
  }
  return instance;
};

// Proxy so známym API (`stripe.customers.create(...)`) — modul sa dá
// načítať aj bez kľúča.
const stripe = new Proxy({}, {
  get(_, prop) {
    const client = getStripe();
    if (!client) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
    const value = client[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  }
});

module.exports = { stripe, getStripe, STRIPE_OPTIONS };
