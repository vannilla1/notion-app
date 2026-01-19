const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const User = require('../models/User');
const { autoSyncTaskToCalendar, autoDeleteTaskFromCalendar } = require('./googleCalendar');
const { autoSyncTaskToGoogleTasks, autoDeleteTaskFromGoogleTasks } = require('./googleTasks');

const router = express.Router();

// Helper to sync to both Google Calendar and Google Tasks
const autoSyncToGoogle = async (taskData, action) => {
  await Promise.all([
    autoSyncTaskToCalendar(taskData, action).catch(err =>
      console.error('Auto-sync Calendar error:', err.message)
    ),
    autoSyncTaskToGoogleTasks(taskData, action).catch(err =>
      console.error('Auto-sync Tasks error:', err.message)
    )
  ]);
};

const autoDeleteFromGoogle = async (taskId) => {
  await Promise.all([
    autoDeleteTaskFromCalendar(taskId).catch(err =>
      console.error('Auto-delete Calendar error:', err.message)
    ),
    autoDeleteTaskFromGoogleTasks(taskId).catch(err =>
      console.error('Auto-delete Tasks error:', err.message)
    )
  ]);
};

// Helper function to convert contact to plain object with deep copy of nested subtasks
const contactToPlainObject = (contact) => {
  const obj = contact.toObject ? contact.toObject() : contact;
  return JSON.parse(JSON.stringify({
    ...obj,
    id: obj._id ? obj._id.toString() : obj.id
  }));
};

// Helper function to deep copy a task with all nested subtasks
const taskToPlainObject = (task, extras = {}) => {
  const obj = task.toObject ? task.toObject() : task;
  return JSON.parse(JSON.stringify({
    ...obj,
    ...extras
  }));
};

// Helper function to find a subtask recursively
const findSubtaskRecursive = (subtasks, subtaskId) => {
  if (!subtasks) return null;
  for (let i = 0; i < subtasks.length; i++) {
    if (subtasks[i].id === subtaskId) {
      return { subtask: subtasks[i], parent: subtasks, index: i };
    }
    if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
      const found = findSubtaskRecursive(subtasks[i].subtasks, subtaskId);
      if (found) return found;
    }
  }
  return null;
};

// Helper function to populate assigned users info
const populateAssignedUsers = async (assignedToIds) => {
  if (!assignedToIds || assignedToIds.length === 0) return [];
  const users = await User.find({ _id: { $in: assignedToIds } }, 'username color avatar');
  return users.map(u => ({
    id: u._id.toString(),
    username: u.username,
    color: u.color,
    avatar: u.avatar
  }));
};

// Get all tasks (including tasks from contacts) - shared workspace
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Only get truly global tasks (without contact assignments)
    const globalTasks = await Task.find({
      $or: [
        { contactIds: { $exists: false } },
        { contactIds: { $size: 0 } },
        { contactIds: null }
      ],
      $and: [
        { $or: [{ contactId: { $exists: false } }, { contactId: null }, { contactId: '' }] }
      ]
    });
    const contacts = await Contact.find({});

    // Get all unique assigned user IDs for batch query
    const allAssignedIds = new Set();
    globalTasks.forEach(t => (t.assignedTo || []).forEach(id => allAssignedIds.add(id.toString())));
    contacts.forEach(c => (c.tasks || []).forEach(t => (t.assignedTo || []).forEach(id => allAssignedIds.add(id))));

    // Fetch all assigned users at once
    const assignedUsers = await User.find({ _id: { $in: Array.from(allAssignedIds) } }, 'username color avatar');
    const usersMap = {};
    assignedUsers.forEach(u => {
      usersMap[u._id.toString()] = {
        id: u._id.toString(),
        username: u.username,
        color: u.color,
        avatar: u.avatar
      };
    });

    // Enrich global tasks (these should have no contacts)
    const enrichedGlobalTasks = globalTasks.map(task => {
      const taskObj = task.toObject();
      taskObj.id = taskObj._id.toString();
      const assignedUsersList = (task.assignedTo || []).map(id => usersMap[id.toString()]).filter(Boolean);
      return {
        ...taskObj,
        contactIds: [],
        contactNames: [],
        contactName: null,
        source: 'global',
        assignedTo: (task.assignedTo || []).map(id => id.toString()),
        assignedUsers: assignedUsersList
      };
    });

    // Extract tasks from contacts
    const contactTasks = [];
    contacts.forEach(contact => {
      if (contact.tasks && contact.tasks.length > 0) {
        contact.tasks.forEach(task => {
          // Deep copy to ensure nested subtasks are properly included
          const taskObj = JSON.parse(JSON.stringify(task));
          const assignedUsersList = (task.assignedTo || []).map(id => usersMap[id]).filter(Boolean);
          contactTasks.push({
            ...taskObj,
            id: task.id,
            contactId: contact._id.toString(),
            contactName: contact.name,
            source: 'contact',
            assignedTo: task.assignedTo || [],
            assignedUsers: assignedUsersList
          });
        });
      }
    });

    // Combine all tasks
    const allTasks = [...enrichedGlobalTasks, ...contactTasks];

    // Sort by createdAt descending (newest first)
    allTasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(allTasks);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Export tasks to iCal format - MUST be before /:id route
