const mongoose = require('mongoose');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');

/**
 * Workspace model testy — P2 multi-tenancy foundation.
 *
 * Workspace je koreňová entita pre multi-tenant izoláciu — ak tu niečo
 * zlyhá (napr. duplicitný slug), rozpadne sa celá izolácia dát medzi
 * tenantmi. Viď GEMMA_PROJECT_GUIDE.md §2 Multi-tenancy.
 */
describe('Workspace model', () => {
  let owner;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
  });

  beforeEach(async () => {
    await Workspace.deleteMany({});
    await User.deleteMany({});

    owner = await User.create({
      username: 'owner',
      email: 'owner@test.com',
      password: 'hashedpassword123'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Creation & required fields', () => {
    it('should create a workspace with required fields', async () => {
      const ws = await Workspace.create({
        name: 'Acme Inc',
        slug: 'acme-inc',
        ownerId: owner._id
      });

      expect(ws._id).toBeDefined();
      expect(ws.name).toBe('Acme Inc');
      expect(ws.slug).toBe('acme-inc');
      expect(ws.ownerId.toString()).toBe(owner._id.toString());
      expect(ws.color).toBe('#6366f1'); // default brand color
      expect(ws.paidSeats).toBe(0);
      expect(ws.settings.allowMemberInvites).toBe(false);
      expect(ws.settings.defaultMemberRole).toBe('member');
    });

    it('should enforce name as required', async () => {
      await expect(
        Workspace.create({
          slug: 'no-name',
          ownerId: owner._id
        })
      ).rejects.toThrow();
    });

    it('should enforce slug as required', async () => {
      await expect(
        Workspace.create({
          name: 'No Slug',
          ownerId: owner._id
        })
      ).rejects.toThrow();
    });

    it('should enforce ownerId as required', async () => {
      await expect(
        Workspace.create({
          name: 'Orphan',
          slug: 'orphan'
        })
      ).rejects.toThrow();
    });

    it('should lowercase the slug', async () => {
      const ws = await Workspace.create({
        name: 'Mixed Case',
        slug: 'MixedCase',
        ownerId: owner._id
      });
      expect(ws.slug).toBe('mixedcase');
    });

    it('should enforce maxlength on name (100)', async () => {
      const longName = 'a'.repeat(101);
      await expect(
        Workspace.create({
          name: longName,
          slug: 'long-name',
          ownerId: owner._id
        })
      ).rejects.toThrow();
    });
  });

  describe('Unique constraints (P2 critical)', () => {
    it('should enforce unique slug across workspaces', async () => {
      await Workspace.create({
        name: 'First',
        slug: 'duplicate-slug',
        ownerId: owner._id
      });

      await expect(
        Workspace.create({
          name: 'Second',
          slug: 'duplicate-slug',
          ownerId: owner._id
        })
      ).rejects.toThrow(/duplicate key|E11000/i);
    });

    it('should enforce unique inviteCode when provided (sparse index)', async () => {
      await Workspace.create({
        name: 'WS1',
        slug: 'ws1',
        ownerId: owner._id,
        inviteCode: 'SAMEINVITE'
      });

      await expect(
        Workspace.create({
          name: 'WS2',
          slug: 'ws2',
          ownerId: owner._id,
          inviteCode: 'SAMEINVITE'
        })
      ).rejects.toThrow(/duplicate key|E11000/i);
    });

    it('should allow multiple workspaces without inviteCode (sparse index)', async () => {
      // Sparse index — null/undefined sa v indexe neobjavuje, takže
      // viacero workspacov môže existovať bez inviteCode.
      await Workspace.create({
        name: 'No Code 1',
        slug: 'no-code-1',
        ownerId: owner._id
      });

      const ws2 = await Workspace.create({
        name: 'No Code 2',
        slug: 'no-code-2',
        ownerId: owner._id
      });

      expect(ws2._id).toBeDefined();
    });
  });

  describe('Statics — generateSlug', () => {
    it('should generate a clean slug from name', async () => {
      const slug = await Workspace.generateSlug('Moja Firma s.r.o.');
      expect(slug).toBe('moja-firma-s-r-o');
    });

    it('should strip diacritics from slug', async () => {
      const slug = await Workspace.generateSlug('Žltý Kôň');
      expect(slug).toBe('zlty-kon');
    });

    it('should add counter suffix when slug exists', async () => {
      await Workspace.create({
        name: 'Acme',
        slug: 'acme',
        ownerId: owner._id
      });

      const next = await Workspace.generateSlug('Acme');
      expect(next).toBe('acme-1');

      await Workspace.create({
        name: 'Acme',
        slug: next,
        ownerId: owner._id
      });

      const afterThat = await Workspace.generateSlug('Acme');
      expect(afterThat).toBe('acme-2');
    });

    it('should strip leading/trailing dashes', async () => {
      const slug = await Workspace.generateSlug('---Tesla---');
      expect(slug).toBe('tesla');
    });
  });

  describe('Statics — generateInviteCode', () => {
    it('should generate an 8-char uppercase hex code', () => {
      const code = Workspace.generateInviteCode();
      expect(code).toMatch(/^[0-9A-F]{8}$/);
    });

    it('should generate different codes on subsequent calls', () => {
      const a = Workspace.generateInviteCode();
      const b = Workspace.generateInviteCode();
      expect(a).not.toBe(b);
    });
  });

  describe('toJSON virtual id', () => {
    it('should expose id field (string) in JSON output', async () => {
      const ws = await Workspace.create({
        name: 'JSON Test',
        slug: 'json-test',
        ownerId: owner._id
      });
      const json = ws.toJSON();
      expect(json.id).toBe(ws._id.toString());
    });
  });
});
