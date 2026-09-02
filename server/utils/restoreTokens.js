/**
 * Obnovovacie tokeny pre Google Play zero-tap sign-in (Block Store).
 *
 * Token = 32 náhodných bajtov (base64url). V DB LEN SHA-256 hash. Platnosť
 * 180 dní, jednorazový (pri použití sa atomicky odstráni a vydá nový),
 * max 5 na používateľa (najstaršie vypadnú). Všetky zápisy sú atomické
 * Mongo update-y — bez VersionError pri paralelnom logine z dvoch zariadení
 * a bez replay race (dva súbežné POST /restore s tým istým tokenom → uspeje
 * presne jeden).
 *
 * Dizajn: docs/superpowers/specs/2026-09-02-play-zero-tap-block-store-design.md
 */
const crypto = require('crypto');
const User = require('../models/User');

const RESTORE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 dní
const MAX_RESTORE_TOKENS = 5;
const DEVICE_LABEL_MAX = 120;

const hashRestoreToken = (plaintext) =>
  crypto.createHash('sha256').update(String(plaintext)).digest('hex');

const generateRestoreToken = () => {
  const plaintext = crypto.randomBytes(32).toString('base64url');
  return { plaintext, tokenHash: hashRestoreToken(plaintext) };
};

const cleanLabel = (label) => String(label || '').trim().slice(0, DEVICE_LABEL_MAX);

/**
 * Vydá nový token používateľovi. Vráti { plaintext, expiresAt } alebo null,
 * ak používateľ neexistuje. Expirované záznamy odstráni, pole oreže na
 * MAX_RESTORE_TOKENS najnovších.
 */
const issueRestoreToken = async (userId, deviceLabel = '', now = new Date()) => {
  const { plaintext, tokenHash } = generateRestoreToken();
  const expiresAt = new Date(now.getTime() + RESTORE_TOKEN_TTL_MS);
  const entry = {
    tokenHash,
    expiresAt,
    createdAt: now,
    lastUsedAt: null,
    deviceLabel: cleanLabel(deviceLabel)
  };

  await User.updateOne(
    { _id: userId },
    { $pull: { restoreTokens: { expiresAt: { $lte: now } } } }
  );
  const result = await User.updateOne(
    { _id: userId },
    {
      $push: {
        restoreTokens: {
          $each: [entry],
          $sort: { createdAt: 1 },
          $slice: -MAX_RESTORE_TOKENS
        }
      }
    }
  );
  if (result.matchedCount === 0) return null;
  return { plaintext, expiresAt };
};

/**
 * Atomicky spotrebuje token (odstráni záznam). Vráti
 *   { ok: true, user, entry }  — hydrated User (bez avatarData) + použitý záznam
 *   { ok: false, reason: 'expired' | 'invalid' }
 */
const consumeRestoreToken = async (plaintext, now = new Date()) => {
  const tokenHash = hashRestoreToken(plaintext);
  const user = await User.findOneAndUpdate(
    { restoreTokens: { $elemMatch: { tokenHash, expiresAt: { $gt: now } } } },
    { $pull: { restoreTokens: { tokenHash } } },
    { new: false }
  ).select('+restoreTokens -avatarData');

  if (!user) {
    // Expirovaný záznam upraceme, aby pole nerástlo (a rozlíšime dôvod pre audit).
    const stale = await User.updateOne(
      { 'restoreTokens.tokenHash': tokenHash },
      { $pull: { restoreTokens: { tokenHash } } }
    );
    return { ok: false, reason: stale.matchedCount > 0 ? 'expired' : 'invalid' };
  }

  const entry = user.restoreTokens.find((t) => t.tokenHash === tokenHash) || null;
  return { ok: true, user, entry };
};

/** Zruší jeden token. Vráti vlastníka ({ _id, username, email }) alebo null. */
const revokeRestoreToken = async (plaintext) => {
  const tokenHash = hashRestoreToken(plaintext);
  return User.findOneAndUpdate(
    { 'restoreTokens.tokenHash': tokenHash },
    { $pull: { restoreTokens: { tokenHash } } },
    { new: false }
  ).select('_id username email');
};

/** Zruší všetky tokeny používateľa (zmena/reset hesla). */
const revokeAllRestoreTokens = (userId) =>
  User.updateOne({ _id: userId }, { $set: { restoreTokens: [] } });

module.exports = {
  RESTORE_TOKEN_TTL_MS,
  MAX_RESTORE_TOKENS,
  hashRestoreToken,
  generateRestoreToken,
  issueRestoreToken,
  consumeRestoreToken,
  revokeRestoreToken,
  revokeAllRestoreTokens
};
