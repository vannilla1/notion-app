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
const recentMutationKeys = new Map(); // key → { expiresAt, done }

const claimMutationKey = (key, ttlMs) => {
  const now = Date.now();
  for (const [k, entry] of recentMutationKeys) {
    if (entry.expiresAt <= now) recentMutationKeys.delete(k);
  }
  if (recentMutationKeys.has(key)) return false;
  recentMutationKeys.set(key, { expiresAt: now + ttlMs, done: false });
  return true;
};

const releaseMutationKey = (key) => recentMutationKeys.delete(key);

/**
 * Mutácia pod kľúčom sa dokončila (dáta sú uložené). Až potom smie opakovaný
 * request dostať „duplicate". Kým beží, je kľúč 'pending' — nahrávanie
 * príloh vtedy odpovedá 409 UPLOAD_IN_PROGRESS a klient to skúsi neskôr.
 * Predtým opakovanie počas bežiaceho prvého requestu dostalo 200 duplicate,
 * klient súbor z fronty zmazal — a keď prvý request potom zlyhal (R2 chyba),
 * príloha nebola nikde.
 */
const markMutationDone = (key) => {
  const entry = recentMutationKeys.get(key);
  if (entry) entry.done = true;
};

/** 'pending' | 'done' | null (kľúč neexistuje / vypršal) */
const mutationKeyState = (key) => {
  const entry = recentMutationKeys.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.done ? 'done' : 'pending';
};

module.exports = { claimMutationKey, releaseMutationKey, markMutationDone, mutationKeyState };
