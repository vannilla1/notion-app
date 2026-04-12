const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace, enforceWorkspaceLimits } = require('../middleware/workspace');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const ContactFile = require('../models/ContactFile');
const User = require('../models/User');

// Projection to exclude Base64 file data from all nesting levels (up to 6 deep)
const EXCLUDE_FILE_DATA = {
  'files.data': 0,
  'tasks.files.data': 0,
  'tasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.subtasks.subtasks.files.data': 0,
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedExtensions = /jpeg|jpg|png|gif|bmp|webp|svg|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|json|xml|zip|rar|7z|mp3|mp4|wav|avi|mov/;
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (allowedExtensions.test(ext)) return cb(null, true);
    cb(new Error('Nepovolený typ súboru'));
  }
});
const { autoSyncTaskToCalendar, autoDeleteTaskFromCalendar } = require('./googleCalendar');
const { autoSyncTaskToGoogleTasks, autoDeleteTaskFromGoogleTasks } = require('./googleTasks');
const notificationService = require('../services/notificationService');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');

const router = express.Router();

// Helper to sync to both Google Calendar and Google Tasks
const autoSyncToGoogle = async (taskData, action) => {
  await Promise.all([
    autoSyncTaskToCalendar(taskData, action).catch(err =>
      logger.warn('Auto-sync Calendar error', { error: err.message })
    ),
    autoSyncTaskToGoogleTasks(taskData, action).catch(err =>
      logger.warn('Auto-sync Tasks error', { error: err.message })
    )
  ]);
};

