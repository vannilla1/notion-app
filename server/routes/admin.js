const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { authenticateToken } = require('../middleware/auth');
const { adminLoginLimiter } = require('../middleware/rateLimiter');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const logger = require('../utils/logger');
const { escapeRegex } = require('../utils/regexHelpers');
const Message = require('../models/Message');
const AuditLog = require('../models/AuditLog');
const PushSubscription = require('../models/PushSubscription');
const APNsDevice = require('../models/APNsDevice');
const PromoCode = require('../models/PromoCode');
const ServerError = require('../models/ServerError');
const auditService = require('../services/auditService');
const subscriptionEmailService = require('../services/subscriptionEmailService');
const EmailLog = require('../models/EmailLog');
const onlineUsers = require('../services/onlineUsers');
const { getMetrics } = require('../services/apiMetrics');
const healthMonitor = require('../jobs/healthMonitor');

const router = express.Router();

// Middleware: require super admin (only support@prplcrm.eu)
const SUPER_ADMIN_EMAIL = 'support@prplcrm.eu';

// ─── ADMIN LOGIN (separate from regular auth) ──────────────────
// adminLoginLimiter: 5 pokusov / 30 min — prísnejšie ako bežný login,
// keďže super admin účet má prístup k VŠETKÝM userom + billingu + auditu.
router.post('/login', adminLoginLimiter, async (req, res) => {
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
      discount: u.subscription?.discount?.type ? {
        type: u.subscription.discount.type,
        value: u.subscription.discount.value,
        targetPlan: u.subscription.discount.targetPlan,
        expiresAt: u.subscription.discount.expiresAt
      } : null,
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

    // Prevent removing own admin role.
    // POZOR: `req.user.id` je Mongoose ObjectId, `req.params.userId` je string.
    // Strict `===` by vždy vrátil false → admin by mohol demotnúť sám seba.
    // Bez .toString() ochrana nefungovala vôbec (odhalené testom, jar 2026).
    if (req.params.userId === req.user.id.toString() && role !== 'admin') {
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

// ─── UPDATE WORKSPACE MEMBER ROLE ───────────────────────────────
router.put('/users/:userId/workspace-role', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { workspaceId, role } = req.body;
    if (!['owner', 'manager', 'member'].includes(role)) {
      return res.status(400).json({ message: 'Neplatná workspace rola' });
    }
    if (!workspaceId) {
      return res.status(400).json({ message: 'Chýba workspaceId' });
    }

    const membership = await WorkspaceMember.findOne({
      userId: req.params.userId,
      workspaceId: workspaceId
    }).populate('workspaceId', 'name slug');

    if (!membership) {
      return res.status(404).json({ message: 'Členstvo vo workspace nenájdené' });
    }

    const oldRole = membership.role;
    membership.role = role;
    await membership.save();

    const targetUser = await User.findById(req.params.userId);
    logger.info('Admin workspace role change', {
      targetUserId: req.params.userId,
      workspaceId,
      oldRole,
      newRole: role,
      changedBy: req.user.id
    });

    auditService.logAction({
      userId: req.user.id, username: req.user.username, email: req.user.email,
      action: 'user.workspace_role_changed', category: 'user',
      targetType: 'user', targetId: req.params.userId, targetName: targetUser?.username,
      details: { workspaceId, workspaceName: membership.workspaceId?.name, oldRole, newRole: role },
      ipAddress: req.ip, userAgent: req.get('user-agent')
    });

    res.json({ message: 'Workspace rola bola aktualizovaná', role });
  } catch (error) {
    logger.error('Admin workspace role change error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri zmene workspace role' });
  }
});

