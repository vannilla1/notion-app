const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace, enforceWorkspaceLimits } = require('../middleware/workspace');
const Contact = require('../models/Contact');
const ContactFile = require('../models/ContactFile');
const User = require('../models/User');
const { autoSyncTaskToCalendar, autoDeleteTaskFromCalendar } = require('./googleCalendar');
const { autoSyncTaskToGoogleTasks, autoDeleteTaskFromGoogleTasks } = require('./googleTasks');
const notificationService = require('../services/notificationService');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');
const { getCachedData, setCachedData, invalidateWorkspaceData } = require('../middleware/dataCache');

// Projection to exclude Base64 file data from all nesting levels (up to 6 deep)
const EXCLUDE_FILE_DATA = {
  'files.data': 0,
  'tasks.files.data': 0,
  'tasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.subtasks.subtasks.files.data': 0,
};

// Helper to sync contact tasks to both Google Calendar and Google Tasks
const autoSyncContactToGoogle = async (taskData, action) => {
  await Promise.all([
    autoSyncTaskToCalendar(taskData, action).catch(err =>
      logger.warn('Auto-sync Calendar (contact) error', { error: err.message })
    ),
    autoSyncTaskToGoogleTasks(taskData, action).catch(err =>
      logger.warn('Auto-sync Tasks (contact) error', { error: err.message })
    )
  ]);
};

const autoDeleteContactFromGoogle = async (taskId) => {
  await Promise.all([
    autoDeleteTaskFromCalendar(taskId).catch(err =>
      logger.warn('Auto-delete Calendar (contact) error', { error: err.message })
    ),
    autoDeleteTaskFromGoogleTasks(taskId).catch(err =>
      logger.warn('Auto-delete Tasks (contact) error', { error: err.message })
    )
  ]);
};

/**
 * When a whole contact gets deleted, every task (and every nested subtask)
 * stored inside it must also vanish from Google. Collect every ID first,
 * then fan out parallel deletes. Previously only top-level contact task
 * deletes cleaned up Google — deleting the contact itself left dozens of
 * orphan events pointing to a kontakt that no longer exists.
 */
const collectAllTaskIdsFromContact = (contact) => {
  const ids = [];
  const walk = (subtasks) => {
    if (!Array.isArray(subtasks)) return;
    for (const sub of subtasks) {
      if (sub?.id) ids.push(String(sub.id));
      if (Array.isArray(sub?.subtasks) && sub.subtasks.length > 0) walk(sub.subtasks);
    }
  };
  if (Array.isArray(contact?.tasks)) {
    for (const t of contact.tasks) {
      if (t?.id) ids.push(String(t.id));
      walk(t.subtasks);
    }
  }
  return ids;
};

const autoDeleteAllTasksOfContactFromGoogle = (contact) => {
  const ids = collectAllTaskIdsFromContact(contact);
  for (const id of ids) {
    autoDeleteContactFromGoogle(id).catch(() => {});
  }
};

/**
 * Same idea as in tasks.js — cascade delete a whole task subtree (task + all
 * nested subtasks). Used when a single contact task (with nested subtasks)
 * or a subtask tree is removed.
 */
const autoDeleteTaskTreeFromGoogle = (task) => {
  if (!task) return;
  const ids = [];
  const rootId = task.id || (task._id && task._id.toString());
  if (rootId) ids.push(String(rootId));
  const walk = (subtasks) => {
    if (!Array.isArray(subtasks)) return;
    for (const sub of subtasks) {
      if (sub?.id) ids.push(String(sub.id));
      if (Array.isArray(sub?.subtasks) && sub.subtasks.length > 0) walk(sub.subtasks);
    }
  };
  walk(task.subtasks);
  for (const id of ids) {
    autoDeleteContactFromGoogle(id).catch(() => {});
  }
};

const router = express.Router();

