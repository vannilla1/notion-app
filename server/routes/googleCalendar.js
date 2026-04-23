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
const Workspace = require('../models/Workspace');
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
//
// PR2+ per-workspace model needs the app to actually create secondary calendars
// ("Prpl CRM — {workspace}"). `calendar.app.created` is the intended minimal
// scope for this, BUT in practice it's unreliable across accounts:
//   - Unverified OAuth clients can't use it consistently
//   - Some Workspace-domain accounts block it by admin policy
//   - calendarList.list() can't see app-created calendars without the reader scope
// The result: calendars.insert() succeeds silently-nowhere or throws, and we
// fell back to writing into the user's primary calendar (which for some users
// has been renamed in Google UI — hence the "everything goes into
// Elektrické autá Michalovce" bug report).
//
// Switch to full `calendar` scope. It's "sensitive" per Google's classification
// so OAuth consent page will warn users, but it's the standard scope Google
// themselves recommend for apps that manage multiple calendars, and it removes
// all of the edge-case failures above.
//
// Kept `calendar.events` for backwards compat with tokens issued before this
// change — Google's OAuth returns the UNION of previously-granted scopes, so
// old users keep working even if they don't re-consent.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
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

    // Background: set up push watch so Google → CRM live sync works.
    //
    // Previously we ALSO created a dedicated "Prpl CRM" calendar here, but
    // PR2 introduced per-workspace calendars ("Prpl CRM — {workspace}") that
    // are created lazily on first sync. Keeping the OAuth-callback creation
    // was producing two overlapping calendars in the user's Google account:
    //   - "Prpl CRM"  (from this callback)
    //   - "Prpl CRM — Elektrické autá Michalovce"  (from per-workspace sync)
    // Removed the callback creation entirely. Per-workspace helper handles
    // everything. calendarId stays 'primary' in DB as the fallback — but
    // with the hardened helper in commit 683888e, primary is no longer
    // silently used; it's only returned for delete paths or explicit opt-in.
    setImmediate(async () => {
      try {
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

    // --- Cleanup BEFORE revoking token (token must still be valid here) ---
    //
    // User expectation: after "Odpojiť", no trace of Prpl CRM should remain
    // in their Google Calendar. Leaving stale events looks broken and
    // creates clutter when they re-connect and a second set of events syncs
    // on top.
    //
    // Two paths:
    //  1. Dedicated per-workspace / "Prpl CRM" secondary calendars
    //     → delete the whole calendar via calendars.delete(). Instant, clean,
    //     everything inside goes with it.
    //  2. Legacy fallback = primary calendar
    //     → primary can't be deleted; instead list events with our marker
    //     (extendedProperties.private.source=prplcrm) and batch delete them.
    //
    // Best-effort: if Google returns errors, we log and still proceed with
    // disconnect — user should not be stuck in a half-connected state just
    // because Google is flaky.
    let eventsDeleted = 0;
    let calendarsDeleted = 0;
    if (user.googleCalendar?.accessToken) {
      try {
        const calendar = await getCalendarClient(user);

        // Pass 1: delete calendars we explicitly manage.
        const dedicatedIds = new Set();
        if (user.googleCalendar.workspaceCalendars) {
          for (const [, entry] of user.googleCalendar.workspaceCalendars.entries()) {
            if (entry?.calendarId) dedicatedIds.add(entry.calendarId);
          }
        }
        const legacyCalId = user.googleCalendar.calendarId;
        const legacyIsDedicated = legacyCalId && legacyCalId !== 'primary';
        if (legacyIsDedicated) dedicatedIds.add(legacyCalId);

        // Pass 2: also delete any other calendar in the user's account whose
        // summary matches "Prpl CRM" or "Prpl CRM — …" — these are stragglers
        // from earlier versions of the app (the OAuth callback used to create
        // "Prpl CRM"; some testing left behind "Prpl CRM — workspace" calendars
        // we never tracked in workspaceCalendars). Without this pass, users
        // see 2+ copies of Prpl CRM calendars piling up in Google.
        try {
          const listResp = await calendar.calendarList.list({ maxResults: 250 });
          for (const item of (listResp.data.items || [])) {
            const s = item.summary || '';
            if (s === 'Prpl CRM' || s.startsWith('Prpl CRM —') || s.startsWith('Prpl CRM -')) {
              if (item.id) dedicatedIds.add(item.id);
            }
          }
        } catch (listErr) {
          logger.warn('[Google Calendar] Disconnect: calendarList scan failed', { error: listErr.message });
        }

        for (const calId of dedicatedIds) {
          try {
            await calendar.calendars.delete({ calendarId: calId });
            calendarsDeleted++;
          } catch (e) {
            if (e.code !== 404) {
              logger.warn('[Google Calendar] Disconnect: calendar delete failed', { calId, error: e.message });
            }
          }
        }

        // Pass 3: always scrub primary for our marker-tagged events. Even if
        // user is on a dedicated calendar now, they might have old events
        // from a time when sync hit primary (renamed primary bug). Safe —
        // only deletes events with extendedProperties.private.source=prplcrm.
        let pageToken;
        do {
          try {
            const { data } = await calendar.events.list({
              calendarId: 'primary',
              privateExtendedProperty: 'source=prplcrm',
              maxResults: 250,
              pageToken,
              showDeleted: false
            });
            for (const ev of (data.items || [])) {
              try {
                await calendar.events.delete({ calendarId: 'primary', eventId: ev.id });
                eventsDeleted++;
              } catch (e) {
                if (e.code !== 404) {
                  logger.debug('[Google Calendar] Disconnect: event delete failed', { eventId: ev.id, error: e.message });
                }
              }
            }
            pageToken = data.nextPageToken;
          } catch (listErr) {
            logger.warn('[Google Calendar] Disconnect: primary event list failed', { error: listErr.message });
            break;
          }
        } while (pageToken);
      } catch (cleanupErr) {
        // Don't block disconnect on cleanup failure — log and move on.
        logger.warn('[Google Calendar] Disconnect cleanup failed', { userId: req.user.id, error: cleanupErr.message });
      }
    }

    // Revoke token (fire-and-forget) — now that we've finished using it.
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
      workspaceCalendars: new Map(),
      enabled: false,
      connectedAt: null,
      syncedTaskIds: new Map(),
      syncedTaskCalendars: new Map(),
      watchChannelId: null,
      watchResourceId: null,
      watchExpiry: null,
      syncToken: null
    };

    await user.save();
    logger.info('[Google Calendar] Disconnected', {
      userId: req.user.id,
      username: user.username,
      calendarsDeleted,
      eventsDeleted
    });

    const cleanupSummary = calendarsDeleted + eventsDeleted > 0
      ? ` (odstránených ${calendarsDeleted} kalendárov, ${eventsDeleted} udalostí)`
      : '';
    res.json({ success: true, message: `Google Calendar bol odpojený${cleanupSummary}` });
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
  // Per-(user, workspace) lock prevents double-click duplicates and overlapping
  // manual syncs. If a sync is already running for this scope, short-circuit with
  // 409 instead of racing with Google Calendar inserts.
  const workspaceId = req.workspaceId || req.user?.workspaceId;
  const fullSyncLockKey = `fullsync-${req.user.id}-${workspaceId || 'none'}`;
  if (!acquireCalendarLock(fullSyncLockKey)) {
    return res.status(409).json({ message: 'Synchronizácia už prebieha, počkaj pár sekúnd.' });
  }
  try {
    const user = await User.findById(req.user.id);

    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }

    const calendar = await getCalendarClient(user);

    // Get tasks for the workspace from which the sync was triggered
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

    // Resolve per-workspace calendar once — all tasks in this /sync run share
    // the same workspace, so we only need one lookup (and possibly one calendar
    // creation). Avoids hammering Google's calendarList.list on every task.
    const targetCalendarId = await getOrCreateWorkspaceCalendar(user, workspaceId, calendar);

    for (const task of tasksToSync) {
      try {
        const existingEventId = user.googleCalendar.syncedTaskIds?.get(task.id);
        const existingCalendarId = user.googleCalendar.syncedTaskCalendars?.get?.(task.id);
        const eventData = createEventData(task);

        if (existingEventId && existingCalendarId && existingCalendarId !== targetCalendarId) {
          // Event migrated from another calendar (legacy or cross-workspace).
          // Delete old, insert new — keeps per-workspace grouping honest.
          try {
            await calendar.events.delete({ calendarId: existingCalendarId, eventId: existingEventId });
          } catch (e) {
            if (e.code !== 404) logger.debug('[Google Calendar] Stale delete failed during /sync', { error: e.message });
          }
          const event = await calendar.events.insert({
            calendarId: targetCalendarId,
            resource: eventData
          });
          user.googleCalendar.syncedTaskIds.set(task.id, event.data.id);
          user.googleCalendar.syncedTaskCalendars.set(task.id, targetCalendarId);
          synced++;
        } else if (existingEventId) {
          // Update in place.
          const updateCalendarId = existingCalendarId || targetCalendarId;
          try {
            await calendar.events.update({
              calendarId: updateCalendarId,
              eventId: existingEventId,
              resource: eventData
            });
            if (!existingCalendarId) {
              user.googleCalendar.syncedTaskCalendars.set(task.id, updateCalendarId);
            }
            updated++;
          } catch (e) {
            if (e.code === 404) {
              // Event deleted on Google side — re-insert in target calendar.
              const event = await calendar.events.insert({
                calendarId: targetCalendarId,
                resource: eventData
              });
              user.googleCalendar.syncedTaskIds.set(task.id, event.data.id);
              user.googleCalendar.syncedTaskCalendars.set(task.id, targetCalendarId);
              synced++;
            } else {
              throw e;
            }
          }
        } else {
          // First-time sync.
          const event = await calendar.events.insert({
            calendarId: targetCalendarId,
            resource: eventData
          });
          user.googleCalendar.syncedTaskIds.set(task.id, event.data.id);
          user.googleCalendar.syncedTaskCalendars.set(task.id, targetCalendarId);
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
  } finally {
    releaseCalendarLock(fullSyncLockKey);
  }
});

// Sync single task to Google Calendar
router.post('/sync-task/:taskId', authenticateToken, requireWorkspace, async (req, res) => {
  const { taskId } = req.params;
  // Per-task lock — same rationale as autoSyncTaskToCalendar: prevents two
  // concurrent requests from both inserting the same event (no mapping yet,
  // both create, duplicate lands).
  const singleSyncLockKey = `single-${req.user.id}-${taskId}`;
  if (!acquireCalendarLock(singleSyncLockKey)) {
    return res.status(409).json({ message: 'Synchronizácia tejto úlohy už prebieha.' });
  }
  try {
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
    const existingCalendarId = user.googleCalendar.syncedTaskCalendars?.get?.(taskData.id);
    const eventData = createEventData(taskData);

    // Resolve per-workspace calendar (creates lazily the first time).
    const targetCalendarId = await getOrCreateWorkspaceCalendar(user, workspaceId, calendar);

    if (existingEventId && existingCalendarId && existingCalendarId !== targetCalendarId) {
      // Task changed workspaces — delete stale event, re-insert in new cal.
      try {
        await calendar.events.delete({ calendarId: existingCalendarId, eventId: existingEventId });
      } catch (e) {
        if (e.code !== 404) logger.debug('[Google Calendar] Stale delete failed (/sync-task)', { error: e.message });
      }
      const event = await calendar.events.insert({ calendarId: targetCalendarId, resource: eventData });
      user.googleCalendar.syncedTaskIds.set(taskData.id, event.data.id);
      user.googleCalendar.syncedTaskCalendars.set(taskData.id, targetCalendarId);
      await user.save();
    } else if (existingEventId) {
      const updateCalendarId = existingCalendarId || targetCalendarId;
      try {
        await calendar.events.update({
          calendarId: updateCalendarId,
          eventId: existingEventId,
          resource: eventData
        });
        if (!existingCalendarId) {
          user.googleCalendar.syncedTaskCalendars.set(taskData.id, updateCalendarId);
          await user.save();
        }
      } catch (e) {
        if (e.code === 404) {
          const event = await calendar.events.insert({ calendarId: targetCalendarId, resource: eventData });
          user.googleCalendar.syncedTaskIds.set(taskData.id, event.data.id);
          user.googleCalendar.syncedTaskCalendars.set(taskData.id, targetCalendarId);
          await user.save();
        } else {
          throw e;
        }
      }
    } else {
      const event = await calendar.events.insert({
        calendarId: targetCalendarId,
        resource: eventData
      });
      user.googleCalendar.syncedTaskIds.set(taskData.id, event.data.id);
      user.googleCalendar.syncedTaskCalendars.set(taskData.id, targetCalendarId);
      await user.save();
    }

    res.json({ success: true, message: 'Úloha bola synchronizovaná' });
  } catch (error) {
    logger.error('[Google Calendar] Single task sync error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri synchronizácii: ' + error.message });
  } finally {
    releaseCalendarLock(singleSyncLockKey);
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
    // Delete from the calendar that actually holds this event (PR2: may
    // differ per-task). Legacy events without calendar mapping fall back to
    // user.googleCalendar.calendarId via the helper.
    const targetCalendarId = getCalendarIdForSyncedTask(user, taskId);

    try {
      await calendar.events.delete({
        calendarId: targetCalendarId,
        eventId: eventId
      });
    } catch (e) {
      // 404 = already deleted, that's fine
      if (e.code !== 404) {
        logger.warn('[Google Calendar] Event deletion failed', { error: e.message, eventId });
      }
    }

    user.googleCalendar.syncedTaskIds.delete(taskId);
    if (user.googleCalendar.syncedTaskCalendars) {
      user.googleCalendar.syncedTaskCalendars.delete(taskId);
    }
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
          // Task no longer exists, delete the calendar event from whichever
          // calendar it was synced to (PR2 per-workspace) — with fallback to
          // legacy single calendar.
          const targetCalendarId = getCalendarIdForSyncedTask(user, taskId);
          try {
            await calendar.events.delete({
              calendarId: targetCalendarId,
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
          if (user.googleCalendar.syncedTaskCalendars) {
            user.googleCalendar.syncedTaskCalendars.delete(taskId);
          }
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
 * DEDUPLICATE — remove duplicate Prpl CRM events in the user's calendar.
 *
 * Background: before the sync lock (PR1) was added, race conditions between
 * manual /sync and auto-sync on task create could write the same event twice.
 * This endpoint cleans up that legacy mess.
 *
 * Strategy (conservative — only touches Prpl CRM events):
 *  1. List every event with extendedProperties.private.source=prplcrm (our marker).
 *  2. Group by a "signature" — summary + start.date (or start.dateTime) — because
 *     older events (pre-PR1) don't have taskId in extendedProperties, so that's
 *     the only way to group them.
 *  3. Within a group, keep the event whose ID matches syncedTaskIds[taskId] first;
 *     if nothing matches, keep the newest (created last). Delete the rest.
 *
 * Safe because: only Prpl CRM-tagged events are in scope; primary calendar's
 * personal events (weddings, birthdays) do not have our marker, so they are
 * never even listed.
 */
router.post('/deduplicate', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }
    const calendar = await getCalendarClient(user);

    // Dedup scans every calendar that could hold our events:
    //  - legacy calendarId
    //  - every per-workspace calendar we track
    //  - any other Prpl CRM-named calendar the user owns (stragglers from
    //    older app versions or manual testing — these can hold duplicate
    //    copies of the same event since they share the marker).
    const calendarIds = new Set();
    if (user.googleCalendar.calendarId) calendarIds.add(user.googleCalendar.calendarId);
    if (user.googleCalendar.workspaceCalendars) {
      for (const [, cal] of user.googleCalendar.workspaceCalendars.entries()) {
        if (cal?.calendarId) calendarIds.add(cal.calendarId);
      }
    }
    try {
      const listResp = await calendar.calendarList.list({ maxResults: 250 });
      for (const item of (listResp.data.items || [])) {
        const s = item.summary || '';
        if (s === 'Prpl CRM' || s.startsWith('Prpl CRM —') || s.startsWith('Prpl CRM -')) {
          if (item.id) calendarIds.add(item.id);
        }
      }
    } catch (e) {
      logger.debug('[Google Calendar] Dedup: calendarList scan failed', { error: e.message });
    }

    // Build reverse index eventId → taskId from syncedTaskIds (shared map).
    const eventIdToTaskId = new Map();
    if (user.googleCalendar.syncedTaskIds) {
      for (const [taskId, eventId] of user.googleCalendar.syncedTaskIds.entries()) {
        eventIdToTaskId.set(eventId, taskId);
      }
    }

    let deleted = 0;
    let errors = 0;
    let totalScanned = 0;
    let totalGroups = 0;

    for (const calendarId of calendarIds) {
      // List all events tagged as ours in this calendar
      let pageToken;
      const ourEvents = [];
      try {
        do {
          const { data } = await calendar.events.list({
            calendarId,
            privateExtendedProperty: 'source=prplcrm',
            maxResults: 250,
            pageToken,
            showDeleted: false
          });
          if (data.items) ourEvents.push(...data.items);
          pageToken = data.nextPageToken;
        } while (pageToken);
      } catch (e) {
        // Calendar may have been deleted on Google side — skip it.
        logger.warn('[Google Calendar] Dedup list failed for calendar', { calendarId, error: e.message });
        errors++;
        continue;
      }
      totalScanned += ourEvents.length;

      // Group by (summary|startDate) — duplicates will collide on this key
      const groups = new Map();
      for (const ev of ourEvents) {
        const startKey = ev.start?.date || ev.start?.dateTime || '';
        const key = `${ev.summary || ''}|${startKey}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ev);
      }
      totalGroups += groups.size;

      for (const [, events] of groups) {
        if (events.length <= 1) continue; // no duplicates
        // Pick survivor: prefer one referenced in syncedTaskIds, else the newest
        events.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
        const mapped = events.find(e => eventIdToTaskId.has(e.id));
        const survivor = mapped || events[0];
        for (const ev of events) {
          if (ev.id === survivor.id) continue;
          try {
            await calendar.events.delete({ calendarId, eventId: ev.id });
            deleted++;
          } catch (e) {
            if (e.code !== 404) {
              logger.warn('[Google Calendar] Dedup delete failed', { eventId: ev.id, error: e.message });
              errors++;
            }
          }
        }
      }
    }

    logger.info('[Google Calendar] Dedup finished', {
      userId: user._id,
      calendarsScanned: calendarIds.size,
      totalEvents: totalScanned,
      groupsScanned: totalGroups,
      deleted,
      errors
    });

    res.json({
      success: true,
      message: `Odstránených ${deleted} duplicitných udalostí v ${calendarIds.size} kalendári/och${errors ? ` (${errors} chýb)` : ''}.`,
      deleted,
      errors,
      scanned: totalScanned,
      calendarsScanned: calendarIds.size
    });
  } catch (error) {
    logger.error('[Google Calendar] Dedup error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri deduplikácii: ' + error.message });
  }
});

/**
 * MIGRATE — move existing events from the legacy single calendar into new
 * per-workspace calendars.
 *
 * Before PR2, every user had one shared calendar (usually `primary` or an
 * early "Prpl CRM" calendar). PR2 introduced per-workspace calendars, but
 * new events only land in them after the user syncs each workspace. Old
 * events stay behind in the legacy calendar, so users see a mess: half
 * the events split by workspace, half stuck in the old pile.
 *
 * This endpoint fixes it in one shot:
 *   1. Walk syncedTaskIds (the canonical mapping).
 *   2. For each (taskId, eventId) without a per-task calendar recorded:
 *      a. Look up the Task → get workspaceId.
 *      b. Resolve / create the per-workspace calendar via the standard helper.
 *      c. Insert a fresh event there with the same data.
 *      d. Delete the original event from the legacy calendar.
 *      e. Update mappings (syncedTaskIds.eventId, syncedTaskCalendars).
 *   3. Skip tasks already bound to a calendar (post-PR2 or previously migrated).
 *
 * Failure handling: per-task failures are logged and counted; the run keeps
 * going. Migration is idempotent — re-running completes any tasks that
 * failed the first time.
 */
router.post('/migrate-to-per-workspace', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'Používateľ nebol nájdený' });
    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }

    const calendar = await getCalendarClient(user);
    const legacyCalendarId = user.googleCalendar.calendarId || 'primary';

    const syncedTaskIds = user.googleCalendar.syncedTaskIds
      ? Array.from(user.googleCalendar.syncedTaskIds.entries())
      : [];

    let migrated = 0;
    let skipped = 0;
    let errors = 0;
    let orphans = 0; // events whose task no longer exists

    for (const [taskId, eventId] of syncedTaskIds) {
      // Already bound to a calendar → skip (post-PR2 or previously migrated).
      const existingCal = user.googleCalendar.syncedTaskCalendars?.get?.(taskId);
      if (existingCal) { skipped++; continue; }

      try {
        // Resolve task → workspaceId. Global task first, then contact-scoped tasks.
        let workspaceId = null;
        if (mongoose.Types.ObjectId.isValid(taskId)) {
          const t = await Task.findById(taskId, 'workspaceId').lean();
          if (t?.workspaceId) workspaceId = t.workspaceId.toString();
        }
        if (!workspaceId) {
          // Contact subtask — search across contacts (bounded by membership).
          const memberships = await WorkspaceMember.find({ userId: user._id }, 'workspaceId').lean();
          const wsIds = memberships.map(m => m.workspaceId);
          const contact = await Contact.findOne({ workspaceId: { $in: wsIds }, 'tasks.id': taskId }, 'workspaceId').lean();
          if (contact?.workspaceId) workspaceId = contact.workspaceId.toString();
        }

        if (!workspaceId) {
          orphans++;
          // Task is gone — delete the dangling event and remove the mapping.
          try {
            await calendar.events.delete({ calendarId: legacyCalendarId, eventId });
          } catch (e) {
            if (e.code !== 404) logger.debug('[Migrate] Orphan delete failed', { error: e.message });
          }
          await User.findByIdAndUpdate(user._id, {
            $unset: {
              [`googleCalendar.syncedTaskIds.${taskId}`]: '',
              [`googleCalendar.syncedTaskCalendars.${taskId}`]: ''
            }
          });
          continue;
        }

        const targetCalendarId = await getOrCreateWorkspaceCalendar(user, workspaceId, calendar);
        if (!targetCalendarId || targetCalendarId === legacyCalendarId) {
          // Helper returned the same calendar (creation failed, falling back
          // to legacy). No point moving — just record the binding so we
          // don't try to migrate this again on next run.
          await User.findByIdAndUpdate(user._id, {
            $set: { [`googleCalendar.syncedTaskCalendars.${taskId}`]: legacyCalendarId }
          });
          skipped++;
          continue;
        }

        // Fetch the original event so we can re-create it verbatim in the
        // new calendar (keeps title/date/description/color intact).
        let originalEvent = null;
        try {
          const { data } = await calendar.events.get({ calendarId: legacyCalendarId, eventId });
          originalEvent = data;
        } catch (e) {
          if (e.code !== 404) throw e;
          // Event disappeared on Google side — just clean up mapping.
          await User.findByIdAndUpdate(user._id, {
            $unset: {
              [`googleCalendar.syncedTaskIds.${taskId}`]: '',
              [`googleCalendar.syncedTaskCalendars.${taskId}`]: ''
            }
          });
          orphans++;
          continue;
        }

        // Strip read-only fields before insert (Google rejects them).
        const copyBody = {
          summary: originalEvent.summary,
          description: originalEvent.description,
          start: originalEvent.start,
          end: originalEvent.end,
          colorId: originalEvent.colorId,
          transparency: originalEvent.transparency,
          status: originalEvent.status,
          extendedProperties: originalEvent.extendedProperties || {
            private: { ...EVENT_MARKER, taskId: String(taskId) }
          }
        };
        // Ensure our marker is present on migrated events (legacy ones may lack it)
        if (!copyBody.extendedProperties.private) copyBody.extendedProperties.private = {};
        copyBody.extendedProperties.private.source = 'prplcrm';
        copyBody.extendedProperties.private.taskId = String(taskId);

        const inserted = await calendar.events.insert({
          calendarId: targetCalendarId,
          resource: copyBody
        });

        // Delete from legacy location.
        try {
          await calendar.events.delete({ calendarId: legacyCalendarId, eventId });
        } catch (e) {
          if (e.code !== 404) logger.warn('[Migrate] Legacy delete failed', { taskId, error: e.message });
        }

        // Update mappings.
        await User.findByIdAndUpdate(user._id, {
          $set: {
            [`googleCalendar.syncedTaskIds.${taskId}`]: inserted.data.id,
            [`googleCalendar.syncedTaskCalendars.${taskId}`]: targetCalendarId
          }
        });
        migrated++;
      } catch (taskErr) {
        errors++;
        logger.warn('[Migrate] Per-task migration failed', { taskId, error: taskErr.message });
      }
    }

    logger.info('[Google Calendar] Migration finished', {
      userId: user._id.toString(),
      migrated,
      skipped,
      orphans,
      errors,
      total: syncedTaskIds.length
    });

    res.json({
      success: true,
      message: `Rozdelené: ${migrated} udalostí presunutých do workspace kalendárov, ${skipped} už bolo správne, ${orphans} osirotené odstránené, ${errors} chýb.`,
      migrated,
      skipped,
      orphans,
      errors,
      total: syncedTaskIds.length
    });
  } catch (error) {
    logger.error('[Google Calendar] Migration error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri migrácii: ' + error.message });
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
    // Marker so we can find our events later (bulk delete in primary calendar use-case).
    // taskId is stored too — lets us reconcile duplicates by grouping via Google Calendar's
    // `privateExtendedProperty=taskId=...` search parameter without having to trust the
    // per-user syncedTaskIds map (which can get out of sync with reality).
    extendedProperties: { private: { ...EVENT_MARKER, taskId: task.id ? String(task.id) : '' } }
  };
}

// ==================== PER-WORKSPACE CALENDAR RESOLUTION (PR2) ====================

/**
 * Resolve the Google calendarId to use for a (user, workspace) pair.
 *
 * Creates a dedicated "Prpl CRM — {workspace name}" secondary calendar on
 * Google the first time it's needed for a given workspace. Subsequent calls
 * return the mapping stored in `user.googleCalendar.workspaceCalendars`.
 *
 * Why a calendar per workspace (and not per-user): a user with 3 workspaces
 * would otherwise see 3 workspaces' events jumbled in one calendar with no
 * way to tell them apart. Separate calendars give users native Google-side
 * controls (toggle visibility, set distinct colors, hide a workspace
 * temporarily) without us having to invent new UI.
 *
 * Fallbacks (in order of preference):
 *  1. Mapping exists in workspaceCalendars → use it.
 *  2. Create a new secondary calendar → store and use it.
 *  3. Creation fails (e.g. missing calendar.app.created scope) → fall back
 *     to user.googleCalendar.calendarId (pre-PR2 legacy single calendar).
 *  4. Last-resort fallback → 'primary'.
 *
 * Concurrent calls for the same (user, workspace) are safe: worst case we
 * create the calendar twice on Google, but only one mapping wins in the DB
 * (atomic $set). The loser calendar becomes orphaned but has no events —
 * user can delete it manually if bothered, or /cleanup later.
 */
async function getOrCreateWorkspaceCalendar(user, workspaceId, calendarClient) {
  // No workspace context (shouldn't normally happen) → legacy calendar.
  // Delete paths still need this so orphan cleanup can function.
  if (!workspaceId) {
    return user.googleCalendar?.calendarId || 'primary';
  }

  const wsKey = String(workspaceId);
  const existing = user.googleCalendar?.workspaceCalendars?.get?.(wsKey);
  if (existing?.calendarId) {
    // Trust-but-verify: ensure the calendar still exists on Google's side.
    // If user manually deleted it, we need to re-create rather than write
    // into a dead ID (which would fail every sync afterwards).
    try {
      // calendars.get verifies the calendar resource itself still exists.
      // calendarList.get could 404 even when the calendar is fine (user
      // unsubscribed from their own list) — that would trigger false
      // recreations.
      await calendarClient.calendars.get({ calendarId: existing.calendarId });
      return existing.calendarId;
    } catch (e) {
      if (e.code === 404 || e.code === 410) {
        logger.warn('[Google Calendar] Cached workspace calendar vanished, will recreate', {
          workspaceId,
          staleCalendarId: existing.calendarId
        });
        // Fall through to re-create below.
      } else {
        throw e;
      }
    }
  }

  // Need to create. Fetch workspace name for a human-readable calendar summary.
  let workspaceName = 'Workspace';
  try {
    const ws = await Workspace.findById(workspaceId).lean();
    if (ws?.name) workspaceName = ws.name;
  } catch (e) {
    logger.debug('[Google Calendar] Workspace lookup failed, using fallback name', { workspaceId, error: e.message });
  }

  const summary = `Prpl CRM — ${workspaceName}`;

  let newCalendarId = null;
  // Intentionally NO try/catch wrapping the list+insert below. Previously
  // we swallowed failures and silently returned user.googleCalendar.calendarId,
  // which for users whose primary calendar is renamed ("Elektrické autá
  // Michalovce") meant every workspace's events got dumped into their
  // personal calendar invisibly. Now errors propagate to /sync and the
  // user sees a real message instead of wondering why nothing appears.
  const listResp = await calendarClient.calendarList.list({ maxResults: 250 });
  const existingOnGoogle = (listResp.data.items || []).find(c => c.summary === summary);
  if (existingOnGoogle) {
    newCalendarId = existingOnGoogle.id;
    logger.info('[Google Calendar] Reusing existing Google-side calendar', { workspaceId, calendarId: newCalendarId });
  } else {
    try {
      const created = await calendarClient.calendars.insert({
        resource: {
          summary,
          description: `Synchronizované úlohy z Prpl CRM (${workspaceName}). Môžete tento kalendár kedykoľvek vymazať.`,
          timeZone: 'Europe/Bratislava'
        }
      });
      newCalendarId = created.data.id;
      logger.info('[Google Calendar] Created per-workspace calendar', { workspaceId, calendarId: newCalendarId });
    } catch (insertErr) {
      logger.error('[Google Calendar] calendars.insert failed', {
        userId: user._id?.toString(),
        workspaceId,
        summary,
        code: insertErr.code,
        message: insertErr.message,
        errors: insertErr.errors,
        response: insertErr.response?.data
      });
      // Re-throw with a user-actionable message (Slovak, shown in the toast).
      const e = new Error(
        insertErr.code === 403
          ? 'Google Calendar nedovolil vytvoriť nový kalendár. Pravdepodobne treba odpojiť a znova prepojiť Google účet s novým povolením.'
          : `Nepodarilo sa vytvoriť kalendár v Google: ${insertErr.message}`
      );
      e.cause = insertErr;
      e.status = insertErr.code || 500;
      throw e;
    }

    // Set a color so workspaces are visually distinct. Non-fatal.
    try {
      const colorId = String((Math.abs(Array.from(wsKey).reduce((a, c) => a + c.charCodeAt(0), 0)) % 24) + 1);
      await calendarClient.calendarList.patch({
        calendarId: newCalendarId,
        resource: { colorId }
      });
    } catch (colorErr) {
      logger.debug('[Google Calendar] Color patch failed (non-fatal)', { error: colorErr.message });
    }
  }

  if (!newCalendarId) {
    throw new Error('Neznáma chyba pri vytváraní workspace kalendára');
  }

  // Persist mapping atomically. If two requests raced, the second $set wins,
  // which is fine — the orphaned calendar on Google is harmless (no events).
  try {
    await User.findByIdAndUpdate(user._id, {
      $set: {
        [`googleCalendar.workspaceCalendars.${wsKey}`]: {
          calendarId: newCalendarId,
          createdAt: new Date()
        }
      }
    });
    // Update in-memory user so the same request doesn't re-create.
    if (!user.googleCalendar.workspaceCalendars) {
      user.googleCalendar.workspaceCalendars = new Map();
    }
    user.googleCalendar.workspaceCalendars.set(wsKey, { calendarId: newCalendarId, createdAt: new Date() });
  } catch (persistErr) {
    logger.warn('[Google Calendar] Failed to persist workspaceCalendars mapping', {
      userId: user._id?.toString(),
      workspaceId,
      error: persistErr.message
    });
    // Non-fatal — the mapping will be re-attempted on next sync.
  }

  return newCalendarId;
}

/**
 * Resolve which calendar a previously-synced event lives in. Used by
 * delete/update paths that only have taskId in hand.
 * Prefers syncedTaskCalendars (PR2). Falls back to legacy single calendarId.
 */
function getCalendarIdForSyncedTask(user, taskId) {
  const calendarId = user.googleCalendar?.syncedTaskCalendars?.get?.(String(taskId));
  return calendarId || user.googleCalendar?.calendarId || 'primary';
}

// ==================== AUTO-SYNC HELPER FUNCTIONS ====================

// In-memory lock to prevent duplicate syncs for the same task.
// Parallel triggers (manual /sync + auto-sync on create) wrote the same event twice
// into Google Calendar, because Google's insert is not idempotent for events with
// the same extendedProperties.private.taskId — it cheerfully creates duplicates.
// Mirror of Google Tasks lock (googleTasks.js); keep behavior identical so both
// sync paths converge on the same concurrency model.
const calendarSyncLocks = new Map();
const CALENDAR_LOCK_TIMEOUT = 30000; // 30s — matches /sync worst-case wall time

const acquireCalendarLock = (key) => {
  const now = Date.now();
  const existing = calendarSyncLocks.get(key);
  if (existing && now - existing > CALENDAR_LOCK_TIMEOUT) {
    calendarSyncLocks.delete(key); // stale — release
  }
  if (calendarSyncLocks.has(key)) return false;
  calendarSyncLocks.set(key, now);
  return true;
};

const releaseCalendarLock = (key) => {
  calendarSyncLocks.delete(key);
};

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

    // Acquire lock to prevent duplicate syncs (create+auto-sync race)
    const lockKey = `calsync-${taskId}-${action}`;
    if (!acquireCalendarLock(lockKey)) {
      logger.debug('[Auto-sync Calendar] Skipping - sync already in progress', { taskId, action });
      return;
    }

    try {
    // Determine workspace scope — only sync for members of the task's workspace.
    const workspaceId = taskData.workspaceId?.toString();

    // HARDENED FALLBACK: if workspaceId is missing, we used to fan out to
    // every user with googleCalendar.enabled across ALL workspaces. That
    // caused events to leak between workspaces and created phantom
    // duplicates (a subtask in workspace A ended up also syncing to user's
    // workspace B legacy calendar). For `delete` we still need the fallback
    // so an orphan cleanup can hit whatever user had the event mapped.
    // For `create`/`update` we refuse to proceed — better to skip a sync
    // than to corrupt another workspace's calendar.
    let users;
    if (workspaceId) {
      const members = await WorkspaceMember.find({ workspaceId }, 'userId').lean();
      const memberUserIds = members.map(m => m.userId);
      users = await User.find({ _id: { $in: memberUserIds }, 'googleCalendar.enabled': true });
    } else if (action === 'delete') {
      users = await User.find({ 'googleCalendar.enabled': true });
    } else {
      logger.warn('[Auto-sync Calendar] Missing workspaceId — skipping to avoid cross-workspace leak', {
        taskId,
        action,
        title: taskData.title
      });
      return;
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
          // Delete event from calendar. Use the calendarId recorded at insert
          // time (syncedTaskCalendars) so we hit the right calendar even if
          // workspaceCalendars mapping evolved since.
          const eventId = user.googleCalendar.syncedTaskIds?.get(taskId);
          if (eventId) {
            const targetCalendarId = getCalendarIdForSyncedTask(user, taskId);
            try {
              await calendar.events.delete({
                calendarId: targetCalendarId,
                eventId: eventId
              });
            } catch (e) {
              // 404 is OK - event already deleted
              if (e.code !== 404) {
                logger.warn('[Auto-sync Calendar] Event deletion failed', { error: e.message });
              }
            }
            // Atomic removal of mappings
            await User.findByIdAndUpdate(user._id, {
              $unset: {
                [`googleCalendar.syncedTaskIds.${taskId}`]: '',
                [`googleCalendar.syncedTaskCalendars.${taskId}`]: ''
              }
            });
          }
        } else {
          // Resolve target calendar (create per-workspace if needed).
          const targetCalendarId = await getOrCreateWorkspaceCalendar(user, workspaceId, calendar);

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
          const existingCalendarId = user.googleCalendar.syncedTaskCalendars?.get?.(taskId);

          if (existingEventId && existingCalendarId && existingCalendarId !== targetCalendarId) {
            // Event was previously synced to a different calendar (e.g. task
            // moved between workspaces, or we migrated from legacy single
            // calendar). Delete the stale event first so we don't leave an
            // orphan behind in the old calendar.
            try {
              await calendar.events.delete({
                calendarId: existingCalendarId,
                eventId: existingEventId
              });
            } catch (e) {
              if (e.code !== 404) {
                logger.warn('[Auto-sync Calendar] Stale event cleanup failed', { error: e.message, existingCalendarId });
              }
            }
            // Force re-insert in the new calendar.
            const event = await calendar.events.insert({
              calendarId: targetCalendarId,
              resource: eventData
            });
            await User.findByIdAndUpdate(user._id, {
              $set: {
                [`googleCalendar.syncedTaskIds.${taskId}`]: event.data.id,
                [`googleCalendar.syncedTaskCalendars.${taskId}`]: targetCalendarId
              }
            });
          } else if (existingEventId) {
            // Update in the same calendar we synced to last time.
            const updateCalendarId = existingCalendarId || targetCalendarId;
            try {
              await calendar.events.update({
                calendarId: updateCalendarId,
                eventId: existingEventId,
                resource: eventData
              });
              // Backfill calendar mapping if it was missing (pre-PR2 legacy).
              if (!existingCalendarId) {
                await User.findByIdAndUpdate(user._id, {
                  $set: { [`googleCalendar.syncedTaskCalendars.${taskId}`]: updateCalendarId }
                });
              }
            } catch (e) {
              // If event doesn't exist, create new one in target calendar
              if (e.code === 404) {
                const event = await calendar.events.insert({
                  calendarId: targetCalendarId,
                  resource: eventData
                });
                await User.findByIdAndUpdate(user._id, {
                  $set: {
                    [`googleCalendar.syncedTaskIds.${taskId}`]: event.data.id,
                    [`googleCalendar.syncedTaskCalendars.${taskId}`]: targetCalendarId
                  }
                });
              } else {
                throw e;
              }
            }
          } else {
            // First-time sync — create new event in workspace calendar.
            const event = await calendar.events.insert({
              calendarId: targetCalendarId,
              resource: eventData
            });
            await User.findByIdAndUpdate(user._id, {
              $set: {
                [`googleCalendar.syncedTaskIds.${taskId}`]: event.data.id,
                [`googleCalendar.syncedTaskCalendars.${taskId}`]: targetCalendarId
              }
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
    } finally {
      releaseCalendarLock(lockKey);
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
