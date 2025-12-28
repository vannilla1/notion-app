const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;

async function migrateTasks() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const contactsCollection = db.collection('contacts');

    const contacts = await contactsCollection.find({}).toArray();
    console.log(`Found ${contacts.length} contacts`);

    let migratedCount = 0;
    let duplicatesFixed = 0;

    for (const contact of contacts) {
      let modified = false;
      const seenIds = new Set();

      if (contact.tasks && contact.tasks.length > 0) {
        console.log(`\nContact: ${contact.name || contact._id}`);
        console.log(`  Tasks: ${contact.tasks.length}`);

        for (let i = 0; i < contact.tasks.length; i++) {
          const task = contact.tasks[i];

          // Add id if missing OR if duplicate
          if (!task.id) {
            const newId = uuidv4();
            console.log(`  Task "${task.title}" - adding id: ${newId}`);
            contact.tasks[i].id = newId;
            seenIds.add(newId);
            modified = true;
            migratedCount++;
          } else if (seenIds.has(task.id)) {
            // Duplicate ID found!
            const newId = uuidv4();
            console.log(`  Task "${task.title}" - DUPLICATE ID detected! Changing from ${task.id} to ${newId}`);
            contact.tasks[i].id = newId;
            seenIds.add(newId);
            modified = true;
            duplicatesFixed++;
          } else {
            console.log(`  Task "${task.title}" - already has id: ${task.id}`);
            seenIds.add(task.id);
          }

          // Migrate subtasks recursively
          if (task.subtasks && task.subtasks.length > 0) {
            const subtasksMigrated = migrateSubtasksRecursive(contact.tasks[i].subtasks, 1, seenIds);
            if (subtasksMigrated.count > 0) {
              modified = true;
              migratedCount += subtasksMigrated.count;
              duplicatesFixed += subtasksMigrated.duplicates;
            }
          }
        }

        if (modified) {
          // Use direct MongoDB update
          await contactsCollection.updateOne(
            { _id: contact._id },
            { $set: { tasks: contact.tasks } }
          );
          console.log(`  Saved contact with migrated tasks`);
        }
      }
    }

    console.log(`\n=== Migration complete ===`);
    console.log(`Migrated ${migratedCount} tasks/subtasks without IDs`);
    console.log(`Fixed ${duplicatesFixed} duplicate IDs`);

    // Verify migration
    console.log('\n=== Verifying migration ===');
    const verifyContacts = await contactsCollection.find({}).toArray();
    for (const contact of verifyContacts) {
      if (contact.tasks && contact.tasks.length > 0) {
        const allIds = new Set();
        for (const task of contact.tasks) {
          if (!task.id) {
            console.log(`WARNING: Task "${task.title}" in "${contact.name}" still missing id!`);
          } else if (allIds.has(task.id)) {
            console.log(`WARNING: Task "${task.title}" in "${contact.name}" has duplicate id: ${task.id}`);
          } else {
            allIds.add(task.id);
          }
        }
      }
    }

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

function migrateSubtasksRecursive(subtasks, level, seenIds) {
  let count = 0;
  let duplicates = 0;
  const indent = '  '.repeat(level + 1);

  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];

    if (!subtask.id) {
      const newId = uuidv4();
      console.log(`${indent}Subtask "${subtask.title}" - adding id: ${newId}`);
      subtasks[i].id = newId;
      seenIds.add(newId);
      count++;
    } else if (seenIds.has(subtask.id)) {
      const newId = uuidv4();
      console.log(`${indent}Subtask "${subtask.title}" - DUPLICATE ID detected! Changing from ${subtask.id} to ${newId}`);
      subtasks[i].id = newId;
      seenIds.add(newId);
      duplicates++;
    } else {
      seenIds.add(subtask.id);
    }

    if (subtask.subtasks && subtask.subtasks.length > 0) {
      const result = migrateSubtasksRecursive(subtask.subtasks, level + 1, seenIds);
      count += result.count;
      duplicates += result.duplicates;
    }
  }

  return { count, duplicates };
}

migrateTasks();
