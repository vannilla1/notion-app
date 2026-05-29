/**
 * appleIap.js — Apple In-App Purchase verification + App Store Server API.
 *
 * In-house implementácia (žiadny RevenueCat). Postavená na OFICIÁLNEJ Apple
 * knižnici @apple/app-store-server-library, ktorá rieši crypto-citlivé časti:
 *   - JWS podpis verifikácia StoreKit 2 transakcií (x5c cert chain → Apple root)
 *   - App Store Server Notifications V2 dekódovanie + verifikácia
 *   - App Store Server API client (subscription status lookup)
 *
 * Fail-safe: ak chýbajú env vars, isConfigured() vráti false a routes vrátia
 * 503 (namiesto crash-u). Mirror pattern z fileStorage.js / appleIap nie je
 * povinný kým iOS appka nie je v reálnom IAP flow.
 *
 * Required env vars (nastaviť na Render po App Store Connect setup-e):
 *   APPLE_IAP_KEY_ID         — Key ID z App Store Connect In-App Purchase kľúča
 *   APPLE_IAP_ISSUER_ID      — Issuer ID (App Store Connect → Users and Access → Integrations)
 *   APPLE_IAP_PRIVATE_KEY    — obsah .p8 súboru (multi-line, vrátane BEGIN/END riadkov)
 *   APPLE_IAP_BUNDLE_ID      — sk.perunelectromobility.prplcrm (default)
 *   APPLE_IAP_APP_APPLE_ID   — numerické App ID z App Store Connect (App Information → General → Apple ID)
 */

const fs = require('fs');
const path = require('path');
const {
  SignedDataVerifier,
  AppStoreServerAPIClient,
  Environment
} = require('@apple/app-store-server-library');
const logger = require('../utils/logger');

