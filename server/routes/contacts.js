const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const Contact = require('../models/Contact');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '../uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype) ||
                     file.mimetype === 'application/pdf' ||
                     file.mimetype === 'application/msword' ||
                     file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                     file.mimetype === 'application/vnd.ms-excel' ||
                     file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                     file.mimetype === 'text/plain';
    if (extname || mimetype) {
      return cb(null, true);
    }
    cb(new Error('Invalid file type'));
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
  return JSON.parse(JSON.stringify({
    ...obj,
    id: obj._id ? obj._id.toString() : obj.id
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

// Get all contacts (shared workspace) - sorted alphabetically by name
router.get('/', authenticateToken, async (req, res) => {
  try {
    const contacts = await Contact.find({}).sort({ name: 1 }).lean();
    // Add id field to each contact (lean() doesn't apply toJSON transforms)
    const contactsWithId = contacts.map(c => ({
      ...c,
      id: c._id.toString()
    }));
    res.json(contactsWithId);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get single contact
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id).lean();
    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }
    res.json({
      ...contact,
      id: contact._id.toString()
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create contact
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, company, website, notes, status } = req.body;

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: 'Neplatný formát emailu' });
    }

    if (phone && !isValidPhone(phone)) {
      return res.status(400).json({ message: 'Telefón môže obsahovať len čísla, medzery, pomlčky a znak +' });
    }

    const contact = new Contact({
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

    res.status(201).json(contactData);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update contact
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, company, website, notes, status } = req.body;

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: 'Neplatný formát emailu' });
    }

    if (phone && !isValidPhone(phone)) {
      return res.status(400).json({ message: 'Telefón môže obsahovať len čísla, medzery, pomlčky a znak +' });
    }

    const contact = await Contact.findByIdAndUpdate(
      req.params.id,
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

    res.json(contactData);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete contact
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    // Delete associated files
    if (contact.files) {
      contact.files.forEach(file => {
        const filePath = path.join(UPLOADS_DIR, file.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      });
    }

    await Contact.findByIdAndDelete(req.params.id);

    const io = req.app.get('io');
    io.emit('contact-deleted', { id: req.params.id });

    res.json({ message: 'Contact deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Upload file to contact
router.post('/:id/files', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const contact = await Contact.findById(req.params.id);

    if (!contact) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ message: 'Contact not found' });
    }

    const fileInfo = {
      id: uuidv4(),
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    };

    contact.files.push(fileInfo);
    await contact.save();

    const io = req.app.get('io');
    io.emit('contact-updated', contactToPlainObject(contact));

    res.status(201).json(fileInfo);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete file from contact
router.delete('/:contactId/files/:fileId', authenticateToken, async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.contactId);

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const fileIndex = contact.files.findIndex(f => f.id === req.params.fileId);

    if (fileIndex === -1) {
      return res.status(404).json({ message: 'File not found' });
    }

    const file = contact.files[fileIndex];
    const filePath = path.join(UPLOADS_DIR, file.filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
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

// Download file
router.get('/:contactId/files/:fileId/download', authenticateToken, async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.contactId);

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const file = contact.files.find(f => f.id === req.params.fileId);

    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    const filePath = path.join(UPLOADS_DIR, file.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'File not found on server' });
    }

    res.download(filePath, file.originalName);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== TASKS ====================

// Add task to contact
router.post('/:contactId/tasks', authenticateToken, async (req, res) => {
  try {
    const { title, description, dueDate, priority } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Názov úlohy je povinný' });
    }

    const contact = await Contact.findById(req.params.contactId);

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const task = {
      id: uuidv4(),
      title: title.trim(),
      description: description || '',
      dueDate: dueDate || null,
      priority: priority || 'medium',
      completed: false,
      subtasks: []
    };

    console.log('Creating task with id:', task.id, 'title:', task.title);
    contact.tasks.push(task);
    contact.markModified('tasks');
    await contact.save();
    console.log('Task saved successfully');

    const io = req.app.get('io');
    io.emit('contact-updated', contactToPlainObject(contact));

    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update task
router.put('/:contactId/tasks/:taskId', authenticateToken, async (req, res) => {
  try {
    const { title, description, dueDate, priority, completed } = req.body;

    const contact = await Contact.findById(req.params.contactId);

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
      title: title !== undefined ? title : task.title,
      description: description !== undefined ? description : task.description,
      dueDate: dueDate !== undefined ? dueDate : task.dueDate,
      priority: priority !== undefined ? priority : task.priority,
      completed: completed !== undefined ? completed : task.completed
    };

    await contact.save();

    const io = req.app.get('io');
    io.emit('contact-updated', contactToPlainObject(contact));

    res.json(contact.tasks[taskIndex]);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete task
router.delete('/:contactId/tasks/:taskId', authenticateToken, async (req, res) => {
  try {
    console.log('Delete task request:', { contactId: req.params.contactId, taskId: req.params.taskId });

    const contact = await Contact.findById(req.params.contactId);

    if (!contact) {
      console.log('Contact not found:', req.params.contactId);
      return res.status(404).json({ message: 'Contact not found' });
    }

    console.log('Contact found:', contact.name, 'with', contact.tasks?.length || 0, 'tasks');
    console.log('Task IDs in contact:', contact.tasks?.map(t => t.id) || []);

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      console.log('Task not found with id:', req.params.taskId);
      return res.status(404).json({ message: 'Task not found' });
    }

    console.log('Found task at index:', taskIndex, 'title:', contact.tasks[taskIndex].title);
    contact.tasks.splice(taskIndex, 1);
    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.emit('contact-updated', contactToPlainObject(contact));

    res.json({ message: 'Task deleted' });
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Add subtask to task
router.post('/:contactId/tasks/:taskId/subtasks', authenticateToken, async (req, res) => {
  try {
    const { title, parentSubtaskId, dueDate, notes } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Nazov podulohy je povinny' });
    }

    const contact = await Contact.findById(req.params.contactId);

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      console.log('Add subtask - Task not found. Looking for:', req.params.taskId);
      console.log('Available tasks:', contact.tasks.map(t => ({ id: t.id, _id: t._id })));
      return res.status(404).json({ message: 'Task not found' });
    }

    const subtask = {
      id: uuidv4(),
      title: title.trim(),
      completed: false,
      dueDate: dueDate || null,
      notes: notes || '',
      subtasks: []
    };

    const task = contact.tasks[taskIndex];

    if (parentSubtaskId) {
      const found = findSubtaskRecursive(task.subtasks, parentSubtaskId);
      if (found) {
        if (!found.subtask.subtasks) {
          found.subtask.subtasks = [];
        }
        found.subtask.subtasks.push(subtask);
      } else {
        return res.status(404).json({ message: 'Parent subtask not found' });
      }
    } else {
      if (!task.subtasks) {
        task.subtasks = [];
      }
      task.subtasks.push(subtask);
    }

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
router.put('/:contactId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, async (req, res) => {
  try {
    const { title, completed, dueDate, notes } = req.body;

    const contact = await Contact.findById(req.params.contactId);

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
      title: title !== undefined ? title : found.subtask.title,
      completed: completed !== undefined ? completed : found.subtask.completed,
      dueDate: dueDate !== undefined ? dueDate : found.subtask.dueDate,
      notes: notes !== undefined ? notes : found.subtask.notes
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
router.delete('/:contactId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.contactId);

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

// Upload file to contact
router.post('/:id/files', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) {
      // Delete uploaded file if contact not found
      if (req.file) {
        fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename));
      }
      return res.status(404).json({ message: 'Contact not found' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const fileData = {
      id: uuidv4(),
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date()
    };

    contact.files.push(fileData);
    await contact.save();

    const io = req.app.get('io');
    io.emit('contact-updated', contactToPlainObject(contact));

    res.status(201).json(fileData);
  } catch (error) {
    // Clean up uploaded file on error
    if (req.file) {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename));
      } catch (e) {}
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Download file
router.get('/:id/files/:fileId/download', authenticateToken, async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const file = contact.files.find(f => f.id === req.params.fileId);
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    const filePath = path.join(UPLOADS_DIR, file.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'File not found on server' });
    }

    res.download(filePath, file.originalName);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete file from contact
router.delete('/:id/files/:fileId', authenticateToken, async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const fileIndex = contact.files.findIndex(f => f.id === req.params.fileId);
    if (fileIndex === -1) {
      return res.status(404).json({ message: 'File not found' });
    }

    const file = contact.files[fileIndex];

    // Delete file from filesystem
    const filePath = path.join(UPLOADS_DIR, file.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
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
