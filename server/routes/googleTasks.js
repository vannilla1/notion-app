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

// Daily quota limit - Google Tasks API allows 50,000 queries per day
const DAILY_QUOTA_LIMIT = 50000;

// Create a simple hash of task data to detect changes
const createTaskHash = (task) => {
  const data = `${task.title}|${task.dueDate}|${task.completed}|${task.notes || ''}|${task.contact || ''}`;
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
};

// Check and reset daily quota if needed
const checkAndResetQuota = (user) => {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (!user.googleTasks.quotaResetDate || new Date(user.googleTasks.quotaResetDate) < today) {
    // Reset quota for new day
    user.googleTasks.quotaUsedToday = 0;
    user.googleTasks.quotaResetDate = today;
    return true;
  }
  return false;
};

// Get remaining quota for today
const getRemainingQuota = (user) => {
  checkAndResetQuota(user);
  return DAILY_QUOTA_LIMIT - (user.googleTasks.quotaUsedToday || 0);
};

// Increment quota usage
const incrementQuota = (user, count = 1) => {
  checkAndResetQuota(user);
  user.googleTasks.quotaUsedToday = (user.googleTasks.quotaUsedToday || 0) + count;
};

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

// Get connection status with quota info and pending tasks count
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    // Check and reset quota if needed
    checkAndResetQuota(user);
    await user.save();

    const remainingQuota = getRemainingQuota(user);
    const quotaPercentUsed = Math.round(((DAILY_QUOTA_LIMIT - remainingQuota) / DAILY_QUOTA_LIMIT) * 100);

    // Count pending tasks (tasks with due date that are not yet synced)
    let pendingCount = 0;
    let totalTasksWithDueDate = 0;
    let syncedCount = 0;

    if (user.googleTasks?.enabled) {
      const globalTasks = await Task.find({});
      const contacts = await Contact.find({});

      // Count global tasks with due dates
      for (const task of globalTasks) {
        if (task.dueDate && !task.completed) {
          totalTasksWithDueDate++;
          const taskId = task._id.toString();
          const existingGoogleTaskId = user.googleTasks.syncedTaskIds?.get(taskId);
          if (existingGoogleTaskId && typeof existingGoogleTaskId === 'string' && existingGoogleTaskId.length > 0) {
            syncedCount++;
          }
        }
        // Count subtasks
        if (task.subtasks) {
          countSubtasksPending(task.subtasks, user, (total, synced) => {
            totalTasksWithDueDate += total;
            syncedCount += synced;
          });
        }
      }

      // Count contact tasks with due dates
      for (const contact of contacts) {
        if (contact.tasks) {
          for (const task of contact.tasks) {
            if (task.dueDate && !task.completed) {
              totalTasksWithDueDate++;
              const existingGoogleTaskId = user.googleTasks.syncedTaskIds?.get(task.id);
              if (existingGoogleTaskId && typeof existingGoogleTaskId === 'string' && existingGoogleTaskId.length > 0) {
                syncedCount++;
              }
            }
            // Count subtasks
            if (task.subtasks) {
              countSubtasksPending(task.subtasks, user, (total, synced) => {
                totalTasksWithDueDate += total;
                syncedCount += synced;
              });
            }
          }
        }
      }

      pendingCount = totalTasksWithDueDate - syncedCount;
    }

    res.json({
      connected: user.googleTasks?.enabled || false,
      connectedAt: user.googleTasks?.connectedAt || null,
      lastSyncAt: user.googleTasks?.lastSyncAt || null,
      pendingTasks: {
        total: totalTasksWithDueDate,
        synced: syncedCount,
        pending: pendingCount
      },
      quota: {
        used: user.googleTasks?.quotaUsedToday || 0,
        limit: DAILY_QUOTA_LIMIT,
        remaining: remainingQuota,
        percentUsed: quotaPercentUsed,
        resetsAt: getNextQuotaReset()
      }
    });
  } catch (error) {
    console.error('Error getting Google Tasks status:', error);
    res.status(500).json({ message: 'Chyba pri získavaní stavu' });
  }
});

// Helper function to count subtasks pending sync
function countSubtasksPending(subtasks, user, callback) {
  let total = 0;
  let synced = 0;
  if (!subtasks) return callback(total, synced);

  for (const subtask of subtasks) {
    if (subtask.dueDate && !subtask.completed) {
      total++;
      const existingGoogleTaskId = user.googleTasks.syncedTaskIds?.get(subtask.id);
      if (existingGoogleTaskId && typeof existingGoogleTaskId === 'string' && existingGoogleTaskId.length > 0) {
        synced++;
      }
    }
    if (subtask.subtasks) {
      countSubtasksPending(subtask.subtasks, user, (subTotal, subSynced) => {
        total += subTotal;
        synced += subSynced;
      });
    }
  }
  callback(total, synced);
}

