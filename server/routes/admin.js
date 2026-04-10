const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { authenticateToken } = require('../middleware/auth');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const logger = require('../utils/logger');
const Message = require('../models/Message');
const AuditLog = require('../models/AuditLog');
const PushSubscription = require('../models/PushSubscription');
const APNsDevice = require('../models/APNsDevice');
const auditService = require('../services/auditService');

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

    const oldRole = targetUser.role;
    targetUser.role = role;
    await targetUser.save();

    logger.info('Admin role change', { targetUserId: req.params.userId, newRole: role, changedBy: req.user.id });

    auditService.logAction({
      userId: req.user.id, username: req.user.username, email: req.user.email,
      action: 'user.role_changed', category: 'user',
      targetType: 'user', targetId: req.params.userId, targetName: targetUser.username,
      details: { oldRole, newRole: role },
      ipAddress: req.ip, userAgent: req.get('user-agent')
    });

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

    const oldPlan = targetUser.subscription?.plan || 'free';
    targetUser.subscription = { plan };
    await targetUser.save();

    logger.info('Admin plan change', { targetUserId: req.params.userId, newPlan: plan, changedBy: req.user.id });

    auditService.logAction({
      userId: req.user.id, username: req.user.username, email: req.user.email,
      action: 'user.plan_changed', category: 'billing',
      targetType: 'user', targetId: req.params.userId, targetName: targetUser.username,
      details: { oldPlan, newPlan: plan },
      ipAddress: req.ip, userAgent: req.get('user-agent')
    });

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

    // Capture info before deletion
    const deletedUsername = targetUser.username;
    const deletedEmail = targetUser.email;

    // Remove workspace memberships
    await WorkspaceMember.deleteMany({ userId: targetUser._id });

    // Delete user
    await User.findByIdAndDelete(targetUser._id);

    logger.info('Admin delete user', { targetUserId: req.params.userId, deletedBy: req.user.id });

    auditService.logAction({
      userId: req.user.id, username: req.user.username, email: req.user.email,
      action: 'user.deleted', category: 'user',
      targetType: 'user', targetId: req.params.userId, targetName: deletedUsername,
      details: { email: deletedEmail },
      ipAddress: req.ip, userAgent: req.get('user-agent')
    });

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

// ─── WORKSPACE DETAIL ──────────────────────────────────────────
router.get('/workspaces/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id.match(/^[0-9a-fA-F]{24}$/)) return res.status(400).json({ message: 'Neplatné ID' });

    const workspace = await Workspace.findById(id);
    if (!workspace) return res.status(404).json({ message: 'Workspace nenájdený' });

    // Get members with user details
    const members = await WorkspaceMember.find({ workspaceId: id }).lean();
    const memberUserIds = members.map(m => m.userId);
    const memberUsers = await User.find({ _id: { $in: memberUserIds } }).select('username email role subscription color avatar avatarData avatarMimetype').lean();
    const memberMap = {};
    memberUsers.forEach(u => { memberMap[u._id.toString()] = u; });

    const enrichedMembers = members.map(m => ({
      ...m,
      user: memberMap[m.userId.toString()] || null
    }));

    // Get counts
    const [contactCount, taskCount, messageCount] = await Promise.all([
      Contact.countDocuments({ workspaceId: id }),
      Task.countDocuments({ workspaceId: id }),
      Message.countDocuments({ workspaceId: id })
    ]);

    // Recent activity - last 20 contacts created
    const recentContacts = await Contact.find({ workspaceId: id })
      .select('name email company status createdAt')
      .sort({ createdAt: -1 }).limit(20).lean();

    // Task stats
    const completedTasks = await Task.countDocuments({ workspaceId: id, completed: true });
    const pendingTasks = taskCount - completedTasks;

    // Message stats
    const pendingMessages = await Message.countDocuments({ workspaceId: id, status: 'pending' });

    res.json({
      workspace,
      members: enrichedMembers,
      stats: { contactCount, taskCount, completedTasks, pendingTasks, messageCount, pendingMessages },
      recentContacts
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri načítaní workspace detailu' });
  }
});

