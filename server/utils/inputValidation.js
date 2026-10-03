/**
 * Spoločná validácia identitných vstupov (e-mail, username, farba) pre
 * register / login / úpravu profilu.
 *
 * Všetky funkcie vracajú normalizovanú hodnotu alebo null pri nevalidnom
 * vstupe — volajúci route odpovie 400. Ne-string hodnoty (objekt
 * `{"$gt": ""}`, pole, číslo) sú vždy nevalidné, takže sa nikdy nedostanú
 * do Mongo dotazu ako operátor ani nespadnú na `.toLowerCase()` (500).
 */

// RFC 5321: adresa max 254 znakov. Zámerne jednoduchý regex — presná RFC
// validácia je nepraktická; skutočné vlastníctvo overuje až doručenie.
const EMAIL_MAX_LENGTH = 254;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

const USERNAME_MIN_LENGTH = 2;
const USERNAME_MAX_LENGTH = 50;
// Písmená (vrátane diakritiky), číslice, medzera a _ . - '
const USERNAME_RE = /^[\p{L}\p{N} _.'-]+$/u;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const normalizeEmail = (value) => {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX_LENGTH) return null;
  return EMAIL_RE.test(email) ? email : null;
};

const normalizeUsername = (value) => {
  if (typeof value !== 'string') return null;
  const username = value.trim().replace(/\s+/g, ' ');
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) return null;
  return USERNAME_RE.test(username) ? username : null;
};

const isHexColor = (value) => typeof value === 'string' && HEX_COLOR_RE.test(value);

module.exports = {
  normalizeEmail,
  normalizeUsername,
  isHexColor,
  EMAIL_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH
};
