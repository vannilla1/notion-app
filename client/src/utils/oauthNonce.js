// Väzba OAuth prihlásenia na prehliadač, ktorý ho spustil (login-CSRF ochrana).
//
// Pred navigáciou na /api/auth/{provider}/login vygenerujeme náhodný nonce,
// uložíme ho do localStorage a pošleme serveru (`cnonce`). Server ho vloží do
// podpísaného state a callback ho vráti vo fragmente spolu s tokenom.
// AuthCallback token prijme len pri zhode — URL callbacku, ktorú by útočník
// podstrčil obeti (s jeho code+state), sa v jej prehliadači zahodí.
//
// localStorage (nie sessionStorage): natívne shelly (iOS WKWebView, Android
// WebView) dokončujú flow cez Universal/App Link v tom istom WebView, ale
// mimo pôvodnej „session“ tabu.

const KEY = 'prpl_oauth_nonce';
const MAX_AGE_MS = 15 * 60 * 1000;

const randomHex = (bytes) => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
};

export const createOAuthNonce = () => {
  const nonce = randomHex(16);
  try {
    localStorage.setItem(KEY, JSON.stringify({ n: nonce, ts: Date.now() }));
  } catch { /* storage nedostupný — callback potom prihlásenie odmietne */ }
  return nonce;
};

// true ak `received` zodpovedá uloženému (a ešte platnému) nonce. Uložený
// nonce sa zmaže vždy — každý je jednorazový.
export const consumeOAuthNonce = (received) => {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || 'null');
    localStorage.removeItem(KEY);
  } catch { /* noop */ }
  if (!stored || typeof stored.n !== 'string' || typeof received !== 'string') return false;
  if (Date.now() - (stored.ts || 0) > MAX_AGE_MS) return false;
  return stored.n === received;
};