// Query params:
//   - incremental=true: only export tasks not previously exported
//   - reset=true: reset export history and export all tasks
router.get('/export/calendar', authenticateToken, async (req, res) => {
  try {
    const { incremental, reset } = req.query;
    const userId = req.user.userId;

    // Get user to check previously exported task IDs
    const user = await User.findById(userId);
    let exportedTaskIds = user?.exportedTaskIds || [];

    // If reset requested, clear export history
    if (reset === 'true') {
      exportedTaskIds = [];
    }

    const contacts = await Contact.find({});
    const globalTasks = await Task.find({});
    const events = [];
    const newExportedIds = [];

    const formatICalDate = (dateString) => {
      const date = new Date(dateString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}${month}${day}`;
    };

    const createUID = (id) => `${id}@peruncrm`;

    // Check if task should be included (not already exported in incremental mode)
    const shouldIncludeTask = (taskId) => {
      if (incremental !== 'true') return true;
      return !exportedTaskIds.includes(taskId);
    };

    const collectSubtasks = (subtasks, parentTitle, contactName) => {
      if (!subtasks) return;
      for (const subtask of subtasks) {
        if (subtask.dueDate && !subtask.completed && shouldIncludeTask(subtask.id)) {
          events.push({
            uid: createUID(subtask.id),
            title: `${subtask.title} (${parentTitle})`,
            dueDate: subtask.dueDate,
            description: subtask.notes || '',
            contact: contactName
          });
          newExportedIds.push(subtask.id);
        }
        if (subtask.subtasks && subtask.subtasks.length > 0) {
          collectSubtasks(subtask.subtasks, parentTitle, contactName);
        }
      }
    };

    // Collect from global tasks
    for (const task of globalTasks) {
      const taskId = task._id.toString();
      if (task.dueDate && !task.completed && shouldIncludeTask(taskId)) {
        events.push({
          uid: createUID(taskId),
          title: task.title,
          dueDate: task.dueDate,
          description: task.description || '',
          contact: null
        });
        newExportedIds.push(taskId);
      }
      collectSubtasks(task.subtasks, task.title, null);
    }

    // Collect from contact tasks
    for (const contact of contacts) {
      if (contact.tasks) {
        for (const task of contact.tasks) {
          if (task.dueDate && !task.completed && shouldIncludeTask(task.id)) {
            events.push({
              uid: createUID(task.id),
              title: task.title,
              dueDate: task.dueDate,
              description: task.description || '',
              contact: contact.name
            });
            newExportedIds.push(task.id);
          }
          collectSubtasks(task.subtasks, task.title, contact.name);
        }
      }
    }

    let ical = 'BEGIN:VCALENDAR\r\n';
    ical += 'VERSION:2.0\r\n';
    ical += 'PRODID:-//Perun CRM//Task Calendar//SK\r\n';
    ical += 'CALSCALE:GREGORIAN\r\n';
    ical += 'METHOD:PUBLISH\r\n';
    ical += 'X-WR-CALNAME:Perun CRM Úlohy\r\n';

    const now = new Date();
    const dtstamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    for (const event of events) {
      const dateStr = formatICalDate(event.dueDate);

      // Use VTODO instead of VEVENT for tasks
      ical += 'BEGIN:VTODO\r\n';
      ical += `UID:${event.uid}\r\n`;
      ical += `DTSTAMP:${dtstamp}\r\n`;
      ical += `DUE;VALUE=DATE:${dateStr}\r\n`;
      ical += `SUMMARY:${event.title.replace(/[,;\\]/g, '\\$&')}\r\n`;
      if (event.description) {
        ical += `DESCRIPTION:${event.description.replace(/\n/g, '\\n').replace(/[,;\\]/g, '\\$&')}\r\n`;
      }
      if (event.contact) {
        ical += `CATEGORIES:${event.contact.replace(/[,;\\]/g, '\\$&')}\r\n`;
      }
      ical += `CREATED:${dtstamp}\r\n`;
      ical += `LAST-MODIFIED:${dtstamp}\r\n`;
      ical += 'STATUS:NEEDS-ACTION\r\n';
      ical += 'END:VTODO\r\n';
    }

    ical += 'END:VCALENDAR\r\n';

    // Update user's exported task IDs
    if (user && newExportedIds.length > 0) {
      const updatedExportedIds = reset === 'true'
        ? newExportedIds
        : [...new Set([...exportedTaskIds, ...newExportedIds])];

      await User.findByIdAndUpdate(userId, {
        exportedTaskIds: updatedExportedIds,
        lastCalendarExport: new Date()
      });
    }

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="perun-crm-tasks.ics"');
    res.send(ical);
  } catch (error) {
    console.error('Calendar export error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Generate or get calendar feed URL for user
router.post('/calendar/feed/generate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nenájdený' });
    }

    // Generate new token if doesn't exist
    let token = user.calendarFeedToken;
    if (!token) {
      token = uuidv4() + '-' + uuidv4(); // Extra long for security
      await User.findByIdAndUpdate(userId, {
        calendarFeedToken: token,
        calendarFeedEnabled: true,
        calendarFeedCreatedAt: new Date()
      });
    } else {
      // Just enable if exists
      await User.findByIdAndUpdate(userId, {
        calendarFeedEnabled: true
      });
    }

    const baseUrl = process.env.API_URL || 'https://perun-crm.onrender.com';
    const feedUrl = `${baseUrl}/api/tasks/calendar/feed/${token}`;

    res.json({
      feedUrl,
      enabled: true,
      message: 'Kalendár feed bol aktivovaný'
    });
  } catch (error) {
    console.error('Calendar feed generate error:', error);
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Get calendar feed status
router.get('/calendar/feed/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'Používateľ nenájdený' });
    }

    if (!user.calendarFeedToken) {
      return res.json({
        enabled: false,
        feedUrl: null
      });
    }

    const baseUrl = process.env.API_URL || 'https://perun-crm.onrender.com';
    const feedUrl = `${baseUrl}/api/tasks/calendar/feed/${user.calendarFeedToken}`;

    res.json({
      enabled: user.calendarFeedEnabled,
      feedUrl: user.calendarFeedEnabled ? feedUrl : null,
      createdAt: user.calendarFeedCreatedAt
    });
  } catch (error) {
    console.error('Calendar feed status error:', error);
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Disable calendar feed
router.post('/calendar/feed/disable', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    await User.findByIdAndUpdate(userId, {
      calendarFeedEnabled: false
    });

    res.json({
      enabled: false,
      message: 'Kalendár feed bol deaktivovaný'
    });
  } catch (error) {
    console.error('Calendar feed disable error:', error);
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Regenerate calendar feed token (invalidates old URL)
router.post('/calendar/feed/regenerate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const newToken = uuidv4() + '-' + uuidv4();

    await User.findByIdAndUpdate(userId, {
      calendarFeedToken: newToken,
      calendarFeedEnabled: true,
      calendarFeedCreatedAt: new Date()
    });

    const baseUrl = process.env.API_URL || 'https://perun-crm.onrender.com';
    const feedUrl = `${baseUrl}/api/tasks/calendar/feed/${newToken}`;

    res.json({
      feedUrl,
      enabled: true,
      message: 'Nový kalendár feed bol vygenerovaný'
    });
  } catch (error) {
    console.error('Calendar feed regenerate error:', error);
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Public calendar feed endpoint (no auth required, uses token)
router.get('/calendar/feed/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Find user by feed token
    const user = await User.findOne({ calendarFeedToken: token, calendarFeedEnabled: true });

    if (!user) {
      return res.status(404).send('Kalendár feed nebol nájdený alebo je deaktivovaný');
    }

    // Get all tasks for this user
    const globalTasks = await Task.find({});
    const contacts = await Contact.find({});

    const events = [];

    const formatICalDate = (dateString) => {
      const date = new Date(dateString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}${month}${day}`;
    };

    const formatICalDateTime = (dateString) => {
      const date = new Date(dateString);
      return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    };

    const createUID = (id) => `${id}@peruncrm`;

    const getPriorityValue = (priority) => {
      // iCal priority: 1-4 high, 5 medium, 6-9 low
      switch (priority) {
        case 'high': return 1;
        case 'medium': return 5;
        case 'low': return 9;
        default: return 5;
      }
    };

    const collectSubtasks = (subtasks, parentTitle, contactName, parentPriority) => {
      if (!subtasks) return;
      for (const subtask of subtasks) {
        if (subtask.dueDate) {
          events.push({
            uid: createUID(subtask.id),
            title: `${subtask.title} (${parentTitle})`,
            dueDate: subtask.dueDate,
            description: subtask.notes || '',
            contact: contactName,
            completed: subtask.completed,
            priority: parentPriority,
            createdAt: subtask.createdAt,
            updatedAt: subtask.updatedAt
          });
        }
        if (subtask.subtasks && subtask.subtasks.length > 0) {
          collectSubtasks(subtask.subtasks, parentTitle, contactName, parentPriority);
        }
      }
    };

    // Collect from global tasks
    console.log('Calendar feed - Global tasks count:', globalTasks.length);
    for (const task of globalTasks) {
      const taskId = task._id.toString();
      console.log('Calendar feed - Task:', task.title, 'dueDate:', task.dueDate);
      if (task.dueDate) {
        events.push({
          uid: createUID(taskId),
          title: task.title,
          dueDate: task.dueDate,
          description: task.description || '',
          contact: null,
          completed: task.completed,
          priority: task.priority || 'medium',
          createdAt: task.createdAt,
          updatedAt: task.updatedAt
        });
      }
      collectSubtasks(task.subtasks, task.title, null, task.priority || 'medium');
    }

    // Collect from contact tasks
    console.log('Calendar feed - Contacts count:', contacts.length);
    for (const contact of contacts) {
      if (contact.tasks) {
        console.log('Calendar feed - Contact:', contact.name, 'tasks:', contact.tasks.length);
        for (const task of contact.tasks) {
          console.log('Calendar feed - Contact task:', task.title, 'dueDate:', task.dueDate);
          if (task.dueDate) {
            events.push({
              uid: createUID(task.id),
              title: task.title,
              dueDate: task.dueDate,
              description: task.description || '',
              contact: contact.name,
              completed: task.completed,
              priority: task.priority || 'medium',
              createdAt: task.createdAt,
              updatedAt: task.updatedAt
            });
          }
          collectSubtasks(task.subtasks, task.title, contact.name, task.priority || 'medium');
        }
      }
    }

    console.log('Calendar feed - Total events:', events.length);

    // Build iCal feed with VTODO (tasks) instead of VEVENT (events)
    let ical = 'BEGIN:VCALENDAR\r\n';
    ical += 'VERSION:2.0\r\n';
    ical += 'PRODID:-//Perun CRM//Task Calendar//SK\r\n';
    ical += 'CALSCALE:GREGORIAN\r\n';
    ical += 'METHOD:PUBLISH\r\n';
    ical += 'X-WR-CALNAME:Perun CRM - Úlohy\r\n';
    ical += 'X-WR-TIMEZONE:Europe/Bratislava\r\n';
    ical += 'REFRESH-INTERVAL;VALUE=DURATION:PT15M\r\n'; // Suggest 15 min refresh
    ical += 'X-PUBLISHED-TTL:PT15M\r\n';

    const now = new Date();
    const dtstamp = formatICalDateTime(now.toISOString());

    for (const event of events) {
      const dateStr = formatICalDate(event.dueDate);

      // Escape special characters
      const escapeText = (text) => {
        if (!text) return '';
        return text
          .replace(/\\/g, '\\\\')
          .replace(/;/g, '\\;')
          .replace(/,/g, '\\,')
          .replace(/\n/g, '\\n');
      };

      // Build description with metadata
      let description = '';
      if (event.description) {
        description += event.description;
      }
      if (event.contact) {
        description += description ? '\\n\\n' : '';
        description += `Kontakt: ${event.contact}`;
      }

      // Use VTODO instead of VEVENT for tasks
      ical += 'BEGIN:VTODO\r\n';
      ical += `UID:${event.uid}\r\n`;
      ical += `DTSTAMP:${dtstamp}\r\n`;
      ical += `DUE;VALUE=DATE:${dateStr}\r\n`;
      ical += `SUMMARY:${escapeText(event.title)}\r\n`;
      if (description) {
        ical += `DESCRIPTION:${escapeText(description)}\r\n`;
      }
      if (event.contact) {
        ical += `CATEGORIES:${escapeText(event.contact)}\r\n`;
      }
      ical += `PRIORITY:${getPriorityValue(event.priority)}\r\n`;
      if (event.completed) {
        ical += 'STATUS:COMPLETED\r\n';
        ical += 'PERCENT-COMPLETE:100\r\n';
      } else {
        ical += 'STATUS:NEEDS-ACTION\r\n';
        ical += 'PERCENT-COMPLETE:0\r\n';
      }
      if (event.createdAt) {
        ical += `CREATED:${formatICalDateTime(event.createdAt)}\r\n`;
      }
      if (event.updatedAt) {
        ical += `LAST-MODIFIED:${formatICalDateTime(event.updatedAt)}\r\n`;
      }
      ical += 'END:VTODO\r\n';
    }

    ical += 'END:VCALENDAR\r\n';

    // Set headers for calendar subscription
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="perun-crm-tasks.ics"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(ical);
  } catch (error) {
    console.error('Calendar feed error:', error);
    res.status(500).send('Chyba pri generovaní kalendára');
  }
});

