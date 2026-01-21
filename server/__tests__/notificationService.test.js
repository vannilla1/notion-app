const mongoose = require('mongoose');
const notificationService = require('../services/notificationService');
const Notification = require('../models/Notification');
const User = require('../models/User');

describe('NotificationService', () => {
  let mockIo;
  let testUser1;
  let testUser2;
  let testUser3;

  beforeEach(async () => {
    // Create mock Socket.IO
    mockIo = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn()
    };
    notificationService.initialize(mockIo);

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
      expect(title).toBe('Peter vám priradil úlohu: Dokončiť projekt');
    });

    it('should generate correct title for task.completed', () => {
      const title = notificationService.getNotificationTitle(
        'task.completed',
        'Maria',
        'Review kódu'
      );
      expect(title).toBe('Maria dokončil úlohu: Review kódu');
    });

    it('should generate correct title for subtask.created', () => {
      const title = notificationService.getNotificationTitle(
        'subtask.created',
        'Admin',
        'Napísať testy'
      );
      expect(title).toBe('Admin pridal podúlohu: Napísať testy');
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
      expect(title).toBe('Jan upravil úlohu');
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
    it('should notify all users except the actor', async () => {
      const notifications = await notificationService.notifyAllExcept(
        testUser1._id,
        {
          type: 'contact.created',
          title: 'Nový kontakt od user1',
          actorName: 'testuser1'
        }
      );

      // Should notify user2 and user3, but not user1
      expect(notifications).toHaveLength(2);

      const recipientIds = notifications.map(n => n.userId.toString());
      expect(recipientIds).toContain(testUser2._id.toString());
      expect(recipientIds).toContain(testUser3._id.toString());
      expect(recipientIds).not.toContain(testUser1._id.toString());
    });
  });

  describe('notifyContactChange', () => {
    it('should notify all except actor for contact changes', async () => {
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
        actor
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
        actor
      );

      expect(notifications[0].title).toBe('Peter vymazal kontakt: Test');
    });
  });

  describe('notifyTaskChange', () => {
    it('should notify assigned users about task changes', async () => {
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
        actor
      );

      // Should notify user2 and user3 (assigned users, excluding actor)
      expect(notifications).toHaveLength(2);
      expect(notifications[0].relatedType).toBe('task');
    });

    it('should not notify actor even if assigned', async () => {
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
        actor
      );

      // Should only notify user2, not user1 (actor)
      const recipientIds = notifications.map(n => n.userId.toString());
      expect(recipientIds).not.toContain(testUser1._id.toString());
      expect(recipientIds).toContain(testUser2._id.toString());
    });

    it('should notify all except actor when no assigned users', async () => {
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
        actor
      );

      // Should notify user2 and user3
      expect(notifications).toHaveLength(2);
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
      expect(notifications[0].title).toContain('priradil úlohu');
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