// Auto-invalidate contacts cache after any mutation (POST/PUT/DELETE)
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    const origJson = res.json.bind(res);
    res.json = (data) => {
      // Invalidate after successful response
      if (res.statusCode < 400 && req.workspaceId) {
        invalidateWorkspaceData(req.workspaceId, 'contacts');
        invalidateWorkspaceData(req.workspaceId, 'tasks'); // contacts have embedded tasks
      }
      return origJson(data);
    };
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = /jpeg|jpg|png|gif|bmp|webp|svg|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|json|xml|zip|rar|7z|mp3|mp4|wav|avi|mov/;
    const ext = file.originalname.toLowerCase().split('.').pop();
    const extAllowed = allowedExtensions.test(ext);

    const allowedMimetypes = [
      'image/', 'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument',
      'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
      'text/', 'audio/', 'video/',
      'application/zip', 'application/x-rar', 'application/x-7z-compressed',
      'application/json', 'application/xml'
    ];
    const mimeAllowed = allowedMimetypes.some(type => file.mimetype.startsWith(type) || file.mimetype === type);

    if (extAllowed || mimeAllowed) {
      return cb(null, true);
    }
    cb(new Error('Nepovolený typ súboru'));
  }
});

// Validation helpers
const isValidEmail = (email) => {
  if (!email) return true;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const isValidPhone = (phone) => {
  if (!phone) return true;
  const phoneRegex = /^[+]?[0-9\s-]+$/;
  return phoneRegex.test(phone);
};

// Helper function to convert contact to plain object with deep copy of nested subtasks
const contactToPlainObject = (contact) => {
  const obj = contact.toObject ? contact.toObject() : contact;
  const result = JSON.parse(JSON.stringify({
    ...obj,
    id: obj._id ? obj._id.toString() : obj.id
  }));
  // Strip file data (too large for socket.io)
  if (result.files && result.files.length > 0) {
    result.files = result.files.map(f => ({
      id: f.id,
      originalName: f.originalName,
      mimetype: f.mimetype,
      size: f.size,
      uploadedAt: f.uploadedAt
    }));
  }
  return result;
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

// Get all contacts (for current workspace) - sorted alphabetically by name
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Check cache first (avoids DB query for 30s)
    const cached = getCachedData(req.workspaceId, 'contacts');
    if (cached) return res.json(cached);

    // files.data is now stored in ContactFile collection, so Contact docs are small
    const contacts = await Contact.find(
      { workspaceId: req.workspaceId },
      EXCLUDE_FILE_DATA
    ).sort({ name: 1 }).lean();

    const contactsWithId = contacts.map(contact => ({
      ...contact,
      id: contact._id.toString()
    }));

    // Cache result for 30s
    setCachedData(req.workspaceId, 'contacts', contactsWithId);

    res.json(contactsWithId);
  } catch (error) {
    logger.error('GET /contacts error', { error: error.message, workspaceId: req.workspaceId?.toString() });
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Export contacts to CSV
router.get('/export/csv', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contacts = await Contact.find(
      { workspaceId: req.workspaceId },
      EXCLUDE_FILE_DATA
    ).sort({ name: 1 }).lean();

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

    const statusMap = { new: 'Nový', active: 'Aktívny', completed: 'Dokončený', cancelled: 'Zrušený' };

    const headers = ['Meno', 'Email', 'Telefón', 'Firma', 'Web', 'Stav', 'Poznámky', 'Počet projektov', 'Dokončené projekty', 'Vytvorený'];
    const rows = contacts.map(c => {
      const taskCount = (c.tasks || []).length;
      const completedTasks = (c.tasks || []).filter(t => t.completed).length;
      return [
        escCsv(c.name),
        escCsv(c.email),
        escCsv(c.phone),
        escCsv(c.company),
        escCsv(c.website),
        escCsv(statusMap[c.status] || c.status),
        escCsv(c.notes),
        taskCount,
        completedTasks,
        escCsv(c.createdAt ? new Date(c.createdAt).toLocaleDateString('sk-SK') : '')
      ].join(',');
    });

    const bom = '\uFEFF';
    const csv = bom + headers.join(',') + '\n' + rows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kontakty.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri exporte' });
  }
});

// Get single contact
router.get('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Exclude files.data field - it contains large Base64 data
    const contact = await Contact.findOne(
      { _id: req.params.id, workspaceId: req.workspaceId },
      EXCLUDE_FILE_DATA
    ).lean();
    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }
    res.json({ ...contact, id: contact._id.toString() });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Create contact
