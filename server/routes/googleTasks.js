const express = require('express');
const { google } = require('googleapis');
const { authenticateToken } = require('../middleware/auth');
const User = require('../models/User');
const Task = require('../models/Task');
const Contact = require('../models/Contact');

const router = express.Router();

// Google OAuth2 configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_TASKS_REDIRECT_URI = process.env.GOOGLE_TASKS_REDIRECT_URI || 'https://perun-crm-api.onrender.com/api/google-tasks/callback';

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_TASKS_REDIRECT_URI
);

// Scopes required for Google Tasks
const SCOPES = ['https://www.googleapis.com/auth/tasks'];

// Helper function for delays (used for rate limiting)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to get authenticated tasks client for user
const getTasksClient = async (user) => {
  if (!user.googleTasks?.accessToken) {
    throw new Error('Google Tasks not connected');
  }

  oauth2Client.setCredentials({
    access_token: user.googleTasks.accessToken,
    refresh_token: user.googleTasks.refreshToken,
    expiry_date: user.googleTasks.tokenExpiry?.getTime()
  });

  // Check if token needs refresh
  if (user.googleTasks.tokenExpiry && new Date() >= user.googleTasks.tokenExpiry) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    user.googleTasks.accessToken = credentials.access_token;
    user.googleTasks.tokenExpiry = new Date(credentials.expiry_date);
    await user.save();
    oauth2Client.setCredentials(credentials);
  }

  return google.tasks({ version: 'v1', auth: oauth2Client });
};

// Get Google Tasks authorization URL
router.get('/auth-url', authenticateToken, (req, res) => {
  try {
    const state = req.user.id.toString();
    console.log('Generating Google Tasks auth URL for user:', state);

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      state: state,
      prompt: 'consent'
    });

    console.log('Generated auth URL:', authUrl);
    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ message: 'Chyba pri generovaní autorizačného linku' });
  }
});

// OAuth callback - handle Google's response
router.get('/callback', async (req, res) => {
  const baseUrl = process.env.CLIENT_URL || 'https://perun-crm.onrender.com';

  console.log('Google Tasks callback - full query:', req.query);

  try {
    const { code, state: userId } = req.query;

    console.log('Google Tasks callback received:', { code: !!code, userId });

    if (!code || !userId) {
      return res.redirect(`${baseUrl}/tasks?google_tasks=error&message=missing_params`);
    }

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    console.log('Tokens received:', { hasAccessToken: !!tokens.access_token, hasRefreshToken: !!tokens.refresh_token });

    // Update user with Google Tasks credentials
    const user = await User.findById(userId);
    if (!user) {
      return res.redirect(`${baseUrl}/tasks?google_tasks=error&message=user_not_found`);
    }

    // Set credentials to create task list
    oauth2Client.setCredentials(tokens);
    const tasksApi = google.tasks({ version: 'v1', auth: oauth2Client });

    // Try to find or create "Perun CRM" task list
    let taskListId = null;
    try {
      const taskListsResponse = await tasksApi.tasklists.list();
      const taskLists = taskListsResponse.data.items || [];

      // Find existing Perun CRM list
      const existingList = taskLists.find(list => list.title === 'Perun CRM');

      if (existingList) {
        taskListId = existingList.id;
        console.log('Found existing Perun CRM task list:', taskListId);
      } else {
        // Create new task list
        const newList = await tasksApi.tasklists.insert({
          resource: { title: 'Perun CRM' }
        });
        taskListId = newList.data.id;
        console.log('Created new Perun CRM task list:', taskListId);
      }
    } catch (e) {
      console.error('Error creating task list:', e.message);
      // Use default task list as fallback
      const defaultList = await tasksApi.tasklists.list();
      taskListId = defaultList.data.items?.[0]?.id || '@default';
    }

    user.googleTasks = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      taskListId: taskListId,
      enabled: true,
      connectedAt: new Date(),
      syncedTaskIds: user.googleTasks?.syncedTaskIds || new Map()
    };

    await user.save();
    console.log('User updated with Google Tasks credentials');

    res.redirect(`${baseUrl}/tasks?google_tasks=connected`);
  } catch (error) {
    console.error('Error in Google Tasks callback:', error);
    res.redirect(`${baseUrl}/tasks?google_tasks=error&message=` + encodeURIComponent(error.message));
  }
});

// Get connection status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    res.json({
      connected: user.googleTasks?.enabled || false,
      connectedAt: user.googleTasks?.connectedAt || null
    });
  } catch (error) {
    console.error('Error getting Google Tasks status:', error);
    res.status(500).json({ message: 'Chyba pri získavaní stavu' });
  }
});