// ─── UPDATE USER PLAN ───────────────────────────────────────────
router.put('/users/:userId/plan', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!['free', 'team', 'pro'].includes(plan)) {
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

    // Reset reminder flags + send notification email (fire-and-forget so admin
    // response isn't blocked by SMTP latency). welcome_pro is auto-substituted
    // for first-time upgrades inside sendSubscriptionAssigned.
    if (oldPlan !== plan) {
      subscriptionEmailService.resetReminderFlags(targetUser._id).catch(() => {});
      subscriptionEmailService.sendSubscriptionAssigned({
        user: targetUser,
        oldPlan,
        triggeredBy: `admin:${req.user.username || req.adminUser?.username || 'unknown'}`
      }).catch((err) => logger.error('Plan change email failed', { error: err.message }));
    }

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
    // ObjectId vs string porovnanie — viď PUT /users/:userId/role komentár.
    // Bez .toString() táto ochrana nefungovala; self-delete bol nepriamo
    // blokovaný len ochranou "iný admin". Po odinštalovaní admin role by
    // admin mohol zmazať sám seba.
    if (req.params.userId === req.user.id.toString()) {
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
    const targetUserId = targetUser._id;

    // ── Cascade delete (audit LOW-001 fix) ──
    // Predtým: mazali sme len WorkspaceMember + User, čo nechávalo orphan
    // dáta v DB (push tokeny, notifikácie, pozvánky, sole-owned workspaces
    // s ich obsahom). Teraz parita so self-delete flow v auth.js DELETE
    // /api/auth/account.
    const Workspace = require('../models/Workspace');
    const Task = require('../models/Task');
    const Contact = require('../models/Contact');
    const Message = require('../models/Message');
    const Page = require('../models/Page');
    const Notification = require('../models/Notification');
    const Invitation = require('../models/Invitation');
    const APNsDevice = require('../models/APNsDevice');
    const FcmDevice = require('../models/FcmDevice');

    // 1) Sole-owned workspaces — admin override: mažeme aj keď majú iných
    // členov (admin akcia je "definitívna nuke"). Self-delete blokuje pri
    // ostatných členoch, ale super-admin musí vedieť odstrániť aj
    // problematické účty bez ručnej intervencie do každého workspace-u.
    const ownedWorkspaces = await Workspace.find({ ownerId: targetUserId });
    const ownedWorkspaceIds = ownedWorkspaces.map(w => w._id);

    if (ownedWorkspaceIds.length > 0) {
      await Promise.all([
        Task.deleteMany({ workspaceId: { $in: ownedWorkspaceIds } }),
        Contact.deleteMany({ workspaceId: { $in: ownedWorkspaceIds } }),
        Message.deleteMany({ workspaceId: { $in: ownedWorkspaceIds } }),
        Page.deleteMany({ workspaceId: { $in: ownedWorkspaceIds } }),
        Notification.deleteMany({ workspaceId: { $in: ownedWorkspaceIds } }),
        Invitation.deleteMany({ workspaceId: { $in: ownedWorkspaceIds } }),
        WorkspaceMember.deleteMany({ workspaceId: { $in: ownedWorkspaceIds } }),
        Workspace.deleteMany({ _id: { $in: ownedWorkspaceIds } })
      ]);
    }

    // 2) User-specific cleanup (vo všetkých workspaces, vrátane cudzích)
    await Promise.all([
      WorkspaceMember.deleteMany({ userId: targetUserId }),
      Notification.deleteMany({ userId: targetUserId }),
      APNsDevice.deleteMany({ userId: targetUserId }),
      FcmDevice.deleteMany({ userId: targetUserId }),
      PushSubscription.deleteMany({ userId: targetUserId }),
      Invitation.deleteMany({ $or: [{ invitedBy: targetUserId }, { email: deletedEmail }] })
    ]);

    // POZN: Tasks/Contacts/Messages ktoré user vytvoril v cudzích workspaces
    // NEMAŽEME — patria tímu (rovnaké pravidlo ako self-delete).

    // 3) Final delete user document
    await User.findByIdAndDelete(targetUserId);

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
    // Get all users with Google integrations enabled, including the PR2
    // per-workspace maps so the admin UI can show the workspace breakdown.
    const usersWithSync = await User.find(
      {
        $or: [
          { 'googleCalendar.enabled': true },
          { 'googleTasks.enabled': true }
        ]
      },
      'username email googleCalendar googleTasks'
    ).lean();

    // Pre-load workspace names so we don't issue N+1 lookups in the map.
    const wsIdSet = new Set();
    for (const u of usersWithSync) {
      const wsMap = u.googleCalendar?.workspaceCalendars || {};
      for (const k of Object.keys(wsMap)) wsIdSet.add(k);
      const tsMap = u.googleTasks?.workspaceTaskLists || {};
      for (const k of Object.keys(tsMap)) wsIdSet.add(k);
    }
    const Workspace = require('../models/Workspace');
    const workspaces = wsIdSet.size
      ? await Workspace.find({ _id: { $in: Array.from(wsIdSet) } }, 'name').lean()
      : [];
    const workspaceNameById = new Map(workspaces.map(w => [w._id.toString(), w.name]));

    // Count synced entries per workspace by walking the {task → calendar/list}
    // reverse indexes. syncedTaskCalendars / syncedTaskLists live on the user doc.
    const countByCalendarId = (user) => {
      const stc = user.googleCalendar?.syncedTaskCalendars || {};
      const counts = new Map();
      for (const calId of Object.values(stc)) {
        counts.set(calId, (counts.get(calId) || 0) + 1);
      }
      return counts;
    };
    const countByTaskListId = (user) => {
      const stl = user.googleTasks?.syncedTaskLists || {};
      const counts = new Map();
      for (const listId of Object.values(stl)) {
        counts.set(listId, (counts.get(listId) || 0) + 1);
      }
      return counts;
    };

    const diagnostics = usersWithSync.map(u => {
      const calSyncedCount = u.googleCalendar?.syncedTaskIds
        ? Object.keys(u.googleCalendar.syncedTaskIds).length
        : 0;
      const tasksSyncedCount = u.googleTasks?.syncedTaskIds
        ? Object.keys(u.googleTasks.syncedTaskIds).length
        : 0;

      // Build per-workspace breakdown for Calendar
      const calendarWorkspaces = [];
      const calCounts = countByCalendarId(u);
      const wsCal = u.googleCalendar?.workspaceCalendars || {};
      for (const [wsId, entry] of Object.entries(wsCal)) {
        calendarWorkspaces.push({
          workspaceId: wsId,
          workspaceName: workspaceNameById.get(wsId) || '(neznámy)',
          calendarId: entry?.calendarId,
          createdAt: entry?.createdAt,
          syncedCount: calCounts.get(entry?.calendarId) || 0
        });
      }
      // Legacy leftovers — events still bound to the old single calendar
      const legacyCalendarId = u.googleCalendar?.calendarId;
      const legacyCalCount = legacyCalendarId ? (calCounts.get(legacyCalendarId) || 0) : 0;
      // syncedTaskIds minus everything attributed to workspace calendars =
      // unattributed (pre-PR2 events). Show so admin sees what still needs migration.
      const attributed = Array.from(calCounts.values()).reduce((a, b) => a + b, 0);
      const unattributedCal = Math.max(0, calSyncedCount - attributed);

      // Same for Tasks
      const tasksWorkspaces = [];
      const tsCounts = countByTaskListId(u);
      const wsTs = u.googleTasks?.workspaceTaskLists || {};
      for (const [wsId, entry] of Object.entries(wsTs)) {
        tasksWorkspaces.push({
          workspaceId: wsId,
          workspaceName: workspaceNameById.get(wsId) || '(neznámy)',
          taskListId: entry?.taskListId,
          createdAt: entry?.createdAt,
          syncedCount: tsCounts.get(entry?.taskListId) || 0
        });
      }
      const legacyTaskListId = u.googleTasks?.taskListId;
      const legacyTasksCount = legacyTaskListId ? (tsCounts.get(legacyTaskListId) || 0) : 0;
      const attributedTs = Array.from(tsCounts.values()).reduce((a, b) => a + b, 0);
      const unattributedTs = Math.max(0, tasksSyncedCount - attributedTs);

      return {
        id: u._id,
        username: u.username,
        email: u.email,
        calendar: u.googleCalendar?.enabled ? {
          enabled: true,
          connectedAt: u.googleCalendar.connectedAt,
          syncedCount: calSyncedCount,
          watchExpiry: u.googleCalendar.watchExpiry,
          watchActive: u.googleCalendar.watchExpiry ? new Date(u.googleCalendar.watchExpiry) > new Date() : false,
          // PR2: per-workspace breakdown
          workspaces: calendarWorkspaces,
          legacyCalendarId,
          legacyCount: legacyCalCount,
          unattributedCount: unattributedCal
        } : { enabled: false },
        tasks: u.googleTasks?.enabled ? {
          enabled: true,
          connectedAt: u.googleTasks.connectedAt,
          syncedCount: tasksSyncedCount,
          lastSyncAt: u.googleTasks.lastSyncAt,
          quotaUsedToday: u.googleTasks.quotaUsedToday || 0,
          quotaResetDate: u.googleTasks.quotaResetDate,
          // PR2: per-workspace breakdown
          workspaces: tasksWorkspaces,
          legacyTaskListId,
          legacyCount: legacyTasksCount,
          unattributedCount: unattributedTs
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
      // ReDoS hardening (audit MED-002): escapujeme regex meta-znaky
      // a obmedzujeme dĺžku, aby kompromitovaný admin token nemohol
      // poslať katastrofický pattern typu (a+)+ na DoS Mongo connection pool.
      const safeSearch = escapeRegex(String(search).slice(0, 100));
      query.$or = [
        { username: { $regex: safeSearch, $options: 'i' } },
        { email: { $regex: safeSearch, $options: 'i' } },
        { targetName: { $regex: safeSearch, $options: 'i' } },
        { action: { $regex: safeSearch, $options: 'i' } }
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
  const stateMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({
    uptime: process.uptime(),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    database: { status: stateMap[mongoose.connection.readyState] || 'unknown' },
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// Bulk update users (plan or role) — MUST be before /:userId routes
router.put('/users/bulk', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userIds, action, value } = req.body;
    if (!userIds?.length || !['plan', 'role'].includes(action)) return res.status(400).json({ message: 'Neplatné parametre' });

    const validPlans = ['free', 'team', 'pro'];
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

    const { plan, paidUntil } = req.body;
    const oldPlan = user.subscription?.plan;
    const oldPaidUntil = user.subscription?.paidUntil;
    if (plan) user.subscription.plan = plan;
    if (paidUntil !== undefined) user.subscription.paidUntil = paidUntil || null;
    await user.save();

    auditService.logAction({
      userId: req.user.id, username: req.user.username, email: req.user.email,
      action: 'user.subscription_updated', category: 'billing',
      targetType: 'user', targetId: req.params.userId, targetName: user.username,
      details: { oldPlan, plan, paidUntil },
      ipAddress: req.ip
    });

    // Fire notification email if plan or expiry actually changed. Reset
    // reminder flags so the new cycle generates fresh T-7/T-1 reminders.
    const planChanged = plan && plan !== oldPlan;
    const expiryChanged = paidUntil !== undefined && String(paidUntil) !== String(oldPaidUntil);
    if (planChanged || expiryChanged) {
      subscriptionEmailService.resetReminderFlags(user._id).catch(() => {});
      subscriptionEmailService.sendSubscriptionAssigned({
        user,
        oldPlan,
        triggeredBy: `admin:${req.user.username || req.adminUser?.username || 'unknown'}`
      }).catch((err) => logger.error('Subscription update email failed', { error: err.message }));
    }

    res.json({ success: true, subscription: user.subscription });
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

// ─── DISCOUNT MANAGEMENT ──────────────────────────────────────
// Apply discount to user
router.put('/users/:userId/discount', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'Používateľ nenájdený' });

    const { type, value, targetPlan, reason, expiresAt } = req.body;

    // Validate discount type
    const validTypes = ['percentage', 'fixed', 'freeMonths', 'planUpgrade'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ message: 'Neplatný typ zľavy' });
    }

    // Validate value based on type
    if (type === 'percentage' && (value < 1 || value > 100)) {
      return res.status(400).json({ message: 'Percentuálna zľava musí byť medzi 1-100%' });
    }
    if (type === 'fixed' && (value < 0.01 || value > 100)) {
      return res.status(400).json({ message: 'Fixná zľava musí byť medzi 0.01-100€' });
    }
    if (type === 'freeMonths' && (value < 1 || value > 24)) {
      return res.status(400).json({ message: 'Počet voľných mesiacov musí byť 1-24' });
    }
    if (type === 'planUpgrade' && !['team', 'pro'].includes(targetPlan)) {
      return res.status(400).json({ message: 'Neplatný cieľový plán' });
    }

    const oldDiscount = user.subscription?.discount?.type ? { ...user.subscription.discount.toObject() } : null;

    user.subscription.discount = {
      type,
      value: type === 'planUpgrade' ? null : value,
      targetPlan: type === 'planUpgrade' ? targetPlan : null,
      reason: reason || null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdAt: new Date(),
      createdBy: req.adminUser.username
    };

    // For planUpgrade: also set the plan and paidUntil
    if (type === 'planUpgrade') {
      user.subscription.plan = targetPlan;
      if (expiresAt) {
        user.subscription.paidUntil = new Date(expiresAt);
      }
    }

    // For freeMonths: extend paidUntil by X months
    if (type === 'freeMonths') {
      const current = user.subscription.paidUntil ? new Date(user.subscription.paidUntil) : new Date();
      current.setMonth(current.getMonth() + value);
      user.subscription.paidUntil = current;
    }

    await user.save();

    auditService.logAction({
      userId: req.user.id, username: req.adminUser.username, email: req.adminUser.email,
      action: 'user.discount_applied', category: 'billing',
      targetType: 'user', targetId: req.params.userId, targetName: user.username,
      details: { type, value, targetPlan, reason, expiresAt, oldDiscount },
      ipAddress: req.ip
    });

    // Reset reminder cycle flags (planUpgrade or freeMonths extends paidUntil
    // → user shouldn't keep getting expiry reminders for the OLD date) and
    // notify the user about the discount/upgrade.
    subscriptionEmailService.resetReminderFlags(user._id).catch(() => {});
    subscriptionEmailService.sendDiscountAssigned({
      user,
      triggeredBy: `admin:${req.adminUser.username}`
    }).catch((err) => logger.error('Discount email failed', { error: err.message }));

    res.json({ success: true, subscription: user.subscription });
  } catch (error) {
    logger.error('Apply discount error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri aplikovaní zľavy' });
  }
});

// Remove discount from user
router.delete('/users/:userId/discount', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'Používateľ nenájdený' });

    const oldDiscount = user.subscription?.discount?.type ? { ...user.subscription.discount.toObject() } : null;

    // If it was a planUpgrade, revert the plan to free (unless they have a Stripe subscription)
    if (user.subscription?.discount?.type === 'planUpgrade' && !user.subscription.stripeSubscriptionId) {
      user.subscription.plan = 'free';
      user.subscription.paidUntil = null;
    }

    user.subscription.discount = {
      type: null, value: null, targetPlan: null,
      reason: null, expiresAt: null, createdAt: null, createdBy: null
    };
    await user.save();

    auditService.logAction({
      userId: req.user.id, username: req.adminUser.username, email: req.adminUser.email,
      action: 'user.discount_removed', category: 'billing',
      targetType: 'user', targetId: req.params.userId, targetName: user.username,
      details: { removedDiscount: oldDiscount },
      ipAddress: req.ip
    });

    res.json({ success: true, subscription: user.subscription });
  } catch (error) {
    logger.error('Remove discount error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri odstraňovaní zľavy' });
  }
});

