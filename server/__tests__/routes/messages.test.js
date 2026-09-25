// recordError (Diagnostika) mockneme — testy overujú, ČO sa do Diagnostiky
// posiela (a čo nie: obsah správy), bez zápisu do ServerError kolekcie.
jest.mock('../../services/serverErrorService', () => {
  const actual = jest.requireActual('../../services/serverErrorService');
  return { ...actual, recordError: jest.fn(() => Promise.resolve()) };
});

const { createTestApp, createUserWithWorkspace, addMember, authHeader } = require('../helpers/testApp');
const { recordError } = require('../../services/serverErrorService');
const logger = require('../../utils/logger');
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

  /**
   * Prílohy správ — base64 v jednom Mongo dokumente (16 MB BSON strop).
   *
   * Invarianty:
   *   - súčet príloh (files + legacy attachment + prílohy komentárov) sa
   *     stráži PRED zápisom → 413 MESSAGE_ATTACHMENTS_TOO_LARGE, nie 500
   *   - Mongo „dokument > 16 MB" (10334) → rovnaká 413 (poistka)
   *   - blocklist ako kontakty/úlohy (HEIC, ODT prejdú), videá a .exe nie
   *   - UTF-8 názvy súborov sa neukladajú rozbité (multer ich dekóduje ako latin1)
   *   - download VŽDY Content-Disposition: attachment + nosniff
   *   - vymenená legacy príloha má novú verziu (URL ?v= aj ETag)
   *   - do Diagnostiky ide príčina chyby, ale NIKDY obsah správy
   */
  describe('prílohy', () => {
    const MB = 1024 * 1024;
    const meta = (size, extra = {}) => ({
      id: new mongoose.Types.ObjectId().toString(),
      originalName: 'foto.jpg',
      mimetype: 'image/jpeg',
      size,
      data: 'eA==',
      uploadedAt: new Date(),
      ...extra
    });
    const makeMessage = (extra = {}) => Message.create({
      workspaceId: senderCtx.workspace._id,
      fromUserId: senderCtx.user._id,
      fromUsername: 'sender',
      toUserId: recipient._id,
      toUsername: 'recipient',
      type: 'info',
      subject: 'Prílohy',
      status: 'pending',
      ...extra
    });
    const binaryParser = (res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const addFile = (msgId, buffer, filename, contentType, token = senderCtx.token) =>
      request(app)
        .post(`/api/messages/${msgId}/files`)
        .set(authHeader(token))
        .attach('file', buffer, { filename, contentType });

    beforeEach(() => {
      recordError.mockClear();
    });

    describe('16 MB strop dokumentu', () => {
      it('POST /:id/files: súčet by prekročil limit → 413 MESSAGE_ATTACHMENTS_TOO_LARGE, nič sa neuloží', async () => {
        const msg = await makeMessage({ files: [meta(5 * MB), meta(5 * MB)] });
        const res = await addFile(msg._id, Buffer.alloc(2 * MB, 1), 'tretia.jpg', 'image/jpeg');

        expect(res.status).toBe(413);
        expect(res.body.code).toBe('MESSAGE_ATTACHMENTS_TOO_LARGE');
        expect(res.body.message).toMatch(/novej správy alebo k úlohe/);
        expect((await Message.findById(msg._id)).files).toHaveLength(2);
        expect(recordError).not.toHaveBeenCalled();
      });

      it('POST /:id/files: pod limitom prejde', async () => {
        const msg = await makeMessage({ files: [meta(5 * MB), meta(5 * MB)] });
        const res = await addFile(msg._id, Buffer.alloc(1 * MB, 1), 'mala.jpg', 'image/jpeg');
        expect(res.status).toBe(200);
        expect(res.body.files).toHaveLength(3);
      });

      it('do limitu sa rátajú aj legacy príloha a prílohy komentárov', async () => {
        const msg = await makeMessage({
          attachment: meta(4 * MB),
          comments: [{ userId: recipient._id, username: 'recipient', text: 'x', attachment: meta(4 * MB) }],
          files: [meta(2 * MB)]
        });
        const res = await addFile(msg._id, Buffer.alloc(2 * MB, 1), 'dalsia.jpg', 'image/jpeg');
        expect(res.status).toBe(413);
        expect(res.body.code).toBe('MESSAGE_ATTACHMENTS_TOO_LARGE');
      });

      it('POST /:id/comment s prílohou nad limit → 413, komentár sa nepridá; textový komentár prejde', async () => {
        const msg = await makeMessage({ files: [meta(5 * MB), meta(5 * MB)] });
        const res = await request(app)
          .post(`/api/messages/${msg._id}/comment`)
          .set(authHeader(recipientToken))
          .field('text', 'Posielam fotku')
          .attach('attachment', Buffer.alloc(2 * MB, 1), { filename: 'foto.jpg', contentType: 'image/jpeg' });
        expect(res.status).toBe(413);
        expect(res.body.code).toBe('MESSAGE_ATTACHMENTS_TOO_LARGE');
        expect((await Message.findById(msg._id)).comments).toHaveLength(0);

        const textOnly = await request(app)
          .post(`/api/messages/${msg._id}/comment`)
          .set(authHeader(recipientToken))
          .field('text', 'Len text');
        expect(textOnly.status).toBe(200);
        expect(textOnly.body.comments).toHaveLength(1);
      });

      it('PUT /:id: nahrádzaná legacy príloha sa do odhadu neráta, nová nad limit → 413', async () => {
        const ok = await makeMessage({ attachment: meta(10 * MB), files: [meta(4 * MB)] });
        const r1 = await request(app)
          .put(`/api/messages/${ok._id}`)
          .set(authHeader(senderCtx.token))
          .attach('attachment', Buffer.alloc(2 * MB, 1), { filename: 'nova.pdf', contentType: 'application/pdf' });
        expect(r1.status).toBe(200);
        expect(r1.body.attachment.originalName).toBe('nova.pdf');

        const full = await makeMessage({ files: [meta(5 * MB), meta(5 * MB)] });
        const r2 = await request(app)
          .put(`/api/messages/${full._id}`)
          .set(authHeader(senderCtx.token))
          .attach('attachment', Buffer.alloc(2 * MB, 1), { filename: 'nova.pdf', contentType: 'application/pdf' });
        expect(r2.status).toBe(413);
        expect(r2.body.code).toBe('MESSAGE_ATTACHMENTS_TOO_LARGE');
      });

      it('poistka: Mongo „dokument > 16 MB" (odhad z metadát nesedí) → 413, nie 500', async () => {
        // size v metadátach je malý (odhad prejde), ale reálne base64 dáta
        // majú 2 × 6,5 MB → push ďalších ~3,3 MB zhodí update v Mongo (10334).
        const big = 'A'.repeat(Math.round(6.5 * MB));
        const msg = await makeMessage({ files: [meta(1, { data: big }), meta(1, { data: big })] });
        const warnSpy = jest.spyOn(logger, 'warn');
        let res;
        try {
          res = await addFile(msg._id, Buffer.alloc(Math.round(2.5 * MB), 1), 'foto.jpg', 'image/jpeg');
          // Overí, že 413 prišla z mapovania Mongo chyby, nie z odhadu.
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringMatching(/document too large/),
            expect.objectContaining({ mongoCode: 10334 })
          );
        } finally {
          warnSpy.mockRestore();
        }

        expect(res.status).toBe(413);
        expect(res.body.code).toBe('MESSAGE_ATTACHMENTS_TOO_LARGE');
        expect(recordError).not.toHaveBeenCalled();
        const reloaded = await Message.findById(msg._id, { 'files.id': 1 }).lean();
        expect(reloaded.files).toHaveLength(2);
      });

      it('iná chyba zápisu → 500 + recordError so skutočnou príčinou, ale BEZ obsahu správy', async () => {
        const msg = await makeMessage();
        const spy = jest.spyOn(Message, 'updateOne').mockRejectedValueOnce(new Error('connection reset'));
        try {
          const res = await request(app)
            .post(`/api/messages/${msg._id}/comment`)
            .set(authHeader(recipientToken))
            .field('text', 'Tajný obsah komentára')
            .attach('attachment', Buffer.from('abc'), { filename: 'zmluva klienta.pdf', contentType: 'application/pdf' });
          expect(res.status).toBe(500);
        } finally {
          spy.mockRestore();
        }
        expect(recordError).toHaveBeenCalledTimes(1);
        const [err, diagReq] = recordError.mock.calls[0];
        expect(err.message).toBe('connection reset');
        expect(diagReq.method).toBe('POST');
        expect(diagReq.body).toEqual({ fileSize: 3, mimetype: 'application/pdf' });
        expect(JSON.stringify(diagReq.body)).not.toMatch(/Tajný|zmluva/);
      });
    });

    describe('typy súborov a chyby nahrávania', () => {
      it('HEIC z iPhonu a ODT prejdú (predtým „Nepovolený typ súboru")', async () => {
        const msg = await makeMessage();
        const heic = await addFile(msg._id, Buffer.from('heic'), 'IMG_1234.HEIC', 'image/heic');
        expect(heic.status).toBe(200);
        const odt = await addFile(msg._id, Buffer.from('odt'), 'zmluva.odt', 'application/vnd.oasis.opendocument.text');
        expect(odt.status).toBe(200);
        expect(odt.body.files.map(f => f.originalName)).toEqual(['IMG_1234.HEIC', 'zmluva.odt']);
        expect(odt.body.files[0].mimetype).toBe('image/heic');
      });

      it('video je zakázané — podľa mimetype aj podľa prípony', async () => {
        const msg = await makeMessage();
        const mov = await addFile(msg._id, Buffer.from('mov'), 'clip.MOV', 'video/quicktime');
        expect(mov.status).toBe(400);
        expect(mov.body.code).toBe('VIDEO_NOT_ALLOWED');
        expect(mov.body.message).toMatch(/Videá/);

        const mp4 = await addFile(msg._id, Buffer.from('mp4'), 'video.mp4', 'application/octet-stream');
        expect(mp4.status).toBe(400);
        expect(mp4.body.code).toBe('VIDEO_NOT_ALLOWED');
        expect((await Message.findById(msg._id)).files).toHaveLength(0);
      });

      it('spustiteľný súbor → 400 BLOCKED_EXTENSION', async () => {
        const msg = await makeMessage();
        const res = await addFile(msg._id, Buffer.from('MZ'), 'setup.exe', 'application/octet-stream');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('BLOCKED_EXTENSION');
        expect(recordError).not.toHaveBeenCalled();
      });

      it('spustiteľný/video súbor s koncovou bodkou, medzerou či tabulátorom → odmietnutý (uložil by sa bez nich)', async () => {
        const msg = await makeMessage();
        for (const name of ['setup.exe.', 'setup.exe ', 'setup.exe\t', 'run.bat..']) {
          const res = await addFile(msg._id, Buffer.from('MZ'), name, 'application/octet-stream');
          expect(res.status).toBe(400);
          expect(res.body.code).toBe('BLOCKED_EXTENSION');
        }
        const vid = await addFile(msg._id, Buffer.from('abc'), 'clip.mp4.', 'application/octet-stream');
        expect(vid.status).toBe(400);
        expect(vid.body.code).toBe('VIDEO_NOT_ALLOWED');
        expect((await Message.findById(msg._id)).files).toHaveLength(0);
      });

      it('súbor nad 10 MB → 400 FILE_TOO_LARGE so slovenskou hláškou', async () => {
        const msg = await makeMessage();
        const res = await addFile(msg._id, Buffer.alloc(10 * MB + 1, 1), 'velka.jpg', 'image/jpeg');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('FILE_TOO_LARGE');
        expect(res.body.message).toMatch(/10 MB/);
        expect(recordError).not.toHaveBeenCalled();
      });

      it('useknuté multipart telo → 400 UPLOAD_BODY_INCOMPLETE + Diagnostika bez názvu súboru', async () => {
        const msg = await makeMessage();
        const truncated = '--XYZ\r\nContent-Disposition: form-data; name="file"; filename="tajne.jpg"\r\nContent-Type: image/jpeg\r\n\r\nabc';
        const res = await request(app)
          .post(`/api/messages/${msg._id}/files`)
          .set(authHeader(senderCtx.token))
          .set('Content-Type', 'multipart/form-data; boundary=XYZ')
          .send(truncated);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('UPLOAD_BODY_INCOMPLETE');
        expect(res.body.message).toMatch(/nedostal celý/);
        expect(recordError).toHaveBeenCalledTimes(1);
        const [err, , context] = recordError.mock.calls[0];
        expect(err.name).toBe('MessageUploadRejected');
        expect(err.status).toBe(400);
        expect(err.message).toMatch(/^UPLOAD_BODY_INCOMPLETE: Unexpected end of form/);
        expect(context.upload).toMatchObject({ contentType: 'multipart/form-data', hasBoundary: true, shell: 'web' });
        expect(JSON.stringify(recordError.mock.calls[0])).not.toMatch(/tajne/);
      });
    });

    describe('názvy súborov s diakritikou', () => {
      it('všetky 4 cesty nahrávania uložia správny UTF-8 názov (nie „faktÃºra")', async () => {
        const created = await request(app)
          .post('/api/messages')
          .set(authHeader(senderCtx.token))
          .field('toUserId', recipient._id.toString())
          .field('type', 'info')
          .field('subject', 'Ponuka')
          .attach('attachment', Buffer.from('pdf'), { filename: 'Cenová ponuka – Košice.pdf', contentType: 'application/pdf' });
        expect(created.status).toBe(201);
        expect(created.body.attachment.originalName).toBe('Cenová ponuka – Košice.pdf');
        const id = created.body.id;

        const file = await addFile(id, Buffer.from('xls'), 'faktúra č. 12.xlsx', 'application/vnd.ms-excel');
        expect(file.status).toBe(200);
        expect(file.body.files[0].originalName).toBe('faktúra č. 12.xlsx');

        const comment = await request(app)
          .post(`/api/messages/${id}/comment`)
          .set(authHeader(recipientToken))
          .field('text', 'Podpísané')
          .attach('attachment', Buffer.from('pdf'), { filename: 'zmluva_podpísaná.pdf', contentType: 'application/pdf' });
        expect(comment.status).toBe(200);
        expect(comment.body.comments[0].attachment.originalName).toBe('zmluva_podpísaná.pdf');

        const edited = await request(app)
          .put(`/api/messages/${id}`)
          .set(authHeader(senderCtx.token))
          .attach('attachment', Buffer.from('pdf'), { filename: 'Príloha č. 2.pdf', contentType: 'application/pdf' });
        expect(edited.status).toBe(200);
        expect(edited.body.attachment.originalName).toBe('Príloha č. 2.pdf');

        const stored = await Message.findById(id).lean();
        expect(stored.attachment.originalName).toBe('Príloha č. 2.pdf');
        expect(stored.files[0].originalName).toBe('faktúra č. 12.xlsx');
      });
    });

    describe('download hlavičky a verzia legacy prílohy', () => {
      it('legacy príloha: attachment + filename* (UTF-8) + nosniff; immutable len pre aktuálne ?v=', async () => {
        const msg = await makeMessage({
          attachment: {
            id: 'att-1',
            originalName: 'faktúra č. 5.pdf',
            mimetype: 'application/pdf',
            size: 5,
            data: Buffer.from('hello').toString('base64'),
            uploadedAt: new Date()
          }
        });

        const res = await request(app)
          .get(`/api/messages/${msg._id}/attachment?v=att-1`)
          .set(authHeader(recipientToken))
          .buffer(true).parse(binaryParser);
        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe('hello');
        expect(res.headers['content-disposition']).toMatch(/^attachment;/);
        expect(res.headers['content-disposition']).toContain("filename*=UTF-8''fakt%C3%BAra%20%C4%8D.%205.pdf");
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-type']).toMatch(/^application\/pdf/);
        expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
        expect(res.headers.etag).toBe('"msg-att-att-1"');

        // Bez v (staršia verzia appky) → revalidovať, nikdy immutable.
        const noV = await request(app)
          .get(`/api/messages/${msg._id}/attachment`)
          .set(authHeader(recipientToken))
          .buffer(true).parse(binaryParser);
        expect(noV.status).toBe(200);
        expect(noV.headers['cache-control']).toBe('private, no-cache');

        const cached = await request(app)
          .get(`/api/messages/${msg._id}/attachment?v=att-1`)
          .set(authHeader(recipientToken))
          .set('If-None-Match', '"msg-att-att-1"');
        expect(cached.status).toBe(304);
      });

      it('vymenená príloha (PUT) má nové id → starý ETag nevráti 304 ani starý súbor', async () => {
        const msg = await makeMessage({
          attachment: {
            id: 'att-old',
            originalName: 'navrh.pdf',
            mimetype: 'application/pdf',
            size: 3,
            data: Buffer.from('OLD').toString('base64'),
            uploadedAt: new Date()
          }
        });

        const put = await request(app)
          .put(`/api/messages/${msg._id}`)
          .set(authHeader(senderCtx.token))
          .attach('attachment', Buffer.from('NEW'), { filename: 'navrh-v2.pdf', contentType: 'application/pdf' });
        expect(put.status).toBe(200);
        const newId = put.body.attachment.id;
        expect(newId).toBeTruthy();
        expect(newId).not.toBe('att-old');

        const res = await request(app)
          .get(`/api/messages/${msg._id}/attachment?v=att-old`)
          .set(authHeader(recipientToken))
          .set('If-None-Match', '"msg-att-att-old"')
          .buffer(true).parse(binaryParser);
        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe('NEW');
        expect(res.headers.etag).toBe(`"msg-att-${newId}"`);
        // Zastaraná v → neukladať natrvalo pod starou URL.
        expect(res.headers['cache-control']).toBe('private, no-cache');
      });

      it('files[] a príloha komentára: attachment + nosniff; HTML sa nikdy nevykreslí inline', async () => {
        const msg = await makeMessage();
        const up = await addFile(msg._id, Buffer.from('<script>alert(1)</script>'), 'stranka.html', 'text/html');
        expect(up.status).toBe(200);
        const fileId = up.body.files[0].id;

        const dl = await request(app)
          .get(`/api/messages/${msg._id}/files/${fileId}/download`)
          .set(authHeader(recipientToken))
          .buffer(true).parse(binaryParser);
        expect(dl.status).toBe(200);
        expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="stranka.html"/);
        expect(dl.headers['x-content-type-options']).toBe('nosniff');

        const comment = await request(app)
          .post(`/api/messages/${msg._id}/comment`)
          .set(authHeader(recipientToken))
          .field('text', 'Príloha')
          .attach('attachment', Buffer.from('pdf'), { filename: 'podklad.pdf', contentType: 'application/pdf' });
        const commentId = comment.body.comments[0]._id;
        const cdl = await request(app)
          .get(`/api/messages/${msg._id}/comment/${commentId}/attachment`)
          .set(authHeader(senderCtx.token))
          .buffer(true).parse(binaryParser);
        expect(cdl.status).toBe(200);
        expect(cdl.headers['content-disposition']).toMatch(/^attachment;/);
        expect(cdl.headers['x-content-type-options']).toBe('nosniff');
        expect(cdl.body.toString()).toBe('pdf');
      });
    });
  });
});
