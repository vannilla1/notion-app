const mongoose = require('mongoose');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const Notification = require('../../models/Notification');

/**
 * Notification model testy — P2 Workspace Isolation + enum integrita.
 *
 * Invariants (viď server/models/Notification.js):
 *   - userId je required (komu patrí notifikácia)
 *   - workspaceId NIE JE required — legacy podpora počas migrácie starých
 *     záznamov; nové notifikácie ho však musia mať (inak by prekrižovali
 *     workspacy). Kódová cesta cez notificationService je už povinná.
 *   - type je enum s presne 20 hodnotami — akákoľvek nová notifikačná
 *     udalosť musí byť pridaná do enumu, inak create hodí validation error.
 *   - expiresAt default = +30 dní (TTL index auto-delete).
 *   - relatedType enum: contact | task | subtask | message.
 */
describe('Notification model — workspace isolation + schema integrity', () => {
  let user;
  let actor;
  let workspaceA;
  let workspaceB;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await Notification.init();
  });

  beforeEach(async () => {
    await Notification.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    user = await User.create({
      username: 'recipient',
      email: 'recipient@test.com',
      password: 'hashedpw'
    });
    actor = await User.create({
      username: 'actor',
      email: 'actor@test.com',
      password: 'hashedpw'
    });
    workspaceA = await Workspace.create({
      name: 'WS A',
      slug: 'notif-ws-a',
      ownerId: user._id
    });
    workspaceB = await Workspace.create({
      name: 'WS B',
      slug: 'notif-ws-b',
      ownerId: user._id
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  const baseNotif = () => ({
    userId: user._id,
    workspaceId: workspaceA._id,
    type: 'task.created',
    title: 'Actor pridal projekt: Demo',
    actorId: actor._id,
    actorName: 'actor'
  });

  describe('Creation & required fields', () => {
    it('should create notification with defaults', async () => {
      const n = await Notification.create(baseNotif());

      expect(n._id).toBeDefined();
      expect(n.read).toBe(false);
      expect(n.message).toBe('');
      expect(n.data).toEqual({});
      expect(n.expiresAt).toBeInstanceOf(Date);
      // Default expiresAt ~30 dní dopredu (±1 deň tolerancia)
      const diffDays = (n.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(29);
      expect(diffDays).toBeLessThan(31);
    });

    it('should enforce userId as required', async () => {
      const n = baseNotif();
      delete n.userId;
      await expect(Notification.create(n)).rejects.toThrow();
    });

    it('should enforce type as required', async () => {
      const n = baseNotif();
      delete n.type;
      await expect(Notification.create(n)).rejects.toThrow();
    });

    it('should enforce title as required', async () => {
      const n = baseNotif();
      delete n.title;
      await expect(Notification.create(n)).rejects.toThrow();
    });

    it('should allow notification without workspaceId (legacy support)', async () => {
      // Zámerné správanie: workspaceId nie je required kvôli migrácii
      // starých záznamov. Nové notifikácie ho však VŽDY musia mať
      // (garantuje to notificationService.createNotification).
      const n = baseNotif();
      delete n.workspaceId;
      const created = await Notification.create(n);
      expect(created._id).toBeDefined();
    });
  });

  describe('Type enum integrity', () => {
    const validTypes = [
      'contact.created', 'contact.updated', 'contact.deleted',
      'task.created', 'task.updated', 'task.completed', 'task.deleted', 'task.assigned',
      'subtask.created', 'subtask.updated', 'subtask.completed', 'subtask.deleted', 'subtask.assigned',
      'task.dueDate', 'subtask.dueDate',
      'message.created', 'message.approved', 'message.rejected', 'message.commented',
      'message.comment.reacted'
    ];

    it.each(validTypes)('should accept type="%s"', async (type) => {
      const n = await Notification.create({ ...baseNotif(), type });
      expect(n.type).toBe(type);
    });

    it('should reject unknown notification type', async () => {
      await expect(
        Notification.create({ ...baseNotif(), type: 'contact.exported' })
      ).rejects.toThrow();
    });
  });

  describe('relatedType enum', () => {
    it.each(['contact', 'task', 'subtask', 'message'])(
      'should accept relatedType="%s"',
      async (rt) => {
        const n = await Notification.create({
          ...baseNotif(),
          relatedType: rt,
          relatedId: 'abc-123',
          relatedName: 'Demo'
        });
        expect(n.relatedType).toBe(rt);
      }
    );

    it('should reject unknown relatedType', async () => {
      await expect(
        Notification.create({ ...baseNotif(), relatedType: 'invoice' })
      ).rejects.toThrow();
    });
  });

  describe('Workspace Isolation (P2)', () => {
    it('should NOT return notifications from other workspace', async () => {
      await Notification.create({
        ...baseNotif(),
        workspaceId: workspaceA._id,
        title: 'Secret in A'
      });

      const leaked = await Notification.findOne({
        userId: user._id,
        workspaceId: workspaceB._id,
        title: 'Secret in A'
      });
      expect(leaked).toBeNull();
    });

    it('should filter by workspace when user is in multiple workspaces', async () => {
      await Notification.create([
        { ...baseNotif(), workspaceId: workspaceA._id, title: 'A1' },
        { ...baseNotif(), workspaceId: workspaceA._id, title: 'A2' },
        { ...baseNotif(), workspaceId: workspaceB._id, title: 'B1' }
      ]);

      const aNotifs = await Notification.find({
        userId: user._id,
        workspaceId: workspaceA._id
      });
      const bNotifs = await Notification.find({
        userId: user._id,
        workspaceId: workspaceB._id
      });

      expect(aNotifs).toHaveLength(2);
      expect(bNotifs).toHaveLength(1);
    });

    it('should NOT allow update across workspace boundary', async () => {
      const n = await Notification.create(baseNotif());

      const result = await Notification.findOneAndUpdate(
        { _id: n._id, workspaceId: workspaceB._id },
        { read: true },
        { new: true }
      );

      expect(result).toBeNull();
      const unchanged = await Notification.findById(n._id);
      expect(unchanged.read).toBe(false);
    });
  });

  describe('Read status + data payload', () => {
    it('should flip read to true and keep other fields intact', async () => {
      const n = await Notification.create(baseNotif());
      expect(n.read).toBe(false);

      n.read = true;
      await n.save();

      const refetched = await Notification.findById(n._id);
      expect(refetched.read).toBe(true);
      expect(refetched.title).toBe(n.title);
    });

    it('should store arbitrary data payload (mixed type)', async () => {
      const n = await Notification.create({
        ...baseNotif(),
        data: {
          taskId: 'task-42',
          contactId: 'contact-7',
          subtaskId: 'sub-3',
          custom: { nested: [1, 2, 3] }
        }
      });

      const fetched = await Notification.findById(n._id);
      expect(fetched.data.taskId).toBe('task-42');
      expect(fetched.data.custom.nested).toEqual([1, 2, 3]);
    });
  });

  describe('TTL expiresAt', () => {
    it('should allow custom expiresAt override', async () => {
      const future = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // +60 dní
      const n = await Notification.create({ ...baseNotif(), expiresAt: future });
      expect(n.expiresAt.getTime()).toBe(future.getTime());
    });

    it('should index expiresAt with TTL (metadata introspection)', async () => {
      const indexes = await Notification.collection.indexes();
      const ttl = indexes.find(
        (idx) => idx.key && idx.key.expiresAt === 1 && typeof idx.expireAfterSeconds === 'number'
      );
      expect(ttl).toBeDefined();
      expect(ttl.expireAfterSeconds).toBe(0);
    });
  });
});