// ─── USER DETAIL ───────────────────────────────────────────────
router.get('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id.match(/^[0-9a-fA-F]{24}$/)) return res.status(400).json({ message: 'Neplatné ID' });

    const user = await User.findById(id).select('-password').lean();
    if (!user) return res.status(404).json({ message: 'Používateľ nenájdený' });

    // Get workspace memberships
    const memberships = await WorkspaceMember.find({ userId: id }).lean();
    const workspaceIds = memberships.map(m => m.workspaceId);
    const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).lean();
    const wsMap = {};
    workspaces.forEach(w => { wsMap[w._id.toString()] = w; });

    const enrichedMemberships = memberships.map(m => ({
      ...m,
      workspace: wsMap[m.workspaceId.toString()] || null
    }));

    // Activity counts
    const [contactCount, taskCount, messagesSent, messagesReceived] = await Promise.all([
      Contact.countDocuments({ userId: id }),
      Task.countDocuments({ $or: [{ userId: id }, { createdBy: id }, { assignedTo: id }] }),
      Message.countDocuments({ fromUserId: id }),
      Message.countDocuments({ toUserId: id })
    ]);

    // Recent audit log
    const recentActivity = await AuditLog.find({ userId: id })
      .sort({ createdAt: -1 }).limit(30).lean();

    // Push subscriptions and APNs devices
    const [pushSubs, apnsDevices] = await Promise.all([
      PushSubscription.find({ userId: id }).select('endpoint userAgent createdAt lastUsed').lean(),
      APNsDevice.find({ userId: id }).select('deviceToken apnsEnvironment createdAt lastUsed').lean()
    ]);

    res.json({
      user,
      memberships: enrichedMemberships,
      stats: { contactCount, taskCount, messagesSent, messagesReceived },
      recentActivity,
      devices: { pushSubscriptions: pushSubs, apnsDevices }
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri načítaní detailu používateľa' });
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

// ─── AUDIT LOG ─────────────────────────────────────────────────
// GET /api/admin/audit-log — paginated, filterable audit log
router.get('/audit-log', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, category, action, userId, from, to, search } = req.query;
    const parsedPage = Math.max(parseInt(page) || 1, 1);
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const skip = (parsedPage - 1) * parsedLimit;

    const query = {};
    if (category) query.category = category;
    if (action) query.action = action;
    if (userId) query.userId = userId;
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { targetName: { $regex: search, $options: 'i' } },
        { action: { $regex: search, $options: 'i' } }
      ];
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      AuditLog.countDocuments(query)
    ]);

    res.json({
      logs: logs.map(l => ({ ...l, id: l._id.toString() })),
      total,
      page: parsedPage,
      pages: Math.ceil(total / parsedLimit)
    });
  } catch (error) {
    logger.error('Admin audit log error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri načítaní audit logu' });
  }
});

// GET /api/admin/audit-log/categories — get available categories and actions for filtering
router.get('/audit-log/categories', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const categories = await AuditLog.distinct('category');
    const actions = await AuditLog.distinct('action');
    res.json({ categories, actions });
  } catch (error) {
    logger.error('Admin audit log categories error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// Export users to CSV
router.get('/export/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password -avatarData').lean();
    const members = await WorkspaceMember.find().lean();
    const workspaces = await Workspace.find().select('_id name').lean();
    const wsMap = {};
    workspaces.forEach(w => { wsMap[w._id.toString()] = w.name; });

    const header = 'Meno,Email,Rola,Plán,Workspace-y,Registrovaný,Google Calendar,Google Tasks\n';
    const rows = users.map(u => {
      const userWs = members.filter(m => m.userId.toString() === u._id.toString()).map(m => wsMap[m.workspaceId.toString()] || '').filter(Boolean).join('; ');
      return [
        `"${(u.username || '').replace(/"/g, '""')}"`,
        `"${(u.email || '').replace(/"/g, '""')}"`,
        u.role || 'user',
        u.subscription?.plan || 'free',
        `"${userWs}"`,
        u.createdAt ? new Date(u.createdAt).toLocaleDateString('sk-SK') : '',
        u.googleCalendar?.enabled ? 'Áno' : 'Nie',
        u.googleTasks?.enabled ? 'Áno' : 'Nie'
      ].join(',');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=users-export.csv');
    res.send('\ufeff' + header + rows);
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri exporte' });
  }
});

// Export workspaces to CSV
router.get('/export/workspaces', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const workspaces = await Workspace.find().lean();
    const members = await WorkspaceMember.find().lean();
    const users = await User.find().select('_id username email').lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id.toString()] = u; });

    const header = 'Názov,Slug,Vlastník,Email vlastníka,Počet členov,Platené miesta,Vytvorený\n';
    const rows = workspaces.map(w => {
      const owner = userMap[w.ownerId.toString()] || {};
      const memberCount = members.filter(m => m.workspaceId.toString() === w._id.toString()).length;
      return [
        `"${(w.name || '').replace(/"/g, '""')}"`,
        `"${(w.slug || '').replace(/"/g, '""')}"`,
        `"${(owner.username || '').replace(/"/g, '""')}"`,
        `"${(owner.email || '').replace(/"/g, '""')}"`,
        memberCount,
        w.paidSeats || 0,
        w.createdAt ? new Date(w.createdAt).toLocaleDateString('sk-SK') : ''
      ].join(',');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=workspaces-export.csv');
    res.send('\ufeff' + header + rows);
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri exporte' });
  }
});

