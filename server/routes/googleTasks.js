const express = require('express');
const { google } = require('googleapis');
const mongoose = require('mongoose');
const { authenticateToken } = require('../middleware/auth');
const User = require('../models/User');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const logger = require('../utils/logger');

const router = express.Router();

// Validate MongoDB ObjectId
const isValidObjectId = (id) => {
  return id && mongoose.Types.ObjectId.isValid(id);
};

// Google OAuth2 configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_TASKS_REDIRECT_URI = process.env.GOOGLE_TASKS_REDIRECT_URI || 'https://perun-crm-api.onrender.com/api/google-tasks/callback';

// Validate OAuth configuration at startup
const isOAuthConfigured = () => {
  return GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET;
};

if (!isOAuthConfigured()) {
  logger.warn('[Google Tasks] OAuth not configured - integration will be disabled');
}

let oauth2Client = null;
try {
  oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_TASKS_REDIRECT_URI
  );
} catch (error) {
  logger.error('[Google Tasks] Failed to initialize OAuth client', { error: error.message });
}

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
  if (!oauth2Client) {
    throw new Error('Google Tasks OAuth not configured');
  }

  if (!user.googleTasks?.accessToken) {
    throw new Error('Google Tasks not connected');
  }

  oauth2Client.setCredentials({
    access_token: user.googleTasks.accessToken,
    refresh_token: user.googleTasks.refreshToken,
    expiry_date: user.googleTasks.tokenExpiry?.getTime()
  });

  // Check if token needs refresh (with 5 min buffer)
  const now = new Date();
  const tokenExpiry = user.googleTasks.tokenExpiry;
  const expiryBuffer = 5 * 60 * 1000; // 5 minutes

  if (tokenExpiry && now.getTime() >= tokenExpiry.getTime() - expiryBuffer) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      user.googleTasks.accessToken = credentials.access_token;
      user.googleTasks.tokenExpiry = new Date(credentials.expiry_date);
      if (credentials.refresh_token) {
        user.googleTasks.refreshToken = credentials.refresh_token;
      }
      await user.save();
      oauth2Client.setCredentials(credentials);
      logger.debug('[Google Tasks] Token refreshed', { userId: user._id });
    } catch (refreshError) {
      logger.error('[Google Tasks] Token refresh failed', { userId: user._id, error: refreshError.message });
      // If refresh fails, try to continue with existing token - it might still work
      if (refreshError.message?.includes('invalid_grant')) {
        // Token is completely invalid - user needs to reconnect
        throw new Error('Google Tasks token expired. Please reconnect your account.');
      }
    }
  }

  return google.tasks({ version: 'v1', auth: oauth2Client });
};

// Get Google Tasks authorization URL
router.get('/auth-url', authenticateToken, (req, res) => {
  try {
    // Validate Google OAuth configuration
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      logger.error('[Google Tasks] OAuth not configured');
      return res.status(503).json({ message: 'Google Tasks integrácia nie je nakonfigurovaná' });
    }

    const state = req.user.id.toString();
    logger.info('[Google Tasks] Generating auth URL', { userId: state });

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      state: state,
      prompt: 'consent'
    });

    logger.debug('[Google Tasks] Auth URL generated', { userId: state });
    res.json({ authUrl });
  } catch (error) {
    logger.error('[Google Tasks] Error generating auth URL', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri generovaní autorizačného linku' });
  }
});

