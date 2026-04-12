#!/usr/bin/env node
/**
 * Migration script: Move Base64 file data from embedded task/subtask files
 * to the ContactFile collection.
 *
 * This handles:
 * 1. Contact task files: contact.tasks[].files[].data
 * 2. Contact subtask files: contact.tasks[].subtasks[...recursive...].files[].data
 * 3. Global Task files: task.files[].data
 * 4. Global Task subtask files: task.subtasks[...recursive...].files[].data
 *
 * Usage:
 *   node server/scripts/migrateTaskFiles.js
 *
 * Reads MONGODB_URI from .env
 */

require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI not found in .env');
  process.exit(1);
}

const getDbName = (uri) => {
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return match ? match[1] : 'prplcrm';
};

/**
 * Recursively find all files with Base64 data in subtasks (any depth)
 */
function findFilesDeep(subtasks, path = '') {
  const found = [];
  if (!Array.isArray(subtasks)) return found;

  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i];
    const currentPath = path ? `${path}.subtasks[${i}]` : `subtasks[${i}]`;

    // Check files at this level
    if (Array.isArray(st.files)) {
      for (const file of st.files) {
        if (file.data && typeof file.data === 'string' && file.data.length > 100) {
          found.push({
            fileId: file.id,
            data: file.data,
            path: currentPath,
            size: file.data.length
          });
        }
      }
    }

    // Recurse into nested subtasks
    if (Array.isArray(st.subtasks) && st.subtasks.length > 0) {
      found.push(...findFilesDeep(st.subtasks, currentPath));
    }
  }
  return found;
}

/**
 * Recursively strip data field from all files in subtasks
 */
function stripFilesDeep(subtasks) {
  if (!Array.isArray(subtasks)) return false;
  let modified = false;

  for (const st of subtasks) {
    if (Array.isArray(st.files)) {
      for (const file of st.files) {
        if (file.data && typeof file.data === 'string' && file.data.length > 100) {
          delete file.data;
          modified = true;
        }
      }
    }
    if (Array.isArray(st.subtasks) && st.subtasks.length > 0) {
      if (stripFilesDeep(st.subtasks)) modified = true;
    }
  }
  return modified;
}

async function migrate() {
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(MONGODB_URI, {
    socketTimeoutMS: 300000,
    serverSelectionTimeoutMS: 30000,
  });

  try {
    await client.connect();
    const dbName = getDbName(MONGODB_URI);
    const db = client.db(dbName);
    const contactsColl = db.collection('contacts');
    const tasksColl = db.collection('tasks');
    const filesColl = db.collection('contactfiles');

    let totalMigrated = 0;
    let totalBytes = 0;

    // === 1. Contact task/subtask files ===
    console.log('\n=== Migrating Contact task/subtask files ===');
    const contactCursor = contactsColl.find({}).project({ _id: 1, name: 1, tasks: 1 });

    while (await contactCursor.hasNext()) {
      const contact = await contactCursor.next();
      if (!Array.isArray(contact.tasks) || contact.tasks.length === 0) continue;

      let contactModified = false;
      const contactId = contact._id;

      for (let ti = 0; ti < contact.tasks.length; ti++) {
        const task = contact.tasks[ti];

        // Check task-level files
        if (Array.isArray(task.files)) {
          for (const file of task.files) {
            if (file.data && typeof file.data === 'string' && file.data.length > 100) {
              try {
                await filesColl.updateOne(
                  { fileId: file.id },
                  { $setOnInsert: { contactId, fileId: file.id, data: file.data, createdAt: new Date(), updatedAt: new Date() } },
                  { upsert: true }
                );
                totalBytes += file.data.length;
                totalMigrated++;
                console.log(`  ✓ ${contact.name} → task "${task.title}" → ${file.originalName || file.id} (${(file.data.length / 1024).toFixed(1)} KB)`);
              } catch (err) {
                console.log(`  ⚠ Skip ${file.id}: ${err.message}`);
              }
              delete file.data;
              contactModified = true;
            }
          }
        }

        // Check subtask files (recursive)
        const deepFiles = findFilesDeep(task.subtasks || []);
        if (deepFiles.length > 0) {
          for (const df of deepFiles) {
            try {
              await filesColl.updateOne(
                { fileId: df.fileId },
                { $setOnInsert: { contactId, fileId: df.fileId, data: df.data, createdAt: new Date(), updatedAt: new Date() } },
                { upsert: true }
              );
              totalBytes += df.size;
              totalMigrated++;
              console.log(`  ✓ ${contact.name} → task "${task.title}" → ${df.path} → file ${df.fileId} (${(df.size / 1024).toFixed(1)} KB)`);
            } catch (err) {
              console.log(`  ⚠ Skip ${df.fileId}: ${err.message}`);
            }
          }
          stripFilesDeep(task.subtasks);
          contactModified = true;
        }
      }

      if (contactModified) {
        await contactsColl.updateOne(
          { _id: contactId },
          { $set: { tasks: contact.tasks } }
        );
        console.log(`  → ${contact.name}: saved\n`);
      }
    }

    // === 2. Global Task files ===
    console.log('\n=== Migrating Global Task files ===');
    const taskCursor = tasksColl.find({}).project({ _id: 1, title: 1, files: 1, subtasks: 1 });

    while (await taskCursor.hasNext()) {
      const task = await taskCursor.next();
      let taskModified = false;

      // Check task-level files
      if (Array.isArray(task.files)) {
        for (const file of task.files) {
          if (file.data && typeof file.data === 'string' && file.data.length > 100) {
            try {
              await filesColl.updateOne(
                { fileId: file.id },
                { $setOnInsert: { fileId: file.id, data: file.data, createdAt: new Date(), updatedAt: new Date() } },
                { upsert: true }
              );
              totalBytes += file.data.length;
              totalMigrated++;
              console.log(`  ✓ Global "${task.title}" → ${file.originalName || file.id} (${(file.data.length / 1024).toFixed(1)} KB)`);
            } catch (err) {
              console.log(`  ⚠ Skip ${file.id}: ${err.message}`);
            }
            delete file.data;
            taskModified = true;
          }
        }
      }

      // Check subtask files (recursive)
      const deepFiles = findFilesDeep(task.subtasks || []);
      if (deepFiles.length > 0) {
        for (const df of deepFiles) {
          try {
            await filesColl.updateOne(
              { fileId: df.fileId },
              { $setOnInsert: { fileId: df.fileId, data: df.data, createdAt: new Date(), updatedAt: new Date() } },
              { upsert: true }
            );
            totalBytes += df.size;
            totalMigrated++;
            console.log(`  ✓ Global "${task.title}" → ${df.path} → file ${df.fileId} (${(df.size / 1024).toFixed(1)} KB)`);
          } catch (err) {
            console.log(`  ⚠ Skip ${df.fileId}: ${err.message}`);
          }
        }
        stripFilesDeep(task.subtasks);
        taskModified = true;
      }

      if (taskModified) {
        const updateFields = {};
        if (task.files) updateFields.files = task.files;
        if (task.subtasks) updateFields.subtasks = task.subtasks;
        await tasksColl.updateOne({ _id: task._id }, { $set: updateFields });
        console.log(`  → Global "${task.title}": saved\n`);
      }
    }

    console.log('\n✅ Migration complete!');
    console.log(`   Files migrated: ${totalMigrated}`);
    console.log(`   Total data moved: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

migrate();
