const mongoose = require('mongoose');
const WorkspaceMember = require('../models/WorkspaceMember');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const logger = require('../utils/logger');

// In-memory cache for workspace validation (reduces 3 DB queries to 0 per request)
// Kľúč: `${userId}:${workspaceId}` — per-device model, každý device môže mať iný
// "current" workspace, takže cache MUSÍ byť key-ed aj podľa workspace, nie iba
// user. Predtým bol key čisto userId, čo spôsobovalo cross-workspace cache hit
// keď user zmenil workspace na inom zariadení.
const workspaceCache = new Map();
const CACHE_TTL = 60000; // 60 seconds

const cacheKey = (userId, workspaceId) => `${userId}:${workspaceId}`;

const getCached = (userId, workspaceId) => {
  const entry = workspaceCache.get(cacheKey(userId, workspaceId));
  if (entry && Date.now() - entry.cachedAt < CACHE_TTL) return entry;
  workspaceCache.delete(cacheKey(userId, workspaceId));
  return null;
};

const setCache = (userId, workspaceId, data) => {
  workspaceCache.set(cacheKey(userId, workspaceId), { ...data, cachedAt: Date.now() });
  // Limit cache size
  if (workspaceCache.size > 400) {
    const firstKey = workspaceCache.keys().next().value;
    workspaceCache.delete(firstKey);
  }
};

// Invaliduje VŠETKY cached workspace entries pre daného usera (treba napr.
// po membership zmene, role zmene, alebo leave/delete workspace). Iterujeme
// keys a mažeme prefix-match — cena je O(n) kde n je cache size (max 400),
// čo je zanedbateľné vs. 3 DB queries per request.
const invalidateCache = (userId) => {
  const prefix = `${userId}:`;
  for (const key of workspaceCache.keys()) {
    if (key.startsWith(prefix)) workspaceCache.delete(key);
  }
};

/**
 * Middleware to check if user has access to current workspace
 * Sets req.workspace and req.workspaceMember
 * Uses in-memory cache to avoid 3 DB queries per request
 */
const requireWorkspace = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // 1) CLIENT-AUTHORITATIVE workspace intent.
    // Klient posiela `X-Workspace-Id` header z lokálneho state-u. Toto je
    // ground truth pre request — každé zariadenie si môže mať otvorený iný
    // workspace a nezasahujú si. `User.currentWorkspaceId` v DB ostáva len
    // ako "default pre ďalšie login-y / zariadenia bez localStorage state-u".
    //
    // Header ignorujeme keď nie je validný ObjectId shape — falošný alebo
    // corrupted header → fallback na user.currentWorkspaceId namiesto 400,
    // aby stará verzia klienta (pred týmto commitom) stále fungovala.
    const rawHeader = req.headers['x-workspace-id'];
    let requestedWsId = null;
    if (rawHeader && typeof rawHeader === 'string' && mongoose.Types.ObjectId.isValid(rawHeader)) {
      requestedWsId = new mongoose.Types.ObjectId(rawHeader);
    }

    // 2) Resolve target workspace
    let workspaceObjId = requestedWsId;
    let user = null;

    if (!workspaceObjId) {
      // Backward-compat path: žiadny header → čítame z DB.
      user = await User.findById(userId);
      if (!user) {
        return res.status(401).json({ message: 'Používateľ nenájdený' });
      }

      if (!user.currentWorkspaceId) {
        // Auto-assign prvé dostupné workspace
        const firstMembership = await WorkspaceMember.findOne({ userId });
        if (firstMembership) {
          await User.findByIdAndUpdate(userId, { currentWorkspaceId: firstMembership.workspaceId });
          workspaceObjId = firstMembership.workspaceId;
          logger.info('Auto-assigned workspace', { userId, workspaceId: workspaceObjId });
        } else {
          return res.status(400).json({
            message: 'Nie ste členom žiadneho pracovného prostredia',
            code: 'NO_WORKSPACE'
          });
        }
      } else {
        workspaceObjId = user.currentWorkspaceId;
        // Legacy dáta môžu byť string — prevedieme na ObjectId.
        if (typeof workspaceObjId === 'string') {
          if (!mongoose.Types.ObjectId.isValid(workspaceObjId)) {
            await User.findByIdAndUpdate(userId, { currentWorkspaceId: null });
            return res.status(400).json({
              message: 'Neplatné ID pracovného prostredia',
              code: 'NO_WORKSPACE'
            });
          }
          workspaceObjId = new mongoose.Types.ObjectId(workspaceObjId);
          await User.findByIdAndUpdate(userId, { currentWorkspaceId: workspaceObjId });
        }
      }
    }

    // 3) Cache check per (user, workspace) — ak klient posiela iný ws ako
    // predtým, toto je cache miss a validujeme membership.
    const cached = getCached(userId, workspaceObjId);
    if (cached) {
      req.workspace = cached.workspace;
      req.workspaceMember = cached.membership;
      req.workspaceId = cached.workspace._id;
      return next();
    }

    // 4) Membership validácia — POVINNÁ pri každom novom (user, ws) pári.
    // SECURITY: aj keď klient pošle header, musíme overiť že tam patrí,
    // inak by ktokoľvek mohol nastaviť cudzí workspace-id a čítať dáta.
    const membership = await WorkspaceMember.findOne({
      workspaceId: workspaceObjId,
      userId
    });

    if (!membership) {
      // Header bol explicitne poskytnutý a nie som člen → 403 (klient musí
      // vedieť že má nastaviť iný workspace). Nesilent-fallback — to by
      // spôsobilo "correct section, wrong workspace" bug.
      if (requestedWsId) {
        return res.status(403).json({
          message: 'Nie ste členom tohto pracovného prostredia',
          code: 'NOT_MEMBER'
        });
      }
      // Fallback path: user.currentWorkspaceId je stale → skús recovery.
      const anyMembership = await WorkspaceMember.findOne({ userId });
      if (anyMembership) {
        await User.findByIdAndUpdate(userId, { currentWorkspaceId: anyMembership.workspaceId });
        const retryWorkspace = await Workspace.findById(anyMembership.workspaceId);
        if (retryWorkspace) {
          req.workspace = retryWorkspace;
          req.workspaceMember = anyMembership;
          req.workspaceId = retryWorkspace._id;
          setCache(userId, retryWorkspace._id, { workspace: retryWorkspace, membership: anyMembership });
          logger.info('Auto-recovered to valid workspace', { userId, workspaceId: retryWorkspace._id });
          return next();
        }
      }
      await User.findByIdAndUpdate(userId, { currentWorkspaceId: null });
      return res.status(400).json({
        message: 'Nie ste členom žiadneho pracovného prostredia',
        code: 'NO_WORKSPACE'
      });
    }

    // 5) Workspace details
    const workspace = await Workspace.findById(workspaceObjId);
    if (!workspace) {
      if (!requestedWsId) {
        await User.findByIdAndUpdate(userId, { currentWorkspaceId: null });
      }
      return res.status(400).json({
        message: 'Pracovné prostredie neexistuje',
        code: 'NO_WORKSPACE'
      });
    }

    req.workspace = workspace;
    req.workspaceMember = membership;
    req.workspaceId = workspace._id;
    setCache(userId, workspaceObjId, { workspace, membership });

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
