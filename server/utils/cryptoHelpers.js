const crypto = require('crypto');
const logger = require('./logger');

/**
 * Audit MED-003: at-rest encryption pre OAuth tokeny v MongoDB.
 *
 * Predtým: googleCalendar.accessToken/refreshToken (a googleTasks ekvivalenty)
 * boli uložené ako plaintext stringy. DB dump → okamžitý prístup k Google
 * Calendar/Tasks API všetkých prepojených userov.
 *
 * Teraz: AES-256-GCM (authenticated encryption). Každý token má unikátnu
 * IV (12 bytes), zápis vyzerá: `enc:v1:<base64Iv>:<base64AuthTag>:<base64Ciphertext>`.
 * Prefix `enc:v1:` slúži aj na detekciu pre graceful migration — legacy
 * plaintext tokeny ostanú čitateľné kým ich Google flow neobnoví (vtedy sa
 * zapíšu už encrypted).
 *
 * Kľúč: `ENCRYPTION_KEY` env var, 32 bytes ako base64 (44 znakov) alebo
 * hex (64 znakov). Generovanie: `openssl rand -base64 32`.
 *
 * Bez `ENCRYPTION_KEY` server pokračuje v plaintext režime + raz pri boote
 * loguje warning (lazy migration — admin musí kľúč pridať do env keď je
 * pripravený). Nie process.exit(1) ako pri JWT_SECRET, lebo už máme
 * deployed produkciu bez kľúča a nesmie padnúť.
 */

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes = 96 bits, štandard pre GCM
const AUTH_TAG_LENGTH = 16;

let encryptionKey = null;
let warnedMissing = false;

const initKey = () => {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    if (!warnedMissing) {
      logger.warn('[Crypto] ENCRYPTION_KEY env var nie je nastavený — OAuth tokeny budú uložené v plaintext. Pre at-rest encryption nastav 32-byte base64 kľúč: `openssl rand -base64 32`');
      warnedMissing = true;
    }
    return null;
  }
  try {
    // Akceptujeme buď base64 (44 znakov) alebo hex (64 znakov)
    let keyBuffer;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      keyBuffer = Buffer.from(raw, 'hex');
    } else {
      keyBuffer = Buffer.from(raw, 'base64');
    }
    if (keyBuffer.length !== 32) {
      logger.error('[Crypto] ENCRYPTION_KEY má nesprávnu dĺžku — očakávam 32 bytov (base64 ~44 znakov alebo hex 64 znakov)', {
        actualLength: keyBuffer.length
      });
      return null;
    }
    return keyBuffer;
  } catch (err) {
    logger.error('[Crypto] ENCRYPTION_KEY parsing zlyhal', { error: err.message });
    return null;
  }
};

const getKey = () => {
  if (encryptionKey === null) {
    encryptionKey = initKey();
  }
  return encryptionKey;
};

const isEncrypted = (value) => {
  return typeof value === 'string' && value.startsWith(PREFIX);
};

/**
 * Encrypt plaintext token. Ak nie je dostupný encryption key, vráti
 * plaintext (graceful fallback). Volajúci nemusí riešiť edge cases —
 * `setterPipeline` v Mongoose hooku je idempotentný.
 */
const encryptToken = (plaintext) => {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // už encrypted — nezošifruj 2×

  const key = getKey();
  if (!key) return plaintext; // fallback do plaintext keď chýba kľúč

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
  } catch (err) {
    logger.error('[Crypto] Encryption failed', { error: err.message });
    return plaintext; // fail-open: lepšie plaintext ako stratený token
  }
};

/**
 * Decrypt encrypted token. Ak hodnota nemá `enc:v1:` prefix, vráti as-is
 * (legacy plaintext — gracefull migration). Ak je encrypted ale dekrypt
 * zlyhá (kľúč rotated, corrupt data), loguje + vráti null (volajúci
 * potom typically zruší connection a user musí znova prejsť OAuth flow).
 */
const decryptToken = (value) => {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncrypted(value)) return value; // legacy plaintext

  const key = getKey();
  if (!key) {
    logger.warn('[Crypto] Encrypted token v DB ale ENCRYPTION_KEY chýba — token nedostupný');
    return null;
  }

  try {
    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) {
      logger.error('[Crypto] Malformed encrypted token (zlý počet častí)');
      return null;
    }
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      logger.error('[Crypto] Encrypted token má neplatné IV/authTag dimenzie');
      return null;
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    logger.error('[Crypto] Decryption failed (kľúč rotated alebo corrupted data?)', { error: err.message });
    return null;
  }
};

module.exports = { encryptToken, decryptToken, isEncrypted };
