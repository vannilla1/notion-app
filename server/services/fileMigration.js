/**
 * fileMigration.js — ContactFile.data (base64) → R2 migration logic
 *
 * Refaktorovaný z server/scripts/migrate-files-to-r2.js do reusable service.
 * Použiteľný z 2 miest:
 *   1. CLI script (server/scripts/migrate-files-to-r2.js) — pre lokálne behy
 *   2. Admin endpoint (POST /api/admin/migration/contactfiles-to-r2) —
 *      pre triggering priamo z Render (kde sú env vars už nastavené)
 *
 * Stav migrácie sa drží v module-level singleton — `getStatus()` ho vie
 * pollovať z admin UI bez DB queries. Stav je in-memory only → po restart-e
 * servera sa resetuje (acceptable lebo migrácia trvá ~2 min, nepravdepodobné
 * že prežije restart).
 */

const ContactFile = require('../models/ContactFile');
const fileStorage = require('./fileStorage');
const logger = require('../utils/logger');

const BATCH_PAUSE_MS = 100; // pauza každých 10 files (R2 rate limit ochrana)
const BATCH_SIZE = 10;

// Module-level state — singleton tracker. Iba jedna migrácia naraz.
const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  mode: null, // 'dry-run' alebo 'live'
  total: 0,
  processed: 0,
  succeeded: 0,
  failed: 0,
  totalBytesMigrated: 0,
  errors: [], // [{ fileId, message }]
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
    failed: state.failed,
    totalBytesMigrated: state.totalBytesMigrated,
    estimatedMongoFreedMB: (state.totalBytesMigrated * 1.33 / 1024 / 1024).toFixed(2),
    errors: state.errors.slice(0, 20), // max 20 chýb v response
    log: state.log.slice(-30) // posledných 30 logov
  };
}

function resetState(mode) {
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.mode = mode;
  state.total = 0;
  state.processed = 0;
  state.succeeded = 0;
  state.failed = 0;
  state.totalBytesMigrated = 0;
  state.errors = [];
  state.log = [];
}

/**
 * Hlavná migration funkcia.
 *
 * @param {Object} opts
 * @param {boolean} opts.dryRun — ak true, len spočíta dokumenty bez upload-u
 * @returns {Promise<Object>} — final status (rovnaký formát ako getStatus())
 */
async function runContactFileMigration(opts = {}) {
  const dryRun = !!opts.dryRun;

  if (state.running) {
    throw new Error('Migration already running');
  }

  resetState(dryRun ? 'dry-run' : 'live');
  pushLog(`Migration started (mode: ${state.mode})`);
  logger.info('[FileMigration] Started', { mode: state.mode });

  try {
    if (!fileStorage.isR2Available()) {
      throw new Error('R2 nie je nakonfigurované (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)');
    }
    pushLog(`R2 bucket: ${fileStorage.bucket}`);

    // Prehľad — koľko files potrebuje migráciu
    const totalCount = await ContactFile.countDocuments({});
    const alreadyMigrated = await ContactFile.countDocuments({ r2Key: { $ne: null } });
    const needsMigration = await ContactFile.countDocuments({
      r2Key: null,
      data: { $ne: null, $exists: true }
    });
    const broken = await ContactFile.countDocuments({
      r2Key: null,
      $or: [{ data: null }, { data: { $exists: false } }]
    });

    pushLog(`Total records: ${totalCount}`);
    pushLog(`Already migrated (r2Key set): ${alreadyMigrated}`);
    pushLog(`Needs migration: ${needsMigration}`);
    pushLog(`Broken (no data): ${broken}`);

    state.total = needsMigration;

    if (needsMigration === 0) {
      pushLog('Nothing to migrate — all files have r2Key or are broken.');
      return finishState();
    }

    if (dryRun) {
      pushLog(`[DRY RUN] Would migrate ${needsMigration} files.`);
      return finishState();
    }

    // Cursor-based iteration — žiadny RAM peak pri veľkých files
    const cursor = ContactFile.find({
      r2Key: null,
      data: { $ne: null, $exists: true }
    }).cursor();

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      state.processed++;
      const fileId = doc.fileId;
      const r2Key = fileStorage.contactFileKey(fileId);
      const dataLen = doc.data?.length || 0;

      try {
        const buffer = Buffer.from(doc.data, 'base64');

        // Upload do R2
        await fileStorage.uploadFile(r2Key, buffer, 'application/octet-stream');

        // Verify že dorazil (defensive — HEAD request, nestreamuje body)
        const exists = await fileStorage.fileExists(r2Key);
        if (!exists) throw new Error('R2 upload verification failed (fileExists returned false)');

        // Update DB: set r2Key, unset data
        await ContactFile.updateOne(
          { _id: doc._id },
          { $set: { r2Key }, $unset: { data: '' } }
        );

        state.succeeded++;
        state.totalBytesMigrated += buffer.length;
        pushLog(`[${state.processed}/${state.total}] ${fileId} OK (${(buffer.length / 1024).toFixed(1)} kB)`);
      } catch (err) {
        state.failed++;
        state.errors.push({ fileId, message: err.message });
        pushLog(`[${state.processed}/${state.total}] ${fileId} FAIL: ${err.message}`);
        logger.warn('[FileMigration] File failed', { fileId, error: err.message });
      }

      // Rate-limit pauza každých 10 files
      if (state.processed % BATCH_SIZE === 0) {
        await new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    pushLog(`Migration complete: ${state.succeeded} succeeded, ${state.failed} failed`);
    pushLog(`Bytes migrated to R2: ${(state.totalBytesMigrated / 1024 / 1024).toFixed(2)} MB`);
    pushLog(`Estimated MongoDB freed: ${(state.totalBytesMigrated * 1.33 / 1024 / 1024).toFixed(2)} MB`);
    logger.info('[FileMigration] Complete', {
      processed: state.processed,
      succeeded: state.succeeded,
      failed: state.failed,
      bytesMigrated: state.totalBytesMigrated
    });
  } catch (err) {
    pushLog(`FATAL: ${err.message}`);
    logger.error('[FileMigration] Fatal error', { error: err.message, stack: err.stack });
    state.errors.push({ fileId: null, message: `FATAL: ${err.message}` });
  }

  return finishState();
}

function finishState() {
  state.running = false;
  state.finishedAt = new Date().toISOString();
  return getStatus();
}

module.exports = {
  runContactFileMigration,
  getStatus
};
