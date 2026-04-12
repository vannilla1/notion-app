const Task = require('../models/Task');
const Contact = require('../models/Contact');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');

/**
 * Due date urgency levels based on days remaining
 * - success: 8-14 days (green)
 * - warning: 4-7 days (yellow)
 * - danger: 1-3 days (red)
 * - overdue: 0 or negative (past due)
 */
const getUrgencyLevel = (dueDate) => {
  if (!dueDate) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);

  const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'overdue'; // Today is also considered overdue/urgent
  if (diffDays <= 3) return 'danger';
  if (diffDays <= 7) return 'warning';
  if (diffDays <= 14) return 'success';
  return null; // More than 14 days - no urgency
};

/**
 * Get urgency change message
 */
const getUrgencyMessage = (oldLevel, newLevel, title, dueDate) => {
  const formattedDate = new Date(dueDate).toLocaleDateString('sk-SK');

  const messages = {
    'success-warning': {
      title: '⚠️ Blíži sa termín',
      body: `Projekt "${title}" má termín do 7 dní (${formattedDate})`
    },
    'warning-danger': {
      title: '🔴 Urgentný termín',
      body: `Projekt "${title}" má termín do 3 dní (${formattedDate})!`
    },
    'danger-overdue': {
      title: '❗ Termín vypršal',
      body: `Projekt "${title}" je po termíne (${formattedDate})!`
    },
    'success-danger': {
      title: '🔴 Urgentný termín',
      body: `Projekt "${title}" má termín do 3 dní (${formattedDate})!`
    },
    'success-overdue': {
      title: '❗ Termín vypršal',
      body: `Projekt "${title}" je po termíne (${formattedDate})!`
    },
    'warning-overdue': {
      title: '❗ Termín vypršal',
      body: `Projekt "${title}" je po termíne (${formattedDate})!`
    },
    'null-warning': {
      title: '⚠️ Blíži sa termín',
      body: `Projekt "${title}" má termín do 7 dní (${formattedDate})`
    },
    'null-danger': {
      title: '🔴 Urgentný termín',
      body: `Projekt "${title}" má termín do 3 dní (${formattedDate})!`
    },
    'null-overdue': {
      title: '❗ Termín vypršal',
      body: `Projekt "${title}" je po termíne (${formattedDate})!`
    }
  };

  const key = `${oldLevel || 'null'}-${newLevel}`;
  return messages[key] || null;
};

/**
 * Check if a custom reminder should fire for a task/subtask
 * Returns reminder info if it should fire, null otherwise
 */
const checkReminder = (item) => {
  if (!item.dueDate || !item.reminder || item.reminderSent || item.completed) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(item.dueDate);
  due.setHours(0, 0, 0, 0);

  const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

  // Fire reminder when days remaining <= reminder days and not overdue yet
  if (diffDays >= 0 && diffDays <= item.reminder) {
    return {
      daysRemaining: diffDays,
      reminderDays: item.reminder,
      dueDate: item.dueDate
    };
  }
  return null;
};

/**
 * Get reminder message
 */
const getReminderMessage = (title, dueDate, daysRemaining) => {
  const formattedDate = new Date(dueDate).toLocaleDateString('sk-SK');
  if (daysRemaining === 0) {
    return {
      title: '🔔 Pripomienka: dnes je termín',
      body: `Projekt "${title}" má termín dnes (${formattedDate})`
    };
  }
  if (daysRemaining === 1) {
    return {
      title: '🔔 Pripomienka: zajtra je termín',
      body: `Projekt "${title}" má termín zajtra (${formattedDate})`
    };
  }
  return {
    title: `🔔 Pripomienka: termín o ${daysRemaining} dní`,
    body: `Projekt "${title}" má termín ${formattedDate} (zostáva ${daysRemaining} dní)`
  };
};

/**
 * Process subtasks recursively and collect reminder triggers
 */
const processSubtaskReminders = (subtasks, taskId, reminders = []) => {
  if (!subtasks || subtasks.length === 0) return reminders;

  for (const subtask of subtasks) {
    if (subtask.completed) continue;

    const reminderInfo = checkReminder(subtask);
    if (reminderInfo) {
      reminders.push({
        type: 'subtask',
        subtask,
        taskId,
        ...reminderInfo
      });
    }

    if (subtask.subtasks && subtask.subtasks.length > 0) {
      processSubtaskReminders(subtask.subtasks, taskId, reminders);
    }
  }

  return reminders;
};

/**
 * Mark subtask reminders as sent recursively
 */
