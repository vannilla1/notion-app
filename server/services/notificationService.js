const Notification = require('../models/Notification');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');
const webpush = require('web-push');

/**
 * Notification Service
 * Handles creating and sending notifications to users
 */

// Store io instance
let io = null;

// Configure web-push with VAPID keys (if available)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@purplecrm.sk',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

/**
 * Initialize the notification service with Socket.IO instance
 */
const initialize = (socketIo) => {
  io = socketIo;
};

/**
 * Send push notification to a user
 */
const sendPushNotification = async (userId, payload) => {
  try {
    const subscriptions = await PushSubscription.find({ userId });

    if (subscriptions.length === 0) {
      return;
    }

    const pushPayload = JSON.stringify({
      title: payload.title,
      body: payload.body || payload.message,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      data: {
        url: payload.url || '/',
        ...payload.data
      },
      tag: payload.tag || payload.type || 'default'
    });

    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: sub.keys
        }, pushPayload);

        // Update last used timestamp
        sub.lastUsed = new Date();
        await sub.save();
      } catch (error) {
        console.error('Push notification failed for endpoint:', sub.endpoint, error.message);

        // Remove invalid subscriptions (expired or unsubscribed)
        if (error.statusCode === 410 || error.statusCode === 404) {
          await PushSubscription.deleteOne({ _id: sub._id });
          console.log('Removed invalid push subscription:', sub.endpoint);
        }
      }
    }
  } catch (error) {
    console.error('Error sending push notifications:', error);
  }
};

/**
 * Create a notification for a specific user
 */
const createNotification = async ({
  userId,
  type,
  title,
  message = '',
  actorId = null,
  actorName = null,
  relatedType = null,
  relatedId = null,
  relatedName = null,
  data = {}
}) => {
  try {
    const notification = new Notification({
      userId,
      type,
      title,
      message,
      actorId,
      actorName,
      relatedType,
      relatedId,
      relatedName,
      data
    });

    await notification.save();

    // Send real-time notification via Socket.IO
    if (io) {
      io.to(`user-${userId}`).emit('notification', {
        id: notification._id.toString(),
        type: notification.type,
        title: notification.title,
        message: notification.message,
        actorName: notification.actorName,
        relatedType: notification.relatedType,
        relatedId: notification.relatedId,
        relatedName: notification.relatedName,
        data: notification.data,
        read: notification.read,
        createdAt: notification.createdAt
      });
    }

    // Send push notification (for background/closed app)
    sendPushNotification(userId, {
      title: notification.title,
      body: notification.message,
      type: notification.type,
      data: notification.data
    });

    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    return null;
  }
};

/**
 * Notify multiple users about an event
 */
const notifyUsers = async (userIds, notificationData) => {
  const notifications = [];
  for (const userId of userIds) {
    const notification = await createNotification({
      ...notificationData,
      userId
    });
    if (notification) {
      notifications.push(notification);
    }
  }
  return notifications;
};

/**
 * Notify all users except the actor
 */
const notifyAllExcept = async (excludeUserId, notificationData) => {
  try {
    const users = await User.find({ _id: { $ne: excludeUserId } }, '_id').lean();
    const userIds = users.map(u => u._id.toString());
    return await notifyUsers(userIds, notificationData);
  } catch (error) {
    console.error('Error notifying all users:', error);
    return [];
  }
};

/**
 * Get notification title based on type
 */
const getNotificationTitle = (type, actorName, relatedName) => {
  const actor = actorName || 'Niekto';
  const related = relatedName || '';

  switch (type) {
    case 'contact.created':
      return `${actor} vytvoril nový kontakt${related ? ': ' + related : ''}`;
    case 'contact.updated':
      return `${actor} upravil kontakt${related ? ': ' + related : ''}`;
    case 'contact.deleted':
      return `${actor} vymazal kontakt${related ? ': ' + related : ''}`;
    case 'task.created':
      return `${actor} vytvoril novú úlohu${related ? ': ' + related : ''}`;
    case 'task.updated':
      return `${actor} upravil úlohu${related ? ': ' + related : ''}`;
    case 'task.completed':
      return `${actor} dokončil úlohu${related ? ': ' + related : ''}`;
    case 'task.deleted':
      return `${actor} vymazal úlohu${related ? ': ' + related : ''}`;
    case 'task.assigned':
      return `${actor} vám priradil úlohu${related ? ': ' + related : ''}`;
    case 'subtask.created':
      return `${actor} pridal podúlohu${related ? ': ' + related : ''}`;
    case 'subtask.updated':
      return `${actor} upravil podúlohu${related ? ': ' + related : ''}`;
    case 'subtask.completed':
      return `${actor} dokončil podúlohu${related ? ': ' + related : ''}`;
    case 'subtask.deleted':
      return `${actor} vymazal podúlohu${related ? ': ' + related : ''}`;
    default:
      return 'Nová notifikácia';
  }
};

