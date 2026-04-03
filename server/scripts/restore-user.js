/**
 * One-time script to restore a user account that was overwritten by seed-admin.
 *
 * Usage:
 *   node scripts/restore-user.js
 *
 * Requires MONGODB_URI in .env or environment.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const USER_EMAIL = 'martin.kosco@eperun.sk';
const USER_USERNAME = 'martin.kosco';
const USER_PASSWORD = 'TempPass2026!';  // Temporary password — change after login

async function restoreUser() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const User = require('../models/User');

    // Check if user already exists
    const existing = await User.findOne({ email: USER_EMAIL });
    if (existing) {
      console.log('User already exists with this email. Resetting password...');
      const salt = await bcrypt.genSalt(12);
      existing.password = await bcrypt.hash(USER_PASSWORD, salt);
      await existing.save();
      console.log(`Password reset for: ${USER_EMAIL}`);
      console.log(`New password: ${USER_PASSWORD}`);
    } else {
      // Create new user
      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(USER_PASSWORD, salt);

      const user = new User({
        username: USER_USERNAME,
        email: USER_EMAIL,
        password: hashedPassword,
        color: '#6366F1',
        role: 'user'
      });
      await user.save();

      console.log(`User account created:`);
      console.log(`  Email: ${USER_EMAIL}`);
      console.log(`  Username: ${USER_USERNAME}`);
      console.log(`  Password: ${USER_PASSWORD}`);
    }

    console.log('\nDone. Change the password after login in profile settings!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

restoreUser();