// Helper to get next quota reset time
function getNextQuotaReset() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.toISOString();
}

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

// Sync all tasks to Google Tasks (with incremental sync and quota checking)
router.post('/sync', authenticateToken, async (req, res) => {
  console.log('=== SYNC STARTED ===');
  console.log('User ID:', req.user.id);
  const forceSync = req.body.force === true;
  console.log('Force sync:', forceSync);

  try {
    const user = await User.findById(req.user.id);
    console.log('User found:', !!user);

    // If force sync, reset all tracking maps
    if (forceSync) {
      console.log('Force sync - resetting all tracking maps');
      user.googleTasks.syncedTaskIds = new Map();
      user.googleTasks.syncedTaskHashes = new Map();
    }

    if (!user.googleTasks?.enabled) {
      console.log('Google Tasks not enabled');
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    console.log('Google Tasks enabled, checking quota...');

    // Check quota before starting
    checkAndResetQuota(user);
    const remainingQuota = getRemainingQuota(user);
    console.log('Remaining quota:', remainingQuota);

    if (remainingQuota < 10) {
      return res.status(429).json({
        message: 'Denný limit API bol dosiahnutý. Skúste zajtra.',
        quotaExceeded: true,
        quota: {
          used: user.googleTasks.quotaUsedToday,
          limit: DAILY_QUOTA_LIMIT,
          remaining: remainingQuota,
          resetsAt: getNextQuotaReset()
        }
      });
    }

    console.log('Getting tasks client...');
    console.log('Task list ID:', user.googleTasks.taskListId);

    // Verify task list ID exists
    if (!user.googleTasks.taskListId) {
      console.log('ERROR: No task list ID configured!');
      return res.status(400).json({ message: 'Google Tasks task list nie je nakonfigurovaný. Skúste sa odpojiť a znova pripojiť.' });
    }

    const tasksApi = await getTasksClient(user);
    console.log('Tasks client obtained');

    // Verify task list exists - if not, recreate it
    try {
      console.log('Verifying task list exists...');
      await tasksApi.tasklists.get({ tasklist: user.googleTasks.taskListId });
      console.log('Task list verified');
    } catch (listError) {
      console.log('Task list not found, creating new one...', listError.message);
      // Task list doesn't exist, create a new one
      try {
        const newList = await tasksApi.tasklists.insert({
          resource: { title: 'Perun CRM' }
        });
        user.googleTasks.taskListId = newList.data.id;
        user.googleTasks.syncedTaskIds = new Map(); // Reset synced tasks
        user.googleTasks.syncedTaskHashes = new Map();
        await user.save();
        console.log('Created new task list:', newList.data.id);
      } catch (createError) {
        console.error('Failed to create task list:', createError.message);
        return res.status(500).json({ message: 'Nepodarilo sa vytvoriť task list v Google Tasks' });
      }
    }

    // Get all tasks with due dates
    console.log('Fetching tasks from database...');
    const globalTasks = await Task.find({});
    const contacts = await Contact.find({});
    console.log(`Found ${globalTasks.length} global tasks, ${contacts.length} contacts`);

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
          contact: null,
          modifiedAt: task.modifiedAt || task.updatedAt
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
              contact: contact.name,
              modifiedAt: task.modifiedAt
            });
          }
          collectSubtasksForSync(task.subtasks, task.title, contact.name, tasksToSync);
        }
      }
    }

    let synced = 0;
    let updated = 0;
    let unchanged = 0;
    let errors = 0;
    let skipped = 0;
    let quotaExceeded = false;

    console.log('Tasks to sync:', tasksToSync.length);
    console.log('Remaining quota:', remainingQuota);

    // Initialize hash map if not exists
    if (!user.googleTasks.syncedTaskHashes) {
      console.log('Initializing syncedTaskHashes map');
      user.googleTasks.syncedTaskHashes = new Map();
    }
    if (!user.googleTasks.syncedTaskIds) {
      console.log('Initializing syncedTaskIds map');
      user.googleTasks.syncedTaskIds = new Map();
    }

    console.log('Starting incremental sync analysis...');

    // Filter tasks: new tasks to create, changed tasks to update
    const tasksToCreate = [];
    const tasksToUpdate = [];

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

      const existingGoogleTaskId = user.googleTasks.syncedTaskIds?.get(task.id);
      const currentHash = createTaskHash(task);
      const storedHash = user.googleTasks.syncedTaskHashes?.get(task.id);

      // Validate that existingGoogleTaskId is a non-empty string
      const hasValidGoogleTaskId = existingGoogleTaskId && typeof existingGoogleTaskId === 'string' && existingGoogleTaskId.length > 0;

      if (hasValidGoogleTaskId) {
        // Task exists in Google - check if it changed
        if (storedHash !== currentHash) {
          // Task changed - needs update
          tasksToUpdate.push({ ...task, googleTaskId: existingGoogleTaskId, hash: currentHash });
        } else {
          // Task unchanged - skip
          unchanged++;
        }
      } else {
        // New task or invalid Google Task ID - needs to be created
        tasksToCreate.push({ ...task, hash: currentHash });
      }
    }

    console.log(`Incremental sync analysis complete: ${tasksToCreate.length} new, ${tasksToUpdate.length} changed, ${unchanged} unchanged`);

    // If nothing to do, return early
    if (tasksToCreate.length === 0 && tasksToUpdate.length === 0) {
      console.log('No tasks to sync, returning early');
      user.googleTasks.lastSyncAt = new Date();
      await user.save();
      return res.json({
        success: true,
        message: `Všetky úlohy sú aktuálne (${unchanged} nezmenených)`,
        synced: 0,
        updated: 0,
        unchanged,
        skipped,
        errors: 0,
        quotaExceeded: false,
        quota: {
          used: user.googleTasks.quotaUsedToday || 0,
          limit: DAILY_QUOTA_LIMIT,
          remaining: getRemainingQuota(user),
          resetsAt: getNextQuotaReset()
        }
      });
    }

    // Check if we have enough quota for all tasks
    const totalTasksToProcess = tasksToCreate.length + tasksToUpdate.length;
    const availableForSync = Math.min(totalTasksToProcess, remainingQuota);

    if (totalTasksToProcess > remainingQuota) {
      console.log(`Quota warning: Need ${totalTasksToProcess} API calls, only ${remainingQuota} remaining`);
    }

    // Process tasks in batches with exponential backoff
    // Google Tasks API has rate limits - keep batch size small and add delays
    const BATCH_SIZE = 5;  // Reduced from 10 to avoid rate limits
    let currentBackoff = 1000;  // Start with 1 second delay between batches
    const MAX_BACKOFF = 32000;
    const MAX_RETRIES = 3;

    // Combine tasks to create and update, prioritizing updates (they're more important)
    const allTasksToProcess = [...tasksToUpdate, ...tasksToCreate];

    const batches = [];
    for (let i = 0; i < allTasksToProcess.length; i += BATCH_SIZE) {
      batches.push(allTasksToProcess.slice(i, i + BATCH_SIZE));
    }

    console.log(`Processing ${batches.length} batches of up to ${BATCH_SIZE} tasks each`);
    console.log('Starting batch processing loop...');

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      console.log(`\n--- Starting batch ${batchIndex + 1}/${batches.length} ---`);
      // Stop if quota exceeded
      if (quotaExceeded) {
        for (let i = batchIndex; i < batches.length; i++) {
          skipped += batches[i].length;
        }
        break;
      }

      // Check remaining quota before each batch
      if (getRemainingQuota(user) < BATCH_SIZE) {
        console.log('Quota running low, stopping sync');
        quotaExceeded = true;
        for (let i = batchIndex; i < batches.length; i++) {
          skipped += batches[i].length;
        }
        break;
      }

      const batch = batches[batchIndex];
      console.log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} tasks)`);

      // Process batch with concurrent requests
      const batchPromises = batch.map(async (task) => {
        let retries = 0;
        let lastError = null;
        const isUpdate = !!task.googleTaskId;

        while (retries < MAX_RETRIES) {
          try {
            const taskData = createGoogleTaskData(task);

            if (isUpdate) {
              // Update existing task
              console.log(`Updating task ${task.id} -> Google ${task.googleTaskId}`);
              await tasksApi.tasks.update({
                tasklist: user.googleTasks.taskListId,
                task: task.googleTaskId,
                resource: taskData
              });
              return { success: true, taskId: task.id, googleTaskId: task.googleTaskId, hash: task.hash, action: 'updated' };
            } else {
              // Create new task
              console.log(`Creating task ${task.id}: "${task.title.substring(0, 30)}..."`);
              const newTask = await tasksApi.tasks.insert({
                tasklist: user.googleTasks.taskListId,
                resource: taskData
              });
              console.log(`Created Google task: ${newTask.data.id}`);
              return { success: true, taskId: task.id, googleTaskId: newTask.data.id, hash: task.hash, action: 'created' };
            }
          } catch (error) {
            lastError = error;
            console.log(`Error for task ${task.id}: code=${error.code}, message=${error.message}`);

            // Check for quota/rate limit exceeded - retry with longer delay
            if (error.code === 403 && (error.message?.includes('Quota') || error.message?.includes('quota') || error.message?.includes('Rate Limit'))) {
              retries++;
              if (retries < MAX_RETRIES) {
                // Wait longer for rate limit errors (5-20 seconds)
                const waitTime = 5000 * Math.pow(2, retries);
                console.log(`Rate limit hit for task ${task.id}, waiting ${waitTime}ms before retry ${retries}/${MAX_RETRIES}`);
                await delay(waitTime);
                continue;
              }
              return { success: false, taskId: task.id, error: 'quota', message: error.message };
            }

            // Handle 404 for updates - task was deleted from Google, recreate it
            if (isUpdate && error.code === 404) {
              try {
                const newTask = await tasksApi.tasks.insert({
                  tasklist: user.googleTasks.taskListId,
                  resource: createGoogleTaskData(task)
                });
                return { success: true, taskId: task.id, googleTaskId: newTask.data.id, hash: task.hash, action: 'recreated' };
              } catch (insertError) {
                return { success: false, taskId: task.id, error: 'other', message: insertError.message };
              }
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

        return { success: false, taskId: task.id, error: 'max_retries', message: lastError?.message };
      });

      const results = await Promise.all(batchPromises);

      // Process results and track quota
      let batchApiCalls = 0;
      for (const result of results) {
        batchApiCalls++;
        if (result.success) {
          user.googleTasks.syncedTaskIds.set(result.taskId, result.googleTaskId);
          user.googleTasks.syncedTaskHashes.set(result.taskId, result.hash);

          if (result.action === 'created' || result.action === 'recreated') {
            synced++;
          } else {
            updated++;
          }
          currentBackoff = 500;
        } else if (result.error === 'quota') {
          quotaExceeded = true;
          skipped++;
        } else {
          errors++;
        }
      }

      // Track quota usage
      incrementQuota(user, batchApiCalls);

      // Add delay between batches - important to avoid rate limits
      if (batchIndex < batches.length - 1 && !quotaExceeded) {
        // If any errors, increase backoff significantly
        if (results.some(r => !r.success)) {
          currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF);
          console.log(`Increased backoff to ${currentBackoff}ms due to errors`);
        }
        console.log(`Waiting ${currentBackoff}ms before next batch...`);
        await delay(currentBackoff);
      }
    }

    // Update last sync time
    console.log('=== SYNC COMPLETE ===');
    console.log(`Results: ${synced} new, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped, ${errors} errors`);
    user.googleTasks.lastSyncAt = new Date();
    await user.save();
    console.log('User saved successfully');

    let message = `Synchronizované: ${synced} nových, ${updated} aktualizovaných, ${unchanged} nezmenených`;
    if (skipped > 0) message += `, ${skipped} preskočených`;
    if (errors > 0) message += `, ${errors} chýb`;
    if (quotaExceeded) message += ' (denný limit Google API dosiahnutý - skúste zajtra)';

    res.json({
      success: true,
      message,
      synced,
      updated,
      unchanged,
      skipped,
      errors,
      quotaExceeded,
      quota: {
        used: user.googleTasks.quotaUsedToday,
        limit: DAILY_QUOTA_LIMIT,
        remaining: getRemainingQuota(user),
        resetsAt: getNextQuotaReset()
      }
    });
  } catch (error) {
    console.error('=== SYNC ERROR ===');
    console.error('Error syncing to Google Tasks:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({ message: 'Chyba pri synchronizácii: ' + error.message });
  }
});

// Reset sync state - clears all tracking maps to force full re-sync
router.post('/reset-sync', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    console.log('Resetting sync state for user:', user.username);

    user.googleTasks.syncedTaskIds = new Map();
    user.googleTasks.syncedTaskHashes = new Map();
    user.googleTasks.quotaUsedToday = 0;
    await user.save();

    res.json({
      success: true,
      message: 'Synchronizačný stav bol resetovaný. Teraz môžete spustiť novú synchronizáciu.'
    });
  } catch (error) {
    console.error('Error resetting sync state:', error);
    res.status(500).json({ message: 'Chyba pri resetovaní: ' + error.message });
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
