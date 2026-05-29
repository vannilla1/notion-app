/**
 * iapBridge.js — web ↔ native most pre Apple In-App Purchases.
 *
 * Architektúra (Option B): native (StoreKitManager.swift) robí StoreKit
 * operáciu a výsledok vráti cez injektnuté globály window.__iapProducts /
 * window.__iapResult. Tu ich napárujeme na Promise podľa requestId a po
 * úspešnom nákupe POSTneme JWS na /api/billing/apple/verify (reuse api
 * clientu — token, refresh, error handling).
 *
 * Funguje IBA v iOS native shell-e. Vo web/Android prehliadači iapAvailable()
 * vráti false → UI ukáže Stripe flow namiesto IAP.
 */

import { isIosNativeApp } from './platform';
import api from '@/api/api';

// requestId → { resolve, reject }. Native odpovedá s rovnakým requestId.
const pending = new Map();
let initialized = false;
let reqCounter = 0;

function ensureInit() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  // Native → web: zoznam produktov s lokalizovanými cenami
  window.__iapProducts = (requestId, products) => {
    const p = pending.get(requestId);
    if (p) { pending.delete(requestId); p.resolve(products); }
  };

  // Native → web: výsledok nákupu / restore
  window.__iapResult = (requestId, result) => {
    // 'external' = renewal / Ask-to-Buy / restore prišlo mimo priameho
    // nákupu (StoreKit Transaction.updates listener). Backend dostane
    // authoritatívny update aj cez ASSN webhook; tu len pre istotu
    // re-verifikujeme JWS a triggerneme UI refresh event.
    if (requestId === 'external') {
      if (result?.jws) {
        api.post('/api/billing/apple/verify', { signedTransaction: result.jws }).catch(() => {});
      }
      window.dispatchEvent(new CustomEvent('iap-external-update'));
      return;
    }
    const p = pending.get(requestId);
    if (p) { pending.delete(requestId); p.resolve(result); }
  };
}

function postToNative(payload) {
  window.webkit?.messageHandlers?.iosNative?.postMessage(payload);
}

function newRequest(prefix, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const requestId = `${prefix}${Date.now()}_${reqCounter++}`;
    pending.set(requestId, { resolve, reject });
    postToNative({ requestId, ...label(requestId) });
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error('Vypršal čas — skús to znova'));
      }
    }, timeoutMs);
  });
}

/** Je IAP dostupné? (beží v iOS native shell-e s bridge) */
export function iapAvailable() {
  return isIosNativeApp() && !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iosNative);
}

/**
 * Fetchne produkty z App Store (cez native StoreKit). Vráti pole
 * [{ productId, displayName, description, price, priceValue }].
 */
export function fetchIapProducts(timeoutMs = 15000) {
  ensureInit();
  return newRequest('p', timeoutMs, () => ({ type: 'iapGetProducts' }));
}

/**
 * Spustí nákup. Native otvorí StoreKit purchase sheet. Po úspechu sa JWS
 * pošle backendu na overenie a vráti sa { success, subscription }.
 * Pri zrušení { cancelled: true }, pri Ask-to-Buy { pending: true }.
 */
export async function purchaseIap(productId, timeoutMs = 180000) {
  ensureInit();
  const result = await newRequest('b', timeoutMs, () => ({ type: 'iapPurchase', productId }));

  if (result.cancelled) return { cancelled: true };
  if (result.pending) return { pending: true };
  if (!result.success || !result.jws) {
    throw new Error(result.error || 'Nákup zlyhal');
  }
  // Over JWS na backende → aktivuje plán
  const verifyRes = await api.post('/api/billing/apple/verify', { signedTransaction: result.jws });
  return { success: true, subscription: verifyRes.data.subscription };
}

/**
 * Obnoví predošlé nákupy (reinštalácia / nové zariadenie). Nájde aktívnu
 * subscription cez StoreKit currentEntitlements a re-verifikuje na backende.
 */
export async function restoreIap(timeoutMs = 60000) {
  ensureInit();
  const result = await newRequest('r', timeoutMs, () => ({ type: 'iapRestore' }));
  if (!result.success || !result.jws) {
    throw new Error(result.error || 'Žiadne predplatné na obnovenie');
  }
  const verifyRes = await api.post('/api/billing/apple/verify', { signedTransaction: result.jws });
  return { success: true, subscription: verifyRes.data.subscription };
}
