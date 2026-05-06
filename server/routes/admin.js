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

    // Pre Task/Contact/Workspace counts treba excludnúť aj workspaces ktoré
    // patria super adminovi (jeho testovacie dáta by skreslovali produkčné
    // metriky). Najprv nájdeme jeho user._id, potom workspaces ktoré vlastní.
    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();
    const superAdminWorkspaceIds = superAdmin
      ? (await Workspace.find({ ownerId: superAdmin._id }).select('_id').lean()).map((w) => w._id)
      : [];
    const excludeSuperAdminWorkspaces = superAdminWorkspaceIds.length > 0
      ? { workspaceId: { $nin: superAdminWorkspaceIds } }
      : {};
    const excludeSuperAdminWsForWorkspaces = superAdminWorkspaceIds.length > 0
      ? { _id: { $nin: superAdminWorkspaceIds } }
      : {};

    const [
      totalUsers,
      totalWorkspaces,
      totalTasks,
      totalContacts,
      usersWithGoogleCalendar,
      usersWithGoogleTasks
    ] = await Promise.all([
      User.countDocuments(excludeSuperAdmin),
      Workspace.countDocuments(excludeSuperAdminWsForWorkspaces),
      Task.countDocuments(excludeSuperAdminWorkspaces),
      Contact.countDocuments(excludeSuperAdminWorkspaces),
      User.countDocuments({ ...excludeSuperAdmin, 'googleCalendar.enabled': true }),
      User.countDocuments({ ...excludeSuperAdmin, 'googleTasks.enabled': true })
    ]);

    // Subtasks count — rekurzívne cez JS po načítaní subtasks polí. Atlas má
    // server-side $function disabled by default (security policy), takže
    // aggregation $function nefunguje. Pre súčasnú škálu (~stovky Task docs)
    // je JS counting po lean() projekcii rýchlejšie ako $unwind reťaz a má
    // jasnú sémantiku. Pri raste > 50k Task docs zvážiť cache + denný recompute.
    const taskSubtaskDocs = await Task.find(excludeSuperAdminWorkspaces)
      .select('subtasks')
      .lean();
    const countSubtasksRecursive = (subtasks) => {
      if (!subtasks?.length) return 0;
      let count = subtasks.length;
      for (const s of subtasks) {
        if (s.subtasks?.length) count += countSubtasksRecursive(s.subtasks);
      }
      return count;
    };
    const totalSubtasks = taskSubtaskDocs.reduce(
      (sum, t) => sum + countSubtasksRecursive(t.subtasks || []),
      0
    );

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

    // Active workspaces (have at least 1 task or contact, excluding super admin)
    const activeWorkspaceIds = await Task.distinct('workspaceId', excludeSuperAdminWorkspaces);
    const activeWorkspaceIdsContacts = await Contact.distinct('workspaceId', excludeSuperAdminWorkspaces);
    const allActiveIds = new Set([
      ...activeWorkspaceIds.map(id => id.toString()),
      ...activeWorkspaceIdsContacts.map(id => id.toString())
    ]);

    res.json({
      totalUsers,
      totalWorkspaces,
      activeWorkspaces: allActiveIds.size,
      totalTasks,
      totalSubtasks,
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

// ─── ALL USERS (system-wide) — filter, sort, pagination, lastLogin ──
//
// Query params:
//   ?plan=free|team|pro          — filter by subscription plan
//   ?role=admin|manager|user     — filter by global role
//   ?active=true|false           — true = lastLogin za posledných 30d, false = inaktívny
//   ?hasStripe=true|false        — true = má Stripe sub (subscription.stripeSubscriptionId)
//   ?hasDiscount=true|false      — true = má discount metadata
//   ?search=…                    — substring search v username / email
//   ?sort=createdAt|username|email|plan|lastLogin
//   ?order=asc|desc              — default desc
//   ?page=1&limit=50             — pagination, default 50/page (clamped 10..200)
//
// Response shape:
//   { users: [...], total, page, limit, breakdown: { free, team, pro, admin } }
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { plan, role, active, hasStripe, hasDiscount, search } = req.query;
    const sort = ['createdAt', 'username', 'email', 'plan', 'lastLogin'].includes(req.query.sort)
      ? req.query.sort : 'createdAt';
    const order = req.query.order === 'asc' ? 1 : -1;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));

    // Base filter — vždy excludeneme super admina
    const filter = { email: { $ne: SUPER_ADMIN_EMAIL } };
    if (plan && ['free', 'team', 'pro'].includes(plan)) {
      filter['subscription.plan'] = plan;
    }
    if (role && ['admin', 'manager', 'user'].includes(role)) {
      filter.role = role;
    }
    if (hasStripe === 'true') {
      filter['subscription.stripeSubscriptionId'] = { $exists: true, $ne: null };
    } else if (hasStripe === 'false') {
      filter.$or = [
        { 'subscription.stripeSubscriptionId': { $exists: false } },
        { 'subscription.stripeSubscriptionId': null }
      ];
    }
    if (hasDiscount === 'true') {
      filter['subscription.discount.type'] = { $exists: true, $ne: null };
    }
    if (search && search.trim()) {
      const safe = escapeRegex(String(search).slice(0, 100));
      filter.$or = [
        { username: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } }
      ];
    }

    // Last login lookup z AuditLog. Robíme single aggregation (max createdAt)
    // na všetkých userov v poslednom rezultsete — efektívnejšie ako N+1.
    //
    // Match obsahuje 4 typy autentifikačných akcií aby sme zachytili
    // všetkých userov bez ohľadu na auth metódu:
    //   auth.login           — klasický password login
    //   auth.oauth.login     — Google / Apple existing user login
    //   auth.register        — klasická signup (implicit login po creation)
    //   auth.oauth.register  — OAuth signup (Google/Apple new user)
    //
    // Predtým match-oval len 'auth.login' → OAuth-only userovia mali
    // "nikdy" status aj keď sa reálne nedávno prihlásili.
    const recentLogins = await AuditLog.aggregate([
      {
        $match: {
          action: { $in: ['auth.login', 'auth.oauth.login', 'auth.register', 'auth.oauth.register'] },
          userId: { $exists: true }
        }
      },
      { $group: { _id: '$userId', lastLogin: { $max: '$createdAt' } } }
    ]);
    const lastLoginMap = new Map(recentLogins.map((r) => [String(r._id), r.lastLogin]));

    // Active filter — aplikujeme post-query lebo je závislý na aggregate hore.
    // Ak bolo `active` špecifikované, vyfiltrujeme query. Inak aplikujeme po
    // pagination (žiadny problém — UI default zobrazuje všetkých).
    const ACTIVE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
    const activeSince = new Date(Date.now() - ACTIVE_THRESHOLD_MS);

    if (active === 'true') {
      const activeUserIds = recentLogins
        .filter((r) => r.lastLogin >= activeSince)
        .map((r) => r._id);
      filter._id = { $in: activeUserIds };
    } else if (active === 'false') {
      const activeUserIds = recentLogins
        .filter((r) => r.lastLogin >= activeSince)
        .map((r) => r._id);
      filter._id = { $nin: activeUserIds };
    }

    // Spočítame total pred pagination + získame breakdown
    const [total, allMatchingUsers] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter, 'subscription.plan role').lean()
    ]);
    const breakdown = {
      free: 0, team: 0, pro: 0,
      admin: 0, manager: 0, user: 0,
      active: 0, inactive: 0
    };
    for (const u of allMatchingUsers) {
      const p = u.subscription?.plan || 'free';
      breakdown[p] = (breakdown[p] || 0) + 1;
      breakdown[u.role || 'user'] = (breakdown[u.role || 'user'] || 0) + 1;
      const ll = lastLoginMap.get(String(u._id));
      if (ll && ll >= activeSince) breakdown.active++;
      else breakdown.inactive++;
    }

    // Sort prep
    const sortMap = {
      createdAt: { createdAt: order },
      username: { username: order },
      email: { email: order },
      plan: { 'subscription.plan': order, createdAt: -1 }
    };
    // lastLogin sort sa nedá robiť priamo na User collection — riešime
    // post-fetch JS sortom (akceptovateľné pri page-size 50).

    let users;
    if (sort === 'lastLogin') {
      // fetch all matching, then JS sort, then slice
      users = await User.find(
        filter,
        'username email color avatar role subscription currentWorkspaceId googleCalendar.enabled googleTasks.enabled createdAt'
      ).lean();
      users.sort((a, b) => {
        const la = lastLoginMap.get(String(a._id))?.getTime() || 0;
        const lb = lastLoginMap.get(String(b._id))?.getTime() || 0;
        return order === 1 ? la - lb : lb - la;
      });
      users = users.slice((page - 1) * limit, page * limit);
    } else {
      users = await User.find(
        filter,
        'username email color avatar role subscription currentWorkspaceId googleCalendar.enabled googleTasks.enabled createdAt'
      )
        .sort(sortMap[sort] || sortMap.createdAt)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();
    }

    // Workspace memberships pre aktuálnu page
    const userIds = users.map(u => u._id);
    const memberships = await WorkspaceMember.find({ userId: { $in: userIds } })
      .populate('workspaceId', 'name slug')
      .lean();
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

    const result = users.map(u => {
      const lastLogin = lastLoginMap.get(String(u._id)) || null;
      const isActive = lastLogin ? lastLogin >= activeSince : false;
      const discount = u.subscription?.discount?.type ? {
        type: u.subscription.discount.type,
        value: u.subscription.discount.value,
        targetPlan: u.subscription.discount.targetPlan,
        expiresAt: u.subscription.discount.expiresAt,
        // Frontend label "vypršaná" pre discount-y kde expiresAt < now
        isExpired: u.subscription.discount.expiresAt
          ? new Date(u.subscription.discount.expiresAt) < new Date()
          : false
      } : null;

      return {
        id: u._id,
        username: u.username,
        email: u.email,
        color: u.color,
        avatar: u.avatar,
        role: u.role,
        plan: u.subscription?.plan || 'free',
        billingPeriod: u.subscription?.billingPeriod || null,
        paidUntil: u.subscription?.paidUntil || null,
        stripePaying: !!u.subscription?.stripeSubscriptionId,
        discount,
        googleCalendar: u.googleCalendar?.enabled || false,
        googleTasks: u.googleTasks?.enabled || false,
        createdAt: u.createdAt,
        lastLogin,
        isActive,
        workspaces: membershipMap[u._id.toString()] || []
      };
    });

    res.json({
      users: result,
      total,
      page,
      limit,
      breakdown
    });
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

    // Owner demotion guard — workspace musí mať aspoň jedného ownera. Ak by
    // sa user ktorého demotujeme bol jediným ownerom, blokujeme zmenu.
    // Riešenie: admin musí najprv povýšiť iného člena na ownera, potom
    // demotnúť pôvodného. Inak by workspace zostal "siroty" — žiadny user
    // by nemal full kontrolu (delete, member-management).
    if (oldRole === 'owner' && role !== 'owner') {
      const otherOwners = await WorkspaceMember.countDocuments({
        workspaceId,
        role: 'owner',
        userId: { $ne: req.params.userId }
      });
      if (otherOwners === 0) {
        return res.status(400).json({
          message: 'Nemôžete demotnúť jediného ownera workspace-u. Najprv povýšte iného člena na ownera.'
        });
      }
    }

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
// Query: ?search=&status=active|inactive|empty&ownerPlan=free|team|pro
//        &hasStripe=true|false&sort=createdAt|name|memberCount|lastActivity
//        &order=asc|desc&page=&limit=
router.get('/workspaces', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search, status, ownerPlan, hasStripe } = req.query;
    const sort = ['createdAt', 'name', 'memberCount', 'lastActivity'].includes(req.query.sort)
      ? req.query.sort : 'createdAt';
    const order = req.query.order === 'asc' ? 1 : -1;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));

    // Excludneme super admin workspaces — testovacie dáta neskreslia produkčné
    // metriky (rovnako ako v /stats endpointe).
    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();
    const superAdminWorkspaceIds = superAdmin
      ? (await Workspace.find({ ownerId: superAdmin._id }).select('_id').lean()).map((w) => w._id)
      : [];

    const wsFilter = {};
    if (superAdminWorkspaceIds.length > 0) {
      wsFilter._id = { $nin: superAdminWorkspaceIds };
    }
    if (search && search.trim()) {
      const safe = escapeRegex(String(search).slice(0, 100));
      wsFilter.name = { $regex: safe, $options: 'i' };
    }

    // Načítame všetky workspaces (po super admin exclusion + search) — agregácie
    // potrebujú vidieť celý relevantný set pred filter-om podľa status/ownerPlan
    // (ktoré sú post-filter v JS, lebo závisia od join-ov).
    const allMatchingWorkspaces = await Workspace.find(wsFilter).lean();
    const allWsIds = allMatchingWorkspaces.map((w) => w._id);

    // Súbeh agregátov — efektívne ak je workspace count mierny.
    const [memberCounts, memberRoleBreakdowns, taskCounts, contactCounts, messageCounts,
           contactLastActivity, taskLastActivity, messageLastActivity] = await Promise.all([
      WorkspaceMember.aggregate([
        { $match: { workspaceId: { $in: allWsIds } } },
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ]),
      // Per-role breakdown — owner / manager / member
      WorkspaceMember.aggregate([
        { $match: { workspaceId: { $in: allWsIds } } },
        { $group: { _id: { ws: '$workspaceId', role: '$role' }, count: { $sum: 1 } } }
      ]),
      Task.aggregate([
        { $match: { workspaceId: { $in: allWsIds } } },
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ]),
      Contact.aggregate([
        { $match: { workspaceId: { $in: allWsIds } } },
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ]),
      Message.aggregate([
        { $match: { workspaceId: { $in: allWsIds } } },
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ]),
      // lastActivity = max(updatedAt) z contact / task / message dokumentov
      Contact.aggregate([
        { $match: { workspaceId: { $in: allWsIds } } },
        { $group: { _id: '$workspaceId', lastAt: { $max: '$updatedAt' } } }
      ]),
      Task.aggregate([
        { $match: { workspaceId: { $in: allWsIds } } },
        { $group: { _id: '$workspaceId', lastAt: { $max: '$updatedAt' } } }
      ]),
      Message.aggregate([
        { $match: { workspaceId: { $in: allWsIds } } },
        { $group: { _id: '$workspaceId', lastAt: { $max: '$updatedAt' } } }
      ])
    ]);

    const memberCountMap = Object.fromEntries(memberCounts.map((mc) => [String(mc._id), mc.count]));
    const memberRolesMap = {};
    for (const r of memberRoleBreakdowns) {
      const wsId = String(r._id.ws);
      if (!memberRolesMap[wsId]) memberRolesMap[wsId] = { owner: 0, manager: 0, member: 0 };
      memberRolesMap[wsId][r._id.role] = r.count;
    }
    const taskCountMap = Object.fromEntries(taskCounts.map((tc) => [String(tc._id), tc.count]));
    const contactCountMap = Object.fromEntries(contactCounts.map((cc) => [String(cc._id), cc.count]));
    const messageCountMap = Object.fromEntries(messageCounts.map((mc) => [String(mc._id), mc.count]));

    // Zlučujeme last activity z 3 zdrojov — vezmeme max z {contact, task, message}.
    // Workspaces bez žiadnych dát majú lastActivity = null.
    const lastActivityMap = {};
    for (const arr of [contactLastActivity, taskLastActivity, messageLastActivity]) {
      for (const item of arr) {
        const wsId = String(item._id);
        const current = lastActivityMap[wsId];
        if (!current || item.lastAt > current) lastActivityMap[wsId] = item.lastAt;
      }
    }

    // Owner info — username, email, plan, stripeSubscriptionId
    const ownerIds = [...new Set(allMatchingWorkspaces.map((w) => w.ownerId.toString()))];
    const owners = await User.find({ _id: { $in: ownerIds } }, 'username email subscription.plan subscription.stripeSubscriptionId').lean();
    const ownerMap = Object.fromEntries(owners.map((o) => [String(o._id), {
      _id: o._id,
      username: o.username,
      email: o.email,
      plan: o.subscription?.plan || 'free',
      hasStripe: !!o.subscription?.stripeSubscriptionId
    }]));

    // Status detection per workspace:
    //   empty    — žiadne dáta (taskCount 0 + contactCount 0 + messageCount 0)
    //   inactive — má dáta ale lastActivity < now-30d (alebo žiadna aktivita)
    //   active   — lastActivity v posledných 30d
    const INACTIVE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
    const inactiveSince = new Date(Date.now() - INACTIVE_THRESHOLD_MS);

    // Build enriched + apply post-filter (status, ownerPlan, hasStripe)
    let enriched = allMatchingWorkspaces.map((w) => {
      const wsId = String(w._id);
      const tasks = taskCountMap[wsId] || 0;
      const contacts = contactCountMap[wsId] || 0;
      const messages = messageCountMap[wsId] || 0;
      const lastAct = lastActivityMap[wsId] || null;
      const isEmpty = tasks === 0 && contacts === 0 && messages === 0;
      const wsStatus = isEmpty ? 'empty' : (lastAct && lastAct >= inactiveSince ? 'active' : 'inactive');
      const owner = ownerMap[String(w.ownerId)] || { username: '?', email: '?', plan: 'free', hasStripe: false };

      return {
        id: w._id,
        name: w.name,
        slug: w.slug,
        color: w.color,
        owner,
        memberCount: memberCountMap[wsId] || 0,
        memberRoles: memberRolesMap[wsId] || { owner: 0, manager: 0, member: 0 },
        taskCount: tasks,
        contactCount: contacts,
        messageCount: messages,
        paidSeats: w.paidSeats || 0,
        createdAt: w.createdAt,
        lastActivity: lastAct,
        status: wsStatus
      };
    });

    // Post-filter
    if (status && ['active', 'inactive', 'empty'].includes(status)) {
      enriched = enriched.filter((w) => w.status === status);
    }
    if (ownerPlan && ['free', 'team', 'pro'].includes(ownerPlan)) {
      enriched = enriched.filter((w) => w.owner.plan === ownerPlan);
    }
    if (hasStripe === 'true') {
      enriched = enriched.filter((w) => w.owner.hasStripe);
    } else if (hasStripe === 'false') {
      enriched = enriched.filter((w) => !w.owner.hasStripe);
    }

    // Breakdown stats — na enriched DRŽ pred sort/pagination
    const breakdown = {
      total: enriched.length,
      active: enriched.filter((w) => w.status === 'active').length,
      inactive: enriched.filter((w) => w.status === 'inactive').length,
      empty: enriched.filter((w) => w.status === 'empty').length,
      withStripeOwner: enriched.filter((w) => w.owner.hasStripe).length
    };

    // Sort
    const sortFns = {
      createdAt: (a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) * order,
      name: (a, b) => a.name.localeCompare(b.name) * order,
      memberCount: (a, b) => (a.memberCount - b.memberCount) * order,
      lastActivity: (a, b) => {
        const av = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
        const bv = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
        return (av - bv) * order;
      }
    };
    enriched.sort(sortFns[sort]);

    // Pagination
    const total = enriched.length;
    const paged = enriched.slice((page - 1) * limit, page * limit);

    res.json({
      workspaces: paged,
      total,
      page,
      limit,
      breakdown
    });
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

    // Task stats — completed / pending split + recent
    const completedTasks = await Task.countDocuments({ workspaceId: id, completed: true });
    const pendingTasks = taskCount - completedTasks;
    const recentTasks = await Task.find({ workspaceId: id })
      .select('title completed priority dueDate createdAt')
      .sort({ createdAt: -1 }).limit(10).lean();

    // Message stats
    const pendingMessages = await Message.countDocuments({ workspaceId: id, status: 'pending' });
    const recentMessages = await Message.find({ workspaceId: id })
      .select('subject type status createdAt')
      .sort({ createdAt: -1 }).limit(10).lean();

    // Activity timeline — kombinácia z audit logu pre tento workspace
    // (posledné akcie členov v rámci workspace-u). Užitočné pre admina
    // ktorý chce vidieť "kto čo kedy v tomto workspace robil".
    const recentActivity = await AuditLog.find({ workspaceId: id })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('action category username targetName createdAt')
      .lean();

    // Last activity timestamp — max z contact/task/message updatedAt
    const [lastContactUpdate, lastTaskUpdate, lastMessageUpdate] = await Promise.all([
      Contact.findOne({ workspaceId: id }).sort({ updatedAt: -1 }).select('updatedAt').lean(),
      Task.findOne({ workspaceId: id }).sort({ updatedAt: -1 }).select('updatedAt').lean(),
      Message.findOne({ workspaceId: id }).sort({ updatedAt: -1 }).select('updatedAt').lean()
    ]);
    const lastActivity = [lastContactUpdate?.updatedAt, lastTaskUpdate?.updatedAt, lastMessageUpdate?.updatedAt]
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;

    res.json({
      workspace,
      members: enrichedMembers,
      stats: {
        contactCount, taskCount, completedTasks, pendingTasks,
        messageCount, pendingMessages
      },
      recentContacts,
      recentTasks,
      recentMessages,
      recentActivity,
      lastActivity
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
// Defaultne excludujeme super admin akcie (testovanie nezahŕňame do
// forenzných záznamov reálnej user-base). Cez ?includeSuperAdmin=true
// admin može override.
router.get('/audit-log', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, category, action, userId, from, to, search, includeSuperAdmin } = req.query;
    const parsedPage = Math.max(parseInt(page) || 1, 1);
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const skip = (parsedPage - 1) * parsedLimit;

    const query = {};
    if (category) query.category = category;
    if (action) query.action = action;
    if (userId) query.userId = userId;
    if (includeSuperAdmin !== 'true') {
      const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();
      if (superAdmin && !userId) {
        query.userId = { $ne: superAdmin._id };
      }
    }
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

// GET /api/admin/audit-log/stats — counts za rôzne obdobia + top users/actions
router.get('/audit-log/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();
    const baseFilter = superAdmin ? { userId: { $ne: superAdmin._id } } : {};

    const now = Date.now();
    const day = new Date(now - 24 * 60 * 60 * 1000);
    const week = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const month = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [count24h, count7d, count30d, topUsers7d, topActions7d, topCategories7d] = await Promise.all([
      AuditLog.countDocuments({ ...baseFilter, createdAt: { $gte: day } }),
      AuditLog.countDocuments({ ...baseFilter, createdAt: { $gte: week } }),
      AuditLog.countDocuments({ ...baseFilter, createdAt: { $gte: month } }),
      AuditLog.aggregate([
        { $match: { ...baseFilter, createdAt: { $gte: week }, username: { $exists: true, $ne: null } } },
        { $group: { _id: '$username', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]),
      AuditLog.aggregate([
        { $match: { ...baseFilter, createdAt: { $gte: week } } },
        { $group: { _id: '$action', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]),
      AuditLog.aggregate([
        { $match: { ...baseFilter, createdAt: { $gte: week } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    res.json({
      count24h, count7d, count30d,
      topUsers7d: topUsers7d.map((u) => ({ username: u._id, count: u.count })),
      topActions7d: topActions7d.map((a) => ({ action: a._id, count: a.count })),
      topCategories7d: topCategories7d.map((c) => ({ category: c._id, count: c.count }))
    });
  } catch (error) {
    logger.error('Admin audit log stats error', { error: error.message });
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

  // Externé service checks z health monitor cache (5 min TTL). Nezdržiavame
  // request live ping-om Google/SMTP API — jednak by to každé otvorenie
  // Prehľadu robilo I/O latency, jednak by sme museli držať timeouty. Cron
  // beží na pozadí každých 5 min a držíme last snapshot.
  let externalServices = null;
  try {
    const healthMonitor = require('../jobs/healthMonitor');
    const snapshot = healthMonitor.getLastSnapshot();
    if (snapshot?.checks) {
      externalServices = {
        smtp: snapshot.checks.smtp || { status: 'unknown' },
        apns: snapshot.checks.apns || { status: 'unknown' },
        google: snapshot.checks.google || { status: 'unknown' },
        checkedAt: snapshot.checkedAt
      };
    }
  } catch (err) {
    logger.warn('Health snapshot read failed', { error: err.message });
  }

  res.json({
    uptime: process.uptime(),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    database: { status: stateMap[mongoose.connection.readyState] || 'unknown' },
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development',
    externalServices,
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

    // Excludujeme akcie super admina aby chart reflektoval skutočnú user
    // base aktivitu, nie naše testovanie. Lookup userId-a a vyhodenie.
    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();
    const matchStage = { createdAt: { $gte: startDate } };
    if (superAdmin) {
      matchStage.userId = { $ne: superAdmin._id };
    }

    const activity = await AuditLog.aggregate([
      { $match: matchStage },
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

// Workspaces growth — analogicky k /charts/user-growth, ale ráta vznik
// workspace dokumentov. Excluduje super admin workspaces aby čísla
// odrážali produkčné metriky.
router.get('/charts/workspaces-growth', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const daysBack = parseInt(req.query.days) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();
    const excludeOwners = superAdmin ? { ownerId: { $ne: superAdmin._id } } : {};

    const growth = await Workspace.aggregate([
      { $match: { ...excludeOwners, createdAt: { $gte: startDate } } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 }
      }},
      { $sort: { _id: 1 } }
    ]);

    let cumulative = await Workspace.countDocuments({
      ...excludeOwners,
      createdAt: { $lt: startDate }
    });
    const dataMap = Object.fromEntries(growth.map((g) => [g._id, g.count]));

    const result = [];
    for (let d = new Date(startDate); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const daily = dataMap[key] || 0;
      cumulative += daily;
      result.push({ date: key, daily, cumulative });
    }
    res.json(result);
  } catch (error) {
    logger.error('Charts workspaces growth error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// Plans distribution v čase — pre každý deň v range vracia kumulatívny
// snapshot rozdelenia plánov podľa user.subscription.plan. Logika:
//  - berieme aktuálny stav user.subscription.plan
//  - rátame len užívateľov ktorí už existovali k danému dňu (createdAt <= day)
//  - približný — neberieme do úvahy historické plan zmeny (audit log by
//    bol presnejší, ale ten by vyžadoval per-day reconstruction history)
//  - pre PrplCRM scale je to akceptabilná aproximácia
router.get('/charts/plans-distribution', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const daysBack = parseInt(req.query.days) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const users = await User.find({ email: { $ne: SUPER_ADMIN_EMAIL } })
      .select('createdAt subscription.plan')
      .lean();

    const result = [];
    for (let d = new Date(startDate); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const dayEnd = new Date(d);
      dayEnd.setHours(23, 59, 59, 999);
      const buckets = { free: 0, team: 0, pro: 0 };
      for (const u of users) {
        if (new Date(u.createdAt) <= dayEnd) {
          const plan = u.subscription?.plan || 'free';
          if (buckets[plan] !== undefined) buckets[plan]++;
        }
      }
      result.push({
        date: d.toISOString().slice(0, 10),
        ...buckets,
        total: buckets.free + buckets.team + buckets.pro
      });
    }
    res.json(result);
  } catch (error) {
    logger.error('Charts plans distribution error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// Summary metrics pre stat cards na vrchu Grafy tabu — peak day, priemer,
// total za obdobie. Beží sériovo s ostatnými chart endpoint-mi v UI.
router.get('/charts/summary', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const daysBack = parseInt(req.query.days) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();

    const [newUsers, newWorkspaces, totalActivity] = await Promise.all([
      User.countDocuments({
        email: { $ne: SUPER_ADMIN_EMAIL },
        createdAt: { $gte: startDate }
      }),
      Workspace.countDocuments({
        ...(superAdmin ? { ownerId: { $ne: superAdmin._id } } : {}),
        createdAt: { $gte: startDate }
      }),
      AuditLog.countDocuments({
        createdAt: { $gte: startDate },
        ...(superAdmin ? { userId: { $ne: superAdmin._id } } : {})
      })
    ]);

    // Peak registration day v rozsahu
    const peakRegDayAgg = await User.aggregate([
      { $match: { email: { $ne: SUPER_ADMIN_EMAIL }, createdAt: { $gte: startDate } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ]);
    const peakRegDay = peakRegDayAgg[0] || null;

    res.json({
      windowDays: daysBack,
      newUsers,
      newWorkspaces,
      totalActivity,
      avgRegPerDay: Math.round((newUsers / daysBack) * 100) / 100,
      avgActivityPerDay: Math.round((totalActivity / daysBack) * 100) / 100,
      peakRegDay: peakRegDay ? { date: peakRegDay._id, count: peakRegDay.count } : null
    });
  } catch (error) {
    logger.error('Charts summary error', { error: error.message });
    res.status(500).json({ message: 'Chyba' });
  }
});

// ─── P3: REAL-TIME ACTIVITY FEED ──────────────────────────────
router.get('/activity-feed', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const after = req.query.after; // ISO date — pre polling NOVÝCH eventov
    const before = req.query.before; // ISO date — pre load-more (pagináciu nadol)
    const { category, action, search } = req.query;

    // Excludujeme super admin akcie aby feed reflektoval skutočnú user
    // base aktivitu, nie naše testovanie. Konzistentné s Grafmi.
    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();
    const query = {};
    if (superAdmin) {
      query.userId = { $ne: superAdmin._id };
    }
    if (after) query.createdAt = { $gt: new Date(after) };
    if (before) query.createdAt = { ...(query.createdAt || {}), $lt: new Date(before) };
    if (category && ['auth', 'contact', 'task', 'message', 'workspace', 'billing', 'user', 'security'].includes(category)) {
      query.category = category;
    }
    if (action && action.trim()) {
      // Action je presný string (e.g., "task.completed") — exact match
      query.action = action;
    }
    if (search && search.trim()) {
      const safe = escapeRegex(String(search).slice(0, 100));
      query.$or = [
        { username: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
        { targetName: { $regex: safe, $options: 'i' } }
      ];
    }

    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json(logs.map(l => ({
      id: l._id,
      action: l.action,
      category: l.category,
      userId: l.userId, // pre klik-na-username navigáciu
      username: l.username,
      email: l.email,
      targetType: l.targetType,
      targetId: l.targetId,
      targetName: l.targetName,
      workspaceId: l.workspaceId,
      details: l.details,
      ipAddress: l.ipAddress,
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

    // Známe kolekcie ktoré sledujeme — postupne sme pridali nové (emaillogs,
    // fcmdevices, servererrors, promocodes). Nediagnostikované kolekcie sa
    // automaticky preskočia v try/catch ak nie sú vytvorené.
    const collections = [
      'users', 'workspaces', 'workspacemembers',
      'contacts', 'tasks', 'messages',
      'notifications', 'pushsubscriptions', 'apnsdevices', 'fcmdevices',
      'auditlogs', 'servererrors', 'pages',
      'emaillogs', 'promocodes', 'invitations'
    ];
    const collectionStats = [];

    // Pre growth trend potrebujeme týždeň starý cutoff. Per-collection
    // count documents s createdAt > 7d back — len pre kolekcie s `createdAt`
    // poľom (väčšina, ale niektoré legacy kolekcie ho nemusia mať).
    const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    for (const name of collections) {
      try {
        const stats = await db.command({ collStats: name });
        let last7d = null;
        try {
          last7d = await db.collection(name).countDocuments({ createdAt: { $gte: week } });
        } catch { /* createdAt may not exist on this collection */ }
        collectionStats.push({
          name,
          count: stats.count,
          size: stats.size,
          avgObjSize: Math.round(stats.avgObjSize || 0),
          storageSize: stats.storageSize,
          indexSize: stats.totalIndexSize,
          // null = createdAt sa nepodarilo zistiť, 0 = žiadne nové, čísla > 0 sú growth
          growth7d: last7d
        });
      } catch {
        // Collection might not exist yet
      }
    }

    // Storage per workspace (contacts + tasks + messages) — excludujeme
    // workspaces super admina aby produkčné metriky neboli skreslené testovacími.
    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();
    const superAdminWsIds = superAdmin
      ? (await Workspace.find({ ownerId: superAdmin._id }).select('_id').lean()).map((w) => w._id)
      : [];
    const wsExcludeMatch = superAdminWsIds.length > 0
      ? { workspaceId: { $nin: superAdminWsIds } }
      : {};

    const workspaceStorage = await Promise.all([
      Contact.aggregate([
        { $match: wsExcludeMatch },
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ]),
      Task.aggregate([
        { $match: wsExcludeMatch },
        { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
      ]),
      Message.aggregate([
        { $match: wsExcludeMatch },
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

    // Atlas tier hint — Free M0 má 512 MB limit, M2 2 GB, M5 5 GB. Hodnota
    // sa nedá zistiť z dbStats, ale podľa storageSize odhadneme strop.
    // Presný strop si admin nakonfiguruje cez ATLAS_TIER_LIMIT_MB env var.
    const tierLimitMb = parseInt(process.env.ATLAS_TIER_LIMIT_MB) || 512;
    const tierLimitBytes = tierLimitMb * 1024 * 1024;

    res.json({
      database: {
        dataSize: dbStats.dataSize,
        storageSize: dbStats.storageSize,
        indexSize: dbStats.indexSize,
        collections: dbStats.collections,
        tierLimitMb,
        tierLimitBytes,
        usagePct: Math.round((dbStats.storageSize / tierLimitBytes) * 1000) / 10
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
    // Excludujeme workspaces super admina (jeho testovacie dáta skreslujú
    // porovnanie aktivity reálnych užívateľov). Konzistentné s ostatnými tabmi.
    const superAdmin = await User.findOne({ email: SUPER_ADMIN_EMAIL }).select('_id').lean();
    const wsFilter = superAdmin ? { ownerId: { $ne: superAdmin._id } } : {};

    const workspaces = await Workspace.find(wsFilter).select('name slug color ownerId createdAt').lean();
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
    res.json({
      routes,
      totalRequests: metrics.totalRequests,
      errorRate: metrics.errorRate,
      // Timestamp od kedy sa metriky zbierajú — pre kontext "Avg za posledné X hodín".
      // apiMetrics exportuje pole ako `trackingSince`.
      startedAt: metrics.trackingSince || null,
      requestsPerMinute: metrics.requestsPerMinute || 0
    });
  } catch (error) {
    logger.error('Performance slow error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/admin/performance/reset — vyčistí in-memory apiMetrics.
// Užitočné pri performance debugovaní (po deployi alebo pri sledovaní efektu
// optimizácie nechceme staré priemery skreslovať novšie merania).
router.post('/performance/reset', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const apiMetricsModule = require('../services/apiMetrics');
    if (typeof apiMetricsModule.resetMetrics === 'function') {
      apiMetricsModule.resetMetrics();
      logger.info('[Performance] Metrics reset by admin', { username: req.adminUser?.username || req.user?.username });
      return res.json({ success: true, resetAt: new Date() });
    }
    return res.status(501).json({ message: 'apiMetrics nepodporuje reset' });
  } catch (error) {
    logger.error('Performance reset error', { error: error.message });
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

// GET /api/admin/health/full — posledný snapshot z healthMonitor.
// Predtým: ak prvý cron ešte nebehol, synchronne čakal na runChecks (~3-5s
// SMTP+Google ping) → UI zaseklé na "Načítavam...". Teraz: vrátime okamžite
// to čo máme (môže byť čiastočne prázdny snapshot) + spustíme background
// runChecks pre next request. Druhý refresh ukáže plné dáta.
router.get('/health/full', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = healthMonitor.getLastSnapshot();
    if (!snapshot.checkedAt) {
      // Background warmup — nečakáme. UI dostane prázdny snapshot a má
      // tlačidlo "🔄 Re-check" ktoré vyrobí plný refresh keď user chce.
      healthMonitor.runChecks().catch((err) =>
        logger.error('[Health] background warmup failed', { error: err.message })
      );
      return res.json({ checks: {}, checkedAt: null, warmingUp: true });
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

    // Zoznam audit log akcií ktoré sledujeme ako "feature usage" metriky.
    // Rozšírený o task.completed (kľúčová business KPI), task.updated,
    // subtask.* (granularitu projektov), notification.read (engagement),
    // auth.login_failed (security signal). Frontend renderuje ich
    // human-readable labely cez translation map.
    const USAGE_ACTIONS = [
      'contact.created', 'contact.updated', 'contact.deleted',
      'task.created', 'task.updated', 'task.completed', 'task.deleted',
      'subtask.created', 'subtask.completed',
      'message.created', 'message.approved', 'message.rejected',
      'auth.register', 'auth.login', 'auth.login_failed',
      'notification.read',
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

    // Plan prices (EUR) — sync s BillingPage. Pre presný MRR pre yearly
    // userov delíme yearly cenu /12 (predtým bol hrubý odhad price * 0.83
    // ktorý nadhodnocoval ~1%). Schema field je `billingPeriod` (nie
    // `period` — pôvodný bug spôsobil že yearly users sa rátali ako monthly).
    const PRICES = {
      free: { monthly: 0, yearly: 0 },
      team: { monthly: 4.99, yearly: 49.00 },
      pro: { monthly: 9.99, yearly: 99.00 }
    };

    const now = new Date();
    const plans = await User.aggregate([
      { $match: excludeSuperAdmin },
      { $group: { _id: '$subscription.plan', count: { $sum: 1 } } }
    ]);
    const plansMap = plans.reduce((acc, p) => ({ ...acc, [p._id || 'free']: p.count }), {});

    // Všetci active "paid plan" users (môžu byť Stripe aj admin-granted)
    const allActivePaidUsers = await User.find({
      ...excludeSuperAdmin,
      'subscription.plan': { $in: ['team', 'pro'] },
      'subscription.paidUntil': { $gt: now }
    }).select('subscription.plan subscription.billingPeriod subscription.stripeSubscriptionId').lean();

    // MRR ráta IBA Stripe-managed users — admin-granted upgrades (free
    // months, planUpgrade discount, manuálne plán prirídenia) NIE sú reálny
    // revenue, len business-courtesy. Bez tohto by graf MRR ukazoval falošné
    // číslo aj keď žiadna reálna platba neprebehla. Stripe-managed identifier
    // je `subscription.stripeSubscriptionId` (non-null = user má actívne sub
    // s reálnym billing cyklom).
    const stripePaidUsers = allActivePaidUsers.filter((u) => u.subscription?.stripeSubscriptionId);
    const adminGrantedUsers = allActivePaidUsers.filter((u) => !u.subscription?.stripeSubscriptionId);

    let mrr = 0;
    for (const u of stripePaidUsers) {
      const plan = u.subscription?.plan;
      const billingPeriod = u.subscription?.billingPeriod || 'monthly';
      const priceConfig = PRICES[plan] || PRICES.free;
      const monthlyEquiv = billingPeriod === 'yearly'
        ? priceConfig.yearly / 12
        : priceConfig.monthly;
      mrr += monthlyEquiv;
    }

    // Nové Stripe subscriptions za posledných 30d. Filter na audit log
    // billing kategóriu — admin-granted upgrades sa rátajú samostatne, sem
    // ide len reálny Stripe checkout (action 'billing.checkout_completed'
    // alebo 'billing.subscription_created' podľa nášho audit log namingu).
    const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newStripeSubs30d = await AuditLog.countDocuments({
      category: 'billing',
      action: { $in: ['billing.checkout_completed', 'billing.subscription_created', 'billing.subscription_renewed'] },
      createdAt: { $gte: d30 }
    });
    // Admin-granted za 30d — pre kontext (info-only, nie revenue)
    const newAdminGranted30d = await AuditLog.countDocuments({
      category: 'billing',
      action: { $in: ['user.plan_changed', 'user.subscription_updated', 'user.discount_applied'] },
      createdAt: { $gte: d30 },
      'details.newPlan': { $in: ['team', 'pro'] }
    });

    const in7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const endingSoon = await User.find({
      ...excludeSuperAdmin,
      'subscription.plan': { $in: ['team', 'pro'] },
      'subscription.paidUntil': { $gte: now, $lte: in7d }
    }).select('username email subscription.plan subscription.paidUntil subscription.billingPeriod subscription.stripeSubscriptionId').limit(20).lean();

    res.json({
      mrr: Math.round(mrr * 100) / 100,
      // Active Stripe-paying users — toto je real revenue base
      stripePaidCount: stripePaidUsers.length,
      // Admin-granted "paid plan" users — informatívne, bez vplyvu na MRR
      adminGrantedCount: adminGrantedUsers.length,
      // Total all active paid plans (Stripe + admin-granted)
      activePaidCount: allActivePaidUsers.length,
      plansBreakdown: plansMap,
      // Rozdiel medzi reálnymi novými platbami a admin akciami
      newStripeSubs30d,
      newAdminGranted30d,
      endingSoon: endingSoon.map(u => ({
        username: u.username,
        email: u.email,
        plan: u.subscription?.plan,
        paidUntil: u.subscription?.paidUntil,
        billingPeriod: u.subscription?.billingPeriod || 'monthly',
        isStripe: !!u.subscription?.stripeSubscriptionId
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
    const { type, status, search, from, to, sort, order } = req.query;
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

    // Whitelist sort fields — bezpečne pred user-input do MongoDB
    const sortField = ['sentAt', 'toEmail', 'type', 'status'].includes(sort) ? sort : 'sentAt';
    const sortDir = order === 'asc' ? 1 : -1;

    const [total, logs] = await Promise.all([
      EmailLog.countDocuments(q),
      EmailLog.find(q)
        .sort({ [sortField]: sortDir })
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

    // Daily aggregation pre line-chart (volume + failure trend). Group by
    // YYYY-MM-DD pomocou $dateToString — Atlas-friendly, žiadne JS post-processing
    // potrebné.
    const [byStatus, byType, total7d, total30d, recentFailed, daily] = await Promise.all([
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
        .lean(),
      EmailLog.aggregate([
        { $match: { sentAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$sentAt' } },
            sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            skipped: { $sum: { $cond: [{ $regexMatch: { input: '$status', regex: /^skipped/ } }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ])
    ]);

    const statusMap = byStatus.reduce((acc, r) => { acc[r._id] = r.count; return acc; }, {});
    const sentTotal = statusMap.sent || 0;
    const failedTotal = statusMap.failed || 0;
    const failureRate = sentTotal + failedTotal > 0
      ? Math.round((failedTotal / (sentTotal + failedTotal)) * 1000) / 10
      : 0;

    // Fill missing days s 0, aby chart neukazoval medzery
    const dailyMap = daily.reduce((acc, d) => { acc[d._id] = d; return acc; }, {});
    const dailyFilled = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const entry = dailyMap[key] || { _id: key, sent: 0, failed: 0, skipped: 0 };
      dailyFilled.push({ date: key, sent: entry.sent, failed: entry.failed, skipped: entry.skipped });
    }

    res.json({
      windowDays: days,
      total7d,
      total30d,
      byStatus: statusMap,
      failureRatePct: failureRate,
      topTypes7d: byType.map((t) => ({ type: t._id, count: t.count })),
      recentFailed,
      daily: dailyFilled
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

/**
 * MED-003 follow-up — bulk encrypt plaintext OAuth tokens.
 *
 * Problém: pre('save') hook šifruje iba modifikované polia (`isModified`).
 * accessToken-y sa šifrujú prirodzene cez hodinový Google refresh cyklus,
 * ale refreshToken-y sa pri OAuth nastavia raz, nikdy sa nemodifikujú →
 * legacy záznamy z času pred MED-003 deployom ostávajú plaintext v DB.
 *
 * Tento endpoint prejde všetky users, deteguje plaintext (chýba `enc:v1:`
 * prefix), zašifruje a uloží. Idempotentný — opakované volanie nemení
 * už-zašifrované tokeny. Po prvom úspešnom run-e je migration hotová.
 */
router.post('/migrate-encrypt-tokens', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { encryptToken, isEncrypted } = require('../utils/cryptoHelpers');
    const PATHS = [
      'googleCalendar.accessToken',
      'googleCalendar.refreshToken',
      'googleTasks.accessToken',
      'googleTasks.refreshToken'
    ];

    // Načítavame iba minimum potrebných polí — nepublikujeme celé heslá hashe
    // ani avatary. dryRun mode vráti len počty bez zápisu.
    const dryRun = req.body?.dryRun === true;
    const users = await User.find({
      $or: [
        { 'googleCalendar.accessToken': { $exists: true, $ne: null } },
        { 'googleCalendar.refreshToken': { $exists: true, $ne: null } },
        { 'googleTasks.accessToken': { $exists: true, $ne: null } },
        { 'googleTasks.refreshToken': { $exists: true, $ne: null } }
      ]
    }).select('googleCalendar.accessToken googleCalendar.refreshToken googleTasks.accessToken googleTasks.refreshToken');

    const stats = {
      usersScanned: users.length,
      perPath: {}
    };
    PATHS.forEach((p) => { stats.perPath[p] = { plaintext: 0, encrypted: 0, migrated: 0 }; });

    for (const user of users) {
      // Skip post('init') hook — chceme raw hodnoty z DB, nie auto-decrypt-nuté.
      // Najjednoduchšie: použijeme aggregation read alebo ťaháme znova lean.
      const raw = await User.collection.findOne(
        { _id: user._id },
        {
          projection: {
            'googleCalendar.accessToken': 1,
            'googleCalendar.refreshToken': 1,
            'googleTasks.accessToken': 1,
            'googleTasks.refreshToken': 1
          }
        }
      );
      if (!raw) continue;

      const updates = {};
      for (const path of PATHS) {
        const [outer, inner] = path.split('.');
        const value = raw[outer]?.[inner];
        if (!value) continue;

        if (isEncrypted(value)) {
          stats.perPath[path].encrypted++;
        } else {
          stats.perPath[path].plaintext++;
          if (!dryRun) {
            const encrypted = encryptToken(value);
            if (isEncrypted(encrypted)) {
              updates[path] = encrypted;
              stats.perPath[path].migrated++;
            }
          }
        }
      }

      if (!dryRun && Object.keys(updates).length > 0) {
        // Použijeme priamy updateOne (bypass pre('save') hook ktorý by
        // detekoval že hodnota je už šifrovaná a nepokazil to, ale aj tak
        // chceme rýchly direct write bez hook-ovania).
        await User.updateOne({ _id: user._id }, { $set: updates });
      }
    }

    auditService.logAction({
      userId: req.user.id,
      username: req.adminUser?.username || req.user.username,
      email: req.adminUser?.email || req.user.email,
      action: 'admin.migrate_encrypt_tokens',
      category: 'security',
      details: { dryRun, stats },
      ipAddress: req.ip
    });

    res.json({ success: true, dryRun, stats });
  } catch (err) {
    logger.error('Migrate encrypt tokens error', { error: err.message });
    res.status(500).json({ message: 'Chyba pri migrácii', error: err.message });
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
    const allowed = ['subscription_assigned', 'discount_assigned', 'welcome_pro', 'reminder_t7', 'reminder_t1', 'expired', 'winback', 'welcome', 'mobile_app_launch'];
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
    } else if (t === 'mobile_app_launch') {
      result = await subEmail.sendMobileAppLaunch({ user: mockUser, triggeredBy });
    } else if (t === 'welcome') {
      // Welcome email žije v adminEmailService (legacy flow), nie subscription
      // service. Returns boolean true/false, normalizujeme na rovnaký shape.
      const adminEmail = require('../services/adminEmailService');
      const ok = await adminEmail.sendWelcomeEmail({ toEmail, username: mockUser.username });
      result = { ok, status: ok ? 'sent' : 'failed' };
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
