const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace } = require('../middleware/workspace');
const User = require('../models/User');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const WorkspaceMember = require('../models/WorkspaceMember');
const logger = require('../utils/logger');

const router = express.Router();

// Store io instance for webhook-triggered socket events
let calendarIo = null;

// Google OAuth2 configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://perun-crm-api.onrender.com/api/google-calendar/callback';

// Webhook verification secret (used as x-goog-channel-token)
const WEBHOOK_TOKEN_SECRET = process.env.GOOGLE_WEBHOOK_SECRET || process.env.JWT_SECRET || GOOGLE_CLIENT_SECRET || 'prplcrm-webhook-fallback';

/**
 * Create a fresh OAuth2Client for each request.
 * CRITICAL: Must NOT be a module-level singleton — credentials on a shared client
 * race across concurrent requests and can leak data between users.
 */
const createOAuth2Client = () => new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Scopes required for Google Calendar.
// - calendar.events: read/write events on user's calendars (kept — existing users have this)
// - calendar.app.created: allows our app to create its own secondary calendars ("Prpl CRM")
//   and manage them. This is the minimal "non-sensitive" scope for creating calendars,
//   so we don't need to re-verify the OAuth consent screen for a broader scope.
// Existing users who only have calendar.events will keep working — we just fall back to
// primary calendar if calendar creation fails.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.app.created'
];

// Marker attached to every event we create — lets us find OUR events in primary calendar
// later (for bulk cleanup) without needing to remember individual event IDs.
const EVENT_MARKER = { source: 'prplcrm' };

/**
 * Compute a deterministic HMAC token for a watch channel.
 * Used as x-goog-channel-token so we can verify webhook POSTs really came from Google.
 */
const computeWatchToken = (userId, channelId) => {
  return crypto
    .createHmac('sha256', WEBHOOK_TOKEN_SECRET)
    .update(`${userId}:${channelId}`)
    .digest('hex');
};

// Helper to get authenticated calendar client for user
const getCalendarClient = async (user, forceRefresh = false) => {
  if (!user.googleCalendar?.accessToken) {
    throw new Error('Google Calendar not connected');
  }

  // Check if we have a refresh token - this is critical for long-term access
  if (!user.googleCalendar.refreshToken) {
    logger.warn('[Google Calendar] No refresh token stored - user needs to reconnect', { userId: user._id });
    throw new Error('Google Calendar token expired. Please reconnect your account.');
  }

  // Per-request OAuth client — never share across requests
  const client = createOAuth2Client();
  client.setCredentials({
    access_token: user.googleCalendar.accessToken,
    refresh_token: user.googleCalendar.refreshToken,
    expiry_date: user.googleCalendar.tokenExpiry?.getTime()
  });

  // Check if token needs refresh (with 10 min buffer for safety)
  const now = new Date();
  const tokenExpiry = user.googleCalendar.tokenExpiry;
  const expiryBuffer = 10 * 60 * 1000; // 10 minutes buffer
  const needsRefresh = forceRefresh || !tokenExpiry || now.getTime() >= tokenExpiry.getTime() - expiryBuffer;

  if (needsRefresh) {
    logger.debug('[Google Calendar] Token refresh needed', {
      userId: user._id,
      forceRefresh
    });

    try {
      const { credentials } = await client.refreshAccessToken();
      user.googleCalendar.accessToken = credentials.access_token;
      user.googleCalendar.tokenExpiry = new Date(credentials.expiry_date);
      // Google sometimes returns a new refresh token - always save it
      if (credentials.refresh_token) {
        user.googleCalendar.refreshToken = credentials.refresh_token;
        logger.info('[Google Calendar] New refresh token received', { userId: user._id });
      }
      await user.save();
      client.setCredentials(credentials);
      logger.info('[Google Calendar] Token refreshed successfully', { userId: user._id });
    } catch (refreshError) {
      logger.error('[Google Calendar] Token refresh failed', {
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
        user.googleCalendar.accessToken = null;
        user.googleCalendar.refreshToken = null;
        user.googleCalendar.tokenExpiry = null;
        user.googleCalendar.enabled = false;
        await user.save();

        logger.warn('[Google Calendar] Credentials cleared due to invalid grant', { userId: user._id });
        throw new Error('Google Calendar token expired. Please reconnect your account.');
      }

      // For other errors, try to continue with existing token
      logger.warn('[Google Calendar] Continuing with existing token after refresh failure', { userId: user._id });
    }
  }

  return google.calendar({ version: 'v3', auth: client });
};

// Get Google Calendar authorization URL
router.get('/auth-url', authenticateToken, (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      logger.error('[Google Calendar] OAuth not configured');
      return res.status(503).json({ message: 'Google Calendar integrácia nie je nakonfigurovaná' });
    }

    const state = req.user.id.toString(); // Pass user ID in state for callback (must be string)
    logger.info('[Google Calendar] Generating auth URL', { userId: state });

    const client = createOAuth2Client();
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      state: state,
      prompt: 'consent' // Force consent to get refresh token
    });

    res.json({ authUrl });
  } catch (error) {
    logger.error('[Google Calendar] Error generating auth URL', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri generovaní autorizačného linku' });
  }
});

