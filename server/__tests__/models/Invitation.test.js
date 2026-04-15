const mongoose = require('mongoose');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const Invitation = require('../../models/Invitation');

/**
 * Invitation model testy — workspace invite flow (email + token).
 *
 * Invariants (viď server/models/Invitation.js):
 *   - workspaceId, email, invitedBy sú required
 *   - email je lowercase + trim (case-insensitive lookup)
 *   - token je unique, auto-generovaný (crypto.randomBytes(32).toString('hex') = 64 chars)
 *   - role enum: manager | member (nie owner — owner nemôže byť pozvaný)
 *   - status enum: pending | accepted | expired | cancelled
 *   - expiresAt default = +7 dní, TTL index auto-delete
 */
describe('Invitation model', () => {
  let owner;
  let workspace;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await Invitation.init();
  });

  beforeEach(async () => {
    await Invitation.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    owner = await User.create({
      username: 'owner',
      email: 'owner@test.com',
      password: 'hashedpw'
    });
    workspace = await Workspace.create({
      name: 'Invite WS',
      slug: 'invite-ws',
      ownerId: owner._id
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Creation & defaults', () => {
    it('should create an invitation with auto-generated token and defaults', async () => {
      const inv = await Invitation.create({
        workspaceId: workspace._id,
        email: 'invitee@test.com',
        invitedBy: owner._id
      });

      expect(inv._id).toBeDefined();
      expect(inv.token).toBeDefined();
      expect(inv.token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
      expect(inv.role).toBe('member');
      expect(inv.status).toBe('pending');
      expect(inv.expiresAt).toBeInstanceOf(Date);

      // Default expiresAt ~7 dní dopredu
      const diffDays = (inv.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(6.9);
      expect(diffDays).toBeLessThan(7.1);
    });

    it('should lowercase and trim the email', async () => {
      const inv = await Invitation.create({
        workspaceId: workspace._id,
        email: '  UPPER@Example.COM  ',
        invitedBy: owner._id
      });
      expect(inv.email).toBe('upper@example.com');
    });

    it('should enforce workspaceId as required', async () => {
      await expect(
        Invitation.create({
          email: 'x@test.com',
          invitedBy: owner._id
        })
      ).rejects.toThrow();
    });

    it('should enforce email as required', async () => {
      await expect(
        Invitation.create({
          workspaceId: workspace._id,
          invitedBy: owner._id
        })
      ).rejects.toThrow();
    });

    it('should enforce invitedBy as required', async () => {
      await expect(
        Invitation.create({
          workspaceId: workspace._id,
          email: 'x@test.com'
        })
      ).rejects.toThrow();
    });
  });

  describe('Role enum', () => {
    it.each(['manager', 'member'])('should accept role="%s"', async (role) => {
      const inv = await Invitation.create({
        workspaceId: workspace._id,
        email: `${role}@test.com`,
        invitedBy: owner._id,
        role
      });
      expect(inv.role).toBe(role);
    });

    it('should reject role="owner" (owner cannot be invited)', async () => {
      // Owner sa priradí len pri založení workspacu, nikdy cez pozvánku.
      await expect(
        Invitation.create({
          workspaceId: workspace._id,
          email: 'fake-owner@test.com',
          invitedBy: owner._id,
          role: 'owner'
        })
      ).rejects.toThrow();
    });
  });

  describe('Status enum', () => {
    it.each(['pending', 'accepted', 'expired', 'cancelled'])(
      'should accept status="%s"',
      async (status) => {
        const inv = await Invitation.create({
          workspaceId: workspace._id,
          email: `${status}@test.com`,
          invitedBy: owner._id,
          status
        });
        expect(inv.status).toBe(status);
      }
    );

    it('should reject unknown status', async () => {
      await expect(
        Invitation.create({
          workspaceId: workspace._id,
          email: 'bad@test.com',
          invitedBy: owner._id,
          status: 'revoked'
        })
      ).rejects.toThrow();
    });
  });

  describe('Unique token constraint', () => {
    it('should enforce unique token across invitations', async () => {
      const sharedToken = 'abc123-shared-token';
      await Invitation.create({
        workspaceId: workspace._id,
        email: 'first@test.com',
        invitedBy: owner._id,
        token: sharedToken
      });

      await expect(
        Invitation.create({
          workspaceId: workspace._id,
          email: 'second@test.com',
          invitedBy: owner._id,
          token: sharedToken
        })
      ).rejects.toThrow(/duplicate key|E11000/i);
    });

    it('should auto-generate different tokens for different invitations', async () => {
      const a = await Invitation.create({
        workspaceId: workspace._id,
        email: 'a@test.com',
        invitedBy: owner._id
      });
      const b = await Invitation.create({
        workspaceId: workspace._id,
        email: 'b@test.com',
        invitedBy: owner._id
      });
      expect(a.token).not.toBe(b.token);
    });
  });

  describe('Common queries', () => {
    it('should find invitation by token (primary acceptance flow)', async () => {
      const inv = await Invitation.create({
        workspaceId: workspace._id,
        email: 'find-by-token@test.com',
        invitedBy: owner._id
      });

      const found = await Invitation.findOne({ token: inv.token });
      expect(found).not.toBeNull();
      expect(found.email).toBe('find-by-token@test.com');
    });

    it('should find pending invitations for a workspace', async () => {
      await Invitation.create([
        { workspaceId: workspace._id, email: 'p1@test.com', invitedBy: owner._id, status: 'pending' },
        { workspaceId: workspace._id, email: 'p2@test.com', invitedBy: owner._id, status: 'pending' },
        { workspaceId: workspace._id, email: 'a@test.com', invitedBy: owner._id, status: 'accepted' }
      ]);

      const pending = await Invitation.find({
        workspaceId: workspace._id,
        status: 'pending'
      });
      expect(pending).toHaveLength(2);
    });

    it('should flip status from pending to accepted', async () => {
      const inv = await Invitation.create({
        workspaceId: workspace._id,
        email: 'accepter@test.com',
        invitedBy: owner._id
      });

      inv.status = 'accepted';
      await inv.save();

      const refetched = await Invitation.findById(inv._id);
      expect(refetched.status).toBe('accepted');
    });
  });

  describe('TTL auto-delete', () => {
    it('should have TTL index on expiresAt with expireAfterSeconds=0', async () => {
      const indexes = await Invitation.collection.indexes();
      const ttl = indexes.find(
        (idx) => idx.key && idx.key.expiresAt === 1 && typeof idx.expireAfterSeconds === 'number'
      );
      expect(ttl).toBeDefined();
      expect(ttl.expireAfterSeconds).toBe(0);
    });

    it('should allow custom expiresAt (e.g. 24h for dev)', async () => {
      const oneDay = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const inv = await Invitation.create({
        workspaceId: workspace._id,
        email: 'dev@test.com',
        invitedBy: owner._id,
        expiresAt: oneDay
      });
      expect(inv.expiresAt.getTime()).toBe(oneDay.getTime());
    });
  });
});
