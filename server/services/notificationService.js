const Notification = require('../models/Notification');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');
const APNsDevice = require('../models/APNsDevice');
const webpush = require('web-push');
const apn = require('apn');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Notification Service
 * Handles creating and sending notifications to users
 */

// Store io instance
let io = null;

// VAPID configuration status
let vapidConfigured = false;

// Metrics for monitoring
const metrics = {
  notifications: {
    created: 0,
    socketEmitted: 0,
    pushSent: 0,
    pushFailed: 0,
    subscriptionsRemoved: 0
  },
  lastReset: new Date(),
  errors: []
};

// Keep only last 50 errors
const MAX_ERRORS = 50;

// Configure web-push with VAPID keys (if available)
const initializeVapid = () => {
  if (vapidConfigured) return true;

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@prplcrm.sk',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
      vapidConfigured = true;
      logger.info('[NotificationService] VAPID configured successfully');
    } catch (error) {
      logger.error('[NotificationService] Failed to configure VAPID', { error: error.message });
      vapidConfigured = false;
    }
  } else {
    logger.warn('[NotificationService] VAPID keys not configured - push notifications disabled');
  }

  return vapidConfigured;
};

// Initialize VAPID on module load
initializeVapid();

// APNs provider
let apnProvider = null;
let apnConfigured = false;

const initializeAPNs = () => {
  if (apnConfigured) return true;

  const keyPath = process.env.APNS_KEY_PATH || path.join(__dirname, '..', 'config', 'AuthKey.p8');
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;

  if (keyId && teamId) {
    try {
      apnProvider = new apn.Provider({
        token: {
          key: keyPath,
          keyId,
          teamId
        },
        production: process.env.NODE_ENV === 'production'
      });
      apnConfigured = true;
      logger.info('[APNs] Provider initialized', { keyId, teamId, production: process.env.NODE_ENV === 'production' });
    } catch (err) {
      logger.warn('[APNs] Provider initialization failed', { error: err.message });
    }
  } else {
    logger.debug('[APNs] Not configured (missing APNS_KEY_ID or APNS_TEAM_ID)');
  }
  return apnConfigured;
};

// Initialize APNs on module load
initializeAPNs();

/**
 * Send APNs push notification to iOS devices
 */
const sendAPNsNotification = async (userId, payload) => {
  if (!apnConfigured || !apnProvider) return { sent: 0, failed: 0 };

  const result = { sent: 0, failed: 0, removed: 0 };

  try {
    const devices = await APNsDevice.find({ userId });
    if (devices.length === 0) return result;

    const url = generateNotificationUrl(payload.type, payload.data);
    const baseUrl = process.env.CLIENT_URL || 'https://perun-crm.onrender.com';

    const notification = new apn.Notification();
    notification.expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    notification.badge = 1;
    notification.sound = 'default';
    notification.alert = {
      title: String(payload.title).slice(0, 100),
      body: String(payload.body || payload.message || '').slice(0, 200)
    };
    notification.topic = 'sk.eperun.prplcrm';
    notification.payload = {
      url: baseUrl + url,
      type: payload.type,
      ...(payload.data || {})
    };
    notification.pushType = 'alert';

    for (const device of devices) {
      try {
        const res = await apnProvider.send(notification, device.deviceToken);
        if (res.sent.length > 0) {
          result.sent++;
          device.lastUsed = new Date();
          await device.save();
        }
        if (res.failed.length > 0) {
          result.failed++;
          const failure = res.failed[0];
          // Remove invalid tokens
          if (failure.status === '410' || failure.response?.reason === 'Unregistered' || failure.response?.reason === 'BadDeviceToken') {
            await APNsDevice.deleteOne({ _id: device._id });
            result.removed++;
            logger.info('[APNs] Removed invalid device', { reason: failure.response?.reason });
          }
        }
      } catch (err) {
        result.failed++;
        logger.warn('[APNs] Send failed', { error: err.message });
      }
    }

    if (result.sent > 0) {
      logger.debug('[APNs] Notifications sent', { userId, ...result });
    }
  } catch (error) {
    logger.error('[APNs] Error', { error: error.message, userId });
  }

  return result;
};

/**
 * Initialize the notification service with Socket.IO instance
 */
const initialize = (socketIo) => {
  io = socketIo;
};

/**
 * Generate URL for navigation based on notification type and data
 */
