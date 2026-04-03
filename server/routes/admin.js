const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateToken } = require('../middleware/auth');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const logger = require('../utils/logger');

const router = express.Router();

// Middleware: require super admin (only support@prplcrm.eu)
const SUPER_ADMIN_EMAIL = 'support@prplcrm.eu';

// ─── ADMIN LOGIN (separate from regular auth) ──────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (email !== SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ message: 'Prístup zamietnutý' });
    }

    const user = await User.findOne({ email: SUPER_ADMIN_EMAIL });
    if (!user) {
      return res.status(403).json({ message: 'Prístup zamietnutý' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Nesprávne heslo' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '4h' });

    logger.info('Admin login', { userId: user._id });
    res.json({ token, user: { id: user._id, email: user.email, username: user.username } });
  } catch (error) {
    logger.error('Admin login error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

const requireAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.email !== SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ message: 'Prístup zamietnutý' });
    }
    req.adminUser = user;
    next();
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
};

// ─── OVERVIEW STATS ─────────────────────────────────────────────
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Exclude super admin from all stats
    const excludeSuperAdmin = { email: { $ne: SUPER_ADMIN_EMAIL } };

    const [
      totalUsers,
      totalWorkspaces,
      totalTasks,
      totalContacts,
      usersWithGoogleCalendar,
      usersWithGoogleTasks
    ] = await Promise.all([
      User.countDocuments(excludeSuperAdmin),
      Workspace.countDocuments(),
      Task.countDocuments(),
      Contact.countDocuments(),
      User.countDocuments({ ...excludeSuperAdmin, 'googleCalendar.enabled': true }),
      User.countDocuments({ ...excludeSuperAdmin, 'googleTasks.enabled': true })
    ]);

    // Plan breakdown (exclude super admin)
    const planBreakdown = await User.aggregate([
      { $match: excludeSuperAdmin },
      { $group: { _id: '$subscription.plan', count: { $sum: 1 } } }
    ]);

    // Role breakdown (exclude super admin)
    const roleBreakdown = await User.aggregate([
      { $match: excludeSuperAdmin },
      { $group: { _id: '$role', count: { $sum: 1 } } }
    ]);

    // Recent registrations (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentRegistrations = await User.countDocuments({
      ...excludeSuperAdmin,
      createdAt: { $gte: thirtyDaysAgo }
    });

    // Active workspaces (have at least 1 task or contact)
    const activeWorkspaceIds = await Task.distinct('workspaceId');
    const activeWorkspaceIdsContacts = await Contact.distinct('workspaceId');
    const allActiveIds = new Set([
      ...activeWorkspaceIds.map(id => id.toString()),
      ...activeWorkspaceIdsContacts.map(id => id.toString())
    ]);

    res.json({
      totalUsers,
      totalWorkspaces,
      activeWorkspaces: allActiveIds.size,
      totalTasks,
      totalContacts,
      usersWithGoogleCalendar,
      usersWithGoogleTasks,
      recentRegistrations,
      planBreakdown: planBreakdown.reduce((acc, item) => {
        acc[item._id || 'free'] = item.count;
        return acc;
      }, {}),
      roleBreakdown: roleBreakdown.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {})
    });
  } catch (error) {
    logger.error('Admin stats error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri načítaní štatistík' });
  }
});

// ─── ALL USERS (system-wide) ────────────────────────────────────
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Exclude super admin from the user list
    const users = await User.find(
      { email: { $ne: SUPER_ADMIN_EMAIL } },
      'username email color avatar role subscription currentWorkspaceId googleCalendar.enabled googleTasks.enabled createdAt'
    ).sort({ createdAt: -1 }).lean();

    // Get workspace memberships for each user
    const userIds = users.map(u => u._id);
    const memberships = await WorkspaceMember.find({ userId: { $in: userIds } })
      .populate('workspaceId', 'name slug')
      .lean();

    // Group memberships by userId
    const membershipMap = {};
    for (const m of memberships) {
      const uid = m.userId.toString();
      if (!membershipMap[uid]) membershipMap[uid] = [];
      if (m.workspaceId) {
        membershipMap[uid].push({
          workspaceId: m.workspaceId._id,
          name: m.workspaceId.name,
          slug: m.workspaceId.slug,
          role: m.role
        });
      }
    }

    const result = users.map(u => ({
      id: u._id,
      username: u.username,
      email: u.email,
      color: u.color,
      avatar: u.avatar,
      role: u.role,
      plan: u.subscription?.plan || 'free',
      googleCalendar: u.googleCalendar?.enabled || false,
      googleTasks: u.googleTasks?.enabled || false,
      createdAt: u.createdAt,
      workspaces: membershipMap[u._id.toString()] || []
    }));

    res.json(result);
  } catch (error) {
    logger.error('Admin get users error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri načítaní používateľov' });
  }
});

// ─── UPDATE USER ROLE (system-wide) ─────────────────────────────
router.put('/users/:userId/role', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'manager', 'user'].includes(role)) {
      return res.status(400).json({ message: 'Neplatná rola' });
    }

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).json({ message: 'Používateľ nenájdený' });
    }

    // Prevent removing own admin role
    if (req.params.userId === req.user.id && role !== 'admin') {
      return res.status(400).json({ message: 'Nemôžete odstrániť vlastnú admin rolu' });
    }

    targetUser.role = role;
    await targetUser.save();

    logger.info('Admin role change', { targetUserId: req.params.userId, newRole: role, changedBy: req.user.id });

    res.json({ message: 'Rola bola aktualizovaná', role });
  } catch (error) {
    logger.error('Admin role change error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri zmene role' });
  }
});