// OAuth callback - handle Google's response
router.get('/callback', async (req, res) => {
  const baseUrl = process.env.CLIENT_URL || 'https://perun-crm.onrender.com';

  logger.debug('[Google Tasks] Callback received', { hasCode: !!req.query.code, hasState: !!req.query.state });

  try {
    const { code, state: userId } = req.query;

    // Validate required parameters
    if (!code || !userId) {
      logger.warn('[Google Tasks] Callback missing parameters', { hasCode: !!code, hasUserId: !!userId });
      return res.redirect(`${baseUrl}/tasks?google_tasks=error&message=missing_params`);
    }

    // Validate userId format to prevent injection
    if (!isValidObjectId(userId)) {
      logger.warn('[Google Tasks] Invalid userId in callback state', { userId });
      return res.redirect(`${baseUrl}/tasks?google_tasks=error&message=invalid_state`);
    }

    logger.info('[Google Tasks] Processing callback', { userId });

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    logger.debug('[Google Tasks] Tokens received', {
      userId,
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token
    });

    // Update user with Google Tasks credentials
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('[Google Tasks] User not found in callback', { userId });
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
        logger.info('[Google Tasks] Found existing task list', { userId, taskListId });
      } else {
        // Create new task list
        const newList = await tasksApi.tasklists.insert({
          resource: { title: 'Perun CRM' }
        });
        taskListId = newList.data.id;
        logger.info('[Google Tasks] Created new task list', { userId, taskListId });
      }
    } catch (e) {
      logger.error('[Google Tasks] Error with task list', { error: e.message, userId });
      // Use default task list as fallback
      try {
        const defaultList = await tasksApi.tasklists.list();
        taskListId = defaultList.data.items?.[0]?.id || '@default';
        logger.info('[Google Tasks] Using default task list', { userId, taskListId });
      } catch (fallbackError) {
        taskListId = '@default';
        logger.warn('[Google Tasks] Using @default as fallback', { userId });
      }
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
    logger.info('[Google Tasks] User connected successfully', { userId, username: user.username });

    res.redirect(`${baseUrl}/tasks?google_tasks=connected`);
  } catch (error) {
    logger.error('[Google Tasks] Callback error', { error: error.message, stack: error.stack });
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
    let totalTasksWithDueDate = 0;
    let syncedCount = 0;

    if (user.googleTasks?.enabled) {
      // Only fetch tasks with due dates for efficiency
      const globalTasks = await Task.find(
        { dueDate: { $exists: true, $ne: null }, completed: { $ne: true } },
        { _id: 1, subtasks: 1 }
      ).lean();
      const contacts = await Contact.find(
        { 'tasks.dueDate': { $exists: true } },
        { 'tasks.id': 1, 'tasks.dueDate': 1, 'tasks.completed': 1, 'tasks.subtasks': 1 }
      ).lean();

      // Count global tasks with due dates
      for (const task of globalTasks) {
        totalTasksWithDueDate++;
        const taskId = task._id.toString();
        const existingGoogleTaskId = user.googleTasks.syncedTaskIds?.get(taskId);
        if (existingGoogleTaskId && typeof existingGoogleTaskId === 'string' && existingGoogleTaskId.length > 0) {
          syncedCount++;
        }
        // Count subtasks
        if (task.subtasks) {
          const subtaskCounts = countSubtasksPendingSync(task.subtasks, user);
          totalTasksWithDueDate += subtaskCounts.total;
          syncedCount += subtaskCounts.synced;
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
              const subtaskCounts = countSubtasksPendingSync(task.subtasks, user);
              totalTasksWithDueDate += subtaskCounts.total;
              syncedCount += subtaskCounts.synced;
            }
          }
        }
      }
    }

    const pendingCount = totalTasksWithDueDate - syncedCount;

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
    logger.error('[Google Tasks] Error getting status', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri získavaní stavu' });
  }
});

// Helper function to count subtasks pending sync (returns object instead of callback)
function countSubtasksPendingSync(subtasks, user) {
  let total = 0;
  let synced = 0;
  if (!subtasks || !Array.isArray(subtasks)) return { total, synced };

  for (const subtask of subtasks) {
    if (subtask.dueDate && !subtask.completed) {
      total++;
      const existingGoogleTaskId = user.googleTasks.syncedTaskIds?.get(subtask.id);
      if (existingGoogleTaskId && typeof existingGoogleTaskId === 'string' && existingGoogleTaskId.length > 0) {
        synced++;
      }
    }
    if (subtask.subtasks && subtask.subtasks.length > 0) {
      const childCounts = countSubtasksPendingSync(subtask.subtasks, user);
      total += childCounts.total;
      synced += childCounts.synced;
    }
  }
  return { total, synced };
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

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    if (user.googleTasks?.accessToken) {
      try {
        await oauth2Client.revokeToken(user.googleTasks.accessToken);
        logger.info('[Google Tasks] Token revoked', { userId: req.user.id });
      } catch (e) {
        // Token revocation can fail if token is already invalid - that's OK
        logger.warn('[Google Tasks] Token revocation failed', { error: e.message, userId: req.user.id });
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
    logger.info('[Google Tasks] Disconnected', { userId: req.user.id, username: user.username });

    res.json({ success: true, message: 'Google Tasks bol odpojený' });
  } catch (error) {
    logger.error('[Google Tasks] Disconnect error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri odpájaní' });
  }
});