// System health
router.get('/health', authenticateToken, requireAdmin, async (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime: process.uptime(),
    memory: { rss: Math.round(mem.rss / 1024 / 1024), heapUsed: Math.round(mem.heapUsed / 1024 / 1024), heapTotal: Math.round(mem.heapTotal / 1024 / 1024) },
    mongoStatus: mongoose.connection.readyState,
    nodeVersion: process.version,
    platform: process.platform
  });
});

// Bulk update users (plan or role) — MUST be before /:userId routes
router.put('/users/bulk', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userIds, action, value } = req.body;
    if (!userIds?.length || !['plan', 'role'].includes(action)) return res.status(400).json({ message: 'Neplatné parametre' });

    const validPlans = ['free', 'team', 'pro', 'trial'];
    const validRoles = ['admin', 'manager', 'user'];
    if (action === 'plan' && !validPlans.includes(value)) return res.status(400).json({ message: 'Neplatný plán' });
    if (action === 'role' && !validRoles.includes(value)) return res.status(400).json({ message: 'Neplatná rola' });

    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL });
    const filteredIds = userIds.filter(id => id !== superAdmin?._id?.toString());

    const updateQuery = action === 'plan' ? { 'subscription.plan': value } : { role: value };
    const result = await User.updateMany({ _id: { $in: filteredIds } }, updateQuery);

    auditService.logAction({
      userId: req.user.id, username: req.user.username, email: req.user.email,
      action: action === 'plan' ? 'user.plan_changed' : 'user.role_changed',
      category: action === 'plan' ? 'billing' : 'user',
      targetType: 'user', targetName: `bulk (${filteredIds.length})`,
      details: { bulkAction: true, newValue: value, count: filteredIds.length },
      ipAddress: req.ip
    });

    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri hromadnej úprave' });
  }
});

// Update user subscription details
router.put('/users/:userId/subscription', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'Používateľ nenájdený' });

    const { plan, trialEndsAt, paidUntil } = req.body;
    const oldPlan = user.subscription?.plan;
    if (plan) user.subscription.plan = plan;
    if (trialEndsAt !== undefined) user.subscription.trialEndsAt = trialEndsAt || null;
    if (paidUntil !== undefined) user.subscription.paidUntil = paidUntil || null;
    await user.save();

    auditService.logAction({
      userId: req.user.id, username: req.user.username, email: req.user.email,
      action: 'user.subscription_updated', category: 'billing',
      targetType: 'user', targetId: req.params.userId, targetName: user.username,
      details: { oldPlan, plan, trialEndsAt, paidUntil },
      ipAddress: req.ip
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri úprave predplatného' });
  }
});

// Delete workspace and all its data
router.delete('/workspaces/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id.match(/^[0-9a-fA-F]{24}$/)) return res.status(400).json({ message: 'Neplatné ID' });

    const workspace = await Workspace.findById(id);
    if (!workspace) return res.status(404).json({ message: 'Workspace nenájdený' });

    await Promise.all([
      Contact.deleteMany({ workspaceId: id }),
      Task.deleteMany({ workspaceId: id }),
      Message.deleteMany({ workspaceId: id }),
      WorkspaceMember.deleteMany({ workspaceId: id }),
      Workspace.findByIdAndDelete(id)
    ]);

    auditService.logAction({
      userId: req.user.id, username: req.user.username, email: req.user.email,
      action: 'workspace.deleted', category: 'workspace',
      targetType: 'workspace', targetId: id, targetName: workspace.name,
      ipAddress: req.ip
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri mazaní workspace' });
  }
});

module.exports = router;