const autoDeleteFromGoogle = async (taskId) => {
  await Promise.all([
    autoDeleteTaskFromCalendar(taskId).catch(err =>
      logger.warn('Auto-delete Calendar error', { error: err.message })
    ),
    autoDeleteTaskFromGoogleTasks(taskId).catch(err =>
      logger.warn('Auto-delete Tasks error', { error: err.message })
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

// Helper: check if all subtasks are completed (recursive)
const allSubtasksCompleted = (subtasks) => {
  if (!subtasks || subtasks.length === 0) return false;
  for (const sub of subtasks) {
    if (!sub.completed) return false;
    if (sub.subtasks && sub.subtasks.length > 0 && !allSubtasksCompleted(sub.subtasks)) return false;
  }
  return true;
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

// Get all tasks (including tasks from contacts) - for current workspace
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Only get truly global tasks (without contact assignments) for this workspace
    const globalTasks = await Task.find({
      workspaceId: req.workspaceId,
      $or: [
        { contactIds: { $exists: false } },
        { contactIds: { $size: 0 } },
        { contactIds: null }
      ],
      $and: [
        { $or: [{ contactId: { $exists: false } }, { contactId: null }, { contactId: '' }] }
      ]
    }).maxTimeMS(30000).lean();

    // Exclude file data at all nesting levels (can't use inclusion + exclusion together)
    const contacts = await Contact.find(
      { workspaceId: req.workspaceId, 'tasks.0': { $exists: true } },
      EXCLUDE_FILE_DATA
    ).lean();

    // Get all unique assigned user IDs for batch query
    const allAssignedIds = new Set();
    globalTasks.forEach(t => (t.assignedTo || []).forEach(id => allAssignedIds.add(id.toString())));
    contacts.forEach(c => (c.tasks || []).forEach(t => (t.assignedTo || []).forEach(id => allAssignedIds.add(id))));

    // Fetch all assigned users at once
    const assignedUsers = await User.find({ _id: { $in: Array.from(allAssignedIds) } }, 'username color avatar').lean();
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
      const taskId = task._id.toString();
      const assignedUsersList = (task.assignedTo || []).map(id => usersMap[id.toString()]).filter(Boolean);
      return {
        ...task,
        id: taskId,
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

    // Sort: incomplete first, then by custom order, then by createdAt descending
    allTasks.sort((a, b) => {
      // First sort by completed status (incomplete first)
      if (a.completed !== b.completed) {
        return a.completed ? 1 : -1;
      }
      // Then by custom order (lower order = higher position)
      const orderA = a.order || 0;
      const orderB = b.order || 0;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      // Fallback: by createdAt descending
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json(allTasks);
  } catch (error) {
    logger.error('GET /tasks error', { error: error.message, workspaceId: req.workspaceId?.toString() });
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Export tasks to CSV - MUST be before /:id route
router.get('/export/csv', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Get global tasks
    const globalTasks = await Task.find({ workspaceId: req.workspaceId }).sort({ createdAt: -1 }).lean();

    // Get contact tasks
    const contacts = await Contact.find(
      { workspaceId: req.workspaceId },
      EXCLUDE_FILE_DATA
    ).lean();

    const escCsv = (val) => {
      if (val == null) return '';
      let str = String(val);
      // CSV injection protection: prefix dangerous characters
      if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
      }
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const priorityMap = { low: 'Nízka', medium: 'Stredná', high: 'Vysoká' };

    const headers = ['Názov', 'Popis', 'Stav', 'Priorita', 'Termín', 'Kontakt', 'Typ', 'Počet úloh', 'Dokončené úlohy', 'Vytvorený'];
    const rows = [];

    // Global tasks
    for (const task of globalTasks) {
      const contactNames = [];
      if (task.contactIds?.length > 0) {
        for (const cId of task.contactIds) {
          const c = contacts.find(ct => ct._id.toString() === cId.toString());
          if (c) contactNames.push(c.name);
        }
      }
      const subtaskCount = (task.subtasks || []).length;
      const completedSubtasks = (task.subtasks || []).filter(s => s.completed).length;

      rows.push([
        escCsv(task.title),
        escCsv(task.description),
        task.completed ? 'Dokončený' : 'Aktívny',
        escCsv(priorityMap[task.priority] || task.priority),
        escCsv(task.dueDate ? new Date(task.dueDate).toLocaleDateString('sk-SK') : ''),
        escCsv(contactNames.join(', ')),
        'Globálny',
        subtaskCount,
        completedSubtasks,
        escCsv(task.createdAt ? new Date(task.createdAt).toLocaleDateString('sk-SK') : '')
      ].join(','));
    }

    // Contact tasks
    for (const contact of contacts) {
      for (const task of (contact.tasks || [])) {
        const subtaskCount = (task.subtasks || []).length;
        const completedSubtasks = (task.subtasks || []).filter(s => s.completed).length;

        rows.push([
          escCsv(task.title),
          escCsv(task.description),
          task.completed ? 'Dokončený' : 'Aktívny',
          escCsv(priorityMap[task.priority] || task.priority),
          escCsv(task.dueDate ? new Date(task.dueDate).toLocaleDateString('sk-SK') : ''),
          escCsv(contact.name),
          'Kontaktový',
          subtaskCount,
          completedSubtasks,
          escCsv(task.createdAt ? new Date(task.createdAt).toLocaleDateString('sk-SK') : '')
        ].join(','));
      }
    }

    const bom = '\uFEFF';
    const csv = bom + headers.join(',') + '\n' + rows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="projekty.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri exporte' });
  }
});

// Export tasks to iCal format - MUST be before /:id route
// Query params:
//   - incremental=true: only export tasks not previously exported
//   - reset=true: reset export history and export all tasks
router.get('/export/calendar', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { incremental, reset } = req.query;
    const userId = req.user.id;

    // Get user to check previously exported task IDs
    const user = await User.findById(userId);
    let exportedTaskIds = user?.exportedTaskIds || [];

    // If reset requested, clear export history
    if (reset === 'true') {
      exportedTaskIds = [];
    }

    // Only fetch contacts with tasks for current workspace, exclude files.data
    const contacts = await Contact.find(
      { workspaceId: req.workspaceId, tasks: { $exists: true, $ne: [] } },
      { name: 1, tasks: 1 }
    ).lean();
    const globalTasks = await Task.find({ workspaceId: req.workspaceId }).lean();
    const events = [];
    const newExportedIds = [];

    const formatICalDate = (dateString) => {
      const date = new Date(dateString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}${month}${day}`;
    };

    const createUID = (id) => `${id}@prplcrm`;

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
    ical += 'PRODID:-//Prpl CRM//Task Calendar//SK\r\n';
    ical += 'CALSCALE:GREGORIAN\r\n';
    ical += 'METHOD:PUBLISH\r\n';
    ical += 'X-WR-CALNAME:Prpl CRM Projekty\r\n';

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
    res.setHeader('Content-Disposition', 'attachment; filename="prpl-crm-tasks.ics"');
    res.send(ical);
  } catch (error) {
    logger.error('Calendar export error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
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

    const baseUrl = process.env.API_URL || 'https://prplcrm.eu';
    const feedUrl = `${baseUrl}/api/tasks/calendar/feed/${token}`;

    res.json({
      feedUrl,
      enabled: true,
      message: 'Kalendár feed bol aktivovaný'
    });
  } catch (error) {
    logger.error('Calendar feed generate error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
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

    const baseUrl = process.env.API_URL || 'https://prplcrm.eu';
    const feedUrl = `${baseUrl}/api/tasks/calendar/feed/${user.calendarFeedToken}`;

    res.json({
      enabled: user.calendarFeedEnabled,
      feedUrl: user.calendarFeedEnabled ? feedUrl : null,
      createdAt: user.calendarFeedCreatedAt
    });
  } catch (error) {
    logger.error('Calendar feed status error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
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
    logger.error('Calendar feed disable error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
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

    const baseUrl = process.env.API_URL || 'https://prplcrm.eu';
    const feedUrl = `${baseUrl}/api/tasks/calendar/feed/${newToken}`;

    res.json({
      feedUrl,
      enabled: true,
      message: 'Nový kalendár feed bol vygenerovaný'
    });
  } catch (error) {
    logger.error('Calendar feed regenerate error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
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

    // Get tasks only from user's current workspace
    const workspaceFilter = user.currentWorkspaceId ? { workspaceId: user.currentWorkspaceId } : {};
    const globalTasks = await Task.find(
      { ...workspaceFilter, dueDate: { $exists: true, $ne: null } },
      { title: 1, dueDate: 1, description: 1, completed: 1, priority: 1, subtasks: 1, createdAt: 1, updatedAt: 1 }
    ).lean();
    const contacts = await Contact.find(
      { ...workspaceFilter, 'tasks.dueDate': { $exists: true } },
      { name: 1, tasks: 1 }
    ).lean();

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

    const createUID = (id) => `${id}@prplcrm`;

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
    logger.debug('Calendar feed - Global tasks count', { count: globalTasks.length });
    for (const task of globalTasks) {
      const taskId = task._id.toString();
      logger.debug('Calendar feed - Task', { title: task.title, dueDate: task.dueDate });
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
    logger.debug('Calendar feed - Contacts count', { count: contacts.length });
    for (const contact of contacts) {
      if (contact.tasks) {
        logger.debug('Calendar feed - Contact', { name: contact.name, taskCount: contact.tasks.length });
        for (const task of contact.tasks) {
          logger.debug('Calendar feed - Contact task', { title: task.title, dueDate: task.dueDate });
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

    logger.debug('Calendar feed - Total events', { count: events.length });

    // Build iCal feed with VTODO (tasks) instead of VEVENT (events)
    let ical = 'BEGIN:VCALENDAR\r\n';
    ical += 'VERSION:2.0\r\n';
    ical += 'PRODID:-//Prpl CRM//Task Calendar//SK\r\n';
    ical += 'CALSCALE:GREGORIAN\r\n';
    ical += 'METHOD:PUBLISH\r\n';
    ical += 'X-WR-CALNAME:Prpl CRM - Projekty\r\n';
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
    res.setHeader('Content-Disposition', 'inline; filename="prpl-crm-tasks.ics"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(ical);
  } catch (error) {
    logger.error('Calendar feed error', { error: error.message });
    res.status(500).send('Chyba pri generovaní kalendára');
  }
});

// Reorder tasks (drag & drop)
router.put('/reorder', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { tasks } = req.body; // [{ id, order, source, contactId }]
    if (!Array.isArray(tasks)) {
      return res.status(400).json({ message: 'Neplatné dáta' });
    }

    const bulkOps = [];
    const contactUpdates = {};

    for (const item of tasks) {
      if (item.source === 'global') {
        bulkOps.push({
          updateOne: {
            filter: { _id: item.id, workspaceId: req.workspaceId },
            update: { $set: { order: item.order } }
          }
        });
      } else if (item.source === 'contact' && item.contactId) {
        if (!contactUpdates[item.contactId]) {
          contactUpdates[item.contactId] = [];
        }
        contactUpdates[item.contactId].push({ id: item.id, order: item.order });
      }
    }

    if (bulkOps.length > 0) {
      await Task.bulkWrite(bulkOps);
    }

    // Update contact task orders
    for (const [contactId, taskOrders] of Object.entries(contactUpdates)) {
      const contact = await Contact.findOne({ _id: contactId, workspaceId: req.workspaceId });
      if (contact && contact.tasks) {
        for (const item of taskOrders) {
          const task = contact.tasks.find(t => t.id === item.id);
          if (task) task.order = item.order;
        }
        await contact.save();
      }
    }

    res.json({ message: 'Poradie aktualizované' });
  } catch (error) {
    logger.error('Reorder tasks error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Reorder subtasks within a task (drag & drop)
router.put('/reorder-subtasks', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { taskId, source, contactId, subtasks } = req.body; // subtasks: [{ id, order }]
    if (!taskId || !Array.isArray(subtasks)) {
      return res.status(400).json({ message: 'Neplatné dáta' });
    }

    const reorderSubtasksRecursive = (existingSubtasks, orderMap) => {
      if (!existingSubtasks) return existingSubtasks;
      for (const sub of existingSubtasks) {
        if (orderMap[sub.id] !== undefined) {
          sub.order = orderMap[sub.id];
        }
        if (sub.subtasks && sub.subtasks.length > 0) {
          reorderSubtasksRecursive(sub.subtasks, orderMap);
        }
      }
      return existingSubtasks;
    };

    const orderMap = {};
    subtasks.forEach(s => { orderMap[s.id] = s.order; });

    if (source === 'global') {
      const task = await Task.findOne({ _id: taskId, workspaceId: req.workspaceId });
      if (!task) return res.status(404).json({ message: 'Projekt nenájdený' });
      reorderSubtasksRecursive(task.subtasks, orderMap);
      task.markModified('subtasks');
      await task.save();
    } else if (source === 'contact' && contactId) {
      const contact = await Contact.findOne({ _id: contactId, workspaceId: req.workspaceId });
      if (!contact) return res.status(404).json({ message: 'Kontakt nenájdený' });
      const task = contact.tasks.find(t => t.id === taskId);
      if (!task) return res.status(404).json({ message: 'Projekt nenájdený' });
      reorderSubtasksRecursive(task.subtasks, orderMap);
      contact.markModified('tasks');
      await contact.save();
    }

    res.json({ message: 'Poradie úloh aktualizované' });
  } catch (error) {
    logger.error('Reorder subtasks error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get single task (from global tasks or contacts)
router.get('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // First check global tasks in this workspace
    const task = await Task.findOne({ _id: req.params.id, workspaceId: req.workspaceId }).lean();
    if (task) {
      return res.json({ ...task, source: 'global', id: task._id.toString() });
    }

    // Check tasks in contacts using MongoDB query (much faster than loading all contacts)
    const contact = await Contact.findOne(
      { workspaceId: req.workspaceId, 'tasks.id': req.params.id },
      { name: 1, 'tasks.$': 1 }
    ).lean();

    if (contact && contact.tasks && contact.tasks.length > 0) {
      const foundTask = contact.tasks[0];
      return res.json({
        ...foundTask,
        contactId: contact._id.toString(),
        contactName: contact.name,
        source: 'contact'
      });
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
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
router.post('/', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
  try {
    const { title, description, dueDate, priority, contactId, contactIds, subtasks, assignedTo, reminder } = req.body;
    const io = req.app.get('io');

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Názov projektu je povinný' });
    }

    // Support both old contactId (single) and new contactIds (array)
    let finalContactIds = [];
    if (contactIds && Array.isArray(contactIds) && contactIds.length > 0) {
      finalContactIds = contactIds;
    } else if (contactId) {
      finalContactIds = [contactId];
    }

    // Check plan limits
    const user = await User.findById(req.user.id);
    const plan = user?.subscription?.plan || 'free';
    const taskLimits = { free: 10, trial: 10, team: 25, pro: Infinity };
    const maxTasks = taskLimits[plan] || 10;
    const isLimited = maxTasks !== Infinity;

    // If no contacts selected, create as global task
    if (finalContactIds.length === 0) {
      const task = new Task({
        workspaceId: req.workspaceId,
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
        modifiedAt: new Date().toISOString(),
        reminder: reminder !== '' && reminder != null ? Number(reminder) : null,
        reminderSent: false
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

      io.to(`workspace-${req.workspaceId}`).emit('task-created', taskObj);

      // Auto-sync to Google Calendar
      autoSyncToGoogle(taskObj, 'create');

      // Send notification about new task
      await notificationService.notifyTaskChange('task.created', taskObj, req.user, [], req.workspaceId);

      // Notify assigned users
      logger.debug('[Task Create Global] Assignment check', { assignedTo });
      if (assignedTo && assignedTo.length > 0) {
        logger.debug('[Task Create Global] Sending assignment notification', { assignedTo });
        await notificationService.notifyTaskAssignment(taskObj, assignedTo, req.user);
      } else {
        logger.debug('[Task Create Global] No assigned users, skipping');
      }

      // Audit log (fire and forget)
      auditService.logAction({
        userId: req.user.id,
        username: req.user.username,
        email: req.user.email,
        action: 'task.created',
        category: 'task',
        targetType: 'task',
        targetId: taskObj.id,
        targetName: taskObj.title,
        details: { title: taskObj.title, source: 'global' },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        workspaceId: req.workspaceId || null
      });

      return res.status(201).json(taskObj);
    }

    // Create independent embedded task in each selected contact
    const createdTasks = [];
    const updatedContacts = [];

    for (const cId of finalContactIds) {
      const contact = await Contact.findOne({ _id: cId, workspaceId: req.workspaceId });
      if (!contact) continue;

      // Check plan limit: tasks per contact
      if (isLimited && contact.tasks && contact.tasks.length >= maxTasks) {
        return res.status(403).json({ message: `Váš plán umožňuje max. ${maxTasks} projektov na kontakt. Pre viac prejdite na vyšší plán.` });
      }

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
        modifiedAt: new Date().toISOString(),
        reminder: reminder !== '' && reminder != null ? Number(reminder) : null,
        reminderSent: false
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
      io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
    }

    // Emit task-created for each new task so Tasks view updates in real-time
    for (const task of createdTasks) {
      io.to(`workspace-${req.workspaceId}`).emit('task-created', task);
      // Auto-sync to Google Calendar
      autoSyncToGoogle(task, 'create');

      // Send notification about new task
      await notificationService.notifyTaskChange('task.created', task, req.user, [], req.workspaceId);

      // Notify assigned users
      logger.debug('[Task Create Contact] Assignment check', { assignedTo: task.assignedTo });
      if (task.assignedTo && task.assignedTo.length > 0) {
        logger.debug('[Task Create Contact] Sending assignment notification', { assignedTo: task.assignedTo });
        await notificationService.notifyTaskAssignment(task, task.assignedTo, req.user);
      } else {
        logger.debug('[Task Create Contact] No assigned users, skipping');
      }
    }

    // Return first task for compatibility (or all tasks info)
    if (createdTasks.length === 1) {
      res.status(201).json(createdTasks[0]);
    } else {
      res.status(201).json({
        createdCount: createdTasks.length,
        tasks: createdTasks,
        message: `Projekt bol vytvorený v ${createdTasks.length} kontaktoch`
      });
    }

    // Audit log for each created contact task (fire and forget)
    for (const ct of createdTasks) {
      auditService.logAction({
        userId: req.user.id,
        username: req.user.username,
        email: req.user.email,
        action: 'task.created',
        category: 'task',
        targetType: 'task',
        targetId: ct.id,
        targetName: ct.title,
        details: { title: ct.title, source: 'contact', contactName: ct.contactName },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        workspaceId: req.workspaceId || null
      });
    }
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Helper function to sync all subtasks to Google when parent title changes
const syncSubtasksToGoogle = async (subtasks, parentTitle, contactName) => {
  if (!subtasks || subtasks.length === 0) return;

  for (const subtask of subtasks) {
    autoSyncToGoogle({
      id: subtask.id,
      title: `${subtask.title} (${parentTitle})`,
      description: subtask.notes || '',
      dueDate: subtask.dueDate,
      completed: subtask.completed,
      priority: subtask.priority,
      contactName: contactName
    }, 'update');

    // Recursively sync nested subtasks
    if (subtask.subtasks && subtask.subtasks.length > 0) {
      await syncSubtasksToGoogle(subtask.subtasks, parentTitle, contactName);
    }
  }
};

// Update task (global or from contact)
router.put('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { title, description, dueDate, priority, completed, contactId, contactIds, source, assignedTo, reminder } = req.body;
    const io = req.app.get('io');

    // If source is 'contact', update in contacts
    if (source === 'contact') {
      // Optimization: if contactId is provided, use it directly
      // Otherwise use MongoDB query with index on tasks.id
      let contact;
      if (contactId) {
        contact = await Contact.findById(contactId);
      } else {
        contact = await Contact.findOne({ 'tasks.id': req.params.id });
      }

      if (contact && contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.id);
        if (taskIndex !== -1) {
            const task = contact.tasks[taskIndex];
            // Save original assignedTo before update
            const originalAssignedTo = task.assignedTo || [];
            // Auto-complete all subtasks when main task is completed
            const markAllSubtasksCompleted = (subtasks) => {
              if (!subtasks) return subtasks;
              return subtasks.map(s => ({
                ...s,
                completed: true,
                subtasks: markAllSubtasksCompleted(s.subtasks)
              }));
            };

            let updatedSubtasks = req.body.subtasks !== undefined ? req.body.subtasks : task.subtasks;
            if (completed === true) {
              updatedSubtasks = markAllSubtasksCompleted(updatedSubtasks);
            }

            const newReminder = reminder !== undefined ? (reminder !== '' && reminder != null ? Number(reminder) : null) : task.reminder;
            const reminderChanged = newReminder !== task.reminder || (dueDate !== undefined && dueDate !== task.dueDate);

            contact.tasks[taskIndex] = {
              ...task,
              id: task.id,
              title: title !== undefined ? title : task.title,
              description: description !== undefined ? description : task.description,
              dueDate: dueDate !== undefined ? dueDate : task.dueDate,
              priority: priority !== undefined ? priority : task.priority,
              completed: completed !== undefined ? completed : task.completed,
              assignedTo: assignedTo !== undefined ? assignedTo : task.assignedTo,
              subtasks: updatedSubtasks,
              createdAt: task.createdAt,
              modifiedAt: new Date().toISOString(),
              reminder: newReminder,
              reminderSent: reminderChanged ? false : (task.reminderSent || false)
            };
            contact.markModified('tasks');
            await contact.save();

            io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
            const assignedUsers = await populateAssignedUsers(contact.tasks[taskIndex].assignedTo);
            const taskData = taskToPlainObject(contact.tasks[taskIndex], {
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact',
              assignedUsers
            });
            io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskData);

            // Auto-sync to Google Calendar
            autoSyncToGoogle(taskData, 'update');

            // If title changed, also update all subtasks in calendar (they have parent title in their name)
            // Note: 'task' is the original task before update, so we compare new title with original
            const originalTitle = task.title;
            if (title !== undefined && title !== originalTitle) {
              const newTitle = title;
              const subtasks = contact.tasks[taskIndex].subtasks;
              logger.debug("Auto-sync: Parent task title changed", { originalTitle, newTitle, subtaskCount: (subtasks || []).length });
              syncSubtasksToGoogle(subtasks, newTitle, contact.name).catch(err =>
                logger.warn("Auto-sync error updating subtasks (contact)", { error: err.message })
              );
            }

            // Determine newly assigned users first
            let newlyAssigned = [];
            if (assignedTo !== undefined) {
              const newAssignedTo = assignedTo || [];
              newlyAssigned = newAssignedTo.filter(id => !originalAssignedTo.includes(id));
              logger.debug('[Task Update Contact] Assignment check', {
                originalAssignedTo,
                newAssignedTo,
                newlyAssigned,
                assignedToFromBody: assignedTo
              });
            }

            // Send notification about task update (exclude newly assigned - they get assignment notification)
            const taskType = completed === true && task.completed !== true ? 'task.completed' : 'task.updated';
            await notificationService.notifyTaskChange(taskType, taskData, req.user, newlyAssigned, req.workspaceId);

            // Notify newly assigned users with specific assignment notification
            if (newlyAssigned.length > 0) {
              logger.debug('[Task Update Contact] Sending assignment notification', { newlyAssigned });
              await notificationService.notifyTaskAssignment(taskData, newlyAssigned, req.user);
            }

            res.json(taskData);

            // Audit log (fire and forget)
            auditService.logAction({
              userId: req.user.id,
              username: req.user.username,
              email: req.user.email,
              action: taskType === 'task.completed' ? 'task.completed' : 'task.updated',
              category: 'task',
              targetType: 'task',
              targetId: taskData.id,
              targetName: taskData.title,
              details: { title: taskData.title, source: 'contact', changedFields: Object.keys(req.body).filter(k => req.body[k] !== undefined) },
              ipAddress: req.ip,
              userAgent: req.get('user-agent'),
              workspaceId: req.workspaceId || null
            });
            return;
          }
        }
      return res.status(404).json({ message: 'Task not found in contacts' });
    }

    // Try to update global task
    let task = await Task.findById(req.params.id);

    if (task) {
      // Save original assignedTo before update
      const originalAssignedTo = (task.assignedTo || []).map(id => id.toString());

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
      const oldDueDate = task.dueDate;
      task.dueDate = dueDate !== undefined ? dueDate : task.dueDate;
      task.priority = priority !== undefined ? priority : task.priority;
      task.completed = completed !== undefined ? completed : task.completed;
      task.contactIds = finalContactIds;
      task.assignedTo = assignedTo !== undefined ? assignedTo : task.assignedTo;
      task.modifiedAt = new Date().toISOString();

      // Handle reminder
      if (reminder !== undefined) {
        const newReminder = reminder !== '' && reminder != null ? Number(reminder) : null;
        const reminderChanged = newReminder !== task.reminder || (dueDate !== undefined && dueDate !== oldDueDate);
        task.reminder = newReminder;
        if (reminderChanged) task.reminderSent = false;
      }
      // Preserve subtasks if not explicitly provided
      if (req.body.subtasks !== undefined) {
        task.subtasks = req.body.subtasks;
      }

      // Auto-complete all subtasks when main task is completed
      if (completed === true && task.subtasks && task.subtasks.length > 0) {
        const markAllSubtasksCompleted = (subtasks) => {
          if (!subtasks) return subtasks;
          return subtasks.map(s => ({
            ...s.toObject ? s.toObject() : s,
            completed: true,
            subtasks: markAllSubtasksCompleted(s.subtasks)
          }));
        };
        task.subtasks = markAllSubtasksCompleted(task.subtasks);
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

      io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskData);

      // Auto-sync to Google Calendar
      autoSyncToGoogle(taskData, 'update');

      // If title changed, also update all subtasks in calendar (they have parent title in their name)
      if (title !== undefined && title !== originalTitle) {
        const newTitle = title;
        const subtasks = task.subtasks;
        logger.debug("Auto-sync: Parent task title changed", { originalTitle, newTitle, subtaskCount: (subtasks || []).length });
        syncSubtasksToGoogle(subtasks, newTitle, null).catch(err =>
          logger.warn("Auto-sync error updating subtasks (global)", { error: err.message })
        );
      }

      // Determine newly assigned users first
      let newlyAssigned = [];
      if (assignedTo !== undefined) {
        const newAssignedTo = (assignedTo || []).map(id => id.toString());
        newlyAssigned = newAssignedTo.filter(id => !originalAssignedTo.includes(id));
        logger.debug('[Task Update Global] Assignment check', {
          originalAssignedTo,
          newAssignedTo,
          newlyAssigned,
          assignedToFromBody: assignedTo
        });
      }

      // Send notification about task update (exclude newly assigned - they get assignment notification)
      const prevCompleted = task.completed;
      const taskType = completed === true && prevCompleted !== true ? 'task.completed' : 'task.updated';
      await notificationService.notifyTaskChange(taskType, taskData, req.user, newlyAssigned, req.workspaceId);

      // Notify newly assigned users with specific assignment notification
      if (newlyAssigned.length > 0) {
        logger.debug('[Task Update Global] Sending assignment notification', { newlyAssigned });
        await notificationService.notifyTaskAssignment(taskData, newlyAssigned, req.user);
      }

      res.json(taskData);

      // Audit log (fire and forget)
      auditService.logAction({
        userId: req.user.id,
        username: req.user.username,
        email: req.user.email,
        action: taskType === 'task.completed' ? 'task.completed' : 'task.updated',
        category: 'task',
        targetType: 'task',
        targetId: taskData.id,
        targetName: taskData.title,
        details: { title: taskData.title, source: 'global', changedFields: Object.keys(req.body).filter(k => req.body[k] !== undefined) },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        workspaceId: req.workspaceId || null
      });
      return;
    }

    // Task not found in global tasks, try to find in contacts
    const contacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.id);
        if (taskIndex !== -1) {
          const ctask = contact.tasks[taskIndex];
          // Save original values before update
          const originalCtaskTitle = ctask.title;
          const originalCtaskAssignedTo = ctask.assignedTo || [];
          contact.tasks[taskIndex] = {
            ...ctask,
            id: ctask.id,
            title: title !== undefined ? title : ctask.title,
            description: description !== undefined ? description : ctask.description,
            dueDate: dueDate !== undefined ? dueDate : ctask.dueDate,
            priority: priority !== undefined ? priority : ctask.priority,
            completed: completed !== undefined ? completed : ctask.completed,
            assignedTo: assignedTo !== undefined ? assignedTo : ctask.assignedTo,
            subtasks: req.body.subtasks !== undefined ? req.body.subtasks : ctask.subtasks,
            createdAt: ctask.createdAt,
            modifiedAt: new Date().toISOString()
          };
          contact.markModified('tasks');
          await contact.save();

          io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
          const assignedUsers = await populateAssignedUsers(contact.tasks[taskIndex].assignedTo);
          const taskData = taskToPlainObject(contact.tasks[taskIndex], {
            contactId: contact._id.toString(),
            contactName: contact.name,
            source: 'contact',
            assignedUsers
          });
          io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskData);

          // Auto-sync to Google Calendar
          autoSyncToGoogle(taskData, 'update');

          // If title changed, also update all subtasks in calendar (they have parent title in their name)
          if (title !== undefined && title !== originalCtaskTitle) {
            const newTitle = title;
            const subtasks = contact.tasks[taskIndex].subtasks;
            logger.debug('Auto-sync: Parent task title changed (fallback)', { originalCtaskTitle, newTitle, subtaskCount: (subtasks || []).length });
            syncSubtasksToGoogle(subtasks, newTitle, contact.name).catch(err =>
              logger.warn('Auto-sync error updating subtasks (fallback)', { error: err.message })
            );
          }

          // Determine newly assigned users first
          let newlyAssigned = [];
          if (assignedTo !== undefined) {
            const newAssignedTo = assignedTo || [];
            newlyAssigned = newAssignedTo.filter(id => !originalCtaskAssignedTo.includes(id));
            logger.debug('[Task Update Fallback] Assignment check', {
              originalCtaskAssignedTo,
              newAssignedTo,
              newlyAssigned,
              assignedToFromBody: assignedTo
            });
          }

          // Send notification about task update (exclude newly assigned - they get assignment notification)
          const fallbackTaskType = completed === true && ctask.completed !== true ? 'task.completed' : 'task.updated';
          await notificationService.notifyTaskChange(fallbackTaskType, taskData, req.user, newlyAssigned, req.workspaceId);

          // Notify newly assigned users with specific assignment notification
          if (newlyAssigned.length > 0) {
            logger.debug('[Task Update Fallback] Sending assignment notification', { newlyAssigned });
            await notificationService.notifyTaskAssignment(taskData, newlyAssigned, req.user);
          }

          res.json(taskData);

          // Audit log (fire and forget)
          auditService.logAction({
            userId: req.user.id,
            username: req.user.username,
            email: req.user.email,
            action: fallbackTaskType === 'task.completed' ? 'task.completed' : 'task.updated',
            category: 'task',
            targetType: 'task',
            targetId: taskData.id,
            targetName: taskData.title,
            details: { title: taskData.title, source: 'contact', changedFields: Object.keys(req.body).filter(k => req.body[k] !== undefined) },
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            workspaceId: req.workspaceId || null
          });
          return;
        }
      }
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete task (global or from contact)
router.delete('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const io = req.app.get('io');
    const source = req.query.source;

    // If source is 'contact', delete from contacts
    if (source === 'contact') {
      const contacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.id);
          if (taskIndex !== -1) {
            const deletedTask = contact.tasks[taskIndex];
            contact.tasks.splice(taskIndex, 1);
            contact.markModified('tasks');
            await contact.save();

            io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
            io.to(`workspace-${req.workspaceId}`).emit('task-deleted', { id: req.params.id, source: 'contact' });

            // Auto-delete from Google Calendar
            autoDeleteFromGoogle(req.params.id);

            // Send notification about deleted task
            await notificationService.notifyTaskChange('task.deleted', deletedTask, req.user, [], req.workspaceId);

            res.json({ message: 'Task deleted' });

            // Audit log (fire and forget)
            auditService.logAction({
              userId: req.user.id,
              username: req.user.username,
              email: req.user.email,
              action: 'task.deleted',
              category: 'task',
              targetType: 'task',
              targetId: req.params.id,
              targetName: deletedTask.title,
              details: { title: deletedTask.title, source: 'contact' },
              ipAddress: req.ip,
              userAgent: req.get('user-agent'),
              workspaceId: req.workspaceId || null
            });
            return;
          }
        }
      }
      return res.status(404).json({ message: 'Task not found in contacts' });
    }

    // Try to delete from global tasks first
    const task = await Task.findByIdAndDelete(req.params.id);
    if (task) {
      io.to(`workspace-${req.workspaceId}`).emit('task-deleted', { id: req.params.id, source: 'global' });

      // Auto-delete from Google Calendar
      autoDeleteFromGoogle(req.params.id);

      // Send notification about deleted task
      await notificationService.notifyTaskChange('task.deleted', task, req.user, [], req.workspaceId);

      res.json({ message: 'Task deleted' });

      // Audit log (fire and forget)
      auditService.logAction({
        userId: req.user.id,
        username: req.user.username,
        email: req.user.email,
        action: 'task.deleted',
        category: 'task',
        targetType: 'task',
        targetId: req.params.id,
        targetName: task.title,
        details: { title: task.title, source: 'global' },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        workspaceId: req.workspaceId || null
      });
      return;
    }

    // If not found in global tasks, try contacts
    const contacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.id);
        if (taskIndex !== -1) {
          const deletedTask = contact.tasks[taskIndex];
          contact.tasks.splice(taskIndex, 1);
          contact.markModified('tasks');
          await contact.save();

          io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
          io.to(`workspace-${req.workspaceId}`).emit('task-deleted', { id: req.params.id, source: 'contact' });

          // Auto-delete from Google Calendar
          autoDeleteFromGoogle(req.params.id);

          // Send notification about deleted task
          await notificationService.notifyTaskChange('task.deleted', deletedTask, req.user, [], req.workspaceId);

          res.json({ message: 'Task deleted' });

          // Audit log (fire and forget)
          auditService.logAction({
            userId: req.user.id,
            username: req.user.username,
            email: req.user.email,
            action: 'task.deleted',
            category: 'task',
            targetType: 'task',
            targetId: req.params.id,
            targetName: deletedTask.title,
            details: { title: deletedTask.title, source: 'contact' },
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            workspaceId: req.workspaceId || null
          });
          return;
        }
      }
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
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
router.post('/:id/duplicate', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
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
      const allContacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
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

      io.to(`workspace-${req.workspaceId}`).emit('task-created', taskObj);

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
      io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
    }

    res.status(201).json({
      duplicatedCount: duplicatedTasks.length,
      tasks: duplicatedTasks,
      message: `Projekt bol duplikovaný do ${duplicatedTasks.length} kontaktov`
    });
  } catch (error) {
    logger.error('Duplicate task error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ==================== SUBTASKS (RECURSIVE) ====================

// Add subtask to task (global or from contact)
router.post('/:taskId/subtasks', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
  try {
    const { title, source, parentSubtaskId, dueDate, notes, priority, assignedTo } = req.body;
    const io = req.app.get('io');

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Nazov ulohy je povinny' });
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
      const contacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
          if (taskIndex !== -1) {
            if (addToParent(contact.tasks[taskIndex])) {
              // Update parent task's modifiedAt when subtask is added
              contact.tasks[taskIndex].modifiedAt = now;
              contact.markModified('tasks');
              await contact.save();

              io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
              io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
                contactId: contact._id.toString(),
                contactName: contact.name,
                source: 'contact'
              }));

              // Auto-sync subtask to Google
              autoSyncToGoogle({
                id: subtask.id,
                title: `${subtask.title} (${contact.tasks[taskIndex].title})`,
                description: subtask.notes || '',
                dueDate: subtask.dueDate,
                completed: subtask.completed,
                priority: subtask.priority,
                contactName: contact.name
              }, 'create');

              // Send notification about new subtask
              await notificationService.notifySubtaskChange('subtask.created', subtask, contact.tasks[taskIndex], req.user, [], req.workspaceId);

              // Send assignment notification if subtask is assigned to someone
              if (assignedTo && assignedTo.length > 0) {
                await notificationService.notifySubtaskAssignment(subtask, contact.tasks[taskIndex], assignedTo, req.user);
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

        io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(task, { source: 'global', id: task._id.toString() }));

        // Auto-sync subtask to Google
        autoSyncToGoogle({
          id: subtask.id,
          title: `${subtask.title} (${task.title})`,
          description: subtask.notes || '',
          dueDate: subtask.dueDate,
          completed: subtask.completed,
          priority: subtask.priority,
          contactName: null
        }, 'create');

        // Send notification about new subtask
        await notificationService.notifySubtaskChange('subtask.created', subtask, task, req.user, [], req.workspaceId);

        // Send assignment notification if subtask is assigned to someone
        if (assignedTo && assignedTo.length > 0) {
          await notificationService.notifySubtaskAssignment(subtask, task, assignedTo, req.user);
        }

        return res.status(201).json(subtask);
      }
      return res.status(404).json({ message: 'Parent subtask not found' });
    }

    // If not found in global, search in contacts
    const contacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
        if (taskIndex !== -1) {
          if (addToParent(contact.tasks[taskIndex])) {
            // Update parent task's modifiedAt when subtask is added
            contact.tasks[taskIndex].modifiedAt = now;
            contact.markModified('tasks');
            await contact.save();

            io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
            io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            }));

            // Auto-sync subtask to Google
            autoSyncToGoogle({
              id: subtask.id,
              title: `${subtask.title} (${contact.tasks[taskIndex].title})`,
              description: subtask.notes || '',
              dueDate: subtask.dueDate,
              completed: subtask.completed,
              priority: subtask.priority,
              contactName: contact.name
            }, 'create');

            // Send notification about new subtask
            await notificationService.notifySubtaskChange('subtask.created', subtask, contact.tasks[taskIndex], req.user, [], req.workspaceId);

            // Send assignment notification if subtask is assigned to someone
            if (assignedTo && assignedTo.length > 0) {
              await notificationService.notifySubtaskAssignment(subtask, contact.tasks[taskIndex], assignedTo, req.user);
            }

            return res.status(201).json(subtask);
          }
          return res.status(404).json({ message: 'Parent subtask not found' });
        }
      }
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update subtask (global or from contact)
router.put('/:taskId/subtasks/:subtaskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { title, completed, source, dueDate, notes, assignedTo } = req.body;
    const io = req.app.get('io');

    // Helper to update subtask recursively
    // BUGFIX: Preserve all existing fields including priority and nested subtasks
    // Returns { updated, originalAssignedTo } for assignment notification logic
    const updateSubtaskInTask = (task) => {
      const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);
      if (found) {
        const originalAssignedTo = found.subtask.assignedTo || [];
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
        return { updated: found.parent[found.index], originalAssignedTo };
      }
      return null;
    };

    // If source is contact, look in contacts
    if (source === 'contact') {
      const contacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
          if (taskIndex !== -1) {
            const result = updateSubtaskInTask(contact.tasks[taskIndex]);
            if (result) {
              const { updated, originalAssignedTo } = result;
              contact.markModified('tasks');
              await contact.save();

              io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
              io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
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

              // Determine newly assigned users
              let newlyAssigned = [];
              if (assignedTo !== undefined) {
                const newAssignedTo = assignedTo || [];
                newlyAssigned = newAssignedTo.filter(id => !originalAssignedTo.includes(id));
                logger.debug('[Subtask Update Contact] Assignment check', {
                  originalAssignedTo,
                  newAssignedTo,
                  newlyAssigned
                });
              }

              // Send notification about subtask update (exclude newly assigned - they get assignment notification)
              const subtaskType = completed === true ? 'subtask.completed' : 'subtask.updated';
              await notificationService.notifySubtaskChange(subtaskType, updated, contact.tasks[taskIndex], req.user, newlyAssigned, req.workspaceId);

              // Notify newly assigned users with specific assignment notification
              if (newlyAssigned.length > 0) {
                logger.debug('[Subtask Update Contact] Sending assignment notification', { newlyAssigned });
                await notificationService.notifySubtaskAssignment(updated, contact.tasks[taskIndex], newlyAssigned, req.user);
              }

              // Auto-complete project when all subtasks are done
              if (completed === true && !contact.tasks[taskIndex].completed && allSubtasksCompleted(contact.tasks[taskIndex].subtasks)) {
                contact.tasks[taskIndex].completed = true;
                contact.markModified('tasks');
                await contact.save();
                io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
                io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], { contactId: contact._id.toString(), contactName: contact.name, source: 'contact' }));
                logger.info('[Auto-complete] Project auto-completed (contact)', { taskId: req.params.taskId });
              }

              return res.json(updated);
            }
          }
        }
      }
    }

    // Try global tasks
    const task = await Task.findById(req.params.taskId);
    if (task) {
      const result = updateSubtaskInTask(task);
      if (result) {
        const { updated, originalAssignedTo } = result;
        task.markModified('subtasks');
        await task.save();

        io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(task, { source: 'global', id: task._id.toString() }));

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

        // Determine newly assigned users
        let newlyAssigned = [];
        if (assignedTo !== undefined) {
          const newAssignedTo = assignedTo || [];
          newlyAssigned = newAssignedTo.filter(id => !originalAssignedTo.includes(id));
          logger.debug('[Subtask Update Global] Assignment check', {
            originalAssignedTo,
            newAssignedTo,
            newlyAssigned
          });
        }

        // Send notification about subtask update (exclude newly assigned - they get assignment notification)
        const globalSubtaskType = completed === true ? 'subtask.completed' : 'subtask.updated';
        await notificationService.notifySubtaskChange(globalSubtaskType, updated, task, req.user, newlyAssigned, req.workspaceId);

        // Notify newly assigned users with specific assignment notification
        if (newlyAssigned.length > 0) {
          logger.debug('[Subtask Update Global] Sending assignment notification', { newlyAssigned });
          await notificationService.notifySubtaskAssignment(updated, task, newlyAssigned, req.user);
        }

        // Auto-complete project when all subtasks are done
        if (completed === true && !task.completed && allSubtasksCompleted(task.subtasks)) {
          task.completed = true;
          task.markModified('subtasks');
          await task.save();
          io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(task, { source: 'global', id: task._id.toString() }));
          logger.info('[Auto-complete] Project auto-completed (global)', { taskId: task._id.toString() });
        }

        return res.json(updated);
      }
    }

    // Search in contacts
    const contacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
        if (taskIndex !== -1) {
          const result = updateSubtaskInTask(contact.tasks[taskIndex]);
          if (result) {
            const { updated, originalAssignedTo } = result;
            contact.markModified('tasks');
            await contact.save();

            io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
            io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
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

            // Determine newly assigned users
            let newlyAssigned = [];
            if (assignedTo !== undefined) {
              const newAssignedTo = assignedTo || [];
              newlyAssigned = newAssignedTo.filter(id => !originalAssignedTo.includes(id));
              logger.debug('[Subtask Update Fallback] Assignment check', {
                originalAssignedTo,
                newAssignedTo,
                newlyAssigned
              });
            }

            // Send notification about subtask update (exclude newly assigned - they get assignment notification)
            const fallbackSubtaskType = completed === true ? 'subtask.completed' : 'subtask.updated';
            await notificationService.notifySubtaskChange(fallbackSubtaskType, updated, contact.tasks[taskIndex], req.user, newlyAssigned, req.workspaceId);

            // Notify newly assigned users with specific assignment notification
            if (newlyAssigned.length > 0) {
              logger.debug('[Subtask Update Fallback] Sending assignment notification', { newlyAssigned });
              await notificationService.notifySubtaskAssignment(updated, contact.tasks[taskIndex], newlyAssigned, req.user);
            }

            // Auto-complete project when all subtasks are done
            if (completed === true && !contact.tasks[taskIndex].completed && allSubtasksCompleted(contact.tasks[taskIndex].subtasks)) {
              contact.tasks[taskIndex].completed = true;
              contact.markModified('tasks');
              await contact.save();
              io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
              io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], { contactId: contact._id.toString(), contactName: contact.name, source: 'contact' }));
              logger.info('[Auto-complete] Project auto-completed (fallback contact)', { taskId: req.params.taskId });
            }

            return res.json(updated);
          }
        }
      }
    }

    return res.status(404).json({ message: 'Task or subtask not found' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete subtask (global or from contact)
router.delete('/:taskId/subtasks/:subtaskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const io = req.app.get('io');
    const source = req.query.source;

    // Helper to find and delete subtask recursively, returning the deleted subtask info
    const findAndDeleteSubtask = (task) => {
      const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);
      if (found) {
        const deletedSubtask = JSON.parse(JSON.stringify(found.subtask));
        found.parent.splice(found.index, 1);
        return deletedSubtask;
      }
      return null;
    };

    // Helper to collect all subtasks recursively (for cascade notifications)
    const collectAllSubtasks = (subtask) => {
      const allSubtasks = [subtask];
      if (subtask.subtasks && subtask.subtasks.length > 0) {
        for (const child of subtask.subtasks) {
          allSubtasks.push(...collectAllSubtasks(child));
        }
      }
      return allSubtasks;
    };

    // Helper to send notifications for deleted subtask and all its children
    const sendDeleteNotifications = async (deletedSubtask, parentTask) => {
      const allSubtasksToNotify = collectAllSubtasks(deletedSubtask);
      for (const subtask of allSubtasksToNotify) {
        await notificationService.notifySubtaskChange('subtask.deleted', subtask, parentTask, req.user, [], req.workspaceId);
      }
    };

    // If source is contact, look in contacts
    if (source === 'contact') {
      const contacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
          if (taskIndex !== -1) {
            const deletedSubtask = findAndDeleteSubtask(contact.tasks[taskIndex]);
            if (deletedSubtask) {
              contact.markModified('tasks');
              await contact.save();

              io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
              io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
                contactId: contact._id.toString(),
                contactName: contact.name,
                source: 'contact'
              }));

              // Build parent task object with contact info
              // Use toObject() to properly convert Mongoose subdocument to plain object
              const taskObj = contact.tasks[taskIndex].toObject ? contact.tasks[taskIndex].toObject() : contact.tasks[taskIndex];
              const parentTask = {
                ...taskObj,
                id: taskObj.id || contact.tasks[taskIndex].id,
                contactId: contact._id.toString(),
                contactName: contact.name
              };

              logger.debug('[DeleteSubtask] IDs', { parentTaskId: parentTask.id, taskObjId: taskObj.id, deletedSubtaskId: deletedSubtask.id });

              // Send notifications for deleted subtask and all nested subtasks
              await sendDeleteNotifications(deletedSubtask, parentTask);

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
      const deletedSubtask = findAndDeleteSubtask(task);
      if (deletedSubtask) {
        task.markModified('subtasks');
        await task.save();

        io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(task, { source: 'global', id: task._id.toString() }));

        // Send notifications for deleted subtask and all nested subtasks
        await sendDeleteNotifications(deletedSubtask, task);

        // Auto-delete subtask from Google
        autoDeleteFromGoogle(req.params.subtaskId);

        return res.json({ message: 'Subtask deleted' });
      }
    }

    // Search in contacts
    const contacts = await Contact.find({ workspaceId: req.workspaceId }, EXCLUDE_FILE_DATA);
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
        if (taskIndex !== -1) {
          const deletedSubtask = findAndDeleteSubtask(contact.tasks[taskIndex]);
          if (deletedSubtask) {
            contact.markModified('tasks');
            await contact.save();

            io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
            io.to(`workspace-${req.workspaceId}`).emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            }));

            // Build parent task object with contact info
            const parentTask = {
              ...contact.tasks[taskIndex],
              contactId: contact._id.toString(),
              contactName: contact.name
            };

            // Send notifications for deleted subtask and all nested subtasks
            await sendDeleteNotifications(deletedSubtask, parentTask);

            // Auto-delete subtask from Google
            autoDeleteFromGoogle(req.params.subtaskId);

            return res.json({ message: 'Subtask deleted' });
          }
        }
      }
    }

    return res.status(404).json({ message: 'Task or subtask not found' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ==================== FILE ATTACHMENTS ====================

// Helper: find subtask recursively and return reference
const findSubtaskById = (subtasks, subtaskId) => {
  for (const s of subtasks) {
    if (s.id === subtaskId) return s;
    if (s.subtasks?.length) {
      const found = findSubtaskById(s.subtasks, subtaskId);
      if (found) return found;
    }
  }
  return null;
};

// Upload file to task
router.post('/:taskId/files', authenticateToken, requireWorkspace, enforceWorkspaceLimits, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'Súbor je príliš veľký (max 5MB)' });
      }
      return res.status(400).json({ message: err.message });
    }
    if (!req.file) return res.status(400).json({ message: 'Žiadny súbor' });

    try {
      const { taskId } = req.params;
      const subtaskId = req.query.subtaskId;

      const base64Data = req.file.buffer.toString('base64');
      const fileId = uuidv4();

      // Metadata only (no Base64 data in document — stored in ContactFile collection)
      const fileMeta = {
        id: fileId,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date()
      };

      // Try global Task first (only if taskId is a valid ObjectId)
      if (mongoose.Types.ObjectId.isValid(taskId)) {
        const task = await Task.findOne({ _id: taskId, workspaceId: req.workspaceId });
        if (task) {
          // Save file data to ContactFile collection
          await ContactFile.create({ fileId, data: base64Data });

          if (subtaskId) {
            const subtask = findSubtaskById(task.subtasks, subtaskId);
            if (!subtask) return res.status(404).json({ message: 'Úloha nenájdená' });
            if (!subtask.files) subtask.files = [];
            subtask.files.push(fileMeta);
            task.markModified('subtasks');
          } else {
            task.files.push(fileMeta);
          }
          await task.save();
          return res.json({ message: 'Súbor nahraný', file: fileMeta });
        }
      }

      // Search in contact tasks (handles UUID task IDs)
      const contact = await Contact.findOne({
        workspaceId: req.workspaceId,
        'tasks.id': taskId
      });
      if (!contact) return res.status(404).json({ message: 'Projekt nenájdený' });

      const contactTask = contact.tasks.find(t => t.id === taskId);
      if (!contactTask) return res.status(404).json({ message: 'Projekt nenájdený' });

      // Save file data to ContactFile collection
      await ContactFile.create({ contactId: contact._id, fileId, data: base64Data });

      if (subtaskId) {
        const subtask = findSubtaskById(contactTask.subtasks, subtaskId);
        if (!subtask) return res.status(404).json({ message: 'Úloha nenájdená' });
        if (!subtask.files) subtask.files = [];
        subtask.files.push(fileMeta);
      } else {
        if (!contactTask.files) contactTask.files = [];
        contactTask.files.push(fileMeta);
      }
      contact.markModified('tasks');
      await contact.save();

      res.json({ message: 'Súbor nahraný', file: fileMeta });
    } catch (error) {
      logger.error('Task file upload error', { error: error.message });
      res.status(500).json({ message: 'Chyba pri nahrávaní súboru' });
    }
  });
});

// Download file from task
router.get('/:taskId/files/:fileId/download', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { taskId, fileId } = req.params;
    const subtaskId = req.query.subtaskId;
    let fileMeta;

    // Try global Task first (only if taskId is a valid ObjectId)
    if (mongoose.Types.ObjectId.isValid(taskId)) {
      const task = await Task.findOne({ _id: taskId, workspaceId: req.workspaceId });
      if (task) {
        if (subtaskId) {
          const subtask = findSubtaskById(task.subtasks, subtaskId);
          if (subtask) fileMeta = (subtask.files || []).find(f => f.id === fileId);
        } else {
          fileMeta = task.files.find(f => f.id === fileId);
        }
      }
    }

    // If not found, search in contact tasks (handles UUID task IDs)
    if (!fileMeta) {
      const contact = await Contact.findOne({
        workspaceId: req.workspaceId,
        'tasks.id': taskId
      });
      if (contact) {
        const contactTask = contact.tasks.find(t => t.id === taskId);
        if (contactTask) {
          if (subtaskId) {
            const subtask = findSubtaskById(contactTask.subtasks, subtaskId);
            if (subtask) fileMeta = (subtask.files || []).find(f => f.id === fileId);
          } else {
            fileMeta = (contactTask.files || []).find(f => f.id === fileId);
          }
        }
      }
    }

    if (!fileMeta) return res.status(404).json({ message: 'Súbor nenájdený' });

    // Try ContactFile collection first, fall back to legacy embedded data
    let base64Data;
    const contactFile = await ContactFile.findOne({ fileId }, { data: 1 }).lean();
    if (contactFile) {
      base64Data = contactFile.data;
    } else if (fileMeta.data) {
      // Legacy: data still embedded — migrate on-the-fly
      base64Data = fileMeta.data;
      ContactFile.updateOne(
        { fileId },
        { $setOnInsert: { fileId, data: base64Data } },
        { upsert: true }
      ).catch(() => {}); // Fire-and-forget — just ensure it's saved for next time
    } else {
      return res.status(404).json({ message: 'Dáta súboru nenájdené' });
    }

    const fileBuffer = Buffer.from(base64Data, 'base64');
    res.set({
      'Content-Type': fileMeta.mimetype,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileMeta.originalName)}"`,
      'Content-Length': fileBuffer.length,
      'Cross-Origin-Resource-Policy': 'cross-origin'
    });
    res.send(fileBuffer);
  } catch (error) {
    logger.error('Task file download error', { error: error.message, stack: error.stack, taskId: req.params.taskId, fileId: req.params.fileId, subtaskId: req.query.subtaskId });
    res.status(500).json({ message: 'Chyba pri sťahovaní súboru' });
  }
});

// Delete file from task
router.delete('/:taskId/files/:fileId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { taskId, fileId } = req.params;
    const subtaskId = req.query.subtaskId;

    // Delete file data from ContactFile collection
    await ContactFile.deleteOne({ fileId }).catch(() => {});

    // Try global Task first (only if taskId is a valid ObjectId)
    if (mongoose.Types.ObjectId.isValid(taskId)) {
      const task = await Task.findOne({ _id: taskId, workspaceId: req.workspaceId });
      if (task) {
        if (subtaskId) {
          const subtask = findSubtaskById(task.subtasks, subtaskId);
          if (!subtask) return res.status(404).json({ message: 'Úloha nenájdená' });
          subtask.files = (subtask.files || []).filter(f => f.id !== fileId);
          task.markModified('subtasks');
        } else {
          task.files = task.files.filter(f => f.id !== fileId);
        }
        await task.save();
        return res.json({ message: 'Súbor vymazaný' });
      }
    }

    // Search in contact tasks (handles UUID task IDs)
    const contact = await Contact.findOne({
      workspaceId: req.workspaceId,
      'tasks.id': taskId
    });
    if (!contact) return res.status(404).json({ message: 'Projekt nenájdený' });

    const contactTask = contact.tasks.find(t => t.id === taskId);
    if (!contactTask) return res.status(404).json({ message: 'Projekt nenájdený' });

    if (subtaskId) {
      const subtask = findSubtaskById(contactTask.subtasks, subtaskId);
      if (!subtask) return res.status(404).json({ message: 'Úloha nenájdená' });
      subtask.files = (subtask.files || []).filter(f => f.id !== fileId);
    } else {
      contactTask.files = (contactTask.files || []).filter(f => f.id !== fileId);
    }
    contact.markModified('tasks');
    await contact.save();
    res.json({ message: 'Súbor vymazaný' });
  } catch (error) {
    logger.error('Task file delete error', { error: error.message });
    res.status(500).json({ message: 'Chyba pri mazaní súboru' });
  }
});

module.exports = router;
