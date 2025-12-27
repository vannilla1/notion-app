const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;

const contactSchema = new mongoose.Schema({
  tasks: { type: Array, default: [] }
}, { strict: false });

const Contact = mongoose.model('Contact', contactSchema);

async function migrateTasks() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const contacts = await Contact.find({});
    console.log(`Found ${contacts.length} contacts`);

    let migratedCount = 0;

    for (const contact of contacts) {
      let modified = false;

      if (contact.tasks && contact.tasks.length > 0) {
        console.log(`\nContact: ${contact.name || contact._id}`);
        console.log(`  Tasks: ${contact.tasks.length}`);

        for (let i = 0; i < contact.tasks.length; i++) {
          const task = contact.tasks[i];

          // Add id if missing
          if (!task.id) {
            const newId = uuidv4();
            console.log(`  Task "${task.title}" - adding id: ${newId}`);
            contact.tasks[i].id = newId;
            modified = true;
            migratedCount++;
          } else {
            console.log(`  Task "${task.title}" - already has id: ${task.id}`);
          }

          // Migrate subtasks recursively
          if (task.subtasks && task.subtasks.length > 0) {
            const subtasksMigrated = migrateSubtasksRecursive(contact.tasks[i].subtasks, 1);
            if (subtasksMigrated > 0) {
              modified = true;
              migratedCount += subtasksMigrated;
            }
          }
        }

        if (modified) {
          contact.markModified('tasks');
          await contact.save();
          console.log(`  Saved contact with migrated tasks`);
        }
      }
    }

    console.log(`\n=== Migration complete ===`);
    console.log(`Migrated ${migratedCount} tasks/subtasks`);

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

function migrateSubtasksRecursive(subtasks, level) {
  let count = 0;
  const indent = '  '.repeat(level + 1);

  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];

    if (!subtask.id) {
      const newId = uuidv4();
      console.log(`${indent}Subtask "${subtask.title}" - adding id: ${newId}`);
      subtasks[i].id = newId;
      count++;
    }

    if (subtask.subtasks && subtask.subtasks.length > 0) {
      count += migrateSubtasksRecursive(subtask.subtasks, level + 1);
    }
  }

  return count;
}

migrateTasks();