const generateNotificationUrl = (type, data = {}) => {
  logger.debug('[NotificationService] generateNotificationUrl', { type, data });

  // Contact notifications -> /crm with contact expansion
  if (type?.startsWith('contact') && data.contactId) {
    const url = `/crm?expandContact=${data.contactId}`;
    logger.debug('[NotificationService] Generated contact URL', { url });
    return url;
  }

  // Task notifications -> /tasks with task highlight
  if (type?.startsWith('task') && data.taskId) {
    let url = `/tasks?highlightTask=${data.taskId}`;
    // Add contactId for contact-based tasks to help with navigation
    if (data.contactId) {
      url += `&contactId=${data.contactId}`;
    }
    logger.debug('[NotificationService] Generated task URL', { url });
    return url;
  }

  // Subtask notifications -> /tasks with parent task highlight
  if (type?.startsWith('subtask') && data.taskId) {
    let url = `/tasks?highlightTask=${data.taskId}&subtask=${data.subtaskId || ''}`;
    // Add contactId for contact-based tasks to help with navigation
    if (data.contactId) {
      url += `&contactId=${data.contactId}`;
    }
    logger.debug('[NotificationService] Generated subtask URL', { url });
    return url;
  }

  logger.warn('[NotificationService] No URL match, returning /', { type, data });
  return '/';
};

/**
 * Send push notification to a user
 * @param {string} userId - User ID to send notification to
 * @param {Object} payload - Notification payload
 * @returns {Object} Result with sent/failed counts
 */
const sendPushNotification = async (userId, payload) => {
  const result = { sent: 0, failed: 0, removed: 0 };

  // Check VAPID configuration
  if (!vapidConfigured) {
    logger.debug('[Push] VAPID not configured, skipping push notification');
    return result;
  }

  // Validate payload
  if (!payload || !payload.title) {
    logger.warn('[Push] Invalid payload - missing title');
    return result;
  }

  try {
    const subscriptions = await PushSubscription.find({ userId });

    if (subscriptions.length === 0) {
      logger.debug('[Push] No subscriptions found for user', { userId });
      return result;
    }

    // Generate URL based on notification type
    const url = generateNotificationUrl(payload.type, payload.data);

    // Sanitize and limit payload sizes
    const sanitizedTitle = String(payload.title).slice(0, 100);
    const sanitizedBody = String(payload.body || payload.message || '').slice(0, 200);

    const pushPayload = JSON.stringify({
      title: sanitizedTitle,
      body: sanitizedBody,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      data: {
        url,
        type: payload.type,
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
        result.sent++;
        metrics.notifications.pushSent++;
      } catch (error) {
        result.failed++;
        metrics.notifications.pushFailed++;
        logger.warn('[Push] Notification failed', {
          endpoint: sub.endpoint.substring(0, 50) + '...',
          statusCode: error.statusCode,
          message: error.message
        });

        // Remove invalid subscriptions (expired or unsubscribed)
        if (error.statusCode === 410 || error.statusCode === 404) {
          await PushSubscription.deleteOne({ _id: sub._id });
          result.removed++;
          metrics.notifications.subscriptionsRemoved++;
          logger.info('[Push] Removed invalid subscription', {
            endpoint: sub.endpoint.substring(0, 50) + '...'
          });
        }
      }
    }

    logger.debug('[Push] Notification batch completed', { userId, ...result });
    return result;
  } catch (error) {
    logger.error('[Push] Error sending notifications', { error: error.message, userId });
    return result;
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
    metrics.notifications.created++;

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
      metrics.notifications.socketEmitted++;
    }

    // Send push notification (for background/closed app)
    const pushPayload = {
      title: notification.title,
      body: notification.message,
      type: notification.type,
      data: notification.data
    };
    await sendPushNotification(userId, pushPayload);

    // Send APNs push to iOS devices
    await sendAPNsNotification(userId, pushPayload);

    return notification;
  } catch (error) {
    logger.error('[NotificationService] Error creating notification', { error: error.message, userId, type });
    // Track error
    metrics.errors.push({
      timestamp: new Date(),
      type: 'createNotification',
      message: error.message,
      context: { userId, type }
    });
    if (metrics.errors.length > MAX_ERRORS) {
      metrics.errors.shift();
    }
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
    logger.error('[NotificationService] Error notifying all users', { error: error.message });
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
      return `Nový kontakt: ${related || 'bez názvu'}`;
    case 'contact.updated':
      return `Kontakt upravený: ${related || 'bez názvu'}`;
    case 'contact.deleted':
      return `Kontakt vymazaný: ${related || 'bez názvu'}`;
    case 'task.created':
      return `Nový projekt: ${related || 'bez názvu'}`;
    case 'task.updated':
      return `Projekt upravený: ${related || 'bez názvu'}`;
    case 'task.completed':
      return `Projekt dokončený: ${related || 'bez názvu'}`;
    case 'task.deleted':
      return `Projekt vymazaný: ${related || 'bez názvu'}`;
    case 'task.assigned':
      return `Priradený projekt: ${related || 'bez názvu'}`;
    case 'subtask.created':
      return `Nová úloha: ${related || 'bez názvu'}`;
    case 'subtask.updated':
      return `Úloha upravená: ${related || 'bez názvu'}`;
    case 'subtask.completed':
      return `Úloha dokončená: ${related || 'bez názvu'}`;
    case 'subtask.deleted':
      return `Úloha vymazaná: ${related || 'bez názvu'}`;
    case 'subtask.assigned':
      return `Priradená úloha: ${related || 'bez názvu'}`;
    case 'task.dueDate':
    case 'subtask.dueDate':
      return related || 'Blíži sa termín';
    default:
      return 'Nová notifikácia';
  }
};

