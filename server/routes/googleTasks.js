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
const getTasksClient = async (user, forceRefresh = false) => {
  if (!oauth2Client) {
    throw new Error('Google Tasks OAuth not configured');
  }

  if (!user.googleTasks?.accessToken) {
    throw new Error('Google Tasks not connected');
  }

  // Check if we have a refresh token - this is critical for long-term access
  if (!user.googleTasks.refreshToken) {
    logger.warn('[Google Tasks] No refresh token stored - user needs to reconnect', { userId: user._id });
    throw new Error('Google Tasks token expired. Please reconnect your account.');
  }

  oauth2Client.setCredentials({
    access_token: user.googleTasks.accessToken,
    refresh_token: user.googleTasks.refreshToken,
    expiry_date: user.googleTasks.tokenExpiry?.getTime()
  });

  // Check if token needs refresh (with 10 min buffer for safety)
  const now = new Date();
  const tokenExpiry = user.googleTasks.tokenExpiry;
  const expiryBuffer = 10 * 60 * 1000; // 10 minutes buffer
  const needsRefresh = forceRefresh || !tokenExpiry || now.getTime() >= tokenExpiry.getTime() - expiryBuffer;

  if (needsRefresh) {
    logger.debug('[Google Tasks] Token refresh needed', {
      userId: user._id,
      forceRefresh,
      tokenExpiry: tokenExpiry?.toISOString(),
      now: now.toISOString()
    });

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      user.googleTasks.accessToken = credentials.access_token;
      user.googleTasks.tokenExpiry = new Date(credentials.expiry_date);
      // Google sometimes returns a new refresh token - always save it
      if (credentials.refresh_token) {
        user.googleTasks.refreshToken = credentials.refresh_token;
        logger.info('[Google Tasks] New refresh token received', { userId: user._id });
      }
      await user.save();
      oauth2Client.setCredentials(credentials);
      logger.info('[Google Tasks] Token refreshed successfully', { userId: user._id });
    } catch (refreshError) {
      logger.error('[Google Tasks] Token refresh failed', {
        userId: user._id,
        error: refreshError.message,
        code: refreshError.code
      });

      // Check for various invalid grant scenarios
      const errorMessage = refreshError.message?.toLowerCase() || '';
      const isInvalidGrant = errorMessage.includes('invalid_grant') ||
                            errorMessage.includes('token has been expired or revoked') ||
                            errorMessage.includes('token has been revoked') ||
                            refreshError.code === 400;

      if (isInvalidGrant) {
        // Clear invalid credentials
        user.googleTasks.accessToken = null;
        user.googleTasks.refreshToken = null;
        user.googleTasks.tokenExpiry = null;
        user.googleTasks.connected = false;
        await user.save();

        logger.warn('[Google Tasks] Credentials cleared due to invalid grant', { userId: user._id });
        throw new Error('Google Tasks token expired. Please reconnect your account.');
      }

      // For other errors, try to continue with existing token
      logger.warn('[Google Tasks] Continuing with existing token after refresh failure', { userId: user._id });
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

    // IMPORTANT: Google only sends refresh_token on first authorization
    // or if we use prompt: 'consent'. Make sure we save it!
    if (!tokens.refresh_token) {
      logger.warn('[Google Tasks] No refresh token received! User may need to reconnect later.', { userId });
    }

    // IMPORTANT: Clear old sync data when reconnecting to avoid stale references
    // Old syncedTaskIds point to tasks in potentially different task list
    user.googleTasks = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.googleTasks?.refreshToken, // Keep old if not provided
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      taskListId: taskListId,
      enabled: true,
      connected: true,
      connectedAt: new Date(),
      syncedTaskIds: new Map(), // Always start fresh on reconnect
      syncedTaskHashes: new Map() // Always start fresh on reconnect
    };

    await user.save();
    logger.info('[Google Tasks] User connected successfully', {
      userId,
      username: user.username,
      hasRefreshToken: !!user.googleTasks.refreshToken,
      tokenExpiry: user.googleTasks.tokenExpiry
    });

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
// Maximum sync time: 10 minutes to allow large syncs to complete
const SYNC_TIMEOUT = 600000;

router.post('/sync', authenticateToken, async (req, res) => {
  const forceSync = req.body.force === true;
  const syncStartTime = Date.now();
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
    logger.info('[Google Tasks] Fetched tasks from DB', {
      userId: req.user.id,
      globalTasks: globalTasks.length,
      contacts: contacts.length,
      existingSyncedIds: user.googleTasks.syncedTaskIds?.size || 0,
      existingSyncedHashes: user.googleTasks.syncedTaskHashes?.size || 0
    });

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

    logger.info('[Google Tasks] Sync analysis', {
      userId: req.user.id,
      totalTasksToSync: tasksToSync.length,
      toCreate: tasksToCreate.length,
      toUpdate: tasksToUpdate.length,
      unchanged,
      skipped,
      syncedTaskIdsSize: user.googleTasks.syncedTaskIds?.size || 0,
      syncedTaskHashesSize: user.googleTasks.syncedTaskHashes?.size || 0
    });

    // If nothing to do, return early
    if (tasksToCreate.length === 0 && tasksToUpdate.length === 0) {
      user.googleTasks.lastSyncAt = new Date();
      await user.save();

      let msg = '';
      if (unchanged > 0 && skipped === 0) {
        msg = `Všetky úlohy sú aktuálne (${unchanged} synchronizovaných)`;
      } else if (unchanged === 0 && skipped === 0) {
        msg = 'Žiadne úlohy na synchronizáciu (žiadne úlohy s termínom)';
      } else {
        msg = `Žiadne zmeny (${unchanged} aktuálnych, ${skipped} preskočených)`;
      }

      return res.json({
        success: true,
        message: msg,
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

    // Process tasks with adaptive concurrency and retry on rate limit
    const CONCURRENCY = 15; // Balance between speed and rate limits
    const MAX_RETRIES = 3;
    const SAVE_INTERVAL = 50; // Save progress every 50 completed tasks
    let taskIndex = 0;
    let completedSinceLastSave = 0;

    // Combine tasks - updates first (more important)
    const allTasksToProcess = [...tasksToUpdate, ...tasksToCreate];

    logger.info('[Google Tasks] Processing tasks', { userId: req.user.id, total: allTasksToProcess.length, concurrency: CONCURRENCY });

    // Sleep helper
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Process a single task with retry on rate limit
    const processTask = async (task) => {
      const isUpdate = !!task.googleTaskId;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const taskData = createGoogleTaskData(task);

          if (isUpdate) {
            try {
              await tasksApi.tasks.update({
                tasklist: user.googleTasks.taskListId,
                task: task.googleTaskId,
                resource: taskData
              });
              return { success: true, taskId: task.id, googleTaskId: task.googleTaskId, hash: task.hash, action: 'updated' };
            } catch (updateError) {
              const uCode = updateError.code || updateError.response?.status;
              // Rate limit on update - throw to trigger retry
              if (uCode === 429 || uCode === 403) throw updateError;
              // If task doesn't exist in Google anymore, create it
              if (uCode === 404 || uCode === 400) {
                const newTask = await tasksApi.tasks.insert({
                  tasklist: user.googleTasks.taskListId,
                  resource: taskData
                });
                return { success: true, taskId: task.id, googleTaskId: newTask.data.id, hash: task.hash, action: 'recreated' };
              }
              throw updateError;
            }
          } else {
            const newTask = await tasksApi.tasks.insert({
              tasklist: user.googleTasks.taskListId,
              resource: taskData
            });
            return { success: true, taskId: task.id, googleTaskId: newTask.data.id, hash: task.hash, action: 'created' };
          }
        } catch (error) {
          const code = error.code || error.response?.status;
          if ((code === 429 || code === 403) && attempt < MAX_RETRIES) {
            // Exponential backoff: 1s, 2s, 4s
            const delay = Math.pow(2, attempt) * 1000;
            await sleep(delay);
            continue;
          }
          if (code === 429 || code === 403) {
            return { success: false, taskId: task.id, error: 'rate_limit', message: error.message };
          }
          logger.error('[Google Tasks] Task error', { taskId: task.id, code, message: error.message });
          return { success: false, taskId: task.id, error: 'other', message: error.message };
        }
      }
    };

    // Run with concurrency pool - process results immediately as they complete
    const executing = new Set();
    let successCount = 0;

    // Process a single result immediately
    const handleResult = (result) => {
      if (!result) return;
      if (result.success) {
        user.googleTasks.syncedTaskIds.set(result.taskId, result.googleTaskId);
        user.googleTasks.syncedTaskHashes.set(result.taskId, result.hash);
        successCount++;
        completedSinceLastSave++;
        if (result.action === 'created' || result.action === 'recreated') {
          synced++;
        } else {
          updated++;
        }
      } else if (result.error === 'rate_limit') {
        rateLimitCount++;
        skipped++;
      } else {
        errors++;
      }
    };

    // Periodic save to prevent data loss on timeout
    const saveProgressIfNeeded = async () => {
      if (completedSinceLastSave >= SAVE_INTERVAL) {
        try {
          await user.save();
          logger.info('[Google Tasks] Progress saved', { synced, updated, successCount });
          completedSinceLastSave = 0;
        } catch (saveErr) {
          logger.error('[Google Tasks] Progress save failed', { error: saveErr.message });
        }
      }
    };

    for (const task of allTasksToProcess) {
      // Check timeout
      if (Date.now() - syncStartTime > SYNC_TIMEOUT) {
        skipped += allTasksToProcess.length - taskIndex;
        logger.warn('[Google Tasks] Timeout reached', { processed: taskIndex, total: allTasksToProcess.length });
        break;
      }

      const promise = processTask(task).then(result => {
        executing.delete(promise);
        handleResult(result);
        return result;
      });
      executing.add(promise);
      taskIndex++;

      // When pool is full, wait for one to finish and save if needed
      if (executing.size >= CONCURRENCY) {
        await Promise.race(executing);
        await saveProgressIfNeeded();
      }
    }

    // Wait for remaining tasks
    const remaining = await Promise.all(executing);

    incrementQuota(user, successCount);

    // Update last sync time
    user.googleTasks.lastSyncAt = new Date();
    await user.save();

    const syncDuration = Date.now() - syncStartTime;
    const timedOut = syncDuration >= SYNC_TIMEOUT;

    logger.info('[Google Tasks] Sync completed', {
      userId: req.user.id,
      synced,
      updated,
      unchanged,
      skipped,
      errors,
      quotaExceeded,
      duration: syncDuration,
      timedOut
    });

    let message = `Synchronizované: ${synced} nových, ${updated} aktualizovaných, ${unchanged} nezmenených`;
    if (skipped > 0) message += `, ${skipped} preskočených`;
    if (errors > 0) message += `, ${errors} chýb`;
    if (timedOut) {
      message += ' (časový limit - spustite sync znova pre zvyšok)';
    } else if (quotaExceeded) {
      message += ' (denný limit Google API dosiahnutý - skúste zajtra)';
    } else if (rateLimitCount > 0) {
      message += ' (spomalené kvôli Google API limitu)';
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

// Background dedup job tracking
const dedupJobs = new Map(); // userId -> { status, deleted, errors, total, duplicateGroups }

// Remove duplicate tasks from Google Tasks (keep one, delete copies)
// Everything runs in background - response is sent immediately
router.post('/remove-duplicates', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id.toString(); // Convert ObjectId to string for Map key

    // Check if already running
    const existingJob = dedupJobs.get(userId);
    if (existingJob && existingJob.status === 'running') {
      return res.json({
        success: true,
        message: `Odstraňovanie duplikátov prebieha... (${existingJob.deleted}/${existingJob.total} vymazaných)`,
        status: 'running',
        ...existingJob
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    // Initialize job immediately - before any Google API calls
    const job = { status: 'running', deleted: 0, errors: 0, total: 0, duplicateGroups: 0, phase: 'scanning' };
    dedupJobs.set(userId, job);

    logger.info('[Google Tasks] Dedup job started, sending immediate response', { userId });

    // Send response IMMEDIATELY - everything else runs in background
    res.json({
      success: true,
      message: 'Spúšťam hľadanie duplikátov na pozadí...',
      status: 'running',
      version: 'v3-background'
    });

    // ENTIRE process runs in background
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    (async () => {
      try {
        const tasksApi = await getTasksClient(user);
        const taskListId = user.googleTasks.taskListId;

        // Fetch ALL tasks from Google Tasks
        let allGoogleTasks = [];
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
            allGoogleTasks.push(...response.data.items);
          }
          pageToken = response.data.nextPageToken;
        } while (pageToken);

        logger.info('[Google Tasks] Remove duplicates - fetched tasks', {
          userId, total: allGoogleTasks.length
        });

        // Group by title
        const titleMap = new Map();
        for (const gTask of allGoogleTasks) {
          const title = (gTask.title || '').trim();
          if (!title) continue;
          if (!titleMap.has(title)) titleMap.set(title, []);
          titleMap.get(title).push(gTask);
        }

        // Find tracked IDs
        const trackedGoogleIds = new Set();
        if (user.googleTasks.syncedTaskIds) {
          for (const [, googleId] of user.googleTasks.syncedTaskIds.entries()) {
            trackedGoogleIds.add(googleId);
          }
        }

        const tasksToDelete = [];

        for (const [title, tasks] of titleMap.entries()) {
          if (tasks.length <= 1) continue;
          job.duplicateGroups++;

          let keepTask = null;
          for (const t of tasks) {
            if (trackedGoogleIds.has(t.id)) { keepTask = t; break; }
          }
          if (!keepTask) {
            keepTask = tasks.sort((a, b) =>
              new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime()
            )[0];
          }

          for (const t of tasks) {
            if (t.id !== keepTask.id) tasksToDelete.push(t);
          }
        }

        job.total = tasksToDelete.length;
        job.phase = 'deleting';

        logger.info('[Google Tasks] Duplicates found', {
          userId, duplicateGroups: job.duplicateGroups, toDelete: tasksToDelete.length
        });

        if (tasksToDelete.length === 0) {
          job.status = 'completed';
          job.phase = 'done';
          setTimeout(() => dedupJobs.delete(userId), 300000);
          return;
        }

        // Delete with concurrency pool - conservative to avoid rate limits
        const DEDUP_CONCURRENCY = 5;
        const executing = new Set();
        let globalBackoff = 0; // Shared backoff when rate limited

        const deleteTask = async (task) => {
          for (let attempt = 0; attempt <= 5; attempt++) {
            // Wait for global backoff if another task hit rate limit
            if (globalBackoff > Date.now()) {
              await sleep(globalBackoff - Date.now());
            }
            try {
              await tasksApi.tasks.delete({ tasklist: taskListId, task: task.id });
              job.deleted++;
              return;
            } catch (e) {
              if (e.code === 404 || e.response?.status === 404) {
                job.deleted++;
                return;
              }
              const code = e.code || e.response?.status;
              const msg = e.message || '';
              const isRateLimit = code === 429 || code === 403 || msg.includes('Quota') || msg.includes('quota') || msg.includes('Rate');
              if (isRateLimit && attempt < 5) {
                // Exponential backoff: 2s, 4s, 8s, 16s, 32s
                const delay = Math.pow(2, attempt + 1) * 1000;
                globalBackoff = Date.now() + delay; // Tell other tasks to wait too
                logger.info('[Google Tasks] Rate limit on delete, backing off', {
                  attempt, delay, deleted: job.deleted, errors: job.errors
                });
                await sleep(delay);
                continue;
              }
              job.errors++;
              return;
            }
          }
        };

        for (let i = 0; i < tasksToDelete.length; i++) {
          const task = tasksToDelete[i];
          const promise = deleteTask(task).then(() => executing.delete(promise));
          executing.add(promise);

          if (executing.size >= DEDUP_CONCURRENCY) {
            await Promise.race(executing);
          }

          // Save progress every 200 deletes
          if (job.deleted > 0 && job.deleted % 200 === 0) {
            try {
              const freshUser = await User.findById(userId);
              if (freshUser?.googleTasks?.syncedTaskIds) {
                const deletedSoFar = new Set(tasksToDelete.slice(0, i + 1).map(t => t.id));
                for (const [taskId, googleId] of freshUser.googleTasks.syncedTaskIds.entries()) {
                  if (deletedSoFar.has(googleId)) {
                    freshUser.googleTasks.syncedTaskIds.delete(taskId);
                    if (freshUser.googleTasks.syncedTaskHashes) {
                      freshUser.googleTasks.syncedTaskHashes.delete(taskId);
                    }
                  }
                }
                await freshUser.save();
                logger.info('[Google Tasks] Dedup progress saved', { deleted: job.deleted, total: job.total });
              }
            } catch (saveErr) {
              logger.error('[Google Tasks] Progress save failed during dedup', { error: saveErr.message });
            }
          }
        }

        // Wait for remaining
        await Promise.all(executing);

        // Final cleanup of syncedTaskIds
        try {
          const freshUser = await User.findById(userId);
          if (freshUser?.googleTasks?.syncedTaskIds) {
            const deletedIds = new Set(tasksToDelete.map(t => t.id));
            for (const [taskId, googleId] of freshUser.googleTasks.syncedTaskIds.entries()) {
              if (deletedIds.has(googleId)) {
                freshUser.googleTasks.syncedTaskIds.delete(taskId);
                if (freshUser.googleTasks.syncedTaskHashes) {
                  freshUser.googleTasks.syncedTaskHashes.delete(taskId);
                }
              }
            }
            await freshUser.save();
          }
        } catch (saveErr) {
          logger.error('[Google Tasks] Final save failed during dedup', { error: saveErr.message });
        }

        job.status = 'completed';
        job.phase = 'done';
        logger.info('[Google Tasks] Background dedup completed', {
          userId, deleted: job.deleted, errors: job.errors, duplicateGroups: job.duplicateGroups
        });

        setTimeout(() => dedupJobs.delete(userId), 300000);
      } catch (bgError) {
        job.status = 'error';
        job.errorMessage = bgError.message;
        logger.error('[Google Tasks] Background dedup error', { error: bgError.message, userId });
        setTimeout(() => dedupJobs.delete(userId), 300000);
      }
    })();
  } catch (error) {
    logger.error('[Google Tasks] Remove duplicates error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri odstraňovaní duplikátov: ' + error.message });
  }
});

// Check dedup job status
router.get('/remove-duplicates/status', authenticateToken, (req, res) => {
  const job = dedupJobs.get(req.user.id.toString());
  if (!job) {
    logger.info('[Google Tasks] Dedup status check - no job found', { userId: req.user.id, jobsCount: dedupJobs.size });
    return res.json({ status: 'none', message: 'Žiadna úloha neprebieha', version: 'v3-background' });
  }
  let message;
  if (job.status === 'running') {
    if (job.phase === 'scanning') {
      message = 'Sťahujem úlohy z Google Tasks a hľadám duplikáty...';
    } else {
      message = job.total > 0
        ? `Odstraňujem duplikáty... ${job.deleted}/${job.total}`
        : 'Analyzujem duplikáty...';
    }
  } else if (job.status === 'completed') {
    message = job.total === 0
      ? 'Žiadne duplikáty nenájdené'
      : `Dokončené: ${job.deleted} duplikátov odstránených` + (job.errors > 0 ? `, ${job.errors} chýb` : '');
  } else {
    message = `Chyba: ${job.errorMessage}`;
  }
  res.json({ ...job, message });
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

// Sync completed tasks FROM Google Tasks TO CRM
router.post('/sync-completed', authenticateToken, async (req, res) => {
  logger.info('[Google Tasks] Sync completed tasks started', { userId: req.user.id });

  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    const tasksApi = await getTasksClient(user);
    const taskListId = user.googleTasks.taskListId;

    // Get completed tasks from Google Tasks
    let completedGoogleTasks = [];
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
        // Filter only completed tasks
        const completed = response.data.items.filter(t => t.status === 'completed');
        completedGoogleTasks = completedGoogleTasks.concat(completed);
      }
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    logger.debug('[Google Tasks] Found completed tasks in Google', {
      userId: req.user.id,
      count: completedGoogleTasks.length
    });

    // Build reverse map: googleTaskId -> crmTaskId
    const reverseMap = new Map();
    if (user.googleTasks.syncedTaskIds) {
      for (const [crmId, googleId] of user.googleTasks.syncedTaskIds.entries()) {
        reverseMap.set(googleId, crmId);
      }
    }

    let updated = 0;
    let alreadyCompleted = 0;
    let notFound = 0;
    const io = req.app.get('io');

    for (const googleTask of completedGoogleTasks) {
      const crmTaskId = reverseMap.get(googleTask.id);

      if (!crmTaskId) {
        notFound++;
        continue;
      }

      // Try to find and update the task in CRM
      // First check global tasks
      const globalTask = await Task.findById(crmTaskId);
      if (globalTask) {
        if (globalTask.completed) {
          alreadyCompleted++;
          continue;
        }

        globalTask.completed = true;
        globalTask.modifiedAt = new Date().toISOString();
        await globalTask.save();
        updated++;

        logger.info('[Google Tasks] Marked task as completed from Google', {
          userId: req.user.id,
          taskId: crmTaskId,
          title: globalTask.title
        });

        // Emit socket event
        if (io) {
          io.emit('task-updated', {
            ...globalTask.toObject(),
            id: globalTask._id.toString(),
            source: 'global'
          });
        }
        continue;
      }

      // Check contact tasks
      const contacts = await Contact.find({ 'tasks.id': crmTaskId });
      for (const contact of contacts) {
        const taskIndex = contact.tasks.findIndex(t => t.id === crmTaskId);
        if (taskIndex !== -1) {
          if (contact.tasks[taskIndex].completed) {
            alreadyCompleted++;
            continue;
          }

          contact.tasks[taskIndex].completed = true;
          contact.tasks[taskIndex].modifiedAt = new Date().toISOString();
          contact.markModified('tasks');
          await contact.save();
          updated++;

          logger.info('[Google Tasks] Marked contact task as completed from Google', {
            userId: req.user.id,
            taskId: crmTaskId,
            title: contact.tasks[taskIndex].title,
            contactName: contact.name
          });

          // Emit socket events
          if (io) {
            io.emit('contact-updated', contact.toObject());
            io.emit('task-updated', {
              ...contact.tasks[taskIndex],
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            });
          }
          break;
        }
      }
    }

    logger.info('[Google Tasks] Sync completed tasks finished', {
      userId: req.user.id,
      updated,
      alreadyCompleted,
      notFound
    });

    res.json({
      success: true,
      message: `Synchronizované: ${updated} úloh označených ako dokončené`,
      updated,
      alreadyCompleted,
      notFound
    });
  } catch (error) {
    logger.error('[Google Tasks] Sync completed error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri synchronizácii: ' + error.message });
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
  let notes = task.notes || '';
  if (task.contact) {
    notes += notes ? '\n\n' : '';
    notes += `Kontakt: ${task.contact}`;
  }

  const result = {
    title: task.title,
    notes: notes,
    status: task.completed ? 'completed' : 'needsAction'
  };

  // Only add due date if task has one (Google Tasks API allows tasks without due date)
  if (task.dueDate) {
    const dueDate = new Date(task.dueDate);
    // Set to end of day in UTC
    dueDate.setUTCHours(23, 59, 59, 999);
    result.due = dueDate.toISOString();
  }

  return result;
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
    // Tasks without due date can also be synced to Google Tasks

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
            // Re-fetch user before modifying Map
            const userToSave = await User.findById(user._id);
            if (userToSave) {
              userToSave.googleTasks.syncedTaskIds.delete(taskId);
              await userToSave.save();
            }
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
          if (!freshUser) {
            logger.warn('[Auto-sync Tasks] User not found on re-fetch', { userId: user._id });
            continue;
          }

          const existingGoogleId = freshUser.googleTasks?.syncedTaskIds?.get(taskId);

          logger.debug('[Auto-sync Tasks] Checking existing', {
            userId: user._id,
            taskId,
            existingGoogleId: existingGoogleId || 'none'
          });

          if (existingGoogleId) {
            try {
              await retryWithBackoff(() => tasksApi.tasks.update({
                tasklist: freshUser.googleTasks.taskListId,
                task: existingGoogleId,
                resource: googleTaskData
              }));
              logger.debug('[Auto-sync Tasks] Updated existing task', { userId: user._id, taskId, googleTaskId: existingGoogleId });
            } catch (e) {
              if (e.code === 404) {
                // Task was deleted from Google, create new one
                const newTask = await retryWithBackoff(() => tasksApi.tasks.insert({
                  tasklist: freshUser.googleTasks.taskListId,
                  resource: googleTaskData
                }));
                // Re-fetch again before saving to prevent overwriting other changes
                const userToSave = await User.findById(user._id);
                if (userToSave) {
                  userToSave.googleTasks.syncedTaskIds.set(taskId, newTask.data.id);
                  await userToSave.save();
                }
                logger.debug('[Auto-sync Tasks] Recreated deleted task', { userId: user._id, taskId, newGoogleTaskId: newTask.data.id });
              } else {
                throw e;
              }
            }
          } else {
            const newTask = await retryWithBackoff(() => tasksApi.tasks.insert({
              tasklist: freshUser.googleTasks.taskListId,
              resource: googleTaskData
            }));
            // Re-fetch again before saving to prevent overwriting other changes
            const userToSave = await User.findById(user._id);
            if (userToSave) {
              userToSave.googleTasks.syncedTaskIds.set(taskId, newTask.data.id);
              await userToSave.save();
            }
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
