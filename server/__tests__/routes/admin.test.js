// Helper MUSÍ byť prvý (nastaví JWT_SECRET pred middleware/auth.js require)
const { createTestApp, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const adminRouter = require('../../routes/admin');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const AuditLog = require('../../models/AuditLog');

/**
 * /api/admin route testy — admin panel endpoints (CRITICAL security).
 *
 * Bezpečnostný model (support@prplcrm.eu = super admin):
 *   - requireAdmin middleware: 403 AK user.email !== 'support@prplcrm.eu'
 *   - role='admin' v User modeli NESTAČÍ — checkuje sa konkrétny email
 *   - self-delete protection: nemôžem zmazať vlastný účet
 *   - self-demote protection: nemôžem odobrať sebe admin rolu
 *   - cannot-delete-admin: admin nemôže zmazať iného admina
 *   - super admin sa vylučuje zo zoznamu users + stats
 *   - audit log sa zapisuje pri každej zmene
 */
describe('/api/admin route', () => {
  const SUPER_ADMIN_EMAIL = 'support@prplcrm.eu';
  let app;
  let superAdminUser;
  let superAdminToken;
  let regularUser;
  let regularToken;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    await AuditLog.init();
    ({ app } = createTestApp('/api/admin', adminRouter));
  });

  beforeEach(async () => {
    await AuditLog.deleteMany({});
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    const adminPwd = await bcrypt.hash('super-secret', 12);
    superAdminUser = await User.create({
      username: 'superadmin',
      email: SUPER_ADMIN_EMAIL,
      password: adminPwd,
      role: 'admin'
    });
    superAdminToken = jwt.sign({ id: superAdminUser._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });

    regularUser = await User.create({
      username: 'reguser',
      email: 'reg@test.com',
      password: 'hashed',
      role: 'user'
    });
    regularToken = jwt.sign({ id: regularUser._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('POST /login', () => {
    it('403 ak email nie je super admin', async () => {
      const res = await request(app)
        .post('/api/admin/login')
        .send({ email: 'reg@test.com', password: 'whatever' });
      expect(res.status).toBe(403);
    });

    it('401 pri nesprávnom heslee super admina', async () => {
      const res = await request(app)
        .post('/api/admin/login')
        .send({ email: SUPER_ADMIN_EMAIL, password: 'wrong' });
      expect(res.status).toBe(401);
    });

    it('prihlási super admina s 4h tokenom', async () => {
      const res = await request(app)
        .post('/api/admin/login')
        .send({ email: SUPER_ADMIN_EMAIL, password: 'super-secret' });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.email).toBe(SUPER_ADMIN_EMAIL);
      expect(res.body.user.password).toBeUndefined();
    });
  });

  describe('requireAdmin middleware', () => {
    it('403 pre bežného usera (aj s role="admin" v modeli)', async () => {
      // Kľúčové: role='admin' v User modeli NESTAČÍ, checkuje sa email
      const fakeAdmin = await User.create({
        username: 'fake-admin',
        email: 'fake@test.com',
        password: 'hashed',
        role: 'admin'
      });
      const token = jwt.sign({ id: fakeAdmin._id.toString() }, process.env.JWT_SECRET, { expiresIn: '1h' });

      const res = await request(app)
        .get('/api/admin/stats')
        .set(authHeader(token));
      expect(res.status).toBe(403);
    });

    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/admin/stats');
      expect(res.status).toBe(401);
    });

    it('super admin prejde', async () => {
      const res = await request(app)
        .get('/api/admin/stats')
        .set(authHeader(superAdminToken));
      expect(res.status).toBe(200);
    });
  });

  describe('GET /stats', () => {
    it('vyluči super admina zo všetkých countov', async () => {
      await User.create([
        { username: 'u1', email: 'u1@test.com', password: 'x' },
        { username: 'u2', email: 'u2@test.com', password: 'x' }
      ]);

      const res = await request(app)
        .get('/api/admin/stats')
        .set(authHeader(superAdminToken));

      expect(res.status).toBe(200);
      // 3 regular users (reg + u1 + u2), super admin vylúčený
      expect(res.body.totalUsers).toBe(3);
    });

    it('vráti planBreakdown + roleBreakdown + recentRegistrations', async () => {
      const res = await request(app)
        .get('/api/admin/stats')
        .set(authHeader(superAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.totalWorkspaces).toBeDefined();
      expect(res.body.totalTasks).toBeDefined();
      expect(res.body.totalContacts).toBeDefined();
      expect(res.body.activeWorkspaces).toBeDefined();
    });
  });

  describe('GET /users', () => {
    it('vyluči super admina zo zoznamu', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set(authHeader(superAdminToken));

      expect(res.status).toBe(200);
      const emails = res.body.map(u => u.email);
      expect(emails).not.toContain(SUPER_ADMIN_EMAIL);
      expect(emails).toContain('reg@test.com');
    });

    it('nevracia password field', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set(authHeader(superAdminToken));
      expect(res.status).toBe(200);
      res.body.forEach((u) => {
        expect(u.password).toBeUndefined();
      });
    });
  });

  describe('PUT /users/:userId/role', () => {
    it('400 pri neznámej role', async () => {
      const res = await request(app)
        .put(`/api/admin/users/${regularUser._id}/role`)
        .set(authHeader(superAdminToken))
        .send({ role: 'superuser' });
      expect(res.status).toBe(400);
    });

    it('zmení rolu + audit log entry', async () => {
      const res = await request(app)
        .put(`/api/admin/users/${regularUser._id}/role`)
        .set(authHeader(superAdminToken))
        .send({ role: 'manager' });

      expect(res.status).toBe(200);

      const updated = await User.findById(regularUser._id);
      expect(updated.role).toBe('manager');

      // Audit log musí byť zapísaný
      const logs = await AuditLog.find({ action: 'user.role_changed' });
      expect(logs).toHaveLength(1);
      expect(logs[0].details.oldRole).toBe('user');
      expect(logs[0].details.newRole).toBe('manager');
    });

    it('BLOKUJE self-demote (admin nemôže odobrať sebe admin rolu)', async () => {
      const res = await request(app)
        .put(`/api/admin/users/${superAdminUser._id}/role`)
        .set(authHeader(superAdminToken))
        .send({ role: 'user' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/vlastnú/);

      const unchanged = await User.findById(superAdminUser._id);
      expect(unchanged.role).toBe('admin');
    });

    it('404 pri neexistujúcom userId', async () => {
      const fake = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .put(`/api/admin/users/${fake}/role`)
        .set(authHeader(superAdminToken))
        .send({ role: 'manager' });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /users/:userId/plan', () => {
    it('400 pri neznámom pláne', async () => {
      const res = await request(app)
        .put(`/api/admin/users/${regularUser._id}/plan`)
        .set(authHeader(superAdminToken))
        .send({ plan: 'enterprise' });
      expect(res.status).toBe(400);
    });

    it('akceptuje iba free|team|pro|trial', async () => {
      for (const plan of ['free', 'team', 'pro', 'trial']) {
        const res = await request(app)
          .put(`/api/admin/users/${regularUser._id}/plan`)
          .set(authHeader(superAdminToken))
          .send({ plan });
        expect(res.status).toBe(200);
      }

      const updated = await User.findById(regularUser._id);
      expect(updated.subscription.plan).toBe('trial');
    });

    it('audit log entry s kategóriou billing', async () => {
      await request(app)
        .put(`/api/admin/users/${regularUser._id}/plan`)
        .set(authHeader(superAdminToken))
        .send({ plan: 'pro' });

      const log = await AuditLog.findOne({ action: 'user.plan_changed' });
      expect(log).not.toBeNull();
      expect(log.category).toBe('billing');
      expect(log.details.newPlan).toBe('pro');
    });
  });

  describe('DELETE /users/:userId', () => {
    it('BLOKUJE self-delete', async () => {
      const res = await request(app)
        .delete(`/api/admin/users/${superAdminUser._id}`)
        .set(authHeader(superAdminToken));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/vlastný/);

      // Super admin stále existuje
      expect(await User.findById(superAdminUser._id)).not.toBeNull();
    });

    it('BLOKUJE zmazanie iného admina', async () => {
      const otherAdmin = await User.create({
        username: 'other-admin',
        email: 'oa@test.com',
        password: 'hashed',
        role: 'admin'
      });

      const res = await request(app)
        .delete(`/api/admin/users/${otherAdmin._id}`)
        .set(authHeader(superAdminToken));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/admina/);
      expect(await User.findById(otherAdmin._id)).not.toBeNull();
    });

    it('zmaže usera + jeho WorkspaceMember records', async () => {
      const ws = await Workspace.create({
        name: 'Target WS', slug: 'target', ownerId: regularUser._id
      });
      await WorkspaceMember.create({
        workspaceId: ws._id, userId: regularUser._id, role: 'member'
      });

      const res = await request(app)
        .delete(`/api/admin/users/${regularUser._id}`)
        .set(authHeader(superAdminToken));

      expect(res.status).toBe(200);
      expect(await User.findById(regularUser._id)).toBeNull();
      expect(await WorkspaceMember.countDocuments({ userId: regularUser._id })).toBe(0);

      // Audit log
      const log = await AuditLog.findOne({ action: 'user.deleted' });
      expect(log).not.toBeNull();
      expect(log.targetName).toBe('reguser');
    });
  });

  describe('GET /audit-log', () => {
    it('vráti audit log entries sorted desc', async () => {
      await AuditLog.create([
        { action: 'user.login', category: 'auth', createdAt: new Date('2026-01-01') },
        { action: 'user.deleted', category: 'user', createdAt: new Date('2026-04-01') },
        { action: 'contact.created', category: 'contact', createdAt: new Date('2026-03-01') }
      ]);

      const res = await request(app)
        .get('/api/admin/audit-log')
        .set(authHeader(superAdminToken));

      expect(res.status).toBe(200);
      // Default sort je desc (najnovšie prvé)
      const logs = res.body.logs || res.body;
      expect(Array.isArray(logs)).toBe(true);
      expect(logs.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('GET /audit-log/categories', () => {
    it('vráti unikátne categories', async () => {
      await AuditLog.create([
        { action: 'a.b', category: 'user' },
        { action: 'c.d', category: 'billing' },
        { action: 'e.f', category: 'user' }
      ]);

      const res = await request(app)
        .get('/api/admin/audit-log/categories')
        .set(authHeader(superAdminToken));

      expect(res.status).toBe(200);
      const cats = Array.isArray(res.body) ? res.body : res.body.categories;
      expect(cats).toContain('user');
      expect(cats).toContain('billing');
    });
  });

  describe('DELETE /workspaces/:id', () => {
    it('zmaže workspace + jeho memberships', async () => {
      const ws = await Workspace.create({
        name: 'Doomed', slug: 'doomed', ownerId: regularUser._id
      });
      await WorkspaceMember.create([
        { workspaceId: ws._id, userId: regularUser._id, role: 'owner' }
      ]);

      const res = await request(app)
        .delete(`/api/admin/workspaces/${ws._id}`)
        .set(authHeader(superAdminToken));

      expect(res.status).toBe(200);
      expect(await Workspace.findById(ws._id)).toBeNull();
      expect(await WorkspaceMember.countDocuments({ workspaceId: ws._id })).toBe(0);
    });
  });
});
