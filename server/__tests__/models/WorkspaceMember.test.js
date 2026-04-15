const mongoose = require('mongoose');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * WorkspaceMember model testy — role-based access + membership uniqueness.
 *
 * WorkspaceMember je join table medzi User a Workspace s role fieldom.
 * Dôležité invarianty:
 *   - User môže byť v jednom workspace max 1× (compound unique index)
 *   - Role je enum: owner | manager | member
 *   - canAdmin() = owner || manager (používa sa v middleware na kontrolu oprávnení)
 * Viď GEMMA_PROJECT_GUIDE.md §2.1 Role-based access.
 */
describe('WorkspaceMember model', () => {
  let owner;
  let member;
  let workspaceA;
  let workspaceB;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
  });

  beforeEach(async () => {
    await WorkspaceMember.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    owner = await User.create({
      username: 'owner',
      email: 'owner@test.com',
      password: 'hashedpw'
    });
    member = await User.create({
      username: 'member',
      email: 'member@test.com',
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

  describe('Creation & required fields', () => {
    it('should create a membership with default role=member', async () => {
      const m = await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: member._id
      });

      expect(m._id).toBeDefined();
      expect(m.role).toBe('member');
      expect(m.joinedAt).toBeDefined();
      expect(m.invitedBy).toBeNull();
    });

    it('should enforce workspaceId as required', async () => {
      await expect(
        WorkspaceMember.create({ userId: member._id })
      ).rejects.toThrow();
    });

    it('should enforce userId as required', async () => {
      await expect(
        WorkspaceMember.create({ workspaceId: workspaceA._id })
      ).rejects.toThrow();
    });

    it('should reject invalid role values', async () => {
      await expect(
        WorkspaceMember.create({
          workspaceId: workspaceA._id,
          userId: member._id,
          role: 'superadmin'
        })
      ).rejects.toThrow();
    });

    it('should accept valid role values (owner|manager|member)', async () => {
      for (const role of ['owner', 'manager', 'member']) {
        const m = await WorkspaceMember.create({
          workspaceId: workspaceA._id,
          userId: new mongoose.Types.ObjectId(),
          role
        });
        expect(m.role).toBe(role);
      }
    });
  });

  describe('Unique membership constraint (P2 critical)', () => {
    it('should not allow a user to be added twice to the same workspace', async () => {
      await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: member._id,
        role: 'member'
      });

      await expect(
        WorkspaceMember.create({
          workspaceId: workspaceA._id,
          userId: member._id,
          role: 'manager'
        })
      ).rejects.toThrow(/duplicate key|E11000/i);
    });

    it('should allow the same user to be member of multiple workspaces', async () => {
      // User môže byť v WS-A aj vo WS-B, to je legitímne
      await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: member._id
      });

      const mB = await WorkspaceMember.create({
        workspaceId: workspaceB._id,
        userId: member._id
      });

      expect(mB._id).toBeDefined();

      const memberships = await WorkspaceMember.find({ userId: member._id });
      expect(memberships).toHaveLength(2);
    });
  });

  describe('Instance methods — canAdmin() & isOwner()', () => {
    it('owner should pass canAdmin() and isOwner()', async () => {
      const m = await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        role: 'owner'
      });
      expect(m.canAdmin()).toBe(true);
      expect(m.isOwner()).toBe(true);
    });

    it('manager should pass canAdmin() but NOT isOwner()', async () => {
      const m = await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: member._id,
        role: 'manager'
      });
      expect(m.canAdmin()).toBe(true);
      expect(m.isOwner()).toBe(false);
    });

    it('member should fail canAdmin() and isOwner()', async () => {
      const m = await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: member._id,
        role: 'member'
      });
      expect(m.canAdmin()).toBe(false);
      expect(m.isOwner()).toBe(false);
    });
  });

  describe('Workspace isolation queries (P2)', () => {
    it('should return only members of the queried workspace', async () => {
      await WorkspaceMember.create([
        { workspaceId: workspaceA._id, userId: owner._id, role: 'owner' },
        { workspaceId: workspaceA._id, userId: member._id, role: 'member' },
        { workspaceId: workspaceB._id, userId: owner._id, role: 'owner' }
      ]);

      const aMembers = await WorkspaceMember.find({ workspaceId: workspaceA._id });
      const bMembers = await WorkspaceMember.find({ workspaceId: workspaceB._id });

      expect(aMembers).toHaveLength(2);
      expect(bMembers).toHaveLength(1);
      expect(bMembers[0].userId.toString()).toBe(owner._id.toString());
    });

    it('should not leak membership when querying with wrong workspaceId', async () => {
      await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: member._id,
        role: 'manager'
      });

      const leaked = await WorkspaceMember.findOne({
        workspaceId: workspaceB._id,
        userId: member._id
      });

      expect(leaked).toBeNull();
    });
  });

  describe('Tracking fields', () => {
    it('should set invitedBy when provided', async () => {
      const m = await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: member._id,
        invitedBy: owner._id
      });
      expect(m.invitedBy.toString()).toBe(owner._id.toString());
    });

    it('should auto-set joinedAt timestamp', async () => {
      const before = Date.now();
      const m = await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: member._id
      });
      const after = Date.now();
      expect(m.joinedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(m.joinedAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('should have timestamps (createdAt, updatedAt)', async () => {
      const m = await WorkspaceMember.create({
        workspaceId: workspaceA._id,
        userId: member._id
      });
      expect(m.createdAt).toBeDefined();
      expect(m.updatedAt).toBeDefined();
    });
  });
});