const KEY_ID = process.env.APPLE_IAP_KEY_ID;
const ISSUER_ID = process.env.APPLE_IAP_ISSUER_ID;
// Private key môže prísť ako multi-line env var. Render zachováva newlines,
// ale pre istotu konvertujeme literal \n na skutočné newlines (niektorí
// deploy tools escapujú).
const PRIVATE_KEY = (process.env.APPLE_IAP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const BUNDLE_ID = process.env.APPLE_IAP_BUNDLE_ID || 'sk.perunelectromobility.prplcrm';
// App Apple ID je numerické — required pre PRODUCTION notification verifikáciu.
const APP_APPLE_ID = process.env.APPLE_IAP_APP_APPLE_ID
  ? parseInt(process.env.APPLE_IAP_APP_APPLE_ID, 10)
  : undefined;

const isConfigured = !!(KEY_ID && ISSUER_ID && PRIVATE_KEY);

// ── Apple root CA certs (public, bundled v repo) ──
// SignedDataVerifier potrebuje root-of-trust na overenie x5c cert chain-u
// v JWS podpise. Tieto certy sú verejné, stiahnuté z apple.com/certificateauthority.
let appleRootCerts = [];
try {
  const certDir = path.join(__dirname, '..', 'config', 'apple-certs');
  appleRootCerts = fs.readdirSync(certDir)
    .filter((f) => f.endsWith('.cer'))
    .map((f) => fs.readFileSync(path.join(certDir, f)));
} catch (e) {
  logger.warn('[AppleIAP] Failed to load Apple root certs', { error: e.message });
}

// enableOnlineChecks=true robí OCSP revocation check na cert chain. Mierne
// pomalšie (extra HTTP), ale bezpečnejšie. Pre verifikáciu transakcií OK.
const ENABLE_ONLINE_CHECKS = true;

// Verifiers per environment — transakcia môže prísť z Production (real users)
// alebo Sandbox (TestFlight + Apple review + náš test). Verifikujeme produkčným
// najprv, fallback na sandbox (štandardný Apple-odporúčaný pattern).
let prodVerifier = null;
let sandboxVerifier = null;
let prodApiClient = null;
let sandboxApiClient = null;

if (isConfigured && appleRootCerts.length > 0) {
  try {
    prodVerifier = new SignedDataVerifier(
      appleRootCerts, ENABLE_ONLINE_CHECKS, Environment.PRODUCTION, BUNDLE_ID, APP_APPLE_ID
    );
    sandboxVerifier = new SignedDataVerifier(
      appleRootCerts, ENABLE_ONLINE_CHECKS, Environment.SANDBOX, BUNDLE_ID, APP_APPLE_ID
    );
    prodApiClient = new AppStoreServerAPIClient(
      PRIVATE_KEY, KEY_ID, ISSUER_ID, BUNDLE_ID, Environment.PRODUCTION
    );
    sandboxApiClient = new AppStoreServerAPIClient(
      PRIVATE_KEY, KEY_ID, ISSUER_ID, BUNDLE_ID, Environment.SANDBOX
    );
    logger.info('[AppleIAP] Configured', { bundleId: BUNDLE_ID, rootCerts: appleRootCerts.length });
  } catch (e) {
    logger.error('[AppleIAP] Init failed', { error: e.message });
  }
} else {
  logger.warn('[AppleIAP] NOT configured — iOS IAP disabled until env vars set', {
    hasKeyId: !!KEY_ID, hasIssuer: !!ISSUER_ID, hasKey: !!PRIVATE_KEY, rootCerts: appleRootCerts.length
  });
}

function isAvailable() {
  return !!(isConfigured && prodVerifier && sandboxVerifier);
}

/**
 * Verifikuje + dekóduje StoreKit 2 signed transaction (JWS) prichádzajúci
 * z iOS appky. Skúša production verifier najprv, sandbox fallback.
 *
 * @param {string} signedTransaction — JWS string z StoreKit Transaction
 * @returns {Promise<{ payload: object, environment: 'Production'|'Sandbox' }>}
 * @throws ak verifikácia zlyhá v oboch prostrediach (= neplatná/podvrhnutá transakcia)
 */
async function verifyTransaction(signedTransaction) {
  if (!isAvailable()) throw new Error('Apple IAP not configured');

  // Production first
  try {
    const payload = await prodVerifier.verifyAndDecodeTransaction(signedTransaction);
    return { payload, environment: 'Production' };
  } catch (prodErr) {
    // Fallback na sandbox — TestFlight/review/test transakcie zlyhajú v prod.
    try {
      const payload = await sandboxVerifier.verifyAndDecodeTransaction(signedTransaction);
      return { payload, environment: 'Sandbox' };
    } catch (sandboxErr) {
      logger.warn('[AppleIAP] Transaction verification failed in both envs', {
        prodError: prodErr.message,
        sandboxError: sandboxErr.message
      });
      throw new Error('Transaction verification failed');
    }
  }
}

/**
 * Verifikuje + dekóduje App Store Server Notification V2 (signedPayload).
 * Apple posiela tieto na náš webhook pri renewal / cancel / refund / atď.
 *
 * @param {string} signedPayload — JWS z notification body
 * @returns {Promise<{ payload: object, environment: 'Production'|'Sandbox' }>}
 */
async function verifyNotification(signedPayload) {
  if (!isAvailable()) throw new Error('Apple IAP not configured');

  try {
    const payload = await prodVerifier.verifyAndDecodeNotification(signedPayload);
    return { payload, environment: 'Production' };
  } catch (prodErr) {
    try {
      const payload = await sandboxVerifier.verifyAndDecodeNotification(signedPayload);
      return { payload, environment: 'Sandbox' };
    } catch (sandboxErr) {
      logger.warn('[AppleIAP] Notification verification failed in both envs', {
        prodError: prodErr.message,
        sandboxError: sandboxErr.message
      });
      throw new Error('Notification verification failed');
    }
  }
}

/**
 * Dekóduje renewalInfo / transactionInfo JWS z notification data payloadu.
 * Notification V2 obsahuje vnorené signedTransactionInfo + signedRenewalInfo.
 */
async function decodeNotificationPayloads(data, environment) {
  const verifier = environment === 'Sandbox' ? sandboxVerifier : prodVerifier;
  const result = {};
  if (data.signedTransactionInfo) {
    result.transactionInfo = await verifier.verifyAndDecodeTransaction(data.signedTransactionInfo);
  }
  if (data.signedRenewalInfo) {
    result.renewalInfo = await verifier.verifyAndDecodeRenewalInfo(data.signedRenewalInfo);
  }
  return result;
}

/**
 * Query App Store Server API o aktuálny status subscription podľa
 * originalTransactionId. Vracia najnovší stav (active/expired/grace/...).
 * Použité ako fallback/reconciliation keď si nie sme istí stavom z notifikácie.
 *
 * @param {string} originalTransactionId
 * @param {'Production'|'Sandbox'} environment
 */
async function getSubscriptionStatuses(originalTransactionId, environment = 'Production') {
  if (!isAvailable()) throw new Error('Apple IAP not configured');
  const client = environment === 'Sandbox' ? sandboxApiClient : prodApiClient;
  return client.getAllSubscriptionStatuses(originalTransactionId);
}

module.exports = {
  isAvailable,
  verifyTransaction,
  verifyNotification,
  decodeNotificationPayloads,
  getSubscriptionStatuses,
  bundleId: BUNDLE_ID
};
