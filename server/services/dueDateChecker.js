const Task = require('../models/Task');
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
      body: `Úloha "${title}" má termín do 7 dní (${formattedDate})`
    },
    'warning-danger': {
      title: '🔴 Urgentný termín',
      body: `Úloha "${title}" má termín do 3 dní (${formattedDate})!`
    },
    'danger-overdue': {
      title: '❗ Termín vypršal',
      body: `Úloha "${title}" je po termíne (${formattedDate})!`
    },
    'success-danger': {
      title: '🔴 Urgentný termín',
      body: `Úloha "${title}" má termín do 3 dní (${formattedDate})!`
    },
    'success-overdue': {
      title: '❗ Termín vypršal',
      body: `Úloha "${title}" je po termíne (${formattedDate})!`
    },
    'warning-overdue': {
      title: '❗ Termín vypršal',
      body: `Úloha "${title}" je po termíne (${formattedDate})!`
    },
    'null-warning': {
      title: '⚠️ Blíži sa termín',
      body: `Úloha "${title}" má termín do 7 dní (${formattedDate})`
    },
    'null-danger': {
      title: '🔴 Urgentný termín',
      body: `Úloha "${title}" má termín do 3 dní (${formattedDate})!`
    },
    'null-overdue': {
      title: '❗ Termín vypršal',
      body: `Úloha "${title}" je po termíne (${formattedDate})!`
    }
  };

  const key = `${oldLevel || 'null'}-${newLevel}`;
  return messages[key] || null;
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

    // Get all incomplete tasks with due dates
    const tasks = await Task.find({
      completed: false,
      $or: [
        { dueDate: { $exists: true, $ne: null } },
        { 'subtasks.dueDate': { $exists: true, $ne: null } }
      ]
    });

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

          // Send push notification to each user
          for (const userId of usersToNotify) {
            try {
              await notificationService.sendPushNotification(userId, {
                title: message.title,
                body: message.body,
                type: change.type === 'task' ? 'task-due-date-urgent' : 'subtask-due-date-urgent',
                data: {
                  taskId: task._id.toString(),
                  subtaskId: change.type === 'subtask' ? change.subtask.id : null
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

      // Update stored urgency levels
      if (changes.length > 0) {
        const currentTaskLevel = getUrgencyLevel(task.dueDate);
        task.lastUrgencyLevel = currentTaskLevel;
        task.subtasks = updateSubtaskUrgencyLevels(task.subtasks);
        await task.save();
        tasksUpdated++;
      }
    }

    logger.info(`[DueDateChecker] Completed. Notifications sent: ${notificationsSent}, Tasks updated: ${tasksUpdated}`);

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
