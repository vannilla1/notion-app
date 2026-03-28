const express = require('express');
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

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Scopes required for Google Calendar
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// Helper to get authenticated calendar client for user
const getCalendarClient = async (user, forceRefresh = false) => {
  if (!user.googleCalendar?.accessToken) {
    throw new Error('Google Calendar not connected');
  }

  // Check if we have a refresh token - this is critical for long-term access
  if (!user.googleCalendar.refreshToken) {
    console.warn('[Google Calendar] No refresh token stored - user needs to reconnect', { userId: user._id });
    throw new Error('Google Calendar token expired. Please reconnect your account.');
  }

  oauth2Client.setCredentials({
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
    console.log('[Google Calendar] Token refresh needed', {
      userId: user._id,
      forceRefresh,
      tokenExpiry: tokenExpiry?.toISOString(),
      now: now.toISOString()
    });

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      user.googleCalendar.accessToken = credentials.access_token;
      user.googleCalendar.tokenExpiry = new Date(credentials.expiry_date);
      // Google sometimes returns a new refresh token - always save it
      if (credentials.refresh_token) {
        user.googleCalendar.refreshToken = credentials.refresh_token;
        console.log('[Google Calendar] New refresh token received', { userId: user._id });
      }
      await user.save();
      oauth2Client.setCredentials(credentials);
      console.log('[Google Calendar] Token refreshed successfully', { userId: user._id });
    } catch (refreshError) {
      console.error('[Google Calendar] Token refresh failed', {
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

        console.warn('[Google Calendar] Credentials cleared due to invalid grant', { userId: user._id });
        throw new Error('Google Calendar token expired. Please reconnect your account.');
      }

      // For other errors, try to continue with existing token
      console.warn('[Google Calendar] Continuing with existing token after refresh failure', { userId: user._id });
    }
  }

  return google.calendar({ version: 'v3', auth: oauth2Client });
};

// Get Google Calendar authorization URL
router.get('/auth-url', authenticateToken, (req, res) => {
  try {
    const state = req.user.id.toString(); // Pass user ID in state for callback (must be string)
    console.log('Generating auth URL for user:', state);
    console.log('GOOGLE_CLIENT_ID:', GOOGLE_CLIENT_ID ? 'set' : 'NOT SET');
    console.log('GOOGLE_REDIRECT_URI:', GOOGLE_REDIRECT_URI);

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      state: state,
      prompt: 'consent' // Force consent to get refresh token
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

  // Log all query parameters for debugging
  console.log('Google Calendar callback - full query:', req.query);
  console.log('Google Calendar callback - baseUrl:', baseUrl);

  try {
    const { code, state: userId } = req.query;

    console.log('Google Calendar callback received:', { code: !!code, userId, codeLength: code?.length });

    if (!code || !userId) {
      console.log('Missing params in callback - redirecting to error page');
      const redirectUrl = `${baseUrl}/tasks?google_calendar=error&message=missing_params`;
      console.log('Redirect URL:', redirectUrl);
      return res.redirect(redirectUrl);
    }

    // Exchange code for tokens
    console.log('Exchanging code for tokens...');
    const { tokens } = await oauth2Client.getToken(code);
    console.log('Tokens received:', { hasAccessToken: !!tokens.access_token, hasRefreshToken: !!tokens.refresh_token });

    // Update user with Google Calendar credentials
    const user = await User.findById(userId);
    if (!user) {
      console.log('User not found:', userId);
      return res.redirect(`${baseUrl}/tasks?google_calendar=error&message=user_not_found`);
    }

    // IMPORTANT: Google only sends refresh_token on first authorization
    // or if we use prompt: 'consent'. Make sure we save it!
    if (!tokens.refresh_token) {
      console.warn('[Google Calendar] No refresh token received! User may need to reconnect later.', { userId });
    }

    user.googleCalendar = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.googleCalendar?.refreshToken, // Keep old if not provided
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      calendarId: 'primary',
      enabled: true,
      connectedAt: new Date(),
      syncedTaskIds: user.googleCalendar?.syncedTaskIds || new Map()
    };

    await user.save();
    logger.info('[Google Calendar] User connected successfully', {
      userId,
      username: user.username,
      hasRefreshToken: !!user.googleCalendar.refreshToken,
      tokenExpiry: user.googleCalendar.tokenExpiry
    });

    // Start watching for calendar changes (Google → CRM push notifications)
    startCalendarWatch(user).catch(err =>
      logger.warn('[Google Calendar] Watch setup failed on connect', { error: err.message })
    );

    // Redirect back to app with success
    res.redirect(`${baseUrl}/tasks?google_calendar=connected`);
  } catch (error) {
    console.error('Error in Google Calendar callback:', error);
    res.redirect(`${baseUrl}/tasks?google_calendar=error&message=` + encodeURIComponent(error.message));
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
      connected: user.googleCalendar?.enabled || false,
      connectedAt: user.googleCalendar?.connectedAt || null
    });
  } catch (error) {
    console.error('Error getting Google Calendar status:', error);
    res.status(500).json({ message: 'Chyba pri získavaní stavu' });
  }
});

