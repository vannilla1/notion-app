const mongoose = require('mongoose');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const AuditLog = require('../../models/AuditLog');

/**
 * AuditLog model testy — admin panel audit trail.
 *
 * Invariants (viď server/models/AuditLog.js):
 *   - action je required (napr. 'user.role_changed', 'workspace.deleted')
 *   - category enum: user | workspace | contact | task | message | system |
 *     auth | billing
 *   - TTL index: auto-delete po 90 dňoch (neudržiavať log navždy kvôli GDPR)
 *   - workspaceId je voliteľný (system-wide actions ho nemajú)
 *   - timestamps: false — managed manually cez createdAt default
 */
describe('AuditLog model', () => {
  let user;
  let workspace;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await AuditLog.init();
  });

  beforeEach(async () => {
    await AuditLog.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    user = await User.create({
      username: 'admin',
      email: 'admin@test.com',
      password: 'hashedpw'
    });
    workspace = await Workspace.create({
      name: 'Target WS',
      slug: 'target-ws',
      ownerId: user._id
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Creation & required fields', () => {
    it('should create an audit log entry with required fields', async () => {
      const log = await AuditLog.create({
        userId: user._id,
        username: 'admin',
        email: 'admin@test.com',
        action: 'user.role_changed',
        category: 'user',
        targetType: 'user',
        targetId: user._id.toString(),
        targetName: 'admin',
        details: { oldRole: 'member', newRole: 'admin' },
        ipAddress: '127.0.0.1',
        userAgent: 'Chrome/120'
      });

      expect(log._id).toBeDefined();
      expect(log.action).toBe('user.role_changed');
      expect(log.category).toBe('user');
      expect(log.details.oldRole).toBe('member');
      expect(log.createdAt).toBeInstanceOf(Date);
    });

    it('should enforce action as required', async () => {
      await expect(
        AuditLog.create({ category: 'user' })
      ).rejects.toThrow();
    });

    it('should allow workspace-less system actions', async () => {
      // Systémové akcie (napr. cron job, backup) nemajú workspaceId.
      const log = await AuditLog.create({
        action: 'system.backup_completed',
        category: 'system',
        details: { size: 12345 }
      });
      expect(log._id).toBeDefined();
      expect(log.workspaceId).toBeUndefined();
    });
  });

  describe('Category enum', () => {
    const cats = ['user', 'workspace', 'contact', 'task', 'message', 'system', 'auth', 'billing'];

    it.each(cats)('should accept category="%s"', async (c) => {
      const log = await AuditLog.create({
        action: 'x.y',
        category: c
      });
      expect(log.category).toBe(c);
    });

    it('should reject unknown category', async () => {
      await expect(
        AuditLog.create({ action: 'x.y', category: 'finance' })
      ).rejects.toThrow();
    });
  });

  describe('Mixed details field', () => {
    it('should store arbitrary details payload', async () => {
      const log = await AuditLog.create({
        action: 'user.plan_changed',
        category: 'billing',
        details: {
          from: { plan: 'free', seats: 2 },
          to: { plan: 'pro', seats: 5 },
          reason: 'upgrade',
          metadata: { promoCode: 'SUMMER20', discount: 20 }
        }
      });

      const fetched = await AuditLog.findById(log._id);
      expect(fetched.details.from.plan).toBe('free');
      expect(fetched.details.to.seats).toBe(5);
      expect(fetched.details.metadata.promoCode).toBe('SUMMER20');
    });
  });

  describe('Common queries', () => {
    it('should filter logs by category', async () => {
      await AuditLog.create([
        { action: 'user.created', category: 'user' },
        { action: 'user.deleted', category: 'user' },
        { action: 'workspace.created', category: 'workspace' }
      ]);

      const userLogs = await AuditLog.find({ category: 'user' });
      expect(userLogs).toHaveLength(2);
    });

    it('should filter logs by workspaceId', async () => {
      await AuditLog.create([
        { action: 'contact.created', category: 'contact', workspaceId: workspace._id },
        { action: 'system.backup', category: 'system' } // bez workspaceId
      ]);

      const wsLogs = await AuditLog.find({ workspaceId: workspace._id });
      expect(wsLogs).toHaveLength(1);
      expect(wsLogs[0].action).toBe('contact.created');
    });

    it('should sort by createdAt desc for activity feed', async () => {
      const old = await AuditLog.create({
        action: 'old.action',
        category: 'user',
        createdAt: new Date('2025-01-01')
      });
      const recent = await AuditLog.create({
        action: 'recent.action',
        category: 'user',
        createdAt: new Date('2026-04-15')
      });

      const sorted = await AuditLog.find({}).sort({ createdAt: -1 });
      expect(sorted[0]._id.toString()).toBe(recent._id.toString());
      expect(sorted[1]._id.toString()).toBe(old._id.toString());
    });
  });

  describe('TTL auto-delete (90 days)', () => {
    it('should have TTL index on createdAt with 90-day expireAfterSeconds', async () => {
      const indexes = await AuditLog.collection.indexes();
      const ttl = indexes.find(
        (idx) => idx.key && idx.key.createdAt === 1 && typeof idx.expireAfterSeconds === 'number'
      );
      expect(ttl).toBeDefined();
      expect(ttl.expireAfterSeconds).toBe(90 * 24 * 60 * 60); // 90 days in seconds
    });
  });
});
