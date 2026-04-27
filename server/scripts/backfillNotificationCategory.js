/**
 * Migration: backfill `category` field on legacy Notification records.
 *
 * Pred zavedením kategórií všetky notifikácie boli "neutrálne". Tento
 * script ich rozdelí podľa typu:
 *   - direct  : task.assigned, subtask.assigned, message.created,
 *               message.commented, message.comment.reacted
 *   - general : všetko ostatné (vrátane completion eventov, pretože pri
 *               historickom backfille nemáme spoľahlivo info o tom, či
 *               príjemca bol assignee — radšej bezpečnejší default)
 *
 * Bezpečné na opakované spustenie — upravuje len záznamy, ktoré ešte
 * nemajú vyplnenú kategóriu.
 *
 * Použitie:
 *   node scripts/backfillNotificationCategory.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const Notification = require('../models/Notification');

const DIRECT_TYPES = [
  'task.assigned',
  'subtask.assigned',
  'message.created',
  'message.commented',
  'message.comment.reacted'
];

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Missing MONGODB_URI / MONGO_URI env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('[backfill-category] connected');

  // Najprv nastav direct typy
  const directRes = await Notification.updateMany(
    {
      $or: [
        { category: { $exists: false } },
        { category: null }
      ],
      type: { $in: DIRECT_TYPES }
    },
    { $set: { category: 'direct' } }
  );

  // Všetko ostatné nastav na general
  const generalRes = await Notification.updateMany(
    {
      $or: [
        { category: { $exists: false } },
        { category: null }
      ]
    },
    { $set: { category: 'general' } }
  );

  console.log('[backfill-category] direct  updated:', directRes.modifiedCount);
  console.log('[backfill-category] general updated:', generalRes.modifiedCount);

  await mongoose.disconnect();
  console.log('[backfill-category] done');
}

if (require.main === module) {
  run().catch(err => {
    console.error('[backfill-category] error', err);
    process.exit(1);
  });
}

module.exports = { run };
