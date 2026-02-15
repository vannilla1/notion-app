const express = require('express');
const router = express.Router();
const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace, requireWorkspaceAdmin, requireWorkspaceOwner } = require('../middleware/workspace');
const logger = require('../utils/logger');

// Get all workspaces user is member of
router.get('/', authenticateToken, async (req, res) => {
  try {
    const memberships = await WorkspaceMember.find({ userId: req.user.id })
      .populate('workspaceId');

    const workspaces = memberships.map(m => ({
      id: m.workspaceId._id,
      name: m.workspaceId.name,
      slug: m.workspaceId.slug,
      description: m.workspaceId.description,
      color: m.workspaceId.color,
      role: m.role,
      joinedAt: m.joinedAt,
      isOwner: m.role === 'owner'
    }));

    // Get current workspace
    const user = await User.findById(req.user.id);

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

    // Verify membership
    const membership = await WorkspaceMember.findOne({
      workspaceId,
      userId: req.user.id
    });

    if (!membership) {
      return res.status(403).json({ message: 'Nie ste členom tohto pracovného prostredia' });
    }

    // Update current workspace
    await User.findByIdAndUpdate(req.user.id, { currentWorkspaceId: workspaceId });

    const workspace = await Workspace.findById(workspaceId);

    logger.info('Workspace switched', { workspaceId, userId: req.user.id });

    res.json({
      message: 'Pracovné prostredie bolo prepnuté',
      workspace: {
        id: workspace._id,
        name: workspace.name,
        slug: workspace.slug,
        color: workspace.color,
        role: membership.role
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

    if (!['admin', 'member'].includes(role)) {
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

    await WorkspaceMember.deleteOne({ _id: req.workspaceMember._id });

    // Find another workspace to switch to
    const otherMembership = await WorkspaceMember.findOne({
      userId: req.user.id,
      workspaceId: { $ne: req.workspace._id }
    });

    await User.findByIdAndUpdate(req.user.id, {
      currentWorkspaceId: otherMembership?.workspaceId || null
    });

    logger.info('User left workspace', { workspaceId: req.workspace._id, userId: req.user.id });

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

    // Update roles
    req.workspaceMember.role = 'admin';
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

    // Delete workspace
    await Workspace.deleteOne({ _id: workspaceId });

    // Note: Contacts and Tasks are NOT deleted - they become orphaned
    // In production, you might want to delete them too or archive them

    logger.info('Workspace deleted', { workspaceId, userId: req.user.id });

    res.json({ message: 'Pracovné prostredie bolo vymazané' });
  } catch (error) {
    logger.error('Delete workspace error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