const markSubtaskRemindersSent = (subtasks) => {
  if (!subtasks || subtasks.length === 0) return subtasks;

  return subtasks.map(subtask => {
    const reminderInfo = checkReminder(subtask);
    const updated = subtask.toObject ? subtask.toObject() : { ...subtask };
    if (reminderInfo) {
      updated.reminderSent = true;
    }
    if (updated.subtasks && updated.subtasks.length > 0) {
      updated.subtasks = markSubtaskRemindersSent(updated.subtasks);
    }
    return updated;
  });
};

/**
 * Process subtasks recursively and collect urgency changes
 */
const processSubtasks = (subtasks, taskId, changes = []) => {
  if (!subtasks || subtasks.length === 0) return changes;

  for (const subtask of subtasks) {
    if (subtask.completed) continue;

    const currentLevel = getUrgencyLevel(subtask.dueDate);
    const storedLevel = subtask.lastUrgencyLevel || null;

    if (currentLevel && currentLevel !== storedLevel) {
      // Check if this is an escalation (not de-escalation)
      const levelOrder = { 'success': 1, 'warning': 2, 'danger': 3, 'overdue': 4 };
      const currentOrder = levelOrder[currentLevel] || 0;
      const storedOrder = levelOrder[storedLevel] || 0;

      if (currentOrder > storedOrder) {
        changes.push({
          type: 'subtask',
          subtask,
          taskId,
          oldLevel: storedLevel,
          newLevel: currentLevel
        });
      }
    }

    // Process nested subtasks
    if (subtask.subtasks && subtask.subtasks.length > 0) {
      processSubtasks(subtask.subtasks, taskId, changes);
    }
  }

  return changes;
};

/**
 * Update urgency levels in subtasks recursively
 */
const updateSubtaskUrgencyLevels = (subtasks) => {
  if (!subtasks || subtasks.length === 0) return subtasks;

  return subtasks.map(subtask => {
    const currentLevel = getUrgencyLevel(subtask.dueDate);
    return {
      ...subtask.toObject ? subtask.toObject() : subtask,
      lastUrgencyLevel: currentLevel,
      subtasks: updateSubtaskUrgencyLevels(subtask.subtasks)
    };
  });
};

/**
 * Check all tasks for due date urgency changes and send notifications
 */
