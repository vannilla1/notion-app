/**
 * messageFileMigration.js — base64 prílohy správ → Cloudflare R2
 *
 * Zrkadlí services/fileMigration.js (ContactFile), ale správa má prílohy na
 * TROCH miestach v jednom dokumente: legacy `attachment`, `files[]` a
 * `comments[].attachment`. Migruje sa po BLOBOCH, nie po správach — každý
 * blob je samostatný upload + samostatný atomický update, takže výpadok
 * uprostred správy nechá zvyšok nedotknutý a ďalší beh ho dorobí.
 *
 * Invarianty:
 *   - `data` sa NIKDY neodstráni bez overeného uploadu (fileExists HEAD)
 *   - jeden updateOne na blob: $set r2Key (+ id, ak chýba) a $unset data —
 *     arrayFilters pre files[] a comments[], nikdy prepis celého poľa
 *   - idempotentné a opakovateľné: vyberá len neprázdne inline `data`,
 *     update sa podmieňuje tým, že príloha je stále inline (r2Key null)
 *   - chyby per blob sa zbierajú, beh pokračuje
 *
 * Stav je module-level singleton (jedna migrácia naraz), poll-uje ho admin UI
 * cez getStatus(). Použiteľné z CLI (scripts/migrate-messages-to-r2.js) aj
 * z admin endpointu (POST /api/admin/migration/messages-to-r2).
 */

const { v4: uuidv4 } = require('uuid');
const Message = require('../models/Message');
const fileStorage = require('./fileStorage');
const logger = require('../utils/logger');

const BATCH_PAUSE_MS = 100; // pauza každých 10 blobov (R2 rate limit ochrana)
const BATCH_SIZE = 10;

// Správa má aspoň jeden inline blob (neprázdny base64 string). `$gt: ''` v
// dotaze porovnáva len hodnoty rovnakého typu (string), takže null/chýbajúce
// `data` nesedia; pri poliach stačí jeden prvok.
const INLINE_FILTER = {
  $or: [
    { 'attachment.data': { $gt: '' } },
    { 'files.data': { $gt: '' } },
    { 'comments.attachment.data': { $gt: '' } }
  ]
};

// Len to, čo migrácia potrebuje: prílohy + _id komentárov. Žiadny text
// správ/komentárov (súkromná komunikácia).
const MIGRATION_PROJECTION = {
  attachment: 1,
  files: 1,
  'comments._id': 1,
  'comments.attachment': 1
};

// Module-level state — singleton tracker. Iba jedna migrácia naraz.
const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  mode: null, // 'dry-run' alebo 'live'
  total: 0, // počet inline blobov na začiatku behu
  processed: 0,
  succeeded: 0,
  skipped: 0, // príloha sa medzitým zmenila/zmazala → nahraný blob zmazaný
  failed: 0,
  totalBytesMigrated: 0,
  errors: [], // [{ messageId, blob, message }]
  log: [] // user-facing progress messages (last 100)
};

const pushLog = (msg) => {
  state.log.push(`[${new Date().toISOString()}] ${msg}`);
  if (state.log.length > 100) state.log.shift();
};

function getStatus() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    mode: state.mode,
    total: state.total,
    processed: state.processed,
    succeeded: state.succeeded,
    skipped: state.skipped,
    failed: state.failed,
    totalBytesMigrated: state.totalBytesMigrated,
    estimatedMongoFreedMB: (state.totalBytesMigrated * 1.33 / 1024 / 1024).toFixed(2),
    errors: state.errors.slice(0, 20), // max 20 chýb v response
    log: state.log.slice(-30) // posledných 30 logov
  };
}

const hasInlineData = (att) => !!att && typeof att.data === 'string' && att.data.length > 0;

/**
 * Počet inline BLOBOV (nie správ), ktoré ešte čakajú na presun do R2 —
 * jedna správa môže mať legacy prílohu, viac files aj prílohy komentárov.
 * Agregácia ráta len neprázdne stringy (chýbajúce/null `data` sa v $gt
 * radia pod string, takže vyjdú 0).
 *
 * UI to volá pri otvorení Storage tabu — karta migrácie sa skryje pri 0.
 */
