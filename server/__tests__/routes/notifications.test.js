const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const notificationsRouter = require('../../routes/notifications');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * /api/notifications route testy.
 *
 * Krítické invarianty:
 *   - Tenant isolation: user nikdy nevidí cudzie notifikácie (filter aj po userId
 *     aj po workspaceId; findOneAndUpdate použí oba v query)
 *   - Section regex: contact.* → crm, task.*|subtask.* → tasks, message.* → messages
 *   - read-all modifies iba môj aktívny workspace (nie všetky workspaces)
 *   - pagination clamp: limit [1..100], offset >= 0
 */
describe('/api/notifications route', () => {
  let app;
  let ctx;
  let otherCtx;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    await Notification.init();
    ({ app } = createTestApp('/api/notifications', notificationsRouter));
  });

  beforeEach(async () => {
    await Notification.deleteMany({});
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    ctx = await createUserWithWorkspace({
      username: 'me',
      email: 'me@test.com',
      role: 'owner',
      workspaceName: 'My WS'
    });
    otherCtx = await createUserWithWorkspace({
      username: 'other',
      email: 'other@test.com',
      role: 'owner',
      workspaceName: 'Other WS'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Auth gate', () => {
    it('GET / → 401 bez tokenu', async () => {
      const res = await request(app).get('/api/notifications');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /', () => {
    it('vráti prázdny feed + counters', async () => {
      const res = await request(app)
        .get('/api/notifications')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(res.body.notifications).toEqual([]);
      expect(res.body.total).toBe(0);
      expect(res.body.unreadCount).toBe(0);
    });

    it('vráti iba moje notifikácie z aktívneho workspacu', async () => {
      await Notification.create([
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'A', message: 'a' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'B', message: 'b' },
        // iný workspace
        { userId: ctx.user._id, workspaceId: otherCtx.workspace._id, type: 'task.created', title: 'Other', message: 'x' },
        // iný user
        { userId: otherCtx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'Stranger', message: 'x' }
      ]);

      const res = await request(app)
        .get('/api/notifications')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      expect(res.body.notifications).toHaveLength(2);
      const titles = res.body.notifications.map(n => n.title).sort();
      expect(titles).toEqual(['A', 'B']);
    });

    it('unreadOnly=true filter', async () => {
      await Notification.create([
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'Read', message: 'x', read: true },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'Unread', message: 'x' }
      ]);

      const res = await request(app)
        .get('/api/notifications?unreadOnly=true')
        .set(authHeader(ctx.token));

      expect(res.status).toBe(200);
      expect(res.body.notifications).toHaveLength(1);
      expect(res.body.notifications[0].title).toBe('Unread');
    });

    it('clamp limit to [1..100]', async () => {
      const docs = Array.from({ length: 10 }, (_, i) => ({
        userId: ctx.user._id,
        workspaceId: ctx.workspace._id,
        type: 'task.created',
        title: `n${i}`,
        message: 'x'
      }));
      await Notification.create(docs);

      const res = await request(app)
        .get('/api/notifications?limit=99999')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(res.body.notifications.length).toBeLessThanOrEqual(100);
    });
  });

  describe('GET /unread-count', () => {
    it('spočíta iba moje unread v aktívnom workspace', async () => {
      await Notification.create([
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 't', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 't', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'r', message: 'x', read: true },
        { userId: ctx.user._id, workspaceId: otherCtx.workspace._id, type: 'task.created', title: 'other', message: 'x' }
      ]);

      const res = await request(app)
        .get('/api/notifications/unread-count')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
    });
  });

  describe('GET /unread-by-workspace', () => {
    it('zoskupí unread count podľa workspaceId', async () => {
      await Notification.create([
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'a', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'b', message: 'x' },
        { userId: ctx.user._id, workspaceId: otherCtx.workspace._id, type: 'task.created', title: 'c', message: 'x' }
      ]);

      const res = await request(app)
        .get('/api/notifications/unread-by-workspace')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(res.body[ctx.workspace._id.toString()]).toBe(2);
      expect(res.body[otherCtx.workspace._id.toString()]).toBe(1);
    });
  });

  describe('GET /unread-by-section', () => {
    it('správne classifikuje contact.* / task.* / subtask.* / message.*', async () => {
      await Notification.create([
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'contact.created', title: 'c', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'contact.updated', title: 'c', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 't', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'subtask.completed', title: 's', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'message.created', title: 'm', message: 'x' }
      ]);

      const res = await request(app)
        .get('/api/notifications/unread-by-section')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ crm: 2, tasks: 2, messages: 1 });
    });
  });

  describe('PUT /read-by-section/:section', () => {
    it('označí iba crm sekciu', async () => {
      await Notification.create([
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'contact.created', title: 'c', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 't', message: 'x' }
      ]);

      const res = await request(app)
        .put('/api/notifications/read-by-section/crm')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(res.body.modified).toBe(1);

      const taskStillUnread = await Notification.findOne({ type: 'task.created', read: false });
      expect(taskStillUnread).not.toBeNull();
    });

    it('400 pri unknown sekcii', async () => {
      const res = await request(app)
        .put('/api/notifications/read-by-section/junk')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /:id/read', () => {
    it('označí moju notifikáciu', async () => {
      const n = await Notification.create({
        userId: ctx.user._id, workspaceId: ctx.workspace._id,
        type: 'task.created', title: 't', message: 'x'
      });
      const res = await request(app)
        .put(`/api/notifications/${n._id}/read`)
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);

      const updated = await Notification.findById(n._id);
      expect(updated.read).toBe(true);
    });

    it('CUDZIU notifikáciu → 404 (nesmie prejsť cez userId guard)', async () => {
      const n = await Notification.create({
        userId: otherCtx.user._id, workspaceId: otherCtx.workspace._id,
        type: 'task.created', title: 'secret', message: 'x'
      });

      const res = await request(app)
        .put(`/api/notifications/${n._id}/read`)
        .set(authHeader(ctx.token));
      expect(res.status).toBe(404);

      // DB nezmenená
      const untouched = await Notification.findById(n._id);
      expect(untouched.read).toBe(false);
    });

    it('400 invalid ObjectId', async () => {
      const res = await request(app)
        .put('/api/notifications/not-hex/read')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /read-all', () => {
    it('označí iba môj aktívny workspace', async () => {
      await Notification.create([
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'a', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'b', message: 'x' },
        { userId: ctx.user._id, workspaceId: otherCtx.workspace._id, type: 'task.created', title: 'other-ws', message: 'x' }
      ]);

      const res = await request(app)
        .put('/api/notifications/read-all')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(res.body.modified).toBe(2);

      // Notifikácia v inom workspace zostala unread
      const otherUnread = await Notification.countDocuments({
        workspaceId: otherCtx.workspace._id, read: false
      });
      expect(otherUnread).toBe(1);
    });
  });

  describe('DELETE /:id', () => {
    it('zmaže moju notifikáciu', async () => {
      const n = await Notification.create({
        userId: ctx.user._id, workspaceId: ctx.workspace._id,
        type: 'task.created', title: 't', message: 'x'
      });
      const res = await request(app)
        .delete(`/api/notifications/${n._id}`)
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(await Notification.findById(n._id)).toBeNull();
    });

    it('CUDZIU notifikáciu → 404 (nesmie zmazať)', async () => {
      const n = await Notification.create({
        userId: otherCtx.user._id, workspaceId: otherCtx.workspace._id,
        type: 'task.created', title: 'secret', message: 'x'
      });
      const res = await request(app)
        .delete(`/api/notifications/${n._id}`)
        .set(authHeader(ctx.token));
      expect(res.status).toBe(404);
      expect(await Notification.findById(n._id)).not.toBeNull();
    });
  });

  describe('DELETE /', () => {
    it('zmaže všetky v aktívnom workspace, ostatné zostanú', async () => {
      await Notification.create([
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'a', message: 'x' },
        { userId: ctx.user._id, workspaceId: ctx.workspace._id, type: 'task.created', title: 'b', message: 'x' },
        { userId: ctx.user._id, workspaceId: otherCtx.workspace._id, type: 'task.created', title: 'other', message: 'x' }
      ]);

      const res = await request(app)
        .delete('/api/notifications')
        .set(authHeader(ctx.token));
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(2);

      expect(await Notification.countDocuments({})).toBe(1);
      expect(await Notification.countDocuments({ workspaceId: otherCtx.workspace._id })).toBe(1);
    });
  });
});