router.post('/', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
  try {
    const { name, email, phone, company, website, notes, status } = req.body;

    // Check plan contact limit
    const user = await User.findById(req.user.id);
    const plan = user?.subscription?.plan || 'free';
    const contactLimits = { free: 5, trial: 5, team: 25, pro: Infinity };
    const maxContacts = contactLimits[plan] || 5;
    if (maxContacts !== Infinity) {
      const contactCount = await Contact.countDocuments({ workspaceId: req.workspaceId });
      if (contactCount >= maxContacts) {
        return res.status(403).json({ message: `Váš plán umožňuje max. ${maxContacts} kontaktov. Pre viac kontaktov prejdite na vyšší plán.` });
      }
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: 'Neplatný formát emailu' });
    }

    if (phone && !isValidPhone(phone)) {
      return res.status(400).json({ message: 'Telefón môže obsahovať len čísla, medzery, pomlčky a znak +' });
    }

    const contact = new Contact({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      name: name || '',
      email: email || '',
      phone: phone || '',
      company: company || '',
      website: website || '',
      notes: notes || '',
      status: status || 'new',
      files: [],
      tasks: []
    });

    await contact.save();

    const io = req.app.get('io');
    const contactData = contactToPlainObject(contact);
    io.to(`workspace-${req.workspaceId}`).emit('contact-created', contactData);

    // Send notification to workspace members except creator
    await notificationService.notifyContactChange('contact.created', contact, req.user, req.workspaceId);

    res.status(201).json(contactData);

    // Audit log (fire and forget)
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'contact.created',
      category: 'contact',
      targetType: 'contact',
      targetId: contact._id.toString(),
      targetName: contact.name,
      details: { name: contact.name, email: contact.email, company: contact.company },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update contact
// Status change na 'cancelled' alebo 'completed' = deal sa neuskutočnil /
// je zavretý, takže aj všetky otvorené úlohy a podúlohy pod kontaktom, ktoré
// boli zosynchronizované do Google Calendara a Google Tasks, už nemajú v
// používateľovom kalendári čo hľadať — inak tam visia ako ghost-eventy,
// stále pending, a používateľ ich musí manuálne odklikávať vo dvoch
// aplikáciach zvlášť.
//
// Rovnaký cascade helper ako pri hard-delete — walk cez tasks[].subtasks[]
// → autoDeleteContactFromGoogle per id → paralelné calendar.events.delete +
// tasks.tasks.delete. Používateľovo mapping (syncedTaskIds) je user-scoped,
// takže cleanup funguje aj bez toho, aby sa Contact dokument mazal.
const TERMINAL_STATUSES = new Set(['cancelled', 'completed']);

router.put('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { name, email, phone, company, website, notes, status } = req.body;

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: 'Neplatný formát emailu' });
    }

    if (phone && !isValidPhone(phone)) {
      return res.status(400).json({ message: 'Telefón môže obsahovať len čísla, medzery, pomlčky a znak +' });
    }

    // Načítame pôvodný kontakt PRED updatom — potrebujeme:
    //   1. starý status na detekciu prechodu → terminal,
    //   2. celý strom tasks/subtasks, ktorý po update-e stále existuje
    //      (status change nemaže tasks) a z ktorého vyčítame ids pre cascade
    //      Google cleanup. Keby sme si strom neuložili pred update-om, boli
    //      by sme závislí od toho, že `findOneAndUpdate` ho vráti — čo síce
    //      vracia (new: true), ale čistejšie je oddeliť read a write.
    const previousContact = await Contact.findOne(
      { _id: req.params.id, workspaceId: req.workspaceId }
    );

    if (!previousContact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const previousStatus = previousContact.status;

    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspaceId },
      {
        name, email, phone, company, website, notes, status
      },
      { new: true }
    );

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    // Detekcia prechodu na terminálny status (zrušený / dokončený).
    // Spustíme cascade iba pri ZMENE statusu — ak už bol kontakt dlhodobo
    // 'cancelled' a user len edituje poznámku, nepúšťame opäť delete cez
    // Google API (mapping by aj tak bol prázdny, ale ušetríme kopec zbytočných
    // 404-tok a log šumu).
    const becameTerminal = status
      && TERMINAL_STATUSES.has(status)
      && !TERMINAL_STATUSES.has(previousStatus);

    if (becameTerminal) {
      // Fire-and-forget — response nečakáme na Google, aby UI nebolo blokované
      // niekoľkými sekundami kým paralelné events.delete / tasks.delete
      // dobehnú. Chyby sú zalogované vnútri helperu.
      autoDeleteAllTasksOfContactFromGoogle(previousContact);
    }

    const io = req.app.get('io');
    const contactData = contactToPlainObject(contact);
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactData);

    // Send notification to workspace members except updater
    await notificationService.notifyContactChange('contact.updated', contact, req.user, req.workspaceId);

    res.json(contactData);

    // Audit log (fire and forget)
    const changedFields = Object.keys(req.body).filter(k => req.body[k] !== undefined);
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'contact.updated',
      category: 'contact',
      targetType: 'contact',
      targetId: contact._id.toString(),
      targetName: contact.name,
      details: { changedFields },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete contact
