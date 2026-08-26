/**
 * idempotency.js — in-memory kľúče proti dvojitému vykonaniu mutácie.
 *
 * Používa transfer (kopírovanie/presun) aj nahrávanie príloh: keď sa
 * odpoveď stratí a klient operáciu zopakuje, kľúč zabráni vzniku druhej
 * kópie. Pri reálnom zlyhaní sa kľúč uvoľňuje, aby legitímny retry prešiel.
 *
 * Zámerne in-memory: reštart inštancie kľúče stratí, čo je prijateľné —
 * okno na duplikát je krátke a alternatíva (Redis/DB) by pridala závislosť
 * kvôli okrajovému prípadu.
 */
const recentMutationKeys = new Map(); // key → expiresAt

const claimMutationKey = (key, ttlMs) => {
  const now = Date.now();
  for (const [k, exp] of recentMutationKeys) {
    if (exp <= now) recentMutationKeys.delete(k);
  }
  if (recentMutationKeys.has(key)) return false;
  recentMutationKeys.set(key, now + ttlMs);
  return true;
};

const releaseMutationKey = (key) => recentMutationKeys.delete(key);

module.exports = { claimMutationKey, releaseMutationKey };
