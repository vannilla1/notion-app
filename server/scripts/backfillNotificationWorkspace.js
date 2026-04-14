/**
 * Migration: backfill `workspaceId` on legacy Notification records.
 *
 * Before multi-workspace notification scoping was introduced, notifications
 * were stored with only { userId, relatedType, relatedId }. This script
 * looks up the related entity (contact, task, message) and copies its
 * workspaceId onto the notification so the bell + deep links can filter
 * and switch workspaces correctly.
 *
 * Safe to re-run — only touches records where workspaceId is missing.
 *
 * Usage:
 *   node scripts/backfillNotificationWorkspace.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const Notification = require('../models/Notification');
const Contact = require('../models/Contact');
const Task = require('../models/Task');
const Message = require('../models/Message');
const WorkspaceMember = require('../models/WorkspaceMember');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('[Backfill] MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('[Backfill] Connected to MongoDB');

  const total = await Notification.countDocuments({ workspaceId: { $in: [null, undefined] } });
  console.log(`[Backfill] Notifications missing workspaceId: ${total}`);
  if (total === 0) {
    await mongoose.disconnect();
    return;
  }

  let processed = 0;
  let updated = 0;
  let deleted = 0;

  const cursor = Notification.find({ workspaceId: { $in: [null, undefined] } }).cursor();

  for await (const notif of cursor) {
    processed++;
    let workspaceId = null;

    try {
      // Try to infer from data first (fastest path — new code always includes it)
      if (notif.data?.workspaceId) {
        workspaceId = notif.data.workspaceId;
      }
      // Fall back to looking up the related entity
      else if (notif.relatedType === 'contact' && notif.relatedId) {
        const c = await Contact.findById(notif.relatedId).select('workspaceId').lean();
        workspaceId = c?.workspaceId;
      }
      else if (notif.relatedType === 'task' && notif.relatedId) {
        const t = await Task.findById(notif.relatedId).select('workspaceId').lean();
        workspaceId = t?.workspaceId;
      }
      else if (notif.relatedType === 'subtask' && notif.data?.taskId) {
        const t = await Task.findById(notif.data.taskId).select('workspaceId').lean();
        workspaceId = t?.workspaceId;
        // Subtasks can also live on Contacts
        if (!workspaceId && notif.data?.contactId) {
          const c = await Contact.findById(notif.data.contactId).select('workspaceId').lean();
          workspaceId = c?.workspaceId;
        }
      }
      else if (notif.relatedType === 'message' && notif.relatedId) {
        const m = await Message.findById(notif.relatedId).select('workspaceId').lean();
        workspaceId = m?.workspaceId;
      }

      // Last resort: pick the user's first workspace (better than hiding)
      if (!workspaceId) {
        const membership = await WorkspaceMember.findOne({ userId: notif.userId })
          .select('workspaceId')
          .lean();
        workspaceId = membership?.workspaceId;
      }

      if (workspaceId) {
        await Notification.updateOne(
          { _id: notif._id },
          { $set: { workspaceId, 'data.workspaceId': workspaceId.toString() } }
        );
        updated++;
      } else {
        // Orphaned notification — related entity and user have no workspace.
        // Safe to delete since it's unreachable UI-wise.
        await Notification.deleteOne({ _id: notif._id });
        deleted++;
      }
    } catch (err) {
      console.error('[Backfill] Error processing', notif._id.toString(), err.message);
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
