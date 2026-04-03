/**
 * One-time script to create or update the admin account.
 *
 * Usage:
 *   node scripts/seed-admin.js
 *
 * Requires MONGODB_URI in .env or environment.
 * Run this on the server or locally with access to production DB.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ADMIN_EMAIL = 'support@prplcrm.eu';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'PrplCRM@2026!Secure';

async function seedAdmin() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const User = require('../models/User');

    // Check if admin already exists — search by EMAIL, not by role
    let admin = await User.findOne({ email: ADMIN_EMAIL });

    if (admin) {
      // Update existing admin
      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, salt);

      admin.username = ADMIN_USERNAME;
      admin.password = hashedPassword;
      admin.role = 'admin';
      await admin.save();

      console.log(`Admin account updated:`);
      console.log(`  Email: ${ADMIN_EMAIL}`);
      console.log(`  Username: ${ADMIN_USERNAME}`);
      console.log(`  Password: ${ADMIN_PASSWORD}`);
    } else {
      // Create new admin
      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, salt);

      const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];

      admin = new User({
        username: ADMIN_USERNAME,
        email: ADMIN_EMAIL,
        password: hashedPassword,
        color: colors[Math.floor(Math.random() * colors.length)],
        role: 'admin'
      });
      await admin.save();

      console.log(`Admin account created:`);
      console.log(`  Email: ${ADMIN_EMAIL}`);
      console.log(`  Username: ${ADMIN_USERNAME}`);
      console.log(`  Password: ${ADMIN_PASSWORD}`);
    }

    console.log('\nDone. Change this password after first login!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

seedAdmin();
