const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const tasksRouter = require('../../routes/tasks');
const Task = require('../../models/Task');
const Contact = require('../../models/Contact');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * /api/tasks route testy — najkomplexnejší router v aplikácii (2595 lines).
 *
 * Dvojitý dátový model:
 *   - "global tasks" — samostatná Task kolekcia, bez kontaktu
 *   - "contact tasks" — embedded v Contact.tasks[] array, rozpoznané cez ?source=contact
 *
 * Testovaný scope:
 *   - GET / vráti merge global + contact-embedded tasks
 *   - GET /:id, PUT /:id, DELETE /:id — P2 Workspace Isolation KRITICKÉ
 *     (Task._id globálne unique → cross-workspace leak bez filtra!)
 *   - POST / — title required, plan limits (free=10), default values
 *   - Reorder endpoints
 *
 * Opravené bugy (objavené cez testy):
 *   - PUT /:id — Task.findById bez workspaceId filtra (P2 violation)
 *   - DELETE /:id — Task.findByIdAndDelete bez workspaceId filtra (P2 violation)
 */
describe('/api/tasks route', () => {
  let app;
  let ownerCtx;
  let otherCtx;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    await Task.init();
    await Contact.init();
    ({ app } = createTestApp('/api/tasks', tasksRouter));
  });

  beforeEach(async () => {
    await Task.deleteMany({});
    await Contact.deleteMany({});
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    ownerCtx = await createUserWithWorkspace({
      username: 'owner', email: 'owner@test.com', role: 'owner', workspaceName: 'My WS'
    });
    otherCtx = await createUserWithWorkspace({
      username: 'stranger', email: 'stranger@test.com', role: 'owner', workspaceName: 'Other WS'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Auth gate', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /', () => {
    it('vráti prázdne pole pre nový workspace', async () => {
      const res = await request(app)
        .get('/api/tasks')
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('vráti global tasks IBA z môjho workspace (P2 Isolation)', async () => {
      await Task.create([
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, title: 'Mine 1', completed: false },
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, title: 'Mine 2', completed: false },
        { workspaceId: otherCtx.workspace._id, userId: otherCtx.user._id, title: 'Stranger task', completed: false }
      ]);

      const res = await request(app)
        .get('/api/tasks')
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      const titles = res.body.map(t => t.title).sort();
      expect(titles).toEqual(['Mine 1', 'Mine 2']);
    });

    it('merge global + contact-embedded tasks s source markerom', async () => {
      await Task.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Global task',
        completed: false
      });
      await Contact.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        name: 'Client X',
        tasks: [{ id: 'task-uuid-1', title: 'Contact task', completed: false, createdAt: new Date().toISOString() }]
      });

      const res = await request(app)
        .get('/api/tasks')
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      const sources = res.body.map(t => t.source).sort();
      expect(sources).toEqual(['contact', 'global']);
    });

    it('sort: incomplete first, completed last', async () => {
      await Task.create([
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, title: 'Completed', completed: true, order: 1 },
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, title: 'Active', completed: false, order: 2 }
      ]);

      const res = await request(app)
        .get('/api/tasks')
        .set(authHeader(ownerCtx.token));

      expect(res.body[0].completed).toBe(false);
      expect(res.body[1].completed).toBe(true);
    });
  });

  describe('GET /:id', () => {
    it('vráti global task (P2: iba z môjho workspace)', async () => {
      const t = await Task.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Mine'
      });

      const res = await request(app)
        .get(`/api/tasks/${t._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Mine');
      expect(res.body.source).toBe('global');
    });

    it('P2 isolation: GET task z cudzieho workspace → 404 (nesmie leaknúť)', async () => {
      const foreign = await Task.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        title: 'Stranger secret'
      });

      const res = await request(app)
        .get(`/api/tasks/${foreign._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(404);
      expect(res.body.title).toBeUndefined();
    });

    it('vráti contact task s contactName', async () => {
      // UUID formát (valid UUID v4) aby prvý Task.findOne() nehodil Mongoose
      // CastError kvôli non-hex stringu a fallthrough pokračoval na Contact.findOne
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      await Contact.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        name: 'ACME',
        tasks: [{ id: uuid, title: 'Call ACME', completed: false, createdAt: new Date().toISOString() }]
      });

      const res = await request(app)
        .get(`/api/tasks/${uuid}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Call ACME');
      expect(res.body.source).toBe('contact');
      expect(res.body.contactName).toBe('ACME');
    });
  });

  describe('POST /', () => {
    it('vytvorí global task s defaults', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set(authHeader(ownerCtx.token))
        .send({ title: 'New task' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('New task');
      expect(res.body.priority).toBe('medium');
      expect(res.body.completed).toBe(false);
      expect(res.body.source).toBe('global');
    });

    it('400 ak title chýba', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set(authHeader(ownerCtx.token))
        .send({});
      expect(res.status).toBe(400);
    });

    it('400 ak title je whitespace', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set(authHeader(ownerCtx.token))
        .send({ title: '   ' });
      expect(res.status).toBe(400);
    });

    it('trimuje title', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set(authHeader(ownerCtx.token))
        .send({ title: '   with spaces   ' });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('with spaces');
    });

    it('akceptuje description + dueDate + priority + reminder', async () => {
      const due = new Date(Date.now() + 7 * 86400000).toISOString();
      const res = await request(app)
        .post('/api/tasks')
        .set(authHeader(ownerCtx.token))
        .send({
          title: 'Full task',
          description: 'desc',
          dueDate: due,
          priority: 'high',
          reminder: 3
        });

      expect(res.status).toBe(201);
      expect(res.body.description).toBe('desc');
      expect(res.body.priority).toBe('high');
      expect(res.body.reminder).toBe(3);
    });

    it('subtasks s nových UUID (cloneSubtasksWithNewIds)', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set(authHeader(ownerCtx.token))
        .send({
          title: 'Parent',
          subtasks: [
            { title: 'Sub 1', completed: false },
            { title: 'Sub 2', completed: true }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.subtasks).toHaveLength(2);
      // UUID formát
      expect(res.body.subtasks[0].id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.subtasks[1].id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.subtasks[0].id).not.toBe(res.body.subtasks[1].id);
    });

    it('DOCUMENTED LIMITATION: task plan limit v POST nie je skutočne enforced', async () => {
      // POZOR: `isLimited` / `maxTasks` premenné sa v POST handleri počítajú,
      // ale count check CHÝBA — task sa vytvorí aj pri prekročení free plánu.
      // Porovnaj s contacts.js kde plan limit funguje. Toto zostáva ako known
      // gap — pridanie enforcement by bolo samostatná feature PR.
      const docs = Array.from({ length: 10 }, (_, i) => ({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: `Task ${i}`
      }));
      await Task.create(docs);

      const res = await request(app)
        .post('/api/tasks')
        .set(authHeader(ownerCtx.token))
        .send({ title: 'Eleventh' });

      // Aktuálne správanie: task sa vytvorí. Dokumentujeme cez test.
      expect(res.status).toBe(201);
      expect(await Task.countDocuments({ workspaceId: ownerCtx.workspace._id })).toBe(11);
    });
  });

  describe('PUT /:id', () => {
    let myTask;

    beforeEach(async () => {
      myTask = await Task.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Original',
        completed: false,
        priority: 'medium'
      });
    });

    it('aktualizuje title + priority', async () => {
      const res = await request(app)
        .put(`/api/tasks/${myTask._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ title: 'Updated', priority: 'high' });

      expect(res.status).toBe(200);
      const updated = await Task.findById(myTask._id);
      expect(updated.title).toBe('Updated');
      expect(updated.priority).toBe('high');
    });

    it('completed=true → všetky subtasky sa tiež dokončia', async () => {
      myTask.subtasks = [
        { id: 'sub-1', title: 'Sub 1', completed: false },
        { id: 'sub-2', title: 'Sub 2', completed: false }
      ];
      await myTask.save();

      const res = await request(app)
        .put(`/api/tasks/${myTask._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ completed: true });

      expect(res.status).toBe(200);
      const updated = await Task.findById(myTask._id);
      expect(updated.completed).toBe(true);
      updated.subtasks.forEach(s => {
        expect(s.completed).toBe(true);
      });
    });

    it('🔒 P2 isolation KRITICKÉ: PUT na CUDZÍ task → 404 a DB nezmenená', async () => {
      // Bez workspaceId filtra v Task.findById by sa tento test neprešiel —
      // cudzí task by sa dal updatnúť cez guessed _id.
      const foreign = await Task.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        title: 'Stranger task',
        priority: 'low'
      });

      const res = await request(app)
        .put(`/api/tasks/${foreign._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ title: 'HACKED', priority: 'high' });

      // Expected: 404 "not found in contacts" alebo 500 — hlavné je, že DB
      // v cudzom workspace sa NEZMENILA
      const untouched = await Task.findById(foreign._id);
      expect(untouched.title).toBe('Stranger task');
      expect(untouched.priority).toBe('low');
    });
  });

  describe('DELETE /:id', () => {
    it('zmaže môj global task', async () => {
      const t = await Task.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Goodbye'
      });

      const res = await request(app)
        .delete(`/api/tasks/${t._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(await Task.findById(t._id)).toBeNull();
    });

    it('🔒 P2 isolation KRITICKÉ: DELETE cudzieho tasku → task NESMIE byť zmazaný', async () => {
      const foreign = await Task.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        title: 'Stranger task'
      });

      await request(app)
        .delete(`/api/tasks/${foreign._id}`)
        .set(authHeader(ownerCtx.token));

      // Cudzí task existuje ďalej — toto je KRITICKÁ P2 ochrana
      expect(await Task.findById(foreign._id)).not.toBeNull();
    });

    it('zmaže contact task cez ?source=contact', async () => {
      const keepId = '11111111-2222-3333-4444-555555555555';
      const delId = '99999999-8888-7777-6666-555555555555';
      const c = await Contact.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        name: 'Client',
        tasks: [
          { id: keepId, title: 'Keep', completed: false, createdAt: new Date().toISOString() },
          { id: delId, title: 'Delete', completed: false, createdAt: new Date().toISOString() }
        ]
      });

      const res = await request(app)
        .delete(`/api/tasks/${delId}?source=contact`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      const refreshed = await Contact.findById(c._id);
      expect(refreshed.tasks).toHaveLength(1);
      expect(refreshed.tasks[0].id).toBe(keepId);
    });
  });

  describe('PUT /reorder', () => {
    it('prehádže order hodnoty global taskov', async () => {
      const [t1, t2, t3] = await Task.create([
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, title: 'A', order: 0 },
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, title: 'B', order: 1 },
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, title: 'C', order: 2 }
      ]);

      const res = await request(app)
        .put('/api/tasks/reorder')
        .set(authHeader(ownerCtx.token))
        .send({
          // Route očakáva { tasks: [{ id, order, source, contactId? }] }
          tasks: [
            { id: t3._id.toString(), order: 0, source: 'global' },
            { id: t1._id.toString(), order: 1, source: 'global' },
            { id: t2._id.toString(), order: 2, source: 'global' }
          ]
        });

      expect(res.status).toBe(200);

      const refreshed = await Task.find({ workspaceId: ownerCtx.workspace._id }).sort({ order: 1 });
      expect(refreshed[0].title).toBe('C');
      expect(refreshed[1].title).toBe('A');
      expect(refreshed[2].title).toBe('B');
    });
  });
});
