/**
 * Fix the calendarFeedToken index and create the super admin account.
 *
 * The old index was created without sparse:true, so two users with null
 * calendarFeedToken conflict. This script drops the old index and recreates
 * it as sparse, then creates the super admin account.
 *
 * Usage:
 *   node scripts/fix-index-and-create-admin.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SUPER_ADMIN_EMAIL = 'support@prplcrm.eu';
const SUPER_ADMIN_USERNAME = 'admin';
const SUPER_ADMIN_PASSWORD = 'PrplCRM@2026!Secure';

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('users');

    // Step 1: Drop the old non-sparse index
    try {
      await collection.dropIndex('calendarFeedToken_1');
      console.log('Dropped old calendarFeedToken_1 index');
    } catch (e) {
      console.log('Index calendarFeedToken_1 not found or already dropped:', e.message);
    }

    // Step 2: Recreate as sparse unique index
    await collection.createIndex(
      { calendarFeedToken: 1 },
      { unique: true, sparse: true }
    );
    console.log('Created new sparse unique index on calendarFeedToken');

    // Step 3: Create super admin if not exists
    const User = require('../models/User');
    const existing = await User.findOne({ email: SUPER_ADMIN_EMAIL });

    if (existing) {
      console.log(`Super admin already exists: ${existing.email}`);
    } else {
      const salt = await bcrypt.genSalt(12);
      const admin = new User({
        username: SUPER_ADMIN_USERNAME,
        email: SUPER_ADMIN_EMAIL,
        password: await bcrypt.hash(SUPER_ADMIN_PASSWORD, salt),
        color: '#8B5CF6',
        role: 'admin'
      });
      await admin.save();
      console.log(`\nCreated super admin:`);
      console.log(`  Email: ${SUPER_ADMIN_EMAIL}`);
      console.log(`  Username: ${SUPER_ADMIN_USERNAME}`);
      console.log(`  Password: ${SUPER_ADMIN_PASSWORD}`);
    }

    console.log('\nDone!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

run();
