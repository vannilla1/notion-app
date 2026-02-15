/**
 * Migration script: Add workspace support to existing data
 *
 * This script:
 * 1. Creates a default workspace for existing data
 * 2. Assigns all existing users as members of this workspace
 * 3. Updates all contacts and tasks with the workspace ID
 *
 * Run with: node server/scripts/migrateToWorkspaces.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/database');
const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const User = require('../models/User');
const Contact = require('../models/Contact');
const Task = require('../models/Task');

const DEFAULT_WORKSPACE_NAME = 'Purple CRM';
const DEFAULT_WORKSPACE_SLUG = 'purple-crm';

async function migrate() {
  try {
    console.log('🚀 Starting workspace migration...\n');

    // Connect to database
    await connectDB();
    console.log('✅ Connected to database\n');

    // Check if migration already done
    const existingWorkspace = await Workspace.findOne({ slug: DEFAULT_WORKSPACE_SLUG });
    if (existingWorkspace) {
      console.log('⚠️  Default workspace already exists. Checking for unmigrated data...\n');

      // Check for contacts/tasks without workspaceId
      const contactsWithoutWorkspace = await Contact.countDocuments({ workspaceId: { $exists: false } });
      const tasksWithoutWorkspace = await Task.countDocuments({ workspaceId: { $exists: false } });

      if (contactsWithoutWorkspace === 0 && tasksWithoutWorkspace === 0) {
        console.log('✅ All data already migrated. Nothing to do.\n');
        process.exit(0);
      }

      console.log(`Found ${contactsWithoutWorkspace} contacts and ${tasksWithoutWorkspace} tasks without workspace.\n`);

      // Migrate remaining data
      if (contactsWithoutWorkspace > 0) {
        const result = await Contact.updateMany(
          { workspaceId: { $exists: false } },
          { $set: { workspaceId: existingWorkspace._id } }
        );
        console.log(`✅ Migrated ${result.modifiedCount} contacts to default workspace`);
      }

      if (tasksWithoutWorkspace > 0) {
        const result = await Task.updateMany(
          { workspaceId: { $exists: false } },
          { $set: { workspaceId: existingWorkspace._id } }
        );
        console.log(`✅ Migrated ${result.modifiedCount} tasks to default workspace`);
      }

      // Check for users without membership
      const members = await WorkspaceMember.find({ workspaceId: existingWorkspace._id });
      const memberUserIds = members.map(m => m.userId.toString());
      const allUsers = await User.find({});

      for (const user of allUsers) {
        if (!memberUserIds.includes(user._id.toString())) {
          const membership = new WorkspaceMember({
            workspaceId: existingWorkspace._id,
            userId: user._id,
            role: user.role === 'admin' ? 'admin' : 'member'
          });
          await membership.save();

          // Set current workspace
          await User.findByIdAndUpdate(user._id, { currentWorkspaceId: existingWorkspace._id });
          console.log(`✅ Added user ${user.username} to workspace`);
        }
      }

      console.log('\n✅ Migration completed!\n');
      process.exit(0);
    }

    // Get all users
    const users = await User.find({});
    console.log(`Found ${users.length} users\n`);

    if (users.length === 0) {
      console.log('No users found. Migration not needed.\n');
      process.exit(0);
    }

    // Find first admin or first user to be owner
    const owner = users.find(u => u.role === 'admin') || users[0];
    console.log(`Owner will be: ${owner.username} (${owner.email})\n`);

    // Create default workspace
    const inviteCode = Workspace.generateInviteCode();
    const workspace = new Workspace({
      name: DEFAULT_WORKSPACE_NAME,
      slug: DEFAULT_WORKSPACE_SLUG,
      description: 'Predvolené pracovné prostredie vytvorené počas migrácie',
      ownerId: owner._id,
      inviteCode,
      inviteCodeEnabled: true,
      color: '#6366f1'
    });

    await workspace.save();
    console.log(`✅ Created workspace: ${workspace.name} (${workspace.slug})`);
    console.log(`   Invite code: ${workspace.inviteCode}\n`);

    // Create memberships for all users
    for (const user of users) {
      const isOwner = user._id.toString() === owner._id.toString();
      const membership = new WorkspaceMember({
        workspaceId: workspace._id,
        userId: user._id,
        role: isOwner ? 'owner' : (user.role === 'admin' ? 'admin' : 'member')
      });

      await membership.save();

      // Set current workspace for user
      await User.findByIdAndUpdate(user._id, { currentWorkspaceId: workspace._id });

      console.log(`✅ Added ${user.username} as ${membership.role}`);
    }
    console.log('');

    // Migrate contacts
    const contactsResult = await Contact.updateMany(
      {},
      { $set: { workspaceId: workspace._id } }
    );
    console.log(`✅ Migrated ${contactsResult.modifiedCount} contacts`);

    // Migrate tasks
    const tasksResult = await Task.updateMany(
      {},
      { $set: { workspaceId: workspace._id } }
    );
    console.log(`✅ Migrated ${tasksResult.modifiedCount} tasks`);

    console.log('\n========================================');
    console.log('🎉 Migration completed successfully!');
    console.log('========================================\n');
    console.log(`Workspace: ${workspace.name}`);
    console.log(`Invite code: ${workspace.inviteCode}`);
    console.log(`Members: ${users.length}`);
    console.log(`Contacts: ${contactsResult.modifiedCount}`);
    console.log(`Tasks: ${tasksResult.modifiedCount}`);
    console.log('\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

migrate();
