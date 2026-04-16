const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const Invitation = require('../models/Invitation');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace, requireWorkspaceAdmin, requireWorkspaceOwner, invalidateCache } = require('../middleware/workspace');
const logger = require('../utils/logger');
const { sendInvitationEmail } = require('../services/adminEmailService');
const notificationService = require('../services/notificationService');

// Get all workspaces user is member of
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Run both queries in parallel + only populate needed fields
    const [memberships, user] = await Promise.all([
      WorkspaceMember.find({ userId: req.user.id })
        .populate('workspaceId', 'name slug description color'),
      User.findById(req.user.id, 'currentWorkspaceId')
    ]);

    const workspaces = memberships
      .filter(m => m.workspaceId) // Guard against deleted workspaces
      .map(m => ({
        id: m.workspaceId._id,
        name: m.workspaceId.name,
        slug: m.workspaceId.slug,
        description: m.workspaceId.description,
        color: m.workspaceId.color,
        role: m.role,
        joinedAt: m.joinedAt,
        isOwner: m.role === 'owner'
      }));

    res.json({
      workspaces,
      currentWorkspaceId: user.currentWorkspaceId
    });
  } catch (error) {
    logger.error('Get workspaces error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get current workspace details
router.get('/current', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const memberCount = await WorkspaceMember.countDocuments({ workspaceId: req.workspace._id });

    const owner = await User.findById(req.workspace.ownerId);
    const paidSeats = req.workspace.paidSeats || 0;
    const ownerPlan = owner?.subscription?.plan || 'free';
    const memberLimitsMap = { free: 2, trial: 2, team: 10, pro: Infinity };
    const baseLimit = memberLimitsMap[ownerPlan] || 2;
    const maxMembers = baseLimit === Infinity ? Infinity : baseLimit + paidSeats;

    const isOverLimit = maxMembers !== Infinity && memberCount > maxMembers;

    res.json({
      id: req.workspace._id,
      name: req.workspace.name,
      slug: req.workspace.slug,
      description: req.workspace.description,
      color: req.workspace.color,
      inviteCode: req.workspaceMember.canAdmin() ? req.workspace.inviteCode : undefined,
      inviteCodeEnabled: req.workspace.inviteCodeEnabled,
      settings: req.workspace.settings,
      role: req.workspaceMember.role,
      memberCount,
      paidSeats,
      maxMembers,
      ownerPlan,
      isOverLimit,
      createdAt: req.workspace.createdAt
    });
  } catch (error) {
    logger.error('Get current workspace error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Create new workspace
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, color } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ message: 'Názov je povinný' });
    }

    if (name.length > 100) {
      return res.status(400).json({ message: 'Názov môže mať maximálne 100 znakov' });
    }

    // Generate slug and invite code
    const slug = await Workspace.generateSlug(name);
    const inviteCode = Workspace.generateInviteCode();

    // Create workspace
    const workspace = new Workspace({
      name: name.trim(),
      slug,
      description: description?.trim() || '',
      color: color || '#6366f1',
      ownerId: req.user.id,
      inviteCode,
      inviteCodeEnabled: true
    });

    await workspace.save();

    // Create owner membership
    const membership = new WorkspaceMember({
      workspaceId: workspace._id,
      userId: req.user.id,
      role: 'owner',
      invitedBy: null
    });

    await membership.save();

    // Set as current workspace
    await User.findByIdAndUpdate(req.user.id, { currentWorkspaceId: workspace._id });

    logger.info('Workspace created', { workspaceId: workspace._id, userId: req.user.id, name });

    res.status(201).json({
      id: workspace._id,
      name: workspace.name,
      slug: workspace.slug,
      description: workspace.description,
      color: workspace.color,
      inviteCode: workspace.inviteCode,
      inviteCodeEnabled: workspace.inviteCodeEnabled,
      role: 'owner'
    });
  } catch (error) {
    logger.error('Create workspace error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Join workspace by invite code
router.post('/join', authenticateToken, async (req, res) => {
  try {
    const { inviteCode } = req.body;

    if (!inviteCode) {
      return res.status(400).json({ message: 'Kód pozvánky je povinný' });
    }

    // Find workspace by invite code
    const workspace = await Workspace.findOne({
      inviteCode: inviteCode.toUpperCase(),
      inviteCodeEnabled: true
    });

    if (!workspace) {
      return res.status(404).json({ message: 'Neplatný alebo neaktívny kód pozvánky' });
    }

    // Check if already a member
    const existingMembership = await WorkspaceMember.findOne({
      workspaceId: workspace._id,
      userId: req.user.id
    });

    if (existingMembership) {
      // Already a member - just switch to this workspace
      await User.findByIdAndUpdate(req.user.id, { currentWorkspaceId: workspace._id });

      return res.json({
        message: 'Už ste členom tohto pracovného prostredia',
        workspace: {
          id: workspace._id,
          name: workspace.name,
          slug: workspace.slug,
          role: existingMembership.role
        }
      });
    }

    // Check workspace member limits based on owner's plan and paid seats
    const joiningUser = await User.findById(req.user.id);
    const owner = await User.findById(workspace.ownerId);
    const memberCount = await WorkspaceMember.countDocuments({ workspaceId: workspace._id });

    // Team Pro emails bypass capacity check
    const proEmails = (process.env.PRO_EMAILS || 'project.manager@eperun.sk,martin.kosco@eperun.sk').split(',').map(e => e.trim()).filter(Boolean);
    const isTeamPro = proEmails.includes(owner?.email?.toLowerCase()) || proEmails.includes(joiningUser?.email?.toLowerCase());

    if (!isTeamPro) {
      const ownerPlan = owner?.subscription?.plan || 'free';
      const memberLimits = { free: 2, trial: 2, team: 10, pro: Infinity };
      const baseSeatLimit = memberLimits[ownerPlan] || 2;
      if (baseSeatLimit !== Infinity) {
        const maxSeats = baseSeatLimit + (workspace.paidSeats || 0);
        if (memberCount >= maxSeats) {
          return res.status(403).json({ message: `Váš plán umožňuje max. ${baseSeatLimit} používateľov v tíme. Pre viac členov prejdite na vyšší plán.` });
        }
      }
    }

    // Create membership
    const membership = new WorkspaceMember({
      workspaceId: workspace._id,
      userId: req.user.id,
      role: workspace.settings.defaultMemberRole || 'member',
      invitedBy: null // Joined via code
    });

    await membership.save();

    // Set as current workspace
    await User.findByIdAndUpdate(req.user.id, { currentWorkspaceId: workspace._id });

    logger.info('User joined workspace', { workspaceId: workspace._id, userId: req.user.id });

    res.json({
      message: 'Úspešne ste sa pripojili k pracovnému prostrediu',
      workspace: {
        id: workspace._id,
        name: workspace.name,
        slug: workspace.slug,
        color: workspace.color,
        role: membership.role
      }
    });
  } catch (error) {
    logger.error('Join workspace error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Switch current workspace
router.post('/switch/:workspaceId', authenticateToken, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ message: 'Neplatné ID pracovného prostredia' });
    }

    const objectId = new mongoose.Types.ObjectId(workspaceId);

    // Verify workspace exists
    const workspace = await Workspace.findById(objectId);
    if (!workspace) {
      return res.status(404).json({ message: 'Pracovné prostredie neexistuje' });
    }

    // Verify membership
    const membership = await WorkspaceMember.findOne({
      workspaceId: objectId,
      userId: req.user.id
    });

    if (!membership) {
      return res.status(403).json({ message: 'Nie ste členom tohto pracovného prostredia' });
    }

    // Update current workspace with proper ObjectId
    await User.findByIdAndUpdate(req.user.id, { currentWorkspaceId: objectId });
    invalidateCache(req.user.id);

    // Vraciame FULL workspace shape (rovnaký ako GET /current), aby klient
    // v jednom React render tiku atomicky nastavil currentWorkspaceId +
    // currentWorkspace. Second roundtrip GET /current by otvoril race window
    // (cross-workspace deep-link bug, commit c18a9b2).
    const memberCount = await WorkspaceMember.countDocuments({ workspaceId: workspace._id });
    const owner = await User.findById(workspace.ownerId);
    const paidSeats = workspace.paidSeats || 0;
    const ownerPlan = owner?.subscription?.plan || 'free';
    const memberLimitsMap = { free: 2, trial: 2, team: 10, pro: Infinity };
    const baseLimit = memberLimitsMap[ownerPlan] || 2;
    const maxMembers = baseLimit === Infinity ? Infinity : baseLimit + paidSeats;
    const isOverLimit = maxMembers !== Infinity && memberCount > maxMembers;

    logger.info('Workspace switched', { workspaceId: objectId, userId: req.user.id });

    res.json({
      message: 'Pracovné prostredie bolo prepnuté',
      workspace: {
        id: workspace._id,
        name: workspace.name,
        slug: workspace.slug,
        description: workspace.description,
        color: workspace.color,
        inviteCode: membership.canAdmin() ? workspace.inviteCode : undefined,
        inviteCodeEnabled: workspace.inviteCodeEnabled,
        settings: workspace.settings,
        role: membership.role,
        memberCount,
        paidSeats,
        maxMembers,
        ownerPlan,
        isOverLimit,
        createdAt: workspace.createdAt
      }
    });
  } catch (error) {
    logger.error('Switch workspace error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update workspace (admin only)
router.put('/current', authenticateToken, requireWorkspaceAdmin, async (req, res) => {
  try {
    const { name, description, color, inviteCodeEnabled } = req.body;

    const updates = {};
    if (name !== undefined) {
      if (!name || name.trim().length === 0) {
        return res.status(400).json({ message: 'Názov je povinný' });
      }
      updates.name = name.trim();
    }
    if (description !== undefined) updates.description = description.trim();
    if (color !== undefined) updates.color = color;
    if (inviteCodeEnabled !== undefined) updates.inviteCodeEnabled = inviteCodeEnabled;

    const workspace = await Workspace.findByIdAndUpdate(
      req.workspace._id,
      updates,
      { new: true }
    );

    logger.info('Workspace updated', { workspaceId: workspace._id, userId: req.user.id, updates: Object.keys(updates) });

    res.json({
      id: workspace._id,
      name: workspace.name,
      slug: workspace.slug,
      description: workspace.description,
      color: workspace.color,
      inviteCode: workspace.inviteCode,
      inviteCodeEnabled: workspace.inviteCodeEnabled
    });
  } catch (error) {
    logger.error('Update workspace error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update paid seats (admin only)
router.put('/current/seats', authenticateToken, requireWorkspaceAdmin, async (req, res) => {
  try {
    const { paidSeats } = req.body;

    if (paidSeats === undefined || typeof paidSeats !== 'number' || paidSeats < 0) {
      return res.status(400).json({ message: 'Počet miest musí byť číslo väčšie alebo rovné 0' });
    }

    await Workspace.findByIdAndUpdate(req.workspace._id, { paidSeats: Math.floor(paidSeats) });

    const owner = await User.findById(req.workspace.ownerId);
    const ownerPlan = owner?.subscription?.plan || 'free';
    const seatLimits = { free: 2, trial: 2, team: 10, pro: Infinity };
    const baseLimit = seatLimits[ownerPlan] || 2;
    const memberCount = await WorkspaceMember.countDocuments({ workspaceId: req.workspace._id });

    res.json({
      paidSeats: Math.floor(paidSeats),
      includedSeats: baseLimit === Infinity ? 'unlimited' : baseLimit,
      maxMembers: baseLimit === Infinity ? 'unlimited' : baseLimit + Math.floor(paidSeats),
      memberCount
    });
  } catch (error) {
    logger.error('Update seats error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Regenerate invite code (admin only)
router.post('/current/regenerate-invite', authenticateToken, requireWorkspaceAdmin, async (req, res) => {
  try {
    const newCode = Workspace.generateInviteCode();

    await Workspace.findByIdAndUpdate(req.workspace._id, { inviteCode: newCode });

    logger.info('Invite code regenerated', { workspaceId: req.workspace._id, userId: req.user.id });

    res.json({ inviteCode: newCode });
  } catch (error) {
    logger.error('Regenerate invite code error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get workspace members
router.get('/current/members', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const members = await WorkspaceMember.find({ workspaceId: req.workspace._id })
      .populate('userId', 'username email color avatar');

    const membersData = members.map(m => ({
      id: m._id,
      userId: m.userId._id,
      username: m.userId.username,
      email: m.userId.email,
      color: m.userId.color,
      avatar: m.userId.avatar,
      role: m.role,
      joinedAt: m.joinedAt,
      canEdit: req.workspaceMember.canAdmin() && m.role !== 'owner'
    }));

    res.json(membersData);
  } catch (error) {
    logger.error('Get members error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update member role (admin only)
router.put('/current/members/:memberId/role', authenticateToken, requireWorkspaceAdmin, async (req, res) => {
  try {
    const { memberId } = req.params;
    const { role } = req.body;

    if (!['manager', 'member'].includes(role)) {
      return res.status(400).json({ message: 'Neplatná rola' });
    }

    const member = await WorkspaceMember.findOne({
      _id: memberId,
      workspaceId: req.workspace._id
    });

    if (!member) {
      return res.status(404).json({ message: 'Člen nenájdený' });
    }

    // Cannot change owner role
    if (member.role === 'owner') {
      return res.status(403).json({ message: 'Nie je možné zmeniť rolu vlastníka' });
    }

    member.role = role;
    await member.save();

    logger.info('Member role updated', { workspaceId: req.workspace._id, memberId, newRole: role, userId: req.user.id });

    res.json({ message: 'Rola bola aktualizovaná', role });
  } catch (error) {
    logger.error('Update member role error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Remove member (admin only)
router.delete('/current/members/:memberId', authenticateToken, requireWorkspaceAdmin, async (req, res) => {
  try {
    const { memberId } = req.params;

    const member = await WorkspaceMember.findOne({
      _id: memberId,
      workspaceId: req.workspace._id
    });

    if (!member) {
      return res.status(404).json({ message: 'Člen nenájdený' });
    }

    // Cannot remove owner
    if (member.role === 'owner') {
      return res.status(403).json({ message: 'Nie je možné odstrániť vlastníka' });
    }

    // If removing self (leaving workspace)
    if (member.userId.toString() === req.user.id) {
      // Clear current workspace if this is it
      const user = await User.findById(req.user.id);
      if (user.currentWorkspaceId?.toString() === req.workspace._id.toString()) {
        // Find another workspace to switch to
        const otherMembership = await WorkspaceMember.findOne({
          userId: req.user.id,
          workspaceId: { $ne: req.workspace._id }
        });

        await User.findByIdAndUpdate(req.user.id, {
          currentWorkspaceId: otherMembership?.workspaceId || null
        });
      }
    }

    await WorkspaceMember.deleteOne({ _id: memberId });

    // Clear removed user's current workspace if needed
    const removedUser = await User.findById(member.userId);
    if (removedUser?.currentWorkspaceId?.toString() === req.workspace._id.toString()) {
      const otherMembership = await WorkspaceMember.findOne({
        userId: member.userId,
        workspaceId: { $ne: req.workspace._id }
      });

      await User.findByIdAndUpdate(member.userId, {
        currentWorkspaceId: otherMembership?.workspaceId || null
      });
    }

    logger.info('Member removed', { workspaceId: req.workspace._id, memberId, removedUserId: member.userId, userId: req.user.id });

    res.json({ message: 'Člen bol odstránený' });
  } catch (error) {
    logger.error('Remove member error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Leave workspace
router.post('/current/leave', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Cannot leave if owner
    if (req.workspaceMember.role === 'owner') {
      return res.status(403).json({
        message: 'Vlastník nemôže opustiť pracovné prostredie. Najprv preveďte vlastníctvo na iného člena.'
      });
    }

    // Get leaving user info before deleting membership
    const leavingUser = await User.findById(req.user.id, 'username');
    const workspaceName = req.workspace.name;

    await WorkspaceMember.deleteOne({ _id: req.workspaceMember._id });

    // Find another workspace to switch to
    const otherMembership = await WorkspaceMember.findOne({
      userId: req.user.id,
      workspaceId: { $ne: req.workspace._id }
    });

    await User.findByIdAndUpdate(req.user.id, {
      currentWorkspaceId: otherMembership?.workspaceId || null
    });

    // Notify owners and managers that a member left
    const admins = await WorkspaceMember.find({
      workspaceId: req.workspace._id,
      role: { $in: ['owner', 'manager'] }
    });

    for (const admin of admins) {
      await notificationService.createNotification({
        userId: admin.userId.toString(),
        workspaceId: req.workspace._id,
        type: 'workspace',
        title: `${leavingUser.username} opustil/a prostredie`,
        message: `Používateľ ${leavingUser.username} opustil/a pracovné prostredie "${workspaceName}".`,
        actorId: req.user.id,
        actorName: leavingUser.username,
        relatedType: 'workspace',
        relatedId: req.workspace._id.toString(),
        relatedName: workspaceName
      });
    }

    logger.info('User left workspace', { workspaceId: req.workspace._id, userId: req.user.id, notified: admins.length });

    res.json({
      message: 'Opustili ste pracovné prostredie',
      newWorkspaceId: otherMembership?.workspaceId || null
    });
  } catch (error) {
    logger.error('Leave workspace error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Transfer ownership (owner only)
router.post('/current/transfer-ownership/:newOwnerId', authenticateToken, requireWorkspaceOwner, async (req, res) => {
  try {
    const { newOwnerId } = req.params;

    // Find new owner's membership
    const newOwnerMembership = await WorkspaceMember.findOne({
      workspaceId: req.workspace._id,
      userId: newOwnerId
    });

    if (!newOwnerMembership) {
      return res.status(404).json({ message: 'Používateľ nie je členom tohto pracovného prostredia' });
    }

    // Only managers can become owners
    if (newOwnerMembership.role !== 'manager') {
      return res.status(400).json({ message: 'Vlastníctvo je možné previesť len na manažéra' });
    }

    // Update roles - old owner becomes member
    req.workspaceMember.role = 'member';
    await req.workspaceMember.save();

    newOwnerMembership.role = 'owner';
    await newOwnerMembership.save();

    // Update workspace owner
    await Workspace.findByIdAndUpdate(req.workspace._id, { ownerId: newOwnerId });

    logger.info('Ownership transferred', { workspaceId: req.workspace._id, oldOwnerId: req.user.id, newOwnerId });

    res.json({ message: 'Vlastníctvo bolo prevedené' });
  } catch (error) {
    logger.error('Transfer ownership error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete workspace (owner only)
router.delete('/current', authenticateToken, requireWorkspaceOwner, async (req, res) => {
  try {
    const workspaceId = req.workspace._id;

    // Delete all memberships
    await WorkspaceMember.deleteMany({ workspaceId });

    // Clear currentWorkspaceId for all affected users
    await User.updateMany(
      { currentWorkspaceId: workspaceId },
      { currentWorkspaceId: null }
    );

    // Delete workspace data (contacts, tasks, messages, invitations)
    const Contact = require('../models/Contact');
    const Task = require('../models/Task');
    const Message = require('../models/Message');
    await Contact.deleteMany({ workspaceId });
    await Task.deleteMany({ workspaceId });
    await Message.deleteMany({ workspaceId });
    await Invitation.deleteMany({ workspaceId });

    // Delete workspace
    await Workspace.deleteOne({ _id: workspaceId });

    logger.info('Workspace deleted', { workspaceId, userId: req.user.id });

    res.json({ message: 'Pracovné prostredie bolo vymazané' });
  } catch (error) {
    logger.error('Delete workspace error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ==================== INVITATIONS ====================

// Send invitation to email
router.post('/current/invitations', authenticateToken, requireWorkspace, requireWorkspaceAdmin, async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ message: 'Email je povinný' });

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user is already a member
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      const existingMember = await WorkspaceMember.findOne({
        workspaceId: req.workspaceId,
        userId: existingUser._id
      });
      if (existingMember) {
        return res.status(400).json({ message: 'Tento používateľ je už členom tohto prostredia' });
      }
    }

    // Check if pending invitation already exists
    const existingInvite = await Invitation.findOne({
      workspaceId: req.workspaceId,
      email: normalizedEmail,
      status: 'pending'
    });
    if (existingInvite) {
      return res.status(400).json({ message: 'Pozvánka na tento email už bola odoslaná' });
    }

    // Check workspace capacity
    const workspace = await Workspace.findById(req.workspaceId);
    const owner = await User.findById(workspace.ownerId);
    const memberCount = await WorkspaceMember.countDocuments({ workspaceId: req.workspaceId });

    // Team Pro emails bypass capacity check entirely
    const proEmails = (process.env.PRO_EMAILS || 'project.manager@eperun.sk,martin.kosco@eperun.sk').split(',').map(e => e.trim()).filter(Boolean);
    const inviterUser = await User.findById(req.user.id);
    const isTeamPro = proEmails.includes(inviterUser?.email?.toLowerCase());

    if (!isTeamPro) {
      const ownerPlan = owner?.subscription?.plan || 'free';
      const seatLimits = { free: 2, trial: 2, team: 10, pro: Infinity };
      const baseSeatLimit = seatLimits[ownerPlan] || 2;
      if (baseSeatLimit !== Infinity) {
        const maxSeats = baseSeatLimit + (workspace.paidSeats || 0);
        if (memberCount >= maxSeats) {
          return res.status(400).json({ message: `Váš plán umožňuje max. ${baseSeatLimit} členov. Pre viac členov prejdite na vyšší plán.` });
        }
      }
    }

    // Create invitation
    const invitation = new Invitation({
      workspaceId: req.workspaceId,
      email: normalizedEmail,
      invitedBy: req.user.id,
      role: role === 'manager' ? 'manager' : 'member'
    });
    await invitation.save();

    // inviterUser already fetched above for capacity check
    const inviteLink = `${process.env.CLIENT_URL || 'https://prplcrm.eu'}/invite/${invitation.token}`;

    // Send invitation email (fire and forget — don't block response)
    let emailSent = false;
    try {
      emailSent = await sendInvitationEmail({
        toEmail: normalizedEmail,
        inviterName: inviterUser?.username || 'Člen tímu',
        workspaceName: workspace.name,
        role: invitation.role,
        inviteLink,
        expiresAt: invitation.expiresAt
      });
    } catch (emailErr) {
      logger.warn('Invitation email failed', { error: emailErr.message, email: normalizedEmail });
    }

    logger.info('Invitation sent', {
      workspaceId: req.workspaceId,
      email: normalizedEmail,
      invitedBy: req.user.id,
      emailSent
    });

    res.json({
      message: emailSent
        ? `Pozvánka bola odoslaná na ${normalizedEmail}`
        : 'Pozvánka bola vytvorená (email sa nepodarilo odoslať)',
      emailSent,
      invitation: {
        id: invitation._id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        token: invitation.token,
        inviteLink,
        expiresAt: invitation.expiresAt,
        invitedBy: inviterUser?.username || 'Neznámy'
      }
    });
  } catch (error) {
    logger.error('Send invitation error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get all pending invitations for current workspace
router.get('/current/invitations', authenticateToken, requireWorkspace, requireWorkspaceAdmin, async (req, res) => {
  try {
    const invitations = await Invitation.find({
      workspaceId: req.workspaceId,
      status: 'pending'
    }).populate('invitedBy', 'username');

    res.json(invitations.map(inv => ({
      id: inv._id,
      email: inv.email,
      role: inv.role,
      status: inv.status,
      invitedBy: inv.invitedBy?.username || 'Neznámy',
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt
    })));
  } catch (error) {
    logger.error('Get invitations error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Cancel invitation
router.delete('/current/invitations/:invitationId', authenticateToken, requireWorkspace, requireWorkspaceAdmin, async (req, res) => {
  try {
    const invitation = await Invitation.findOneAndUpdate(
      { _id: req.params.invitationId, workspaceId: req.workspaceId, status: 'pending' },
      { status: 'cancelled' }
    );
    if (!invitation) {
      return res.status(404).json({ message: 'Pozvánka nenájdená' });
    }
    res.json({ message: 'Pozvánka bola zrušená' });
  } catch (error) {
    logger.error('Cancel invitation error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get invitation details by token (public - no auth needed for viewing)
router.get('/invitation/:token', async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      token: req.params.token
    }).populate('workspaceId', 'name color');

    if (!invitation) {
      return res.status(404).json({ message: 'Pozvánka nenájdená' });
    }

    if (invitation.status === 'accepted') {
      return res.status(410).json({
        message: 'Táto pozvánka už bola prijatá',
        workspaceId: invitation.workspaceId?._id,
        alreadyAccepted: true
      });
    }

    if (invitation.status !== 'pending') {
      return res.status(410).json({ message: 'Pozvánka už nie je platná' });
    }

    if (invitation.expiresAt < new Date()) {
      invitation.status = 'expired';
      await invitation.save();
      return res.status(410).json({ message: 'Pozvánka vypršala' });
    }

    const inviter = await User.findById(invitation.invitedBy, 'username');

    res.json({
      email: invitation.email,
      role: invitation.role,
      workspaceName: invitation.workspaceId?.name || 'Neznáme prostredie',
      workspaceColor: invitation.workspaceId?.color || '#6366f1',
      invitedBy: inviter?.username || 'Neznámy',
      expiresAt: invitation.expiresAt
    });
  } catch (error) {
    logger.error('Get invitation by token error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Accept invitation (authenticated user)
router.post('/invitation/:token/accept', authenticateToken, async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      token: req.params.token,
      status: 'pending'
    });

    if (!invitation) {
      return res.status(404).json({ message: 'Pozvánka nenájdená alebo vypršala' });
    }

    if (invitation.expiresAt < new Date()) {
      invitation.status = 'expired';
      await invitation.save();
      return res.status(410).json({ message: 'Pozvánka vypršala' });
    }

    // Check if already a member
    const existingMember = await WorkspaceMember.findOne({
      workspaceId: invitation.workspaceId,
      userId: req.user.id
    });
    if (existingMember) {
      invitation.status = 'accepted';
      await invitation.save();
      return res.json({ message: 'Už ste členom tohto prostredia', workspaceId: invitation.workspaceId });
    }

    // Check workspace capacity
    const workspace = await Workspace.findById(invitation.workspaceId);
    if (!workspace) {
      return res.status(404).json({ message: 'Pracovné prostredie už neexistuje' });
    }

    const owner = await User.findById(workspace.ownerId);
    const memberCount = await WorkspaceMember.countDocuments({ workspaceId: invitation.workspaceId });

    // Team Pro emails bypass capacity check
    const proEmails = (process.env.PRO_EMAILS || 'project.manager@eperun.sk,martin.kosco@eperun.sk').split(',').map(e => e.trim()).filter(Boolean);
    const isTeamPro = proEmails.includes(owner?.email?.toLowerCase());

    if (!isTeamPro) {
      const ownerPlan = owner?.subscription?.plan || 'free';
      const seatLimits = { free: 2, trial: 2, team: 10, pro: Infinity };
      const baseSeatLimit = seatLimits[ownerPlan] || 2;
      if (baseSeatLimit !== Infinity) {
        const maxSeats = baseSeatLimit + (workspace.paidSeats || 0);
        if (memberCount >= maxSeats) {
          return res.status(400).json({ message: `Prostredie je plné. Vlastník musí prejsť na vyšší plán alebo dokúpiť miesta.` });
        }
      }
    }

    // Create membership
    await WorkspaceMember.create({
      workspaceId: invitation.workspaceId,
      userId: req.user.id,
      role: invitation.role,
      invitedBy: invitation.invitedBy
    });

    // Switch user to the new workspace
    await User.findByIdAndUpdate(req.user.id, { currentWorkspaceId: invitation.workspaceId });

    // Mark invitation as accepted
    invitation.status = 'accepted';
    await invitation.save();

    logger.info('Invitation accepted', {
      workspaceId: invitation.workspaceId,
      userId: req.user.id,
      email: invitation.email
    });

    res.json({
      message: `Boli ste pridaný do prostredia "${workspace.name}"`,
      workspaceId: invitation.workspaceId
    });
  } catch (error) {
    logger.error('Accept invitation error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
