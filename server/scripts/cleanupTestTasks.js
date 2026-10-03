// Zmaže úlohy s "test" v názve v JEDNOM workspace.
//
// Predtým: Task.deleteMany({ title: /test/i }) naprieč všetkými workspace,
// hneď po pripojení — zasiahlo aj „Testovanie kotla“ reálnych zákazníkov.
// Teraz: povinný --workspace=<id>, celé slovo „test“, predvolene dry-run.
//
// Usage:
//   node scripts/cleanupTestTasks.js --workspace=<workspaceId>            (dry-run)
//   ALLOW_DESTRUCTIVE_SCRIPTS=true node scripts/cleanupTestTasks.js --workspace=<id> --confirm
require('dotenv').config();
const mongoose = require('mongoose');
const Task = require('../models/Task');
const { isDestructiveRunAllowed, explainDryRun, getArg } = require('./lib/destructiveGuard');

const MONGODB_URI = process.env.MONGODB_URI;
const TEST_TITLE = /\btest\b/i;

async function cleanup() {
  const workspaceId = getArg('workspace');
  if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
    console.error('Chýba alebo je neplatný --workspace=<workspaceId>');
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const filter = { workspaceId, title: { $regex: TEST_TITLE } };
    const testTasks = await Task.find(filter).select('title dueDate').lean();

    console.log(`Found ${testTasks.length} tasks with "test" in name:`);
    testTasks.forEach(t => console.log(`  - "${t.title}" (dueDate: ${t.dueDate})`));

    if (testTasks.length > 0) {
      if (isDestructiveRunAllowed()) {
        const result = await Task.deleteMany({ _id: { $in: testTasks.map(t => t._id) } });
        console.log(`Deleted ${result.deletedCount} tasks`);
      } else {
        explainDryRun(`Zmazanie ${testTasks.length} úloh`);
      }
    }

    await mongoose.disconnect();
    console.log('Done');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

cleanup();