/**
 * Helper to create contact notification
 */
const notifyContactChange = async (type, contact, actor, excludeActorId = true) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle(type, actorName, contact.name);

  const notificationData = {
    type,
    title,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'contact',
    relatedId: contact._id?.toString() || contact.id,
    relatedName: contact.name,
    data: { contactId: contact._id?.toString() || contact.id }
  };

  if (excludeActorId && actor) {
    return await notifyAllExcept(actor._id || actor.id, notificationData);
  } else {
    const users = await User.find({}, '_id').lean();
    return await notifyUsers(users.map(u => u._id.toString()), notificationData);
  }
};

/**
 * Helper to create task notification
 */
const notifyTaskChange = async (type, task, actor, additionalRecipients = []) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle(type, actorName, task.title);

  const notificationData = {
    type,
    title,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'task',
    relatedId: task._id?.toString() || task.id,
    relatedName: task.title,
    data: {
      taskId: task._id?.toString() || task.id,
      contactId: task.contactId,
      contactName: task.contactName
    }
  };

  // Collect all users to notify
  const recipientIds = new Set();

  // Add assigned users
  if (task.assignedTo && Array.isArray(task.assignedTo)) {
    task.assignedTo.forEach(id => {
      if (id) recipientIds.add(id.toString());
    });
  }

  // Add additional recipients
  additionalRecipients.forEach(id => {
    if (id) recipientIds.add(id.toString());
  });

  // Remove the actor
  if (actor) {
    recipientIds.delete((actor._id || actor.id).toString());
  }

  if (recipientIds.size === 0) {
    // If no specific recipients, notify all except actor
    return await notifyAllExcept(actor?._id || actor?.id, notificationData);
  }

  return await notifyUsers(Array.from(recipientIds), notificationData);
};

/**
 * Notify about task assignment
 */
const notifyTaskAssignment = async (task, assignedUserIds, actor) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle('task.assigned', actorName, task.title);

  const notificationData = {
    type: 'task.assigned',
    title,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'task',
    relatedId: task._id?.toString() || task.id,
    relatedName: task.title,
    data: {
      taskId: task._id?.toString() || task.id,
      contactId: task.contactId,
      contactName: task.contactName
    }
  };

  // Filter out the actor from recipients
  const recipients = assignedUserIds.filter(id =>
    id && id.toString() !== (actor?._id || actor?.id)?.toString()
  );

  return await notifyUsers(recipients, notificationData);
};

/**
 * Helper to create subtask notification
 */
const notifySubtaskChange = async (type, subtask, parentTask, actor) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle(type, actorName, subtask.title);

  const notificationData = {
    type,
    title,
    actorId: actor?._id || actor?.id,
    actorName,
    relatedType: 'subtask',
    relatedId: subtask.id,
    relatedName: subtask.title,
    data: {
      subtaskId: subtask.id,
      taskId: parentTask._id?.toString() || parentTask.id,
      taskTitle: parentTask.title,
      contactId: parentTask.contactId
    }
  };

  // Notify parent task's assigned users
  const recipientIds = new Set();

  if (parentTask.assignedTo && Array.isArray(parentTask.assignedTo)) {
    parentTask.assignedTo.forEach(id => {
      if (id) recipientIds.add(id.toString());
    });
  }

  // Remove the actor
  if (actor) {
    recipientIds.delete((actor._id || actor.id).toString());
  }

  if (recipientIds.size === 0) {
    return await notifyAllExcept(actor?._id || actor?.id, notificationData);
  }

  return await notifyUsers(Array.from(recipientIds), notificationData);
};

module.exports = {
  initialize,
  createNotification,
  notifyUsers,
  notifyAllExcept,
  notifyContactChange,
  notifyTaskChange,
  notifyTaskAssignment,
  notifySubtaskChange,
  getNotificationTitle
};
