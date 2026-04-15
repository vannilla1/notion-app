const { createTestApp, createUserWithWorkspace, addMember, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const messagesRouter = require('../../routes/messages');
const Message = require('../../models/Message');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * /api/messages route testy — interné odkazy (approval/info/request/proposal/poll).
 *
 * Kritické invarianty:
 *   - tab filtering: received=toUserId=me, sent=fromUserId=me, all=OR
 *   - P2 Workspace Isolation: cross-workspace message → 404
 *   - Self-send blokovaný (cannot send to self)
 *   - Iba príjemca ALEBO workspace admin môžu approve/reject
 *   - type enum: approval|info|request|proposal|poll
 *   - poll validation: min 2, max 10 options
 *   - status transitions: pending → approved | rejected | commented
 *   - readBy: findOneAndUpdate s $addToSet (idempotent)
 */
describe('/api/messages route', () => {
  let app;
  let senderCtx;
  let recipient;
  let recipientToken;
  let stranger;
  let strangerToken;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    await Message.init();
    ({ app } = createTestApp('/api/messages', messagesRouter));
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    senderCtx = await createUserWithWorkspace({
      username: 'sender',
      email: 'sender@test.com',
      role: 'owner',
      workspaceName: 'Shared WS'
    });
    const recipientCtx = await addMember(senderCtx.workspace._id, {
      username: 'recipient',
      email: 'recipient@test.com',
      role: 'member'
    });
    recipient = recipientCtx.user;
    recipientToken = recipientCtx.token;

    // Stranger vo VLASTNOM workspace (tenant isolation tests)
    const strangerCtx = await createUserWithWorkspace({
      username: 'stranger',
      email: 'stranger@test.com',
      role: 'owner',
      workspaceName: 'Other WS'
    });
    stranger = strangerCtx.user;
    strangerToken = strangerCtx.token;
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('POST /', () => {
    it('vytvorí message (type=info)', async () => {
      const res = await request(app)
        .post('/api/messages')
        .set(authHeader(senderCtx.token))
        .field('toUserId', recipient._id.toString())
        .field('type', 'info')
        .field('subject', 'Informácia')
        .field('description', 'Body');

      expect(res.status).toBe(201);
      expect(res.body.subject).toBe('Informácia');
      expect(res.body.status).toBe('pending');
      expect(res.body.fromUsername).toBe('sender');
      expect(res.body.toUsername).toBe('recipient');
      // Base64 data nie sú v response
      expect(res.body.attachment?.data).toBeUndefined();
    });

    it('400 ak chýba toUserId/type/subject', async () => {
      const r1 = await request(app)
        .post('/api/messages')
        .set(authHeader(senderCtx.token))
        .field('toUserId', recipient._id.toString())
        .field('type', 'info');
      expect(r1.status).toBe(400);
    });

    it('400 pri neznámom type', async () => {
      const res = await request(app)
        .post('/api/messages')
        .set(authHeader(senderCtx.token))
        .field('toUserId', recipient._id.toString())
        .field('type', 'garbage')
        .field('subject', 'x');
      expect(res.status).toBe(400);
    });

    it('BLOKUJE self-send', async () => {
      const res = await request(app)
        .post('/api/messages')
        .set(authHeader(senderCtx.token))
        .field('toUserId', senderCtx.user._id.toString())
        .field('type', 'info')
        .field('subject', 'to myself');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/sami sebe/);
    });

    it('404 ak recipient neexistuje', async () => {
      const fake = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .post('/api/messages')
        .set(authHeader(senderCtx.token))
        .field('toUserId', fake)
        .field('type', 'info')
        .field('subject', 'x');
      expect(res.status).toBe(404);
    });

    it('poll: 400 pri < 2 možnostiach', async () => {
      const res = await request(app)
        .post('/api/messages')
        .set(authHeader(senderCtx.token))
        .field('toUserId', recipient._id.toString())
        .field('type', 'poll')
        .field('subject', 'Poll')
        .field('pollOptions', JSON.stringify(['Only one']));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/2/);
    });

    it('poll: 400 pri > 10 možnostiach', async () => {
      const tooMany = Array.from({ length: 11 }, (_, i) => `Opt ${i}`);
      const res = await request(app)
        .post('/api/messages')
        .set(authHeader(senderCtx.token))
        .field('toUserId', recipient._id.toString())
        .field('type', 'poll')
        .field('subject', 'Poll')
        .field('pollOptions', JSON.stringify(tooMany));
      expect(res.status).toBe(400);
    });

    it('poll: vytvorí message s pollOptions', async () => {
      const res = await request(app)
        .post('/api/messages')
        .set(authHeader(senderCtx.token))
        .field('toUserId', recipient._id.toString())
        .field('type', 'poll')
        .field('subject', 'Kedy?')
        .field('pollOptions', JSON.stringify(['Pondelok', 'Utorok', 'Streda']))
        .field('pollMultipleChoice', 'true');

      expect(res.status).toBe(201);
      expect(res.body.pollOptions).toHaveLength(3);
      expect(res.body.pollMultipleChoice).toBe(true);
    });

    it('trimuje subject na 200 a description na 5000 znakov', async () => {
      const res = await request(app)
        .post('/api/messages')
        .set(authHeader(senderCtx.token))
        .field('toUserId', recipient._id.toString())
        .field('type', 'info')
        .field('subject', 'A'.repeat(300))
        .field('description', 'B'.repeat(6000));

      expect(res.status).toBe(201);
      expect(res.body.subject).toHaveLength(200);
      expect(res.body.description).toHaveLength(5000);
    });
  });

  describe('GET /', () => {
    beforeEach(async () => {
      await Message.create([
        {
          workspaceId: senderCtx.workspace._id,
          fromUserId: senderCtx.user._id,
          fromUsername: 'sender',
          toUserId: recipient._id,
          toUsername: 'recipient',
          type: 'info',
          subject: 'Sender → Recipient',
          status: 'pending'
        },
        {
          workspaceId: senderCtx.workspace._id,
          fromUserId: recipient._id,
          fromUsername: 'recipient',
          toUserId: senderCtx.user._id,
          toUsername: 'sender',
          type: 'info',
          subject: 'Recipient → Sender',
          status: 'pending'
        }
      ]);
    });

    it('default tab=received: iba kde som príjemca', async () => {
      const res = await request(app)
        .get('/api/messages')
        .set(authHeader(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].subject).toBe('Sender → Recipient');
    });

    it('tab=sent: iba kde som autor', async () => {
      const res = await request(app)
        .get('/api/messages?tab=sent')
        .set(authHeader(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].subject).toBe('Recipient → Sender');
    });

    it('tab=all: prijaté + odoslané', async () => {
      const res = await request(app)
        .get('/api/messages?tab=all')
        .set(authHeader(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe('GET /:id', () => {
    let msg;

    beforeEach(async () => {
      msg = await Message.create({
        workspaceId: senderCtx.workspace._id,
        fromUserId: senderCtx.user._id,
        fromUsername: 'sender',
        toUserId: recipient._id,
        toUsername: 'recipient',
        type: 'approval',
        subject: 'Approve this',
        status: 'pending'
      });
    });

    it('vráti message pre príjemcu + readBy sa doplní', async () => {
      const res = await request(app)
        .get(`/api/messages/${msg._id}`)
        .set(authHeader(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body.subject).toBe('Approve this');

      const updated = await Message.findById(msg._id);
      const readByStrings = updated.readBy.map(id => id.toString());
      expect(readByStrings).toContain(recipient._id.toString());
    });

    it('P2 isolation: stranger z iného workspace → 404', async () => {
      const res = await request(app)
        .get(`/api/messages/${msg._id}`)
        .set(authHeader(strangerToken));
      expect(res.status).toBe(404);
    });

    it('400 pri invalid ObjectId', async () => {
      const res = await request(app)
        .get('/api/messages/not-valid')
        .set(authHeader(recipientToken));
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /:id/approve', () => {
    let msg;

    beforeEach(async () => {
      msg = await Message.create({
        workspaceId: senderCtx.workspace._id,
        fromUserId: senderCtx.user._id,
        fromUsername: 'sender',
        toUserId: recipient._id,
        toUsername: 'recipient',
        type: 'approval',
        subject: 'Plz approve',
        status: 'pending'
      });
    });

    it('príjemca MÔŽE schváliť', async () => {
      const res = await request(app)
        .put(`/api/messages/${msg._id}/approve`)
        .set(authHeader(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');

      const updated = await Message.findById(msg._id);
      expect(updated.resolvedBy.toString()).toBe(recipient._id.toString());
      expect(updated.resolvedAt).toBeInstanceOf(Date);
    });

    it('workspace owner MÔŽE schváliť za iného', async () => {
      // sender je owner workspacu → canAdmin=true
      const res = await request(app)
        .put(`/api/messages/${msg._id}/approve`)
        .set(authHeader(senderCtx.token));
      expect(res.status).toBe(200);
    });

    it('3rd user (NOT recipient, NOT admin) → 404', async () => {
      const thirdPartyCtx = await addMember(senderCtx.workspace._id, {
        username: 'bystander',
        email: 'by@test.com',
        role: 'member'
      });

      const res = await request(app)
        .put(`/api/messages/${msg._id}/approve`)
        .set(authHeader(thirdPartyCtx.token));
      expect(res.status).toBe(404);

      // Status zostal pending
      const unchanged = await Message.findById(msg._id);
      expect(unchanged.status).toBe('pending');
    });

    it('už schválený message → 404 (nedá sa approve dvakrát)', async () => {
      msg.status = 'approved';
      await msg.save();

      const res = await request(app)
        .put(`/api/messages/${msg._id}/approve`)
        .set(authHeader(recipientToken));
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /:id/reject', () => {
    let msg;

    beforeEach(async () => {
      msg = await Message.create({
        workspaceId: senderCtx.workspace._id,
        fromUserId: senderCtx.user._id,
        fromUsername: 'sender',
        toUserId: recipient._id,
        toUsername: 'recipient',
        type: 'approval',
        subject: 'Rejection test',
        status: 'pending'
      });
    });

    it('príjemca zamietne + uloží reason', async () => {
      const res = await request(app)
        .put(`/api/messages/${msg._id}/reject`)
        .set(authHeader(recipientToken))
        .send({ reason: 'Rozpočet chýba' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.rejectionReason).toBe('Rozpočet chýba');
    });

    it('trimuje rejectionReason na 1000 znakov', async () => {
      const res = await request(app)
        .put(`/api/messages/${msg._id}/reject`)
        .set(authHeader(recipientToken))
        .send({ reason: 'x'.repeat(2000) });

      expect(res.status).toBe(200);
      expect(res.body.rejectionReason).toHaveLength(1000);
    });
  });

  describe('GET /pending-count', () => {
    it('spočíta pending messages prijaté mnou', async () => {
      await Message.create([
        {
          workspaceId: senderCtx.workspace._id,
          fromUserId: senderCtx.user._id,
          fromUsername: 'sender',
          toUserId: recipient._id,
          toUsername: 'recipient',
          type: 'info',
          subject: 'P1',
          status: 'pending'
        },
        {
          workspaceId: senderCtx.workspace._id,
          fromUserId: senderCtx.user._id,
          fromUsername: 'sender',
          toUserId: recipient._id,
          toUsername: 'recipient',
          type: 'info',
          subject: 'A1',
          status: 'approved'  // nepending
        }
      ]);

      const res = await request(app)
        .get('/api/messages/pending-count')
        .set(authHeader(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
    });

    it('nezapočítava messages už prečítané (readBy)', async () => {
      await Message.create({
        workspaceId: senderCtx.workspace._id,
        fromUserId: senderCtx.user._id,
        fromUsername: 'sender',
        toUserId: recipient._id,
        toUsername: 'recipient',
        type: 'info',
        subject: 'Already read',
        status: 'pending',
        readBy: [recipient._id]
      });

      const res = await request(app)
        .get('/api/messages/pending-count')
        .set(authHeader(recipientToken));
      expect(res.body.count).toBe(0);
    });
  });

  describe('DELETE /:id', () => {
    let msg;

    beforeEach(async () => {
      msg = await Message.create({
        workspaceId: senderCtx.workspace._id,
        fromUserId: senderCtx.user._id,
        fromUsername: 'sender',
        toUserId: recipient._id,
        toUsername: 'recipient',
        type: 'info',
        subject: 'To delete',
        status: 'pending'
      });
    });

    it('sender MÔŽE zmazať', async () => {
      const res = await request(app)
        .delete(`/api/messages/${msg._id}`)
        .set(authHeader(senderCtx.token));
      expect(res.status).toBe(200);
      expect(await Message.findById(msg._id)).toBeNull();
    });

    it('P2 isolation: stranger z iného workspace → 404, message zostane', async () => {
      const res = await request(app)
        .delete(`/api/messages/${msg._id}`)
        .set(authHeader(strangerToken));
      expect(res.status).toBe(404);
      expect(await Message.findById(msg._id)).not.toBeNull();
    });
  });
});