// OAuth callback - handle Google's response
router.get('/callback', async (req, res) => {
  const baseUrl = process.env.CLIENT_URL || 'https://prplcrm.eu';

  // NOTE: never log req.query verbatim — it contains the OAuth authorization `code`
  logger.info('[Google Calendar] Callback received', {
    hasCode: !!req.query.code,
    hasState: !!req.query.state
  });

  try {
    const { code, state: userId } = req.query;

    if (!code || !userId) {
      logger.warn('[Google Calendar] Callback missing parameters', { hasCode: !!code, hasUserId: !!userId });
      return res.redirect(`${baseUrl}/tasks?google_calendar=error&message=missing_params`);
    }

    // Exchange code for tokens — use fresh per-request client
    const client = createOAuth2Client();
    const { tokens } = await client.getToken(code);
    logger.debug('[Google Calendar] Tokens received', {
      userId,
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token
    });

    // Update user with Google Calendar credentials
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('[Google Calendar] User not found in callback', { userId });
      return res.redirect(`${baseUrl}/tasks?google_calendar=error&message=user_not_found`);
    }

    // IMPORTANT: Google only sends refresh_token on first authorization
    // or if we use prompt: 'consent'. Make sure we save it!
    if (!tokens.refresh_token) {
      logger.warn('[Google Calendar] No refresh token received! User may need to reconnect later.', { userId });
    }

    // Save tokens immediately with primary as initial calendar. We intentionally
    // do NOT block the redirect on dedicated-calendar creation — that can be slow
    // and mobile Safari / WebView give up if the callback takes too long.
    user.googleCalendar = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.googleCalendar?.refreshToken,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      calendarId: user.googleCalendar?.calendarId || 'primary',
      enabled: true,
      connectedAt: new Date(),
      lastSyncAt: null,
      syncedTaskIds: user.googleCalendar?.syncedTaskIds || new Map(),
      watchChannelId: user.googleCalendar?.watchChannelId || null,
      watchResourceId: user.googleCalendar?.watchResourceId || null,
      watchExpiry: user.googleCalendar?.watchExpiry || null,
      syncToken: user.googleCalendar?.syncToken || null
    };

    await user.save();
    logger.info('[Google Calendar] User connected successfully', {
      userId,
      username: user.username,
      hasRefreshToken: !!user.googleCalendar.refreshToken,
      calendarId: user.googleCalendar.calendarId
    });

    // Fire-and-forget: redirect NOW, do the rest in the background so the user
    // returns to the app immediately and sees the success toast.
    res.redirect(`${baseUrl}/tasks?google_calendar=connected`);

    // Background: try to create dedicated "Prpl CRM" calendar + start watch.
    // Any failure here is non-fatal — user already sees "connected" and primary
    // calendar sync works regardless.
    setImmediate(async () => {
      try {
        client.setCredentials(tokens);
        const cal = google.calendar({ version: 'v3', auth: client });

        // Only try to create a dedicated calendar if we're currently on primary
        // (skip for users who already have one, including this just-reconnected user)
        if (user.googleCalendar.calendarId === 'primary') {
          try {
            // Look for an existing "Prpl CRM" calendar
            const listResp = await cal.calendarList.list({ maxResults: 250 });
            const existing = (listResp.data.items || []).find(c => c.summary === 'Prpl CRM');

            let finalCalendarId = null;
            if (existing) {
              finalCalendarId = existing.id;
              logger.info('[Google Calendar] Found existing dedicated calendar (bg)', { userId, calendarId: finalCalendarId });
            } else {
              const created = await cal.calendars.insert({
                resource: {
                  summary: 'Prpl CRM',
                  description: 'Synchronizované úlohy z Prpl CRM. Môžete tento kalendár kedykoľvek vymazať.',
                  timeZone: 'Europe/Bratislava'
                }
              });
              finalCalendarId = created.data.id;
              logger.info('[Google Calendar] Created dedicated calendar (bg)', { userId, calendarId: finalCalendarId });

              try {
                await cal.calendarList.patch({
                  calendarId: finalCalendarId,
                  resource: { colorId: '3' }
                });
              } catch (colorErr) {
                logger.debug('[Google Calendar] Could not set calendar color (bg)', { error: colorErr.message });
              }
            }

            if (finalCalendarId && finalCalendarId !== 'primary') {
              // Update user atomically — don't blow away concurrent changes
              await User.findByIdAndUpdate(userId, {
                $set: {
                  'googleCalendar.calendarId': finalCalendarId,
                  'googleCalendar.syncedTaskIds': {}, // reset — old IDs point to primary
                  'googleCalendar.watchChannelId': null,
                  'googleCalendar.watchResourceId': null,
                  'googleCalendar.watchExpiry': null,
                  'googleCalendar.syncToken': null
                }
              });
            }
          } catch (dedErr) {
            logger.warn('[Google Calendar] Dedicated calendar setup skipped (bg)', {
              userId,
              error: dedErr.message,
              code: dedErr.code
            });
          }
        }

        // Set up push watch so Google → CRM live sync works
        const freshUser = await User.findById(userId);
        if (freshUser) {
          await startCalendarWatch(freshUser).catch(err =>
            logger.warn('[Google Calendar] Watch setup failed on connect (bg)', { error: err.message })
          );
        }
      } catch (bgErr) {
        logger.warn('[Google Calendar] Post-connect background task failed', {
          userId,
          error: bgErr.message
        });
      }
    });
  } catch (error) {
    logger.error('[Google Calendar] Callback error', { error: error.message });
    res.redirect(`${baseUrl}/tasks?google_calendar=error&message=` + encodeURIComponent(error.message));
  }
});

// Helper: count synced/pending tasks for Calendar (only tasks with dueDate are eligible)
function countCalendarSubtasks(subtasks, syncedMap) {
  let total = 0;
  let synced = 0;
  if (!subtasks || !Array.isArray(subtasks)) return { total, synced };
  for (const sub of subtasks) {
    if (!sub.completed && sub.dueDate) {
      total++;
      const eventId = syncedMap?.get(sub.id);
      if (eventId && typeof eventId === 'string' && eventId.length > 0) synced++;
    }
    if (sub.subtasks && sub.subtasks.length > 0) {
      const childCounts = countCalendarSubtasks(sub.subtasks, syncedMap);
      total += childCounts.total;
      synced += childCounts.synced;
    }
  }
  return { total, synced };
}

