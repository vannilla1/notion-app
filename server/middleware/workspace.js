const WorkspaceMember = require('../models/WorkspaceMember');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * Middleware to check if user has access to current workspace
 * Sets req.workspace and req.workspaceMember
 */
const requireWorkspace = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Get user's current workspace
    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ message: 'Používateľ nenájdený' });
    }

    // Check if user has a current workspace set
    if (!user.currentWorkspaceId) {
      return res.status(400).json({
        message: 'Nie ste členom žiadneho pracovného prostredia',
        code: 'NO_WORKSPACE'
      });
    }

    // Check membership
    const membership = await WorkspaceMember.findOne({
      workspaceId: user.currentWorkspaceId,
      userId: userId
    });

    if (!membership) {
      // User's currentWorkspaceId is invalid, clear it
      await User.findByIdAndUpdate(userId, { currentWorkspaceId: null });
      return res.status(400).json({
        message: 'Nie ste členom tohto pracovného prostredia',
        code: 'NO_WORKSPACE'
      });
    }

    // Get workspace details
    const workspace = await Workspace.findById(user.currentWorkspaceId);
    if (!workspace) {
      await User.findByIdAndUpdate(userId, { currentWorkspaceId: null });
      return res.status(400).json({
        message: 'Pracovné prostredie neexistuje',
        code: 'NO_WORKSPACE'
      });
    }

    // Attach to request
    req.workspace = workspace;
    req.workspaceMember = membership;
    req.workspaceId = workspace._id;

    next();
  } catch (error) {
    logger.error('Workspace middleware error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
};

/**
 * Middleware to check if user is admin/owner of workspace
 */
const requireWorkspaceAdmin = async (req, res, next) => {
  try {
    // First run requireWorkspace
    await new Promise((resolve, reject) => {
      requireWorkspace(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Check if already responded (error case)
    if (res.headersSent) return;

    // Check admin rights
    if (!req.workspaceMember.canAdmin()) {
      return res.status(403).json({
        message: 'Nemáte oprávnenie na túto akciu. Vyžaduje sa rola admin alebo owner.'
      });
    }

    next();
  } catch (error) {
    logger.error('Workspace admin middleware error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
};

/**
 * Middleware to check if user is owner of workspace
 */
const requireWorkspaceOwner = async (req, res, next) => {
  try {
    // First run requireWorkspace
    await new Promise((resolve, reject) => {
      requireWorkspace(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Check if already responded (error case)
    if (res.headersSent) return;

    // Check owner rights
    if (!req.workspaceMember.isOwner()) {
      return res.status(403).json({
        message: 'Nemáte oprávnenie na túto akciu. Vyžaduje sa rola owner.'
      });
    }

    next();
  } catch (error) {
    logger.error('Workspace owner middleware error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
};

module.exports = {
  requireWorkspace,
  requireWorkspaceAdmin,
  requireWorkspaceOwner
};