// Sync all tasks to Google Tasks (with incremental sync and quota checking)
router.post('/sync', authenticateToken, async (req, res) => {
  const forceSync = req.body.force === true;
  logger.info('[Google Tasks] Sync started', { userId: req.user.id, forceSync });

  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    // If force sync, reset all tracking maps
    if (forceSync) {
      logger.info('[Google Tasks] Force sync - resetting tracking maps', { userId: req.user.id });
      user.googleTasks.syncedTaskIds = new Map();
      user.googleTasks.syncedTaskHashes = new Map();
    }

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    // Check quota before starting
    checkAndResetQuota(user);
    const remainingQuota = getRemainingQuota(user);
    logger.debug('[Google Tasks] Quota check', { userId: req.user.id, remainingQuota });

    if (remainingQuota < 10) {
      logger.warn('[Google Tasks] Quota exceeded', { userId: req.user.id, remainingQuota });
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

    // Verify task list ID exists
    if (!user.googleTasks.taskListId) {
      logger.error('[Google Tasks] No task list configured', { userId: req.user.id });
      return res.status(400).json({ message: 'Google Tasks task list nie je nakonfigurovaný. Skúste sa odpojiť a znova pripojiť.' });
    }

    const tasksApi = await getTasksClient(user);

    // Verify task list exists - if not, recreate it
    try {
      await tasksApi.tasklists.get({ tasklist: user.googleTasks.taskListId });
    } catch (listError) {
      logger.warn('[Google Tasks] Task list not found, recreating', { userId: req.user.id, error: listError.message });
      // Task list doesn't exist, create a new one
      try {
        const newList = await tasksApi.tasklists.insert({
          resource: { title: 'Perun CRM' }
        });
        user.googleTasks.taskListId = newList.data.id;
        user.googleTasks.syncedTaskIds = new Map(); // Reset synced tasks
        user.googleTasks.syncedTaskHashes = new Map();
        await user.save();
        logger.info('[Google Tasks] Created new task list', { userId: req.user.id, taskListId: newList.data.id });
      } catch (createError) {
        logger.error('[Google Tasks] Failed to create task list', { userId: req.user.id, error: createError.message });
        return res.status(500).json({ message: 'Nepodarilo sa vytvoriť task list v Google Tasks' });
      }
    }

    // Get all tasks with due dates - optimize query to only fetch needed fields
    const globalTasks = await Task.find(
      {},
      { _id: 1, title: 1, description: 1, dueDate: 1, completed: 1, modifiedAt: 1, updatedAt: 1, subtasks: 1 }
    ).lean();
    const contacts = await Contact.find(
      {},
      { name: 1, tasks: 1 }
    ).lean();
    logger.debug('[Google Tasks] Fetched tasks', { userId: req.user.id, globalTasks: globalTasks.length, contacts: contacts.length });

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
    let rateLimitHit = false;
    let rateLimitCount = 0;

    // Initialize hash map if not exists
    if (!user.googleTasks.syncedTaskHashes) {
      user.googleTasks.syncedTaskHashes = new Map();
    }
    if (!user.googleTasks.syncedTaskIds) {
      user.googleTasks.syncedTaskIds = new Map();
    }

    // Filter tasks: new tasks to create, changed tasks to update
    const tasksToCreate = [];
    const tasksToUpdate = [];

    for (const task of tasksToSync) {
      // Skip tasks without valid ID
      if (!task.id) {
        skipped++;
        continue;
      }

      // Skip tasks with invalid due date
      if (!task.dueDate || isNaN(new Date(task.dueDate).getTime())) {
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

    logger.debug('[Google Tasks] Sync analysis', {
      userId: req.user.id,
      toCreate: tasksToCreate.length,
      toUpdate: tasksToUpdate.length,
      unchanged
    });

    // If nothing to do, return early
    if (tasksToCreate.length === 0 && tasksToUpdate.length === 0) {
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

    if (totalTasksToProcess > remainingQuota) {
      logger.warn('[Google Tasks] Quota may be insufficient', {
        userId: req.user.id,
        needed: totalTasksToProcess,
        remaining: remainingQuota
      });
    }

    // Process tasks in batches - Google Tasks API has per-user per-minute limits
    // Even though daily quota is 50k, there's a per-minute limit (~100-200 requests/minute)
    // Use small batches with longer delays to stay under the limit
    const BATCH_SIZE = 5;  // Small batch size
    let currentBackoff = 3000;  // 3 second delay between batches
    const MAX_BACKOFF = 120000; // Max 2 minutes

    // Combine tasks to create and update, prioritizing updates (they're more important)
    const allTasksToProcess = [...tasksToUpdate, ...tasksToCreate];

    const batches = [];
    for (let i = 0; i < allTasksToProcess.length; i += BATCH_SIZE) {
      batches.push(allTasksToProcess.slice(i, i + BATCH_SIZE));
    }

    logger.debug('[Google Tasks] Processing batches', { userId: req.user.id, batches: batches.length, batchSize: BATCH_SIZE });

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      // Stop if quota exceeded
      if (quotaExceeded) {
        for (let i = batchIndex; i < batches.length; i++) {
          skipped += batches[i].length;
        }
        break;
      }

      // Check remaining quota before each batch
      if (getRemainingQuota(user) < BATCH_SIZE) {
        logger.warn('[Google Tasks] Quota running low, stopping', { userId: req.user.id });
        quotaExceeded = true;
        for (let i = batchIndex; i < batches.length; i++) {
          skipped += batches[i].length;
        }
        break;
      }

      const batch = batches[batchIndex];
      rateLimitHit = false; // Reset for each batch

      // Process batch
      const batchPromises = batch.map(async (task) => {
        const isUpdate = !!task.googleTaskId;

        try {
          const taskData = createGoogleTaskData(task);

          if (isUpdate) {
            // Update existing task
            await tasksApi.tasks.update({
              tasklist: user.googleTasks.taskListId,
              task: task.googleTaskId,
              resource: taskData
            });
            return { success: true, taskId: task.id, googleTaskId: task.googleTaskId, hash: task.hash, action: 'updated' };
          } else {
            // Create new task
            const newTask = await tasksApi.tasks.insert({
              tasklist: user.googleTasks.taskListId,
              resource: taskData
            });
            return { success: true, taskId: task.id, googleTaskId: newTask.data.id, hash: task.hash, action: 'created' };
          }
        } catch (error) {
          // Log full error details for debugging
          logger.error('[Google Tasks] API error', {
            userId: req.user.id,
            taskId: task.id,
            code: error.code,
            status: error.response?.status,
            message: error.message,
            errors: error.errors
          });

          // Rate limit error (429) - mark for retry with backoff
          if (error.code === 429 || error.response?.status === 429) {
            return { success: false, taskId: task.id, error: 'rate_limit', message: error.message };
          }

          // 403 errors - check specific reason
          if (error.code === 403) {
            const msg = (error.message || '').toLowerCase();
            // "Quota Exceeded" from Google is usually per-minute rate limit, not daily quota
            // Treat it as rate_limit so we slow down but continue
            if (msg.includes('quota') || msg.includes('limit exceeded') || msg.includes('rate limit') || msg.includes('usage limit') || msg.includes('too many')) {
              return { success: false, taskId: task.id, error: 'rate_limit', message: error.message };
            }
            // Only treat as hard quota stop if it explicitly says "daily"
            if (msg.includes('daily limit') || msg.includes('daily quota')) {
              return { success: false, taskId: task.id, error: 'quota', message: error.message };
            }
            // Other 403 - permission or unknown, continue with other tasks
            return { success: false, taskId: task.id, error: 'permission', message: error.message };
          }

          // Handle 404 or 400 "Missing task ID" for updates - task was deleted from Google, recreate it
          if (isUpdate && (error.code === 404 || (error.code === 400 && error.message?.includes('Missing task ID')))) {
            try {
              const newTask = await tasksApi.tasks.insert({
                tasklist: user.googleTasks.taskListId,
                resource: createGoogleTaskData(task)
              });
              logger.debug('[Google Tasks] Recreated deleted task', { userId: req.user.id, taskId: task.id });
              return { success: true, taskId: task.id, googleTaskId: newTask.data.id, hash: task.hash, action: 'recreated' };
            } catch (insertError) {
              if (insertError.code === 429 || insertError.response?.status === 429) {
                return { success: false, taskId: task.id, error: 'rate_limit', message: insertError.message };
              }
              if (insertError.code === 403) {
                return { success: false, taskId: task.id, error: 'permission', message: insertError.message };
              }
              return { success: false, taskId: task.id, error: 'other', message: insertError.message };
            }
          }

          // Other errors
          logger.error('[Google Tasks] Sync task error', { userId: req.user.id, taskId: task.id, error: error.message });
          return { success: false, taskId: task.id, error: 'other', message: error.message };
        }
      });

      const results = await Promise.all(batchPromises);

      // Process results and track quota
      let batchApiCalls = 0;
      let quotaErrorsInBatch = 0;
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
        } else if (result.error === 'rate_limit') {
          // Rate limit - increase backoff significantly and continue
          rateLimitHit = true;
          rateLimitCount++;
          skipped++;
          logger.info('[Google Tasks] Rate limit hit, will increase backoff', { taskId: result.taskId, totalRateLimits: rateLimitCount });
        } else if (result.error === 'quota') {
          // Quota exceeded - stop immediately, don't retry
          quotaErrorsInBatch++;
          quotaExceeded = true;
          skipped++;
          logger.warn('[Google Tasks] Quota exceeded, stopping sync', { taskId: result.taskId });
        } else if (result.error === 'permission') {
          // Permission error - log but continue with other tasks
          errors++;
          logger.warn('[Google Tasks] Permission error, skipping task', { taskId: result.taskId, message: result.message });
        } else {
          errors++;
        }
      }

      // If quota errors, stop completely
      if (quotaErrorsInBatch > 0) {
        // Count remaining tasks as skipped
        for (let i = batchIndex + 1; i < batches.length; i++) {
          skipped += batches[i].length;
        }
        break; // Exit batch processing loop
      }

      // If rate limit hit, increase backoff significantly and wait longer
      if (rateLimitHit) {
        currentBackoff = Math.min(currentBackoff * 3, MAX_BACKOFF);
        logger.info('[Google Tasks] Increased backoff due to rate limit', { backoff: currentBackoff, rateLimitCount });

        // If too many rate limits, stop to avoid being blocked
        if (rateLimitCount >= 20) {
          logger.warn('[Google Tasks] Too many rate limits, stopping sync', { rateLimitCount });
          for (let i = batchIndex + 1; i < batches.length; i++) {
            skipped += batches[i].length;
          }
          break;
        }

        // Wait longer after rate limit
        await delay(currentBackoff);
      }

      // Track quota usage
      incrementQuota(user, batchApiCalls);

      // Add delay between batches - important to avoid rate limits
      if (batchIndex < batches.length - 1 && !quotaExceeded) {
        // If any errors, increase backoff significantly
        if (results.some(r => !r.success)) {
          currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF);
        }
        await delay(currentBackoff);
      }
    }

    // Update last sync time
    user.googleTasks.lastSyncAt = new Date();
    await user.save();

    logger.info('[Google Tasks] Sync completed', {
      userId: req.user.id,
      synced,
      updated,
      unchanged,
      skipped,
      errors,
      quotaExceeded
    });

    let message = `Synchronizované: ${synced} nových, ${updated} aktualizovaných, ${unchanged} nezmenených`;
    if (skipped > 0) message += `, ${skipped} preskočených`;
    if (errors > 0) message += `, ${errors} chýb`;
    if (quotaExceeded) {
      message += ' (denný limit Google API dosiahnutý - skúste zajtra)';
    } else if (rateLimitCount > 0) {
      message += ` (spomalené kvôli Google API limitu - zvyšok sa dosyncuje pri ďalšej sync)`;
    }

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
    logger.error('[Google Tasks] Sync error', { error: error.message, stack: error.stack, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri synchronizácii: ' + error.message });
  }
});

// Reset sync state - clears all tracking maps to force full re-sync
router.post('/reset-sync', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    user.googleTasks.syncedTaskIds = new Map();
    user.googleTasks.syncedTaskHashes = new Map();
    user.googleTasks.quotaUsedToday = 0;
    await user.save();

    logger.info('[Google Tasks] Sync state reset', { userId: req.user.id, username: user.username });

    res.json({
      success: true,
      message: 'Synchronizačný stav bol resetovaný. Teraz môžete spustiť novú synchronizáciu.'
    });
  } catch (error) {
    logger.error('[Google Tasks] Reset sync error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri resetovaní: ' + error.message });
  }
});

