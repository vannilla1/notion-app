const mongoose = require('mongoose');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const Message = require('../../models/Message');

/**
 * Message model testy — P2 Workspace Isolation + schema integrita
 * pre sekciu "Odkazy" (interné schvaľovanie / žiadosti medzi členmi tímu).
 *
 * Kľúčové invarianty (viď server/models/Message.js):
 *   - workspaceId, fromUserId, toUserId, fromUsername, toUsername,
 *     type, subject sú required.
 *   - type enum: approval | info | request | proposal | poll
 *   - status enum: pending | approved | rejected | commented  (default pending)
 *   - linkedType enum: contact | task | null  (default null)
 *   - Embedded: comments[], files[], pollOptions[], readBy[]
 *   - toJSON transform odstraňuje attachment.data z list views
 *     (výkonnostná optimalizácia — neposielame base64 payload v zozname).
 */
describe('Message model — Workspace Isolation + schema integrity', () => {
  let owner;
  let recipient;
  let workspaceA;
  let workspaceB;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await Message.init();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    owner = await User.create({
      username: 'boss',
      email: 'boss@test.com',
      password: 'hashedpw'
    });
    recipient = await User.create({
      username: 'manager',
      email: 'manager@test.com',
      password: 'hashedpw'
    });
    workspaceA = await Workspace.create({
      name: 'WS A',
      slug: 'ws-a',
      ownerId: owner._id
    });
    workspaceB = await Workspace.create({
      name: 'WS B',
      slug: 'ws-b',
      ownerId: owner._id
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  const baseMessage = () => ({
    workspaceId: workspaceA._id,
    fromUserId: owner._id,
    fromUsername: 'boss',
    toUserId: recipient._id,
    toUsername: 'manager',
    type: 'approval',
    subject: 'Schválenie faktúry'
  });

  describe('Creation & required fields', () => {
    it('should create a message with required fields and correct defaults', async () => {
      const msg = await Message.create(baseMessage());

      expect(msg._id).toBeDefined();
      expect(msg.status).toBe('pending');
      expect(msg.description).toBe('');
      expect(msg.linkedType).toBeNull();
      expect(msg.linkedId).toBeNull();
      expect(msg.linkedName).toBeNull();
      expect(msg.dueDate).toBeNull();
      expect(msg.pollMultipleChoice).toBe(false);
      expect(msg.resolvedBy).toBeNull();
      expect(msg.resolvedAt).toBeNull();
      expect(msg.comments).toHaveLength(0);
      expect(msg.files).toHaveLength(0);
      expect(msg.pollOptions).toHaveLength(0);
      expect(msg.readBy).toHaveLength(0);
    });

    it('should enforce workspaceId as required', async () => {
      const m = baseMessage();
      delete m.workspaceId;
      await expect(Message.create(m)).rejects.toThrow();
    });

    it('should enforce fromUserId as required', async () => {
      const m = baseMessage();
      delete m.fromUserId;
      await expect(Message.create(m)).rejects.toThrow();
    });

    it('should enforce toUserId as required', async () => {
      const m = baseMessage();
      delete m.toUserId;
      await expect(Message.create(m)).rejects.toThrow();
    });

    it('should enforce subject as required', async () => {
      const m = baseMessage();
      delete m.subject;
      await expect(Message.create(m)).rejects.toThrow();
    });

    it('should enforce type as required', async () => {
      const m = baseMessage();
      delete m.type;
      await expect(Message.create(m)).rejects.toThrow();
    });

    it('should reject invalid type values', async () => {
      const m = baseMessage();
      m.type = 'urgent-demand'; // not in enum
      await expect(Message.create(m)).rejects.toThrow();
    });

    it('should accept all valid type values', async () => {
      for (const type of ['approval', 'info', 'request', 'proposal', 'poll']) {
        const msg = await Message.create({ ...baseMessage(), type });
        expect(msg.type).toBe(type);
      }
    });

    it('should reject invalid status values', async () => {
      const m = baseMessage();
      m.status = 'archived'; // not in enum
      await expect(Message.create(m)).rejects.toThrow();
    });

    it('should enforce maxlength on subject (200)', async () => {
      const m = baseMessage();
      m.subject = 'a'.repeat(201);
      await expect(Message.create(m)).rejects.toThrow();
    });

    it('should enforce maxlength on description (5000)', async () => {
      const m = baseMessage();
      m.description = 'a'.repeat(5001);
      await expect(Message.create(m)).rejects.toThrow();
    });
  });

  describe('Linked entity (contact | task | null)', () => {
    it('should accept linkedType="contact" with linkedId and linkedName', async () => {
      const msg = await Message.create({
        ...baseMessage(),
        linkedType: 'contact',
        linkedId: 'contact-123',
        linkedName: 'Ivan Novák'
      });
      expect(msg.linkedType).toBe('contact');
      expect(msg.linkedId).toBe('contact-123');
      expect(msg.linkedName).toBe('Ivan Novák');
    });

    it('should accept linkedType="task"', async () => {
      const msg = await Message.create({
        ...baseMessage(),
        linkedType: 'task',
        linkedId: 'task-456'
      });
      expect(msg.linkedType).toBe('task');
    });

    it('should reject invalid linkedType', async () => {
      const m = baseMessage();
      m.linkedType = 'invoice'; // not in enum
      await expect(Message.create(m)).rejects.toThrow();
    });
  });

  describe('Embedded comments with reactions', () => {
    it('should store comments with reactions', async () => {
      const msg = await Message.create({
        ...baseMessage(),
        comments: [
          {
            userId: recipient._id,
            username: 'manager',
            text: 'Súhlasím, schvaľujem.',
            reactions: [
              { userId: owner._id, username: 'boss', type: 'like' }
            ]
          }
        ]
      });

      expect(msg.comments).toHaveLength(1);
      expect(msg.comments[0].text).toBe('Súhlasím, schvaľujem.');
      expect(msg.comments[0].reactions).toHaveLength(1);
      expect(msg.comments[0].reactions[0].type).toBe('like');
    });

    it('should reject invalid reaction type', async () => {
      await expect(
        Message.create({
          ...baseMessage(),
          comments: [
            {
              userId: recipient._id,
              username: 'manager',
              text: 'Test',
              reactions: [
                { userId: owner._id, username: 'boss', type: 'love' } // invalid
              ]
            }
          ]
        })
      ).rejects.toThrow();
    });

    it('should require text in comments', async () => {
      await expect(
        Message.create({
          ...baseMessage(),
          comments: [
            { userId: recipient._id, username: 'manager' } // missing text
          ]
        })
      ).rejects.toThrow();
    });
  });

  describe('Poll options', () => {
    it('should store poll options with votes', async () => {
      const msg = await Message.create({
        ...baseMessage(),
        type: 'poll',
        subject: 'Kedy stretnutie?',
        pollOptions: [
          { text: 'Pondelok', votes: [{ userId: recipient._id, username: 'manager' }] },
          { text: 'Utorok', votes: [] }
        ],
        pollMultipleChoice: false
      });

      expect(msg.pollOptions).toHaveLength(2);
      expect(msg.pollOptions[0].text).toBe('Pondelok');
      expect(msg.pollOptions[0].votes).toHaveLength(1);
      expect(msg.pollOptions[1].votes).toHaveLength(0);
    });

    it('should enforce maxlength on poll option text (200)', async () => {
      await expect(
        Message.create({
          ...baseMessage(),
          type: 'poll',
          pollOptions: [{ text: 'a'.repeat(201) }]
        })
      ).rejects.toThrow();
    });
  });

  describe('Workspace Isolation (P2)', () => {
    it('should NOT leak a message from Workspace A into Workspace B query', async () => {
      await Message.create({
        ...baseMessage(),
        subject: 'Secret in A'
      });

      const leaked = await Message.findOne({
        workspaceId: workspaceB._id,
        subject: 'Secret in A'
      });
      expect(leaked).toBeNull();
    });

    it('should return only messages from the queried workspace', async () => {
      await Message.create([
        { ...baseMessage(), workspaceId: workspaceA._id, subject: 'A1' },
        { ...baseMessage(), workspaceId: workspaceA._id, subject: 'A2' },
        { ...baseMessage(), workspaceId: workspaceB._id, subject: 'B1' }
      ]);

      const aMsgs = await Message.find({ workspaceId: workspaceA._id });
      const bMsgs = await Message.find({ workspaceId: workspaceB._id });

      expect(aMsgs).toHaveLength(2);
      expect(bMsgs).toHaveLength(1);
      expect(bMsgs[0].subject).toBe('B1');
    });

    it('should NOT allow update across workspace boundary', async () => {
      const msg = await Message.create(baseMessage());

      const result = await Message.findOneAndUpdate(
        { _id: msg._id, workspaceId: workspaceB._id },
        { status: 'approved' },
        { new: true }
      );

      expect(result).toBeNull();

      const unchanged = await Message.findById(msg._id);
      expect(unchanged.status).toBe('pending');
    });

    it('should NOT allow delete across workspace boundary', async () => {
      const msg = await Message.create(baseMessage());

      const res = await Message.deleteOne({
        _id: msg._id,
        workspaceId: workspaceB._id
      });

      expect(res.deletedCount).toBe(0);

      const stillThere = await Message.findById(msg._id);
      expect(stillThere).not.toBeNull();
    });
  });

  describe('toJSON transform — strip attachment data', () => {
    it('should remove attachment.data from JSON output while keeping metadata', async () => {
      const msg = await Message.create({
        ...baseMessage(),
        attachment: {
          id: 'att-1',
          originalName: 'faktura.pdf',
          mimetype: 'application/pdf',
          size: 12345,
          data: 'BIG_BASE64_PAYLOAD_...',
          uploadedAt: new Date()
        }
      });

      const json = msg.toJSON();

      expect(json.id).toBe(msg._id.toString());
      expect(json.attachment.originalName).toBe('faktura.pdf');
      expect(json.attachment.mimetype).toBe('application/pdf');
      expect(json.attachment.size).toBe(12345);
      // KRITICKÉ: data musí byť odstránené (list view perf)
      expect(json.attachment.data).toBeUndefined();
    });

    it('should not affect attachment when data is missing', async () => {
      const msg = await Message.create({
        ...baseMessage(),
        attachment: { originalName: 'text.txt', mimetype: 'text/plain', size: 10 }
      });
      const json = msg.toJSON();
      expect(json.attachment.originalName).toBe('text.txt');
    });
  });

  describe('Read tracking (readBy)', () => {
    it('should allow adding user IDs to readBy', async () => {
      const msg = await Message.create({
        ...baseMessage(),
        readBy: [recipient._id]
      });
      expect(msg.readBy).toHaveLength(1);
      expect(msg.readBy[0].toString()).toBe(recipient._id.toString());
    });
  });

  describe('Resolution fields', () => {
    it('should allow marking as approved with resolvedBy and resolvedAt', async () => {
      const now = new Date();
      const msg = await Message.create({
        ...baseMessage(),
        status: 'approved',
        resolvedBy: recipient._id,
        resolvedAt: now
      });

      expect(msg.status).toBe('approved');
      expect(msg.resolvedBy.toString()).toBe(recipient._id.toString());
      expect(msg.resolvedAt.getTime()).toBe(now.getTime());
    });

    it('should allow rejectionReason on rejected messages', async () => {
      const msg = await Message.create({
        ...baseMessage(),
        status: 'rejected',
        rejectionReason: 'Neschvaľujem — nedostatočné údaje.'
      });
      expect(msg.rejectionReason).toBe('Neschvaľujem — nedostatočné údaje.');
    });
  });
});
