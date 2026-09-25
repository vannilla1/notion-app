// Migrácia base64 príloh správ do R2 — R2 napodobnené in-memory mapou.
jest.mock('../../services/fileStorage', () => {
  const store = new Map();
  const failing = { upload: null };
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
    downloadFile: jest.fn(async (key) => store.get(key)?.buffer),
    deleteFile: jest.fn(async (key) => { store.delete(key); }),
    fileExists: jest.fn(async (key) => store.has(key)),
    getFileStream: jest.fn(),
    getPresignedUrl: jest.fn(),
    getBucketStats: jest.fn(async () => ({ configured: true }))
  };
});

const mongoose = require('mongoose');
const fileStorage = require('../../services/fileStorage');
const migration = require('../../services/messageFileMigration');
const Message = require('../../models/Message');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');

const store = fileStorage.__store;
const b64 = (s) => Buffer.from(s).toString('base64');

describe('messageFileMigration', () => {
  let ws;
  let user;
  const FAIL_FILE_ID = 'file-fails';

  beforeAll(async () => {
    await Message.init();
    user = await User.create({ username: 'mig', email: 'mig@test.com', password: 'x' });
    ws = await Workspace.create({ name: 'Mig WS', slug: `mig-${Date.now()}`, ownerId: user._id });
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    store.clear();
    fileStorage.__failing.upload = null;
    fileStorage.uploadFile.mockClear();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  const base = () => ({
    workspaceId: ws._id, fromUserId: user._id, fromUsername: 'mig',
    toUserId: user._id, toUsername: 'mig', type: 'info', status: 'pending'
  });

  const seed = async () => {
    // 1) všetky tri druhy inline: legacy (bez id), 2 files, komentár
    const full = await Message.create({
      ...base(), subject: 'plná',
      attachment: { originalName: 'legacy.pdf', mimetype: 'application/pdf', size: 6, data: b64('legacy'), uploadedAt: new Date() },
      files: [
        { id: 'f1', originalName: 'a.jpg', mimetype: 'image/jpeg', size: 2, data: b64('f1') },
        { id: 'f2', originalName: 'b.jpg', mimetype: 'image/jpeg', size: 2, data: b64('f2') }
      ],
      comments: [{ userId: user._id, username: 'mig', text: 'c', attachment: { originalName: 'c.pdf', mimetype: 'application/pdf', size: 3, data: b64('cmt'), uploadedAt: new Date() } }]
    });
    // 2) už zmigrovaná
    store.set('messagefiles/done', { buffer: Buffer.from('done'), contentType: 'x' });
    const done = await Message.create({
      ...base(), subject: 'hotová',
      files: [{ id: 'done', originalName: 'd.bin', mimetype: 'x', size: 4, r2Key: 'messagefiles/done' }]
    });
    // 3) bez príloh
    const empty = await Message.create({ ...base(), subject: 'prázdna' });
    // 4) upload tohto blobu zlyhá
    const failing = await Message.create({
      ...base(), subject: 'zlyhá',
      files: [{ id: FAIL_FILE_ID, originalName: 'x.bin', mimetype: 'x', size: 5, data: b64('nope!') }]
    });
    return { full, done, empty, failing };
  };

  it('dry-run nič nemení; live presunie všetky bloby, chybný nechá inline; opakovanie je no-op', async () => {
    const { full, done, empty, failing } = await seed();
    expect(await migration.getPendingMigrationCount()).toBe(5);

    const dry = await migration.runMessageFileMigration({ dryRun: true });
    expect(dry.mode).toBe('dry-run');
    expect(dry.total).toBe(5);
    expect(dry.processed).toBe(0);
    expect(store.size).toBe(1); // len 'done'
    expect((await Message.findById(full._id).lean()).attachment.data).toBe(b64('legacy'));
    expect(await migration.getPendingMigrationCount()).toBe(5);

    fileStorage.__failing.upload = (key) => key === `messagefiles/${FAIL_FILE_ID}`;
    const live = await migration.runMessageFileMigration({ dryRun: false });
    expect(live.mode).toBe('live');
    expect(live.processed).toBe(5);
    expect(live.succeeded).toBe(4);
    expect(live.failed).toBe(1);
    expect(live.errors[0]).toMatchObject({ messageId: failing._id.toString() });
    expect(live.running).toBe(false);
    expect(live.finishedAt).toBeTruthy();

    const f = await Message.findById(full._id).lean();
    expect(String(f.updatedAt)).toBe(String(full.updatedAt)); // migrácia nemení čas úpravy
    expect(f.attachment.id).toBeTruthy();
    expect(f.attachment.r2Key).toBe(`messagefiles/${f.attachment.id}`);
    expect(f.attachment.data).toBeUndefined();
    expect(f.attachment.originalName).toBe('legacy.pdf');
    expect(Buffer.compare(store.get(f.attachment.r2Key).buffer, Buffer.from('legacy'))).toBe(0);
    expect(store.get(f.attachment.r2Key).contentType).toBe('application/pdf');
    for (const file of f.files) {
      expect(file.r2Key).toBe(`messagefiles/${file.id}`);
      expect(file.data).toBeUndefined();
      expect(store.has(file.r2Key)).toBe(true);
    }
    expect(Buffer.compare(store.get('messagefiles/f2').buffer, Buffer.from('f2'))).toBe(0);
    const c = f.comments[0].attachment;
    expect(c.id).toBeTruthy();
    expect(c.r2Key).toBe(`messagefiles/${c.id}`);
    expect(c.data).toBeUndefined();
    expect(f.comments[0].text).toBe('c');

    // už zmigrovaná a prázdna sú nedotknuté
    const d = await Message.findById(done._id).lean();
    expect(d.files[0].r2Key).toBe('messagefiles/done');
    expect(d.files[0].data).toBeUndefined();
    expect((await Message.findById(empty._id).lean()).attachment).toBeUndefined();

    // chybný blob: data ostali, r2Key null, nič v R2
    const fl = await Message.findById(failing._id).lean();
    expect(fl.files[0].data).toBe(b64('nope!'));
    expect(fl.files[0].r2Key).toBeNull();
    expect(store.has(`messagefiles/${FAIL_FILE_ID}`)).toBe(false);
    expect(await migration.getPendingMigrationCount()).toBe(1);

    // R2 sa spamätalo → druhý beh dorobí zvyšok, tretí nemá čo robiť
    fileStorage.__failing.upload = null;
    const second = await migration.runMessageFileMigration({ dryRun: false });
    expect(second.succeeded).toBe(1);
    expect(second.failed).toBe(0);
    expect(await migration.getPendingMigrationCount()).toBe(0);
    expect((await Message.findById(failing._id).lean()).files[0].r2Key).toBe(`messagefiles/${FAIL_FILE_ID}`);

    const third = await migration.runMessageFileMigration({ dryRun: false });
    expect(third.total).toBe(0);
    expect(third.processed).toBe(0);
    expect(store.size).toBe(6); // done + legacy + f1 + f2 + cmt + fails
  });

  it('príloha zmazaná počas migrácie → nahraný blob sa hneď zmaže (žiadna sirota)', async () => {
    const msg = await Message.create({
      ...base(), subject: 'race',
      files: [{ id: 'race', originalName: 'r.bin', mimetype: 'x', size: 4, data: b64('race') }]
    });
    // Po uploade, pred updateOne, „používateľ" prílohu zmaže.
    fileStorage.fileExists.mockImplementationOnce(async (key) => {
      await Message.updateOne({ _id: msg._id }, { $set: { files: [] } });
      return store.has(key);
    });
    const res = await migration.runMessageFileMigration({ dryRun: false });
    expect(res.skipped).toBe(1);
    expect(res.succeeded).toBe(0);
    expect(store.has('messagefiles/race')).toBe(false);
  });

  it('bez R2 skončí s FATAL chybou a nič nemení', async () => {
    const { full } = await seed();
    const orig = fileStorage.isR2Available;
    fileStorage.isR2Available = () => false;
    try {
      const res = await migration.runMessageFileMigration({ dryRun: false });
      expect(res.errors[0].message).toMatch(/FATAL/);
      expect((await Message.findById(full._id).lean()).attachment.data).toBe(b64('legacy'));
    } finally {
      fileStorage.isR2Available = orig;
    }
  });
});