/**
 * Get notification message (description) based on type
 */
const getNotificationMessage = (type, actorName, data = {}) => {
  const actor = actorName || 'Niekto';
  const contactName = data.contactName || '';
  const taskTitle = data.taskTitle || '';

  switch (type) {
    case 'contact.created':
      return `${actor} vytvoril nový kontakt`;
    case 'contact.updated':
      return `${actor} upravil tento kontakt`;
    case 'contact.deleted':
      return `${actor} vymazal tento kontakt`;
    case 'task.created':
      return contactName
        ? `${actor} vytvoril projekt pre kontakt "${contactName}"`
        : `${actor} vytvoril nový projekt`;
    case 'task.updated':
      return contactName
        ? `${actor} upravil projekt v kontakte "${contactName}"`
        : `${actor} upravil tento projekt`;
    case 'task.completed':
      return contactName
        ? `${actor} dokončil projekt v kontakte "${contactName}"`
        : `${actor} dokončil tento projekt`;
    case 'task.deleted':
      return contactName
        ? `${actor} vymazal projekt z kontaktu "${contactName}"`
        : `${actor} vymazal tento projekt`;
    case 'task.assigned':
      return contactName
        ? `${actor} vám priradil projekt v kontakte "${contactName}"`
        : `${actor} vám priradil tento projekt`;
    case 'subtask.created':
      return taskTitle
        ? `${actor} pridal úlohu k projektu "${taskTitle}"`
        : `${actor} pridal novú úlohu`;
    case 'subtask.updated':
      return taskTitle
        ? `${actor} upravil úlohu v projekte "${taskTitle}"`
        : `${actor} upravil úlohu`;
    case 'subtask.completed':
      return taskTitle
        ? `${actor} dokončil úlohu v projekte "${taskTitle}"`
        : `${actor} dokončil úlohu`;
    case 'subtask.deleted':
      return taskTitle
        ? `${actor} vymazal úlohu z projektu "${taskTitle}"`
        : `${actor} vymazal úlohu`;
    case 'subtask.assigned':
      return taskTitle
        ? `${actor} vám priradil úlohu v projekte "${taskTitle}"`
        : `${actor} vám priradil túto úlohu`;
    default:
      return '';
  }
};

/**
 * Helper to create contact notification
 */