// Get connection status (also reports how many tasks are synced vs pending)
// NOTE: we do NOT use requireWorkspace here — workspace is optional. If the user
// hasn't picked one yet we still want the connection state to render.
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    }

    let totalTasks = 0;
    let syncedCount = 0;

    if (user.googleCalendar?.enabled) {
      // Read workspace id from header (client-authoritative) or fall back to user default.
      const headerWs = req.headers['x-workspace-id'];
      const workspaceId = (headerWs && typeof headerWs === 'string' && mongoose.Types.ObjectId.isValid(headerWs))
        ? headerWs
        : user.currentWorkspaceId;
      const userId = req.user.id.toString();
      const syncedMap = user.googleCalendar.syncedTaskIds;

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

      for (const task of globalTasks) {
        if (!isUserTask(task)) continue;
        if (task.dueDate) {
          totalTasks++;
          const eventId = syncedMap?.get(task._id.toString());
          if (eventId && typeof eventId === 'string' && eventId.length > 0) syncedCount++;
        }
        if (task.subtasks) {
          const c = countCalendarSubtasks(task.subtasks, syncedMap);
          totalTasks += c.total;
          syncedCount += c.synced;
        }
      }

      for (const contact of contacts) {
        if (contact.tasks) {
          for (const task of contact.tasks) {
            if (task.completed || !isUserTask(task)) continue;
            if (task.dueDate) {
              totalTasks++;
              const eventId = syncedMap?.get(task.id);
              if (eventId && typeof eventId === 'string' && eventId.length > 0) syncedCount++;
            }
            if (task.subtasks) {
              const c = countCalendarSubtasks(task.subtasks, syncedMap);
              totalTasks += c.total;
              syncedCount += c.synced;
            }
          }
        }
      }
    }

    const pendingCount = totalTasks - syncedCount;

    const calId = user.googleCalendar?.calendarId || 'primary';
    res.json({
      connected: user.googleCalendar?.enabled || false,
      connectedAt: user.googleCalendar?.connectedAt || null,
      lastSyncAt: user.googleCalendar?.lastSyncAt || null,
      isDedicatedCalendar: calId !== 'primary',
      pendingTasks: {
        total: totalTasks,
        synced: syncedCount,
        pending: pendingCount
      }
    });
  } catch (error) {
    logger.error('[Google Calendar] Error getting status', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri získavaní stavu' });
  }
});

// Disconnect Google Calendar
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    // Revoke token if possible (fire-and-forget with 3s timeout so disconnect never blocks)
    if (user.googleCalendar?.accessToken) {
      const client = createOAuth2Client();
      const tokenToRevoke = user.googleCalendar.accessToken;
      Promise.race([
        client.revokeToken(tokenToRevoke),
        new Promise((_, reject) => setTimeout(() => reject(new Error('revoke timeout')), 3000))
      ]).catch((e) => {
        logger.debug('[Google Calendar] Token revocation skipped', { error: e.message });
      });
    }

    // Stop watching for changes (best-effort)
    try {
      await stopCalendarWatch(user);
    } catch (e) {
      logger.debug('[Google Calendar] stopCalendarWatch error', { error: e.message });
    }

    user.googleCalendar = {
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
      calendarId: 'primary',
      enabled: false,
      connectedAt: null,
      syncedTaskIds: new Map(),
      watchChannelId: null,
      watchResourceId: null,
      watchExpiry: null,
      syncToken: null
    };

    await user.save();
    logger.info('[Google Calendar] Disconnected', { userId: req.user.id, username: user.username });

    res.json({ success: true, message: 'Google Calendar bol odpojený' });
  } catch (error) {
    logger.error('[Google Calendar] Disconnect error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri odpájaní' });
  }
});

// ==================== WEBHOOK (Google → CRM) ====================

const WEBHOOK_BASE_URL = process.env.API_BASE_URL || 'https://perun-crm-api.onrender.com';
const WATCH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (Google max)

/**
 * Start watching a user's Google Calendar for changes.
 * Creates a push notification channel so Google sends us a POST when events change.
 * We include a signed token so incoming webhook POSTs can be verified (HMAC of userId+channelId).
 */
const startCalendarWatch = async (user) => {
  try {
    const calendar = await getCalendarClient(user);
    const channelId = uuidv4();
    const channelToken = computeWatchToken(user._id.toString(), channelId);

    const res = await calendar.events.watch({
      calendarId: user.googleCalendar.calendarId || 'primary',
      resource: {
        id: channelId,
        type: 'web_hook',
        address: `${WEBHOOK_BASE_URL}/api/google-calendar/webhook`,
        token: channelToken,
        expiration: String(Date.now() + WATCH_EXPIRY_MS)
      }
    });

    user.googleCalendar.watchChannelId = channelId;
    user.googleCalendar.watchResourceId = res.data.resourceId;
    user.googleCalendar.watchExpiry = new Date(Number(res.data.expiration));
    await user.save();

    logger.info('[Calendar Watch] Channel created', {
      userId: user._id,
      channelId,
      expiry: user.googleCalendar.watchExpiry
    });
    return true;
  } catch (err) {
    logger.error('[Calendar Watch] Failed to create channel', {
      userId: user._id,
      error: err.message
    });
    return false;
  }
};

/**
 * Stop watching a user's calendar (cleanup old channel).
 */
const stopCalendarWatch = async (user) => {
  if (!user.googleCalendar.watchChannelId || !user.googleCalendar.watchResourceId) return;

  try {
    const calendar = await getCalendarClient(user);
    await calendar.channels.stop({
      resource: {
        id: user.googleCalendar.watchChannelId,
        resourceId: user.googleCalendar.watchResourceId
      }
    });
    logger.info('[Calendar Watch] Channel stopped', { userId: user._id });
  } catch (err) {
    // 404 = already expired/stopped, that's fine
    if (err.code !== 404) {
      logger.warn('[Calendar Watch] Error stopping channel', { error: err.message });
    }
  }

  user.googleCalendar.watchChannelId = null;
  user.googleCalendar.watchResourceId = null;
  user.googleCalendar.watchExpiry = null;
};