// Get single task (from global tasks or contacts)
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    // First check global tasks
    const task = await Task.findById(req.params.id);
    if (task) {
      return res.json(taskToPlainObject(task, { source: 'global', id: task._id.toString() }));
    }

    // Check tasks in contacts
    const contacts = await Contact.find({});
    for (const contact of contacts) {
      if (contact.tasks) {
        const foundTask = contact.tasks.find(t => t.id === req.params.id);
        if (foundTask) {
          return res.json(taskToPlainObject(foundTask, {
            contactId: contact._id.toString(),
            contactName: contact.name,
            source: 'contact'
          }));
        }
      }
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Helper function to clone subtasks with new IDs
// BUGFIX: Added priority field preservation and input validation
const cloneSubtasksWithNewIds = (subtasks) => {
  if (!subtasks || !Array.isArray(subtasks)) return [];
  return subtasks.map(subtask => {
    // Validate subtask object
    if (!subtask || typeof subtask !== 'object') return null;
    const now = new Date().toISOString();
    return {
      id: uuidv4(),
      title: subtask.title || '',
      completed: subtask.completed || false,
      dueDate: subtask.dueDate || null,
      notes: subtask.notes || '',
      priority: subtask.priority || null, // Preserve priority
      subtasks: cloneSubtasksWithNewIds(subtask.subtasks),
      createdAt: now,
      modifiedAt: now // Set on creation for "new" filter
    };
  }).filter(Boolean); // Remove null entries from invalid subtasks
};

// Create task - creates independent embedded tasks in each selected contact
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, description, dueDate, priority, contactId, contactIds, subtasks, assignedTo } = req.body;
    const io = req.app.get('io');

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Názov úlohy je povinný' });
    }

    // Support both old contactId (single) and new contactIds (array)
    let finalContactIds = [];
    if (contactIds && Array.isArray(contactIds) && contactIds.length > 0) {
      finalContactIds = contactIds;
    } else if (contactId) {
      finalContactIds = [contactId];
    }

    // If no contacts selected, create as global task
    if (finalContactIds.length === 0) {
      const task = new Task({
        userId: req.user.id,
        title: title.trim(),
        description: description || '',
        dueDate: dueDate || null,
        priority: priority || 'medium',
        completed: false,
        contactIds: [],
        assignedTo: assignedTo || [],
        subtasks: cloneSubtasksWithNewIds(subtasks),
        createdBy: req.user.username,
        modifiedAt: new Date().toISOString() // Set on creation for "new" filter
      });

      await task.save();

      // Get assigned users info
      const assignedUsers = await populateAssignedUsers(task.assignedTo);

      const taskObj = task.toObject();
      taskObj.id = taskObj._id.toString();
      taskObj.contactIds = [];
      taskObj.contactNames = [];
      taskObj.contactName = null;
      taskObj.source = 'global';
      taskObj.assignedTo = (task.assignedTo || []).map(id => id.toString());
      taskObj.assignedUsers = assignedUsers;

      io.emit('task-created', taskObj);

      // Auto-sync to Google Calendar
      autoSyncToGoogle(taskObj, 'create');

      return res.status(201).json(taskObj);
    }

    // Create independent embedded task in each selected contact
    const createdTasks = [];
    const updatedContacts = [];

    for (const cId of finalContactIds) {
      const contact = await Contact.findById(cId);
      if (!contact) continue;

      // Create new embedded task for this contact
      const newTask = {
        id: uuidv4(),
        title: title.trim(),
        description: description || '',
        completed: false,
        priority: priority || 'medium',
        dueDate: dueDate || null,
        assignedTo: assignedTo || [],
        subtasks: cloneSubtasksWithNewIds(subtasks),
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString() // Set on creation for "new" filter
      };

      // Ensure tasks array exists
      if (!contact.tasks) {
        contact.tasks = [];
      }
      contact.tasks.push(newTask);
      contact.markModified('tasks');
      await contact.save();

      // Get assigned users info
      const assignedUsers = await populateAssignedUsers(assignedTo);
      createdTasks.push({ ...newTask, contactId: contact._id.toString(), contactName: contact.name, source: 'contact', assignedUsers });
      updatedContacts.push(contact);
    }

    // Emit updates for all affected contacts
    for (const contact of updatedContacts) {
      io.emit('contact-updated', contactToPlainObject(contact));
    }

    // Emit task-created for each new task so Tasks view updates in real-time
    for (const task of createdTasks) {
      io.emit('task-created', task);
      // Auto-sync to Google Calendar
      autoSyncToGoogle(task, 'create');
    }

    // Return first task for compatibility (or all tasks info)
    if (createdTasks.length === 1) {
      res.status(201).json(createdTasks[0]);
    } else {
      res.status(201).json({
        createdCount: createdTasks.length,
        tasks: createdTasks,
        message: `Úloha bola vytvorená v ${createdTasks.length} kontaktoch`
      });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Helper function to sync all subtasks to Google when parent title changes
const syncSubtasksToGoogle = async (subtasks, parentTitle, contactName) => {
  if (!subtasks || subtasks.length === 0) return;

  for (const subtask of subtasks) {
    // Only sync subtasks that have a due date
    if (subtask.dueDate) {
      autoSyncToGoogle({
        id: subtask.id,
        title: `${subtask.title} (${parentTitle})`,
        description: subtask.notes || '',
        dueDate: subtask.dueDate,
        completed: subtask.completed,
        priority: subtask.priority,
        contactName: contactName
      }, 'update');
    }

    // Recursively sync nested subtasks
    if (subtask.subtasks && subtask.subtasks.length > 0) {
      await syncSubtasksToGoogle(subtask.subtasks, parentTitle, contactName);
    }
  }
};

// Update task (global or from contact)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { title, description, dueDate, priority, completed, contactId, contactIds, source, assignedTo } = req.body;
    const io = req.app.get('io');

    // If source is 'contact', update in contacts
    if (source === 'contact') {
      const contacts = await Contact.find({});
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.id);
          if (taskIndex !== -1) {
            const task = contact.tasks[taskIndex];
            contact.tasks[taskIndex] = {
              ...task,
              id: task.id,
              title: title !== undefined ? title : task.title,
              description: description !== undefined ? description : task.description,
              dueDate: dueDate !== undefined ? dueDate : task.dueDate,
              priority: priority !== undefined ? priority : task.priority,
              completed: completed !== undefined ? completed : task.completed,
              assignedTo: assignedTo !== undefined ? assignedTo : task.assignedTo,
              subtasks: req.body.subtasks !== undefined ? req.body.subtasks : task.subtasks,
              createdAt: task.createdAt,
              modifiedAt: new Date().toISOString()
            };
            contact.markModified('tasks');
            await contact.save();

            io.emit('contact-updated', contactToPlainObject(contact));
            const assignedUsers = await populateAssignedUsers(contact.tasks[taskIndex].assignedTo);
            const taskData = taskToPlainObject(contact.tasks[taskIndex], {
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact',
              assignedUsers
            });
            io.emit('task-updated', taskData);

            // Auto-sync to Google Calendar
            autoSyncToGoogle(taskData, 'update');

            // If title changed, also update all subtasks in calendar (they have parent title in their name)
            // Note: 'task' is the original task before update, so we compare new title with original
            const originalTitle = task.title;
            if (title !== undefined && title !== originalTitle) {
              const newTitle = title;
              const subtasks = contact.tasks[taskIndex].subtasks;
              console.log(`Auto-sync: Parent task title changed from "${originalTitle}" to "${newTitle}", updating ${(subtasks || []).length} subtasks in calendar`);
              syncSubtasksToGoogle(subtasks, newTitle, contact.name).catch(err =>
                console.error('Auto-sync error updating subtasks after parent title change (contact):', err.message)
              );
            }

            return res.json(taskData);
          }
        }
      }
      return res.status(404).json({ message: 'Task not found in contacts' });
    }

    // Try to update global task
    let task = await Task.findById(req.params.id);

    if (task) {
      // Support both old contactId and new contactIds
      let finalContactIds = task.contactIds || [];
      let contactNames = [];

      if (contactIds !== undefined) {
        finalContactIds = Array.isArray(contactIds) ? contactIds : [];
        if (finalContactIds.length > 0) {
          const contacts = await Contact.find({ _id: { $in: finalContactIds } });
          contactNames = contacts.map(c => c.name);
        }
      } else if (contactId !== undefined) {
        finalContactIds = contactId ? [contactId] : [];
        if (contactId) {
          const contact = await Contact.findById(contactId);
          if (contact) {
            contactNames = [contact.name];
          }
        }
      } else {
        // Keep existing and fetch names
        if (finalContactIds.length > 0) {
          const contacts = await Contact.find({ _id: { $in: finalContactIds } });
          contactNames = contacts.map(c => c.name);
        }
      }

      // Save original title before update to detect title change
      const originalTitle = task.title;

      task.title = title !== undefined ? title : task.title;
      task.description = description !== undefined ? description : task.description;
      task.dueDate = dueDate !== undefined ? dueDate : task.dueDate;
      task.priority = priority !== undefined ? priority : task.priority;
      task.completed = completed !== undefined ? completed : task.completed;
      task.contactIds = finalContactIds;
      task.assignedTo = assignedTo !== undefined ? assignedTo : task.assignedTo;
      task.modifiedAt = new Date().toISOString();
      // Preserve subtasks if not explicitly provided
      if (req.body.subtasks !== undefined) {
        task.subtasks = req.body.subtasks;
      }

      await task.save();

      const assignedUsers = await populateAssignedUsers(task.assignedTo);
      const taskData = taskToPlainObject(task, {
        source: 'global',
        id: task._id.toString(),
        contactIds: finalContactIds,
        contactNames: contactNames,
        contactName: contactNames.join(', ') || null,
        assignedTo: (task.assignedTo || []).map(id => id.toString()),
        assignedUsers
      });

      io.emit('task-updated', taskData);

      // Auto-sync to Google Calendar
      autoSyncToGoogle(taskData, 'update');

      // If title changed, also update all subtasks in calendar (they have parent title in their name)
      if (title !== undefined && title !== originalTitle) {
        const newTitle = title;
        const subtasks = task.subtasks;
        console.log(`Auto-sync: Parent task title changed from "${originalTitle}" to "${newTitle}", updating ${(subtasks || []).length} subtasks in calendar`);
        syncSubtasksToGoogle(subtasks, newTitle, null).catch(err =>
          console.error('Auto-sync error updating subtasks after parent title change (global):', err.message)
        );
      }

      return res.json(taskData);
    }

    // Task not found in global tasks, try to find in contacts
    const contacts = await Contact.find({});
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.id);
        if (taskIndex !== -1) {
          const ctask = contact.tasks[taskIndex];
          // Save original title before update to detect title change
          const originalCtaskTitle = ctask.title;
          contact.tasks[taskIndex] = {
            ...ctask,
            id: ctask.id,
            title: title !== undefined ? title : ctask.title,
            description: description !== undefined ? description : ctask.description,
            dueDate: dueDate !== undefined ? dueDate : ctask.dueDate,
            priority: priority !== undefined ? priority : ctask.priority,
            completed: completed !== undefined ? completed : ctask.completed,
            subtasks: req.body.subtasks !== undefined ? req.body.subtasks : ctask.subtasks,
            createdAt: ctask.createdAt
          };
          contact.markModified('tasks');
          await contact.save();

          io.emit('contact-updated', contactToPlainObject(contact));
          const taskData = taskToPlainObject(contact.tasks[taskIndex], {
            contactId: contact._id.toString(),
            contactName: contact.name,
            source: 'contact'
          });
          io.emit('task-updated', taskData);

          // Auto-sync to Google Calendar
          autoSyncToGoogle(taskData, 'update');

          // If title changed, also update all subtasks in calendar (they have parent title in their name)
          if (title !== undefined && title !== originalCtaskTitle) {
            const newTitle = title;
            const subtasks = contact.tasks[taskIndex].subtasks;
            console.log(`Auto-sync: Parent task title changed from "${originalCtaskTitle}" to "${newTitle}", updating ${(subtasks || []).length} subtasks in calendar (fallback)`);
            syncSubtasksToGoogle(subtasks, newTitle, contact.name).catch(err =>
              console.error('Auto-sync error updating subtasks after parent title change (contact fallback):', err.message)
            );
          }

          return res.json(taskData);
        }
      }
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete task (global or from contact)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const io = req.app.get('io');
    const source = req.query.source;

    // If source is 'contact', delete from contacts
    if (source === 'contact') {
      const contacts = await Contact.find({});
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.id);
          if (taskIndex !== -1) {
            contact.tasks.splice(taskIndex, 1);
            contact.markModified('tasks');
            await contact.save();

            io.emit('contact-updated', contactToPlainObject(contact));
            io.emit('task-deleted', { id: req.params.id, source: 'contact' });

            // Auto-delete from Google Calendar
            autoDeleteFromGoogle(req.params.id);

            return res.json({ message: 'Task deleted' });
          }
        }
      }
      return res.status(404).json({ message: 'Task not found in contacts' });
    }

    // Try to delete from global tasks first
    const task = await Task.findByIdAndDelete(req.params.id);
    if (task) {
      io.emit('task-deleted', { id: req.params.id, source: 'global' });

      // Auto-delete from Google Calendar
      autoDeleteFromGoogle(req.params.id);

      return res.json({ message: 'Task deleted' });
    }

    // If not found in global tasks, try contacts
    const contacts = await Contact.find({});
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.id);
        if (taskIndex !== -1) {
          contact.tasks.splice(taskIndex, 1);
          contact.markModified('tasks');
          await contact.save();

          io.emit('contact-updated', contactToPlainObject(contact));
          io.emit('task-deleted', { id: req.params.id, source: 'contact' });

          // Auto-delete from Google Calendar
          autoDeleteFromGoogle(req.params.id);

          return res.json({ message: 'Task deleted' });
        }
      }
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== DUPLICATE TASK ====================