// Disconnect Google Calendar
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    // Revoke token if possible
    if (user.googleCalendar?.accessToken) {
      try {
        await oauth2Client.revokeToken(user.googleCalendar.accessToken);
      } catch (e) {
        console.log('Token revocation failed (may already be revoked):', e.message);
      }
    }

    // Stop watching for changes
    await stopCalendarWatch(user);

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

    res.json({ success: true, message: 'Google Calendar bol odpojený' });
  } catch (error) {
    console.error('Error disconnecting Google Calendar:', error);
    res.status(500).json({ message: 'Chyba pri odpájaní' });
  }
});

// ==================== WEBHOOK (Google → CRM) ====================

const WEBHOOK_BASE_URL = process.env.API_BASE_URL || 'https://perun-crm-api.onrender.com';
const WATCH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (Google max)

/**
 * Start watching a user's Google Calendar for changes.
 * Creates a push notification channel so Google sends us a POST when events change.
 */
const startCalendarWatch = async (user) => {
  try {
    const calendar = await getCalendarClient(user);
    const channelId = uuidv4();

    const res = await calendar.events.watch({
      calendarId: user.googleCalendar.calendarId || 'primary',
      resource: {
        id: channelId,
        type: 'web_hook',
        address: `${WEBHOOK_BASE_URL}/api/google-calendar/webhook`,
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

      // Find the CRM task — look it up to get its actual workspaceId
      let task = await Task.findById(crmTaskId);
      let contact = null;
      let taskIndex = -1;

      if (!task) {
        // Search in contacts
        contact = await Contact.findOne({ 'tasks.id': crmTaskId });
        if (contact) {
          taskIndex = contact.tasks.findIndex(t => t.id === crmTaskId);
          if (taskIndex !== -1) task = contact.tasks[taskIndex];
        }
      }

      if (!task) continue; // Task no longer exists in CRM

      // Verify the task's workspace is one where this user is a member
      const taskWsId = (task.workspaceId || contact?.workspaceId)?.toString();
      if (taskWsId && !userWorkspaceIds.some(wId => wId.toString() === taskWsId)) {
        continue; // Task belongs to a workspace where user is not a member
      }

      if (isDeleted) {
        // Event was deleted in Google Calendar — don't delete the CRM task,
        // just remove the mapping so next sync recreates it
        const userToSave = await User.findById(user._id);
        if (userToSave) {
          userToSave.googleCalendar.syncedTaskIds.delete(crmTaskId);
          await userToSave.save();
        }
        logger.debug('[Calendar Webhook] Event deleted in Google, removed mapping', { crmTaskId });
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

    console.log('Found global tasks:', globalTasks.length);
    console.log('Found contacts:', contacts.length);

    // Collect global tasks
    for (const task of globalTasks) {
      console.log('Task:', task.title, 'dueDate:', task.dueDate);
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

    console.log('Tasks to sync (with dueDate):', tasksToSync.length);
    console.log('Tasks details:', tasksToSync.map(t => ({ title: t.title, dueDate: t.dueDate })));

    for (const task of tasksToSync) {
      try {
        console.log(`Syncing task: ${task.title} (${task.id})`);
        const existingEventId = user.googleCalendar.syncedTaskIds?.get(task.id);

        const eventData = createEventData(task);
        console.log('Event data:', JSON.stringify(eventData));

        if (existingEventId) {
          // Update existing event
          console.log(`Updating existing event: ${existingEventId}`);
          await calendar.events.update({
            calendarId: user.googleCalendar.calendarId,
            eventId: existingEventId,
            resource: eventData
          });
          updated++;
          console.log('Event updated successfully');
        } else {
          // Create new event
          console.log('Creating new event...');
          const event = await calendar.events.insert({
            calendarId: user.googleCalendar.calendarId,
            resource: eventData
          });
          console.log('Event created:', event.data.id);
          user.googleCalendar.syncedTaskIds.set(task.id, event.data.id);
          synced++;
        }
      } catch (error) {
        console.error(`Error syncing task ${task.id}:`, error.message);
        console.error('Full error:', error);
        errors++;
      }
    }

    await user.save();

    res.json({
      success: true,
      message: `Synchronizované: ${synced} nových, ${updated} aktualizovaných, ${errors} chýb`,
      synced,
      updated,
      errors
    });
  } catch (error) {
    console.error('Error syncing to Google Calendar:', error);
    res.status(500).json({ message: 'Chyba pri synchronizácii: ' + error.message });
  }
});

// Sync single task to Google Calendar
router.post('/sync-task/:taskId', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const user = await User.findById(req.user.id);

    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }

    const calendar = await getCalendarClient(user);

    // Find task (could be global or contact task)
    let task = await Task.findById(taskId);
    let contactName = null;

    if (!task) {
      // Search in contacts
      const contacts = await Contact.find({});
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
    console.error('Error syncing single task:', error);
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
      console.log('Event deletion failed (may already be deleted):', e.message);
    }

    user.googleCalendar.syncedTaskIds.delete(taskId);
    await user.save();

    res.json({ success: true, message: 'Udalosť bola odstránená z kalendára' });
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    res.status(500).json({ message: 'Chyba pri odstraňovaní: ' + error.message });
  }
});

// Clean up orphaned events (events in Google Calendar that no longer have corresponding tasks)
// Also cleans up old events from the past
router.post('/cleanup', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }

    const calendar = await getCalendarClient(user);

    // Get all current task IDs
    const globalTasks = await Task.find({});
    const contacts = await Contact.find({});

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
      console.log('Synced task IDs in database:', syncedTaskIds.length);

      for (const [taskId, eventId] of syncedTaskIds) {
        if (!currentTaskIds.has(taskId)) {
          // Task no longer exists, delete the calendar event
          try {
            await calendar.events.delete({
              calendarId: user.googleCalendar.calendarId,
              eventId: eventId
            });
            deleted++;
            console.log(`Deleted orphaned event: ${eventId} (task: ${taskId})`);
          } catch (e) {
            console.log(`Failed to delete event ${eventId}:`, e.message);
            errors++;
          }
          user.googleCalendar.syncedTaskIds.delete(taskId);
        }
      }
    }

    await user.save();

    res.json({
      success: true,
      message: `Vyčistené: ${deleted} udalostí odstránených, ${errors} chýb`,
      deleted,
      errors
    });
  } catch (error) {
    console.error('Error cleaning up calendar:', error);
    res.status(500).json({ message: 'Chyba pri čistení: ' + error.message });
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
  const dueDate = new Date(task.dueDate);
  const nextDay = new Date(dueDate);
  nextDay.setDate(nextDay.getDate() + 1);

  // Format dates as YYYY-MM-DD
  const startDate = dueDate.toISOString().split('T')[0];
  const endDate = nextDay.toISOString().split('T')[0];

  let description = task.description || '';
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
    summary: (task.completed ? '✓ ' : '') + task.title,
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
    status: task.completed ? 'cancelled' : 'confirmed'
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
      console.log('[Auto-sync Calendar] Task has no due date, skipping sync');
      return;
    }

    // Normalize taskId - handle various formats (ObjectId, string, nested object)
    let taskId = taskData.id || taskData._id;
    if (taskId && typeof taskId === 'object' && taskId.toString) {
      taskId = taskId.toString();
    }

    // Validate taskId
    if (!taskId) {
      console.warn('[Auto-sync Calendar] Missing task ID', { title: taskData.title });
      return;
    }

    // Determine workspace scope — only sync for members of the task's workspace
    const workspaceId = taskData.workspaceId?.toString();
    console.log(`[Auto-sync Calendar] Starting sync for task "${taskData.title}" (ID: ${taskId}, action: ${action}, workspace: ${workspaceId || 'none'})`);

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

    if (users.length === 0) {
      console.log('[Auto-sync Calendar] No workspace members with Google Calendar connected');
      return;
    }

    console.log(`[Auto-sync Calendar] Found ${users.length} workspace members with Google Calendar connected`);

    for (const user of users) {
      try {
        const calendar = await getCalendarClient(user);
        console.log(`[Auto-sync Calendar] Processing for user ${user.username}, syncedTaskIds has ${user.googleCalendar.syncedTaskIds?.size || 0} entries`);

        if (action === 'delete') {
          // Delete event from calendar
          const eventId = user.googleCalendar.syncedTaskIds?.get(taskId);
          if (eventId) {
            try {
              await calendar.events.delete({
                calendarId: user.googleCalendar.calendarId,
                eventId: eventId
              });
              console.log(`[Auto-sync Calendar] Deleted event ${eventId} for user ${user.username}`);
            } catch (e) {
              // 404 is OK - event already deleted
              if (e.code !== 404) {
                console.warn(`[Auto-sync Calendar] Event deletion failed:`, e.message);
              }
            }
            // Re-fetch user before modifying Map to prevent race conditions
            const userToSave = await User.findById(user._id);
            if (userToSave) {
              userToSave.googleCalendar.syncedTaskIds.delete(taskId);
              await userToSave.save();
            }
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

          // Re-fetch user to get latest syncedTaskIds (prevents race condition)
          const freshUser = await User.findById(user._id);
          if (!freshUser) {
            console.warn('[Auto-sync Calendar] User not found on re-fetch', { userId: user._id });
            continue;
          }

          const existingEventId = freshUser.googleCalendar.syncedTaskIds?.get(taskId);

          if (existingEventId) {
            // Update existing event
            try {
              await calendar.events.update({
                calendarId: freshUser.googleCalendar.calendarId,
                eventId: existingEventId,
                resource: eventData
              });
              console.log(`[Auto-sync Calendar] Updated event ${existingEventId} for user ${user.username}`);
            } catch (e) {
              // If event doesn't exist, create new one
              if (e.code === 404) {
                const event = await calendar.events.insert({
                  calendarId: freshUser.googleCalendar.calendarId,
                  resource: eventData
                });
                // Re-fetch again before saving to prevent overwriting other changes
                const userToSave = await User.findById(user._id);
                if (userToSave) {
                  userToSave.googleCalendar.syncedTaskIds.set(taskId, event.data.id);
                  await userToSave.save();
                }
                console.log(`[Auto-sync Calendar] Created new event (old was deleted) for user ${user.username}`);
              } else {
                throw e;
              }
            }
          } else {
            // Create new event
            const event = await calendar.events.insert({
              calendarId: freshUser.googleCalendar.calendarId,
              resource: eventData
            });
            // Re-fetch again before saving to prevent overwriting other changes
            const userToSave = await User.findById(user._id);
            if (userToSave) {
              userToSave.googleCalendar.syncedTaskIds.set(taskId, event.data.id);
              await userToSave.save();
            }
            console.log(`[Auto-sync Calendar] Created event ${event.data.id} for user ${user.username}`);
          }
        }
      } catch (error) {
        // Check if this is a token expired error - log it prominently
        if (error.message?.includes('token expired') || error.message?.includes('reconnect')) {
          console.warn(`[Auto-sync Calendar] Token expired for user ${user.username}, skipping sync`);
        } else {
          console.error(`[Auto-sync Calendar] Error syncing for user ${user.username}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('[Auto-sync Calendar] Error in autoSyncTaskToCalendar:', error.message);
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