/**
 * Process calendar changes for a user using incremental sync (syncToken).
 * Called when Google sends us a push notification.
 */
const processCalendarChanges = async (user) => {
  try {
    const calendar = await getCalendarClient(user);
    const calendarId = user.googleCalendar.calendarId || 'primary';

    let params = { calendarId, singleEvents: true, maxResults: 250 };
    if (user.googleCalendar.syncToken) {
      params.syncToken = user.googleCalendar.syncToken;
    } else {
      // First sync: get events from last 30 days to establish token
      params.timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    }

    let allEvents = [];
    let nextPageToken = null;
    let newSyncToken = null;

    do {
      if (nextPageToken) params.pageToken = nextPageToken;

      let response;
      try {
        response = await calendar.events.list(params);
      } catch (err) {
        // 410 Gone = syncToken expired, do full re-sync
        if (err.code === 410) {
          logger.info('[Calendar Webhook] SyncToken expired, doing full re-sync', { userId: user._id });
          user.googleCalendar.syncToken = null;
          await user.save();
          return processCalendarChanges(user); // recursive call without syncToken
        }
        throw err;
      }

      allEvents.push(...(response.data.items || []));
      nextPageToken = response.data.nextPageToken;
      newSyncToken = response.data.nextSyncToken;
    } while (nextPageToken);

    // Save new sync token
    if (newSyncToken) {
      user.googleCalendar.syncToken = newSyncToken;
      await user.save();
    }

    if (allEvents.length === 0) return;

    logger.info('[Calendar Webhook] Processing changes', {
      userId: user._id,
      eventCount: allEvents.length
    });

    // Build reverse map: googleEventId → crmTaskId
    const reverseMap = new Map();
    if (user.googleCalendar.syncedTaskIds) {
      for (const [crmId, googleId] of user.googleCalendar.syncedTaskIds.entries()) {
        reverseMap.set(googleId, crmId);
      }
    }

    let updated = 0;
    // Get workspace IDs where this user is a member (for scoped lookup)
    const memberships = await WorkspaceMember.find({ userId: user._id }, 'workspaceId').lean();
    const userWorkspaceIds = memberships.map(m => m.workspaceId);

    for (const event of allEvents) {
      const crmTaskId = reverseMap.get(event.id);
      if (!crmTaskId) continue; // Not a CRM-synced event

      // Determine what changed
      const isDeleted = event.status === 'cancelled';
      const newDueDate = event.start?.date || (event.start?.dateTime ? event.start.dateTime.split('T')[0] : null);
      // Strip the completion prefix "✓ " from event title to get clean title
      let newTitle = (event.summary || '').replace(/^✓\s*/, '').trim();

      // Find the CRM task — scoped to user's workspaces
      let task = await Task.findOne({ _id: crmTaskId, workspaceId: { $in: userWorkspaceIds } });
      let contact = null;
      let taskIndex = -1;

      if (!task) {
        // Search in contacts within user's workspaces
        contact = await Contact.findOne({ 'tasks.id': crmTaskId, workspaceId: { $in: userWorkspaceIds } });
        if (contact) {
          taskIndex = contact.tasks.findIndex(t => t.id === crmTaskId);
          if (taskIndex !== -1) task = contact.tasks[taskIndex];
        }
      }

      if (!task) continue; // Task no longer exists in CRM or not in user's workspace

      if (isDeleted) {
        // Event was deleted in Google Calendar — remove mapping atomically
        await User.findByIdAndUpdate(user._id, {
          $unset: { [`googleCalendar.syncedTaskIds.${crmTaskId}`]: '' }
        });
        continue;
      }

      // Check if due date changed
      let changed = false;
      const taskDueDate = task.dueDate ? new Date(task.dueDate).toISOString().split('T')[0] : null;

      if (newDueDate && newDueDate !== taskDueDate) {
        if (contact && taskIndex !== -1) {
          contact.tasks[taskIndex].dueDate = new Date(newDueDate);
          contact.tasks[taskIndex].modifiedAt = new Date().toISOString();
          changed = true;
        } else if (task._id) {
          task.dueDate = new Date(newDueDate);
          task.modifiedAt = new Date().toISOString();
          changed = true;
        }
      }

      // Check if title changed
      if (newTitle && newTitle !== task.title) {
        if (contact && taskIndex !== -1) {
          contact.tasks[taskIndex].title = newTitle;
          contact.tasks[taskIndex].modifiedAt = new Date().toISOString();
          changed = true;
        } else if (task._id) {
          task.title = newTitle;
          task.modifiedAt = new Date().toISOString();
          changed = true;
        }
      }

      if (changed) {
        if (contact) {
          contact.markModified('tasks');
          await contact.save();
          if (calendarIo && contact.workspaceId) {
            calendarIo.to(`workspace-${contact.workspaceId}`).emit('contact-updated', contact.toObject());
          }
        } else {
          await task.save();
          if (calendarIo && task.workspaceId) {
            calendarIo.to(`workspace-${task.workspaceId}`).emit('task-updated', {
              ...task.toObject(),
              id: task._id.toString(),
              source: 'global'
            });
          }
        }
        updated++;
      }
    }

    if (updated > 0) {
      logger.info('[Calendar Webhook] Applied changes to CRM', { userId: user._id, updated });
    }
  } catch (err) {
    logger.error('[Calendar Webhook] Error processing changes', {
      userId: user._id,
      error: err.message
    });
  }
};

/**
 * Webhook endpoint — Google POSTs here when calendar events change.
 * No auth needed (Google sends channel ID headers for verification).
 */