async function getPendingMigrationCount() {
  const rows = await Message.aggregate([
    { $match: INLINE_FILTER },
    {
      $project: {
        n: {
          $add: [
            { $cond: [{ $gt: ['$attachment.data', ''] }, 1, 0] },
            { $size: { $filter: { input: { $ifNull: ['$files', []] }, as: 'f', cond: { $gt: ['$$f.data', ''] } } } },
            { $size: { $filter: { input: { $ifNull: ['$comments', []] }, as: 'c', cond: { $gt: ['$$c.attachment.data', ''] } } } }
          ]
        }
      }
    },
    { $group: { _id: null, total: { $sum: '$n' } } }
  ]);
  return rows.length ? rows[0].total : 0;
}

function resetState(mode) {
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.mode = mode;
  state.total = 0;
  state.processed = 0;
  state.succeeded = 0;
  state.skipped = 0;
  state.failed = 0;
  state.totalBytesMigrated = 0;
  state.errors = [];
  state.log = [];
}

/**
 * Jeden blob: upload → HEAD overenie → JEDEN atomický update (set r2Key
 * [+ id], unset data). `applyUpdate(r2Key, id)` vráti výsledok updateOne;
 * podmienka „príloha je stále inline" je vo FILTRI, takže rozhoduje
 * matchedCount (modifiedCount nestačí — schéma má timestamps a updateOne by
 * updatedAt zmenil aj bez zásahu do prílohy; migrácia preto beží s
 * timestamps: false, aby správam nemenila čas úpravy). Ak filter nesedí
 * (príloha medzitým zmazaná/vymenená cez PUT, správa zmazaná), nahraný blob
 * sa hneď zmaže, aby v R2 neostala sirota. Chyba → collected, `data` ostáva.
 */
async function migrateBlob({ messageId, label, att, applyUpdate }) {
  state.processed++;
  const id = att.id || uuidv4();
  const r2Key = fileStorage.messageFileKey(id);
  const idStr = String(messageId);

  try {
    const buffer = Buffer.from(att.data, 'base64');

    await fileStorage.uploadFile(r2Key, buffer, att.mimetype || 'application/octet-stream');

    // Verify že dorazil (HEAD request, nestreamuje body) — až potom smie
    // z dokumentu zmiznúť base64.
    const exists = await fileStorage.fileExists(r2Key);
    if (!exists) throw new Error('R2 upload verification failed (fileExists returned false)');

    const result = await applyUpdate(r2Key, id);
    if (!result || !result.matchedCount) {
      await fileStorage.deleteFile(r2Key);
      state.skipped++;
      pushLog(`[${state.processed}/${state.total}] ${idStr} ${label} SKIP (príloha sa medzitým zmenila alebo zmizla)`);
      return;
    }

    state.succeeded++;
    state.totalBytesMigrated += buffer.length;
    pushLog(`[${state.processed}/${state.total}] ${idStr} ${label} OK (${(buffer.length / 1024).toFixed(1)} kB)`);
  } catch (err) {
    state.failed++;
    state.errors.push({ messageId: idStr, blob: label, message: err.message });
    pushLog(`[${state.processed}/${state.total}] ${idStr} ${label} FAIL: ${err.message}`);
    logger.warn('[MessageFileMigration] Blob failed', { messageId: idStr, blob: label, error: err.message });
  }

  // Rate-limit pauza každých 10 blobov
  if (state.processed % BATCH_SIZE === 0) {
    await new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
  }
}

/**
 * Hlavná migration funkcia.
 *
 * @param {Object} opts
 * @param {boolean} opts.dryRun — ak true, len spočíta bloby bez upload-u
 * @returns {Promise<Object>} — final status (rovnaký formát ako getStatus())
 */
