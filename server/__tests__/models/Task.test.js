const mongoose = require('mongoose');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const Task = require('../../models/Task');

describe('Task model - Workspace Isolation (P2 Guard)', () => {
  let owner;
  let workspaceA;
  let workspaceB;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await Task.init();
  });

  beforeEach(async () => {
    await Task.deleteMany({});
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

  describe('Workspace Isolation (P2)', () => {
    it('should NOT find a task from Workspace A when querying for Workspace B', async () => {
      await Task.create({
        workspaceId: workspaceA._id,
        title: 'Secret Task in A',
        description: 'This should not be visible in B',
        userId: owner._id
      });

      const foundTask = await Task.findOne({ 
        workspaceId: workspaceB._id,
        title: 'Secret Task in A' 
      });

      expect(foundTask).toBeNull();
    });

    it('should find the task when using the correct workspaceId', async () => {
      await Task.create({
        workspaceId: workspaceA._id,
        title: 'Visible Task in A',
        description: 'This should be found'
      });

      const foundTask = await Task.findOne({ 
        workspaceId: workspaceA._id,
        title: 'Visible Task in A' 
      });

      expect(foundTask).not.toBeNull();
      expect(foundTask.title).toBe('Visible Task in A');
    });
  });

  describe('Data Integrity', () => {
    it('should enforce workspaceId as a required field', async () => {
      await expect(
        Task.create({
          title: 'Orphan Task',
          description: 'No workspace context'
        })
      ).rejects.toThrow();
    });

    it('should correctly store and retrieve subtasks', async () => {
      const taskWithSubtasks = await Task.create({
        workspaceId: workspaceA._id,
        title: 'Parent Task',
        subtasks: [
          { id: 'sub-1', title: 'Subtask 1', completed: false },
          { id: 'sub-2', title: 'Subtask 2', completed: true }
        ]
      });

      const fetchedTask = await Task.findById(taskWithSubtasks._id);

      expect(fetchedTask.subtasks).toHaveLength(2);
      expect(fetchedTask.subtasks[0].title).toBe('Subtask 1');
      expect(fetchedTask.subtasks[1].completed).toBe(true);
    });
  });
});
