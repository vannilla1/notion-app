const mongoose = require('mongoose');
const Contact = require('../../models/Contact');
const ContactFile = require('../../models/ContactFile');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');

/**
 * ContactFile model testy — oddelené Base64 prílohy od Contact dokumentu.
 *
 * Design rationale (viď server/models/ContactFile.js):
 *   - Base64 data sú veľké (MB), držanie ich v Contact dokumente blokuje
 *     Contact.find() pri počúvaní zmien a TTL indexoch.
 *   - ContactFile má vlastnú kolekciu s lazy loadom; Contact drží len metadáta
 *     (fileId referencia) v contactFile subdocumente.
 *
 * Invariants:
 *   - fileId: required + unique (globálny lookup key, UUID)
 *   - data: required (Base64 string)
 *   - contactId: default null (umožňuje pre-uložiť prílohu pred priradením)
 */
describe('ContactFile model', () => {
  let owner;
  let workspace;
  let contact;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await Contact.init();
    await ContactFile.init();
  });

  beforeEach(async () => {
    await ContactFile.deleteMany({});
    await Contact.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    owner = await User.create({
      username: 'fileowner',
      email: 'files@test.com',
      password: 'hashedpw'
    });
    workspace = await Workspace.create({
      name: 'Files WS',
      slug: 'files-ws',
      ownerId: owner._id
    });
    contact = await Contact.create({
      workspaceId: workspace._id,
      userId: owner._id,
      name: 'Subject with files'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Creation & required fields', () => {
    it('should create a ContactFile with required fields', async () => {
      const file = await ContactFile.create({
        contactId: contact._id,
        fileId: 'uuid-abc-123',
        data: 'data:image/png;base64,iVBORw0KGgo...'
      });

      expect(file._id).toBeDefined();
      expect(file.fileId).toBe('uuid-abc-123');
      expect(file.data).toContain('base64');
      expect(file.createdAt).toBeInstanceOf(Date);
      expect(file.updatedAt).toBeInstanceOf(Date);
    });

    it('should enforce fileId as required', async () => {
      await expect(
        ContactFile.create({ contactId: contact._id, data: 'xxx' })
      ).rejects.toThrow();
    });

    it('should enforce data as required', async () => {
      await expect(
        ContactFile.create({ contactId: contact._id, fileId: 'uuid-1' })
      ).rejects.toThrow();
    });

    it('should allow contactId=null (pre-uploaded file before assignment)', async () => {
      const file = await ContactFile.create({
        fileId: 'orphan-uuid',
        data: 'base64payload'
      });
      expect(file.contactId).toBeNull();
    });
  });

  describe('Unique fileId constraint', () => {
    it('should enforce unique fileId globally', async () => {
      await ContactFile.create({
        contactId: contact._id,
        fileId: 'shared-uuid',
        data: 'payload1'
      });

      await expect(
        ContactFile.create({
          contactId: contact._id,
          fileId: 'shared-uuid',
          data: 'payload2'
        })
      ).rejects.toThrow(/duplicate key|E11000/i);
    });

    it('should allow different files with different fileIds on same contact', async () => {
      const f1 = await ContactFile.create({
        contactId: contact._id,
        fileId: 'uuid-1',
        data: 'data1'
      });
      const f2 = await ContactFile.create({
        contactId: contact._id,
        fileId: 'uuid-2',
        data: 'data2'
      });
      expect(f1.fileId).not.toBe(f2.fileId);
    });
  });

  describe('Common queries', () => {
    it('should find all files for a contact', async () => {
      await ContactFile.create([
        { contactId: contact._id, fileId: 'f1', data: 'x' },
        { contactId: contact._id, fileId: 'f2', data: 'y' },
        { contactId: contact._id, fileId: 'f3', data: 'z' }
      ]);

      const files = await ContactFile.find({ contactId: contact._id });
      expect(files).toHaveLength(3);
    });

    it('should find file by unique fileId for lazy-load GET', async () => {
      await ContactFile.create({
        contactId: contact._id,
        fileId: 'lookup-me',
        data: 'big-base64-payload'
      });

      const found = await ContactFile.findOne({ fileId: 'lookup-me' });
      expect(found).not.toBeNull();
      expect(found.data).toBe('big-base64-payload');
    });

    it('should cascade cleanup: delete files by contactId', async () => {
      await ContactFile.create([
        { contactId: contact._id, fileId: 'a', data: 'x' },
        { contactId: contact._id, fileId: 'b', data: 'y' }
      ]);
      const otherContact = await Contact.create({
        workspaceId: workspace._id,
        userId: owner._id,
        name: 'Other'
      });
      await ContactFile.create({ contactId: otherContact._id, fileId: 'c', data: 'z' });

      await ContactFile.deleteMany({ contactId: contact._id });

      const remaining = await ContactFile.find({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].fileId).toBe('c');
    });
  });

  describe('Large payload support', () => {
    it('should store a 1MB Base64 string without truncation', async () => {
      // ~1MB of Base64 payload (simulating image)
      const bigPayload = 'A'.repeat(1024 * 1024);
      const file = await ContactFile.create({
        contactId: contact._id,
        fileId: 'big-file',
        data: bigPayload
      });
      expect(file.data).toHaveLength(1024 * 1024);

      const refetched = await ContactFile.findOne({ fileId: 'big-file' });
      expect(refetched.data).toHaveLength(1024 * 1024);
    });
  });
});
