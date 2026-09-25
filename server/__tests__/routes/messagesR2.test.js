// R2 v testoch inak nie je nakonfigurované (fallback base64 — messages.test.js).
// Tu ho napodobníme in-memory mapou, aby sa dala overiť CELÁ R2 cesta:
// upload pred zápisom do DB, žiadny base64 ani r2Key v odpovediach,
// sťahovanie z R2, mazanie blobov, kvóta a to, že 16 MB strop dokumentu
// R2 prílohy nepočíta.
jest.mock('../../services/fileStorage', () => {
  const store = new Map();
  const failing = { upload: null };
  const noSuchKey = () => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; return e; };
  return {
    __store: store,
    __failing: failing,
    isR2Available: () => true,
    bucket: 'test-bucket',
    contactFileKey: (id) => `contactfiles/${id}`,
    messageFileKey: (id) => `messagefiles/${id}`,
    uploadFile: jest.fn(async (key, buffer, contentType) => {
      if (failing.upload && failing.upload(key)) throw new Error('R2 down');
      store.set(key, { buffer: Buffer.from(buffer), contentType });
      return key;
    }),
    downloadFile: jest.fn(async (key) => {
      const o = store.get(key);
      if (!o) throw noSuchKey();
      return o.buffer;
    }),
    deleteFile: jest.fn(async (key) => { store.delete(key); }),
    fileExists: jest.fn(async (key) => store.has(key)),
    getFileStream: jest.fn(),
    getPresignedUrl: jest.fn(),
    getBucketStats: jest.fn(async () => ({ configured: true, objectCount: store.size, totalBytes: 0 }))
  };
});
jest.mock('../../services/serverErrorService', () => {
  const actual = jest.requireActual('../../services/serverErrorService');
  return { ...actual, recordError: jest.fn(() => Promise.resolve()) };
});

