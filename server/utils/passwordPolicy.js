/**
 * Password Policy — server-side password validation.
 *
 * Vynucuje minimálne bezpečnostné požiadavky a kontroluje heslo voči
 * verejnej databáze kompromitovaných hesiel (Have I Been Pwned).
 *
 * Pravidlá:
 *   1. Minimálne 8 znakov (NIST SP 800-63B odporúčanie pre user-chosen pwd)
 *   2. Aspoň jedno písmeno A-Za-z (zabráni iba-číselným heslám typu PIN-u)
 *   3. Aspoň jedno číslo 0-9 ALEBO špeciálny znak (zabráni iba abecedným)
 *   4. Maximum 128 znakov (DoS prevencia — bcrypt by inak zožral CPU)
 *   5. HIBP Pwned Passwords API check (k-anonymity, posiela len 5-char SHA1
 *      prefix, nikdy nie celé heslo) — zakáže heslá zo zoznamu úniku.
 *
 * Použitie:
 *   const { validatePassword } = require('../utils/passwordPolicy');
 *   const error = await validatePassword(plainPassword);
 *   if (error) return res.status(400).json({ message: error });
 *
 * HIBP API zlyhanie (sieťová chyba) NEBLOKUJE registráciu — fail-open dizajn,
 * lebo HIBP nie je 100% uptime SLA. Logujeme cez logger.warn pre observability.
 *
 * Ref:
 *   - NIST SP 800-63B: https://pages.nist.gov/800-63-3/sp800-63b.html
 *   - HIBP API: https://haveibeenpwned.com/API/v3#PwnedPasswords
 *   - K-anonymity model: https://en.wikipedia.org/wiki/K-anonymity
 */
const crypto = require('crypto');
const logger = require('./logger');

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const HIBP_TIMEOUT_MS = 3000;

/**
 * Validuje formát hesla — bez sieťového volania.
 * Vracia error message (string) alebo null ak je heslo OK.
 */
function validatePasswordFormat(password) {
  if (typeof password !== 'string') {
    return 'Heslo je povinné.';
  }
  if (password.length < MIN_LENGTH) {
    return `Heslo musí mať aspoň ${MIN_LENGTH} znakov.`;
  }
  if (password.length > MAX_LENGTH) {
    return `Heslo je príliš dlhé (max ${MAX_LENGTH} znakov).`;
  }
  // Aspoň jedno písmeno
  if (!/[A-Za-z]/.test(password)) {
    return 'Heslo musí obsahovať aspoň jedno písmeno.';
  }
  // Aspoň jedno číslo alebo špeciálny znak
  if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) {
    return 'Heslo musí obsahovať aspoň jedno číslo alebo špeciálny znak.';
  }
  return null;
}

/**
 * Skontroluje heslo voči HIBP Pwned Passwords API cez k-anonymity.
 * Posiela iba prvých 5 znakov SHA-1 hashu, nikdy nie celé heslo.
 *
 * Vracia { breached: boolean, count: number } alebo { breached: false, error }
 * pri sieťovej chybe (fail-open).
 */
async function checkPasswordBreached(password) {
  try {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        signal: controller.signal,
        headers: {
          'Add-Padding': 'true',
          'User-Agent': 'PrplCRM-PasswordPolicy/1.0'
        }
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      logger.warn('HIBP API non-OK response', { status: response.status });
      return { breached: false, error: 'hibp_unavailable' };
    }

    const text = await response.text();
    // Each line: "<35-char SHA1 suffix>:<count>"
    const lines = text.split('\n');
    for (const line of lines) {
      const [hashSuffix, countStr] = line.trim().split(':');
      if (hashSuffix === suffix) {
        return { breached: true, count: parseInt(countStr, 10) || 0 };
      }
    }
    return { breached: false, count: 0 };
  } catch (err) {
    // Sieťová chyba alebo timeout — fail-open. Nelog-ujeme heslo, len error.
    logger.warn('HIBP check failed', { error: err.message });
    return { breached: false, error: err.message };
  }
}

/**
 * Hlavný validátor — kombinuje formát a HIBP. Asynchrónny.
 * Vracia error message alebo null.
 */
async function validatePassword(password) {
  const formatError = validatePasswordFormat(password);
  if (formatError) return formatError;

  const { breached } = await checkPasswordBreached(password);
  if (breached) {
    return 'Toto heslo sa nachádza v zozname kompromitovaných hesiel z verejných únikov. Zvoľte iné heslo.';
  }

  return null;
}

module.exports = {
  validatePassword,
  validatePasswordFormat,
  checkPasswordBreached,
  MIN_LENGTH,
  MAX_LENGTH
};
