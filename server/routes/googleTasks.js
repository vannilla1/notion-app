const express = require('express');
const { google } = require('googleapis');
const mongoose = require('mongoose');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace } = require('../middleware/workspace');
const User = require('../models/User');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const WorkspaceMember = require('../models/WorkspaceMember');
const Workspace = require('../models/Workspace');
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

/**
 * Create a fresh OAuth2Client for each request.
 * CRITICAL: Must NOT be a module-level singleton — credentials on a shared client
 * race across concurrent requests and can leak data between users.
 */
const createOAuth2Client = () => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_TASKS_REDIRECT_URI
  );
};

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
  // Per-request OAuth client — never share across requests
  const client = createOAuth2Client();
  if (!client) {
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

  client.setCredentials({
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
      forceRefresh
    });

    try {
      const { credentials } = await client.refreshAccessToken();
      user.googleTasks.accessToken = credentials.access_token;
      user.googleTasks.tokenExpiry = new Date(credentials.expiry_date);
      // Google sometimes returns a new refresh token - always save it
      if (credentials.refresh_token) {
        user.googleTasks.refreshToken = credentials.refresh_token;
        logger.info('[Google Tasks] New refresh token received', { userId: user._id });
      }
      await user.save();
      client.setCredentials(credentials);
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
        // Clear invalid credentials and disable sync
        user.googleTasks.accessToken = null;
        user.googleTasks.refreshToken = null;
        user.googleTasks.tokenExpiry = null;
        user.googleTasks.connected = false;
        user.googleTasks.enabled = false;
        await user.save();

        logger.warn('[Google Tasks] Credentials cleared due to invalid grant', { userId: user._id });
        throw new Error('Google Tasks token expired. Please reconnect your account.');
      }

      // For other errors, try to continue with existing token
      logger.warn('[Google Tasks] Continuing with existing token after refresh failure', { userId: user._id });
    }
  }

  return google.tasks({ version: 'v1', auth: client });
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

    const client = createOAuth2Client();
    const authUrl = client.generateAuthUrl({
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
  const baseUrl = process.env.CLIENT_URL || 'https://prplcrm.eu';

  // NOTE: never log req.query verbatim — it contains the OAuth authorization `code`
  logger.info('[Google Tasks] Callback received', { hasCode: !!req.query.code, hasState: !!req.query.state });

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

    // Exchange code for tokens — use fresh per-request client
    const client = createOAuth2Client();
    const { tokens } = await client.getToken(code);
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

    // Set credentials on the per-request client to create task list
    client.setCredentials(tokens);
    const tasksApi = google.tasks({ version: 'v1', auth: client });

    // Try to find or create "Prpl CRM" task list
    let taskListId = null;
    try {
      const taskListsResponse = await tasksApi.tasklists.list();
      const taskLists = taskListsResponse.data.items || [];

      // Find existing task list (check both new and legacy name for backward compat)
      const existingList = taskLists.find(list => list.title === 'Prpl CRM' || list.title === 'Perun CRM');

      if (existingList) {
        taskListId = existingList.id;
        logger.info('[Google Tasks] Found existing task list', { userId, taskListId });
      } else {
        // Create new task list
        const newList = await tasksApi.tasklists.insert({
          resource: { title: 'Prpl CRM' }
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

// ==================== PER-WORKSPACE TASK LIST RESOLUTION (PR2) ====================

/**
 * Resolve the Google Tasks taskListId to use for a (user, workspace) pair.
 * Mirror of getOrCreateWorkspaceCalendar in googleCalendar.js — same rationale:
 * each workspace gets its own Google Tasks list named "Prpl CRM — {workspace}"
 * so multi-workspace users aren't forced to share one jumbled list.
 *
 * Fallbacks: mapping → lazy create → legacy single taskListId → null.
 */
async function getOrCreateWorkspaceTaskList(user, workspaceId, tasksApi) {
  if (!workspaceId) {
    return user.googleTasks?.taskListId || null;
  }

  const wsKey = String(workspaceId);
  const existing = user.googleTasks?.workspaceTaskLists?.get?.(wsKey);
  if (existing?.taskListId) {
    // Verify it still exists on Google's side — users do delete lists.
    try {
      await tasksApi.tasklists.get({ tasklist: existing.taskListId });
      return existing.taskListId;
    } catch (e) {
      logger.warn('[Google Tasks] Cached task list disappeared, will recreate', { workspaceId, taskListId: existing.taskListId });
      // fall through to create
    }
  }

  let workspaceName = 'Workspace';
  try {
    const ws = await Workspace.findById(workspaceId).lean();
    if (ws?.name) workspaceName = ws.name;
  } catch (e) {
    logger.debug('[Google Tasks] Workspace lookup failed, using fallback name', { workspaceId, error: e.message });
  }

  const title = `Prpl CRM — ${workspaceName}`;

  let newTaskListId = null;
  try {
    // Does Google already have a list with this title? (re-connect case)
    const listResp = await tasksApi.tasklists.list({ maxResults: 100 });
    const existingOnGoogle = (listResp.data.items || []).find(l => l.title === title);
    if (existingOnGoogle) {
      newTaskListId = existingOnGoogle.id;
      logger.info('[Google Tasks] Reusing existing Google-side task list', { workspaceId, taskListId: newTaskListId });
    } else {
      const created = await tasksApi.tasklists.insert({ resource: { title } });
      newTaskListId = created.data.id;
      logger.info('[Google Tasks] Created per-workspace task list', { workspaceId, taskListId: newTaskListId });
    }
  } catch (err) {
    logger.warn('[Google Tasks] Per-workspace task list setup failed, falling back', {
      userId: user._id?.toString(),
      workspaceId,
      error: err.message
    });
    return user.googleTasks?.taskListId || null;
  }

  if (!newTaskListId) {
    return user.googleTasks?.taskListId || null;
  }

  try {
    await User.findByIdAndUpdate(user._id, {
      $set: {
        [`googleTasks.workspaceTaskLists.${wsKey}`]: {
          taskListId: newTaskListId,
          createdAt: new Date()
        }
      }
    });
    if (!user.googleTasks.workspaceTaskLists) {
      user.googleTasks.workspaceTaskLists = new Map();
    }
    user.googleTasks.workspaceTaskLists.set(wsKey, { taskListId: newTaskListId, createdAt: new Date() });
  } catch (persistErr) {
    logger.warn('[Google Tasks] Failed to persist workspaceTaskLists mapping', {
      userId: user._id?.toString(),
      workspaceId,
      error: persistErr.message
    });
  }

  return newTaskListId;
}

/**
 * Resolve which task list a previously-synced task lives in. Mirror of
 * getCalendarIdForSyncedTask in googleCalendar.js.
 */
function getTaskListIdForSyncedTask(user, taskId) {
  const tl = user.googleTasks?.syncedTaskLists?.get?.(String(taskId));
  return tl || user.googleTasks?.taskListId || null;
}

// Get connection status with quota info and pending tasks count
router.get('/status', authenticateToken, requireWorkspace, async (req, res) => {
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

    // Count pending tasks (all non-completed tasks that should be synced)
    let totalTasks = 0;
    let syncedCount = 0;

    if (user.googleTasks?.enabled) {
      const workspaceId = req.workspaceId || user.currentWorkspaceId;
      const userId = req.user.id.toString();
      const isUserTask = (task) => {
        const assignedTo = task.assignedTo || [];
        if (assignedTo.length === 0) return true;
        return assignedTo.some(id => id && id.toString() === userId);
      };

      const globalTasks = workspaceId ? await Task.find(
        { workspaceId, completed: { $ne: true } },
        { _id: 1, subtasks: 1, assignedTo: 1, dueDate: 1 }
      ).lean() : [];
      const contacts = workspaceId ? await Contact.find(
        { workspaceId },
        { 'tasks.id': 1, 'tasks.completed': 1, 'tasks.subtasks': 1, 'tasks.assignedTo': 1, 'tasks.dueDate': 1 }
      ).lean() : [];

      // Count global tasks — unassigned or assigned to this user
      for (const task of globalTasks) {
        if (!isUserTask(task)) continue;
        // Count parent task only if it has dueDate
        if (task.dueDate) {
          totalTasks++;
          const taskId = task._id.toString();
          const existingGoogleTaskId = user.googleTasks.syncedTaskIds?.get(taskId);
          if (existingGoogleTaskId && typeof existingGoogleTaskId === 'string' && existingGoogleTaskId.length > 0) {
            syncedCount++;
          }
        }
        // Always count subtasks (they have their own dueDate filter)
        if (task.subtasks) {
          const subtaskCounts = countSubtasksPendingSync(task.subtasks, user);
          totalTasks += subtaskCounts.total;
          syncedCount += subtaskCounts.synced;
        }
      }

      // Count contact tasks — unassigned or assigned to this user
      for (const contact of contacts) {
        if (contact.tasks) {
          for (const task of contact.tasks) {
            if (!task.completed && isUserTask(task)) {
              if (task.dueDate) {
                totalTasks++;
                const existingGoogleTaskId = user.googleTasks.syncedTaskIds?.get(task.id);
                if (existingGoogleTaskId && typeof existingGoogleTaskId === 'string' && existingGoogleTaskId.length > 0) {
                  syncedCount++;
                }
              }
              // Always count subtasks (they have their own dueDate filter)
              if (task.subtasks) {
                const subtaskCounts = countSubtasksPendingSync(task.subtasks, user);
                totalTasks += subtaskCounts.total;
                syncedCount += subtaskCounts.synced;
              }
            }
          }
        }
      }
    }

    const pendingCount = totalTasks - syncedCount;

    res.json({
      connected: (user.googleTasks?.enabled && !!user.googleTasks?.accessToken) || false,
      connectedAt: user.googleTasks?.connectedAt || null,
      lastSyncAt: user.googleTasks?.lastSyncAt || null,
      pendingTasks: {
        total: totalTasks,
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
    if (!subtask.completed && subtask.dueDate) {
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
      // Fire-and-forget with timeout so disconnect never blocks on Google being slow
      const client = createOAuth2Client();
      if (client) {
        const tokenToRevoke = user.googleTasks.accessToken;
        Promise.race([
          client.revokeToken(tokenToRevoke).then(() =>
            logger.info('[Google Tasks] Token revoked', { userId: req.user.id })
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('revoke timeout')), 3000))
        ]).catch((e) => {
          logger.debug('[Google Tasks] Token revocation skipped', { error: e.message, userId: req.user.id });
        });
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

router.post('/sync', authenticateToken, requireWorkspace, async (req, res) => {
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

    const tasksApi = await getTasksClient(user);

    // Get all tasks for the workspace from which the sync was triggered
    const workspaceId = req.workspaceId || user.currentWorkspaceId;

    // PR2: resolve per-workspace task list (creates lazily the first time).
    // The legacy `taskListId` is kept as fallback for users who pre-dated PR2.
    const targetTaskListId = await getOrCreateWorkspaceTaskList(user, workspaceId, tasksApi);
    if (!targetTaskListId) {
      logger.error('[Google Tasks] Unable to resolve task list', { userId: req.user.id, workspaceId });
      return res.status(500).json({ message: 'Nepodarilo sa vytvoriť task list v Google Tasks' });
    }
    const userId = req.user.id.toString(); // Convert ObjectId to string for comparison

    // Only sync tasks assigned to this user (or unassigned tasks)
    const isUserTask = (task) => {
      const assignedTo = task.assignedTo || [];
      if (assignedTo.length === 0) return true;
      return assignedTo.some(id => id && id.toString() === userId);
    };

    const globalTasks = workspaceId ? await Task.find(
      { workspaceId },
      { _id: 1, title: 1, description: 1, dueDate: 1, completed: 1, modifiedAt: 1, updatedAt: 1, subtasks: 1, assignedTo: 1 }
    ).lean() : [];
    const contacts = workspaceId ? await Contact.find(
      { workspaceId },
      { name: 1, tasks: 1 }
    ).lean() : [];
    const contactTaskCount = contacts.reduce((sum, c) => sum + (c.tasks?.length || 0), 0);
    logger.info('[Google Tasks] Fetched tasks from DB', {
      userId: req.user.id,
      workspaceId: workspaceId?.toString(),
      globalTasks: globalTasks.length,
      contacts: contacts.length,
      contactTasks: contactTaskCount
    });

    const tasksToSync = [];

    // Collect global tasks — unassigned or assigned to this user
    for (const task of globalTasks) {
      if (!task.completed && isUserTask(task)) {
        // Only sync the parent task itself if it has a dueDate
        if (task.dueDate) {
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
        // Always check subtasks (they have their own dueDate filter)
        collectSubtasksForSync(task.subtasks, task.title, null, tasksToSync);
      }
    }

    // Collect contact tasks — unassigned or assigned to this user
    for (const contact of contacts) {
      if (contact.tasks) {
        for (const task of contact.tasks) {
          if (!task.completed && isUserTask(task)) {
            if (task.dueDate) {
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

      // Skip tasks with invalid due date (but allow tasks without due date)
      if (task.dueDate && isNaN(new Date(task.dueDate).getTime())) {
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
        msg = 'Žiadne úlohy na synchronizáciu';
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

    // Process tasks sequentially in batches to avoid Google rate limits
    // Google Tasks API has a per-minute rate limit (~200 req/min for mutations)
    const BATCH_SIZE = 40; // Process 40 tasks per batch
    const BATCH_DELAY = 3000; // 3 second pause between batches
    const MAX_RETRIES = 5;
    const SAVE_INTERVAL = 50; // Save progress every 50 completed tasks
    let taskIndex = 0;
    let completedSinceLastSave = 0;

    // Combine tasks - updates first (more important)
    const allTasksToProcess = [...tasksToUpdate, ...tasksToCreate];

    logger.info('[Google Tasks] Processing tasks', { userId: req.user.id, total: allTasksToProcess.length, batchSize: BATCH_SIZE });

    // Sleep helper
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Process a single task with retry on rate limit
    const processTask = async (task) => {
      const isUpdate = !!task.googleTaskId;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const taskData = createGoogleTaskData(task);

          // PR2: /sync runs in the context of ONE workspace, so every task in
          // this loop lands in the same per-workspace list. Cross-list moves
          // (task reassigned to a different workspace) are handled by the
          // auto-sync path, not here.
          if (isUpdate) {
            try {
              await tasksApi.tasks.patch({
                tasklist: targetTaskListId,
                task: task.googleTaskId,
                requestBody: taskData
              });
              return { success: true, taskId: task.id, googleTaskId: task.googleTaskId, hash: task.hash, action: 'updated' };
            } catch (updateError) {
              const uCode = updateError.code || updateError.response?.status;
              // Rate limit on update - throw to trigger retry
              if (uCode === 429 || uCode === 403) throw updateError;
              // If task doesn't exist in Google anymore, create it
              if (uCode === 404 || uCode === 400) {
                const newTask = await tasksApi.tasks.insert({
                  tasklist: targetTaskListId,
                  resource: taskData
                });
                return { success: true, taskId: task.id, googleTaskId: newTask.data.id, hash: task.hash, action: 'recreated' };
              }
              throw updateError;
            }
          } else {
            const newTask = await tasksApi.tasks.insert({
              tasklist: targetTaskListId,
              resource: taskData
            });
            return { success: true, taskId: task.id, googleTaskId: newTask.data.id, hash: task.hash, action: 'created' };
          }
        } catch (error) {
          const code = error.code || error.response?.status;
          if ((code === 429 || code === 403) && attempt < MAX_RETRIES) {
            // Aggressive exponential backoff: 3s, 6s, 12s, 24s, 48s
            const delay = Math.pow(2, attempt) * 3000;
            logger.debug('[Google Tasks] Rate limited, waiting', { taskId: task.id, attempt: attempt + 1, delay });
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

    let successCount = 0;
    let consecutiveRateLimits = 0;

    // Process a single result immediately
    const handleResult = (result) => {
      if (!result) return;
      if (result.success) {
        user.googleTasks.syncedTaskIds.set(result.taskId, result.googleTaskId);
        user.googleTasks.syncedTaskHashes.set(result.taskId, result.hash);
        // PR2: record which list this task went into so deletes know where
        // to look. In /sync context every task goes to targetTaskListId.
        if (!user.googleTasks.syncedTaskLists) {
          user.googleTasks.syncedTaskLists = new Map();
        }
        user.googleTasks.syncedTaskLists.set(result.taskId, targetTaskListId);
        successCount++;
        completedSinceLastSave++;
        consecutiveRateLimits = 0; // Reset on success
        if (result.action === 'created' || result.action === 'recreated') {
          synced++;
        } else {
          updated++;
        }
      } else if (result.error === 'rate_limit') {
        rateLimitCount++;
        errors++;
        consecutiveRateLimits++;
      } else {
        errors++;
        consecutiveRateLimits = 0;
      }
    };

    // Periodic save to prevent data loss on timeout
    const saveProgress = async () => {
      try {
        await user.save();
        logger.info('[Google Tasks] Progress saved', { synced, updated, successCount });
        completedSinceLastSave = 0;
      } catch (saveErr) {
        logger.error('[Google Tasks] Progress save failed', { error: saveErr.message });
      }
    };

    // Process in batches with delays between them
    for (let batchStart = 0; batchStart < allTasksToProcess.length; batchStart += BATCH_SIZE) {
      // Check timeout
      if (Date.now() - syncStartTime > SYNC_TIMEOUT) {
        skipped += allTasksToProcess.length - batchStart;
        logger.warn('[Google Tasks] Timeout reached', { processed: batchStart, total: allTasksToProcess.length });
        break;
      }

      // If we hit many consecutive rate limits, increase delay significantly
      if (consecutiveRateLimits >= 10) {
        logger.warn('[Google Tasks] Too many rate limits, pausing 30s', { consecutiveRateLimits });
        await sleep(30000);
        consecutiveRateLimits = 0;
      }

      const batch = allTasksToProcess.slice(batchStart, batchStart + BATCH_SIZE);

      // Process batch sequentially (one at a time) to respect rate limits
      for (const task of batch) {
        if (Date.now() - syncStartTime > SYNC_TIMEOUT) {
          skipped++;
          continue;
        }
        const result = await processTask(task);
        handleResult(result);
        taskIndex++;

        // Small delay between individual requests (100ms) to stay under rate limit
        await sleep(100);
      }

      // Save progress after each batch
      if (completedSinceLastSave > 0) {
        await saveProgress();
      }

      // Pause between batches (if more batches remain)
      if (batchStart + BATCH_SIZE < allTasksToProcess.length) {
        logger.info('[Google Tasks] Batch complete, pausing', {
          processed: Math.min(batchStart + BATCH_SIZE, allTasksToProcess.length),
          total: allTasksToProcess.length,
          synced,
          updated,
          errors
        });
        await sleep(BATCH_DELAY);
      }
    }

    incrementQuota(user, successCount);

    // Update last sync time
    user.googleTasks.lastSyncAt = new Date();
    await user.save();

    // ===== REVERSE SYNC: Pull completed status FROM Google Tasks back to CRM =====
    let completedFromGoogle = 0;
    try {
      // Build reverse map: googleTaskId -> crmTaskId
      const reverseMap = new Map();
      if (user.googleTasks.syncedTaskIds) {
        for (const [crmId, googleId] of user.googleTasks.syncedTaskIds.entries()) {
          reverseMap.set(googleId, crmId);
        }
      }

      // Fetch all Google Tasks from the target (per-workspace) list to check
      // completion status. PR2: /sync is scoped to one workspace, so reverse
      // sync should only pull from that workspace's list — events from other
      // workspaces' lists shouldn't leak here.
      let allGoogleTasks = [];
      let gPageToken = null;
      do {
        const gResponse = await tasksApi.tasks.list({
          tasklist: targetTaskListId,
          maxResults: 100,
          showCompleted: true,
          showHidden: true,
          pageToken: gPageToken
        });
        if (gResponse.data.items) {
          allGoogleTasks = allGoogleTasks.concat(gResponse.data.items);
        }
        gPageToken = gResponse.data.nextPageToken;
      } while (gPageToken);

      const completedGoogleTasks = allGoogleTasks.filter(t => t.status === 'completed');
      const io = req.app.get('io');

      for (const googleTask of completedGoogleTasks) {
        const crmTaskId = reverseMap.get(googleTask.id);
        if (!crmTaskId) continue;

        // Check global tasks (workspace-scoped) — only if crmTaskId is a valid ObjectId
        const wsId = req.workspaceId || user.currentWorkspaceId;
        let globalTask = null;
        if (isValidObjectId(crmTaskId)) {
          globalTask = await Task.findOne({ _id: crmTaskId, ...(wsId ? { workspaceId: wsId } : {}) });
        }
        if (globalTask && !globalTask.completed) {
          globalTask.completed = true;
          globalTask.modifiedAt = new Date().toISOString();
          await globalTask.save();
          completedFromGoogle++;
          if (io && globalTask.workspaceId) {
            io.to(`workspace-${globalTask.workspaceId}`).emit('task-updated', { ...globalTask.toObject(), id: globalTask._id.toString(), source: 'global' });
          }
          continue;
        }

        // Check contact tasks (workspace-scoped)
        if (!globalTask) {
          const contacts = await Contact.find({ 'tasks.id': crmTaskId, ...(wsId ? { workspaceId: wsId } : {}) });
          for (const contact of contacts) {
            const taskIndex = contact.tasks.findIndex(t => t.id === crmTaskId);
            if (taskIndex !== -1 && !contact.tasks[taskIndex].completed) {
              contact.tasks[taskIndex].completed = true;
              contact.tasks[taskIndex].modifiedAt = new Date().toISOString();
              contact.markModified('tasks');
              await contact.save();
              completedFromGoogle++;
              if (io && contact.workspaceId) {
                io.to(`workspace-${contact.workspaceId}`).emit('contact-updated', contact.toObject());
                io.to(`workspace-${contact.workspaceId}`).emit('task-updated', { ...contact.tasks[taskIndex], contactId: contact._id.toString(), contactName: contact.name, source: 'contact' });
              }
              break;
            }
          }
        }

        // Check subtasks - search in global tasks (workspace-scoped)
        if (!globalTask) {
          const allTasks = await Task.find({ 'subtasks.id': crmTaskId, ...(wsId ? { workspaceId: wsId } : {}) });
          for (const parentTask of allTasks) {
            const subtask = findSubtaskById(parentTask.subtasks, crmTaskId);
            if (subtask && !subtask.completed) {
              subtask.completed = true;
              parentTask.markModified('subtasks');
              await parentTask.save();
              completedFromGoogle++;
              if (io && parentTask.workspaceId) {
                io.to(`workspace-${parentTask.workspaceId}`).emit('task-updated', { ...parentTask.toObject(), id: parentTask._id.toString(), source: 'global' });
              }
              break;
            }
          }
        }
      }

      if (completedFromGoogle > 0) {
        logger.info('[Google Tasks] Reverse sync - marked tasks as completed from Google', { userId: req.user.id, completedFromGoogle });
      }
    } catch (reverseErr) {
      logger.warn('[Google Tasks] Reverse sync error (non-fatal)', { error: reverseErr.message });
    }

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
      completedFromGoogle,
      duration: syncDuration,
      timedOut
    });

    let message = `Synchronizované: ${synced} nových, ${updated} aktualizovaných, ${unchanged} nezmenených`;
    if (completedFromGoogle > 0) message += `, ${completedFromGoogle} dokončených z Google`;
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

/**
 * MIGRATE — move existing tasks from the legacy single list into new
 * per-workspace lists. Mirror of /migrate-to-per-workspace in googleCalendar.js.
 * Idempotent: re-running picks up anything that failed the first time.
 */
router.post('/migrate-to-per-workspace', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    const tasksApi = await getTasksClient(user);
    const legacyListId = user.googleTasks.taskListId;
    if (!legacyListId) {
      return res.json({ success: true, message: 'Nie je čo migrovať — žiadny legacy task list.', migrated: 0 });
    }

    const syncedTaskIds = user.googleTasks.syncedTaskIds
      ? Array.from(user.googleTasks.syncedTaskIds.entries())
      : [];

    let migrated = 0;
    let skipped = 0;
    let errors = 0;
    let orphans = 0;

    for (const [taskId, googleTaskId] of syncedTaskIds) {
      const existingList = user.googleTasks.syncedTaskLists?.get?.(taskId);
      if (existingList) { skipped++; continue; }

      try {
        // Resolve task → workspaceId
        let workspaceId = null;
        if (mongoose.Types.ObjectId.isValid(taskId)) {
          const t = await Task.findById(taskId, 'workspaceId').lean();
          if (t?.workspaceId) workspaceId = t.workspaceId.toString();
        }
        if (!workspaceId) {
          const memberships = await WorkspaceMember.find({ userId: user._id }, 'workspaceId').lean();
          const wsIds = memberships.map(m => m.workspaceId);
          const contact = await Contact.findOne({ workspaceId: { $in: wsIds }, 'tasks.id': taskId }, 'workspaceId').lean();
          if (contact?.workspaceId) workspaceId = contact.workspaceId.toString();
        }

        if (!workspaceId) {
          orphans++;
          try { await tasksApi.tasks.delete({ tasklist: legacyListId, task: googleTaskId }); }
          catch (e) { if (e.code !== 404) logger.debug('[Migrate Tasks] Orphan delete failed', { error: e.message }); }
          await User.findByIdAndUpdate(user._id, {
            $unset: {
              [`googleTasks.syncedTaskIds.${taskId}`]: '',
              [`googleTasks.syncedTaskLists.${taskId}`]: ''
            }
          });
          continue;
        }

        const targetListId = await getOrCreateWorkspaceTaskList(user, workspaceId, tasksApi);
        if (!targetListId || targetListId === legacyListId) {
          await User.findByIdAndUpdate(user._id, {
            $set: { [`googleTasks.syncedTaskLists.${taskId}`]: legacyListId }
          });
          skipped++;
          continue;
        }

        // Fetch original task to preserve title/notes/due date.
        let original = null;
        try {
          const { data } = await tasksApi.tasks.get({ tasklist: legacyListId, task: googleTaskId });
          original = data;
        } catch (e) {
          if (e.code !== 404) throw e;
          await User.findByIdAndUpdate(user._id, {
            $unset: {
              [`googleTasks.syncedTaskIds.${taskId}`]: '',
              [`googleTasks.syncedTaskLists.${taskId}`]: ''
            }
          });
          orphans++;
          continue;
        }

        const copyBody = {
          title: original.title,
          notes: original.notes,
          due: original.due,
          status: original.status
        };

        const inserted = await tasksApi.tasks.insert({
          tasklist: targetListId,
          resource: copyBody
        });

        try { await tasksApi.tasks.delete({ tasklist: legacyListId, task: googleTaskId }); }
        catch (e) { if (e.code !== 404) logger.warn('[Migrate Tasks] Legacy delete failed', { taskId, error: e.message }); }

        await User.findByIdAndUpdate(user._id, {
          $set: {
            [`googleTasks.syncedTaskIds.${taskId}`]: inserted.data.id,
            [`googleTasks.syncedTaskLists.${taskId}`]: targetListId
          }
        });
        migrated++;
      } catch (taskErr) {
        errors++;
        logger.warn('[Migrate Tasks] Per-task migration failed', { taskId, error: taskErr.message });
      }
    }

    logger.info('[Google Tasks] Migration finished', {
      userId: user._id.toString(),
      migrated, skipped, orphans, errors, total: syncedTaskIds.length
    });

    res.json({
      success: true,
      message: `Rozdelené: ${migrated} úloh presunutých do workspace listov, ${skipped} už bolo správne, ${orphans} osirotené odstránené, ${errors} chýb.`,
      migrated, skipped, orphans, errors, total: syncedTaskIds.length
    });
  } catch (error) {
    logger.error('[Google Tasks] Migration error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri migrácii: ' + error.message });
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

    // Get all current task IDs for current workspace
    const workspaceId = user.currentWorkspaceId;
    const globalTasks = workspaceId ? await Task.find({ workspaceId }, { _id: 1 }).lean() : [];
    const contacts = workspaceId ? await Contact.find({ workspaceId }, { 'tasks.id': 1 }).lean() : [];

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
          // PR2: delete from whichever list holds this task (per-workspace).
          // Fall back to legacy single list for pre-PR2 mappings.
          const cleanupListId = getTaskListIdForSyncedTask(user, taskId);
          if (!cleanupListId) continue;
          try {
            await tasksApi.tasks.delete({
              tasklist: cleanupListId,
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
          if (user.googleTasks.syncedTaskLists) {
            user.googleTasks.syncedTaskLists.delete(taskId);
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

// Remove all tasks by deleting the entire task list and recreating it
// This is MUCH faster than deleting individual tasks (2 API calls vs 2800+)
// After this, user runs "Synchronizovať" to recreate all tasks from CRM
router.post('/remove-duplicates', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id.toString();
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    if (!user.googleTasks?.enabled) {
      return res.status(400).json({ message: 'Google Tasks nie je pripojený' });
    }

    const tasksApi = await getTasksClient(user);

    // PR2: nuke ALL Prpl CRM task lists — the legacy single list AND every
    // per-workspace list. User expects "delete everything", not "delete one
    // workspace and leave the rest behind".
    const listsToDelete = new Set();
    if (user.googleTasks.taskListId) listsToDelete.add(user.googleTasks.taskListId);
    if (user.googleTasks.workspaceTaskLists) {
      for (const [, entry] of user.googleTasks.workspaceTaskLists.entries()) {
        if (entry?.taskListId) listsToDelete.add(entry.taskListId);
      }
    }

    logger.info('[Google Tasks] Nuke & recreate - deleting task lists', { userId, count: listsToDelete.size });

    for (const listId of listsToDelete) {
      try {
        await tasksApi.tasklists.delete({ tasklist: listId });
      } catch (deleteErr) {
        if (deleteErr.code !== 404 && deleteErr.response?.status !== 404) {
          logger.warn('[Google Tasks] Failed to delete a list during nuke', { listId, error: deleteErr.message });
        }
      }
    }

    // Step 2: Clear all sync state. We don't pre-create a new list here —
    // the next sync will lazily create a per-workspace list on demand via
    // getOrCreateWorkspaceTaskList, so empty state is correct.
    user.googleTasks.taskListId = null;
    user.googleTasks.workspaceTaskLists = new Map();
    user.googleTasks.syncedTaskIds = new Map();
    user.googleTasks.syncedTaskLists = new Map();
    user.googleTasks.syncedTaskHashes = new Map();
    await user.save();

    const newTaskListId = null;

    logger.info('[Google Tasks] Nuke & recreate completed', { userId, newTaskListId });

    res.json({
      success: true,
      status: 'completed',
      message: '✅ Všetky úlohy boli vymazané z Google Tasks. Spustite "Synchronizovať" pre opätovné vytvorenie úloh z CRM.',
      needsResync: true
    });
  } catch (error) {
    logger.error('[Google Tasks] Nuke & recreate error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri mazaní úloh: ' + error.message });
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

    // Search ALL task lists, not just the current one
    const taskListsRes = await tasksApi.tasklists.list();
    const taskLists = taskListsRes.data.items || [];

    logger.info('[Google Tasks] Delete by search - scanning all task lists', {
      userId: req.user.id,
      searchTerm,
      taskListCount: taskLists.length,
      taskListNames: taskLists.map(tl => tl.title)
    });

    // Collect matching tasks from ALL task lists
    let allMatchingTasks = []; // { taskListId, task }
    const searchRegex = new RegExp(searchTerm, 'i');

    for (const taskList of taskLists) {
      let pageToken = null;
      do {
        const response = await tasksApi.tasks.list({
          tasklist: taskList.id,
          maxResults: 100,
          showCompleted: true,
          showHidden: true,
          pageToken
        });

        if (response.data.items) {
          for (const task of response.data.items) {
            if (task.title && searchRegex.test(task.title)) {
              allMatchingTasks.push({ taskListId: taskList.id, task });
            }
          }
        }
        pageToken = response.data.nextPageToken;
      } while (pageToken);
    }

    logger.info('[Google Tasks] Delete by search - found matches', {
      userId: req.user.id,
      searchTerm,
      matchingTasks: allMatchingTasks.length
    });

    let deleted = 0;
    let errors = 0;

    for (const { taskListId, task } of allMatchingTasks) {
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
        if (e.code !== 404 && e.response?.status !== 404) {
          logger.warn('[Google Tasks] Failed to delete task by search', {
            taskId: task.id,
            title: task.title,
            error: e.message
          });
          errors++;
        } else {
          deleted++; // Already gone = success
        }
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    await user.save();

    logger.info('[Google Tasks] Delete by search completed', {
      userId: req.user.id,
      searchTerm,
      deleted,
      errors
    });

    // Count total tasks across all lists for debugging
    let totalTasksScanned = 0;
    for (const taskList of taskLists) {
      let pgToken = null;
      do {
        const r = await tasksApi.tasks.list({ tasklist: taskList.id, maxResults: 100, showCompleted: true, showHidden: true, pageToken: pgToken });
        totalTasksScanned += (r.data.items || []).length;
        pgToken = r.data.nextPageToken;
      } while (pgToken);
    }

    res.json({
      success: true,
      message: `Vymazané: ${deleted} úloh s "${searchTerm}", ${errors} chýb (prehľadaných ${totalTasksScanned} úloh v ${taskLists.length} zoznamoch: ${taskLists.map(tl => tl.title).join(', ')})`,
      found: allMatchingTasks.length,
      deleted,
      errors
    });
  } catch (error) {
    logger.error('[Google Tasks] Delete by search error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri mazaní: ' + error.message });
  }
});

// Sync completed tasks FROM Google Tasks TO CRM
router.post('/sync-completed', authenticateToken, requireWorkspace, async (req, res) => {
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

    // PR2: aggregate completed tasks across ALL lists we manage (legacy +
    // per-workspace). User-facing behavior: "sync completed" means pull
    // completion status from every Prpl CRM list, not just one.
    const listsToScan = new Set();
    if (user.googleTasks.taskListId) listsToScan.add(user.googleTasks.taskListId);
    if (user.googleTasks.workspaceTaskLists) {
      for (const [, entry] of user.googleTasks.workspaceTaskLists.entries()) {
        if (entry?.taskListId) listsToScan.add(entry.taskListId);
      }
    }

    // Get completed tasks from all Prpl CRM task lists
    let completedGoogleTasks = [];

    for (const listId of listsToScan) {
      let pageToken = null;
      try {
        do {
          const response = await tasksApi.tasks.list({
            tasklist: listId,
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
      } catch (e) {
        logger.warn('[Google Tasks] List scan failed during sync-completed', { listId, error: e.message });
      }
    }

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
      // First check global tasks (workspace-scoped) — only if crmTaskId is a valid ObjectId
      const wsId = req.workspaceId || user.currentWorkspaceId;
      let globalTask = null;
      if (isValidObjectId(crmTaskId)) {
        globalTask = await Task.findOne({ _id: crmTaskId, ...(wsId ? { workspaceId: wsId } : {}) });
      }
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
        if (io && globalTask.workspaceId) {
          io.to(`workspace-${globalTask.workspaceId}`).emit('task-updated', {
            ...globalTask.toObject(),
            id: globalTask._id.toString(),
            source: 'global'
          });
        }
        continue;
      }

      // Check contact tasks (workspace-scoped)
      const contacts = await Contact.find({ 'tasks.id': crmTaskId, ...(wsId ? { workspaceId: wsId } : {}) });
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
          if (io && contact.workspaceId) {
            io.to(`workspace-${contact.workspaceId}`).emit('contact-updated', contact.toObject());
            io.to(`workspace-${contact.workspaceId}`).emit('task-updated', {
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
function findSubtaskById(subtasks, id) {
  if (!subtasks) return null;
  for (const subtask of subtasks) {
    if (subtask.id === id) return subtask;
    if (subtask.subtasks) {
      const found = findSubtaskById(subtask.subtasks, id);
      if (found) return found;
    }
  }
  return null;
}

function collectSubtasksForSync(subtasks, parentTitle, contactName, tasksToSync) {
  if (!subtasks) return;
  for (const subtask of subtasks) {
    if (!subtask.completed && subtask.dueDate) {
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
  // Google Tasks title limit is 1024 chars
  let title = (task.title || '').substring(0, 1024);
  let notes = (task.notes || '').substring(0, 8192);
  if (task.contact) {
    notes += notes ? '\n\n' : '';
    notes += `Kontakt: ${task.contact}`;
  }

  const result = {
    title,
    notes,
    status: task.completed ? 'completed' : 'needsAction'
  };

  if (task.completed) {
    result.completed = new Date().toISOString();
  }

  if (task.dueDate) {
    try {
      const dueDate = new Date(task.dueDate);
      if (!isNaN(dueDate.getTime())) {
        dueDate.setUTCHours(23, 59, 59, 999);
        result.due = dueDate.toISOString();
      }
    } catch (e) {
      logger.warn('[Google Tasks] Invalid dueDate', { taskId: task.id, dueDate: task.dueDate });
    }
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
    // Only sync tasks with a due date (except deletes — always propagate)
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

    // Determine workspace scope — only sync for members of the task's workspace
    const workspaceId = taskData.workspaceId?.toString();
    logger.info('[Auto-sync Tasks] Starting sync', { taskId, action, title: taskData.title, completed: taskData.completed, hasDueDate: !!taskData.dueDate, workspaceId });

    try {
    // Find users with Google Tasks enabled — filtered by workspace membership
    let users;
    if (workspaceId) {
      const members = await WorkspaceMember.find({ workspaceId }, 'userId').lean();
      const memberUserIds = members.map(m => m.userId);
      users = await User.find({ _id: { $in: memberUserIds }, 'googleTasks.enabled': true });
    } else {
      // Fallback: no workspace context (shouldn't happen, but safe)
      users = await User.find({ 'googleTasks.enabled': true });
    }

    // Filter by assignedTo: if task is assigned, only sync for assigned users
    const assignedTo = (taskData.assignedTo || []).map(id => id?.toString()).filter(Boolean);
    if (assignedTo.length > 0) {
      users = users.filter(u => assignedTo.includes(u._id.toString()));
    }

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
            // Delete from whichever task list holds this task (PR2 multi-list).
            const targetTaskListId = getTaskListIdForSyncedTask(user, taskId);
            if (targetTaskListId) {
              try {
                await retryWithBackoff(() => tasksApi.tasks.delete({
                  tasklist: targetTaskListId,
                  task: googleTaskId
                }));
              } catch (e) {
                if (e.code !== 404) {
                  logger.warn('[Auto-sync Tasks] Delete failed', { userId: user._id, taskId, error: e.message });
                }
              }
            }
            // Atomic removal of mappings
            await User.findByIdAndUpdate(user._id, {
              $unset: {
                [`googleTasks.syncedTaskIds.${taskId}`]: '',
                [`googleTasks.syncedTaskLists.${taskId}`]: ''
              }
            });
          }
        } else {
          // Resolve target list (creates lazily the first time).
          const targetTaskListId = await getOrCreateWorkspaceTaskList(user, workspaceId, tasksApi);
          if (!targetTaskListId) {
            logger.warn('[Auto-sync Tasks] No task list available, skipping', { userId: user._id, taskId });
            continue;
          }

          const googleTaskData = createGoogleTaskData({
            id: taskId,
            title: taskData.title,
            notes: taskData.description || taskData.notes || '',
            dueDate: taskData.dueDate,
            completed: taskData.completed,
            contact: taskData.contactName || taskData.contact || null
          });

          const existingGoogleId = user.googleTasks?.syncedTaskIds?.get(taskId);
          const existingTaskListId = user.googleTasks?.syncedTaskLists?.get?.(taskId);

          if (existingGoogleId && existingTaskListId && existingTaskListId !== targetTaskListId) {
            // Task moved between lists (workspace switch, or migration from
            // legacy single list) — delete stale, insert fresh.
            try {
              await retryWithBackoff(() => tasksApi.tasks.delete({
                tasklist: existingTaskListId,
                task: existingGoogleId
              }));
            } catch (e) {
              if (e.code !== 404) logger.debug('[Auto-sync Tasks] Stale delete failed', { error: e.message });
            }
            const newTask = await retryWithBackoff(() => tasksApi.tasks.insert({
              tasklist: targetTaskListId,
              resource: googleTaskData
            }));
            await User.findByIdAndUpdate(user._id, {
              $set: {
                [`googleTasks.syncedTaskIds.${taskId}`]: newTask.data.id,
                [`googleTasks.syncedTaskLists.${taskId}`]: targetTaskListId
              }
            });
          } else if (existingGoogleId) {
            const patchListId = existingTaskListId || targetTaskListId;
            try {
              await retryWithBackoff(() => tasksApi.tasks.patch({
                tasklist: patchListId,
                task: existingGoogleId,
                requestBody: googleTaskData
              }));
              // Backfill mapping for pre-PR2 entries
              if (!existingTaskListId) {
                await User.findByIdAndUpdate(user._id, {
                  $set: { [`googleTasks.syncedTaskLists.${taskId}`]: patchListId }
                });
              }
            } catch (e) {
              if (e.code === 404) {
                // Task was deleted from Google — create new one in target list
                const newTask = await retryWithBackoff(() => tasksApi.tasks.insert({
                  tasklist: targetTaskListId,
                  resource: googleTaskData
                }));
                await User.findByIdAndUpdate(user._id, {
                  $set: {
                    [`googleTasks.syncedTaskIds.${taskId}`]: newTask.data.id,
                    [`googleTasks.syncedTaskLists.${taskId}`]: targetTaskListId
                  }
                });
              } else {
                throw e;
              }
            }
          } else {
            const newTask = await retryWithBackoff(() => tasksApi.tasks.insert({
              tasklist: targetTaskListId,
              resource: googleTaskData
            }));
            await User.findByIdAndUpdate(user._id, {
              $set: {
                [`googleTasks.syncedTaskIds.${taskId}`]: newTask.data.id,
                [`googleTasks.syncedTaskLists.${taskId}`]: targetTaskListId
              }
            });
          }
        }
      } catch (error) {
        logger.error('[Auto-sync Tasks] Error for user', { userId: user._id, taskId, action, error: error.message, stack: error.stack?.substring(0, 200) });
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

// ==================== BACKGROUND POLLING: Google Tasks ↔ CRM ====================
// Polls Google Tasks every 30s for ALL changes and syncs bidirectionally

let pollingInterval = null;
let pollingIo = null; // Socket.IO instance for emitting updates

/**
 * Apply a single Google Task change to the CRM (completion, title, due date).
 * Returns true if a CRM task was updated.
 */
const applyGoogleTaskChange = async (googleTask, crmTaskId, wsId) => {
  const isCompleted = googleTask.status === 'completed';
  const googleTitle = (googleTask.title || '').trim();
  // Google Tasks due is RFC3339 date string like "2026-03-28T00:00:00.000Z"
  const googleDue = googleTask.due ? googleTask.due.split('T')[0] : null;
  const isDeleted = googleTask.deleted === true;

  // Try global task first (only if crmTaskId is a valid ObjectId)
  let task = null;
  let contact = null;
  let taskIndex = -1;

  if (isValidObjectId(crmTaskId)) {
    task = await Task.findOne({ _id: crmTaskId, ...(wsId ? { workspaceId: wsId } : {}) });
  }

  if (!task) {
    // Search in contacts (works for both ObjectId and UUID strings)
    contact = await Contact.findOne({
      'tasks.id': crmTaskId,
      ...(wsId ? { workspaceId: wsId } : {})
    });
    if (contact) {
      taskIndex = contact.tasks.findIndex(t => t.id === crmTaskId);
      if (taskIndex !== -1) task = contact.tasks[taskIndex];
    }
  }

  if (!task) {
    // Check subtasks in global tasks
    const parentTasks = await Task.find({ 'subtasks.id': crmTaskId, ...(wsId ? { workspaceId: wsId } : {}) });
    for (const parentTask of parentTasks) {
      const subtask = findSubtaskById(parentTask.subtasks, crmTaskId);
      if (subtask) {
        let changed = false;
        if (isCompleted && !subtask.completed) {
          subtask.completed = true;
          changed = true;
        }
        if (changed) {
          parentTask.markModified('subtasks');
          await parentTask.save();
          if (pollingIo && parentTask.workspaceId) {
            pollingIo.to(`workspace-${parentTask.workspaceId}`).emit('task-updated', { ...parentTask.toObject(), id: parentTask._id.toString(), source: 'global' });
          }
          return true;
        }
      }
    }
    return false;
  }

  // Deleted in Google — remove mapping but don't delete CRM task
  if (isDeleted) {
    // Mapping cleanup happens in the polling loop (caller removes from syncedTaskIds)
    return 'deleted';
  }

  // Compare and apply changes
  let changed = false;
  const crmDue = task.dueDate ? new Date(task.dueDate).toISOString().split('T')[0] : null;

  // Completion
  if (isCompleted && !task.completed) {
    if (contact && taskIndex !== -1) contact.tasks[taskIndex].completed = true;
    else task.completed = true;
    changed = true;
  } else if (!isCompleted && task.completed) {
    // Un-completed in Google
    if (contact && taskIndex !== -1) contact.tasks[taskIndex].completed = false;
    else task.completed = false;
    changed = true;
  }

  // Title
  if (googleTitle && googleTitle !== task.title) {
    if (contact && taskIndex !== -1) contact.tasks[taskIndex].title = googleTitle;
    else task.title = googleTitle;
    changed = true;
  }

  // Due date
  if (googleDue && googleDue !== crmDue) {
    if (contact && taskIndex !== -1) contact.tasks[taskIndex].dueDate = new Date(googleDue);
    else task.dueDate = new Date(googleDue);
    changed = true;
  } else if (!googleDue && crmDue) {
    // Due date removed in Google
    if (contact && taskIndex !== -1) contact.tasks[taskIndex].dueDate = null;
    else task.dueDate = null;
    changed = true;
  }

  if (changed) {
    const now = new Date().toISOString();
    if (contact && taskIndex !== -1) {
      contact.tasks[taskIndex].modifiedAt = now;
      contact.markModified('tasks');
      await contact.save();
      if (pollingIo && contact.workspaceId) {
        pollingIo.to(`workspace-${contact.workspaceId}`).emit('contact-updated', contact.toObject());
        pollingIo.to(`workspace-${contact.workspaceId}`).emit('task-updated', {
          ...contact.tasks[taskIndex],
          contactId: contact._id.toString(),
          contactName: contact.name,
          source: 'contact'
        });
      }
    } else {
      task.modifiedAt = now;
      await task.save();
      if (pollingIo && task.workspaceId) {
        pollingIo.to(`workspace-${task.workspaceId}`).emit('task-updated', {
          ...task.toObject(),
          id: task._id.toString(),
          source: 'global'
        });
      }
    }
  }

  return changed;
};

const pollGoogleTasksChanges = async () => {
  try {
    const users = await User.find({ 'googleTasks.enabled': true });
    if (users.length === 0) return;

    for (const user of users) {
      try {
        const tasksApi = await getTasksClient(user);
        // PR2: poll every list this user is synced to. Legacy single list +
        // every per-workspace list. Without this, completions marked in a
        // workspace-specific list would never propagate back to CRM.
        const listsToPoll = new Set();
        if (user.googleTasks.taskListId) listsToPoll.add(user.googleTasks.taskListId);
        if (user.googleTasks.workspaceTaskLists) {
          for (const [, entry] of user.googleTasks.workspaceTaskLists.entries()) {
            if (entry?.taskListId) listsToPoll.add(entry.taskListId);
          }
        }
        if (listsToPoll.size === 0) continue;

        // Build reverse map: googleTaskId → crmTaskId
        const reverseMap = new Map();
        if (user.googleTasks.syncedTaskIds) {
          for (const [crmId, googleId] of user.googleTasks.syncedTaskIds.entries()) {
            reverseMap.set(googleId, crmId);
          }
        }

        let allGoogleTasks = [];
        for (const taskListId of listsToPoll) {
          let pageToken = null;
          try {
            do {
              const params = {
                tasklist: taskListId,
                maxResults: 100,
                showCompleted: true,
                showDeleted: true,
                showHidden: true,
                pageToken
              };

              // Use updatedMin to only get recently changed tasks (last 2 minutes for 30s polling)
              if (user.googleTasks.lastSyncAt) {
                params.updatedMin = new Date(user.googleTasks.lastSyncAt.getTime() - 30000).toISOString();
              }

              const response = await tasksApi.tasks.list(params);
              if (response.data.items) {
                allGoogleTasks = allGoogleTasks.concat(response.data.items);
              }
              pageToken = response.data.nextPageToken;
            } while (pageToken);
          } catch (e) {
            logger.warn('[Google Tasks Poll] List query failed', { userId: user._id, taskListId, error: e.message });
          }
        }

        if (allGoogleTasks.length === 0) {
          // Update lastSyncAt even if no changes
          user.googleTasks.lastSyncAt = new Date();
          await user.save();
          continue;
        }

        // Get workspace IDs where this user is a member (for scoped lookup)
        const memberships = await WorkspaceMember.find({ userId: user._id }, 'workspaceId').lean();
        const userWorkspaceIds = memberships.map(m => m.workspaceId);
        let updated = 0;

        for (const googleTask of allGoogleTasks) {
          const crmTaskId = reverseMap.get(googleTask.id);
          if (!crmTaskId) continue;

          // Find the actual task to get its workspaceId (instead of using currentWorkspaceId)
          let wsId = null;
          if (isValidObjectId(crmTaskId)) {
            const task = await Task.findById(crmTaskId, 'workspaceId').lean();
            if (task) {
              wsId = task.workspaceId;
            }
          }
          if (!wsId) {
            // Check contacts (works for both ObjectId and UUID strings)
            const contact = await Contact.findOne({ 'tasks.id': crmTaskId }, 'workspaceId').lean();
            if (contact) wsId = contact.workspaceId;
          }

          // Only sync if task belongs to a workspace where the user is a member
          if (wsId && !userWorkspaceIds.some(wId => wId.toString() === wsId.toString())) {
            continue;
          }

          const result = await applyGoogleTaskChange(googleTask, crmTaskId, wsId);
          if (result === 'deleted') {
            // Clean up mapping for task deleted from Google
            await User.findByIdAndUpdate(user._id, {
              $unset: { [`googleTasks.syncedTaskIds.${crmTaskId}`]: '' }
            });
          } else if (result) {
            updated++;
          }
        }

        // Update last sync timestamp
        user.googleTasks.lastSyncAt = new Date();
        await user.save();

        if (updated > 0) {
          logger.info('[Google Tasks Poll] Synced changes from Google', { userId: user._id, updated, total: allGoogleTasks.length });
        }
      } catch (userErr) {
        // Token errors are expected for inactive users - just skip
        if (!userErr.message?.includes('expired') && !userErr.message?.includes('invalid_grant')) {
          logger.warn('[Google Tasks Poll] Error for user', { userId: user._id, error: userErr.message });
        }
      }
    }
  } catch (err) {
    logger.error('[Google Tasks Poll] Fatal error', { error: err.message });
  }
};

const startGoogleTasksPolling = (io) => {
  pollingIo = io;
  // Poll every 5 minutes (Atlas M0 can't handle 30s polling — too many IOPS)
  pollingInterval = setInterval(pollGoogleTasksChanges, 300000);
  // Run first poll after 90 seconds (let server stabilize)
  setTimeout(pollGoogleTasksChanges, 90000);
  logger.info('[Google Tasks Poll] Bidirectional polling started (5min interval)');
};

const stopGoogleTasksPolling = () => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    logger.info('[Google Tasks Poll] Background polling stopped');
  }
};

module.exports = router;
module.exports.autoSyncTaskToGoogleTasks = autoSyncTaskToGoogleTasks;
module.exports.autoDeleteTaskFromGoogleTasks = autoDeleteTaskFromGoogleTasks;
module.exports.startGoogleTasksPolling = startGoogleTasksPolling;
module.exports.stopGoogleTasksPolling = stopGoogleTasksPolling;