router.post('/webhook', async (req, res) => {
  // Respond 200 immediately — Google requires fast response
  res.status(200).end();

  const channelId = req.headers['x-goog-channel-id'];
  const channelToken = req.headers['x-goog-channel-token'];
  const resourceState = req.headers['x-goog-resource-state'];

  if (!channelId) return;

  // 'sync' = initial confirmation, 'exists' = changes available
  if (resourceState === 'sync') {
    logger.debug('[Calendar Webhook] Sync confirmation received', { channelId });
    return;
  }

  if (resourceState !== 'exists') return;

  try {
    // Find user by watch channel ID
    const user = await User.findOne({ 'googleCalendar.watchChannelId': channelId });
    if (!user) {
      logger.warn('[Calendar Webhook] No user found for channel', { channelId });
      return;
    }

    // Verify HMAC token so random attackers can't trigger sync for arbitrary users
    const expectedToken = computeWatchToken(user._id.toString(), channelId);
    if (!channelToken) {
      logger.warn('[Calendar Webhook] Missing channel token', { channelId, userId: user._id });
      return;
    }
    // Use timingSafeEqual to prevent timing attacks
    const a = Buffer.from(channelToken);
    const b = Buffer.from(expectedToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      logger.warn('[Calendar Webhook] Invalid channel token', { channelId, userId: user._id });
      return;
    }

    await processCalendarChanges(user);
  } catch (err) {
    logger.error('[Calendar Webhook] Error', { error: err.message, channelId });
  }
});

/**
 * Renew all expiring watch channels.
 * Should be called periodically (e.g., every 6 hours via cron or setInterval).
 */
const renewCalendarWatches = async () => {
  try {
    // Find users whose watch expires in the next 24 hours
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const users = await User.find({
      'googleCalendar.enabled': true,
      'googleCalendar.watchExpiry': { $lt: soon, $ne: null }
    });

    for (const user of users) {
      await stopCalendarWatch(user);
      await startCalendarWatch(user);
    }

    if (users.length > 0) {
      logger.info('[Calendar Watch] Renewed channels', { count: users.length });
    }
  } catch (err) {
    logger.error('[Calendar Watch] Renewal error', { error: err.message });
  }
};

// Also set up watch for users who don't have one yet
const ensureCalendarWatches = async () => {
  try {
    const users = await User.find({
      'googleCalendar.enabled': true,
      $or: [
        { 'googleCalendar.watchChannelId': null },
        { 'googleCalendar.watchChannelId': { $exists: false } }
      ]
    });

    for (const user of users) {
      await startCalendarWatch(user);
    }

    if (users.length > 0) {
      logger.info('[Calendar Watch] Set up new watches', { count: users.length });
    }
  } catch (err) {
    logger.error('[Calendar Watch] Setup error', { error: err.message });
  }
};

// ==================== SYNC ROUTES ====================

// Sync all tasks to Google Calendar
router.post('/sync', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }

    const calendar = await getCalendarClient(user);

    // Get tasks for the workspace from which the sync was triggered
    const workspaceId = req.workspaceId || user.currentWorkspaceId;
    const globalTasks = workspaceId ? await Task.find({ workspaceId }) : [];
    const contacts = workspaceId ? await Contact.find({ workspaceId }) : [];

    const tasksToSync = [];

    logger.debug('[Google Calendar] Sync starting', {
      userId: user._id,
      globalTaskCount: globalTasks.length,
      contactCount: contacts.length
    });

    // Collect global tasks
    for (const task of globalTasks) {
      if (task.dueDate) {
        tasksToSync.push({
          id: task._id.toString(),
          title: task.title,
          description: task.description || '',
          dueDate: task.dueDate,
          completed: task.completed,
          priority: task.priority,
          contact: null
        });
      }
      // Collect subtasks
      collectSubtasksForSync(task.subtasks, task.title, null, tasksToSync);
    }

    // Collect contact tasks
    for (const contact of contacts) {
      if (contact.tasks) {
        for (const task of contact.tasks) {
          if (task.dueDate) {
            tasksToSync.push({
              id: task.id,
              title: task.title,
              description: task.description || '',
              dueDate: task.dueDate,
              completed: task.completed,
              priority: task.priority,
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

    logger.info('[Google Calendar] Syncing tasks', { userId: user._id, count: tasksToSync.length });

    for (const task of tasksToSync) {
      try {
        const existingEventId = user.googleCalendar.syncedTaskIds?.get(task.id);
        const eventData = createEventData(task);

        if (existingEventId) {
          // Update existing event
          await calendar.events.update({
            calendarId: user.googleCalendar.calendarId,
            eventId: existingEventId,
            resource: eventData
          });
          updated++;
        } else {
          // Create new event
          const event = await calendar.events.insert({
            calendarId: user.googleCalendar.calendarId,
            resource: eventData
          });
          user.googleCalendar.syncedTaskIds.set(task.id, event.data.id);
          synced++;
        }
      } catch (error) {
        logger.warn('[Google Calendar] Task sync error', {
          userId: user._id,
          taskId: task.id,
          error: error.message
        });
        errors++;
      }
    }

    user.googleCalendar.lastSyncAt = new Date();
    await user.save();

    logger.info('[Google Calendar] Sync finished', { userId: user._id, synced, updated, errors });

    res.json({
      success: true,
      message: `Synchronizované: ${synced} nových, ${updated} aktualizovaných, ${errors} chýb`,
      synced,
      updated,
      errors
    });
  } catch (error) {
    logger.error('[Google Calendar] Sync error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri synchronizácii: ' + error.message });
  }
});

// Sync single task to Google Calendar
router.post('/sync-task/:taskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { taskId } = req.params;
    const user = await User.findById(req.user.id);
    const workspaceId = req.workspaceId || user.currentWorkspaceId;

    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }

    const calendar = await getCalendarClient(user);

    // Find task (could be global or contact task) — scoped to workspace
    let task = await Task.findOne({ _id: taskId, workspaceId });
    let contactName = null;

    if (!task) {
      // Search in contacts within workspace only
      const contacts = await Contact.find({ workspaceId });
      for (const contact of contacts) {
        const found = contact.tasks?.find(t => t.id === taskId);
        if (found) {
          task = found;
          contactName = contact.name;
          break;
        }
        // Check subtasks recursively
        const foundSubtask = findSubtaskById(contact.tasks, taskId);
        if (foundSubtask) {
          task = foundSubtask;
          contactName = contact.name;
          break;
        }
      }
    }

    if (!task) {
      return res.status(404).json({ message: 'Úloha nebola nájdená' });
    }

    if (!task.dueDate) {
      return res.status(400).json({ message: 'Úloha nemá nastavený termín' });
    }

    const taskData = {
      id: task._id?.toString() || task.id,
      title: task.title,
      description: task.description || '',
      dueDate: task.dueDate,
      completed: task.completed,
      priority: task.priority,
      contact: contactName
    };

    const existingEventId = user.googleCalendar.syncedTaskIds?.get(taskData.id);
    const eventData = createEventData(taskData);

    if (existingEventId) {
      await calendar.events.update({
        calendarId: user.googleCalendar.calendarId,
        eventId: existingEventId,
        resource: eventData
      });
    } else {
      const event = await calendar.events.insert({
        calendarId: user.googleCalendar.calendarId,
        resource: eventData
      });
      user.googleCalendar.syncedTaskIds.set(taskData.id, event.data.id);
      await user.save();
    }

    res.json({ success: true, message: 'Úloha bola synchronizovaná' });
  } catch (error) {
    logger.error('[Google Calendar] Single task sync error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri synchronizácii: ' + error.message });
  }
});

