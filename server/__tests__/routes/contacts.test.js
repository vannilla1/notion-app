const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const contactsRouter = require('../../routes/contacts');
const Contact = require('../../models/Contact');
const ContactFile = require('../../models/ContactFile');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * /api/contacts route testy — core CRM path.
 *
 * Kritické invarianty:
 *   - P2 Workspace Isolation na GET/PUT/DELETE (cross-workspace = 404)
 *   - Validation: email regex, phone regex (číslice + medzery + pomlčky + "+")
 *   - Plan limits: free=5 kontaktov, team=25, pro=∞
 *   - Cascade delete: po zmazaní contactu sa zmažú aj ContactFile dokumenty
 *   - enforceWorkspaceLimits: POST blokovaný keď workspace prekročil member limit
 */
describe('/api/contacts route', () => {
  let app;
  let ownerCtx;
  let otherCtx;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    await Contact.init();
    await ContactFile.init();
    ({ app } = createTestApp('/api/contacts', contactsRouter));
  });

  beforeEach(async () => {
    await ContactFile.deleteMany({});
    await Contact.deleteMany({});
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    ownerCtx = await createUserWithWorkspace({
      username: 'owner', email: 'owner@test.com', role: 'owner', workspaceName: 'WS Owner'
    });
    otherCtx = await createUserWithWorkspace({
      username: 'stranger', email: 'stranger@test.com', role: 'owner', workspaceName: 'WS Other'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Auth gate', () => {
    it('401 bez tokenu', async () => {
      const res = await request(app).get('/api/contacts');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /', () => {
    it('vráti prázdne pole', async () => {
      const res = await request(app)
        .get('/api/contacts')
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toEqual([]);
    });

    it('P2 isolation: vráti IBA kontakty z môjho workspace', async () => {
      await Contact.create([
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, name: 'Mine 1' },
        { workspaceId: ownerCtx.workspace._id, userId: ownerCtx.user._id, name: 'Mine 2' },
        { workspaceId: otherCtx.workspace._id, userId: otherCtx.user._id, name: 'Stranger' }
      ]);

      const res = await request(app)
        .get('/api/contacts')
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const names = res.body.map(c => c.name).sort();
      expect(names).toEqual(['Mine 1', 'Mine 2']);
    });
  });

  describe('GET /:id', () => {
    it('P2 isolation: GET kontaktu z cudzieho workspace → 404', async () => {
      const foreign = await Contact.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        name: 'Secret Corp',
        email: 'secret@corp.com'
      });

      const res = await request(app)
        .get(`/api/contacts/${foreign._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(404);
      // CRITICAL: nesmieme leaknúť meno/email cudzieho kontaktu
      expect(res.body.name).toBeUndefined();
      expect(res.body.email).toBeUndefined();
    });

    it('vráti môj kontakt', async () => {
      const c = await Contact.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        name: 'ACME Inc',
        email: 'hi@acme.com'
      });

      const res = await request(app)
        .get(`/api/contacts/${c._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('ACME Inc');
    });
  });

  describe('POST /', () => {
    it('vytvorí kontakt v mojom workspace', async () => {
      const res = await request(app)
        .post('/api/contacts')
        .set(authHeader(ownerCtx.token))
        .send({
          name: 'New Client',
          email: 'new@client.com',
          phone: '+421 900 123 456',
          company: 'New Co'
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('New Client');
      expect(res.body.workspaceId.toString()).toBe(ownerCtx.workspace._id.toString());

      // Auditované v DB
      const inDb = await Contact.findById(res.body._id);
      expect(inDb).not.toBeNull();
    });

    it('default status="new" ak nie je zadaný', async () => {
      const res = await request(app)
        .post('/api/contacts')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'X' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('new');
    });

    it('400 pri invalid email formáte', async () => {
      const res = await request(app)
        .post('/api/contacts')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'X', email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/email/i);
    });

    it('400 pri invalid phone (obsahuje písmená)', async () => {
      const res = await request(app)
        .post('/api/contacts')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'X', phone: 'call-me-maybe' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Telefón/);
    });

    it('akceptuje medzinárodný formát telefónu s medzerami a +', async () => {
      const res = await request(app)
        .post('/api/contacts')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'X', phone: '+421 905 123 456' });
      expect(res.status).toBe(201);
    });

    it('403 pri prekročení free plánu (5 kontaktov)', async () => {
      // Vytvor 5 existujúcich kontaktov (owner má default free plán)
      const docs = Array.from({ length: 5 }, (_, i) => ({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        name: `Contact ${i}`
      }));
      await Contact.create(docs);

      const res = await request(app)
        .post('/api/contacts')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'Sixth' });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/plán/i);
      expect(await Contact.countDocuments({})).toBe(5); // nepridal sa
    });
  });

  describe('PUT /:id', () => {
    it('aktualizuje email + status', async () => {
      const c = await Contact.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        name: 'Old',
        status: 'new'
      });

      const res = await request(app)
        .put(`/api/contacts/${c._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ email: 'new@email.com', status: 'active' });

      expect(res.status).toBe(200);
      expect(res.body.email).toBe('new@email.com');
      expect(res.body.status).toBe('active');
    });

    it('P2 isolation: PUT na cudzí kontakt → 404, DB nezmenená', async () => {
      const foreign = await Contact.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        name: 'Stranger Corp'
      });

      const res = await request(app)
        .put(`/api/contacts/${foreign._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ name: 'HACKED', email: 'pwned@bad.com' });

      expect(res.status).toBe(404);

      // DB invariant: cudzí kontakt sa nezmenil
      const untouched = await Contact.findById(foreign._id);
      expect(untouched.name).toBe('Stranger Corp');
      // email bol undefined pri create (bez defaultu v schéme), musí zostať undefined
      expect(untouched.email).toBeFalsy();
    });

    it('400 pri invalid email v update', async () => {
      const c = await Contact.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        name: 'X'
      });

      const res = await request(app)
        .put(`/api/contacts/${c._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ email: 'bogus' });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /:id', () => {
    it('zmaže môj kontakt', async () => {
      const c = await Contact.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        name: 'Goodbye'
      });

      const res = await request(app)
        .delete(`/api/contacts/${c._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(200);
      expect(await Contact.findById(c._id)).toBeNull();
    });

    it('P2 isolation: DELETE cudzí kontakt → 404, existuje ďalej', async () => {
      const foreign = await Contact.create({
        workspaceId: otherCtx.workspace._id,
        userId: otherCtx.user._id,
        name: 'Stranger'
      });

      const res = await request(app)
        .delete(`/api/contacts/${foreign._id}`)
        .set(authHeader(ownerCtx.token));

      expect(res.status).toBe(404);
      expect(await Contact.findById(foreign._id)).not.toBeNull();
    });

    it('cascade: po zmazaní kontaktu sa zmažú aj jeho ContactFile dokumenty', async () => {
      const c = await Contact.create({
        workspaceId: ownerCtx.workspace._id,
        userId: ownerCtx.user._id,
        name: 'With files',
        files: [{ fileId: 'f1', name: 'doc.pdf', size: 1234, type: 'application/pdf' }]
      });
      await ContactFile.create([
        { contactId: c._id, fileId: 'f1', data: 'base64-payload' }
      ]);

      const res = await request(app)
        .delete(`/api/contacts/${c._id}`)
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(200);

      const remainingFiles = await ContactFile.find({ contactId: c._id });
      expect(remainingFiles).toHaveLength(0);
    });
  });

  describe('Socket.IO emit', () => {
    it('POST emituje contact-created do workspace room', async () => {
      const mockIo = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn()
      };
      const { app: localApp } = createTestApp('/api/contacts', contactsRouter, { io: mockIo });

      const res = await request(localApp)
        .post('/api/contacts')
        .set(authHeader(ownerCtx.token))
        .send({ name: 'Broadcast Test' });

      expect(res.status).toBe(201);
      expect(mockIo.to).toHaveBeenCalledWith(`workspace-${ownerCtx.workspace._id}`);
      expect(mockIo.emit).toHaveBeenCalledWith(
        'contact-created',
        expect.objectContaining({ name: 'Broadcast Test' })
      );
    });
  });
});