// ─── P3: CHARTS DATA ──────────────────────────────────────────
// User growth over time (registrations per day for last 90 days)
router.get('/charts/user-growth', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const daysBack = parseInt(req.query.days) || 90;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const growth = await User.aggregate([
      { $match: { createdAt: { $gte: startDate }, email: { $ne: SUPER_ADMIN_EMAIL } } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 }
      }},
      { $sort: { _id: 1 } }
    ]);

    // Fill gaps (days with 0 registrations)
    const result = [];
    let cumulative = await User.countDocuments({
      createdAt: { $lt: startDate },
      email: { $ne: SUPER_ADMIN_EMAIL }
    });
    const dataMap = {};
    growth.forEach(g => { dataMap[g._id] = g.count; });

    for (let d = new Date(startDate); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const daily = dataMap[key] || 0;
      cumulative += daily;
      result.push({ date: key, daily, cumulative });
    }

    res.json(result);
  } catch (error) {
    logger.error('Charts user growth error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// Activity over time (audit log entries per day for last 30 days)
router.get('/charts/activity', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const daysBack = parseInt(req.query.days) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const activity = await AuditLog.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      { $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          category: '$category'
        },
        count: { $sum: 1 }
      }},
      { $sort: { '_id.date': 1 } }
    ]);

    // Group by date with category breakdown
    const dateMap = {};
    activity.forEach(a => {
      if (!dateMap[a._id.date]) dateMap[a._id.date] = { date: a._id.date, total: 0 };
      dateMap[a._id.date][a._id.category] = a.count;
      dateMap[a._id.date].total += a.count;
    });

    // Fill gaps
    const result = [];
    for (let d = new Date(startDate); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      result.push(dateMap[key] || { date: key, total: 0 });
    }

    res.json(result);
  } catch (error) {
    logger.error('Charts activity error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// ─── P3: REAL-TIME ACTIVITY FEED ──────────────────────────────
router.get('/activity-feed', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const after = req.query.after; // ISO date — for polling new entries

    const query = {};
    if (after) query.createdAt = { $gt: new Date(after) };

    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json(logs.map(l => ({
      id: l._id,
      action: l.action,
      category: l.category,
      username: l.username,
      email: l.email,
      targetType: l.targetType,
      targetName: l.targetName,
      details: l.details,
      createdAt: l.createdAt
    })));
  } catch (error) {
    logger.error('Activity feed error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// ─── P3: API USAGE METRICS ───────────────────────────────────
router.get('/api-metrics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { getMetrics } = require('../services/apiMetrics');
    res.json(getMetrics());
  } catch (error) {
    logger.error('API metrics error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// ─── P3: STORAGE METRICS ─────────────────────────────────────
router.get('/storage', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const db = mongoose.connection.db;

    // Get collection stats
    const collections = ['users', 'workspaces', 'contacts', 'tasks', 'messages', 'notifications', 'auditlogs', 'pushsubscriptions', 'apnsdevices', 'pages', 'workspacemembers'];
    const collectionStats = [];

    for (const name of collections) {
      try {
        const stats = await db.command({ collStats: name });
        collectionStats.push({
          name,
          count: stats.count,
          size: stats.size,
          avgObjSize: stats.avgObjSize || 0,
          storageSize: stats.storageSize,
          indexSize: stats.totalIndexSize
        });
      } catch {
        // Collection might not exist yet
      }
    }

    // Storage per workspace (contacts + tasks + messages)
    const workspaceStorage = await Promise.all([
      Contact.aggregate([
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ]),
      Task.aggregate([
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ]),
      Message.aggregate([
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ])
    ]);

    const wsMap = {};
    const [contactCounts, taskCounts, messageCounts] = workspaceStorage;
    contactCounts.forEach(c => {
      if (!c._id) return;
      const id = c._id.toString();
      if (!wsMap[id]) wsMap[id] = { contacts: 0, tasks: 0, messages: 0 };
      wsMap[id].contacts = c.count;
    });
    taskCounts.forEach(t => {
      if (!t._id) return;
      const id = t._id.toString();
      if (!wsMap[id]) wsMap[id] = { contacts: 0, tasks: 0, messages: 0 };
      wsMap[id].tasks = t.count;
    });
    messageCounts.forEach(m => {
      if (!m._id) return;
      const id = m._id.toString();
      if (!wsMap[id]) wsMap[id] = { contacts: 0, tasks: 0, messages: 0 };
      wsMap[id].messages = m.count;
    });

    // Get workspace names
    const workspaceIds = Object.keys(wsMap);
    const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select('name slug color').lean();
    const wsNameMap = {};
    workspaces.forEach(w => { wsNameMap[w._id.toString()] = w; });

    // Estimate storage per workspace using avg object sizes
    const avgContactSize = collectionStats.find(c => c.name === 'contacts')?.avgObjSize || 500;
    const avgTaskSize = collectionStats.find(c => c.name === 'tasks')?.avgObjSize || 300;
    const avgMessageSize = collectionStats.find(c => c.name === 'messages')?.avgObjSize || 400;

    const perWorkspace = Object.entries(wsMap).map(([id, counts]) => ({
      id,
      name: wsNameMap[id]?.name || '—',
      slug: wsNameMap[id]?.slug || '',
      color: wsNameMap[id]?.color || '#6B7280',
      ...counts,
      totalDocs: counts.contacts + counts.tasks + counts.messages,
      estimatedSize: (counts.contacts * avgContactSize) + (counts.tasks * avgTaskSize) + (counts.messages * avgMessageSize)
    })).sort((a, b) => b.totalDocs - a.totalDocs);

    // Total DB size
    const dbStats = await db.command({ dbStats: 1 });

    res.json({
      database: {
        dataSize: dbStats.dataSize,
        storageSize: dbStats.storageSize,
        indexSize: dbStats.indexSize,
        collections: dbStats.collections
      },
      collections: collectionStats.sort((a, b) => b.size - a.size),
      perWorkspace
    });
  } catch (error) {
    logger.error('Storage metrics error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// ─── P3: WORKSPACE COMPARISON ─────────────────────────────────
router.get('/workspace-comparison', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const workspaces = await Workspace.find().select('name slug color ownerId createdAt').lean();
    const wsIds = workspaces.map(w => w._id);

    // Pre Task: namiesto Mongo aggregation (ktorá by spočítala len top-level
    // Task dokumenty = "projekty") načítame celé dokumenty a rátame subtasks
    // rekurzívne v JS. Subtask schema má `subtasks: Array` ktoré môže byť
    // ľubovoľne hlboko zanorené — Mongo $unwind by zvládol len jednu úroveň.
    // Pre admin prehľad (~stovky workspace-ov × pár desiatok tasks) je
    // in-memory walk bezproblémový.
    const [contactStats, allTasks, messageStats, memberStats] = await Promise.all([
      Contact.aggregate([
        { $match: { workspaceId: { $in: wsIds } } },
        { $group: { _id: '$workspaceId', count: { $sum: 1 }, recent: { $max: '$createdAt' } } }
      ]),
      Task.find({ workspaceId: { $in: wsIds } })
        .select('workspaceId completed subtasks createdAt')
        .lean(),
      Message.aggregate([
        { $match: { workspaceId: { $in: wsIds } } },
        { $group: { _id: '$workspaceId', count: { $sum: 1 }, recent: { $max: '$createdAt' } } }
      ]),
      WorkspaceMember.aggregate([
        { $match: { workspaceId: { $in: wsIds } } },
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ])
    ]);

    // Aggregate task & subtask metrics per workspace.
    // Projekty = top-level Task documents.
    // Úlohy = subtasks (embedded), recursively counted including nested levels.
    const tMap = {};
    const countSubtasksRecursive = (arr, acc) => {
      if (!Array.isArray(arr)) return;
      for (const sub of arr) {
        acc.subtasks += 1;
        if (sub && sub.completed === true) acc.subtasksCompleted += 1;
        if (sub && Array.isArray(sub.subtasks) && sub.subtasks.length > 0) {
          countSubtasksRecursive(sub.subtasks, acc);
        }
      }
    };
    for (const task of allTasks) {
      const wid = task.workspaceId.toString();
      if (!tMap[wid]) {
        tMap[wid] = {
          projects: 0,
          projectsCompleted: 0,
          subtasks: 0,
          subtasksCompleted: 0,
          recent: null,
        };
      }
      const acc = tMap[wid];
      acc.projects += 1;
      if (task.completed === true) acc.projectsCompleted += 1;
      if (task.createdAt && (!acc.recent || task.createdAt > acc.recent)) {
        acc.recent = task.createdAt;
      }
      countSubtasksRecursive(task.subtasks, acc);
    }

    // Build other maps
    const cMap = {}, mMap = {}, mbMap = {};
    contactStats.forEach(c => { cMap[c._id.toString()] = c; });
    messageStats.forEach(m => { mMap[m._id.toString()] = m; });
    memberStats.forEach(m => { mbMap[m._id.toString()] = m; });

    // Owner info
    const ownerIds = [...new Set(workspaces.map(w => w.ownerId.toString()))];
    const owners = await User.find({ _id: { $in: ownerIds } }).select('username').lean();
    const ownerMap = {};
    owners.forEach(o => { ownerMap[o._id.toString()] = o.username; });

    const result = workspaces.map(w => {
      const id = w._id.toString();
      const c = cMap[id] || { count: 0 };
      const t = tMap[id] || { projects: 0, projectsCompleted: 0, subtasks: 0, subtasksCompleted: 0, recent: null };
      const m = mMap[id] || { count: 0 };
      const mb = mbMap[id] || { count: 0 };

      // Most recent activity across all types
      const lastActivity = [c.recent, t.recent, m.recent].filter(Boolean).sort((a, b) => b - a)[0];

      // Completion rate prefers subtask-level measure (čo user reálne pracuje
      // = úlohy v projektoch). Ak workspace nemá subtasks vôbec, fallbackneme
      // na project-level rate. Ak nemá ani projekty, rate je 0.
      let completionRate = 0;
      if (t.subtasks > 0) {
        completionRate = Math.round((t.subtasksCompleted / t.subtasks) * 100);
      } else if (t.projects > 0) {
        completionRate = Math.round((t.projectsCompleted / t.projects) * 100);
      }

      return {
        id,
        name: w.name,
        slug: w.slug,
        color: w.color,
        owner: ownerMap[w.ownerId.toString()] || '—',
        createdAt: w.createdAt,
        members: mb.count,
        contacts: c.count,
        // 'tasks' field zachovávame pre backward compat (= projekty/top-level Task docs).
        tasks: t.projects,
        completedTasks: t.projectsCompleted,
        // Nové explicitné polia pre subtasky (= úlohy v UI terminológii).
        projects: t.projects,
        projectsCompleted: t.projectsCompleted,
        subtasks: t.subtasks,
        subtasksCompleted: t.subtasksCompleted,
        completionRate,
        messages: m.count,
        lastActivity,
        // Score: weighted activity metric — teraz váži aj subtasky lebo to
        // je reálna jednotka práce (pred fixom score nereagovalo na pridávanie
        // subtaskov, keďže rátalo len top-level Tasks).
        activityScore: c.count * 2 + t.projects * 3 + t.subtasks * 1 + m.count * 1
      };
    }).sort((a, b) => b.activityScore - a.activityScore);

    res.json(result);
  } catch (error) {
    logger.error('Workspace comparison error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// ─── PROMO CODES MANAGEMENT ──────────────────────────────────

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' });

// List all promo codes
router.get('/promo-codes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const codes = await PromoCode.find()
      .sort({ createdAt: -1 })
      .lean();
    res.json(codes);
  } catch (error) {
    logger.error('List promo codes error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri načítaní promo kódov' });
  }
});

// Create promo code
router.post('/promo-codes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      code, name, type, value,
      duration, durationInMonths,
      validForPlans, validForPeriods,
      maxUses, maxUsesPerUser, expiresAt
    } = req.body;

    // Validate required fields
    if (!code || !name || !type || value === undefined) {
      return res.status(400).json({ message: 'Vyplňte všetky povinné polia (kód, názov, typ, hodnota)' });
    }

    // Resolve effective duration + duration_in_months.
    //   - freeMonths typ má duration vždy 'repeating' s durationInMonths=value
    //     (100% off for X months — to je jeho semantika).
    //   - Pre percentage/fixed používame user-provided duration ('once',
    //     'repeating', 'forever'). Default 'once' kvôli backwards compat —
    //     existujúce kódy a staré frontend verzie neposielajú pole.
    let effectiveDuration, effectiveDurationInMonths;
    if (type === 'freeMonths') {
      effectiveDuration = 'repeating';
      effectiveDurationInMonths = value;
    } else {
      effectiveDuration = ['once', 'repeating', 'forever'].includes(duration) ? duration : 'once';
      effectiveDurationInMonths = null;
      if (effectiveDuration === 'repeating') {
        const months = Number(durationInMonths);
        if (!Number.isFinite(months) || months < 1 || months > 36) {
          return res.status(400).json({ message: 'Pri opakovanej zľave musíš zadať počet mesiacov (1–36).' });
        }
        effectiveDurationInMonths = Math.round(months);
      }
    }

    // Validate code format (alphanumeric, hyphens, underscores)
    if (!/^[A-Z0-9_-]+$/i.test(code)) {
      return res.status(400).json({ message: 'Kód môže obsahovať len písmená, čísla, pomlčky a podčiarkovníky' });
    }

    // Check if code already exists
    const existing = await PromoCode.findOne({ code: code.toUpperCase() });
    if (existing) {
      return res.status(409).json({ message: 'Promo kód s týmto kódom už existuje' });
    }

    // Validate value based on type
    if (type === 'percentage' && (value < 1 || value > 100)) {
      return res.status(400).json({ message: 'Percentuálna zľava musí byť medzi 1-100%' });
    }
    if (type === 'fixed' && (value < 0.01 || value > 500)) {
      return res.status(400).json({ message: 'Fixná zľava musí byť medzi 0.01-500€' });
    }
    if (type === 'freeMonths' && (value < 1 || value > 24)) {
      return res.status(400).json({ message: 'Počet voľných mesiacov musí byť 1-24' });
    }

    // Create Stripe Coupon + Promotion Code
    let stripeCouponId = null;
    let stripePromotionCodeId = null;

    if (process.env.STRIPE_SECRET_KEY) {
      try {
        // Create Stripe Coupon
        const couponParams = {
          name: name,
          metadata: { promoCode: code.toUpperCase() }
        };

        if (type === 'percentage') {
          couponParams.percent_off = value;
        } else if (type === 'fixed') {
          couponParams.amount_off = Math.round(value * 100); // Stripe uses cents
          couponParams.currency = 'eur';
        } else if (type === 'freeMonths') {
          // For free months, use 100% off for X months
          couponParams.percent_off = 100;
        }

        // Duration — KRITICKÉ pre opakované zľavy.
        //   'once'      → Stripe aplikuje zľavu iba na prvú faktúru.
        //   'repeating' → Stripe aplikuje zľavu na N nasledujúcich faktúr
        //                 (napr. 50% po dobu 6 mesiacov = user platí diskontovanú
        //                 sumu 6× po sebe).
        //   'forever'   → zľava zostáva po celý život subscription.
        // Bez tohto by "-50% na 6 mesiacov" znamenalo iba 1. mesiac → user by
        // od 2. mesiaca platil plnú cenu, čo bola práve sťažnosť.
        couponParams.duration = effectiveDuration;
        if (effectiveDuration === 'repeating') {
          couponParams.duration_in_months = effectiveDurationInMonths;
        }

        if (maxUses > 0) {
          couponParams.max_redemptions = maxUses;
        }
        if (expiresAt) {
          couponParams.redeem_by = Math.floor(new Date(expiresAt).getTime() / 1000);
        }

        const stripeCoupon = await stripe.coupons.create(couponParams);
        stripeCouponId = stripeCoupon.id;

        // Create Stripe Promotion Code (the customer-facing code)
        const promoCodeParams = {
          coupon: stripeCoupon.id,
          code: code.toUpperCase(),
          active: true
        };

        if (maxUses > 0) {
          promoCodeParams.max_redemptions = maxUses;
        }
        if (expiresAt) {
          promoCodeParams.expires_at = Math.floor(new Date(expiresAt).getTime() / 1000);
        }

        const stripePromoCode = await stripe.promotionCodes.create(promoCodeParams);
        stripePromotionCodeId = stripePromoCode.id;

        logger.info('[PromoCode] Stripe coupon + promotion code created', {
          couponId: stripeCouponId,
          promotionCodeId: stripePromotionCodeId,
          code: code.toUpperCase()
        });
      } catch (stripeErr) {
        logger.error('[PromoCode] Stripe creation failed', { error: stripeErr.message });
        // Continue without Stripe — code will work for in-app discount display
      }
    }

    const promoCode = new PromoCode({
      code: code.toUpperCase(),
      name,
      type,
      value,
      duration: effectiveDuration,
      durationInMonths: effectiveDurationInMonths,
      validForPlans: validForPlans || [],
      validForPeriods: validForPeriods || [],
      maxUses: maxUses || 0,
      maxUsesPerUser: maxUsesPerUser !== undefined ? maxUsesPerUser : 1,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      stripeCouponId,
      stripePromotionCodeId,
      createdBy: req.adminUser.username
    });

    await promoCode.save();

    auditService.logAction({
      userId: req.user.id, username: req.adminUser.username, email: req.adminUser.email,
      action: 'promo_code.created', category: 'billing',
      targetType: 'promoCode', targetId: promoCode._id.toString(), targetName: code.toUpperCase(),
      details: { type, value, maxUses, expiresAt, validForPlans, validForPeriods, stripeCouponId },
      ipAddress: req.ip
    });

    res.status(201).json(promoCode);
  } catch (error) {
    logger.error('Create promo code error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri vytváraní promo kódu' });
  }
});

// Update promo code (toggle active, update limits)
router.put('/promo-codes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const promoCode = await PromoCode.findById(req.params.id);
    if (!promoCode) return res.status(404).json({ message: 'Promo kód nenájdený' });

    const { name, isActive, maxUses, maxUsesPerUser, expiresAt } = req.body;

    const changes = {};
    if (name !== undefined) { changes.name = name; promoCode.name = name; }
    if (isActive !== undefined) { changes.isActive = isActive; promoCode.isActive = isActive; }
    if (maxUses !== undefined) { changes.maxUses = maxUses; promoCode.maxUses = maxUses; }
    if (maxUsesPerUser !== undefined) { changes.maxUsesPerUser = maxUsesPerUser; promoCode.maxUsesPerUser = maxUsesPerUser; }
    if (expiresAt !== undefined) {
      changes.expiresAt = expiresAt;
      promoCode.expiresAt = expiresAt ? new Date(expiresAt) : null;
    }

    // Update Stripe promotion code active status
    if (isActive !== undefined && promoCode.stripePromotionCodeId && process.env.STRIPE_SECRET_KEY) {
      try {
        await stripe.promotionCodes.update(promoCode.stripePromotionCodeId, { active: isActive });
      } catch (stripeErr) {
        logger.warn('[PromoCode] Stripe update failed', { error: stripeErr.message });
      }
    }

    await promoCode.save();

    auditService.logAction({
      userId: req.user.id, username: req.adminUser.username, email: req.adminUser.email,
      action: 'promo_code.updated', category: 'billing',
      targetType: 'promoCode', targetId: promoCode._id.toString(), targetName: promoCode.code,
      details: changes,
      ipAddress: req.ip
    });

    res.json(promoCode);
  } catch (error) {
    logger.error('Update promo code error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri aktualizácii promo kódu' });
  }
});