const checkDueDates = async () => {
  try {
    logger.info('[DueDateChecker] Starting due date check...');

    // Get all incomplete tasks with due dates or reminders
    const tasks = await Task.find({
      completed: false,
      $or: [
        { dueDate: { $exists: true, $ne: null } },
        { 'subtasks.dueDate': { $exists: true, $ne: null } },
        { reminder: { $exists: true, $ne: null } },
        { 'subtasks.reminder': { $exists: true, $ne: null } }
      ]
    }).maxTimeMS(20000);

    logger.info(`[DueDateChecker] Found ${tasks.length} tasks to check`);

    let notificationsSent = 0;
    let tasksUpdated = 0;

    for (const task of tasks) {
      const changes = [];

      // Check main task due date
      if (task.dueDate && !task.completed) {
        const currentLevel = getUrgencyLevel(task.dueDate);
        const storedLevel = task.lastUrgencyLevel || null;

        if (currentLevel && currentLevel !== storedLevel) {
          const levelOrder = { 'success': 1, 'warning': 2, 'danger': 3, 'overdue': 4 };
          const currentOrder = levelOrder[currentLevel] || 0;
          const storedOrder = levelOrder[storedLevel] || 0;

          if (currentOrder > storedOrder) {
            changes.push({
              type: 'task',
              task,
              oldLevel: storedLevel,
              newLevel: currentLevel
            });
          }
        }
      }

      // Check subtasks
      processSubtasks(task.subtasks, task._id, changes);

      // Send notifications for changes
      for (const change of changes) {
        const message = getUrgencyMessage(
          change.oldLevel,
          change.newLevel,
          change.type === 'task' ? change.task.title : change.subtask.title,
          change.type === 'task' ? change.task.dueDate : change.subtask.dueDate
        );

        if (message) {
          // Get users to notify - task assignees or creator
          const usersToNotify = new Set();

          if (task.assignedTo && task.assignedTo.length > 0) {
            task.assignedTo.forEach(userId => usersToNotify.add(userId.toString()));
          }
          if (task.createdBy) {
            usersToNotify.add(task.createdBy.toString());
          }

          // Send full notification (in-app + web push + APNs) to each user
          for (const userId of usersToNotify) {
            try {
              const notificationType = change.type === 'task' ? 'task.dueDate' : 'subtask.dueDate';
              await notificationService.createNotification({
                userId,
                type: notificationType,
                title: message.title,
                message: message.body,
                actorName: 'Systém',
                relatedType: change.type,
                relatedId: change.type === 'task' ? task._id.toString() : change.subtask.id,
                relatedName: change.type === 'task' ? task.title : change.subtask.title,
                data: {
                  taskId: task._id.toString(),
                  subtaskId: change.type === 'subtask' ? change.subtask.id : null,
                  contactId: task.contactId || null
                }
              });
              notificationsSent++;
            } catch (err) {
              logger.error('[DueDateChecker] Failed to send notification', {
                error: err.message,
                userId,
                taskId: task._id
              });
            }
          }
        }
      }

      // --- Custom reminders ---
      const reminders = [];

      // Check main task reminder
      const taskReminder = checkReminder(task);
      if (taskReminder) {
        reminders.push({ type: 'task', task, ...taskReminder });
      }

      // Check subtask reminders
      processSubtaskReminders(task.subtasks, task._id, reminders);

      // Mark reminders as sent BEFORE sending notifications (prevents duplicates on overlapping runs)
      if (reminders.length > 0) {
        if (taskReminder) {
          task.reminderSent = true;
        }
        if (reminders.some(r => r.type === 'subtask')) {
          task.subtasks = markSubtaskRemindersSent(task.subtasks);
        }
        await task.save();
      }

      // Send reminder notifications
      for (const rem of reminders) {
        const title = rem.type === 'task' ? rem.task.title : rem.subtask.title;
        const message = getReminderMessage(title, rem.dueDate, rem.daysRemaining);

        const usersToNotify = new Set();
        if (task.assignedTo && task.assignedTo.length > 0) {
          task.assignedTo.forEach(userId => usersToNotify.add(userId.toString()));
        }
        if (task.createdBy) {
          usersToNotify.add(task.createdBy.toString());
        }

        for (const userId of usersToNotify) {
          try {
            const notificationType = rem.type === 'task' ? 'task.dueDate' : 'subtask.dueDate';
            await notificationService.createNotification({
              userId,
              type: notificationType,
              title: message.title,
              message: message.body,
              actorName: 'Systém',
              relatedType: rem.type,
              relatedId: rem.type === 'task' ? task._id.toString() : rem.subtask.id,
              relatedName: title,
              data: {
                taskId: task._id.toString(),
                subtaskId: rem.type === 'subtask' ? rem.subtask.id : null,
                contactId: task.contactId || null
              }
            });
            notificationsSent++;
          } catch (err) {
            logger.error('[DueDateChecker] Failed to send reminder', {
              error: err.message,
              userId,
              taskId: task._id
            });
          }
        }
      }

      // Update stored urgency levels (reminders already marked as sent above)
      if (changes.length > 0) {
        const currentTaskLevel = getUrgencyLevel(task.dueDate);
        task.lastUrgencyLevel = currentTaskLevel;
        task.subtasks = updateSubtaskUrgencyLevels(task.subtasks);

        await task.save();
        tasksUpdated++;
      }
    }

    // Also check contact tasks
    const contactResult = await checkContactDueDates();
    notificationsSent += contactResult.notificationsSent;

    logger.info(`[DueDateChecker] Completed. Notifications sent: ${notificationsSent}, Tasks updated: ${tasksUpdated}, Contacts updated: ${contactResult.contactsUpdated}`);

    return { notificationsSent, tasksUpdated };
  } catch (error) {
    logger.error('[DueDateChecker] Error checking due dates', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
};

/**
 * Check contact tasks for due date urgency changes and reminders
 */
const checkContactDueDates = async () => {
  try {
    const contacts = await Contact.aggregate([
      { $match: {
        'tasks.0': { $exists: true },
        'tasks': { $elemMatch: { completed: { $ne: true }, $or: [
          { dueDate: { $exists: true, $ne: null } },
          { reminder: { $exists: true, $ne: null } }
        ]}}
      }},
      { $project: { name: 1, tasks: 1, workspaceId: 1, userId: 1 } }
    ]).option({ maxTimeMS: 30000 });

    let notificationsSent = 0;
    let contactsUpdated = 0;

    for (const contact of contacts) {
      let contactModified = false;

      for (const task of contact.tasks) {
        if (task.completed) continue;

        const changes = [];

        // Check task due date
        if (task.dueDate) {
          const currentLevel = getUrgencyLevel(task.dueDate);
          const storedLevel = task.lastUrgencyLevel || null;

          if (currentLevel && currentLevel !== storedLevel) {
            const levelOrder = { success: 1, warning: 2, danger: 3, overdue: 4 };
            if ((levelOrder[currentLevel] || 0) > (levelOrder[storedLevel] || 0)) {
              changes.push({ type: 'task', task, oldLevel: storedLevel, newLevel: currentLevel });
            }
          }
        }

        // Check subtasks
        processSubtasks(task.subtasks, contact._id, changes);

        // Send urgency notifications
        for (const change of changes) {
          const message = getUrgencyMessage(
            change.oldLevel, change.newLevel,
            change.type === 'task' ? change.task.title : change.subtask.title,
            change.type === 'task' ? change.task.dueDate : change.subtask.dueDate
          );

          if (message) {
            const usersToNotify = new Set();
            if (task.assignedTo?.length > 0) task.assignedTo.forEach(uid => usersToNotify.add(uid));
            usersToNotify.add(contact.userId.toString());

            for (const userId of usersToNotify) {
              try {
                await notificationService.createNotification({
                  userId,
                  type: change.type === 'task' ? 'task.dueDate' : 'subtask.dueDate',
                  title: message.title,
                  message: message.body,
                  actorName: 'Systém',
                  relatedType: 'contact',
                  relatedId: contact._id.toString(),
                  relatedName: contact.name || 'Kontakt',
                  data: {
                    contactId: contact._id.toString(),
                    taskId: task.id,
                    subtaskId: change.type === 'subtask' ? change.subtask.id : null
                  }
                });
                notificationsSent++;
              } catch (err) {
                logger.error('[DueDateChecker] Contact task notification failed', { error: err.message });
              }
            }
          }
        }

        // Custom reminders
        const reminders = [];
        const taskReminder = checkReminder(task);
        if (taskReminder) reminders.push({ type: 'task', task, ...taskReminder });
        processSubtaskReminders(task.subtasks, contact._id, reminders);

        if (reminders.length > 0) {
          if (taskReminder) task.reminderSent = true;
          if (reminders.some(r => r.type === 'subtask')) {
            task.subtasks = markSubtaskRemindersSent(task.subtasks);
          }
          contactModified = true;

          for (const rem of reminders) {
            const title = rem.type === 'task' ? rem.task.title : rem.subtask.title;
            const msg = getReminderMessage(title, rem.dueDate, rem.daysRemaining);

            const usersToNotify = new Set();
            if (task.assignedTo?.length > 0) task.assignedTo.forEach(uid => usersToNotify.add(uid));
            usersToNotify.add(contact.userId.toString());

            for (const userId of usersToNotify) {
              try {
                await notificationService.createNotification({
                  userId,
                  type: rem.type === 'task' ? 'task.dueDate' : 'subtask.dueDate',
                  title: msg.title,
                  message: msg.body,
                  actorName: 'Systém',
                  relatedType: 'contact',
                  relatedId: contact._id.toString(),
                  relatedName: contact.name || 'Kontakt',
                  data: {
                    contactId: contact._id.toString(),
                    taskId: task.id,
                    subtaskId: rem.type === 'subtask' ? rem.subtask.id : null
                  }
                });
                notificationsSent++;
              } catch (err) {
                logger.error('[DueDateChecker] Contact task reminder failed', { error: err.message });
              }
            }
          }
        }

        // Update urgency levels
        if (changes.length > 0) {
          const currentTaskLevel = getUrgencyLevel(task.dueDate);
          task.lastUrgencyLevel = currentTaskLevel;
          task.subtasks = updateSubtaskUrgencyLevels(task.subtasks);
          contactModified = true;
        }
      }

      if (contactModified) {
        await Contact.updateOne({ _id: contact._id }, { tasks: contact.tasks });
        contactsUpdated++;
      }
    }

    logger.info(`[DueDateChecker] Contact tasks: ${notificationsSent} notifications, ${contactsUpdated} contacts updated`);
    return { notificationsSent, contactsUpdated };
  } catch (error) {
    logger.error('[DueDateChecker] Error checking contact due dates', { error: error.message });
    throw error;
  }
};

/**
 * Schedule due date checks to run at specific times
 * This should be called once when the server starts
 */
const scheduleDueDateChecks = () => {
  // Run check every hour
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // Run immediately on startup (after a short delay to let DB connect)
  setTimeout(() => {
    checkDueDates().catch(err => {
      logger.error('[DueDateChecker] Initial check failed', { error: err.message });
    });
  }, 10000); // 10 seconds after startup

  // Then run periodically
  setInterval(() => {
    checkDueDates().catch(err => {
      logger.error('[DueDateChecker] Scheduled check failed', { error: err.message });
    });
  }, INTERVAL_MS);

  logger.info('[DueDateChecker] Scheduled to run every hour');
};

module.exports = {
  checkDueDates,
  scheduleDueDateChecks,
  getUrgencyLevel
};