// Helper function to duplicate subtasks recursively with new IDs
// BUGFIX: Added priority field preservation and input validation
const duplicateSubtasksRecursive = (subtasks) => {
  if (!subtasks || !Array.isArray(subtasks)) return [];
  return subtasks.map(subtask => {
    // Validate subtask object
    if (!subtask || typeof subtask !== 'object') return null;
    const now = new Date().toISOString();
    return {
      id: uuidv4(),
      title: subtask.title || '',
      completed: false,
      dueDate: subtask.dueDate || null,
      notes: subtask.notes || '',
      priority: subtask.priority || null, // Preserve priority
      subtasks: duplicateSubtasksRecursive(subtask.subtasks),
      createdAt: now,
      modifiedAt: now // Set on creation for "new" filter
    };
  }).filter(Boolean); // Remove null entries from invalid subtasks
};

// Duplicate task with new contact assignment - creates independent embedded tasks in each contact
router.post('/:id/duplicate', authenticateToken, async (req, res) => {
  try {
    const { contactIds, source } = req.body;
    const io = req.app.get('io');
    const mongoose = require('mongoose');

    let originalTask = null;

    // Check if ID is valid MongoDB ObjectId
    const isValidObjectId = mongoose.Types.ObjectId.isValid(req.params.id);

    // Find original task - check global tasks first (only if valid ObjectId)
    if (isValidObjectId) {
      const globalTask = await Task.findById(req.params.id);
      if (globalTask) {
        // Deep copy to ensure subtasks are properly copied
        originalTask = JSON.parse(JSON.stringify(globalTask.toObject()));
        originalTask.source = 'global';
      }
    }

    // If not found in global tasks, search in contacts
    if (!originalTask) {
      const allContacts = await Contact.find({});
      for (const contact of allContacts) {
        if (contact.tasks && contact.tasks.length > 0) {
          const found = contact.tasks.find(t => t.id === req.params.id);
          if (found) {
            // Deep copy the task to ensure subtasks are properly copied
            originalTask = JSON.parse(JSON.stringify(found));
            originalTask.source = 'contact';
            break;
          }
        }
      }
    }

    if (!originalTask) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const finalContactIds = contactIds && Array.isArray(contactIds) ? contactIds : [];

    if (finalContactIds.length === 0) {
      // No contacts selected - create as global task
      const duplicatedTask = new Task({
        userId: req.user.id,
        title: originalTask.title + ' (kópia)',
        description: originalTask.description || '',
        dueDate: originalTask.dueDate || null,
        priority: originalTask.priority || 'medium',
        completed: false,
        contactIds: [],
        subtasks: duplicateSubtasksRecursive(originalTask.subtasks),
        createdBy: req.user.username,
        modifiedAt: new Date().toISOString() // Set on creation for "new" filter
      });

      await duplicatedTask.save();

      const taskObj = duplicatedTask.toObject();
      taskObj.id = taskObj._id.toString();
      taskObj.contactIds = [];
      taskObj.contactNames = [];
      taskObj.contactName = null;
      taskObj.source = 'global';

      io.emit('task-created', taskObj);

      return res.status(201).json({ duplicatedCount: 1, tasks: [taskObj] });
    }

    // Create independent embedded task in each selected contact
    const duplicatedTasks = [];
    const updatedContacts = [];

    for (const contactId of finalContactIds) {
      const contact = await Contact.findById(contactId);
      if (!contact) continue;

      // Create new embedded task for this contact
      const now = new Date().toISOString();
      const newTask = {
        id: uuidv4(),
        title: originalTask.title + ' (kópia)',
        description: originalTask.description || '',
        completed: false,
        priority: originalTask.priority || 'medium',
        dueDate: originalTask.dueDate || null,
        subtasks: duplicateSubtasksRecursive(originalTask.subtasks),
        createdAt: now,
        modifiedAt: now // Set on creation for "new" filter
      };

      // Ensure tasks array exists
      if (!contact.tasks) {
        contact.tasks = [];
      }

      contact.tasks.push(newTask);
      contact.markModified('tasks');
      await contact.save();

      duplicatedTasks.push({ ...newTask, contactId: contact._id.toString(), contactName: contact.name });
      updatedContacts.push(contact);
    }

    // Emit updates for all affected contacts
    for (const contact of updatedContacts) {
      io.emit('contact-updated', contactToPlainObject(contact));
    }

    res.status(201).json({
      duplicatedCount: duplicatedTasks.length,
      tasks: duplicatedTasks,
      message: `Úloha bola duplikovaná do ${duplicatedTasks.length} kontaktov`
    });
  } catch (error) {
    console.error('Duplicate task error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== SUBTASKS (RECURSIVE) ====================

// Add subtask to task (global or from contact)
router.post('/:taskId/subtasks', authenticateToken, async (req, res) => {
  try {
    const { title, source, parentSubtaskId, dueDate, notes, priority, assignedTo } = req.body;
    const io = req.app.get('io');

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Nazov podulohy je povinny' });
    }

    // BUGFIX: Added priority field support for subtasks
    const now = new Date().toISOString();
    const subtask = {
      id: uuidv4(),
      title: title.trim(),
      completed: false,
      dueDate: dueDate || null,
      notes: notes || '',
      priority: priority || null,
      subtasks: [],
      assignedTo: assignedTo || [],
      createdAt: now,
      modifiedAt: now // Set on creation for "new" filter
    };

    // Helper to add subtask to parent (task or subtask)
    const addToParent = (task) => {
      if (parentSubtaskId) {
        const found = findSubtaskRecursive(task.subtasks, parentSubtaskId);
        if (found) {
          if (!found.subtask.subtasks) {
            found.subtask.subtasks = [];
          }
          found.subtask.subtasks.push(subtask);
          // Update parent subtask's modifiedAt when child is added
          found.subtask.modifiedAt = now;
          return true;
        }
        return false;
      } else {
        if (!task.subtasks) {
          task.subtasks = [];
        }
        task.subtasks.push(subtask);
        return true;
      }
      // Note: Parent task's modifiedAt is updated after this function returns
    };

    // If source is specified as contact, look in contacts first
    if (source === 'contact') {
      const contacts = await Contact.find({});
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
          if (taskIndex !== -1) {
            if (addToParent(contact.tasks[taskIndex])) {
              // Update parent task's modifiedAt when subtask is added
              contact.tasks[taskIndex].modifiedAt = now;
              contact.markModified('tasks');
              await contact.save();

              io.emit('contact-updated', contactToPlainObject(contact));
              io.emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
                contactId: contact._id.toString(),
                contactName: contact.name,
                source: 'contact'
              }));

              // Auto-sync subtask to Google
              if (subtask.dueDate) {
                autoSyncToGoogle({
                  id: subtask.id,
                  title: `${subtask.title} (${contact.tasks[taskIndex].title})`,
                  description: subtask.notes || '',
                  dueDate: subtask.dueDate,
                  completed: subtask.completed,
                  priority: subtask.priority,
                  contactName: contact.name
                }, 'create');
              }

              return res.status(201).json(subtask);
            }
          }
        }
      }
    }

    // Try global tasks
    const task = await Task.findById(req.params.taskId);
    if (task) {
      if (addToParent(task)) {
        // Update parent task's modifiedAt when subtask is added
        task.modifiedAt = now;
        task.markModified('subtasks');
        await task.save();

        io.emit('task-updated', taskToPlainObject(task, { source: 'global', id: task._id.toString() }));

        // Auto-sync subtask to Google
        if (subtask.dueDate) {
          autoSyncToGoogle({
            id: subtask.id,
            title: `${subtask.title} (${task.title})`,
            description: subtask.notes || '',
            dueDate: subtask.dueDate,
            completed: subtask.completed,
            priority: subtask.priority,
            contactName: null
          }, 'create');
        }

        return res.status(201).json(subtask);
      }
      return res.status(404).json({ message: 'Parent subtask not found' });
    }

    // If not found in global, search in contacts
    const contacts = await Contact.find({});
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
        if (taskIndex !== -1) {
          if (addToParent(contact.tasks[taskIndex])) {
            // Update parent task's modifiedAt when subtask is added
            contact.tasks[taskIndex].modifiedAt = now;
            contact.markModified('tasks');
            await contact.save();

            io.emit('contact-updated', contactToPlainObject(contact));
            io.emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            }));

            // Auto-sync subtask to Google
            if (subtask.dueDate) {
              autoSyncToGoogle({
                id: subtask.id,
                title: `${subtask.title} (${contact.tasks[taskIndex].title})`,
                description: subtask.notes || '',
                dueDate: subtask.dueDate,
                completed: subtask.completed,
                priority: subtask.priority,
                contactName: contact.name
              }, 'create');
            }

            return res.status(201).json(subtask);
          }
          return res.status(404).json({ message: 'Parent subtask not found' });
        }
      }
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update subtask (global or from contact)
router.put('/:taskId/subtasks/:subtaskId', authenticateToken, async (req, res) => {
  try {
    const { title, completed, source, dueDate, notes, assignedTo } = req.body;
    const io = req.app.get('io');

    // Helper to update subtask recursively
    // BUGFIX: Preserve all existing fields including priority and nested subtasks
    const updateSubtaskInTask = (task) => {
      const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);
      if (found) {
        found.parent[found.index] = {
          ...found.subtask,
          id: found.subtask.id, // Ensure ID is preserved
          title: title !== undefined ? title : found.subtask.title,
          completed: completed !== undefined ? completed : found.subtask.completed,
          dueDate: dueDate !== undefined ? dueDate : found.subtask.dueDate,
          notes: notes !== undefined ? notes : found.subtask.notes,
          priority: found.subtask.priority, // Preserve priority
          assignedTo: assignedTo !== undefined ? assignedTo : (found.subtask.assignedTo || []),
          subtasks: found.subtask.subtasks || [], // Preserve nested subtasks
          createdAt: found.subtask.createdAt, // Preserve createdAt
          modifiedAt: new Date().toISOString() // Set modification timestamp
        };
        return found.parent[found.index];
      }
      return null;
    };

    // If source is contact, look in contacts
    if (source === 'contact') {
      const contacts = await Contact.find({});
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
          if (taskIndex !== -1) {
            const updated = updateSubtaskInTask(contact.tasks[taskIndex]);
            if (updated) {
              contact.markModified('tasks');
              await contact.save();

              io.emit('contact-updated', contactToPlainObject(contact));
              io.emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
                contactId: contact._id.toString(),
                contactName: contact.name,
                source: 'contact'
              }));

              // Auto-sync subtask to Google
              autoSyncToGoogle({
                id: updated.id,
                title: `${updated.title} (${contact.tasks[taskIndex].title})`,
                description: updated.notes || '',
                dueDate: updated.dueDate,
                completed: updated.completed,
                priority: updated.priority,
                contactName: contact.name
              }, 'update');

              return res.json(updated);
            }
          }
        }
      }
    }

    // Try global tasks
    const task = await Task.findById(req.params.taskId);
    if (task) {
      const updated = updateSubtaskInTask(task);
      if (updated) {
        task.markModified('subtasks');
        await task.save();

        io.emit('task-updated', taskToPlainObject(task, { source: 'global', id: task._id.toString() }));

        // Auto-sync subtask to Google
        autoSyncToGoogle({
          id: updated.id,
          title: `${updated.title} (${task.title})`,
          description: updated.notes || '',
          dueDate: updated.dueDate,
          completed: updated.completed,
          priority: updated.priority,
          contactName: null
        }, 'update');

        return res.json(updated);
      }
    }

    // Search in contacts
    const contacts = await Contact.find({});
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
        if (taskIndex !== -1) {
          const updated = updateSubtaskInTask(contact.tasks[taskIndex]);
          if (updated) {
            contact.markModified('tasks');
            await contact.save();

            io.emit('contact-updated', contactToPlainObject(contact));
            io.emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            }));

            // Auto-sync subtask to Google
            autoSyncToGoogle({
              id: updated.id,
              title: `${updated.title} (${contact.tasks[taskIndex].title})`,
              description: updated.notes || '',
              dueDate: updated.dueDate,
              completed: updated.completed,
              priority: updated.priority,
              contactName: contact.name
            }, 'update');

            return res.json(updated);
          }
        }
      }
    }

    return res.status(404).json({ message: 'Task or subtask not found' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete subtask (global or from contact)
router.delete('/:taskId/subtasks/:subtaskId', authenticateToken, async (req, res) => {
  try {
    const io = req.app.get('io');
    const source = req.query.source;

    // Helper to delete subtask recursively
    const deleteSubtaskInTask = (task) => {
      const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);
      if (found) {
        found.parent.splice(found.index, 1);
        return true;
      }
      return false;
    };

    // If source is contact, look in contacts
    if (source === 'contact') {
      const contacts = await Contact.find({});
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
          if (taskIndex !== -1) {
            if (deleteSubtaskInTask(contact.tasks[taskIndex])) {
              contact.markModified('tasks');
              await contact.save();

              io.emit('contact-updated', contactToPlainObject(contact));
              io.emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
                contactId: contact._id.toString(),
                contactName: contact.name,
                source: 'contact'
              }));

              // Auto-delete subtask from Google
              autoDeleteFromGoogle(req.params.subtaskId);

              return res.json({ message: 'Subtask deleted' });
            }
          }
        }
      }
    }

    // Try global tasks
    const task = await Task.findById(req.params.taskId);
    if (task) {
      if (deleteSubtaskInTask(task)) {
        task.markModified('subtasks');
        await task.save();

        io.emit('task-updated', taskToPlainObject(task, { source: 'global', id: task._id.toString() }));

        // Auto-delete subtask from Google
        autoDeleteFromGoogle(req.params.subtaskId);

        return res.json({ message: 'Subtask deleted' });
      }
    }

    // Search in contacts
    const contacts = await Contact.find({});
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
        if (taskIndex !== -1) {
          if (deleteSubtaskInTask(contact.tasks[taskIndex])) {
            contact.markModified('tasks');
            await contact.save();

            io.emit('contact-updated', contactToPlainObject(contact));
            io.emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            }));

            // Auto-delete subtask from Google
            autoDeleteFromGoogle(req.params.subtaskId);

            return res.json({ message: 'Subtask deleted' });
          }
        }
      }
    }

    return res.status(404).json({ message: 'Task or subtask not found' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