// Clean up completed tasks from Google Tasks
router.post('/cleanup', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    const tasksApi = await getTasksClient(user);

    // Get all current task IDs - only fetch necessary fields
    const globalTasks = await Task.find({}, { _id: 1 }).lean();
    const contacts = await Contact.find({}, { 'tasks.id': 1 }).lean();

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
            // 404 is OK - task already deleted
            if (e.code !== 404) {
              logger.warn('[Google Tasks] Failed to delete task', { taskId, googleTaskId, error: e.message });
              errors++;
            }
          }
          user.googleTasks.syncedTaskIds.delete(taskId);
        }
      }
    }

    await user.save();

    logger.info('[Google Tasks] Cleanup completed', { userId: req.user.id, deleted, errors });

    res.json({
      success: true,
      message: `Vyčistené: ${deleted} úloh odstránených, ${errors} chýb`,
      deleted,
      errors
    });
  } catch (error) {
    logger.error('[Google Tasks] Cleanup error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri čistení: ' + error.message });
  }
});

// Delete tasks from Google Tasks by search term
router.post('/delete-by-search', authenticateToken, async (req, res) => {
  try {
    const { searchTerm } = req.body;

    if (!searchTerm || searchTerm.length < 2) {
      return res.status(400).json({ message: 'Vyhľadávací výraz musí mať aspoň 2 znaky' });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    const tasksApi = await getTasksClient(user);
    const taskListId = user.googleTasks.taskListId;

    // Fetch all tasks from Google Tasks
    let allTasks = [];
    let pageToken = null;

    do {
      const response = await tasksApi.tasks.list({
        tasklist: taskListId,
        maxResults: 100,
        showCompleted: true,
        showHidden: true,
        pageToken
      });

      if (response.data.items) {
        allTasks = allTasks.concat(response.data.items);
      }
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    // Filter tasks matching the search term (case insensitive)
    const searchRegex = new RegExp(searchTerm, 'i');
    const tasksToDelete = allTasks.filter(t => t.title && searchRegex.test(t.title));

    logger.info('[Google Tasks] Delete by search', {
      userId: req.user.id,
      searchTerm,
      totalTasks: allTasks.length,
      matchingTasks: tasksToDelete.length
    });

    let deleted = 0;
    let errors = 0;

    for (const task of tasksToDelete) {
      try {
        await tasksApi.tasks.delete({
          tasklist: taskListId,
          task: task.id
        });
        deleted++;

        // Also remove from syncedTaskIds if present
        if (user.googleTasks.syncedTaskIds) {
          for (const [localId, googleId] of user.googleTasks.syncedTaskIds.entries()) {
            if (googleId === task.id) {
              user.googleTasks.syncedTaskIds.delete(localId);
              break;
            }
          }
        }
      } catch (e) {
        if (e.code !== 404) {
          logger.warn('[Google Tasks] Failed to delete task by search', {
            taskId: task.id,
            title: task.title,
            error: e.message
          });
          errors++;
        }
      }

      // Small delay to avoid rate limiting
      if (deleted % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    await user.save();

    logger.info('[Google Tasks] Delete by search completed', {
      userId: req.user.id,
      searchTerm,
      deleted,
      errors
    });

    res.json({
      success: true,
      message: `Vymazané: ${deleted} úloh s "${searchTerm}", ${errors} chýb`,
      found: tasksToDelete.length,
      deleted,
      errors
    });
  } catch (error) {
    logger.error('[Google Tasks] Delete by search error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri mazaní: ' + error.message });
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

// In-memory lock to prevent duplicate syncs for the same task
const syncLocks = new Map();
const LOCK_TIMEOUT = 30000; // 30 seconds

const acquireLock = (key) => {
  const now = Date.now();
  const existingLock = syncLocks.get(key);

  // Clean up expired lock
  if (existingLock && now - existingLock > LOCK_TIMEOUT) {
    syncLocks.delete(key);
  }

  if (syncLocks.has(key)) {
    return false; // Lock exists
  }

  syncLocks.set(key, now);
  return true;
};

const releaseLock = (key) => {
  syncLocks.delete(key);
};

/**
 * Automatically sync a task to Google Tasks for all users who have Google Tasks connected
 * Uses exponential backoff for rate limiting and locks to prevent duplicates
 */
const autoSyncTaskToGoogleTasks = async (taskData, action) => {
  try {
    // Skip if task has no due date (for create/update)
    if (action !== 'delete' && !taskData.dueDate) {
      return;
    }

    let taskId = taskData.id || taskData._id;
    if (taskId && typeof taskId === 'object' && taskId.toString) {
      taskId = taskId.toString();
    }

    // Validate taskId
    if (!taskId) {
      logger.warn('[Auto-sync Tasks] Missing task ID', { title: taskData.title });
      return;
    }

    // Acquire lock to prevent duplicate syncs
    const lockKey = `sync-${taskId}-${action}`;
    if (!acquireLock(lockKey)) {
      logger.debug('[Auto-sync Tasks] Skipping - sync already in progress', { taskId, action });
      return;
    }

    logger.debug('[Auto-sync Tasks] Starting sync', { taskId, action, title: taskData.title });

    try {
    // Find all users with Google Tasks enabled
    const users = await User.find({ 'googleTasks.enabled': true });

    if (users.length === 0) {
      return;
    }

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
            logger.debug('[Auto-sync Tasks] Rate limited, retrying', { attempt: attempt + 1, maxRetries, waitTime });
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
              logger.debug('[Auto-sync Tasks] Deleted task', { userId: user._id, taskId });
            } catch (e) {
              // 404 is OK - task was already deleted
              if (e.code !== 404) {
                logger.warn('[Auto-sync Tasks] Delete failed', { userId: user._id, taskId, error: e.message });
              }
            }
            // Use atomic update to remove from syncedTaskIds
            await User.updateOne(
              { _id: user._id },
              { $unset: { [`googleTasks.syncedTaskIds.${taskId}`]: 1 } }
            );
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

          // Re-fetch user to get latest syncedTaskIds (prevents race condition)
          const freshUser = await User.findById(user._id);
          const existingTaskId = freshUser?.googleTasks?.syncedTaskIds?.get(taskId);

          logger.debug('[Auto-sync Tasks] Checking existing', {
            userId: user._id,
            taskId,
            existingTaskId: existingTaskId || 'none'
          });

          if (existingTaskId) {
            try {
              await retryWithBackoff(() => tasksApi.tasks.update({
                tasklist: user.googleTasks.taskListId,
                task: existingTaskId,
                resource: googleTaskData
              }));
              logger.debug('[Auto-sync Tasks] Updated existing task', { userId: user._id, taskId, googleTaskId: existingTaskId });
            } catch (e) {
              if (e.code === 404) {
                // Task was deleted from Google, create new one
                const newTask = await retryWithBackoff(() => tasksApi.tasks.insert({
                  tasklist: user.googleTasks.taskListId,
                  resource: googleTaskData
                }));
                // Use atomic update to prevent race conditions
                await User.updateOne(
                  { _id: user._id },
                  { $set: { [`googleTasks.syncedTaskIds.${taskId}`]: newTask.data.id } }
                );
                logger.debug('[Auto-sync Tasks] Recreated deleted task', { userId: user._id, taskId, newGoogleTaskId: newTask.data.id });
              } else {
                throw e;
              }
            }
          } else {
            const newTask = await retryWithBackoff(() => tasksApi.tasks.insert({
              tasklist: user.googleTasks.taskListId,
              resource: googleTaskData
            }));
            // Use atomic update to prevent race conditions
            await User.updateOne(
              { _id: user._id },
              { $set: { [`googleTasks.syncedTaskIds.${taskId}`]: newTask.data.id } }
            );
            logger.debug('[Auto-sync Tasks] Created new task', { userId: user._id, taskId, newGoogleTaskId: newTask.data.id });
          }
        }
      } catch (error) {
        logger.error('[Auto-sync Tasks] Error for user', { userId: user._id, error: error.message });
      }
    }
    } finally {
      releaseLock(lockKey);
    }
  } catch (error) {
    logger.error('[Auto-sync Tasks] Error', { error: error.message });
  }
};

const autoDeleteTaskFromGoogleTasks = async (taskId) => {
  await autoSyncTaskToGoogleTasks({ id: taskId }, 'delete');
};

module.exports = router;
module.exports.autoSyncTaskToGoogleTasks = autoSyncTaskToGoogleTasks;
module.exports.autoDeleteTaskFromGoogleTasks = autoDeleteTaskFromGoogleTasks;
