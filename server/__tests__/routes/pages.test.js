// MUSÍ byť prvý require — setne JWT_SECRET pred middleware/auth.js
const { createTestApp, createUserWithWorkspace, addMember, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const pagesRouter = require('../../routes/pages');
const Page = require('../../models/Page');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * /api/pages route integračné testy (supertest + mongodb-memory-server).
 *
 * Pokrývame:
 *   - auth gate (401 bez tokenu)
 *   - workspace gate (400 NO_WORKSPACE ak user nemá currentWorkspaceId)
 *   - P2 Workspace Isolation na HTTP vrstve (GET/PUT/DELETE zo susedného
 *     workspace vráti 404, nie 200 s cudzími dátami)
 *   - input validation (invalid ObjectId → 400)
 *   - kaskádové mazanie subtree (iterative BFS + deleteMany)
 */
describe('/api/pages route', () => {
  let app;
  let ownerCtx; // { user, workspace, token }
  let otherCtx; // iný workspace pre isolation testy

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    await Page.init();
    ({ app } = createTestApp('/api/pages', pagesRouter));
  });

  beforeEach(async () => {
    await Page.deleteMany({});
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    ownerCtx = await createUserWithWorkspace({
      username: 'owner',
      email: 'owner@test.com',
      role: 'owner',
      workspaceName: 'WS Owner'
    });
    otherCtx = await createUserWithWorkspace({
      username: 'stranger',
      email: 'stranger@test.com',
      role: 'owner',
      workspaceName: 'WS Other'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Auth gate', () => {
    it('GET / → 401 bez tokenu', async () => {
      const res = await request(app).get('/api/pages');
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/token/i);
    });

    it('GET / → 401 s invalid tokenom', async () => {
      const res = await request(app)
        .get('/api/pages')
        .set('Authorization', 'Bearer garbage.not.a.jwt');
      expect(res.status).toBe(401);
    });

    it('POST / → 401 bez tokenu', async () => {
      const res = await request(app)
        .post('/api/pages')
        .send({ title: 'X' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /', () => {
    it('vráti prázdne pole ak workspace ešte nemá stránky', async () => {
      const res = await request(app)
        .get('/api/pages')
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('vráti iba stránky z aktívneho workspacu', async () => {
      await Page.create([
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, title: 'Mine 1' },
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, title: 'Mine 2' },
        { workspaceId: otherCtx.workspace._id, userId: otherCtx.user._id, title: 'Stranger' }
      ]);

      const res = await request(app)
        .get('/api/pages')
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const titles = res.body.map(p => p.title).sort();
      expect(titles).toEqual(['Mine 1', 'Mine 2']);
    });
  });

  describe('GET /:id', () => {
    it('vráti 400 pri invalid ObjectId', async () => {
      const res = await request(app)
        .get('/api/pages/not-an-object-id')
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Neplatné ID/);
    });

    it('vráti 404 ak stránka neexistuje', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .get(`/api/pages/${fakeId}`)
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(404);
    });

    it('P2 isolation: GET stránky z CUDZIEHO workspace → 404', async () => {
      const strangerPage = await Page.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        title: 'Secret'
      });

      const res = await request(app)
        .get(`/api/pages/${strangerPage._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(404);
      // KRITICKÉ: nesmieme leaknuť obsah ani metadata cudzej stránky
      expect(res.body.title).toBeUndefined();
    });

    it('vráti 200 + stránku ak patrí môjmu workspace', async () => {
      const p = await Page.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'My page'
      });
      const res = await request(app)
        .get(`/api/pages/${p._id}`)
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('My page');
    });
  });

  describe('POST /', () => {
    it('vytvorí stránku v mojom workspace', async () => {
      const res = await request(app)
        .post('/api/pages')
        .set(authHeader(ownerCtx.token))
        .send({ title: 'New Page', content: 'body', icon: '🚀' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('New Page');
      expect(res.body.workspaceId).toBe(ownerCtx.workspace._id.toString());
      expect(res.body.userId).toBe(ownerCtx.user._id.toString());

      const inDb = await Page.findById(res.body._id);
      expect(inDb).not.toBeNull();
      expect(inDb.workspaceId.toString()).toBe(ownerCtx.workspace._id.toString());
    });

    it('default title="Untitled" ak nie je zadaný', async () => {
      const res = await request(app)
        .post('/api/pages')
        .set(authHeader(ownerCtx.token))
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Untitled');
    });

    it('trimuje title na max 500 znakov', async () => {
      const longTitle = 'A'.repeat(1000);
      const res = await request(app)
        .post('/api/pages')
        .set(authHeader(ownerCtx.token))
        .send({ title: longTitle });
      expect(res.status).toBe(201);
      expect(res.body.title).toHaveLength(500);
    });

    it('trimuje content na max 500 000 znakov', async () => {
      const hugeContent = 'B'.repeat(600000);
      const res = await request(app)
        .post('/api/pages')
        .set(authHeader(ownerCtx.token))
        .send({ title: 'X', content: hugeContent });
      expect(res.status).toBe(201);
      expect(res.body.content).toHaveLength(500000);
    });

    it('P2 isolation: parentId z cudzieho workspace → 404', async () => {
      const strangerPage = await Page.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        title: 'Stranger root'
      });

      const res = await request(app)
        .post('/api/pages')
        .set(authHeader(ownerCtx.token))
        .send({ title: 'Child', parentId: strangerPage._id.toString() });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/Rodič/);
      // Stránka nesmie byť vytvorená
      expect(await Page.countDocuments({ workspaceId: ownerCtx.workspace._id })).toBe(0);
    });

    it('400 pri invalid parentId', async () => {
      const res = await request(app)
        .post('/api/pages')
        .set(authHeader(ownerCtx.token))
        .send({ title: 'X', parentId: 'not-valid' });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /:id', () => {
    it('aktualizuje title + content', async () => {
      const p = await Page.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Old'
      });
      const res = await request(app)
        .put(`/api/pages/${p._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ title: 'New', content: 'updated body' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('New');
      expect(res.body.content).toBe('updated body');
    });

    it('P2 isolation: PUT na cudziu stránku → 404', async () => {
      const strangerPage = await Page.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        title: 'Stranger'
      });

      const res = await request(app)
        .put(`/api/pages/${strangerPage._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ title: 'HACKED' });

      expect(res.status).toBe(404);
      // DB remains untouched
      const untouched = await Page.findById(strangerPage._id);
      expect(untouched.title).toBe('Stranger');
    });

    it('parentId=null resetuje parent', async () => {
      const root = await Page.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Root'
      });
      const child = await Page.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Child',
        parentId: root._id
      });

      const res = await request(app)
        .put(`/api/pages/${child._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ parentId: null });

      expect(res.status).toBe(200);
      expect(res.body.parentId).toBeNull();
    });
  });

  describe('DELETE /:id', () => {
    it('zmaže stránku a celý jej subtree (iterative BFS)', async () => {
      const root = await Page.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Root'
      });
      const child1 = await Page.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Child 1',
        parentId: root._id
      });
      await Page.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Grandchild',
        parentId: child1._id
      });
      // Sibling (ostane)
      const sibling = await Page.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Sibling'
      });

      const res = await request(app)
        .delete(`/api/pages/${root._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      const remaining = await Page.find({ workspaceId: ownerCtx.workspace._id });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]._id.toString()).toBe(sibling._id.toString());
    });

    it('P2 isolation: DELETE cudziu stránku → 404 a nic sa nezmaze', async () => {
      const strangerPage = await Page.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        title: 'Stranger'
      });

      const res = await request(app)
        .delete(`/api/pages/${strangerPage._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(404);
      // Cudzia stránka existuje dalej
      expect(await Page.findById(strangerPage._id)).not.toBeNull();
    });

    it('400 pri invalid ObjectId', async () => {
      const res = await request(app)
        .delete('/api/pages/xyz')
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(400);
    });
  });

  describe('Socket.IO emit', () => {
    it('POST emituje page-created do workspace room', async () => {
      const mockIo = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn()
      };
      const { app: localApp } = createTestApp('/api/pages', pagesRouter, { io: mockIo });

      const res = await request(localApp)
        .post('/api/pages')
        .set(authHeader(ownerCtx.token))
        .send({ title: 'Broadcast' });

      expect(res.status).toBe(201);
      expect(mockIo.to).toHaveBeenCalledWith(`workspace-${ownerCtx.workspace._id}`);
      expect(mockIo.emit).toHaveBeenCalledWith('page-created', expect.objectContaining({ title: 'Broadcast' }));
    });

    it('DELETE emituje page-deleted s pageId', async () => {
      const mockIo = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn()
      };
      const { app: localApp } = createTestApp('/api/pages', pagesRouter, { io: mockIo });

      const p = await Page.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        title: 'Goodbye'
      });

      const res = await request(localApp)
        .delete(`/api/pages/${p._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(mockIo.emit).toHaveBeenCalledWith('page-deleted', { pageId: p._id.toString() });
    });
  });
});
