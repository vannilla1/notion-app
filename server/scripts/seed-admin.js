/**
 * One-time script to create or update the admin account.
 *
 * Usage:
 *   SEED_ADMIN_PASSWORD=… node scripts/seed-admin.js
 *   (voliteľne SEED_ADMIN_EMAIL, SEED_ADMIN_USERNAME)
 *
 * Requires MONGODB_URI in .env or environment.
 * Run this on the server or locally with access to production DB.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'support@prplcrm.eu';
const ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME || 'admin';
// Heslo NIKDY v kóde (predtým bolo napevno v repozitári) — len z env.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('SEED_ADMIN_PASSWORD musí byť nastavené (min. 12 znakov).');
  process.exit(1);
}

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
      // Zmena hesla odhlási existujúce relácie (JWT claim tv).
      admin.tokenVersion = (admin.tokenVersion || 0) + 1;
      admin.role = 'admin';
      await admin.save();

      console.log(`Admin account updated:`);
      console.log(`  Email: ${ADMIN_EMAIL}`);
      console.log(`  Username: ${ADMIN_USERNAME}`);
      console.log('  Password: (zo SEED_ADMIN_PASSWORD)');
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
      console.log('  Password: (zo SEED_ADMIN_PASSWORD)');
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
