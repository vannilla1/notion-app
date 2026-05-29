/**
 * appleProducts.js — Apple IAP product ID ↔ plan/period mapping.
 *
 * Single source of truth pre mapovanie Apple In-App Purchase product
 * identifikátorov na interné plány. Tieto presné stringy MUSÍŠ vytvoriť
 * v App Store Connect → Subscriptions ako auto-renewable subscriptions.
 *
 * Product IDs sú PUBLIC identifikátory (nie secrets) — preto sú v kóde
 * natvrdo, nie v env vars. Bundle ID appky je sk.perunelectromobility.prplcrm,
 * ale product IDs nemusia byť pod ním — stačí že sú unikátne v rámci appky.
 *
 * Konvencia: prplcrm.<plan>.<period>
 *
 * DÔLEŽITÉ: rovnaké stringy musia byť aj v iOS Swift StoreKit kóde
 * (StoreKitManager.productIds). Keď meníš tu, zmeň aj tam.
 *
 * Ceny (z webu, musia mapovať na Apple price tiers):
 *   team monthly: €4.99  | team yearly: €49.00
 *   pro  monthly: €9.99  | pro  yearly: €99.00
 */

const APPLE_PRODUCTS = {
  'prplcrm.team.monthly': { plan: 'team', period: 'monthly' },
  'prplcrm.team.yearly':  { plan: 'team', period: 'yearly'  },
  'prplcrm.pro.monthly':  { plan: 'pro',  period: 'monthly' },
  'prplcrm.pro.yearly':   { plan: 'pro',  period: 'yearly'  }
};

// Reverse lookup: productId → { plan, period } | null
const getProductInfo = (productId) => APPLE_PRODUCTS[productId] || null;

// Pole všetkých product IDs — pre iOS fetch + validáciu
const allProductIds = () => Object.keys(APPLE_PRODUCTS);

// productId pre danú (plan, period) kombináciu — reverzný helper
const getProductId = (plan, period) => {
  for (const [pid, info] of Object.entries(APPLE_PRODUCTS)) {
    if (info.plan === plan && info.period === period) return pid;
  }
  return null;
};

module.exports = {
  APPLE_PRODUCTS,
  getProductInfo,
  allProductIds,
  getProductId
};