// ─── UPDATE USER PLAN ───────────────────────────────────────────
router.put('/users/:userId/plan', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!['free', 'team', 'pro', 'trial'].includes(plan)) {
      return res.status(400).json({ message: 'Neplatný plán' });
    }

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).json({ message: 'Používateľ nenájdený' });
    }

    targetUser.subscription = { plan };
    await targetUser.save();

    logger.info('Admin plan change', { targetUserId: req.params.userId, newPlan: plan, changedBy: req.user.id });

    res.json({ message: 'Plán bol aktualizovaný', plan });
  } catch (error) {
    logger.error('Admin plan change error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri zmene plánu' });
  }
});

// ─── DELETE USER ────────────────────────────────────────────────
router.delete('/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ message: 'Nemôžete vymazať vlastný účet' });
    }

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).json({ message: 'Používateľ nenájdený' });
    }

    if (targetUser.role === 'admin') {
      return res.status(400).json({ message: 'Nemôžete vymazať iného admina' });
    }

    // Remove workspace memberships
    await WorkspaceMember.deleteMany({ userId: targetUser._id });

    // Delete user
    await User.findByIdAndDelete(targetUser._id);

    logger.info('Admin delete user', { targetUserId: req.params.userId, deletedBy: req.user.id });

    // Notify via socket
    const io = req.app.get('io');
    if (io) {
      io.to(`user-${req.params.userId}`).emit('user-deleted');
    }

    res.json({ message: 'Používateľ bol vymazaný' });
  } catch (error) {
    logger.error('Admin delete user error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri mazaní používateľa' });
  }
});

// ─── ALL WORKSPACES ─────────────────────────────────────────────
router.get('/workspaces', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const workspaces = await Workspace.find().sort({ createdAt: -1 }).lean();

    // Get member counts and owner info
    const workspaceIds = workspaces.map(w => w._id);
    const memberCounts = await WorkspaceMember.aggregate([
      { $match: { workspaceId: { $in: workspaceIds } } },
      { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
    ]);
    const memberCountMap = {};
    for (const mc of memberCounts) {
      memberCountMap[mc._id.toString()] = mc.count;
    }

    // Get task/contact counts per workspace
    const taskCounts = await Task.aggregate([
      { $match: { workspaceId: { $in: workspaceIds } } },
      { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
    ]);
    const taskCountMap = {};
    for (const tc of taskCounts) {
      taskCountMap[tc._id.toString()] = tc.count;
    }

    const contactCounts = await Contact.aggregate([
      { $match: { workspaceId: { $in: workspaceIds } } },
      { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
    ]);
    const contactCountMap = {};
    for (const cc of contactCounts) {
      contactCountMap[cc._id.toString()] = cc.count;
    }

    // Get owner usernames
    const ownerIds = [...new Set(workspaces.map(w => w.ownerId.toString()))];
    const owners = await User.find({ _id: { $in: ownerIds } }, 'username email').lean();
    const ownerMap = {};
    for (const o of owners) {
      ownerMap[o._id.toString()] = { username: o.username, email: o.email };
    }

    const result = workspaces.map(w => ({
      id: w._id,
      name: w.name,
      slug: w.slug,
      color: w.color,
      owner: ownerMap[w.ownerId.toString()] || { username: '?', email: '?' },
      memberCount: memberCountMap[w._id.toString()] || 0,
      taskCount: taskCountMap[w._id.toString()] || 0,
      contactCount: contactCountMap[w._id.toString()] || 0,
      paidSeats: w.paidSeats || 0,
      createdAt: w.createdAt
    }));

    res.json(result);
  } catch (error) {
    logger.error('Admin get workspaces error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri načítaní workspace-ov' });
  }
});

// ─── SYNC DIAGNOSTICS ───────────────────────────────────────────
router.get('/sync-diagnostics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Get all users with Google integrations enabled
    const usersWithSync = await User.find(
      {
        $or: [
          { 'googleCalendar.enabled': true },
          { 'googleTasks.enabled': true }
        ]
      },
      'username email googleCalendar.enabled googleCalendar.connectedAt googleCalendar.syncedTaskIds googleCalendar.watchExpiry googleTasks.enabled googleTasks.connectedAt googleTasks.syncedTaskIds googleTasks.lastSyncAt googleTasks.quotaUsedToday googleTasks.quotaResetDate'
    ).lean();

    const diagnostics = usersWithSync.map(u => {
      const calSyncedCount = u.googleCalendar?.syncedTaskIds
        ? Object.keys(u.googleCalendar.syncedTaskIds).length
        : 0;
      const tasksSyncedCount = u.googleTasks?.syncedTaskIds
        ? Object.keys(u.googleTasks.syncedTaskIds).length
        : 0;

      return {
        id: u._id,
        username: u.username,
        email: u.email,
        calendar: u.googleCalendar?.enabled ? {
          enabled: true,
          connectedAt: u.googleCalendar.connectedAt,
          syncedCount: calSyncedCount,
          watchExpiry: u.googleCalendar.watchExpiry,
          watchActive: u.googleCalendar.watchExpiry ? new Date(u.googleCalendar.watchExpiry) > new Date() : false
        } : { enabled: false },
        tasks: u.googleTasks?.enabled ? {
          enabled: true,
          connectedAt: u.googleTasks.connectedAt,
          syncedCount: tasksSyncedCount,
          lastSyncAt: u.googleTasks.lastSyncAt,
          quotaUsedToday: u.googleTasks.quotaUsedToday || 0,
          quotaResetDate: u.googleTasks.quotaResetDate
        } : { enabled: false }
      };
    });

    res.json(diagnostics);
  } catch (error) {
    logger.error('Admin sync diagnostics error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri načítaní diagnostiky' });
  }
});

module.exports = router;
