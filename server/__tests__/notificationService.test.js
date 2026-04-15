const mongoose = require('mongoose');
const notificationService = require('../services/notificationService');
const Notification = require('../models/Notification');
const User = require('../models/User');
const WorkspaceMember = require('../models/WorkspaceMember');

describe('NotificationService', () => {
  let mockIo;
  let testUser1;
  let testUser2;
  let testUser3;
  let testWorkspaceId;

  beforeEach(async () => {
    // Create mock Socket.IO
    mockIo = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn()
    };
    notificationService.initialize(mockIo);

    testWorkspaceId = new mongoose.Types.ObjectId();

    // Create test users
    testUser1 = await User.create({
      username: 'testuser1',
      email: 'test1@test.com',
      password: 'hashedpassword123'
    });

    testUser2 = await User.create({
      username: 'testuser2',
      email: 'test2@test.com',
      password: 'hashedpassword123'
    });

    testUser3 = await User.create({
      username: 'testuser3',
      email: 'test3@test.com',
      password: 'hashedpassword123'
    });

    // Add all users to the same workspace
    await WorkspaceMember.create([
      { workspaceId: testWorkspaceId, userId: testUser1._id, role: 'owner' },
      { workspaceId: testWorkspaceId, userId: testUser2._id, role: 'member' },
      { workspaceId: testWorkspaceId, userId: testUser3._id, role: 'member' }
    ]);
  });

  describe('getNotificationTitle', () => {
    it('should generate correct title for contact.created', () => {
      const title = notificationService.getNotificationTitle(
        'contact.created',
        'Jan',
        'Firma XYZ'
      );
      expect(title).toBe('Jan vytvoril nový kontakt: Firma XYZ');
    });

    it('should generate correct title for task.assigned', () => {
      const title = notificationService.getNotificationTitle(
        'task.assigned',
        'Peter',
        'Dokončiť projekt'
      );
      expect(title).toBe('Peter vám priradil projekt: Dokončiť projekt');
    });

    it('should generate correct title for task.completed', () => {
      const title = notificationService.getNotificationTitle(
        'task.completed',
        'Maria',
        'Review kódu'
      );
      expect(title).toBe('Maria dokončil projekt: Review kódu');
    });

    it('should generate correct title for subtask.created', () => {
      const title = notificationService.getNotificationTitle(
        'subtask.created',
        'Admin',
        'Napísať testy'
      );
      expect(title).toBe('Admin pridal úlohu: Napísať testy');
    });

    it('should use default actor name when not provided', () => {
      const title = notificationService.getNotificationTitle(
        'contact.deleted',
        null,
        'Starý kontakt'
      );
      expect(title).toBe('Niekto vymazal kontakt: Starý kontakt');
    });

    it('should handle missing related name', () => {
      const title = notificationService.getNotificationTitle(
        'task.updated',
        'Jan',
        null
      );
      expect(title).toBe('Jan upravil projekt');
    });

    it('should return default for unknown type', () => {
      const title = notificationService.getNotificationTitle(
        'unknown.type',
        'Jan',
        'Niečo'
      );
      expect(title).toBe('Nová notifikácia');
    });
  });

  describe('generateNotificationUrl — deep-link resolver', () => {
    // Regresné testy: task notifikácie NESMÚ obsahovať &contactId= v URL,
    // pretože Tasks.jsx má useEffect, ktorý pri detekcii contactId v URL
    // volá navigate('/tasks', { replace: true }) a tým zmaže highlightTask.
    // Výsledok by bol, že notifikácia otvorí filtrovaný zoznam tasks
    // pre kontakt a hľadaná úloha sa nezvýrazni.
    it('task.* deep-link nesmie obsahovať contactId v query (regression)', () => {
      const url = notificationService.generateNotificationUrl('task.updated', {
        taskId: 'task-123',
        contactId: 'contact-456',
        workspaceId: 'ws-789'
      });
      expect(url).toContain('highlightTask=task-123');
      expect(url).toContain('ws=ws-789');
      expect(url).not.toContain('contactId');
    });

    it('subtask.* deep-link nesmie obsahovať contactId v query (regression)', () => {
      const url = notificationService.generateNotificationUrl('subtask.created', {
        taskId: 'task-123',
        subtaskId: 'sub-456',
        contactId: 'contact-789',
        workspaceId: 'ws-999'
      });
      expect(url).toContain('highlightTask=task-123');
      expect(url).toContain('subtask=sub-456');
      expect(url).not.toContain('contactId');
    });

    it('contact.* deep-link smeruje na /crm s expandContact', () => {
      const url = notificationService.generateNotificationUrl('contact.updated', {
        contactId: 'contact-abc',
        workspaceId: 'ws-xyz'
      });
      expect(url).toContain('/crm');
      expect(url).toContain('expandContact=contact-abc');
      expect(url).toContain('ws=ws-xyz');
    });

    it('message.* deep-link smeruje na /messages s highlight a voliteľne comment', () => {
      const url = notificationService.generateNotificationUrl('message.comment.reacted', {
        messageId: 'msg-1',
        commentId: 'com-2',
        workspaceId: 'ws-3'
      });
      expect(url).toContain('/messages');
      expect(url).toContain('highlight=msg-1');
      expect(url).toContain('comment=com-2');
      expect(url).toContain('ws=ws-3');
    });

    it('fallback bez taskId/messageId → /app dashboard', () => {
      const url = notificationService.generateNotificationUrl('unknown.type', {
        workspaceId: 'ws-1'
      });
      expect(url).toBe('/app?ws=ws-1');
    });
  });

  describe('createNotification', () => {
    it('should create notification and save to database', async () => {
      const notification = await notificationService.createNotification({
        userId: testUser1._id,
        type: 'task.created',
        title: 'Nová úloha vytvorená',
        actorId: testUser2._id,
        actorName: 'testuser2',
        relatedType: 'task',
        relatedId: 'task-123',
        relatedName: 'Testovacia úloha'
      });

      expect(notification).toBeDefined();
      expect(notification.userId.toString()).toBe(testUser1._id.toString());
      expect(notification.type).toBe('task.created');
      expect(notification.title).toBe('Nová úloha vytvorená');

      // Verify saved to database
      const savedNotification = await Notification.findById(notification._id);
      expect(savedNotification).toBeDefined();
      expect(savedNotification.type).toBe('task.created');
    });

    it('should emit notification via Socket.IO', async () => {
      await notificationService.createNotification({
        userId: testUser1._id,
        type: 'contact.created',
        title: 'Nový kontakt',
        actorName: 'testuser2'
      });

      expect(mockIo.to).toHaveBeenCalledWith(`user-${testUser1._id}`);
      expect(mockIo.emit).toHaveBeenCalledWith(
        'notification',
        expect.objectContaining({
          type: 'contact.created',
          title: 'Nový kontakt'
        })
      );
    });

    it('should set default values correctly', async () => {
      const notification = await notificationService.createNotification({
        userId: testUser1._id,
        type: 'task.updated',
        title: 'Úloha aktualizovaná'
      });

      expect(notification.read).toBe(false);
      expect(notification.message).toBe('');
      expect(notification.data).toEqual({});
    });
  });

  describe('notifyUsers', () => {
    it('should create notifications for multiple users', async () => {
      const notifications = await notificationService.notifyUsers(
        [testUser1._id.toString(), testUser2._id.toString()],
        {
          type: 'task.created',
          title: 'Nová úloha pre tím',
          actorName: 'Manager'
        }
      );

      expect(notifications).toHaveLength(2);
      expect(mockIo.to).toHaveBeenCalledTimes(2);
    });

    it('should handle empty user list', async () => {
      const notifications = await notificationService.notifyUsers([], {
        type: 'task.created',
        title: 'Nikto to nedostane'
      });

      expect(notifications).toHaveLength(0);
      expect(mockIo.to).not.toHaveBeenCalled();
    });
  });

  describe('notifyAllExcept', () => {
    it('should notify all workspace members except the actor', async () => {
      const notifications = await notificationService.notifyAllExcept(
        testUser1._id,
        {
          type: 'contact.created',
          title: 'Nový kontakt od user1',
          actorName: 'testuser1'
        },
        testWorkspaceId
      );

      // Should notify user2 and user3, but not user1
      expect(notifications).toHaveLength(2);

      const recipientIds = notifications.map(n => n.userId.toString());
      expect(recipientIds).toContain(testUser2._id.toString());
      expect(recipientIds).toContain(testUser3._id.toString());
      expect(recipientIds).not.toContain(testUser1._id.toString());
    });

    it('should return empty if no workspaceId provided', async () => {
      const notifications = await notificationService.notifyAllExcept(
        testUser1._id,
        {
          type: 'contact.created',
          title: 'Test',
          actorName: 'testuser1'
        }
      );
      expect(notifications).toHaveLength(0);
    });
  });

  describe('notifyContactChange', () => {
    it('should notify workspace members except actor for contact changes', async () => {
      const contact = {
        _id: new mongoose.Types.ObjectId(),
        name: 'Firma ABC'
      };

      const actor = {
        _id: testUser1._id,
        username: 'testuser1'
      };

      const notifications = await notificationService.notifyContactChange(
        'contact.created',
        contact,
        actor,
        testWorkspaceId
      );

      expect(notifications).toHaveLength(2);
      expect(notifications[0].type).toBe('contact.created');
      expect(notifications[0].relatedType).toBe('contact');
      expect(notifications[0].relatedName).toBe('Firma ABC');
    });

    it('should generate correct title', async () => {
      const contact = { _id: new mongoose.Types.ObjectId(), name: 'Test' };
      const actor = { _id: testUser1._id, username: 'Peter' };

      const notifications = await notificationService.notifyContactChange(
        'contact.deleted',
        contact,
        actor,
        testWorkspaceId
      );

      expect(notifications[0].title).toBe('Peter vymazal kontakt: Test');
    });

    it('should return empty without workspaceId', async () => {
      const contact = { _id: new mongoose.Types.ObjectId(), name: 'Test' };
      const actor = { _id: testUser1._id, username: 'Peter' };

      const notifications = await notificationService.notifyContactChange(
        'contact.created',
        contact,
        actor
      );

      expect(notifications).toHaveLength(0);
    });
  });

  describe('notifyTaskChange', () => {
    // Všetky testy prechádzajú workspaceId, lebo aktuálny kód honoruje
    // workspace scoping (P2 guide-u). Bez workspaceId existuje len legacy
    // fallback na task.assignedTo — ten sa v produkcii nepoužíva a netestujeme ho.
    it('should notify workspace members about task changes', async () => {
      const task = {
        _id: new mongoose.Types.ObjectId(),
        title: 'Dôležitá úloha',
        assignedTo: [testUser2._id.toString(), testUser3._id.toString()]
      };

      const actor = {
        _id: testUser1._id,
        username: 'testuser1'
      };

      const notifications = await notificationService.notifyTaskChange(
        'task.updated',
        task,
        actor,
        [],
        testWorkspaceId
      );

      // Should notify user2 and user3 (workspace members, excluding actor)
      expect(notifications).toHaveLength(2);
      expect(notifications[0].relatedType).toBe('task');
    });

    it('should not notify actor who made the change', async () => {
      const task = {
        _id: new mongoose.Types.ObjectId(),
        title: 'Self-assigned task',
        assignedTo: [testUser1._id.toString(), testUser2._id.toString()]
      };

      const actor = {
        _id: testUser1._id,
        username: 'testuser1'
      };

      const notifications = await notificationService.notifyTaskChange(
        'task.completed',
        task,
        actor,
        [],
        testWorkspaceId
      );

      // Should notify user2 and user3 (members except actor user1)
      const recipientIds = notifications.map(n => n.userId.toString());
      expect(recipientIds).not.toContain(testUser1._id.toString());
      expect(recipientIds).toContain(testUser2._id.toString());
      expect(recipientIds).toContain(testUser3._id.toString());
    });

    it('should notify all workspace members except actor when no assigned users', async () => {
      const task = {
        _id: new mongoose.Types.ObjectId(),
        title: 'Unassigned task',
        assignedTo: []
      };

      const actor = {
        _id: testUser1._id,
        username: 'testuser1'
      };

      const notifications = await notificationService.notifyTaskChange(
        'task.created',
        task,
        actor,
        [],
        testWorkspaceId
      );

      // Should notify user2 and user3 (workspace members except actor)
      expect(notifications).toHaveLength(2);
    });

    it('should return empty without workspaceId and without assignedTo (tenancy guard)', async () => {
      // Regresný test: bez workspaceId a bez assigned users nemáme ako zistiť
      // recipients — service musí vrátiť [] (fail-safe). Pôvodne test očakával
      // broadcast všetkým v DB, čo bolo nebezpečné pre multi-tenant prostredie.
      const task = {
        _id: new mongoose.Types.ObjectId(),
        title: 'Orphan task',
        assignedTo: []
      };

      const actor = {
        _id: testUser1._id,
        username: 'testuser1'
      };

      const notifications = await notificationService.notifyTaskChange(
        'task.created',
        task,
        actor
      );

      expect(notifications).toHaveLength(0);
    });
  });

  describe('notifyTaskAssignment', () => {
    it('should notify only newly assigned users', async () => {
      const task = {
        _id: new mongoose.Types.ObjectId(),
        title: 'Priradená úloha'
      };

      const actor = {
        _id: testUser1._id,
        username: 'testuser1'
      };

      const notifications = await notificationService.notifyTaskAssignment(
        task,
        [testUser2._id.toString(), testUser3._id.toString()],
        actor
      );

      expect(notifications).toHaveLength(2);
      expect(notifications[0].type).toBe('task.assigned');
      expect(notifications[0].title).toContain('priradil projekt');
    });

    it('should not notify actor if in assigned list', async () => {
      const task = {
        _id: new mongoose.Types.ObjectId(),
        title: 'Self-assign'
      };

      const actor = {
        _id: testUser1._id,
        username: 'testuser1'
      };

      const notifications = await notificationService.notifyTaskAssignment(
        task,
        [testUser1._id.toString(), testUser2._id.toString()],
        actor
      );

      const recipientIds = notifications.map(n => n.userId.toString());
      expect(recipientIds).not.toContain(testUser1._id.toString());
    });
  });

  describe('notifySubtaskChange', () => {
    it('should notify parent task assigned users', async () => {
      const subtask = {
        id: 'subtask-123',
        title: 'Malá podúloha'
      };

      const parentTask = {
        _id: new mongoose.Types.ObjectId(),
        title: 'Hlavná úloha',
        assignedTo: [testUser2._id.toString()],
        contactId: 'contact-123'
      };

      const actor = {
        _id: testUser1._id,
        username: 'testuser1'
      };

      const notifications = await notificationService.notifySubtaskChange(
        'subtask.completed',
        subtask,
        parentTask,
        actor
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe('subtask.completed');
      expect(notifications[0].relatedType).toBe('subtask');
      expect(notifications[0].data.taskId).toBe(parentTask._id.toString());
    });
  });

  describe('Socket.IO integration', () => {
    it('should not emit when io is not initialized', async () => {
      // Reset to null
      notificationService.initialize(null);

      const notification = await notificationService.createNotification({
        userId: testUser1._id,
        type: 'task.created',
        title: 'No socket test'
      });

      expect(notification).toBeDefined();
      // No error should be thrown, just no emission
    });

    it('should emit to correct user room', async () => {
      notificationService.initialize(mockIo);

      await notificationService.createNotification({
        userId: testUser1._id,
        type: 'task.created',
        title: 'Room test'
      });

      expect(mockIo.to).toHaveBeenCalledWith(`user-${testUser1._id}`);
    });
  });
});