// Disconnect Google Tasks
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (user.googleTasks?.accessToken) {
      try {
        await oauth2Client.revokeToken(user.googleTasks.accessToken);
      } catch (e) {
        console.log('Token revocation failed:', e.message);
      }
    }

    user.googleTasks = {
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
      taskListId: null,
      enabled: false,
      connectedAt: null,
      syncedTaskIds: new Map()
    };

    await user.save();

    res.json({ success: true, message: 'Google Tasks bol odpojený' });
  } catch (error) {
    console.error('Error disconnecting Google Tasks:', error);
    res.status(500).json({ message: 'Chyba pri odpájaní' });
  }
});

// Sync all tasks to Google Tasks
router.post('/sync', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    const tasksApi = await getTasksClient(user);

    // Get all tasks with due dates
    const globalTasks = await Task.find({});
    const contacts = await Contact.find({});

    const tasksToSync = [];

    // Collect global tasks
    for (const task of globalTasks) {
      if (task.dueDate && !task.completed) {
        tasksToSync.push({
          id: task._id.toString(),
          title: task.title,
          notes: task.description || '',
          dueDate: task.dueDate,
          completed: task.completed,
          contact: null
        });
      }
      collectSubtasksForSync(task.subtasks, task.title, null, tasksToSync);
    }

    // Collect contact tasks
    for (const contact of contacts) {
      if (contact.tasks) {
        for (const task of contact.tasks) {
          if (task.dueDate && !task.completed) {
            tasksToSync.push({
              id: task.id,
              title: task.title,
              notes: task.description || '',
              dueDate: task.dueDate,
              completed: task.completed,
              contact: contact.name
            });
          }
          collectSubtasksForSync(task.subtasks, task.title, contact.name, tasksToSync);
        }
      }
    }

    let synced = 0;
    let updated = 0;
    let errors = 0;
    let skipped = 0;
    let quotaExceeded = false;

    console.log('Tasks to sync:', tasksToSync.length);

    // Filter out tasks that are already synced and haven't changed
    const tasksNeedingSync = [];
    for (const task of tasksToSync) {
      // Skip tasks without valid ID
      if (!task.id) {
        console.log('Skipping task without ID:', task.title);
        skipped++;
        continue;
      }

      // Skip tasks with invalid due date
      if (!task.dueDate || isNaN(new Date(task.dueDate).getTime())) {
        console.log('Skipping task with invalid date:', task.title, task.dueDate);
        skipped++;
        continue;
      }

      const existingTaskId = user.googleTasks.syncedTaskIds?.get(task.id);
      if (existingTaskId) {
        // Already synced - mark as updated without API call
        updated++;
      } else {
        // Needs to be created
        tasksNeedingSync.push(task);
      }
    }

    console.log('Tasks needing sync (new only):', tasksNeedingSync.length);

    // Process tasks in batches with exponential backoff
    const BATCH_SIZE = 10; // Process 10 tasks at a time
    const batches = [];
    for (let i = 0; i < tasksNeedingSync.length; i += BATCH_SIZE) {
      batches.push(tasksNeedingSync.slice(i, i + BATCH_SIZE));
    }

    console.log(`Processing ${batches.length} batches of up to ${BATCH_SIZE} tasks each`);

    let currentBackoff = 500; // Start with 500ms delay
    const MAX_BACKOFF = 32000; // Max 32 seconds
    const MAX_RETRIES = 3;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      // Stop if quota exceeded
      if (quotaExceeded) {
        // Count remaining tasks as skipped
        for (let i = batchIndex; i < batches.length; i++) {
          skipped += batches[i].length;
        }
        break;
      }

      const batch = batches[batchIndex];
      console.log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} tasks)`);

      // Process batch with concurrent requests (but limited)
      const batchPromises = batch.map(async (task) => {
        let retries = 0;
        let lastError = null;

        while (retries < MAX_RETRIES) {
          try {
            const taskData = createGoogleTaskData(task);
            const newTask = await tasksApi.tasks.insert({
              tasklist: user.googleTasks.taskListId,
              resource: taskData
            });
            return { success: true, taskId: task.id, googleTaskId: newTask.data.id };
          } catch (error) {
            lastError = error;

            // Check for quota exceeded - don't retry
            if (error.code === 403 && (error.message?.includes('Quota') || error.message?.includes('quota') || error.message?.includes('Rate Limit'))) {
              return { success: false, taskId: task.id, error: 'quota', message: error.message };
            }

            // Rate limited - retry with backoff
            if (error.code === 429 || error.response?.status === 429) {
              retries++;
              const waitTime = currentBackoff * Math.pow(2, retries);
              console.log(`Rate limited on task ${task.id}, retry ${retries}/${MAX_RETRIES} after ${waitTime}ms`);
              await delay(Math.min(waitTime, MAX_BACKOFF));
              continue;
            }

            // Other errors - log and don't retry
            console.error(`Error syncing task ${task.id}:`, error.message);
            return { success: false, taskId: task.id, error: 'other', message: error.message };
          }
        }

        // Max retries reached
        return { success: false, taskId: task.id, error: 'max_retries', message: lastError?.message };
      });

      // Wait for all tasks in batch to complete
      const results = await Promise.all(batchPromises);

      // Process results
      for (const result of results) {
        if (result.success) {
          user.googleTasks.syncedTaskIds.set(result.taskId, result.googleTaskId);
          synced++;
          // Reset backoff on success
          currentBackoff = 500;
        } else if (result.error === 'quota') {
          quotaExceeded = true;
          skipped++;
        } else {
          errors++;
        }
      }

      // Add delay between batches to avoid rate limiting
      if (batchIndex < batches.length - 1 && !quotaExceeded) {
        await delay(currentBackoff);
        // Gradually increase backoff if we had errors
        if (results.some(r => !r.success)) {
          currentBackoff = Math.min(currentBackoff * 1.5, MAX_BACKOFF);
        }
      }
    }

    await user.save();

    let message = `Synchronizované: ${synced} nových, ${updated} už existujúcich`;
    if (skipped > 0) message += `, ${skipped} preskočených`;
    if (errors > 0) message += `, ${errors} chýb`;
    if (quotaExceeded) message += ' (denný limit Google API dosiahnutý - skúste zajtra)';

    res.json({
      success: true,
      message,
      synced,
      updated,
      skipped,
      errors,
      quotaExceeded
    });
  } catch (error) {
    console.error('Error syncing to Google Tasks:', error);
    res.status(500).json({ message: 'Chyba pri synchronizácii: ' + error.message });
  }
});

// Clean up completed tasks from Google Tasks
router.post('/cleanup', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    const tasksApi = await getTasksClient(user);

    // Get all current task IDs
    const globalTasks = await Task.find({});
    const contacts = await Contact.find({});

    const currentTaskIds = new Set();

    for (const task of globalTasks) {
      currentTaskIds.add(task._id.toString());
    }

    for (const contact of contacts) {
      if (contact.tasks) {
        for (const task of contact.tasks) {
          currentTaskIds.add(task.id);
        }
      }
    }

    let deleted = 0;
    let errors = 0;

    if (user.googleTasks.syncedTaskIds) {
      const syncedTaskIds = Array.from(user.googleTasks.syncedTaskIds.entries());

      for (const [taskId, googleTaskId] of syncedTaskIds) {
        if (!currentTaskIds.has(taskId)) {
          try {
            await tasksApi.tasks.delete({
              tasklist: user.googleTasks.taskListId,
              task: googleTaskId
            });
            deleted++;
          } catch (e) {
            console.log(`Failed to delete task ${googleTaskId}:`, e.message);
            errors++;
          }
          user.googleTasks.syncedTaskIds.delete(taskId);
        }
      }
    }

    await user.save();

    res.json({
      success: true,
      message: `Vyčistené: ${deleted} úloh odstránených, ${errors} chýb`,
      deleted,
      errors
    });
  } catch (error) {
    console.error('Error cleaning up tasks:', error);
    res.status(500).json({ message: 'Chyba pri čistení: ' + error.message });
  }
});

// Helper functions
function collectSubtasksForSync(subtasks, parentTitle, contactName, tasksToSync) {
  if (!subtasks) return;
  for (const subtask of subtasks) {
    if (subtask.dueDate && !subtask.completed) {
      tasksToSync.push({
        id: subtask.id,
        title: `${subtask.title} (${parentTitle})`,
        notes: subtask.notes || '',
        dueDate: subtask.dueDate,
        completed: subtask.completed,
        contact: contactName
      });
    }
    if (subtask.subtasks) {
      collectSubtasksForSync(subtask.subtasks, parentTitle, contactName, tasksToSync);
    }
  }
}

function createGoogleTaskData(task) {
  // Google Tasks API uses RFC 3339 timestamp for due date
  const dueDate = new Date(task.dueDate);
  // Set to end of day in UTC
  dueDate.setUTCHours(23, 59, 59, 999);

  let notes = task.notes || '';
  if (task.contact) {
    notes += notes ? '\n\n' : '';
    notes += `Kontakt: ${task.contact}`;
  }

  return {
    title: task.title,
    notes: notes,
    due: dueDate.toISOString(),
    status: task.completed ? 'completed' : 'needsAction'
  };
}

// ==================== AUTO-SYNC HELPER FUNCTIONS ====================

/**
 * Automatically sync a task to Google Tasks for all users who have Google Tasks connected
 * Uses exponential backoff for rate limiting
 */
const autoSyncTaskToGoogleTasks = async (taskData, action) => {
  try {
    // Skip if task has no due date (for create/update)
    if (action !== 'delete' && !taskData.dueDate) {
      console.log('Auto-sync Tasks: Task has no due date, skipping sync');
      return;
    }

    let taskId = taskData.id || taskData._id;
    if (taskId && typeof taskId === 'object' && taskId.toString) {
      taskId = taskId.toString();
    }

    console.log(`Auto-sync Tasks: Starting sync for task "${taskData.title}" (ID: ${taskId}, action: ${action})`);

    // Find all users with Google Tasks enabled
    const users = await User.find({ 'googleTasks.enabled': true });

    if (users.length === 0) {
      console.log('Auto-sync Tasks: No users with Google Tasks connected');
      return;
    }

    console.log(`Auto-sync Tasks: Found ${users.length} users with Google Tasks connected`);

    // Helper for retrying with exponential backoff
    const retryWithBackoff = async (fn, maxRetries = 3) => {
      let lastError;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await fn();
        } catch (error) {
          lastError = error;
          // Don't retry on quota exceeded
          if (error.code === 403 && (error.message?.includes('Quota') || error.message?.includes('quota'))) {
            throw error;
          }
          // Retry on rate limit with exponential backoff
          if (error.code === 429 || error.response?.status === 429) {
            const waitTime = Math.min(1000 * Math.pow(2, attempt), 16000);
            console.log(`Auto-sync Tasks: Rate limited, waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);
            await delay(waitTime);
            continue;
          }
          // Don't retry other errors
          throw error;
        }
      }
      throw lastError;
    };

    for (const user of users) {
      try {
        const tasksApi = await getTasksClient(user);

        if (action === 'delete') {
          const googleTaskId = user.googleTasks.syncedTaskIds?.get(taskId);
          if (googleTaskId) {
            try {
              await retryWithBackoff(() => tasksApi.tasks.delete({
                tasklist: user.googleTasks.taskListId,
                task: googleTaskId
              }));
              console.log(`Auto-sync Tasks: Deleted task ${googleTaskId} for user ${user.username}`);
            } catch (e) {
              console.log(`Auto-sync Tasks: Task deletion failed:`, e.message);
            }
            user.googleTasks.syncedTaskIds.delete(taskId);
            await user.save();
          }
        } else {
          const googleTaskData = createGoogleTaskData({
            id: taskId,
            title: taskData.title,
            notes: taskData.description || taskData.notes || '',
            dueDate: taskData.dueDate,
            completed: taskData.completed,
            contact: taskData.contactName || taskData.contact || null
          });

          const existingTaskId = user.googleTasks.syncedTaskIds?.get(taskId);

          if (existingTaskId) {
            try {
              await retryWithBackoff(() => tasksApi.tasks.update({
                tasklist: user.googleTasks.taskListId,
                task: existingTaskId,
                resource: googleTaskData
              }));
              console.log(`Auto-sync Tasks: Updated task ${existingTaskId} for user ${user.username}`);
            } catch (e) {
              if (e.code === 404) {
                const newTask = await retryWithBackoff(() => tasksApi.tasks.insert({
                  tasklist: user.googleTasks.taskListId,
                  resource: googleTaskData
                }));
                user.googleTasks.syncedTaskIds.set(taskId, newTask.data.id);
                await user.save();
                console.log(`Auto-sync Tasks: Created new task for user ${user.username}`);
              } else {
                throw e;
              }
            }
          } else {
            const newTask = await retryWithBackoff(() => tasksApi.tasks.insert({
              tasklist: user.googleTasks.taskListId,
              resource: googleTaskData
            }));
            user.googleTasks.syncedTaskIds.set(taskId, newTask.data.id);
            await user.save();
            console.log(`Auto-sync Tasks: Created task ${newTask.data.id} for user ${user.username}`);
          }
        }
      } catch (error) {
        console.error(`Auto-sync Tasks: Error syncing for user ${user.username}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Auto-sync Tasks: Error in autoSyncTaskToGoogleTasks:', error.message);
  }
};

const autoDeleteTaskFromGoogleTasks = async (taskId) => {
  await autoSyncTaskToGoogleTasks({ id: taskId }, 'delete');
};

module.exports = router;
module.exports.autoSyncTaskToGoogleTasks = autoSyncTaskToGoogleTasks;
module.exports.autoDeleteTaskFromGoogleTasks = autoDeleteTaskFromGoogleTasks;
