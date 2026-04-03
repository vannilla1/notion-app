/**
 * One-time script to fix the damage caused by seed-admin.js
 *
 * The seed-admin script found the first user with role:'admin' (vannilla / martin.kosco@eperun.sk)
 * and overwrote their email/username/password to support@prplcrm.eu.
 *
 * This script:
 * 1. Finds that overwritten account (now support@prplcrm.eu)
 * 2. Restores it back to vannilla / martin.kosco@eperun.sk with a temp password
 * 3. Sets role back to 'user' (regular CRM user)
 * 4. Creates a NEW separate super admin account (support@prplcrm.eu)
 *
 * Usage:
 *   node scripts/restore-user.js
 *
 * Requires MONGODB_URI in .env or environment.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SUPER_ADMIN_EMAIL = 'support@prplcrm.eu';
const SUPER_ADMIN_USERNAME = 'admin';
const SUPER_ADMIN_PASSWORD = 'PrplCRM@2026!Secure';

const RESTORED_EMAIL = 'martin.kosco@eperun.sk';
const RESTORED_USERNAME = 'vannilla';
const RESTORED_PASSWORD = 'TempPass2026!';  // Temporary — change after login!

async function restore() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const User = require('../models/User');

    // Step 1: Find the overwritten account
    const overwritten = await User.findOne({ email: SUPER_ADMIN_EMAIL });

    if (overwritten) {
      console.log(`Found overwritten account: ${overwritten.username} / ${overwritten.email} (id: ${overwritten._id})`);

      // Restore original data
      const salt1 = await bcrypt.genSalt(12);
      overwritten.email = RESTORED_EMAIL;
      overwritten.username = RESTORED_USERNAME;
      overwritten.password = await bcrypt.hash(RESTORED_PASSWORD, salt1);
      overwritten.role = 'user';
      await overwritten.save();

      console.log(`\nRestored user account:`);
      console.log(`  ID: ${overwritten._id} (same as before — workspace memberships preserved)`);
      console.log(`  Email: ${RESTORED_EMAIL}`);
      console.log(`  Username: ${RESTORED_USERNAME}`);
      console.log(`  Password: ${RESTORED_PASSWORD}`);
      console.log(`  Role: user`);
    } else {
      console.log('No account found with support@prplcrm.eu — checking if vannilla already exists...');
      const existing = await User.findOne({ email: RESTORED_EMAIL });
      if (existing) {
        console.log(`Account ${RESTORED_EMAIL} already exists. Resetting password...`);
        const salt = await bcrypt.genSalt(12);
        existing.password = await bcrypt.hash(RESTORED_PASSWORD, salt);
        existing.username = RESTORED_USERNAME;
        await existing.save();
        console.log(`Password reset. New password: ${RESTORED_PASSWORD}`);
      } else {
        console.log('No account found to restore. Creating new user...');
        const salt = await bcrypt.genSalt(12);
        const user = new User({
          username: RESTORED_USERNAME,
          email: RESTORED_EMAIL,
          password: await bcrypt.hash(RESTORED_PASSWORD, salt),
          color: '#6366F1',
          role: 'user'
        });
        await user.save();
        console.log(`Created user: ${RESTORED_EMAIL} / ${RESTORED_PASSWORD}`);
      }
    }

    // Step 2: Create a NEW separate super admin account
    const existingAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL });
    if (!existingAdmin) {
      const salt2 = await bcrypt.genSalt(12);
      const admin = new User({
        username: SUPER_ADMIN_USERNAME,
        email: SUPER_ADMIN_EMAIL,
        password: await bcrypt.hash(SUPER_ADMIN_PASSWORD, salt2),
        color: '#8B5CF6',
        role: 'admin'
      });
      await admin.save();

      console.log(`\nCreated NEW super admin account:`);
      console.log(`  Email: ${SUPER_ADMIN_EMAIL}`);
      console.log(`  Username: ${SUPER_ADMIN_USERNAME}`);
      console.log(`  Password: ${SUPER_ADMIN_PASSWORD}`);
    } else {
      console.log(`\nSuper admin account already exists (${SUPER_ADMIN_EMAIL})`);
    }

    console.log('\n--- DONE ---');
    console.log('Change the user password after login in profile settings!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

restore();
