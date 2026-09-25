/**
 * messageFiles.js — spoločné helpery pre prílohy správ v Cloudflare R2.
 *
 * Prílohy správ (legacy `attachment`, `files[]`, `comments[].attachment`)
 * žijú v R2 pod kľúčom fileStorage.messageFileKey(id); v Message dokumente
 * ostávajú len metadáta + r2Key. Staršie záznamy (a base64 fallback bez R2)
 * majú blob priamo v `data`.
 *
 * Tento modul používajú:
 *   - routes/messages.js — verejný tvar prílohy pre klienta, zber kľúčov pri
 *     mazaní správy
 *   - kaskádové mazanie (routes/workspaces.js, auth.js, admin.js) — pred
 *     Message.deleteMany treba zmazať bloby, inak by v R2 ostali siroty
 *     bez metadát, ktoré už nikto nenájde
 */

const Message = require('../models/Message');
const fileStorage = require('./fileStorage');
const logger = require('../utils/logger');

// Len r2Key polia — bez base64 a bez textu správ/komentárov.
const R2_KEY_PROJECTION = {
  'attachment.r2Key': 1,
  'files.r2Key': 1,
  'comments.attachment.r2Key': 1
};

// Koľko blobov mažeme naraz (R2 rate limit; kaskáda pri mazaní účtu môže
// mať stovky príloh).
const DELETE_BATCH_SIZE = 20;

// Blob je stále v dokumente = nie je v R2. Podľa r2Key (metadáta), nie podľa
// `data`: zoznamy a detail správy base64 do pamäte zámerne neťahajú, takže
// prítomnosť `data` v projekcii nevidieť. Klient (Messages.jsx) podľa tohto
// príznaku ráta 16 MB strop dokumentu len pre nezmigrované správy.
const isInlineAttachment = (att) => !!att && !att.r2Key;

/**
 * Verejný tvar prílohy pre klienta: metadáta + `inline`. NIKDY r2Key ani
 * base64 `data` — r2Key je interný kľúč úložiska, data by nafúkli odpoveď
 * na megabajty.
 */
const publicAttachment = (att) => {
  if (!att) return att;
  return {
    id: att.id,
    originalName: att.originalName,
    mimetype: att.mimetype,
    size: att.size,
    uploadedAt: att.uploadedAt,
    inline: isInlineAttachment(att)
  };
};

/**
 * Všetky R2 kľúče v jednej správe (legacy príloha + files[] + prílohy
 * komentárov). Funguje na lean objekte aj na Mongoose dokumente.
 */
const collectMessageR2Keys = (doc) => {
  if (!doc) return [];
  const keys = [];
  if (doc.attachment?.r2Key) keys.push(doc.attachment.r2Key);
  for (const f of doc.files || []) if (f?.r2Key) keys.push(f.r2Key);
  for (const c of doc.comments || []) if (c?.attachment?.r2Key) keys.push(c.attachment.r2Key);
  return keys;
};

/**
 * Best-effort zmazanie blobov po dávkach. Nikdy nehádže — metadáta sú (alebo
 * o chvíľu budú) preč, pre používateľa je príloha zmazaná; sirota v R2 je
 * menšie zlo ako zlyhaný request. fileStorage.deleteFile sám chyby loguje.
 */
const deleteBlobs = async (keys) => {
  const list = (keys || []).filter(Boolean);
  if (!list.length || !fileStorage.isR2Available()) return;
  for (let i = 0; i < list.length; i += DELETE_BATCH_SIZE) {
    const batch = list.slice(i, i + DELETE_BATCH_SIZE);
    await Promise.all(batch.map(key =>
      Promise.resolve().then(() => fileStorage.deleteFile(key)).catch(() => {})
    ));
  }
};

/**
 * Zmaže bloby VŠETKÝCH správ zodpovedajúcich filtru. Volať tesne PRED
 * Message.deleteMany(filter) — po ňom už kľúče niet odkiaľ prečítať.
 * Projekcia ťahá len r2Key polia (žiadne base64, žiadny text). Nikdy nehádže.
 *
 * @returns {Promise<number>} počet kľúčov, ktoré sa pokúsilo zmazať
 */
const deleteMessageBlobs = async (filter) => {
  if (!filter || !fileStorage.isR2Available()) return 0;
  let deleted = 0;
  try {
    const cursor = Message.find(filter, R2_KEY_PROJECTION).lean().cursor();
    let pending = [];
    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      pending.push(...collectMessageR2Keys(doc));
      if (pending.length >= DELETE_BATCH_SIZE) {
        await deleteBlobs(pending);
        deleted += pending.length;
        pending = [];
      }
    }
    if (pending.length) {
      await deleteBlobs(pending);
      deleted += pending.length;
    }
  } catch (err) {
    logger.warn('[MessageFiles] Kaskádové mazanie blobov zlyhalo (metadáta sa mažú ďalej)', { error: err.message });
  }
  return deleted;
};

module.exports = {
  R2_KEY_PROJECTION,
  isInlineAttachment,
  publicAttachment,
  collectMessageR2Keys,
  deleteBlobs,
  deleteMessageBlobs
};
