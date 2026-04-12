const mongoose = require('mongoose');
const WorkspaceMember = require('../models/WorkspaceMember');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const logger = require('../utils/logger');

// In-memory cache for workspace validation (reduces 3 DB queries to 0 per request)
// Key: `${userId}:${workspaceId}`, Value: { workspace, membership, cachedAt }
const workspaceCache = new Map();
const CACHE_TTL = 60000; // 60 seconds

const getCached = (userId) => {
  const entry = workspaceCache.get(userId);
  if (entry && Date.now() - entry.cachedAt < CACHE_TTL) return entry;
  workspaceCache.delete(userId);
  return null;
};

const setCache = (userId, data) => {
  workspaceCache.set(userId, { ...data, cachedAt: Date.now() });
  // Limit cache size
  if (workspaceCache.size > 200) {
    const firstKey = workspaceCache.keys().next().value;
    workspaceCache.delete(firstKey);
  }
};

const invalidateCache = (userId) => workspaceCache.delete(userId);

/**
 * Middleware to check if user has access to current workspace
 * Sets req.workspace and req.workspaceMember
 * Uses in-memory cache to avoid 3 DB queries per request
 */
const requireWorkspace = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Check cache first (avoids 3 DB queries)
    const cached = getCached(userId);
    if (cached) {
      req.workspace = cached.workspace;
      req.workspaceMember = cached.membership;
      req.workspaceId = cached.workspace._id;
      return next();
    }

    // Get user's current workspace
    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ message: 'Používateľ nenájdený' });
    }

    // Check if user has a current workspace set
    if (!user.currentWorkspaceId) {
      // Try to auto-assign first available workspace
      const firstMembership = await WorkspaceMember.findOne({ userId });
      if (firstMembership) {
        await User.findByIdAndUpdate(userId, { currentWorkspaceId: firstMembership.workspaceId });
        user.currentWorkspaceId = firstMembership.workspaceId;
        logger.info('Auto-assigned workspace', { userId, workspaceId: firstMembership.workspaceId });
      } else {
        return res.status(400).json({
          message: 'Nie ste členom žiadneho pracovného prostredia',
          code: 'NO_WORKSPACE'
        });
      }
    }

    // Ensure currentWorkspaceId is a proper ObjectId
    let workspaceObjId = user.currentWorkspaceId;
    if (typeof workspaceObjId === 'string') {
      if (!mongoose.Types.ObjectId.isValid(workspaceObjId)) {
        await User.findByIdAndUpdate(userId, { currentWorkspaceId: null });
        return res.status(400).json({
          message: 'Neplatné ID pracovného prostredia',
          code: 'NO_WORKSPACE'
        });
      }
      workspaceObjId = new mongoose.Types.ObjectId(workspaceObjId);
      // Fix the stored value
      await User.findByIdAndUpdate(userId, { currentWorkspaceId: workspaceObjId });
      logger.info('Fixed string workspaceId to ObjectId', { userId, workspaceId: workspaceObjId });
    }

    // Check membership
    const membership = await WorkspaceMember.findOne({
      workspaceId: workspaceObjId,
      userId: userId
    });

    if (!membership) {
      // User's currentWorkspaceId is invalid, try to find any valid workspace
      const anyMembership = await WorkspaceMember.findOne({ userId });
      if (anyMembership) {
        await User.findByIdAndUpdate(userId, { currentWorkspaceId: anyMembership.workspaceId });
        // Retry with the valid workspace
        const retryWorkspace = await Workspace.findById(anyMembership.workspaceId);
        if (retryWorkspace) {
          req.workspace = retryWorkspace;
          req.workspaceMember = anyMembership;
          req.workspaceId = retryWorkspace._id;
          setCache(userId, { workspace: retryWorkspace, membership: anyMembership });
          logger.info('Auto-recovered to valid workspace', { userId, workspaceId: retryWorkspace._id });
          return next();
        }
      }
      await User.findByIdAndUpdate(userId, { currentWorkspaceId: null });
      return res.status(400).json({
        message: 'Nie ste členom tohto pracovného prostredia',
        code: 'NO_WORKSPACE'
      });
    }

    // Get workspace details
    const workspace = await Workspace.findById(workspaceObjId);
    if (!workspace) {
      await User.findByIdAndUpdate(userId, { currentWorkspaceId: null });
      return res.status(400).json({
        message: 'Pracovné prostredie neexistuje',
        code: 'NO_WORKSPACE'
      });
    }

    // Attach to request + cache
    req.workspace = workspace;
    req.workspaceMember = membership;
    req.workspaceId = workspace._id;
    setCache(userId, { workspace, membership });

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
        message: 'Nemáte oprávnenie na túto akciu. Vyžaduje sa rola vlastník alebo manažér.'
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

/**
 * Middleware to enforce workspace plan limits.
 * Blocks content creation (POST) when workspace exceeds member limit for owner's plan.
 * Allows read (GET), update (PUT/PATCH), and delete (DELETE) operations.
 * Must be used AFTER requireWorkspace.
 */
const enforceWorkspaceLimits = async (req, res, next) => {
  try {
    // Only block content creation
    if (req.method !== 'POST') return next();

    const owner = await User.findById(req.workspace.ownerId);
    const ownerPlan = owner?.subscription?.plan || 'free';

    // Pro has no member limits
    if (ownerPlan === 'pro') return next();

    const memberLimits = { free: 2, trial: 2, team: 10 };
    const baseLimit = memberLimits[ownerPlan] || 2;
    const maxMembers = baseLimit + (req.workspace.paidSeats || 0);
    const memberCount = await WorkspaceMember.countDocuments({ workspaceId: req.workspace._id });

    if (memberCount > maxMembers) {
      return res.status(403).json({
        message: `Pracovné prostredie prekračuje limit členov pre plán "${ownerPlan}" (${memberCount}/${maxMembers}). Vytváranie nového obsahu je zablokované. Vlastník musí upgradovať plán alebo odstrániť členov.`,
        code: 'WORKSPACE_OVER_LIMIT'
      });
    }

    next();
  } catch (error) {
    logger.error('Enforce workspace limits error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
};

module.exports = {
  requireWorkspace,
  requireWorkspaceAdmin,
  requireWorkspaceOwner,
  enforceWorkspaceLimits,
  invalidateCache
};
