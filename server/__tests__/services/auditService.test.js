const mongoose = require('mongoose');
const auditService = require('../../services/auditService');
const AuditLog = require('../../models/AuditLog');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');

/**
 * auditService testy — thin wrapper nad AuditLog modelom.
 *
 * Design rationale (viď server/services/auditService.js):
 *   - logAction NESMIE shodiť flow pri zlyhaní — audit je side-channel (fire-and-forget).
 *     Chyby sa logujú, ale ticho sa vrátia (try/catch blok).
 *   - Testujeme: šťastná cesta + graceful degradation (invalid data by nemalo hodiť).
 */
describe('auditService', () => {
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
      username: 'actor',
      email: 'actor@test.com',
      password: 'hashedpw'
    });
    workspace = await Workspace.create({
      name: 'Target WS',
      slug: 'target',
      ownerId: user._id
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('logAction', () => {
    it('should persist an audit log entry', async () => {
      await auditService.logAction({
        userId: user._id,
        username: 'actor',
        email: 'actor@test.com',
        action: 'user.login',
        category: 'auth',
        targetType: 'user',
        targetId: user._id.toString(),
        targetName: 'actor',
        details: { method: 'password' },
        ipAddress: '192.168.1.10',
        userAgent: 'Safari/17',
        workspaceId: workspace._id
      });

      const logs = await AuditLog.find({});
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('user.login');
      expect(logs[0].category).toBe('auth');
      expect(logs[0].details.method).toBe('password');
      expect(logs[0].ipAddress).toBe('192.168.1.10');
    });

    it('should persist system actions (no workspaceId)', async () => {
      await auditService.logAction({
        action: 'system.cron_run',
        category: 'system',
        details: { job: 'due-date-checker' }
      });
      const logs = await AuditLog.find({});
      expect(logs).toHaveLength(1);
      expect(logs[0].workspaceId).toBeUndefined();
    });

    it('should NOT throw when schema validation fails (fire-and-forget)', async () => {
      // action je required — úmyselne vynechané.
      // Audit zlyhanie nesmie shodiť business logiku (napr. user update),
      // preto je logAction obalený v try/catch a len loguje chybu.
      await expect(
        auditService.logAction({ category: 'user' })
      ).resolves.toBeUndefined();

      // No log was persisted (validation failed silently)
      const logs = await AuditLog.find({});
      expect(logs).toHaveLength(0);
    });

    it('should NOT throw with unknown category (fire-and-forget)', async () => {
      await expect(
        auditService.logAction({
          action: 'x.y',
          category: 'not_a_real_category'
        })
      ).resolves.toBeUndefined();
      expect(await AuditLog.countDocuments({})).toBe(0);
    });

    it('should handle missing optional fields gracefully', async () => {
      await auditService.logAction({
        action: 'user.created',
        category: 'user'
      });
      const log = await AuditLog.findOne({ action: 'user.created' });
      expect(log).not.toBeNull();
      expect(log.userId).toBeUndefined();
      expect(log.username).toBeUndefined();
      expect(log.details).toBeUndefined();
    });

    it('should persist multiple entries sequentially', async () => {
      await auditService.logAction({ action: 'user.login', category: 'auth' });
      await auditService.logAction({ action: 'user.logout', category: 'auth' });
      await auditService.logAction({ action: 'contact.created', category: 'contact' });

      expect(await AuditLog.countDocuments({})).toBe(3);
      expect(await AuditLog.countDocuments({ category: 'auth' })).toBe(2);
    });
  });
});
