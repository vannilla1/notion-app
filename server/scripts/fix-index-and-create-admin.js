/**
 * Fix the calendarFeedToken index (idempotent).
 *
 * The old index was created without sparse:true, so two users with null
 * calendarFeedToken conflict. This script drops the old index and recreates
 * it as sparse.
 *
 * Vytvorenie super admin účtu bolo zo skriptu odstránené — malo napevno
 * zapísané heslo v repozitári. Admin účet: scripts/seed-admin.js
 * (heslo zo SEED_ADMIN_PASSWORD).
 *
 * Usage:
 *   node scripts/fix-index-and-create-admin.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const collection = mongoose.connection.db.collection('users');

    // Step 1: Drop the old non-sparse index
    try {
      await collection.dropIndex('calendarFeedToken_1');
      console.log('Dropped old calendarFeedToken_1 index');
    } catch (e) {
      console.log('Old index not found (OK):', e.message);
    }

    // Step 2: Recreate as sparse unique index
    await collection.createIndex(
      { calendarFeedToken: 1 },
      { unique: true, sparse: true }
    );
    console.log('Created sparse unique index on calendarFeedToken');

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

run();