const notifyContactChange = async (type, contact, actor, excludeActorId = true) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle(type, actorName, contact.name);
  const message = getNotificationMessage(type, actorName, {});

  const notificationData = {
    type,
    title,
    message,
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
 * @param {string} type - Notification type
 * @param {Object} task - Task object
 * @param {Object} actor - User who performed the action
 * @param {Array} excludeUserIds - User IDs to exclude from notification (e.g., newly assigned users who get separate notification)
 */
const notifyTaskChange = async (type, task, actor, excludeUserIds = []) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle(type, actorName, task.title);
  const message = getNotificationMessage(type, actorName, { contactName: task.contactName });

  logger.debug('[NotificationService] Task change', { type, taskTitle: task.title, actorName, excludeUserIds });

  const notificationData = {
    type,
    title,
    message,
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

  // Remove the actor
  if (actor) {
    recipientIds.delete((actor._id || actor.id).toString());
  }

  // Remove excluded users (e.g., newly assigned who get their own notification)
  if (excludeUserIds && Array.isArray(excludeUserIds)) {
    excludeUserIds.forEach(id => {
      if (id) recipientIds.delete(id.toString());
    });
  }

  if (recipientIds.size === 0) {
    // No specific recipients - don't spam all users, just skip
    logger.debug('[NotificationService] No recipients for task notification, skipping');
    return [];
  }

  return await notifyUsers(Array.from(recipientIds), notificationData);
};

/**
 * Notify about task assignment
 */
const notifyTaskAssignment = async (task, assignedUserIds, actor) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle('task.assigned', actorName, task.title);
  const message = getNotificationMessage('task.assigned', actorName, { contactName: task.contactName });

  logger.info('[NotificationService] Task assignment notification', {
    actorName,
    actorId: actor?.id || actor?._id,
    taskTitle: task.title,
    contactName: task.contactName,
    title,
    message,
    assignedUserIds
  });

  const notificationData = {
    type: 'task.assigned',
    title,
    message,
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
 * Notify about subtask assignment
 */
const notifySubtaskAssignment = async (subtask, parentTask, assignedUserIds, actor) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle('subtask.assigned', actorName, subtask.title);
  const message = getNotificationMessage('subtask.assigned', actorName, { taskTitle: parentTask.title });

  logger.debug('[NotificationService] Subtask assignment', { subtaskTitle: subtask.title, parentTaskTitle: parentTask.title, assignedUserIds, actorName });

  const notificationData = {
    type: 'subtask.assigned',
    title,
    message,
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

  // Filter out the actor from recipients
  const recipients = assignedUserIds.filter(id =>
    id && id.toString() !== (actor?._id || actor?.id)?.toString()
  );

  return await notifyUsers(recipients, notificationData);
};

/**
 * Helper to create subtask notification
 * @param {string} type - Notification type
 * @param {Object} subtask - Subtask object
 * @param {Object} parentTask - Parent task object
 * @param {Object} actor - User who performed the action
 * @param {Array} excludeUserIds - User IDs to exclude from notification (e.g., newly assigned users who get separate notification)
 */
const notifySubtaskChange = async (type, subtask, parentTask, actor, excludeUserIds = []) => {
  const actorName = actor?.username || 'Systém';
  const title = getNotificationTitle(type, actorName, subtask.title);
  const message = getNotificationMessage(type, actorName, { taskTitle: parentTask.title });

  logger.debug('[NotificationService] Subtask change', { type, subtaskTitle: subtask.title, parentTaskTitle: parentTask.title, actorName, excludeUserIds });

  const notificationData = {
    type,
    title,
    message,
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

  // Remove excluded users (e.g., newly assigned who get their own notification)
  if (excludeUserIds && Array.isArray(excludeUserIds)) {
    excludeUserIds.forEach(id => {
      if (id) recipientIds.delete(id.toString());
    });
  }

  if (recipientIds.size === 0) {
    // No specific recipients - don't spam all users, just skip
    logger.debug('[NotificationService] No recipients for subtask notification, skipping');
    return [];
  }

  return await notifyUsers(Array.from(recipientIds), notificationData);
};

/**
 * Get notification metrics for monitoring
 * @returns {Object} Current metrics
 */
const getMetrics = () => {
  return {
    ...metrics,
    uptime: Date.now() - metrics.lastReset.getTime(),
    vapidConfigured
  };
};

/**
 * Reset notification metrics
 */
const resetMetrics = () => {
  metrics.notifications = {
    created: 0,
    socketEmitted: 0,
    pushSent: 0,
    pushFailed: 0,
    subscriptionsRemoved: 0
  };
  metrics.lastReset = new Date();
  metrics.errors = [];
  logger.info('[NotificationService] Metrics reset');
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
  notifySubtaskAssignment,
  getNotificationTitle,
  getNotificationMessage,
  sendPushNotification,
  isVapidConfigured: () => vapidConfigured,
  isAPNsConfigured: () => apnConfigured,
  getMetrics,
  resetMetrics
};
