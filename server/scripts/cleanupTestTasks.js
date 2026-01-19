// Script to delete tasks with "test" in their name
require('dotenv').config();
const mongoose = require('mongoose');
const Task = require('../models/Task');

const MONGODB_URI = process.env.MONGODB_URI;

async function cleanup() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    // Find tasks with "test" in title (case insensitive)
    const testTasks = await Task.find({ 
      title: { $regex: /test/i } 
    });

    console.log(`Found ${testTasks.length} tasks with "test" in name:`);
    testTasks.forEach(t => console.log(`  - "${t.title}" (dueDate: ${t.dueDate})`));

    if (testTasks.length > 0) {
      const result = await Task.deleteMany({ 
        title: { $regex: /test/i } 
      });
      console.log(`\nDeleted ${result.deletedCount} test tasks`);
    }

    await mongoose.disconnect();
    console.log('Done');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

cleanup();