// Delete event from Google Calendar when task is deleted
router.delete('/event/:taskId', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const user = await User.findById(req.user.id);

    if (!user.googleCalendar?.enabled) {
      return res.json({ success: true, message: 'Google Calendar nie je pripojený' });
    }

    const eventId = user.googleCalendar.syncedTaskIds?.get(taskId);
    if (!eventId) {
      return res.json({ success: true, message: 'Udalosť nebola v kalendári' });
    }

    const calendar = await getCalendarClient(user);

    try {
      await calendar.events.delete({
        calendarId: user.googleCalendar.calendarId,
        eventId: eventId
      });
    } catch (e) {
      // 404 = already deleted, that's fine
      if (e.code !== 404) {
        logger.warn('[Google Calendar] Event deletion failed', { error: e.message, eventId });
      }
    }

    user.googleCalendar.syncedTaskIds.delete(taskId);
    await user.save();

    res.json({ success: true, message: 'Udalosť bola odstránená z kalendára' });
  } catch (error) {
    logger.error('[Google Calendar] Event delete error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri odstraňovaní: ' + error.message });
  }
});

// Clean up orphaned events (events in Google Calendar that no longer have corresponding tasks)
// Also cleans up old events from the past
router.post('/cleanup', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const workspaceId = req.workspaceId || user.currentWorkspaceId;

    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }

    const calendar = await getCalendarClient(user);

    // Get all current task IDs — scoped to workspace
    const globalTasks = await Task.find({ workspaceId });
    const contacts = await Contact.find({ workspaceId });

    const currentTaskIds = new Set();

    // Collect all current task IDs
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

    // First, clean up from syncedTaskIds map
    if (user.googleCalendar.syncedTaskIds) {
      const syncedTaskIds = Array.from(user.googleCalendar.syncedTaskIds.entries());
      logger.debug('[Google Calendar] Cleanup starting', {
        userId: user._id,
        mappedCount: syncedTaskIds.length
      });

      for (const [taskId, eventId] of syncedTaskIds) {
        if (!currentTaskIds.has(taskId)) {
          // Task no longer exists, delete the calendar event
          try {
            await calendar.events.delete({
              calendarId: user.googleCalendar.calendarId,
              eventId: eventId
            });
            deleted++;
          } catch (e) {
            if (e.code !== 404) {
              logger.warn('[Google Calendar] Cleanup delete failed', { eventId, error: e.message });
              errors++;
            }
          }
          user.googleCalendar.syncedTaskIds.delete(taskId);
        }
      }
    }

    await user.save();
    logger.info('[Google Calendar] Cleanup finished', { userId: user._id, deleted, errors });

    res.json({
      success: true,
      message: `Vyčistené: ${deleted} udalostí odstránených, ${errors} chýb`,
      deleted,
      errors
    });
  } catch (error) {
    logger.error('[Google Calendar] Cleanup error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri čistení: ' + error.message });
  }
});

/**
 * DELETE ALL — remove every Prpl CRM event from the user's Google Calendar.
 *
 * Two code paths depending on how the user is connected:
 *
 * 1. Dedicated "Prpl CRM" calendar (new connections): delete the whole calendar
 *    via calendars.delete(). One API call, instant, and the calendar disappears
 *    from the user's Google Calendar UI too — cleanest outcome.
 *
 * 2. Primary calendar (legacy connections): query events tagged with the
 *    source=prplcrm marker via privateExtendedProperty filter, union with the
 *    legacy syncedTaskIds mapping (for pre-marker events), batch delete all.
 *    Primary calendar itself is preserved (Google blocks deleting primary).
 *
 * Either way we clear syncedTaskIds + sync state so the next sync starts fresh.
 */
