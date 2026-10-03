const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const Invitation = require('../models/Invitation');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
const { isIosNativeApp } = require('../utils/platform');
const { logPlanGateHit } = require('../utils/planGate');
const { requireWorkspace, requireWorkspaceAdmin, requireWorkspaceOwner, invalidateCache } = require('../middleware/workspace');
const logger = require('../utils/logger');
const { sendInvitationEmail } = require('../services/adminEmailService');
const notificationService = require('../services/notificationService');

// Farba prostredia sa na klientovi vkladá priamo do style={{ backgroundColor }}
// (WorkspaceSwitcher.jsx) — akceptujeme len hex formát (#rgb až #rrggbbaa).
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const isValidHexColor = (value) => typeof value === 'string' && HEX_COLOR_RE.test(value);

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
      // Per-user poradie: order asc, tiebreak joinedAt asc (stabilné pre order=0)
      .sort((a, b) => (a.order || 0) - (b.order || 0) || new Date(a.joinedAt) - new Date(b.joinedAt))
      .map(m => ({
        id: m.workspaceId._id,
        name: m.workspaceId.name,
        slug: m.workspaceId.slug,
        description: m.workspaceId.description,
        color: m.workspaceId.color,
        role: m.role,
        joinedAt: m.joinedAt,
        order: m.order || 0,
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

// Uloženie PER-USER poradia prostredí (šípky vo switcheri).
// Body: { orderedIds: [wsId1, wsId2, ...] } — index v poli = nové `order`.
// Aktualizuje LEN memberships žiadateľa; cudzie id ticho ignoruje (bezpečnosť).
router.put('/reorder', authenticateToken, async (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0 || orderedIds.length > 500) {
      return res.status(400).json({ message: 'Neplatné poradie' });
    }
    const memberships = await WorkspaceMember.find({ userId: req.user.id }, 'workspaceId');
    const myWsIds = new Set(memberships.map(m => m.workspaceId.toString()));
    // Len vlastné + DEDUP (prvý výskyt) — bez dedupu by duplicitné id nafúkli
    // bulkWrite na tisíce no-op zápisov do toho istého dokladu (DoS amplifikácia).
    const seen = new Set();
    const filtered = orderedIds
      .map(String)
      .filter(id => myWsIds.has(id) && !seen.has(id) && seen.add(id));

    const ops = filtered.map((wsId, index) => ({
      updateOne: {
        filter: { userId: req.user.id, workspaceId: wsId },
        update: { $set: { order: index } }
      }
    }));
    if (ops.length) await WorkspaceMember.bulkWrite(ops, { ordered: false });

    res.json({ message: 'Poradie uložené' });
  } catch (error) {
    logger.error('Reorder workspaces error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get current workspace details
router.get('/current', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Z vlastníka čítame len subscription.plan — bez .select() by sa pri každom
    // štarte klienta načítal celý User vrátane avatarData (Base64, až ~6,7 MB).
    const [memberCount, owner] = await Promise.all([
      WorkspaceMember.countDocuments({ workspaceId: req.workspace._id }),
      User.findById(req.workspace.ownerId).select('subscription').lean()
    ]);
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

    // typeof kontroly — pole/číslo/objekt v JSON by inak spadli na .trim()
    // s TypeError → 500 namiesto 400.
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ message: 'Názov je povinný' });
    }

    if (name.length > 100) {
      return res.status(400).json({ message: 'Názov môže mať maximálne 100 znakov' });
    }

    // Plan-based workspace ownership limit. Predtým bolo enforcement úplne
    // vypnuté (bug — UI cenník inzeroval 1/2/∞ ale backend povolil ∞ pre
    // všetkých). Teraz blokujeme vytvorenie pri prekročení.
    const ownerUser = await User.findById(req.user.id).select('subscription').lean();
    const ownerPlan = ownerUser?.subscription?.plan || 'free';
    const workspaceCountLimits = { free: 1, trial: 1, team: 2, pro: Infinity };
    const maxOwnedWorkspaces = workspaceCountLimits[ownerPlan] ?? 1;
    if (maxOwnedWorkspaces !== Infinity) {
      const ownedCount = await Workspace.countDocuments({ ownerId: req.user.id });
      if (ownedCount >= maxOwnedWorkspaces) {
        // iOS-aware neutrálna správa pre Apple 3.1.1 compliance
        const message = isIosNativeApp(req)
          ? `Dosiahli ste limit ${maxOwnedWorkspaces} pracovných prostredí.`
          : `Váš plán umožňuje vlastniť max. ${maxOwnedWorkspaces} pracovných prostredí. Pre viac prejdite na vyšší plán.`;
        logPlanGateHit(req, { code: 'PLAN_LIMIT', feature: 'workspaces', limit: maxOwnedWorkspaces });
        return res.status(403).json({ message, code: 'PLAN_LIMIT' });
      }
    }

    // Generate slug and invite code. generateSlug odstráni všetko mimo
    // [a-z0-9] — pre názvy len z cyriliky/emoji/symbolov („Проект", „🚀")
    // vráti '' a schéma (slug required) by padla na ValidationError → 500.
    let slug = await Workspace.generateSlug(name);
    if (!slug) slug = 'ws-' + crypto.randomBytes(4).toString('hex');
    const inviteCode = Workspace.generateInviteCode();

    // Create workspace
    const workspace = new Workspace({
      name: name.trim(),
      slug,
      description: typeof description === 'string' ? description.trim().slice(0, 500) : '',
      color: isValidHexColor(color) ? color : '#6366f1',
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
    // Súbežné POST / s rovnakým názvom: while-loop v generateSlug nie je
    // atomický a unique index na slug hodí E11000 — nie je to chyba servera.
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Názov prostredia je práve obsadený, skúste to znova' });
    }
    logger.error('Create workspace error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Join workspace by invite code
router.post('/join', authenticateToken, async (req, res) => {
  try {
    const { inviteCode } = req.body;

    if (typeof inviteCode !== 'string' || inviteCode.trim().length === 0) {
      return res.status(400).json({ message: 'Kód pozvánky je povinný' });
    }
    // Kód je vždy 8 alfanumerických znakov (Workspace.generateInviteCode) —
    // iný formát v DB existovať nemôže, odpovedáme ako pri neplatnom kóde
    // bez dotazu. Trim toleruje whitespace pri kopírovaní kódu.
    const code = inviteCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,32}$/.test(code)) {
      return res.status(404).json({ message: 'Neplatný alebo neaktívny kód pozvánky' });
    }

    // Find workspace by invite code
    const workspace = await Workspace.findOne({
      inviteCode: code,
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
    // (len email + subscription — nie celý User s avatarData blobom)
    const [joiningUser, owner, memberCount] = await Promise.all([
      User.findById(req.user.id).select('email').lean(),
      User.findById(workspace.ownerId).select('email subscription').lean(),
      WorkspaceMember.countDocuments({ workspaceId: workspace._id })
    ]);

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
          // Apple 3.1.1 — iOS bez zmienky o pláne
          const message = isIosNativeApp(req)
            ? `Dosiahli ste limit ${baseSeatLimit} používateľov v tíme.`
            : `Váš plán umožňuje max. ${baseSeatLimit} používateľov v tíme. Pre viac členov prejdite na vyšší plán.`;
          logPlanGateHit(req, { code: 'PLAN_LIMIT', feature: 'members', limit: baseSeatLimit });
          return res.status(403).json({ message, code: 'PLAN_LIMIT' });
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

    try {
      await membership.save();
    } catch (saveErr) {
      // Súbežný join (dvojklik/retry): unique index { workspaceId, userId }
      // hodil E11000, ale členstvo už existuje → rovnaká odpoveď ako vetva
      // "už člen" vyššie namiesto 500.
      if (saveErr.code !== 11000) throw saveErr;
      const existing = await WorkspaceMember.findOne({ workspaceId: workspace._id, userId: req.user.id });
      await User.findByIdAndUpdate(req.user.id, { currentWorkspaceId: workspace._id });
      return res.json({
        message: 'Už ste členom tohto pracovného prostredia',
        workspace: {
          id: workspace._id,
          name: workspace.name,
          slug: workspace.slug,
          role: existing?.role || membership.role
        }
      });
    }

    // Set as current workspace
    await User.findByIdAndUpdate(req.user.id, { currentWorkspaceId: workspace._id });

    logger.info('User joined workspace', { workspaceId: workspace._id, userId: req.user.id });

    // Notify všetkých ostatných členov workspace, že pribudol nový člen.
    // Beží fire-and-forget — neblokuje response.
    setImmediate(() => {
      const newMember = { _id: req.user.id, username: req.user.username, email: req.user.email };
      notificationService.notifyWorkspaceMemberAdded({
        workspace,
        newMember,
        actor: newMember
      }).catch(err => logger.warn('notifyWorkspaceMemberAdded (join via code) failed', { error: err.message }));
    });

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

    // IMPORTANT: do NOT overwrite User.currentWorkspaceId here.
    //
    // Workspace context is PER-DEVICE, driven by the X-Workspace-Id header that
    // each client (desktop tab, iOS app, Android app, PWA) sends on every
    // request. User.currentWorkspaceId in the DB is meant only as a "first-login
    // / fresh-device default" — set when the user initially creates or joins a
    // workspace, never changed by explicit switches.
    //
    // Writing it on every switch caused cross-device bleed: switching workspace
    // on iOS would silently become the default for a desktop tab that had no
    // sessionStorage yet, so a refresh there snapped the user into the mobile's
    // workspace. We only invalidate the request-scoped workspace cache so the
    // next request picks up the new client-authoritative header value.
    //
    // Backfill: if the user has no DB default at all (legacy account created
    // before this middleware, or the field was cleared on a prior
    // NO_WORKSPACE recovery), we DO set it here — otherwise a brand new device
    // without any local state would have nothing to fall back to.
    const user = await User.findById(req.user.id).select('currentWorkspaceId');
    if (!user?.currentWorkspaceId) {
      await User.findByIdAndUpdate(req.user.id, { currentWorkspaceId: objectId });
    }
    invalidateCache(req.user.id);

    // Vraciame FULL workspace shape (rovnaký ako GET /current), aby klient
    // v jednom React render tiku atomicky nastavil currentWorkspaceId +
    // currentWorkspace. Second roundtrip GET /current by otvoril race window
    // (cross-workspace deep-link bug, commit c18a9b2).
    const [memberCount, owner] = await Promise.all([
      WorkspaceMember.countDocuments({ workspaceId: workspace._id }),
      User.findById(workspace.ownerId).select('subscription').lean()
    ]);
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

// Update workspace (admin can change description/color/invite, but iba OWNER
// môže meniť názov — ide o identitu prostredia a prevenuje zmätok keď admin
// premenuje workspace bez vedomia vlastníka).
router.put('/current', authenticateToken, requireWorkspaceAdmin, async (req, res) => {
  try {
    const { name, description, color, inviteCodeEnabled } = req.body;

    const updates = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ message: 'Názov je povinný' });
      }
      if (name.length > 100) {
        return res.status(400).json({ message: 'Názov môže mať maximálne 100 znakov' });
      }
      // Owner-only kontrola pre zmenu názvu. requireWorkspaceAdmin už pustil
      // owner aj admin role — tu navyše požadujeme ownership výlučne pre
      // name change. Iné polia (description, color, inviteCodeEnabled) admin
      // ďalej môže meniť bez tejto reštrikcie.
      const requesterMembership = await WorkspaceMember.findOne({
        workspaceId: req.workspace._id,
        userId: req.user.id
      }).select('role').lean();
      if (!requesterMembership || requesterMembership.role !== 'owner') {
        return res.status(403).json({
          message: 'Iba vlastník prostredia môže zmeniť jeho názov.',
          code: 'OWNER_ONLY'
        });
      }
      updates.name = name.trim();
    }
    if (description !== undefined) {
      if (typeof description !== 'string' || description.length > 500) {
        return res.status(400).json({ message: 'Popis môže mať maximálne 500 znakov' });
      }
      updates.description = description.trim();
    }
    if (color !== undefined) {
      if (!isValidHexColor(color)) {
        return res.status(400).json({ message: 'Neplatná farba' });
      }
      updates.color = color;
    }
    if (inviteCodeEnabled !== undefined) {
      if (typeof inviteCodeEnabled !== 'boolean') {
        return res.status(400).json({ message: 'Neplatná hodnota inviteCodeEnabled' });
      }
      updates.inviteCodeEnabled = inviteCodeEnabled;
    }

    // runValidators — update dotazy inak obchádzajú schémové validátory
    // (maxlength description 500 / name 100).
    const workspace = await Workspace.findByIdAndUpdate(
      req.workspace._id,
      updates,
      { new: true, runValidators: true }
    );
    // requireWorkspace kešuje celý Workspace dokument 60 s — bez invalidácie by
    // GET /current žiadateľa vrátil starý názov/farbu/inviteCodeEnabled.
    invalidateCache(req.user.id);

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
    invalidateCache(req.user.id);

    const owner = await User.findById(req.workspace.ownerId).select('subscription').lean();
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
    invalidateCache(req.user.id);

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

    // populate vráti null pre osirelé membership (User zmazaný mimo štandardného
    // flow / ručný zásah v DB) — bez filtra by jedno také zhodilo celý zoznam
    // členov na 500 pre všetkých členov workspace-u.
    const membersData = members.filter(m => m.userId).map(m => ({
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
    if (membersData.length !== members.length) {
      logger.warn('Orphaned memberships skipped', {
        workspaceId: req.workspace._id,
        orphans: members.length - membersData.length
      });
    }

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

    // Neplatný formát ID by inak skončil Mongoose CastError → 500 namiesto 400.
    if (!mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({ message: 'Neplatné ID člena' });
    }

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
    // Membership je kešovaná 60 s v requireWorkspace — bez invalidácie by člen
    // ešte minútu pracoval so starými oprávneniami (canAdmin()).
    invalidateCache(String(member.userId));

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

    if (!mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({ message: 'Neplatné ID člena' });
    }

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

    // If removing self (leaving workspace). req.user.id je ObjectId pri auth
    // cache miss a string pri Redis hite — porovnávame ako string.
    if (member.userId.toString() === String(req.user.id)) {
      // Clear current workspace if this is it
      const user = await User.findById(req.user.id).select('currentWorkspaceId').lean();
      if (user?.currentWorkspaceId?.toString() === req.workspace._id.toString()) {
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
    // Odstránený člen nesmie ďalších 60 s prechádzať requireWorkspace z cache.
    invalidateCache(String(member.userId));

    // Clear removed user's current workspace if needed
    const removedUser = await User.findById(member.userId).select('currentWorkspaceId').lean();
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

    // Meno odchádzajúceho je už v req.user (auth middleware) — ďalší dotaz na
    // User bol zbytočný a pri medzičasom zmazanom účte by sa na null padlo až
    // PO zmazaní membership (nekonzistentný stav + 500).
    const leavingName = req.user.username || 'Používateľ';
    const workspaceName = req.workspace.name;

    await WorkspaceMember.deleteOne({ _id: req.workspaceMember._id });
    invalidateCache(req.user.id);

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

    // Paralelne — každé createNotification je save + socket emit + push,
    // sekvenčná slučka zbytočne násobila latenciu počtom adminov.
    await Promise.all(admins.map(admin => notificationService.createNotification({
      userId: admin.userId.toString(),
      workspaceId: req.workspace._id,
      type: 'workspace',
      title: `${leavingName} opustil/a prostredie`,
      message: `Používateľ ${leavingName} opustil/a pracovné prostredie "${workspaceName}".`,
      actorId: req.user.id,
      actorName: leavingName,
      relatedType: 'workspace',
      relatedId: req.workspace._id.toString(),
      relatedName: workspaceName
    })));

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

    if (!mongoose.Types.ObjectId.isValid(newOwnerId)) {
      return res.status(400).json({ message: 'Neplatné ID používateľa' });
    }

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

    // Poradie zápisov: najprv ownerId a povýšenie nového vlastníka, až
    // nakoniec degradácia starého. Ak niektorý zápis zlyhá, prechodný stav
    // "dvaja vlastníci" je bezpečný (starý vlastník operáciu zopakuje);
    // pôvodné poradie mohlo nechať workspace úplne bez vlastníka.
    await Workspace.findByIdAndUpdate(req.workspace._id, { ownerId: newOwnerId });

    newOwnerMembership.role = 'owner';
    await newOwnerMembership.save();

    // Old owner becomes member
    req.workspaceMember.role = 'member';
    await req.workspaceMember.save();

    // Obaja majú v cache staré membership (rola) aj starý Workspace.ownerId.
    invalidateCache(req.user.id);
    invalidateCache(String(newOwnerId));

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

    // Delete workspace data (contacts, tasks, messages, invitations, pages, notifications)
    const Contact = require('../models/Contact');
    const Task = require('../models/Task');
    const Message = require('../models/Message');
    const Page = require('../models/Page');
    const Notification = require('../models/Notification');
    const { deleteMessageBlobs } = require('../services/messageFiles');
    await Contact.deleteMany({ workspaceId });
    await Task.deleteMany({ workspaceId });
    // Bloby príloh správ (R2) PRED deleteMany — po ňom už kľúče niet odkiaľ
    // prečítať. Best-effort, nikdy nehádže.
    await deleteMessageBlobs({ workspaceId });
    await Message.deleteMany({ workspaceId });
    await Invitation.deleteMany({ workspaceId });
    // Stránky a notifikácie sú tiež viazané na workspaceId — predtým ostávali
    // osirelé (Pages natrvalo, Notifications až do TTL expirácie).
    await Page.deleteMany({ workspaceId });
    await Notification.deleteMany({ workspaceId });

    // Delete workspace
    await Workspace.deleteOne({ _id: workspaceId });
    invalidateCache(req.user.id);

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
    if (typeof email !== 'string' || email.trim().length === 0) {
      return res.status(400).json({ message: 'Email je povinný' });
    }
    // Permisívny formát local@domain.tld + limit dĺžky (RFC 5321: 254) —
    // inak sa ľubovoľný reťazec uložil do Invitation a poslal do SMTP ako adresát.
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ message: 'Neplatný e-mail' });
    }

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
    const owner = await User.findById(workspace.ownerId).select('subscription').lean();
    const memberCount = await WorkspaceMember.countDocuments({ workspaceId: req.workspaceId });

    // Team Pro emails bypass capacity check entirely
    const proEmails = (process.env.PRO_EMAILS || 'project.manager@eperun.sk,martin.kosco@eperun.sk').split(',').map(e => e.trim()).filter(Boolean);
    const inviterUser = await User.findById(req.user.id).select('email username').lean();
    const isTeamPro = proEmails.includes(inviterUser?.email?.toLowerCase());

    if (!isTeamPro) {
      const ownerPlan = owner?.subscription?.plan || 'free';
      const seatLimits = { free: 2, trial: 2, team: 10, pro: Infinity };
      const baseSeatLimit = seatLimits[ownerPlan] || 2;
      if (baseSeatLimit !== Infinity) {
        const maxSeats = baseSeatLimit + (workspace.paidSeats || 0);
        if (memberCount >= maxSeats) {
          // Apple 3.1.1 — iOS bez zmienky o pláne
          const message = isIosNativeApp(req)
            ? `Dosiahli ste limit ${baseSeatLimit} členov v tíme.`
            : `Váš plán umožňuje max. ${baseSeatLimit} členov. Pre viac členov prejdite na vyšší plán.`;
          logPlanGateHit(req, { code: 'PLAN_LIMIT', feature: 'members', limit: baseSeatLimit });
          // 403 ako pri POST / a POST /join — klient reaguje na `code`, nie na status.
          return res.status(403).json({ message, code: 'PLAN_LIMIT' });
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

    // Odoslanie e-mailu s pozvánkou. SMTP transporter nemá nastavené timeouty
    // (nodemailer default: 2 min connection / 10 min socket), takže pri
    // nedostupnom SMTP by tento request visel minúty. Čakáme max. 15 s —
    // pozvánka aj odkaz sú už vytvorené a klient ich zobrazí; e-mail môže
    // doraziť neskôr (vtedy sa iba zaloguje).
    let emailSent = false;
    let emailTimer = null;
    const emailPromise = sendInvitationEmail({
      toEmail: normalizedEmail,
      inviterName: inviterUser?.username || 'Člen tímu',
      workspaceName: workspace.name,
      role: invitation.role,
      inviteLink,
      expiresAt: invitation.expiresAt
    }).catch((emailErr) => {
      logger.warn('Invitation email failed', { error: emailErr.message, email: normalizedEmail });
      return false;
    });
    emailSent = await Promise.race([
      emailPromise,
      new Promise((resolve) => {
        emailTimer = setTimeout(() => {
          logger.warn('Invitation email timed out (15 s) — response sent without waiting', { email: normalizedEmail });
          emailPromise.then((sent) => {
            if (sent) logger.info('Invitation email eventually sent after timeout', { email: normalizedEmail });
          });
          resolve(false);
        }, 15000);
      })
    ]);
    if (emailTimer) clearTimeout(emailTimer);

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
    if (!mongoose.Types.ObjectId.isValid(req.params.invitationId)) {
      return res.status(400).json({ message: 'Neplatné ID pozvánky' });
    }
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

    const owner = await User.findById(workspace.ownerId).select('email subscription').lean();
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
          // Apple 3.1.1 — iOS bez zmienky o pláne/dokupovaní; rovnaký tvar
          // (code PLAN_LIMIT + audit záznam + 403) ako ostatné plan-gate miesta.
          const message = isIosNativeApp(req)
            ? 'Toto pracovné prostredie je plné.'
            : 'Prostredie je plné. Vlastník musí prejsť na vyšší plán alebo dokúpiť miesta.';
          logPlanGateHit(req, { code: 'PLAN_LIMIT', feature: 'members', limit: baseSeatLimit });
          return res.status(403).json({ message, code: 'PLAN_LIMIT' });
        }
      }
    }

    // Create membership. Unique index { workspaceId, userId } — pri dvojkliku
    // / retry klienta prejde druhý request kontrolou "už člen" ešte pred
    // vznikom membership a create() hodí E11000; členstvo však existuje,
    // takže odpovedáme ako pri existujúcom členovi namiesto 500.
    try {
      await WorkspaceMember.create({
        workspaceId: invitation.workspaceId,
        userId: req.user.id,
        role: invitation.role,
        invitedBy: invitation.invitedBy
      });
    } catch (createErr) {
      if (createErr.code !== 11000) throw createErr;
      invitation.status = 'accepted';
      await invitation.save();
      return res.json({ message: 'Už ste členom tohto prostredia', workspaceId: invitation.workspaceId });
    }

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

    // Notifikuj ostatných členov workspace o novom kolegovi.
    setImmediate(() => {
      const newMember = { _id: req.user.id, username: req.user.username, email: req.user.email };
      notificationService.notifyWorkspaceMemberAdded({
        workspace,
        newMember,
        actor: newMember
      }).catch(err => logger.warn('notifyWorkspaceMemberAdded (invite accepted) failed', { error: err.message }));
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
