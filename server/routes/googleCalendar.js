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
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://perun-crm-api.onrender.com/api/google-calendar/callback';

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Scopes required for Google Calendar
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// Helper to get authenticated calendar client for user
const getCalendarClient = async (user) => {
  if (!user.googleCalendar?.accessToken) {
    throw new Error('Google Calendar not connected');
  }

  oauth2Client.setCredentials({
    access_token: user.googleCalendar.accessToken,
    refresh_token: user.googleCalendar.refreshToken,
    expiry_date: user.googleCalendar.tokenExpiry?.getTime()
  });

  // Check if token needs refresh
  if (user.googleCalendar.tokenExpiry && new Date() >= user.googleCalendar.tokenExpiry) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    user.googleCalendar.accessToken = credentials.access_token;
    user.googleCalendar.tokenExpiry = new Date(credentials.expiry_date);
    await user.save();
    oauth2Client.setCredentials(credentials);
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

    user.googleCalendar = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      calendarId: 'primary',
      enabled: true,
      connectedAt: new Date(),
      syncedTaskIds: user.googleCalendar?.syncedTaskIds || new Map()
    };

    await user.save();
    console.log('User updated with Google Calendar credentials');

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

    user.googleCalendar = {
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
      calendarId: 'primary',
      enabled: false,
      connectedAt: null,
      syncedTaskIds: new Map()
    };

    await user.save();

    res.json({ success: true, message: 'Google Calendar bol odpojený' });
  } catch (error) {
    console.error('Error disconnecting Google Calendar:', error);
    res.status(500).json({ message: 'Chyba pri odpájaní' });
  }
});

// Sync all tasks to Google Calendar
router.post('/sync', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user.googleCalendar?.enabled) {
      return res.status(400).json({ message: 'Google Calendar nie je pripojený' });
    }

    const calendar = await getCalendarClient(user);

    // Get all tasks with due dates
    const globalTasks = await Task.find({});
    const contacts = await Contact.find({});

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

    // Second, search for and delete events with "test" in name using query search
    try {
      // Use query search to find events with "test" in the title
      const eventsResponse = await calendar.events.list({
        calendarId: user.googleCalendar.calendarId,
        q: 'test',
        maxResults: 500,
        singleEvents: true
      });

      const events = eventsResponse.data.items || [];
      console.log(`Found ${events.length} events matching 'test' query`);

      for (const event of events) {
        // Double check the title contains "test"
        const title = (event.summary || '').toLowerCase();
        if (title.includes('test')) {
          try {
            await calendar.events.delete({
              calendarId: user.googleCalendar.calendarId,
              eventId: event.id
            });
            deleted++;
            console.log(`Deleted test event: ${event.summary} (${event.id})`);
          } catch (e) {
            console.log(`Failed to delete event ${event.id}:`, e.message);
            errors++;
          }
        }
      }
    } catch (e) {
      console.log('Error listing events:', e.message);
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
      console.log('Auto-sync: Task has no due date, skipping sync');
      return;
    }

    // Find all users with Google Calendar enabled
    const users = await User.find({ 'googleCalendar.enabled': true });

    if (users.length === 0) {
      console.log('Auto-sync: No users with Google Calendar connected');
      return;
    }

    console.log(`Auto-sync: Found ${users.length} users with Google Calendar connected`);

    for (const user of users) {
      try {
        const calendar = await getCalendarClient(user);
        const taskId = taskData.id || taskData._id?.toString();

        if (action === 'delete') {
          // Delete event from calendar
          const eventId = user.googleCalendar.syncedTaskIds?.get(taskId);
          if (eventId) {
            try {
              await calendar.events.delete({
                calendarId: user.googleCalendar.calendarId,
                eventId: eventId
              });
              console.log(`Auto-sync: Deleted event ${eventId} for user ${user.username}`);
            } catch (e) {
              console.log(`Auto-sync: Event deletion failed (may already be deleted):`, e.message);
            }
            user.googleCalendar.syncedTaskIds.delete(taskId);
            await user.save();
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
              console.log(`Auto-sync: Updated event ${existingEventId} for user ${user.username}`);
            } catch (e) {
              // If event doesn't exist, create new one
              if (e.code === 404) {
                const event = await calendar.events.insert({
                  calendarId: user.googleCalendar.calendarId,
                  resource: eventData
                });
                user.googleCalendar.syncedTaskIds.set(taskId, event.data.id);
                await user.save();
                console.log(`Auto-sync: Created new event (old was deleted) for user ${user.username}`);
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
            user.googleCalendar.syncedTaskIds.set(taskId, event.data.id);
            await user.save();
            console.log(`Auto-sync: Created event ${event.data.id} for user ${user.username}`);
          }
        }
      } catch (error) {
        console.error(`Auto-sync: Error syncing for user ${user.username}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Auto-sync: Error in autoSyncTaskToCalendar:', error.message);
  }
};

/**
 * Delete event from Google Calendar when task is removed
 * @param {string} taskId - ID of the task being deleted
 */
const autoDeleteTaskFromCalendar = async (taskId) => {
  await autoSyncTaskToCalendar({ id: taskId }, 'delete');
};

module.exports = router;
module.exports.autoSyncTaskToCalendar = autoSyncTaskToCalendar;
module.exports.autoDeleteTaskFromCalendar = autoDeleteTaskFromCalendar;