router.post('/delete-all', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }

    const calendar = await getCalendarClient(user);
    const calendarId = user.googleCalendar.calendarId || 'primary';
    const isDedicated = calendarId !== 'primary';

    let deleted = 0;
    let errors = 0;

    if (isDedicated) {
      // Path 1: nuke the whole dedicated calendar
      try {
        await calendar.calendars.delete({ calendarId });
        logger.info('[Google Calendar] Dedicated calendar deleted', { userId: user._id, calendarId });
        deleted = 1; // "1 calendar" — exact event count is unknown after delete
      } catch (e) {
        if (e.code === 404) {
          // Already gone, treat as success
          logger.info('[Google Calendar] Dedicated calendar already gone', { userId: user._id, calendarId });
        } else {
          logger.error('[Google Calendar] Failed to delete dedicated calendar', { error: e.message, code: e.code });
          return res.status(500).json({ message: 'Nepodarilo sa vymazať kalendár: ' + e.message });
        }
      }
    } else {
      // Path 2: batch-delete events from primary
      // 2a — events with our source=prplcrm marker (preferred, new events)
      const markedEventIds = new Set();
      try {
        let pageToken;
        do {
          const resp = await calendar.events.list({
            calendarId: 'primary',
            privateExtendedProperty: 'source=prplcrm',
            maxResults: 2500,
            showDeleted: false,
            singleEvents: true,
            pageToken
          });
          for (const ev of (resp.data.items || [])) {
            if (ev.id) markedEventIds.add(ev.id);
          }
          pageToken = resp.data.nextPageToken;
        } while (pageToken);
      } catch (e) {
        logger.warn('[Google Calendar] Marker query failed, relying on syncedTaskIds only', { error: e.message });
      }

      // 2b — union with legacy mapping (covers events created before the marker existed)
      const legacyIds = Array.from(user.googleCalendar.syncedTaskIds?.values() || []);
      for (const id of legacyIds) markedEventIds.add(id);

      const allIds = Array.from(markedEventIds);
      logger.info('[Google Calendar] Bulk delete starting', {
        userId: user._id,
        totalEvents: allIds.length
      });

      for (const eventId of allIds) {
        try {
          await calendar.events.delete({ calendarId: 'primary', eventId });
          deleted++;
        } catch (e) {
          if (e.code === 404 || e.code === 410) {
            // Already deleted, not an error
          } else {
            errors++;
            logger.warn('[Google Calendar] Bulk delete event failed', { eventId, error: e.message });
          }
        }
      }

      logger.info('[Google Calendar] Bulk delete finished', { userId: user._id, deleted, errors });
    }

    // Reset sync state regardless of path — fresh slate
    user.googleCalendar.syncedTaskIds = new Map();
    user.googleCalendar.watchChannelId = null;
    user.googleCalendar.watchResourceId = null;
    user.googleCalendar.watchExpiry = null;
    user.googleCalendar.syncToken = null;
    user.googleCalendar.lastSyncAt = null;
    // For dedicated-calendar users: flip back to 'primary' so next sync doesn't
    // try to write into a calendar that no longer exists. User can reconnect to
    // recreate a dedicated calendar.
    if (isDedicated) user.googleCalendar.calendarId = 'primary';
    await user.save();

    return res.json({
      success: true,
      mode: isDedicated ? 'dedicated' : 'primary',
      deleted,
      errors,
      message: isDedicated
        ? 'Kalendár "Prpl CRM" bol vymazaný z Google Calendar.'
        : `Vymazaných ${deleted} udalostí z Google Calendar${errors ? ` (${errors} chýb)` : ''}.`
    });
  } catch (error) {
    logger.error('[Google Calendar] Delete-all error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri mazaní: ' + error.message });
  }
});

// Helper functions
function collectSubtasksForSync(subtasks, parentTitle, contactName, tasksToSync) {
  if (!subtasks) return;
  for (const subtask of subtasks) {
    if (subtask.dueDate) {
      tasksToSync.push({
        id: subtask.id,
        title: `${subtask.title} (${parentTitle})`,
        description: subtask.notes || '',
        dueDate: subtask.dueDate,
        completed: subtask.completed,
        priority: null,
        contact: contactName
      });
    }
    if (subtask.subtasks) {
      collectSubtasksForSync(subtask.subtasks, parentTitle, contactName, tasksToSync);
    }
  }
}

function findSubtaskById(tasks, subtaskId) {
  if (!tasks) return null;
  for (const task of tasks) {
    if (task.subtasks) {
      const found = findSubtaskRecursive(task.subtasks, subtaskId);
      if (found) return found;
    }
  }
  return null;
}

function findSubtaskRecursive(subtasks, subtaskId) {
  if (!subtasks) return null;
  for (const subtask of subtasks) {
    if (subtask.id === subtaskId) return subtask;
    if (subtask.subtasks) {
      const found = findSubtaskRecursive(subtask.subtasks, subtaskId);
      if (found) return found;
    }
  }
  return null;
}

function createEventData(task) {
  let dueDate;
  try {
    dueDate = new Date(task.dueDate);
    if (isNaN(dueDate.getTime())) {
      logger.warn('[Google Calendar] Invalid dueDate', { taskId: task.id, dueDate: task.dueDate });
      dueDate = new Date(); // fallback to today
    }
  } catch (e) {
    logger.warn('[Google Calendar] Failed to parse dueDate', { taskId: task.id, dueDate: task.dueDate });
    dueDate = new Date();
  }
  const nextDay = new Date(dueDate);
  nextDay.setDate(nextDay.getDate() + 1);

  // Format dates as YYYY-MM-DD
  const startDate = dueDate.toISOString().split('T')[0];
  const endDate = nextDay.toISOString().split('T')[0];

  // Google Calendar limits: summary 1024 chars, description 8192 chars
  let title = (task.title || '').substring(0, 1024);
  let description = (task.description || '').substring(0, 8000);
  if (task.contact) {
    description += description ? '\n\n' : '';
    description += `Kontakt: ${task.contact}`;
  }
  if (task.completed) {
    description += description ? '\n' : '';
    description += '✓ DOKONČENÉ';
  }

  const colorId = task.priority === 'high' ? '11' : // Red
                  task.priority === 'low' ? '8' :   // Gray
                  '9'; // Blue (medium/default)

  return {
    summary: (task.completed ? '✓ ' : '') + title,
    description: description,
    start: {
      date: startDate,
      timeZone: 'Europe/Bratislava'
    },
    end: {
      date: endDate,
      timeZone: 'Europe/Bratislava'
    },
    colorId: colorId,
    transparency: 'transparent', // Don't block time
    status: task.completed ? 'cancelled' : 'confirmed',
    // Marker so we can find our events later (bulk delete in primary calendar use-case)
    extendedProperties: { private: { ...EVENT_MARKER } }
  };
}

