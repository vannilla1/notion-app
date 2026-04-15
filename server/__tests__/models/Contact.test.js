const mongoose = require('mongoose');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const Contact = require('../../models/Contact');

/**
 * Contact model testy — P2 Guard (Workspace Isolation) + data integrity.
 *
 * Pattern kopíruje Task.test.js (viď `__tests__/models/Task.test.js`).
 *
 * Schéma kontaktu (viď `server/models/Contact.js`):
 *   - workspaceId: required (multi-tenant guard)
 *   - userId: required (autor / vlastník)
 *   - name: DEFAULT '' (NIE je required — user si ho môže doplniť neskôr,
 *     napr. pri importe z CSV). Test "name default" to explicitne dokumentuje.
 */
describe('Contact model - Workspace Isolation (P2 Guard)', () => {
  let owner;
  let workspaceA;
  let workspaceB;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await Contact.init();
  });

  beforeEach(async () => {
    await Contact.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    owner = await User.create({
      username: 'admin',
      email: 'admin@test.com',
      password: 'hashedpassword123'
    });

    workspaceA = await Workspace.create({
      name: 'Workspace A',
      slug: 'workspace-a',
      ownerId: owner._id
    });

    workspaceB = await Workspace.create({
      name: 'Workspace B',
      slug: 'workspace-b',
      ownerId: owner._id
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Creation & required fields', () => {
    it('should create a contact with required fields (workspaceId + userId)', async () => {
      // Arrange / Act
      const contact = await Contact.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        name: 'Ivan Novák'
      });

      // Assert
      expect(contact).toBeDefined();
      expect(contact._id).toBeDefined();
      expect(contact.workspaceId.toString()).toBe(workspaceA._id.toString());
      expect(contact.userId.toString()).toBe(owner._id.toString());
      expect(contact.name).toBe('Ivan Novák');
      expect(contact.status).toBe('new'); // default status
    });

    it('should default name to empty string when not provided', async () => {
      // Dokumentuje zámerné správanie: name NIE je required, aby sa mohli
      // importovať kontakty bez mena (napr. len email z CSV) a user ich
      // doplní neskôr v UI.
      const contact = await Contact.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        email: 'ivan@test.com'
      });

      expect(contact.name).toBe('');
      expect(contact.email).toBe('ivan@test.com');
    });
  });

  describe('Data Integrity', () => {
    it('should enforce workspaceId as a required field', async () => {
      await expect(
        Contact.create({
          userId: owner._id,
          name: 'Orphan Contact'
        })
      ).rejects.toThrow();
    });

    it('should enforce userId as a required field', async () => {
      await expect(
        Contact.create({
          workspaceId: workspaceA._id,
          name: 'Orphan Contact'
        })
      ).rejects.toThrow();
    });

    it('should correctly store and retrieve nested tasks', async () => {
      // Kontakty majú nested tasks (embedded, nie cez Task model).
      // Viď §6 GEMMA_PROJECT_GUIDE.md — Task model je standalone projekt,
      // kontaktové tasks sú samostatná doménová entita.
      const contact = await Contact.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        name: 'Parent Contact',
        tasks: [
          { id: 't-1', title: 'Zavolať zákazníkovi', completed: false },
          { id: 't-2', title: 'Poslať ponuku', completed: true }
        ]
      });

      const fetched = await Contact.findById(contact._id);

      expect(fetched.tasks).toHaveLength(2);
      expect(fetched.tasks[0].title).toBe('Zavolať zákazníkovi');
      expect(fetched.tasks[1].completed).toBe(true);
    });
  });

  describe('Workspace Isolation (P2)', () => {
    it('should NOT find a contact from Workspace A when querying for Workspace B', async () => {
      // Arrange — kontakt existuje len vo Workspace A
      await Contact.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        name: 'Secret Contact in A',
        email: 'secret@a.com'
      });

      // Act — query nad Workspace B s rovnakým menom
      const leakedContact = await Contact.findOne({
        workspaceId: workspaceB._id,
        name: 'Secret Contact in A'
      });

      // Assert — žiadny leak cez workspace boundary
      expect(leakedContact).toBeNull();
    });

    it('should find the contact when using the correct workspaceId', async () => {
      // Arrange
      await Contact.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        name: 'Visible Contact in A'
      });

      // Act
      const found = await Contact.findOne({
        workspaceId: workspaceA._id,
        name: 'Visible Contact in A'
      });

      // Assert
      expect(found).not.toBeNull();
      expect(found.name).toBe('Visible Contact in A');
      expect(found.workspaceId.toString()).toBe(workspaceA._id.toString());
    });

    it('should return only contacts from the queried workspace in multi-workspace setup', async () => {
      // Regresný test proti najhoršiemu scenáru: bulk list query (napríklad
      // `Contact.find({ workspaceId })` v GET /api/contacts) nesmie vrátiť
      // ani jeden záznam z iného workspacu.
      await Contact.create([
        { workspaceId: workspaceA._id, userId: owner._id, name: 'A — Kontakt 1' },
        { workspaceId: workspaceA._id, userId: owner._id, name: 'A — Kontakt 2' },
        { workspaceId: workspaceB._id, userId: owner._id, name: 'B — Kontakt 1' },
        { workspaceId: workspaceB._id, userId: owner._id, name: 'B — Kontakt 2' },
        { workspaceId: workspaceB._id, userId: owner._id, name: 'B — Kontakt 3' }
      ]);

      const aContacts = await Contact.find({ workspaceId: workspaceA._id });
      const bContacts = await Contact.find({ workspaceId: workspaceB._id });

      expect(aContacts).toHaveLength(2);
      expect(bContacts).toHaveLength(3);
      expect(aContacts.every(c => c.name.startsWith('A'))).toBe(true);
      expect(bContacts.every(c => c.name.startsWith('B'))).toBe(true);
    });

    it('should NOT allow findOneAndUpdate across workspace boundary', async () => {
      // Ďalší P2 regresný test: update operácia nad wrong workspaceId nesmie
      // zmeniť záznam v inom workspace (ani ho nájsť).
      const original = await Contact.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        name: 'Original',
        status: 'new'
      });

      const updateResult = await Contact.findOneAndUpdate(
        { _id: original._id, workspaceId: workspaceB._id },
        { status: 'active' },
        { new: true }
      );

      expect(updateResult).toBeNull();

      // Uistíme sa, že pôvodný dokument zostal nedotknutý
      const unchanged = await Contact.findById(original._id);
      expect(unchanged.status).toBe('new');
    });

    it('should NOT allow deleteOne across workspace boundary', async () => {
      // P2 regresný test pre delete — kontrola, že wrong workspaceId nezmaže
      // záznam (napr. útočník s platným JWT iného workspacu).
      const target = await Contact.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        name: 'Protected Contact'
      });

      const res = await Contact.deleteOne({
        _id: target._id,
        workspaceId: workspaceB._id
      });

      expect(res.deletedCount).toBe(0);

      // Kontakt stále existuje
      const stillThere = await Contact.findById(target._id);
      expect(stillThere).not.toBeNull();
      expect(stillThere.name).toBe('Protected Contact');
    });
  });
});
