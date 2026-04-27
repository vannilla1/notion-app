const { createTestApp, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authRouter = require('../../routes/auth');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * /api/auth route testy — register, login, profile, password change.
 *
 * Security invarianty:
 *   - Password sa nikdy neposiela späť klientovi (ani v response, ani v /me)
 *   - Generic error message pri duplicate email/username (anti-enumeration):
 *     "Registrácia zlyhala. Skúste iný email alebo používateľské meno."
 *   - Super admin email (support@prplcrm.eu) sa nesmie zaregistrovať cez bežný flow
 *     ani prihlásiť cez POST /login (má samostatný admin flow)
 *   - Min password length = 6 znakov
 *   - bcrypt salt = 12 rounds (register + password change)
 *   - /avatar/:userId je verejný (bez auth) — slúži na <img src> v UI
 *
 * Rate limiters sú vypnuté cez SKIP_RATE_LIMIT=true (testApp helper).
 */
describe('/api/auth route', () => {
  let app;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    ({ app } = createTestApp('/api/auth', authRouter));
  });

  beforeEach(async () => {
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('POST /register', () => {
    it('vytvorí nového usera + hashne heslo + vráti JWT', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'alice', email: 'alice@test.com', password: 'secret123' });

      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.username).toBe('alice');
      expect(res.body.user.email).toBe('alice@test.com');
      expect(res.body.user.role).toBe('user');
      // KRITICKÉ: heslo sa nesmie vrátiť klientovi
      expect(res.body.user.password).toBeUndefined();

      const dbUser = await User.findOne({ email: 'alice@test.com' });
      expect(dbUser).not.toBeNull();
      // heslo je hashnuté, nie plaintext
      expect(dbUser.password).not.toBe('secret123');
      expect(await bcrypt.compare('secret123', dbUser.password)).toBe(true);
    });

    it('400 ak chýba username/email/password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'x@test.com' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/povinné/);
    });

    it('400 ak heslo < 6 znakov', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'bob', email: 'b@test.com', password: '12345' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/6 znakov/);
    });

    it('duplicate email a duplicate username vracajú IDENTICKÝ generic message (anti-enumeration)', async () => {
      // Anti-enumeration invariant: server nesmie prezrádzať či existuje email
      // alebo username. Oba prípady musia vrátiť ROVNAKÝ text, inak útočník vie
      // rozlíšiť: "dup email" vs "dup username".
      await User.create({ username: 'existing-name', email: 'dup@test.com', password: 'x' });

      const dupEmail = await request(app)
        .post('/api/auth/register')
        .send({ username: 'new-name', email: 'dup@test.com', password: 'secret123' });

      const dupUsername = await request(app)
        .post('/api/auth/register')
        .send({ username: 'existing-name', email: 'new@test.com', password: 'secret123' });

      expect(dupEmail.status).toBe(400);
      expect(dupUsername.status).toBe(400);
      expect(dupEmail.body.message).toMatch(/Registrácia zlyhala/);
      // KRITICKÉ: oba messages sú identické → útočník nevie rozlíšiť prípad
      expect(dupEmail.body.message).toBe(dupUsername.body.message);
    });

    it('BLOKUJE registráciu support@prplcrm.eu (super admin reserved)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'fake-admin', email: 'support@prplcrm.eu', password: 'secret123' });

      expect(res.status).toBe(400);
      expect(await User.countDocuments({ email: 'support@prplcrm.eu' })).toBe(0);
    });

    it('všetci noví useri majú role="user" (admin sa dá nastaviť len cez seed)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'wannabe', email: 'w@test.com', password: 'secret123', role: 'admin' });

      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('user');

      const dbUser = await User.findOne({ email: 'w@test.com' });
      expect(dbUser.role).toBe('user');
    });

    it('JWT token je podpísaný JWT_SECRET a obsahuje user.id', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'jwt-user', email: 'j@test.com', password: 'secret123' });

      expect(res.status).toBe(201);
      const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
      expect(decoded.id).toBeDefined();
      expect(decoded.id.toString()).toBe(res.body.user.id.toString());
    });
  });

  describe('POST /login', () => {
    const plainPassword = 'topsecret123';
    let existingUser;

    beforeEach(async () => {
      const hashed = await bcrypt.hash(plainPassword, 12);
      existingUser = await User.create({
        username: 'loginuser',
        email: 'login@test.com',
        password: hashed,
        color: '#3B82F6',
        role: 'user'
      });
    });

    it('prihlási platnými credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'login@test.com', password: plainPassword });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.email).toBe('login@test.com');
      expect(res.body.user.password).toBeUndefined();
    });

    it('400 pri nesprávnom heslee', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'login@test.com', password: 'wrong-password' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Nesprávny/);
    });

    it('400 pri neexistujúcom emaili (rovnaká správa — anti-enumeration)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@test.com', password: 'anything' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Nesprávny/);
    });

    it('400 ak chýba email alebo heslo', async () => {
      let res = await request(app).post('/api/auth/login').send({ email: 'x@test.com' });
      expect(res.status).toBe(400);
      res = await request(app).post('/api/auth/login').send({ password: 'x' });
      expect(res.status).toBe(400);
    });

    it('BLOKUJE login support@prplcrm.eu cez bežný flow', async () => {
      const hashed = await bcrypt.hash('admin123', 12);
      await User.create({ username: 'superadmin', email: 'support@prplcrm.eu', password: hashed });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'support@prplcrm.eu', password: 'admin123' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /me', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('vráti current user info (bez hesla)', async () => {
      const user = await User.create({
        username: 'me-user',
        email: 'me@test.com',
        password: 'hashed',
        role: 'user'
      });
      const token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });

      const res = await request(app)
        .get('/api/auth/me')
        .set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.username).toBe('me-user');
      expect(res.body.email).toBe('me@test.com');
      expect(res.body.password).toBeUndefined();
    });
  });

  describe('GET /profile', () => {
    it('vráti profile bez hesla', async () => {
      const user = await User.create({
        username: 'profile-user',
        email: 'p@test.com',
        password: 'hashed',
        color: '#EF4444'
      });
      const token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });

      const res = await request(app)
        .get('/api/auth/profile')
        .set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.email).toBe('p@test.com');
      expect(res.body.color).toBe('#EF4444');
      expect(res.body.password).toBeUndefined();
    });
  });

  describe('PUT /profile', () => {
    let user;
    let token;

    beforeEach(async () => {
      user = await User.create({
        username: 'editable',
        email: 'edit@test.com',
        password: 'hashed',
        color: '#3B82F6'
      });
      token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });
    });

    it('aktualizuje username + email + color', async () => {
      const res = await request(app)
        .put('/api/auth/profile')
        .set(authHeader(token))
        .send({ username: 'renamed', email: 'new@test.com', color: '#10B981' });

      expect(res.status).toBe(200);
      expect(res.body.username).toBe('renamed');
      expect(res.body.email).toBe('new@test.com');
      expect(res.body.color).toBe('#10B981');
    });

    it('400 ak nový email berie iný user', async () => {
      await User.create({ username: 'other', email: 'taken@test.com', password: 'x' });

      const res = await request(app)
        .put('/api/auth/profile')
        .set(authHeader(token))
        .send({ email: 'taken@test.com' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/registrovaný/);
    });

    it('400 ak nové username berie iný user', async () => {
      await User.create({ username: 'takenhandle', email: 't@test.com', password: 'x' });

      const res = await request(app)
        .put('/api/auth/profile')
        .set(authHeader(token))
        .send({ username: 'takenhandle' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/obsadené/);
    });
  });

  describe('PUT /password', () => {
    let user;
    let token;
    const currentPw = 'oldpass123';

    beforeEach(async () => {
      const hashed = await bcrypt.hash(currentPw, 12);
      user = await User.create({
        username: 'pwchanger', email: 'pw@test.com', password: hashed
      });
      token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });
    });

    it('zmení heslo pri správnom currentPassword', async () => {
      const res = await request(app)
        .put('/api/auth/password')
        .set(authHeader(token))
        .send({ currentPassword: currentPw, newPassword: 'newpass456' });

      expect(res.status).toBe(200);

      const dbUser = await User.findById(user._id);
      expect(await bcrypt.compare('newpass456', dbUser.password)).toBe(true);
      expect(await bcrypt.compare(currentPw, dbUser.password)).toBe(false);
    });

    it('400 pri nesprávnom currentPassword (nezmení heslo)', async () => {
      const res = await request(app)
        .put('/api/auth/password')
        .set(authHeader(token))
        .send({ currentPassword: 'wrong', newPassword: 'newpass456' });

      expect(res.status).toBe(400);

      const dbUser = await User.findById(user._id);
      // Pôvodné heslo sa nezmenilo
      expect(await bcrypt.compare(currentPw, dbUser.password)).toBe(true);
    });

    it('400 ak nové heslo < 6 znakov', async () => {
      const res = await request(app)
        .put('/api/auth/password')
        .set(authHeader(token))
        .send({ currentPassword: currentPw, newPassword: '12345' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /users (workspace members)', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/auth/users');
      expect(res.status).toBe(401);
    });

    it('vráti 400 NO_WORKSPACE ak user nemá currentWorkspaceId ani membership', async () => {
      // Endpoint teraz používa requireWorkspace middleware (zmena: aby vrátil
      // členov AKTUÁLNEHO workspace-u podľa X-Workspace-Id header-a, nie iba
      // currentWorkspaceId z DB). User bez akéhokoľvek workspace dostane
      // 400 NO_WORKSPACE — klient na to odpovedá (od commit 6d404c8) cez
      // axios interceptor: zmaže stale storage a retry-uje, alebo zobrazí
      // empty-state UI ak user naozaj nemá žiadny workspace.
      const user = await User.create({
        username: 'noworkspace',
        email: 'nws@test.com',
        password: 'hashed'
      });
      const token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });

      const res = await request(app)
        .get('/api/auth/users')
        .set(authHeader(token));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_WORKSPACE');
    });

    it('vráti členov rovnakého workspace (bez password field)', async () => {
      const owner = await User.create({
        username: 'owner', email: 'o@test.com', password: 'hashed', color: '#111'
      });
      const workspace = await Workspace.create({
        name: 'Shared', slug: 'shared', ownerId: owner._id
      });
      const member2 = await User.create({
        username: 'second', email: 's@test.com', password: 'hashed', color: '#222'
      });
      await WorkspaceMember.create([
        { workspaceId: workspace._id, userId: owner._id, role: 'owner' },
        { workspaceId: workspace._id, userId: member2._id, role: 'member' }
      ]);
      owner.currentWorkspaceId = workspace._id;
      await owner.save();

      const token = jwt.sign({ id: owner._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });

      const res = await request(app)
        .get('/api/auth/users')
        .set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      res.body.forEach((u) => {
        expect(u.password).toBeUndefined();
        expect(u.username).toBeDefined();
        expect(u.email).toBeDefined();
      });
    });

    it('role je workspace-scoped (nie globálne User.role) — assignee picker nesmie leakovať admin status z iného workspace', async () => {
      // User má globálne User.role = 'admin' (super-admin feature), ale
      // v tomto konkrétnom workspace je len 'member'. Endpoint MUSÍ vrátiť
      // workspace-rolu ('member'), nie globálnu ('admin').
      const globalAdmin = await User.create({
        username: 'globaladmin',
        email: 'ga@test.com',
        password: 'hashed',
        color: '#f00',
        role: 'admin' // globálna rola — super admin na platforme
      });
      const workspaceOwner = await User.create({
        username: 'wsowner',
        email: 'wso@test.com',
        password: 'hashed',
        color: '#0f0'
      });
      const workspace = await Workspace.create({
        name: 'Scope Test',
        slug: 'scope-test',
        ownerId: workspaceOwner._id
      });
      await WorkspaceMember.create([
        { workspaceId: workspace._id, userId: workspaceOwner._id, role: 'owner' },
        { workspaceId: workspace._id, userId: globalAdmin._id, role: 'member' }
      ]);
      workspaceOwner.currentWorkspaceId = workspace._id;
      await workspaceOwner.save();

      const token = jwt.sign({ id: workspaceOwner._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });

      const res = await request(app)
        .get('/api/auth/users')
        .set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);

      const globalAdminInResponse = res.body.find(u => u.username === 'globaladmin');
      expect(globalAdminInResponse).toBeDefined();
      // KĽÚČOVÉ: rola v tomto workspace je 'member', NIE 'admin' (globálna)
      expect(globalAdminInResponse.role).toBe('member');
      expect(globalAdminInResponse.role).not.toBe('admin');

      const ownerInResponse = res.body.find(u => u.username === 'wsowner');
      expect(ownerInResponse.role).toBe('owner');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Notification preferences endpoints — covers GET/PUT contracts
  // including type-strictness (only booleans accepted) and default merge.
  // ─────────────────────────────────────────────────────────────────────
  describe('GET/PUT /api/auth/notification-preferences', () => {
    let user, token;

    beforeEach(async () => {
      user = await User.create({
        username: 'prefsuser',
        email: 'prefs@test.com',
        password: 'hashed'
      });
      token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });
    });

    it('GET vráti všetky 4 toggles s defaultmi false pre nového usera', async () => {
      const res = await request(app)
        .get('/api/auth/notification-preferences')
        .set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        pushTeamActivity: false,
        pushDeadlines: false,
        pushOverdue: false,
        pushNewMember: false
      });
    });

    it('GET 401 bez tokenu', async () => {
      const res = await request(app).get('/api/auth/notification-preferences');
      expect(res.status).toBe(401);
    });

    it('PUT zmení iba uvedený toggle, ostatné ostávajú default', async () => {
      const res = await request(app)
        .put('/api/auth/notification-preferences')
        .set(authHeader(token))
        .send({ pushDeadlines: true });

      expect(res.status).toBe(200);
      expect(res.body.pushDeadlines).toBe(true);
      expect(res.body.pushTeamActivity).toBe(false);
      expect(res.body.pushOverdue).toBe(false);
      expect(res.body.pushNewMember).toBe(false);

      // Persisted to DB
      const fresh = await User.findById(user._id);
      expect(fresh.notificationPreferences.pushDeadlines).toBe(true);
    });

    it('PUT ignoruje neplatné kľúče (whitelist)', async () => {
      const res = await request(app)
        .put('/api/auth/notification-preferences')
        .set(authHeader(token))
        .send({ pushDeadlines: true, unknownKey: true, isAdmin: true });

      expect(res.status).toBe(200);
      expect(res.body.pushDeadlines).toBe(true);
      expect(res.body).not.toHaveProperty('unknownKey');
      expect(res.body).not.toHaveProperty('isAdmin');

      const fresh = await User.findById(user._id);
      expect(fresh.notificationPreferences.unknownKey).toBeUndefined();
      // Critical: PUT MUST NOT escalate role / set arbitrary fields
      expect(fresh.role).not.toBe('admin');
    });

    it('PUT odmietne non-boolean hodnoty (strict typing)', async () => {
      // String "true" — ignored, no valid keys → 400
      const res = await request(app)
        .put('/api/auth/notification-preferences')
        .set(authHeader(token))
        .send({ pushDeadlines: 'true', pushTeamActivity: 1 });

      expect(res.status).toBe(400);
    });

    it('PUT 400 ak body je úplne prázdne / neplatné', async () => {
      const res = await request(app)
        .put('/api/auth/notification-preferences')
        .set(authHeader(token))
        .send({});

      expect(res.status).toBe(400);
    });

    it('PUT zachová predošlé hodnoty (partial update)', async () => {
      // First set both
      await request(app)
        .put('/api/auth/notification-preferences')
        .set(authHeader(token))
        .send({ pushDeadlines: true, pushTeamActivity: true });

      // Then update only one — the other must persist
      const res = await request(app)
        .put('/api/auth/notification-preferences')
        .set(authHeader(token))
        .send({ pushDeadlines: false });

      expect(res.status).toBe(200);
      expect(res.body.pushDeadlines).toBe(false);
      expect(res.body.pushTeamActivity).toBe(true); // preserved
    });
  });
});
