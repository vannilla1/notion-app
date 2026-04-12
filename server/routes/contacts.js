const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace, enforceWorkspaceLimits } = require('../middleware/workspace');
const Contact = require('../models/Contact');
const User = require('../models/User');
const { autoSyncTaskToCalendar, autoDeleteTaskFromCalendar } = require('./googleCalendar');
const { autoSyncTaskToGoogleTasks, autoDeleteTaskFromGoogleTasks } = require('./googleTasks');
const notificationService = require('../services/notificationService');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');

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

const router = express.Router();

// Multer config for file uploads - use memory storage for MongoDB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    // Allow most common file types
    const allowedExtensions = /jpeg|jpg|png|gif|bmp|webp|svg|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|json|xml|zip|rar|7z|mp3|mp4|wav|avi|mov/;
    const ext = file.originalname.toLowerCase().split('.').pop();
    const extAllowed = allowedExtensions.test(ext);

    // Allow common mimetypes
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

// Diagnostic endpoint to check workspace data size
router.get('/diagnostics', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const stats = await Contact.aggregate([
      { $match: { workspaceId: req.workspaceId } },
      { $project: {
        docSize: { $bsonSize: '$$ROOT' },
        filesCount: { $size: { $ifNull: ['$files', []] } },
        tasksCount: { $size: { $ifNull: ['$tasks', []] } },
        name: 1
      }},
      { $sort: { docSize: -1 } }
    ]).option({ maxTimeMS: 45000 });

    const totalSize = stats.reduce((sum, s) => sum + s.docSize, 0);
    res.json({
      contactCount: stats.length,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
      avgSizeKB: stats.length ? (totalSize / stats.length / 1024).toFixed(2) : 0,
      top5: stats.slice(0, 5).map(s => ({
        name: s.name,
        sizeMB: (s.docSize / 1024 / 1024).toFixed(2),
        filesCount: s.filesCount,
        tasksCount: s.tasksCount
      }))
    });
  } catch (error) {
    logger.error('Diagnostics error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get all contacts (for current workspace) - sorted alphabetically by name
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Use aggregation pipeline - more efficient for large documents with embedded files
    const contacts = await Contact.aggregate([
      { $match: { workspaceId: req.workspaceId } },
      { $project: {
        name: 1, email: 1, phone: 1, company: 1, website: 1,
        notes: 1, status: 1, tasks: 1, userId: 1,
        createdAt: 1, updatedAt: 1
      }},
      { $sort: { name: 1 } }
    ]).option({ maxTimeMS: 45000 });

    const contactsWithId = contacts.map(contact => ({
      ...contact,
      id: contact._id.toString()
    }));
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
      { 'files.data': 0, 'tasks.files.data': 0 }
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
      { 'files.data': 0 }
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
router.put('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { name, email, phone, company, website, notes, status } = req.body;

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: 'Neplatný formát emailu' });
    }

    if (phone && !isValidPhone(phone)) {
      return res.status(400).json({ message: 'Telefón môže obsahovať len čísla, medzery, pomlčky a znak +' });
    }

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

    // Files are stored in MongoDB as Base64, no disk cleanup needed

    // Store contact data for notification before deletion
    const contactData = { _id: contact._id, name: contact.name };

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

    // BUGFIX: Mark tasks as modified to ensure Mongoose persists nested changes
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

    const deletedTaskId = contact.tasks[taskIndex].id;
    contact.tasks.splice(taskIndex, 1);
    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-delete from Google
    autoDeleteContactFromGoogle(deletedTaskId);

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

    // BUGFIX: Preserve all existing fields including priority and nested subtasks
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

    const deletedSubtaskId = found.subtask.id;
    found.parent.splice(found.index, 1);

    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-delete subtask from Google
    autoDeleteContactFromGoogle(deletedSubtaskId);

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

      const fileData = {
        id: uuidv4(),
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        data: base64Data,
        uploadedAt: new Date()
      };

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

// Download file (from MongoDB Base64)
router.get('/:id/files/:fileId/download', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const file = contact.files.find(f => f.id === req.params.fileId);
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    if (!file.data) {
      return res.status(404).json({ message: 'File data not found' });
    }

    // Convert Base64 back to buffer
    const fileBuffer = Buffer.from(file.data, 'base64');

    // Set headers for file download
    res.set({
      'Content-Type': file.mimetype,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalName)}"`,
      'Content-Length': fileBuffer.length
    });

    res.send(fileBuffer);
  } catch (error) {
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

    contact.files.splice(fileIndex, 1);
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    res.json({ message: 'File deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