// ==================== AUTO-SYNC HELPER FUNCTIONS ====================

/**
 * Automatically sync a task to Google Calendar for all users who have Google Calendar connected
 * @param {Object} taskData - Task data including id, title, description, dueDate, completed, priority, contact
 * @param {string} action - 'create', 'update', or 'delete'
 */
const autoSyncTaskToCalendar = async (taskData, action) => {
  try {
    // Skip if task has no due date (for create/update)
    if (action !== 'delete' && !taskData.dueDate) {
      logger.debug('[Auto-sync Calendar] Task has no due date, skipping');
      return;
    }

    // Normalize taskId - handle various formats (ObjectId, string, nested object)
    let taskId = taskData.id || taskData._id;
    if (taskId && typeof taskId === 'object' && taskId.toString) {
      taskId = taskId.toString();
    }

    // Validate taskId
    if (!taskId) {
      logger.warn('[Auto-sync Calendar] Missing task ID');
      return;
    }

    // Determine workspace scope — only sync for members of the task's workspace
    const workspaceId = taskData.workspaceId?.toString();
    // Find users with Google Calendar enabled — filtered by workspace membership
    let users;
    if (workspaceId) {
      const members = await WorkspaceMember.find({ workspaceId }, 'userId').lean();
      const memberUserIds = members.map(m => m.userId);
      users = await User.find({ _id: { $in: memberUserIds }, 'googleCalendar.enabled': true });
    } else {
      // Fallback: no workspace context
      users = await User.find({ 'googleCalendar.enabled': true });
    }

    // Filter by assignedTo: if task is assigned, only sync for assigned users
    const assignedTo = (taskData.assignedTo || []).map(id => id?.toString()).filter(Boolean);
    if (assignedTo.length > 0) {
      users = users.filter(u => assignedTo.includes(u._id.toString()));
    }

    if (users.length === 0) {
      return;
    }

    for (const user of users) {
      try {
        const calendar = await getCalendarClient(user);
        logger.debug('[Auto-sync Calendar] Processing', {
          userId: user._id,
          mappedCount: user.googleCalendar.syncedTaskIds?.size || 0
        });

        if (action === 'delete') {
          // Delete event from calendar
          const eventId = user.googleCalendar.syncedTaskIds?.get(taskId);
          if (eventId) {
            try {
              await calendar.events.delete({
                calendarId: user.googleCalendar.calendarId,
                eventId: eventId
              });
            } catch (e) {
              // 404 is OK - event already deleted
              if (e.code !== 404) {
                logger.warn('[Auto-sync Calendar] Event deletion failed', { error: e.message });
              }
            }
            // Atomic removal of mapping
            await User.findByIdAndUpdate(user._id, {
              $unset: { [`googleCalendar.syncedTaskIds.${taskId}`]: '' }
            });
          }
        } else {
          // Create or update event
          const eventData = createEventData({
            id: taskId,
            title: taskData.title,
            description: taskData.description || '',
            dueDate: taskData.dueDate,
            completed: taskData.completed,
            priority: taskData.priority,
            contact: taskData.contactName || taskData.contact || null
          });

          const existingEventId = user.googleCalendar.syncedTaskIds?.get(taskId);

          if (existingEventId) {
            // Update existing event
            try {
              await calendar.events.update({
                calendarId: user.googleCalendar.calendarId,
                eventId: existingEventId,
                resource: eventData
              });
            } catch (e) {
              // If event doesn't exist, create new one
              if (e.code === 404) {
                const event = await calendar.events.insert({
                  calendarId: user.googleCalendar.calendarId,
                  resource: eventData
                });
                // Atomic set of new mapping
                await User.findByIdAndUpdate(user._id, {
                  $set: { [`googleCalendar.syncedTaskIds.${taskId}`]: event.data.id }
                });
              } else {
                throw e;
              }
            }
          } else {
            // Create new event
            const event = await calendar.events.insert({
              calendarId: user.googleCalendar.calendarId,
              resource: eventData
            });
            // Atomic set of new mapping
            await User.findByIdAndUpdate(user._id, {
              $set: { [`googleCalendar.syncedTaskIds.${taskId}`]: event.data.id }
            });
          }
        }
      } catch (error) {
        // Check if this is a token expired error
        if (error.message?.includes('token expired') || error.message?.includes('reconnect')) {
          logger.warn('[Auto-sync Calendar] Token expired for user, skipping', { userId: user._id });
        } else {
          logger.error('[Auto-sync Calendar] Error syncing for user', { userId: user._id, error: error.message });
        }
      }
    }
  } catch (error) {
    logger.error('[Auto-sync Calendar] Error in autoSyncTaskToCalendar', { error: error.message });
  }
};

/**
 * Delete event from Google Calendar when task is removed
 * @param {string} taskId - ID of the task being deleted
 */
const autoDeleteTaskFromCalendar = async (taskId) => {
  await autoSyncTaskToCalendar({ id: taskId }, 'delete');
};

/**
 * Initialize Calendar webhook system with Socket.IO and start periodic renewal.
 */
const initializeCalendarWebhooks = (io) => {
  calendarIo = io;

  // Set up watches for all connected users who don't have one
  setTimeout(() => ensureCalendarWatches(), 20000);

  // Renew expiring watches every 6 hours
  setInterval(() => renewCalendarWatches(), 6 * 60 * 60 * 1000);

  logger.info('[Calendar Watch] Webhook system initialized');
};

module.exports = router;
module.exports.autoSyncTaskToCalendar = autoSyncTaskToCalendar;
module.exports.autoDeleteTaskFromCalendar = autoDeleteTaskFromCalendar;
module.exports.initializeCalendarWebhooks = initializeCalendarWebhooks;
