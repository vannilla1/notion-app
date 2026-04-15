const mongoose = require('mongoose');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const Page = require('../../models/Page');

/**
 * Page model testy — notion-style hierarchická stránková štruktúra.
 *
 * Invariants (viď server/models/Page.js):
 *   - workspaceId, userId sú required (P2 Workspace Isolation)
 *   - title default 'Untitled', content default ''
 *   - parentId default null (root page)
 *   - self-reference cez ref: 'Page' (nested pages)
 *   - toJSON transform: _id → id (stringified)
 */
describe('Page model', () => {
  let owner;
  let workspaceA;
  let workspaceB;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await Page.init();
  });

  beforeEach(async () => {
    await Page.deleteMany({});
    await Workspace.deleteMany({});
    await User.deleteMany({});

    owner = await User.create({
      username: 'author',
      email: 'author@test.com',
      password: 'hashedpw'
    });
    workspaceA = await Workspace.create({
      name: 'Workspace A',
      slug: 'ws-a',
      ownerId: owner._id
    });
    workspaceB = await Workspace.create({
      name: 'Workspace B',
      slug: 'ws-b',
      ownerId: owner._id
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('Creation & defaults', () => {
    it('should create a page with defaults', async () => {
      const page = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id
      });

      expect(page._id).toBeDefined();
      expect(page.title).toBe('Untitled');
      expect(page.content).toBe('');
      expect(page.parentId).toBeNull();
      expect(page.createdAt).toBeInstanceOf(Date);
      expect(page.updatedAt).toBeInstanceOf(Date);
    });

    it('should enforce workspaceId as required', async () => {
      await expect(
        Page.create({ userId: owner._id, title: 'Orphan' })
      ).rejects.toThrow();
    });

    it('should enforce userId as required', async () => {
      await expect(
        Page.create({ workspaceId: workspaceA._id, title: 'Anonymous' })
      ).rejects.toThrow();
    });

    it('should accept custom title, content, icon', async () => {
      const page = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'Project roadmap',
        content: '# H1\n\nBody text...',
        icon: '📋'
      });
      expect(page.title).toBe('Project roadmap');
      expect(page.content).toBe('# H1\n\nBody text...');
      expect(page.icon).toBe('📋');
    });
  });

  describe('Parent/child hierarchy', () => {
    it('should create nested pages via parentId', async () => {
      const root = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'Root'
      });
      const child = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'Child',
        parentId: root._id
      });
      expect(child.parentId.toString()).toBe(root._id.toString());
    });

    it('should find children of a given parent', async () => {
      const root = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'Root'
      });
      await Page.create([
        { workspaceId: workspaceA._id, userId: owner._id, title: 'C1', parentId: root._id },
        { workspaceId: workspaceA._id, userId: owner._id, title: 'C2', parentId: root._id }
      ]);

      const children = await Page.find({
        workspaceId: workspaceA._id,
        parentId: root._id
      });
      expect(children).toHaveLength(2);
    });

    it('should find root pages (parentId=null)', async () => {
      const root = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'Root'
      });
      await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'Child',
        parentId: root._id
      });

      const roots = await Page.find({
        workspaceId: workspaceA._id,
        parentId: null
      });
      expect(roots).toHaveLength(1);
      expect(roots[0].title).toBe('Root');
    });
  });

  describe('Workspace isolation (P2 Guard)', () => {
    it('should only return pages from a single workspace', async () => {
      await Page.create([
        { workspaceId: workspaceA._id, userId: owner._id, title: 'A-1' },
        { workspaceId: workspaceA._id, userId: owner._id, title: 'A-2' },
        { workspaceId: workspaceB._id, userId: owner._id, title: 'B-1' }
      ]);

      const aPages = await Page.find({ workspaceId: workspaceA._id });
      const bPages = await Page.find({ workspaceId: workspaceB._id });

      expect(aPages).toHaveLength(2);
      expect(bPages).toHaveLength(1);
      expect(bPages[0].title).toBe('B-1');
    });

    it('should not leak pages to other workspaces when querying by parentId', async () => {
      const rootA = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'Root A'
      });
      // Cross-workspace child (should not exist in practice, but guard anyway)
      await Page.create({
        workspaceId: workspaceB._id,
        userId: owner._id,
        title: 'Stray B',
        parentId: rootA._id
      });

      const scoped = await Page.find({
        workspaceId: workspaceA._id,
        parentId: rootA._id
      });
      expect(scoped).toHaveLength(0);
    });
  });

  describe('toJSON transform', () => {
    it('should expose stringified id virtual', async () => {
      const page = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'JSON test'
      });
      const json = page.toJSON();
      expect(json.id).toBe(page._id.toString());
      expect(typeof json.id).toBe('string');
    });
  });

  describe('Sorting by updatedAt', () => {
    it('should support recent-first ordering for sidebar lists', async () => {
      const older = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'Older'
      });
      // Small delay to ensure distinct updatedAt
      await new Promise((r) => setTimeout(r, 20));
      const newer = await Page.create({
        workspaceId: workspaceA._id,
        userId: owner._id,
        title: 'Newer'
      });

      const sorted = await Page.find({ workspaceId: workspaceA._id }).sort({ updatedAt: -1 });
      expect(sorted[0]._id.toString()).toBe(newer._id.toString());
      expect(sorted[1]._id.toString()).toBe(older._id.toString());
    });
  });
});
