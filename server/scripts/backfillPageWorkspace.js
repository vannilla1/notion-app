/**
 * Migration: backfill `workspaceId` on legacy Page records.
 *
 * Pages were originally scoped only by userId. The new model requires
 * workspaceId and access control is driven by WorkspaceMember membership.
 * This script assigns each legacy page to the creating user's first
 * workspace (oldest WorkspaceMember row). Orphaned pages (user has no
 * workspace at all) are deleted — they would be unreachable anyway.
 *
 * Safe to re-run — only touches records where workspaceId is missing.
 *
 * Usage:
 *   node scripts/backfillPageWorkspace.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const Page = require('../models/Page');
const WorkspaceMember = require('../models/WorkspaceMember');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('[Backfill] MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('[Backfill] Connected to MongoDB');

  const total = await Page.countDocuments({ workspaceId: { $in: [null, undefined] } });
  console.log(`[Backfill] Pages missing workspaceId: ${total}`);
  if (total === 0) {
    await mongoose.disconnect();
    return;
  }

  // Cache user → firstWorkspaceId to avoid repeated lookups
  const userWsCache = new Map();
  const getFirstWs = async (userId) => {
    const key = userId.toString();
    if (userWsCache.has(key)) return userWsCache.get(key);
    const member = await WorkspaceMember.findOne({ userId })
      .sort({ createdAt: 1 })
      .select('workspaceId')
      .lean();
    const ws = member?.workspaceId || null;
    userWsCache.set(key, ws);
    return ws;
  };

  let processed = 0, updated = 0, deleted = 0;
  const cursor = Page.find({ workspaceId: { $in: [null, undefined] } }).cursor();

  for await (const page of cursor) {
    processed++;
    try {
      const ws = await getFirstWs(page.userId);
      if (ws) {
        await Page.updateOne({ _id: page._id }, { $set: { workspaceId: ws } });
        updated++;
      } else {
        await Page.deleteOne({ _id: page._id });
        deleted++;
      }
    } catch (err) {
      console.error('[Backfill] Error', page._id.toString(), err.message);
    }
    if (processed % 100 === 0) {
      console.log(`[Backfill] Progress: ${processed}/${total} (updated=${updated}, deleted=${deleted})`);
    }
  }

  console.log(`[Backfill] Done. Processed=${processed}, Updated=${updated}, Deleted=${deleted}`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('[Backfill] Fatal error', err);
  process.exit(1);
});