const { createTestApp, createUserWithWorkspace, addMember, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const fileStorage = require('../../services/fileStorage');
const { deleteMessageBlobs } = require('../../services/messageFiles');
const messagesRouter = require('../../routes/messages');
const Message = require('../../models/Message');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

const MB = 1024 * 1024;
const store = fileStorage.__store;
const bytes = (n, seed = 7) => Buffer.from(Array.from({ length: n }, (_, i) => (i * seed) % 251));
const tick = () => new Promise(r => setTimeout(r, 30)); // fire-and-forget mazanie blobov
const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('/api/messages — prílohy v R2', () => {
  let app;
  let senderCtx;
  let recipient;
  let recipientToken;

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
    store.clear();
    fileStorage.__failing.upload = null;
    fileStorage.uploadFile.mockClear();
    fileStorage.deleteFile.mockClear();

    senderCtx = await createUserWithWorkspace({
      username: 'sender', email: 'sender@test.com', role: 'owner', workspaceName: 'R2 WS', plan: 'pro'
    });
    const r = await addMember(senderCtx.workspace._id, { username: 'recipient', email: 'recipient@test.com' });
    recipient = r.user;
    recipientToken = r.token;
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  const makeMessage = (extra = {}) => Message.create({
    workspaceId: senderCtx.workspace._id,
    fromUserId: senderCtx.user._id,
    fromUsername: 'sender',
    toUserId: recipient._id,
    toUsername: 'recipient',
    type: 'info',
    subject: 'R2',
    status: 'pending',
    ...extra
  });
  const addFile = (msgId, buffer, filename = 'foto.jpg', contentType = 'image/jpeg', token = senderCtx.token) =>
    request(app).post(`/api/messages/${msgId}/files`).set(authHeader(token))
      .attach('file', buffer, { filename, contentType });
  const addComment = (msgId, buffer, token = recipientToken) =>
    request(app).post(`/api/messages/${msgId}/comment`).set(authHeader(token))
      .field('text', 'komentár').attach('attachment', buffer, { filename: 'cmt.pdf', contentType: 'application/pdf' });
  const createWithAttachment = (buffer) =>
    request(app).post('/api/messages').set(authHeader(senderCtx.token))
      .field('toUserId', recipient._id.toString()).field('type', 'info').field('subject', 'S prílohou')
      .attach('attachment', buffer, { filename: 'zmluva.pdf', contentType: 'application/pdf' });
  const download = (url, token = senderCtx.token, headers = {}) =>
    request(app).get(url).set(authHeader(token)).set(headers).buffer(true).parse(binaryParser);
  const expectNoSecrets = (body) => {
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/r2Key/);
    expect(json).not.toMatch(/"data":/);
    expect(json).not.toMatch(/messagefiles\//);
  };

  describe('nahrávanie ukladá do R2, v dokumente len metadáta', () => {
    it('POST / s prílohou → r2Key v DB, žiadne base64; odpoveď bez r2Key/data, inline false', async () => {
      const buf = bytes(3000);
      const res = await createWithAttachment(buf);
      expect(res.status).toBe(201);
      expectNoSecrets(res.body);
      expect(res.body.attachment).toMatchObject({ originalName: 'zmluva.pdf', size: 3000, inline: false });
      expect(res.body.attachment.id).toBeTruthy();

      const doc = await Message.findById(res.body.id).lean();
      expect(doc.attachment.r2Key).toBe(`messagefiles/${res.body.attachment.id}`);
      expect(doc.attachment.data).toBeUndefined();
      expect(Buffer.compare(store.get(doc.attachment.r2Key).buffer, buf)).toBe(0);
      expect(store.get(doc.attachment.r2Key).contentType).toBe('application/pdf');
    });

    it('POST /:id/files → r2Key, bez base64; odpoveď files[] bez tajomstiev', async () => {
      const msg = await makeMessage();
      const res = await addFile(msg._id, bytes(500));
      expect(res.status).toBe(200);
      expectNoSecrets(res.body);
      expect(res.body.files[0]).toMatchObject({ originalName: 'foto.jpg', size: 500, inline: false });
      const doc = await Message.findById(msg._id).lean();
      expect(doc.files[0].r2Key).toBe(`messagefiles/${doc.files[0].id}`);
      expect(doc.files[0].data).toBeUndefined();
      expect(store.has(doc.files[0].r2Key)).toBe(true);
    });

    it('POST /:id/comment s prílohou → príloha komentára má id + r2Key', async () => {
      const msg = await makeMessage();
      const res = await addComment(msg._id, bytes(800));
      expect(res.status).toBe(200);
      expectNoSecrets(res.body);
      const c = res.body.comments[0];
      expect(c.attachment).toMatchObject({ originalName: 'cmt.pdf', size: 800, inline: false });
      expect(c.attachment.id).toBeTruthy();
      const doc = await Message.findById(msg._id).lean();
      expect(doc.comments[0].attachment.r2Key).toBe(`messagefiles/${c.attachment.id}`);
      expect(doc.comments[0].attachment.data).toBeUndefined();
    });

    it('zoznam, by-linked a detail nikdy nevrátia r2Key ani base64', async () => {
      const created = await createWithAttachment(bytes(10));
      await addFile(created.body.id, bytes(10));
      await addComment(created.body.id, bytes(10));
      await Message.updateOne({ _id: created.body.id }, { $set: { linkedType: 'contact', linkedId: 'c1' } });

      const list = await request(app).get('/api/messages?tab=all').set(authHeader(senderCtx.token));
      expect(list.status).toBe(200);
      expectNoSecrets(list.body);
      const linked = await request(app).get('/api/messages/by-linked?linkedType=contact&linkedId=c1').set(authHeader(senderCtx.token));
      expect(linked.status).toBe(200);
      expectNoSecrets(linked.body);
      const detail = await request(app).get(`/api/messages/${created.body.id}`).set(authHeader(recipientToken));
      expect(detail.status).toBe(200);
      expectNoSecrets(detail.body);
      expect(detail.body.attachment.inline).toBe(false);
      expect(detail.body.files[0].inline).toBe(false);
      expect(detail.body.comments[0].attachment.inline).toBe(false);
    });

    it('legacy správa s base64 (pred migráciou) → inline: true a sťahovanie z dokumentu funguje', async () => {
      const buf = bytes(64);
      const msg = await makeMessage({
        attachment: { originalName: 'stara.pdf', mimetype: 'application/pdf', size: 64, data: buf.toString('base64'), uploadedAt: new Date() },
        files: [{ id: 'f-old', originalName: 'old.jpg', mimetype: 'image/jpeg', size: 64, data: buf.toString('base64') }],
        comments: [{ userId: recipient._id, username: 'recipient', text: 'x', attachment: { originalName: 'c.pdf', mimetype: 'application/pdf', size: 64, data: buf.toString('base64'), uploadedAt: new Date() } }]
      });
      const detail = await request(app).get(`/api/messages/${msg._id}`).set(authHeader(senderCtx.token));
      expectNoSecrets(detail.body);
      expect(detail.body.attachment.inline).toBe(true);
      expect(detail.body.files[0].inline).toBe(true);
      expect(detail.body.comments[0].attachment.inline).toBe(true);

      const dl = await download(`/api/messages/${msg._id}/files/f-old/download`);
      expect(dl.status).toBe(200);
      expect(Buffer.compare(dl.body, buf)).toBe(0);
    });
  });

  describe('sťahovanie z R2', () => {
    it('legacy príloha: bajty z R2, attachment + nosniff, ETag/Cache podľa verzie, 304 pri If-None-Match', async () => {
      const buf = bytes(2048, 11);
      const created = await createWithAttachment(buf);
      const id = created.body.id;
      const v = created.body.attachment.id;

      const dl = await download(`/api/messages/${id}/attachment?v=${encodeURIComponent(v)}`, recipientToken);
      expect(dl.status).toBe(200);
      expect(Buffer.compare(dl.body, buf)).toBe(0);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);
      expect(dl.headers['content-disposition']).toMatch(/zmluva\.pdf/);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(dl.headers['content-type']).toMatch(/application\/pdf/);
      expect(dl.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(dl.headers['etag']).toBe(`"msg-att-${v}"`);

      const notModified = await download(`/api/messages/${id}/attachment?v=${encodeURIComponent(v)}`, recipientToken, { 'If-None-Match': `"msg-att-${v}"` });
      expect(notModified.status).toBe(304);

      // bez ?v= → no-cache (staršia appka nesmie natrvalo zacachovať)
      const noV = await download(`/api/messages/${id}/attachment`, recipientToken);
      expect(noV.status).toBe(200);
      expect(noV.headers['cache-control']).toBe('private, no-cache');
    });

    it('files[] a príloha komentára: bajty z R2 s nemenným ETagom', async () => {
      const msg = await makeMessage();
      const fbuf = bytes(1500, 3);
      const f = (await addFile(msg._id, fbuf)).body.files[0];
      const dl = await download(`/api/messages/${msg._id}/files/${f.id}/download`, recipientToken);
      expect(dl.status).toBe(200);
      expect(Buffer.compare(dl.body, fbuf)).toBe(0);
      expect(dl.headers['etag']).toBe(`"file-${f.id}"`);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);

      const cbuf = bytes(900, 5);
      const c = (await addComment(msg._id, cbuf)).body.comments[0];
      const cdl = await download(`/api/messages/${msg._id}/comment/${c._id}/attachment`);
      expect(cdl.status).toBe(200);
      expect(Buffer.compare(cdl.body, cbuf)).toBe(0);
      expect(cdl.headers['etag']).toBe(`"cmt-${c._id}-attach"`);
    });

    it('cudzí používateľ (nie odosielateľ ani príjemca) → 404', async () => {
      const other = await createUserWithWorkspace({ username: 'other', email: 'other@test.com', role: 'owner', workspaceName: 'Other WS', plan: 'pro' });
      const msg = await makeMessage();
      const f = (await addFile(msg._id, bytes(10))).body.files[0];
      const res = await download(`/api/messages/${msg._id}/files/${f.id}/download`, other.token);
      expect(res.status).toBe(404);
    });

    it('objekt v R2 chýba → 404 so slovenskou hláškou, nie 500', async () => {
      const msg = await makeMessage();
      const f = (await addFile(msg._id, bytes(10))).body.files[0];
      store.clear();
      const res = await request(app).get(`/api/messages/${msg._id}/files/${f.id}/download`).set(authHeader(senderCtx.token));
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/znovu nahrať/);
    });
  });

  describe('limity s R2', () => {
    it('video je povolené', async () => {
      const msg = await makeMessage();
      const res = await addFile(msg._id, bytes(100), 'klip.mp4', 'video/mp4');
      expect(res.status).toBe(200);
      expect(res.body.files[0].originalName).toBe('klip.mp4');
    });

    it('súbor nad 50 MB → 400 FILE_TOO_LARGE s hláškou o 50 MB', async () => {
      const msg = await makeMessage();
      const res = await addFile(msg._id, Buffer.alloc(50 * MB + 1, 1), 'velke.mp4', 'video/mp4');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
      expect(res.body.message).toMatch(/50 MB/);
      expect(store.size).toBe(0);
    });

    it('16 MB strop dokumentu sa R2 príloh netýka — 3 × 6 MB prejde', async () => {
      const msg = await makeMessage();
      for (let i = 0; i < 3; i++) {
        const res = await addFile(msg._id, Buffer.alloc(6 * MB, i + 1), `f${i}.bin`, 'application/octet-stream');
        expect(res.status).toBe(200);
      }
      const doc = await Message.findById(msg._id).lean();
      expect(doc.files).toHaveLength(3);
      expect(doc.files.every(f => f.r2Key && !f.data)).toBe(true);
    });
  });

  describe('mazanie blobov', () => {
    it('DELETE /:id/files/:fileId zmaže blob až po uložení metadát', async () => {
      const msg = await makeMessage();
      const f = (await addFile(msg._id, bytes(10))).body.files[0];
      const key = `messagefiles/${f.id}`;
      expect(store.has(key)).toBe(true);
      const res = await request(app).delete(`/api/messages/${msg._id}/files/${f.id}`).set(authHeader(senderCtx.token));
      expect(res.status).toBe(200);
      await tick();
      expect(store.has(key)).toBe(false);
      expect((await Message.findById(msg._id).lean()).files).toHaveLength(0);
    });

    it('DELETE komentára zmaže blob jeho prílohy; cudzí komentár nič nezmaže', async () => {
      const msg = await makeMessage();
      const c = (await addComment(msg._id, bytes(10))).body.comments[0];
      const key = `messagefiles/${c.attachment.id}`;
      // odosielateľ nie je autor komentára → 404 a blob ostáva
      const foreign = await request(app).delete(`/api/messages/${msg._id}/comment/${c._id}`).set(authHeader(senderCtx.token));
      expect(foreign.status).toBe(404);
      await tick();
      expect(store.has(key)).toBe(true);
      const own = await request(app).delete(`/api/messages/${msg._id}/comment/${c._id}`).set(authHeader(recipientToken));
      expect(own.status).toBe(200);
      await tick();
      expect(store.has(key)).toBe(false);
    });

    it('PUT /:id: výmena prílohy zmaže starý blob až po uložení; odstránenie tiež', async () => {
      const created = await createWithAttachment(bytes(10));
      const id = created.body.id;
      const oldKey = `messagefiles/${created.body.attachment.id}`;

      const replaced = await request(app).put(`/api/messages/${id}`).set(authHeader(senderCtx.token))
        .attach('attachment', bytes(20), { filename: 'nova.pdf', contentType: 'application/pdf' });
      expect(replaced.status).toBe(200);
      const newKey = `messagefiles/${replaced.body.attachment.id}`;
      expect(newKey).not.toBe(oldKey);
      await tick();
      expect(store.has(oldKey)).toBe(false);
      expect(store.has(newKey)).toBe(true);

      const removed = await request(app).put(`/api/messages/${id}`).set(authHeader(senderCtx.token))
        .field('removeAttachment', 'true');
      expect(removed.status).toBe(200);
      expect(removed.body.attachment).toBeFalsy();
      await tick();
      expect(store.has(newKey)).toBe(false);
    });

    it('DELETE /:id zmaže všetky bloby správy (legacy + files + komentáre)', async () => {
      const created = await createWithAttachment(bytes(10));
      const id = created.body.id;
      await addFile(id, bytes(10));
      await addComment(id, bytes(10));
      expect(store.size).toBe(3);
      const res = await request(app).delete(`/api/messages/${id}`).set(authHeader(senderCtx.token));
      expect(res.status).toBe(200);
      await tick();
      expect(store.size).toBe(0);
    });

    it('deleteMessageBlobs(filter) maže len bloby správ zodpovedajúcich filtru', async () => {
      const other = await createUserWithWorkspace({ username: 'other', email: 'other@test.com', role: 'owner', workspaceName: 'Other WS', plan: 'pro' });
      const a = await createWithAttachment(bytes(10));
      await addFile(a.body.id, bytes(10));
      const keysA = [`messagefiles/${a.body.attachment.id}`, ...(await Message.findById(a.body.id).lean()).files.map(f => f.r2Key)];
      const keyB = 'messagefiles/other-ws-blob';
      store.set(keyB, { buffer: bytes(5), contentType: 'x' });
      await Message.create({
        workspaceId: other.workspace._id, fromUserId: other.user._id, fromUsername: 'other',
        toUserId: other.user._id, toUsername: 'other', type: 'info', subject: 'B', status: 'pending',
        files: [{ id: 'other-ws-blob', originalName: 'b.bin', mimetype: 'x', size: 5, r2Key: keyB }]
      });

      const n = await deleteMessageBlobs({ workspaceId: senderCtx.workspace._id });
      expect(n).toBe(2);
      for (const k of keysA) expect(store.has(k)).toBe(false);
      expect(store.has(keyB)).toBe(true);
    });

    it('zlyhanie zápisu do DB po uploade do R2 → blob sa zmaže (žiadna sirota)', async () => {
      const msg = await makeMessage();
      const spy = jest.spyOn(Message.prototype, 'save').mockImplementationOnce(async () => { throw new Error('DB down'); });
      const res = await addFile(msg._id, bytes(10));
      spy.mockRestore();
      expect(res.status).toBe(500);
      await tick();
      expect(store.size).toBe(0);
      expect((await Message.findById(msg._id).lean()).files).toHaveLength(0);
    });
  });

  describe('plánová kvóta úložiska', () => {
    const seedUsage = async (ctx, bytesUsed) => Message.create({
      workspaceId: ctx.workspace._id, fromUserId: ctx.user._id, fromUsername: ctx.user.username,
      toUserId: ctx.user._id, toUsername: ctx.user.username, type: 'info', subject: 'veľká', status: 'pending',
      files: [{ id: 'big', originalName: 'big.zip', mimetype: 'application/zip', size: bytesUsed, r2Key: 'messagefiles/big' }]
    });

    it('Tím nad 1 GB → 403 STORAGE_LIMIT (iOS bez zmienky o pláne), nič sa nenahrá', async () => {
      const team = await createUserWithWorkspace({ username: 'team', email: 'team@test.com', role: 'owner', workspaceName: 'Team WS', plan: 'team' });
      await seedUsage(team, 1.1 * 1024 * MB);
      const msg = await Message.create({
        workspaceId: team.workspace._id, fromUserId: team.user._id, fromUsername: 'team',
        toUserId: team.user._id, toUsername: 'team', type: 'info', subject: 'x', status: 'pending'
      });
      const web = await addFile(msg._id, bytes(10), 'foto.jpg', 'image/jpeg', team.token);
      expect(web.status).toBe(403);
      expect(web.body.code).toBe('STORAGE_LIMIT');
      expect(web.body.message).toMatch(/Upgradujte plán/);

      const ios = await request(app).post(`/api/messages/${msg._id}/files`).set(authHeader(team.token))
        .set('User-Agent', 'PrplCRM-iOS/1.0.19.79 Mozilla/5.0 (iPhone)')
        .attach('file', bytes(10), { filename: 'foto.jpg', contentType: 'image/jpeg' });
      expect(ios.status).toBe(403);
      expect(ios.body.message).not.toMatch(/plán|Upgrad/i);
      expect(store.size).toBe(0);
    });

    it('Free plán kvótu nemá — príloha správy prejde aj pri veľkom využití', async () => {
      const free = await createUserWithWorkspace({ username: 'free', email: 'free@test.com', role: 'owner', workspaceName: 'Free WS', plan: 'free' });
      await seedUsage(free, 5 * 1024 * MB);
      const msg = await Message.create({
        workspaceId: free.workspace._id, fromUserId: free.user._id, fromUsername: 'free',
        toUserId: free.user._id, toUsername: 'free', type: 'info', subject: 'x', status: 'pending'
      });
      const res = await addFile(msg._id, bytes(10), 'foto.jpg', 'image/jpeg', free.token);
      expect(res.status).toBe(200);
    });
  });
});