async function runMessageFileMigration(opts = {}) {
  const dryRun = !!opts.dryRun;

  if (state.running) {
    throw new Error('Migration already running');
  }

  resetState(dryRun ? 'dry-run' : 'live');
  pushLog(`Migration started (mode: ${state.mode})`);
  logger.info('[MessageFileMigration] Started', { mode: state.mode });

  try {
    if (!fileStorage.isR2Available()) {
      throw new Error('R2 nie je nakonfigurované (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)');
    }
    pushLog(`R2 bucket: ${fileStorage.bucket}`);

    const totalMessages = await Message.countDocuments({});
    const messagesWithInline = await Message.countDocuments(INLINE_FILTER);
    const pendingBlobs = await getPendingMigrationCount();

    pushLog(`Total messages: ${totalMessages}`);
    pushLog(`Messages with inline attachments: ${messagesWithInline}`);
    pushLog(`Attachments (blobs) to migrate: ${pendingBlobs}`);

    state.total = pendingBlobs;

    if (pendingBlobs === 0) {
      pushLog('Nothing to migrate — všetky prílohy správ sú v R2.');
      return finishState();
    }

    if (dryRun) {
      pushLog(`[DRY RUN] Would migrate ${pendingBlobs} attachments from ${messagesWithInline} messages.`);
      return finishState();
    }

    // Cursor — jedna správa naraz (max 16 MB), žiadny RAM peak. Projekcia
    // bez textu správ a komentárov.
    const cursor = Message.find(INLINE_FILTER, MIGRATION_PROJECTION).lean().cursor();

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      const messageId = doc._id;

      // Legacy príloha — podmienka „stále inline" (r2Key null + data
      // neprázdne, + pôvodné id, ak ho mala), inak by $set po zmazaní prílohy
      // vytvoril fantóm { r2Key, id } bez názvu a veľkosti.
      if (hasInlineData(doc.attachment)) {
        const original = doc.attachment;
        await migrateBlob({
          messageId,
          label: 'attachment',
          att: original,
          applyUpdate: (r2Key, id) => Message.updateOne(
            {
              _id: messageId,
              'attachment.r2Key': null,
              'attachment.data': { $gt: '' },
              ...(original.id ? { 'attachment.id': original.id } : {})
            },
            { $set: { 'attachment.r2Key': r2Key, 'attachment.id': id }, $unset: { 'attachment.data': '' } },
            { timestamps: false }
          )
        });
      }

      for (const file of doc.files || []) {
        if (!hasInlineData(file)) continue;
        if (!file.id) {
          // Bez id sa prvok nedá bezpečne zacieliť (index by sa pri
          // súbežnom mazaní posunul) — nechávame, hlásime.
          state.processed++;
          state.failed++;
          state.errors.push({ messageId: String(messageId), blob: 'file', message: 'Súbor bez id — nedá sa zacieliť' });
          pushLog(`[${state.processed}/${state.total}] ${messageId} file FAIL: bez id`);
          continue;
        }
        await migrateBlob({
          messageId,
          label: `file:${file.id}`,
          att: file,
          applyUpdate: (r2Key) => Message.updateOne(
            { _id: messageId, files: { $elemMatch: { id: file.id, r2Key: null, data: { $gt: '' } } } },
            { $set: { 'files.$[f].r2Key': r2Key }, $unset: { 'files.$[f].data': '' } },
            { arrayFilters: [{ 'f.id': file.id, 'f.r2Key': null, 'f.data': { $gt: '' } }], timestamps: false }
          )
        });
      }

      for (const comment of doc.comments || []) {
        if (!hasInlineData(comment?.attachment)) continue;
        await migrateBlob({
          messageId,
          label: `comment:${comment._id}`,
          att: comment.attachment,
          applyUpdate: (r2Key, id) => Message.updateOne(
            { _id: messageId, comments: { $elemMatch: { _id: comment._id, 'attachment.r2Key': null, 'attachment.data': { $gt: '' } } } },
            {
              $set: { 'comments.$[c].attachment.r2Key': r2Key, 'comments.$[c].attachment.id': id },
              $unset: { 'comments.$[c].attachment.data': '' }
            },
            { arrayFilters: [{ 'c._id': comment._id, 'c.attachment.r2Key': null, 'c.attachment.data': { $gt: '' } }], timestamps: false }
          )
        });
      }
    }

    pushLog(`Migration complete: ${state.succeeded} succeeded, ${state.skipped} skipped, ${state.failed} failed`);
    pushLog(`Bytes migrated to R2: ${(state.totalBytesMigrated / 1024 / 1024).toFixed(2)} MB`);
    pushLog(`Estimated MongoDB freed: ${(state.totalBytesMigrated * 1.33 / 1024 / 1024).toFixed(2)} MB`);
    logger.info('[MessageFileMigration] Complete', {
      processed: state.processed,
      succeeded: state.succeeded,
      skipped: state.skipped,
      failed: state.failed,
      bytesMigrated: state.totalBytesMigrated
    });
  } catch (err) {
    pushLog(`FATAL: ${err.message}`);
    logger.error('[MessageFileMigration] Fatal error', { error: err.message, stack: err.stack });
    state.errors.push({ messageId: null, blob: null, message: `FATAL: ${err.message}` });
  }

  return finishState();
}

function finishState() {
  state.running = false;
  state.finishedAt = new Date().toISOString();
  return getStatus();
}

module.exports = {
  runMessageFileMigration,
  getStatus,
  getPendingMigrationCount,
  INLINE_FILTER
};