router.delete('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    // Store contact data for notification before deletion
    const contactData = { _id: contact._id, name: contact.name };

    // Cascade cleanup to Google BEFORE removing the contact from Mongo.
    // If we deleted first, autoSync would have no workspace context to look
    // up (task is gone) and the events would orphan forever in Google.
    autoDeleteAllTasksOfContactFromGoogle(contact);

    // Cascade: zmaž aj prílohy v ContactFile kolekcii. Bez tohto zostanú
    // orphaned Base64 payloady v DB (MB per file) aj po zmazaní kontaktu —
    // hromadí sa to tichu v tle a bloatuje Mongo storage. ContactFile má
    // contactId ref, ale Mongoose neposkytuje auto-cascade, musíme ručne.
    await ContactFile.deleteMany({ contactId: req.params.id });
    await Contact.findByIdAndDelete(req.params.id);

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-deleted', { id: req.params.id });

    // Send notification to workspace members except deleter
    await notificationService.notifyContactChange('contact.deleted', contactData, req.user, req.workspaceId);

    res.json({ message: 'Contact deleted' });

    // Audit log (fire and forget)
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'contact.deleted',
      category: 'contact',
      targetType: 'contact',
      targetId: req.params.id,
      targetName: contactData.name,
      details: { name: contactData.name },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ==================== TASKS ====================

// Add task to contact
router.post('/:contactId/tasks', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
  try {
    const { title, description, dueDate, priority, assignedTo } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Názov projektu je povinný' });
    }

    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const now = new Date().toISOString();
    const task = {
      id: uuidv4(),
      title: title.trim(),
      description: description || '',
      dueDate: dueDate || null,
      priority: priority || 'medium',
      completed: false,
      assignedTo: assignedTo || [],
      subtasks: [],
      createdAt: now,
      modifiedAt: now // Set on creation for "new" filter
    };

    contact.tasks.push(task);
    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-sync to Google
    autoSyncContactToGoogle({
      id: task.id,
      title: task.title,
      description: task.description,
      dueDate: task.dueDate,
      completed: task.completed,
      assignedTo: task.assignedTo,
      workspaceId: req.workspaceId?.toString(),
      contact: contact.name
    }, 'create');

    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update task
router.put('/:contactId/tasks/:taskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { title, description, dueDate, priority, completed, assignedTo } = req.body;

    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

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

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-sync to Google
    const updatedTask = contact.tasks[taskIndex];
    autoSyncContactToGoogle({
      id: updatedTask.id,
      title: updatedTask.title,
      description: updatedTask.description,
      dueDate: updatedTask.dueDate,
      completed: updatedTask.completed,
      assignedTo: updatedTask.assignedTo,
      workspaceId: req.workspaceId?.toString(),
      contact: contact.name
    }, 'update');

    res.json(contact.tasks[taskIndex]);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete task
router.delete('/:contactId/tasks/:taskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Snapshot before splice so we can walk the subtask tree for cleanup.
    const deletedTask = contact.tasks[taskIndex];
    contact.tasks.splice(taskIndex, 1);
    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-delete from Google (cascades to nested subtasks so nothing orphans).
    autoDeleteTaskTreeFromGoogle(deletedTask);

    res.json({ message: 'Task deleted' });
  } catch (error) {
    logger.error('Delete task error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Add subtask to task
router.post('/:contactId/tasks/:taskId/subtasks', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
  try {
    const { title, parentSubtaskId, dueDate, notes, priority } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Nazov ulohy je povinny' });
    }

    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check plan limit for subtasks per task
    const user = await User.findById(req.user.id);
    const plan = user?.subscription?.plan || 'free';
    const subtaskLimits = { free: 10, trial: 10, team: 25, pro: Infinity };
    const maxSubtasks = subtaskLimits[plan] || 10;
    if (maxSubtasks !== Infinity) {
      const countSubtasks = (subs) => (subs || []).reduce((sum, s) => sum + 1 + countSubtasks(s.subtasks), 0);
      if (countSubtasks(contact.tasks[taskIndex].subtasks) >= maxSubtasks) {
        return res.status(403).json({ message: `Váš plán umožňuje max. ${maxSubtasks} úloh na projekt. Pre viac prejdite na vyšší plán.` });
      }
    }

    const now = new Date().toISOString();
    const subtask = {
      id: uuidv4(),
      title: title.trim(),
      completed: false,
      dueDate: dueDate || null,
      notes: notes || '',
      priority: priority || null,
      subtasks: [],
      createdAt: now,
      modifiedAt: now // Set on creation for "new" filter
    };

    const task = contact.tasks[taskIndex];

    if (parentSubtaskId) {
      const found = findSubtaskRecursive(task.subtasks, parentSubtaskId);
      if (found) {
        if (!found.subtask.subtasks) {
          found.subtask.subtasks = [];
        }
        found.subtask.subtasks.push(subtask);
        // Update parent subtask's modifiedAt when child is added
        found.subtask.modifiedAt = now;
      } else {
        return res.status(404).json({ message: 'Parent subtask not found' });
      }
    } else {
      if (!task.subtasks) {
        task.subtasks = [];
      }
      task.subtasks.push(subtask);
    }

    // Update parent task's modifiedAt when subtask is added
    task.modifiedAt = now;

    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-sync subtask to Google
    autoSyncContactToGoogle({
      id: subtask.id,
      title: `${subtask.title} (${task.title})`,
      description: subtask.notes,
      dueDate: subtask.dueDate,
      completed: subtask.completed,
      assignedTo: task.assignedTo || [],
      workspaceId: req.workspaceId?.toString(),
      contact: contact.name
    }, 'create');

    res.status(201).json(subtask);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update subtask
router.put('/:contactId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { title, completed, dueDate, notes } = req.body;

    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const task = contact.tasks[taskIndex];
    const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);

    if (!found) {
      return res.status(404).json({ message: 'Subtask not found' });
    }

    found.parent[found.index] = {
      ...found.subtask,
      id: found.subtask.id, // Ensure ID is preserved
      title: title !== undefined ? title : found.subtask.title,
      completed: completed !== undefined ? completed : found.subtask.completed,
      dueDate: dueDate !== undefined ? dueDate : found.subtask.dueDate,
      notes: notes !== undefined ? notes : found.subtask.notes,
      priority: found.subtask.priority, // Preserve priority
      subtasks: found.subtask.subtasks || [], // Preserve nested subtasks
      createdAt: found.subtask.createdAt, // Preserve createdAt
      modifiedAt: new Date().toISOString() // Set modification timestamp
    };

    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-sync subtask to Google
    const updatedSubtask = found.parent[found.index];
    autoSyncContactToGoogle({
      id: updatedSubtask.id,
      title: `${updatedSubtask.title} (${task.title})`,
      description: updatedSubtask.notes,
      dueDate: updatedSubtask.dueDate,
      completed: updatedSubtask.completed,
      assignedTo: task.assignedTo || [],
      workspaceId: req.workspaceId?.toString(),
      contact: contact.name
    }, 'update');

    res.json(found.parent[found.index]);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete subtask
router.delete('/:contactId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const task = contact.tasks[taskIndex];
    const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);

    if (!found) {
      return res.status(404).json({ message: 'Subtask not found' });
    }

    // Snapshot the subtask (with any nested sub-subtasks) before splicing
    // so we can cascade the Google cleanup properly.
    const deletedSubtask = found.subtask;
    found.parent.splice(found.index, 1);

    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Cascades to nested sub-subtasks so no orphan events remain.
    autoDeleteTaskTreeFromGoogle(deletedSubtask);

    res.json({ message: 'Subtask deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ==================== FILE UPLOAD ====================

// Upload file to contact (stored in MongoDB as Base64)
router.post('/:id/files', authenticateToken, requireWorkspace, enforceWorkspaceLimits, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    try {
      // Handle multer errors
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ message: 'Súbor je príliš veľký. Maximum je 10MB.' });
        }
        return res.status(400).json({ message: err.message || 'Chyba pri nahrávaní súboru' });
      }

      const contact = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
      if (!contact) {
        return res.status(404).json({ message: 'Contact not found' });
      }

      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      // Convert file buffer to Base64
      const base64Data = req.file.buffer.toString('base64');
      const fileId = uuidv4();

      const fileData = {
        id: fileId,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date()
      };

      // Save file data to separate collection (keeps Contact documents small)
      await ContactFile.create({
        contactId: contact._id,
        fileId: fileId,
        data: base64Data
      });

      // Only store metadata in Contact (no data field)
      contact.files.push(fileData);
      await contact.save();

      const io = req.app.get('io');
      if (io) {
        io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
      }

      // Don't send the data field back to client (too large)
      const responseData = {
        id: fileData.id,
        originalName: fileData.originalName,
        mimetype: fileData.mimetype,
        size: fileData.size,
        uploadedAt: fileData.uploadedAt
      };

      res.status(201).json(responseData);
    } catch (error) {
      logger.error('File upload error', { error: error.message });
      res.status(500).json({ message: 'Chyba servera' });
    }
  });
});

// Download file (from ContactFile collection or legacy Contact.files.data)
router.get('/:id/files/:fileId/download', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { id: contactId, fileId } = req.params;
    logger.info('Contact file download request', { contactId, fileId });

    // Load contact with file metadata only (no Base64 data)
    const contact = await Contact.findOne(
      { _id: contactId, workspaceId: req.workspaceId },
      { files: 1, 'tasks.id': 1, 'tasks.files': 1, 'tasks.subtasks': 1 }
    ).lean();
    if (!contact) {
      logger.warn('Contact file download: contact not found', { contactId });
      return res.status(404).json({ message: 'Contact not found' });
    }

    // Search in contact-level files first
    let fileMeta = (contact.files || []).find(f => f.id === fileId);

    // If not found, search in contact task files
    if (!fileMeta) {
      const findFileInTasks = (tasks) => {
        if (!Array.isArray(tasks)) return null;
        for (const t of tasks) {
          const f = (t.files || []).find(f => f.id === fileId);
          if (f) return f;
          if (Array.isArray(t.subtasks)) {
            const found = findFileInTasks(t.subtasks);
            if (found) return found;
          }
        }
        return null;
      };
      fileMeta = findFileInTasks(contact.tasks);
    }

    if (!fileMeta) {
      logger.warn('Contact file download: file metadata not found', {
        contactId, fileId,
        contactFileCount: (contact.files || []).length,
        contactFileIds: (contact.files || []).map(f => f.id),
      });
      return res.status(404).json({ message: 'File not found' });
    }

    // Try ContactFile collection first, fall back to legacy embedded data
    let base64Data;
    const contactFile = await ContactFile.findOne(
      { fileId },
      { data: 1 }
    ).lean();

    if (contactFile) {
      base64Data = contactFile.data;
      logger.info('Contact file download: found in ContactFile', { fileId, dataLen: base64Data?.length });
    } else if (fileMeta.data) {
      // Legacy: data still embedded — migrate on-the-fly
      base64Data = fileMeta.data;
      logger.info('Contact file download: using legacy embedded data, migrating', { fileId });
      ContactFile.updateOne(
        { fileId },
        { $setOnInsert: { contactId, fileId, data: base64Data } },
        { upsert: true }
      ).catch(() => {});
    } else {
      logger.error('Contact file download: NO DATA anywhere', { contactId, fileId, fileName: fileMeta.originalName });
      return res.status(404).json({ message: 'File data not found — file may need to be re-uploaded' });
    }

    const fileBuffer = Buffer.from(base64Data, 'base64');

    res.set({
      'Content-Type': fileMeta.mimetype,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileMeta.originalName)}"`,
      'Content-Length': fileBuffer.length
    });

    res.send(fileBuffer);
  } catch (error) {
    logger.error('Contact file download error', { error: error.message, stack: error.stack, contactId: req.params.id, fileId: req.params.fileId });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete file from contact
router.delete('/:id/files/:fileId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const fileIndex = contact.files.findIndex(f => f.id === req.params.fileId);
    if (fileIndex === -1) {
      return res.status(404).json({ message: 'File not found' });
    }

    const deletedFileId = contact.files[fileIndex].id;
    contact.files.splice(fileIndex, 1);
    await contact.save();

    // Also delete from ContactFile collection
    await ContactFile.deleteOne({ contactId: contact._id, fileId: deletedFileId }).catch(() => {});

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    res.json({ message: 'File deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
