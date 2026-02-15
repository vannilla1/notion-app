const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace } = require('../middleware/workspace');
const Contact = require('../models/Contact');
const notificationService = require('../services/notificationService');
const logger = require('../utils/logger');

const router = express.Router();

// Multer config for file uploads - use memory storage for MongoDB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit (reduced for Base64 overhead)
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

// Helper to strip file data from contacts (too large for list views)
const stripFileData = (contact) => {
  const result = { ...contact, id: contact._id.toString() };
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

// Get all contacts (for current workspace) - sorted alphabetically by name
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Exclude files.data field from query - it contains large Base64 data
    const contacts = await Contact.find(
      { workspaceId: req.workspaceId },
      { 'files.data': 0 }
    ).sort({ name: 1 }).lean();
    // Add id field to each contact
    const contactsWithId = contacts.map(contact => ({
      ...contact,
      id: contact._id.toString()
    }));
    res.json(contactsWithId);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create contact
router.post('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { name, email, phone, company, website, notes, status } = req.body;

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
    io.emit('contact-created', contactData);

    // Send notification to all users except creator
    notificationService.notifyContactChange('contact.created', contact, req.user);

    res.status(201).json(contactData);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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
    io.emit('contact-updated', contactData);

    // Send notification to all users except updater
    notificationService.notifyContactChange('contact.updated', contact, req.user);

    res.json(contactData);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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
    io.emit('contact-deleted', { id: req.params.id });

    // Send notification to all users except deleter
    notificationService.notifyContactChange('contact.deleted', contactData, req.user);

    res.json({ message: 'Contact deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== TASKS ====================

// Add task to contact
router.post('/:contactId/tasks', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { title, description, dueDate, priority, assignedTo } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Názov úlohy je povinný' });
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
    io.emit('contact-updated', contactToPlainObject(contact));

    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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
    io.emit('contact-updated', contactToPlainObject(contact));

    res.json(contact.tasks[taskIndex]);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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

    contact.tasks.splice(taskIndex, 1);
    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.emit('contact-updated', contactToPlainObject(contact));

    res.json({ message: 'Task deleted' });
  } catch (error) {
    logger.error('Delete task error', { error: error.message });
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Add subtask to task
router.post('/:contactId/tasks/:taskId/subtasks', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { title, parentSubtaskId, dueDate, notes, priority } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Nazov podulohy je povinny' });
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
    io.emit('contact-updated', contactToPlainObject(contact));

    res.status(201).json(subtask);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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
    io.emit('contact-updated', contactToPlainObject(contact));

    res.json(found.parent[found.index]);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
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

    found.parent.splice(found.index, 1);

    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.emit('contact-updated', contactToPlainObject(contact));

    res.json({ message: 'Subtask deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== FILE UPLOAD ====================

// Upload file to contact (stored in MongoDB as Base64)
router.post('/:id/files', authenticateToken, requireWorkspace, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    try {
      // Handle multer errors
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ message: 'Súbor je príliš veľký. Maximum je 5MB.' });
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
        io.emit('contact-updated', contactToPlainObject(contact));
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
      res.status(500).json({ message: 'Server error', error: error.message });
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
    res.status(500).json({ message: 'Server error', error: error.message });
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
    io.emit('contact-updated', contactToPlainObject(contact));

    res.json({ message: 'File deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