// Delete promo code
router.delete('/promo-codes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const promoCode = await PromoCode.findById(req.params.id);
    if (!promoCode) return res.status(404).json({ message: 'Promo kód nenájdený' });

    // Deactivate in Stripe (don't delete — keep for historical records)
    if (promoCode.stripePromotionCodeId && process.env.STRIPE_SECRET_KEY) {
      try {
        await stripe.promotionCodes.update(promoCode.stripePromotionCodeId, { active: false });
      } catch (stripeErr) {
        logger.warn('[PromoCode] Stripe deactivation failed', { error: stripeErr.message });
      }
    }

    const codeName = promoCode.code;
    await promoCode.deleteOne();

    auditService.logAction({
      userId: req.user.id, username: req.adminUser.username, email: req.adminUser.email,
      action: 'promo_code.deleted', category: 'billing',
      targetType: 'promoCode', targetId: req.params.id, targetName: codeName,
      details: {},
      ipAddress: req.ip
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete promo code error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri mazaní promo kódu' });
  }
});

// Get promo code stats
router.get('/promo-codes/:id/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const promoCode = await PromoCode.findById(req.params.id).populate('redemptions.userId', 'username email');
    if (!promoCode) return res.status(404).json({ message: 'Promo kód nenájdený' });

    res.json({
      code: promoCode.code,
      name: promoCode.name,
      usedCount: promoCode.usedCount,
      maxUses: promoCode.maxUses,
      isValid: promoCode.isValid(),
      redemptions: promoCode.redemptions.map(r => ({
        user: r.userId ? { username: r.userId.username, email: r.userId.email } : null,
        redeemedAt: r.redeemedAt,
        plan: r.plan,
        period: r.period
      }))
    });
  } catch (error) {
    logger.error('Promo code stats error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ─── DIAGNOSTICS DASHBOARD ─────────────────────────────────────────
// Endpointy pre SuperAdmin "Diagnostika" kartu:
//   - Errors (zoznam, detail, resolve, stats)
//   - Performance (pomalé endpointy, error rates)
//   - Health (full check snapshot)
//   - Active users (online + failed logins)
//   - Feature usage (agregácia z AuditLog)
//   - Revenue (MRR, plans breakdown, trials)
// ═══════════════════════════════════════════════════════════════════

// ─── ERRORS ────────────────────────────────────────────────────────

// GET /api/admin/errors — zoznam chýb
router.get('/errors', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.resolved === 'true') filter.resolved = true;
    else if (req.query.resolved === 'false') filter.resolved = false;
    if (req.query.source === 'server' || req.query.source === 'client') {
      filter.source = req.query.source;
    }
    if (req.query.search) {
      // ReDoS hardening — viď komentár v audit-log endpoint
      const safeSearch = escapeRegex(String(req.query.search).slice(0, 100));
      filter.$or = [
        { message: { $regex: safeSearch, $options: 'i' } },
        { path: { $regex: safeSearch, $options: 'i' } }
      ];
    }
    if (req.query.from) filter.lastSeen = { ...filter.lastSeen, $gte: new Date(req.query.from) };
    if (req.query.to) filter.lastSeen = { ...filter.lastSeen, $lte: new Date(req.query.to) };

    const [errors, total] = await Promise.all([
      ServerError.find(filter)
        .sort({ lastSeen: -1 })
        .skip(skip).limit(limit)
        .populate('userId', 'username email')
        .populate('resolvedBy', 'username email')
        .lean(),
      ServerError.countDocuments(filter)
    ]);

    res.json({
      errors,
      page,
      pages: Math.ceil(total / limit),
      total
    });
  } catch (error) {
    logger.error('Errors list error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/admin/errors/stats — agregovane pre top kartičky
router.get('/errors/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const h24 = new Date(now - 24 * 60 * 60 * 1000);
    const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [count24h, count7d, count30d, unresolved, topByCount] = await Promise.all([
      ServerError.countDocuments({ lastSeen: { $gte: h24 } }),
      ServerError.countDocuments({ lastSeen: { $gte: d7 } }),
      ServerError.countDocuments({ lastSeen: { $gte: d30 } }),
      ServerError.countDocuments({ resolved: false }),
      ServerError.find({ resolved: false }).sort({ count: -1 }).limit(5).select('message path count lastSeen').lean()
    ]);

    res.json({ count24h, count7d, count30d, unresolved, topByCount });
  } catch (error) {
    logger.error('Errors stats error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/admin/errors/:id — detail
router.get('/errors/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const err = await ServerError.findById(req.params.id)
      .populate('userId', 'username email')
      .populate('resolvedBy', 'username email')
      .lean();
    if (!err) return res.status(404).json({ message: 'Chyba nenájdená' });
    res.json(err);
  } catch (error) {
    logger.error('Error detail error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// PUT /api/admin/errors/:id/resolve — označiť opravené / znova otvoriť
router.put('/errors/:id/resolve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { resolved, notes } = req.body;
    const update = {
      resolved: !!resolved,
      notes: notes?.slice(0, 2000) || null
    };
    if (resolved) {
      update.resolvedBy = req.user.id;
      update.resolvedAt = new Date();
    } else {
      update.resolvedBy = null;
      update.resolvedAt = null;
    }
    const err = await ServerError.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!err) return res.status(404).json({ message: 'Chyba nenájdená' });
    res.json(err);
  } catch (error) {
    logger.error('Error resolve error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// DELETE /api/admin/errors/:id — manuálne zmazať záznam
router.delete('/errors/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await ServerError.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ message: 'Chyba nenájdená' });
    res.json({ success: true });
  } catch (error) {
    logger.error('Error delete error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─── PERFORMANCE ───────────────────────────────────────────────────

// GET /api/admin/performance/slow — top pomalé routes
router.get('/performance/slow', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const metrics = getMetrics();
    const routes = (metrics.topRoutes || [])
      .filter(r => r.avgDuration > 0)
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 20);
    res.json({ routes, totalRequests: metrics.totalRequests, errorRate: metrics.errorRate });
  } catch (error) {
    logger.error('Performance slow error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/admin/performance/errors-by-route — 4xx/5xx rate
router.get('/performance/errors-by-route', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const metrics = getMetrics();
    res.json({
      routes: metrics.topRoutes || [],
      statusCodes: metrics.statusCodes || {},
      hourly: metrics.hourly || []
    });
  } catch (error) {
    logger.error('Performance errors-by-route error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─── HEALTH (full snapshot) ────────────────────────────────────────

// GET /api/admin/health/full — posledný snapshot z healthMonitor
router.get('/health/full', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let snapshot = healthMonitor.getLastSnapshot();
    if (!snapshot.checkedAt) {
      snapshot = await healthMonitor.runChecks();
    }
    res.json(snapshot);
  } catch (error) {
    logger.error('Health full error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/admin/health/refresh — donúti okamžitý re-check
router.post('/health/refresh', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = await healthMonitor.runChecks();
    res.json(snapshot);
  } catch (error) {
    logger.error('Health refresh error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─── ACTIVE USERS ──────────────────────────────────────────────────

// GET /api/admin/online-users — aktuálne pripojení cez Socket.IO
router.get('/online-users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = onlineUsers.getOnlineUsers();
    res.json({
      count: onlineUsers.getOnlineCount(),
      socketCount: onlineUsers.getSocketCount(),
      users
    });
  } catch (error) {
    logger.error('Online users error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/admin/auth-events — login eventy za 24h
router.get('/auth-events', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const logs = await AuditLog.find({
      category: 'auth',
      action: { $in: ['auth.login', 'auth.login_failed', 'auth.register'] },
      createdAt: { $gte: since }
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    // Top IP-čky s najviac failed loginmi (potenciálny brute-force)
    const byIp = {};
    for (const log of logs) {
      if (log.action !== 'auth.login_failed') continue;
      const ip = log.ipAddress || 'unknown';
      if (!byIp[ip]) byIp[ip] = { ip, count: 0, emails: new Set(), reasons: {} };
      byIp[ip].count++;
      if (log.email) byIp[ip].emails.add(log.email);
      const reason = log.details?.reason || 'unknown';
      byIp[ip].reasons[reason] = (byIp[ip].reasons[reason] || 0) + 1;
    }
    const topFailingIPs = Object.values(byIp)
      .map(e => ({ ip: e.ip, count: e.count, emails: Array.from(e.emails), reasons: e.reasons }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({ events: logs, topFailingIPs });
  } catch (error) {
    logger.error('Auth events error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─── FEATURE USAGE (agregované z existujúceho AuditLog) ────────────

// GET /api/admin/usage?period=24h|7d|30d
router.get('/usage', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '7d';
    const periodMs = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000
    }[period] || 7 * 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - periodMs);

    const USAGE_ACTIONS = [
      'contact.created', 'contact.updated', 'contact.deleted',
      'task.created', 'task.deleted',
      'message.created', 'message.approved', 'message.rejected',
      'auth.register', 'auth.login',
      'workspace.created'
    ];

    const aggregation = await AuditLog.aggregate([
      { $match: { action: { $in: USAGE_ACTIONS }, createdAt: { $gte: since } } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
      { $project: { _id: 0, action: '$_id', count: 1 } },
      { $sort: { count: -1 } }
    ]);

    const daily = await AuditLog.aggregate([
      { $match: { action: { $in: USAGE_ACTIONS }, createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } },
      {
        $group: {
          _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } },
          count: { $sum: 1 }
        }
      },
      { $project: { _id: 0, day: '$_id.day', count: 1 } },
      { $sort: { day: 1 } }
    ]);

    res.json({ period, since, actions: aggregation, dailyTrend: daily });
  } catch (error) {
    logger.error('Usage aggregation error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─── REVENUE SNAPSHOT ──────────────────────────────────────────────

// GET /api/admin/revenue — MRR, plans breakdown, trials ending
router.get('/revenue', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const excludeSuperAdmin = { email: { $ne: SUPER_ADMIN_EMAIL } };

    // Plan prices (EUR/mes) — udržuj sync s BillingPage
    const PRICES = { free: 0, team: 4.99, pro: 9.99 };

    const now = new Date();
    const plans = await User.aggregate([
      { $match: excludeSuperAdmin },
      { $group: { _id: '$subscription.plan', count: { $sum: 1 } } }
    ]);
    const plansMap = plans.reduce((acc, p) => ({ ...acc, [p._id || 'free']: p.count }), {});

    const activePaidUsers = await User.find({
      ...excludeSuperAdmin,
      'subscription.plan': { $in: ['team', 'pro'] },
      'subscription.paidUntil': { $gt: now }
    }).select('subscription.plan subscription.period').lean();

    let mrr = 0;
    for (const u of activePaidUsers) {
      const plan = u.subscription?.plan;
      const period = u.subscription?.period || 'monthly';
      const price = PRICES[plan] || 0;
      mrr += period === 'yearly' ? price * 0.83 : price;
    }

    const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newSubs30d = await User.countDocuments({
      ...excludeSuperAdmin,
      'subscription.plan': { $in: ['team', 'pro'] },
      'subscription.createdAt': { $gte: d30 }
    });

    const in7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const endingSoon = await User.find({
      ...excludeSuperAdmin,
      'subscription.plan': { $in: ['team', 'pro'] },
      'subscription.paidUntil': { $gte: now, $lte: in7d }
    }).select('username email subscription.plan subscription.paidUntil').limit(20).lean();

    res.json({
      mrr: Math.round(mrr * 100) / 100,
      activePaidCount: activePaidUsers.length,
      plansBreakdown: plansMap,
      newSubs30d,
      endingSoon: endingSoon.map(u => ({
        username: u.username,
        email: u.email,
        plan: u.subscription?.plan,
        paidUntil: u.subscription?.paidUntil
      }))
    });
  } catch (error) {
    logger.error('Revenue error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─── EMAIL LOGS — admin overview of every email sent ────────────────────
//
// 4 endpoints back the "📧 Emaily" tab in AdminPanel:
//   GET  /email-logs           paginated list with filters
//   GET  /email-logs/:id       full HTML preview of a single mail
//   GET  /email-logs-stats     headline counters for dashboard cards
//   GET  /email-config         SMTP status + active promo codes
//   POST /users/:userId/send-email  manual trigger (reminder/winback)
//
// All require super admin (existing `requireAdmin`).

router.get('/email-logs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { type, status, search, from, to } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));

    const q = {};
    if (type) q.type = type;
    if (status) q.status = status;
    if (from || to) {
      q.sentAt = {};
      if (from) q.sentAt.$gte = new Date(from);
      if (to) q.sentAt.$lte = new Date(to);
    }
    if (search) {
      const safe = escapeRegex(String(search).slice(0, 100));
      const matchingUsers = await User.find({
        $or: [
          { email: { $regex: safe, $options: 'i' } },
          { username: { $regex: safe, $options: 'i' } }
        ]
      }).select('_id').limit(500).lean();
      q.$or = [
        { toEmail: { $regex: safe, $options: 'i' } },
        { userId: { $in: matchingUsers.map((u) => u._id) } }
      ];
    }

    const [total, logs] = await Promise.all([
      EmailLog.countDocuments(q),
      EmailLog.find(q)
        .sort({ sentAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('userId', 'username email avatar avatarData avatarMimetype color')
        .select('-htmlSnapshot') // omit big blob from list view
        .lean()
    ]);

    res.json({
      total,
      page,
      limit,
      logs: logs.map((l) => ({
        ...l,
        user: l.userId ? {
          _id: l.userId._id,
          username: l.userId.username,
          email: l.userId.email,
          color: l.userId.color,
          avatar: l.userId.avatar,
          hasAvatarData: !!l.userId.avatarData
        } : null,
        userId: l.userId?._id || null
      }))
    });
  } catch (err) {
    logger.error('Email logs list error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.get('/email-logs/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) return res.status(400).json({ message: 'Neplatné ID' });
    const log = await EmailLog.findById(req.params.id)
      .populate('userId', 'username email')
      .lean();
    if (!log) return res.status(404).json({ message: 'Záznam nenájdený' });
    res.json(log);
  } catch (err) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.get('/email-logs-stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [byStatus, byType, total7d, total30d, recentFailed] = await Promise.all([
      EmailLog.aggregate([
        { $match: { sentAt: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      EmailLog.aggregate([
        { $match: { sentAt: { $gte: since7d } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      EmailLog.countDocuments({ sentAt: { $gte: since7d } }),
      EmailLog.countDocuments({ sentAt: { $gte: since } }),
      EmailLog.find({ status: 'failed', sentAt: { $gte: since7d } })
        .sort({ sentAt: -1 })
        .limit(5)
        .select('toEmail type error sentAt')
        .lean()
    ]);

    const statusMap = byStatus.reduce((acc, r) => { acc[r._id] = r.count; return acc; }, {});
    const sentTotal = statusMap.sent || 0;
    const failedTotal = statusMap.failed || 0;
    const failureRate = sentTotal + failedTotal > 0
      ? Math.round((failedTotal / (sentTotal + failedTotal)) * 1000) / 10
      : 0;

    res.json({
      windowDays: days,
      total7d,
      total30d,
      byStatus: statusMap,
      failureRatePct: failureRate,
      topTypes7d: byType.map((t) => ({ type: t._id, count: t.count })),
      recentFailed
    });
  } catch (err) {
    logger.error('Email stats error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

router.get('/email-config', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const subEmail = require('../services/subscriptionEmailService');
    const transporter = subEmail.initTransporter();
    res.json({
      smtpConfigured: !!transporter,
      smtpHost: process.env.SMTP_HOST || null,
      smtpFrom: process.env.SMTP_FROM || '"PrplCRM" <hello@prplcrm.eu>',
      adminEmail: process.env.ADMIN_EMAIL || 'support@prplcrm.eu',
      promoCodes: subEmail.PROMO,
      reminderTypes: ['reminder_t7', 'reminder_t1', 'winback'],
      transactionalTypes: ['subscription_assigned', 'discount_assigned', 'expired', 'welcome_pro', 'welcome', 'invitation', 'password_reset']
    });
  } catch (err) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Per-user: zoznam posledných N mailov pre subscription editor
router.get('/users/:userId/email-logs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!req.params.userId.match(/^[0-9a-fA-F]{24}$/)) return res.status(400).json({ message: 'Neplatné ID' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const logs = await EmailLog.find({ userId: req.params.userId })
      .sort({ sentAt: -1 })
      .limit(limit)
      .select('-htmlSnapshot')
      .lean();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

/**
 * Mobile app launch — broadcast email všetkým aktívnym userom.
 * Cieľová skupina: users s `lastLogin` za posledných N dní (default 90).
 * Sequenčné odosielanie 1 mail/200ms aby sme nezahltili SMTP frontu a
 * neboli označení za bulk spam. Jeden run = ~5 min pre 1500 userov.
 *
 * Idempotency: EmailLog za posledných 30 dní pre `mobile_app_launch` type
 * znamená že userovi sme už mail poslali (cooldown sa nestará pre
 * non-marketing typy, ale tu si držíme vlastnú kontrolu).
 *
 * Mode `dryRun=true` len vráti počet cieľových userov bez reálneho
 * odoslania — pre admin previewujúceho impact.
 */
router.post('/email-broadcast/mobile-app-launch', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // activeWithinDays=null → všetci registrovaní userovia bez filtra.
    // Default 365 dní pre safety (užší rozsah, ale dostatočne široký pre väčšinu use-case-ov).
    // Filtrujeme cez createdAt — DB nemá lastLogin field, ale pre prvý broadcast
    // o mobile appke chceme zacieliť aj userov ktorí sa registrovali pred dlhšou dobou.
    const { activeWithinDays = null, dryRun = false } = req.body || {};
    const filter = {};
    if (activeWithinDays !== null) {
      const since = new Date(Date.now() - parseInt(activeWithinDays) * 24 * 60 * 60 * 1000);
      filter.createdAt = { $gte: since };
    }

    const targetUsers = await User.find(filter)
      .select('_id username email subscription preferences')
      .lean();

    // Filter out users that already received this broadcast
    const recentSentUserIds = await EmailLog.distinct('userId', {
      type: 'mobile_app_launch',
      status: 'sent',
      sentAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    });
    const recentSentSet = new Set(recentSentUserIds.map((id) => String(id)));

    const queue = targetUsers.filter((u) => !recentSentSet.has(String(u._id)));

    if (dryRun) {
      return res.json({
        dryRun: true,
        eligibleUsers: targetUsers.length,
        alreadySent: targetUsers.length - queue.length,
        toSend: queue.length
      });
    }

    // Async background send — nemôžeme blokovať admin response na 5 min.
    // Vraciame okamžite { started: true } a admin v Email tabe sleduje progress
    // cez log-y / countdown stats endpoint.
    res.json({
      started: true,
      eligibleUsers: targetUsers.length,
      alreadySent: targetUsers.length - queue.length,
      toSend: queue.length
    });

    // Fire-and-forget loop with rate limiting
    const subEmail = require('../services/subscriptionEmailService');
    const triggeredBy = `admin:${req.adminUser?.username || req.user.username}-broadcast`;
    let sent = 0, failed = 0;
    for (const u of queue) {
      try {
        const result = await subEmail.sendMobileAppLaunch({ user: u, triggeredBy });
        if (result.ok) sent++;
        else failed++;
      } catch (err) {
        failed++;
        logger.error('[Broadcast] mobile_app_launch error', { userId: String(u._id), error: err.message });
      }
      // 200ms throttle — 5 mails/sec, well under hostcreators SMTP limits
      await new Promise((r) => setTimeout(r, 200));
    }
    logger.info('[Broadcast] mobile_app_launch complete', { sent, failed, total: queue.length });
  } catch (err) {
    logger.error('Broadcast mobile_app_launch error', { error: err.message });
    res.status(500).json({ message: 'Chyba broadcast', error: err.message });
  }
});

// Test email — pošle preview ľubovoľného typu na ľubovoľnú adresu (mock dáta).
// Pre vizuálne testovanie šablón bez nutnosti meniť reálnemu userovi plán.
router.post('/email-test', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { toEmail, type } = req.body;
    if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
      return res.status(400).json({ message: 'Neplatný email' });
    }
    const allowed = ['subscription_assigned', 'discount_assigned', 'welcome_pro', 'reminder_t7', 'reminder_t1', 'expired', 'winback'];
    const t = allowed.includes(type) ? type : 'welcome_pro';

    // Mock user — neukladá sa, len ako payload pre template render. _id je
    // valídny ObjectId (potrebné pre unsubscribe token), ostatné fields
    // pokrývajú všetky templates.
    const mongoose = require('mongoose');
    const mockUser = {
      _id: new mongoose.Types.ObjectId(),
      username: 'Test User',
      email: toEmail,
      subscription: {
        plan: 'pro',
        paidUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        discount: {
          type: 'percentage', value: 25, targetPlan: 'pro',
          reason: 'Toto je testovací email pre vizuálnu kontrolu šablóny',
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        },
        notifications: {}
      }
    };

    const subEmail = require('../services/subscriptionEmailService');
    const triggeredBy = `admin:${req.adminUser?.username || 'test'}-preview`;
    let result;
    if (t === 'subscription_assigned') {
      result = await subEmail.sendSubscriptionAssigned({ user: mockUser, oldPlan: 'free', triggeredBy });
    } else if (t === 'discount_assigned') {
      result = await subEmail.sendDiscountAssigned({ user: mockUser, triggeredBy });
    } else if (t === 'welcome_pro') {
      result = await subEmail.sendWelcomePaid({ user: mockUser, triggeredBy });
    } else if (t === 'reminder_t7') {
      result = await subEmail.sendReminderT7({ user: mockUser, accountStats: { contactCount: 47, taskCount: 134, workspaceCount: 3 }, triggeredBy });
    } else if (t === 'reminder_t1') {
      result = await subEmail.sendReminderT1({ user: mockUser, triggeredBy });
    } else if (t === 'expired') {
      result = await subEmail.sendExpired({ user: { ...mockUser, subscription: { ...mockUser.subscription, plan: 'free' } }, previousPlan: 'pro', triggeredBy });
    } else if (t === 'winback') {
      result = await subEmail.sendWinback({ user: { ...mockUser, subscription: { ...mockUser.subscription, plan: 'free' } }, triggeredBy });
    }

    res.json({ success: result?.ok, status: result?.status, type: t, toEmail });
  } catch (err) {
    logger.error('Email test send error', { error: err.message });
    res.status(500).json({ message: 'Chyba pri odosielaní testu', error: err.message });
  }
});

// Manuálny trigger reminder/winback emailu — pre support workflow
router.post('/users/:userId/send-email', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { type } = req.body;
    const allowed = ['reminder_t7', 'reminder_t1', 'winback', 'expired', 'welcome_pro', 'subscription_assigned', 'discount_assigned'];
    if (!allowed.includes(type)) {
      return res.status(400).json({ message: 'Neplatný typ emailu pre manuálne odoslanie' });
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'Používateľ nenájdený' });

    const subEmail = require('../services/subscriptionEmailService');
    const triggeredBy = `admin:${req.adminUser?.username || req.user.username || 'unknown'}-manual`;

    let result;
    if (type === 'reminder_t7') {
      result = await subEmail.sendReminderT7({ user, triggeredBy });
    } else if (type === 'reminder_t1') {
      result = await subEmail.sendReminderT1({ user, triggeredBy });
    } else if (type === 'winback') {
      result = await subEmail.sendWinback({ user, triggeredBy });
    } else if (type === 'expired') {
      result = await subEmail.sendExpired({ user, previousPlan: user.subscription?.plan === 'free' ? 'pro' : user.subscription?.plan, triggeredBy });
    } else if (type === 'welcome_pro') {
      result = await subEmail.sendWelcomePaid({ user, triggeredBy });
    } else if (type === 'subscription_assigned') {
      result = await subEmail.sendSubscriptionAssigned({ user, oldPlan: 'free', triggeredBy });
    } else if (type === 'discount_assigned') {
      result = await subEmail.sendDiscountAssigned({ user, triggeredBy });
    }

    auditService.logAction({
      userId: req.user.id, username: req.adminUser?.username || req.user.username, email: req.adminUser?.email || req.user.email,
      action: 'user.email_manual_send', category: 'billing',
      targetType: 'user', targetId: req.params.userId, targetName: user.username,
      details: { type, status: result?.status },
      ipAddress: req.ip
    });

    res.json({ success: result?.ok, status: result?.status, logId: result?.logId });
  } catch (err) {
    logger.error('Manual email send error', { error: err.message });
    res.status(500).json({ message: 'Chyba pri odosielaní' });
  }
});

module.exports = router;
