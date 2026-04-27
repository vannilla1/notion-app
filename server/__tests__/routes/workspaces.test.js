const { createTestApp, createUserWithWorkspace, addMember, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const workspacesRouter = require('../../routes/workspaces');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const Invitation = require('../../models/Invitation');

/**
 * /api/workspaces route testy — multi-tenant permission model.
 *
 * Kľúčové invarianty:
 *   - requireWorkspaceAdmin: 403 pre "member" roly (iba owner/manager prejdú)
 *   - requireWorkspaceOwner: 403 pre "manager" (iba owner prejde)
 *   - POST / auto-priradí creator role='owner' + nastaví currentWorkspaceId
 *   - POST /join s inviteCode rešpektuje member limity plánu (free=2, team=10, pro=∞)
 *   - POST /switch/:id vyžaduje membership (inak 403, nepriamo leak workspace name)
 */
describe('/api/workspaces route', () => {
  let app;
  let ownerCtx;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    await Invitation.init();
    ({ app } = createTestApp('/api/workspaces', workspacesRouter));
  });

  beforeEach(async () => {
    await Invitation.deleteMany({});
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    ownerCtx = await createUserWithWorkspace({
      username: 'owner',
      email: 'owner@test.com',
      role: 'owner',
      workspaceName: 'Primary'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('GET /', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/workspaces');
      expect(res.status).toBe(401);
    });

    it('vráti iba workspaces kde som member, + currentWorkspaceId', async () => {
      // Vytvoríme ešte jeden workspace ktorého NIE SOM člen
      const stranger = await User.create({ username: 's', email: 's@test.com', password: 'x' });
      await Workspace.create({ name: 'Stranger', slug: 'stranger', ownerId: stranger._id });

      const res = await request(app)
        .get('/api/workspaces')
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body.workspaces).toHaveLength(1);
      expect(res.body.workspaces[0].name).toBe('Primary');
      expect(res.body.workspaces[0].isOwner).toBe(true);
      expect(res.body.currentWorkspaceId.toString()).toBe(ownerCtx.workspace._id.toString());
    });

    it('user s viacerými rolami vidí všetky svoje workspaces', async () => {
      const anotherOwner = await User.create({
        username: 'other-owner', email: 'oo@test.com', password: 'x'
      });
      const secondWs = await Workspace.create({
        name: 'Second', slug: 'second', ownerId: anotherOwner._id
      });
      await WorkspaceMember.create({
        workspaceId: secondWs._id, userId: ownerCtx.user._id, role: 'manager'
      });

      const res = await request(app)
        .get('/api/workspaces')
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body.workspaces).toHaveLength(2);
      const names = res.body.workspaces.map(w => w.name).sort();
      expect(names).toEqual(['Primary', 'Second']);
    });
  });

  describe('POST /', () => {
    it('vytvorí workspace + auto-assign owner + nastaví currentWorkspaceId', async () => {
      const res = await request(app)
        .post('/api/workspaces')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'Brand New WS', description: 'desc', color: '#ff00ff' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Brand New WS');
      expect(res.body.role).toBe('owner');
      expect(res.body.inviteCode).toBeDefined();
      // inviteCode format (viď Workspace.generateInviteCode)
      expect(res.body.inviteCode).toMatch(/^[A-Z0-9]{8}$/);

      // Owner membership bol vytvorený
      const memberships = await WorkspaceMember.find({
        userId: ownerCtx.user._id,
        role: 'owner'
      });
      expect(memberships).toHaveLength(2); // pôvodný Primary + nový

      // Current workspace sa prepol na nový
      const freshUser = await User.findById(ownerCtx.user._id);
      expect(freshUser.currentWorkspaceId.toString()).toBe(res.body.id.toString());
    });

    it('400 ak name je prázdny', async () => {
      const res = await request(app)
        .post('/api/workspaces')
        .set(authHeader(ownerCtx.token))
        .send({ name: '   ' });
      expect(res.status).toBe(400);
    });

    it('400 ak name > 100 znakov', async () => {
      const res = await request(app)
        .post('/api/workspaces')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'A'.repeat(101) });
      expect(res.status).toBe(400);
    });

    it('slug je auto-generovaný a unikátny (counter suffix)', async () => {
      const r1 = await request(app)
        .post('/api/workspaces')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'Duplicate Name' });

      const r2 = await request(app)
        .post('/api/workspaces')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'Duplicate Name' });

      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r1.body.slug).not.toBe(r2.body.slug);
    });
  });

  describe('POST /join (invite code)', () => {
    let joiner;
    let joinerToken;
    let ws;

    beforeEach(async () => {
      ws = ownerCtx.workspace;
      // Refetch with invite code
      const fresh = await Workspace.findById(ws._id);
      if (!fresh.inviteCode) {
        fresh.inviteCode = 'TESTJOIN';
        await fresh.save();
        ws = fresh;
      } else {
        ws = fresh;
      }

      joiner = await User.create({
        username: 'joiner', email: 'joiner@test.com', password: 'x'
      });
      joinerToken = jwt.sign({ id: joiner._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });
    });

    it('400 bez inviteCode', async () => {
      const res = await request(app)
        .post('/api/workspaces/join')
        .set(authHeader(joinerToken))
        .send({});
      expect(res.status).toBe(400);
    });

    it('404 pri neplatnom kóde', async () => {
      const res = await request(app)
        .post('/api/workspaces/join')
        .set(authHeader(joinerToken))
        .send({ inviteCode: 'INVALIDXYZ' });
      expect(res.status).toBe(404);
    });

    it('úspešné joinnutie vytvorí membership s default role=member', async () => {
      const res = await request(app)
        .post('/api/workspaces/join')
        .set(authHeader(joinerToken))
        .send({ inviteCode: ws.inviteCode });

      expect(res.status).toBe(200);
      expect(res.body.workspace.role).toBe('member');

      const membership = await WorkspaceMember.findOne({
        workspaceId: ws._id, userId: joiner._id
      });
      expect(membership).not.toBeNull();
      expect(membership.role).toBe('member');
    });

    it('ak je user už member → len prepne currentWorkspaceId, nevytvorí duplicate', async () => {
      await WorkspaceMember.create({
        workspaceId: ws._id, userId: joiner._id, role: 'manager'
      });

      const res = await request(app)
        .post('/api/workspaces/join')
        .set(authHeader(joinerToken))
        .send({ inviteCode: ws.inviteCode });

      expect(res.status).toBe(200);
      expect(res.body.workspace.role).toBe('manager'); // zachováva existujúcu rolu

      const count = await WorkspaceMember.countDocuments({
        workspaceId: ws._id, userId: joiner._id
      });
      expect(count).toBe(1); // žiadny duplicate
    });

    it('403 ak workspace prekročil limit free plánu (max 2 members)', async () => {
      // owner + 1 member = 2 (limit), tretí pokus by mal zlyhať
      const filler = await User.create({
        username: 'filler', email: 'filler@test.com', password: 'x'
      });
      await WorkspaceMember.create({
        workspaceId: ws._id, userId: filler._id, role: 'member'
      });

      const res = await request(app)
        .post('/api/workspaces/join')
        .set(authHeader(joinerToken))
        .send({ inviteCode: ws.inviteCode });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/plán/i);
    });

    it('404 ak inviteCodeEnabled=false', async () => {
      ws.inviteCodeEnabled = false;
      await ws.save();

      const res = await request(app)
        .post('/api/workspaces/join')
        .set(authHeader(joinerToken))
        .send({ inviteCode: ws.inviteCode });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /switch/:workspaceId', () => {
    it('400 pri invalid ObjectId', async () => {
      const res = await request(app)
        .post('/api/workspaces/switch/not-valid')
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(400);
    });

    it('404 pri neexistujúcom workspace', async () => {
      const fake = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .post(`/api/workspaces/switch/${fake}`)
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(404);
    });

    it('403 ak nie som member (nesmie leaknúť workspace info)', async () => {
      const stranger = await User.create({ username: 's', email: 's@test.com', password: 'x' });
      const foreignWs = await Workspace.create({
        name: 'Foreign Secrets', slug: 'foreign', ownerId: stranger._id
      });

      const res = await request(app)
        .post(`/api/workspaces/switch/${foreignWs._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(403);
      // Nesmieme vrátiť workspace name ani iné info
      expect(res.body.workspace).toBeUndefined();
      expect(res.body.name).toBeUndefined();
    });

    it('úspešné prepnutie vráti workspace shape, ZÁMERNE neprepisuje currentWorkspaceId', async () => {
      // Endpoint ZÁMERNE neprepisuje currentWorkspaceId (cross-device bleed
      // ochrana — komentár v server/routes/workspaces.js:276). Workspace
      // context je per-device cez X-Workspace-Id header. Test overí že
      // odpoveď nese správny shape, ale DB default sa pre owner-a nemení
      // (lebo už mal nastavený currentWorkspaceId pri seed-e).
      const anotherOwner = await User.create({
        username: 'ao', email: 'ao@test.com', password: 'x'
      });
      const secondWs = await Workspace.create({
        name: 'Second', slug: 'second', ownerId: anotherOwner._id
      });
      await WorkspaceMember.create({
        workspaceId: secondWs._id, userId: ownerCtx.user._id, role: 'member'
      });

      const beforeUser = await User.findById(ownerCtx.user._id);
      const originalCurrentWs = beforeUser.currentWorkspaceId?.toString();

      const res = await request(app)
        .post(`/api/workspaces/switch/${secondWs._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body.workspace.role).toBe('member');
      expect(res.body.workspace.id).toBe(secondWs._id.toString());

      // currentWorkspaceId sa NEMÁ zmeniť — ostáva pôvodný (header je
      // single source of truth pre per-request workspace, DB default ostáva).
      const freshUser = await User.findById(ownerCtx.user._id);
      expect(freshUser.currentWorkspaceId?.toString()).toBe(originalCurrentWs);
    });

    it('response má FULL workspace shape (rovnaký ako GET /current) — lock-in pre atomický client update', async () => {
      // KĽÚČOVÉ: POST /switch musí vrátiť kompletný shape, aby klient vedel
      // v jednom React render tiku atomicky nastaviť currentWorkspaceId AJ
      // currentWorkspace. Inak vznikne race window (ID=B, details=A) a deep-link
      // gate v App.jsx by odomkol stránku s nesprávnym header/sidebar.
      // Ak niekto zjednoduší tento endpoint späť na 5 polí, tento test to chytí.
      const anotherOwner = await User.create({
        username: 'owner2', email: 'owner2@test.com', password: 'x'
      });
      const secondWs = await Workspace.create({
        name: 'Second WS',
        slug: 'second-ws',
        ownerId: anotherOwner._id,
        description: 'popis',
        color: '#abcdef',
        inviteCode: 'ABC12345',
        inviteCodeEnabled: true
      });
      await WorkspaceMember.create({
        workspaceId: secondWs._id, userId: ownerCtx.user._id, role: 'manager'
      });
      // Owner membership kvôli memberCount
      await WorkspaceMember.create({
        workspaceId: secondWs._id, userId: anotherOwner._id, role: 'owner'
      });

      const res = await request(app)
        .post(`/api/workspaces/switch/${secondWs._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      const ws = res.body.workspace;

      // Všetky polia ktoré vracia GET /current MUSIA byť v POST /switch response
      expect(ws).toHaveProperty('id');
      expect(ws).toHaveProperty('name', 'Second WS');
      expect(ws).toHaveProperty('slug', 'second-ws');
      expect(ws).toHaveProperty('description', 'popis');
      expect(ws).toHaveProperty('color', '#abcdef');
      expect(ws).toHaveProperty('inviteCodeEnabled', true);
      expect(ws).toHaveProperty('settings');
      expect(ws).toHaveProperty('role', 'manager');
      expect(ws).toHaveProperty('memberCount', 2);
      expect(ws).toHaveProperty('paidSeats');
      expect(ws).toHaveProperty('maxMembers');
      expect(ws).toHaveProperty('ownerPlan');
      expect(ws).toHaveProperty('isOverLimit');
      expect(ws).toHaveProperty('createdAt');

      // Manager smie vidieť inviteCode (canAdmin() = true)
      expect(ws.inviteCode).toBe('ABC12345');
    });

    it('response skryje inviteCode pred members (canAdmin() = false)', async () => {
      const anotherOwner = await User.create({
        username: 'owner3', email: 'o3@test.com', password: 'x'
      });
      const ws3 = await Workspace.create({
        name: 'Third', slug: 'third', ownerId: anotherOwner._id,
        inviteCode: 'SECRET00', inviteCodeEnabled: true
      });
      await WorkspaceMember.create({
        workspaceId: ws3._id, userId: ownerCtx.user._id, role: 'member'
      });

      const res = await request(app)
        .post(`/api/workspaces/switch/${ws3._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body.workspace.role).toBe('member');
      expect(res.body.workspace.inviteCode).toBeUndefined();
    });
  });

  describe('PUT /current (admin only)', () => {
    it('403 pre member role', async () => {
      const memberCtx = await addMember(ownerCtx.workspace._id, {
        username: 'plain', email: 'plain@test.com', role: 'member'
      });

      const res = await request(app)
        .put('/api/workspaces/current')
        .set(authHeader(memberCtx.token))
        .send({ name: 'HACKED' });

      expect(res.status).toBe(403);
      // DB sa nezmenila
      const fresh = await Workspace.findById(ownerCtx.workspace._id);
      expect(fresh.name).toBe('Primary');
    });

    it('manager MÔŽE updatnúť (canAdmin() = true)', async () => {
      const managerCtx = await addMember(ownerCtx.workspace._id, {
        username: 'manager', email: 'mgr@test.com', role: 'manager'
      });

      const res = await request(app)
        .put('/api/workspaces/current')
        .set(authHeader(managerCtx.token))
        .send({ name: 'Renamed by Manager' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed by Manager');
    });

    it('owner updatuje name + description + color', async () => {
      const res = await request(app)
        .put('/api/workspaces/current')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'New', description: 'desc', color: '#123456' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('New');
      expect(res.body.description).toBe('desc');
      expect(res.body.color).toBe('#123456');
    });

    it('400 ak name je prázdny string', async () => {
      const res = await request(app)
        .put('/api/workspaces/current')
        .set(authHeader(ownerCtx.token))
        .send({ name: '   ' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /current/regenerate-invite (admin only)', () => {
    it('403 pre member', async () => {
      const memberCtx = await addMember(ownerCtx.workspace._id, {
        username: 'm2', email: 'm2@test.com', role: 'member'
      });

      const res = await request(app)
        .post('/api/workspaces/current/regenerate-invite')
        .set(authHeader(memberCtx.token));
      expect(res.status).toBe(403);
    });

    it('owner regeneruje → nový 8-char kód', async () => {
      const before = await Workspace.findById(ownerCtx.workspace._id);
      const res = await request(app)
        .post('/api/workspaces/current/regenerate-invite')
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body.inviteCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(res.body.inviteCode).not.toBe(before.inviteCode);
    });
  });

  describe('GET /current/members', () => {
    it('vráti všetkých členov s canEdit podľa roly volajúceho', async () => {
      await addMember(ownerCtx.workspace._id, {
        username: 'mem', email: 'mem@test.com', role: 'member'
      });
      await addMember(ownerCtx.workspace._id, {
        username: 'mgr', email: 'mgr@test.com', role: 'manager'
      });

      const res = await request(app)
        .get('/api/workspaces/current/members')
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3); // owner + mgr + member

      const ownerEntry = res.body.find(m => m.role === 'owner');
      const memberEntry = res.body.find(m => m.role === 'member');
      // Owner sa nedá editovať (ani iný admin)
      expect(ownerEntry.canEdit).toBe(false);
      // Member sa dá editovať (volajúci je owner = admin)
      expect(memberEntry.canEdit).toBe(true);
    });

    it('member volajúci má canEdit=false pre všetkých', async () => {
      const memberCtx = await addMember(ownerCtx.workspace._id, {
        username: 'm3', email: 'm3@test.com', role: 'member'
      });

      const res = await request(app)
        .get('/api/workspaces/current/members')
        .set(authHeader(memberCtx.token));

      expect(res.status).toBe(200);
      res.body.forEach((m) => {
        expect(m.canEdit).toBe(false);
      });
    });
  });
});
