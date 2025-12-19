const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Data file paths
const DATA_DIR = path.join(__dirname, '../data');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const UPLOADS_DIR = path.join(__dirname, '../uploads');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(CONTACTS_FILE)) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify([], null, 2));
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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
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

// Helper functions
const readContacts = () => {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  } catch {
    return [];
  }
};

const writeContacts = (contacts) => {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
};

// Get all contacts (shared between all users)
router.get('/', authenticateToken, (req, res) => {
  const contacts = readContacts();
  res.json(contacts);
});

// Get single contact
router.get('/:id', authenticateToken, (req, res) => {
  const contacts = readContacts();
  const contact = contacts.find(c => c.id === req.params.id);
  if (!contact) {
    return res.status(404).json({ message: 'Contact not found' });
  }
  res.json(contact);
});

// Validation helpers
const isValidEmail = (email) => {
  if (!email) return true; // Empty is allowed
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const isValidPhone = (phone) => {
  if (!phone) return true; // Empty is allowed
  const phoneRegex = /^[+]?[0-9\s-]+$/;
  return phoneRegex.test(phone);
};

// Create contact
router.post('/', authenticateToken, (req, res) => {
  const { name, email, phone, company, website, notes, status } = req.body;

  // Validate email
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ message: 'Neplatný formát emailu' });
  }

  // Validate phone
  if (phone && !isValidPhone(phone)) {
    return res.status(400).json({ message: 'Telefón môže obsahovať len čísla, medzery, pomlčky a znak +' });
  }

  const contact = {
    id: uuidv4(),
    name: name || '',
    email: email || '',
    phone: phone || '',
    company: company || '',
    website: website || '',
    notes: notes || '',
    status: status || 'new',
    files: [],
    tasks: [],
    createdBy: req.user.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const contacts = readContacts();
  contacts.push(contact);
  writeContacts(contacts);

  // Emit socket event
  const io = req.app.get('io');
  io.emit('contact-created', contact);

  res.status(201).json(contact);
});

// Update contact
router.put('/:id', authenticateToken, (req, res) => {
  const contacts = readContacts();
  const index = contacts.findIndex(c => c.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  const { name, email, phone, company, website, notes, status } = req.body;

  // Validate email
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ message: 'Neplatný formát emailu' });
  }

  // Validate phone
  if (phone && !isValidPhone(phone)) {
    return res.status(400).json({ message: 'Telefón môže obsahovať len čísla, medzery, pomlčky a znak +' });
  }

  contacts[index] = {
    ...contacts[index],
    name: name !== undefined ? name : contacts[index].name,
    email: email !== undefined ? email : contacts[index].email,
    phone: phone !== undefined ? phone : contacts[index].phone,
    company: company !== undefined ? company : contacts[index].company,
    website: website !== undefined ? website : contacts[index].website,
    notes: notes !== undefined ? notes : contacts[index].notes,
    status: status !== undefined ? status : contacts[index].status,
    updatedAt: new Date().toISOString()
  };

  writeContacts(contacts);

  // Emit socket event
  const io = req.app.get('io');
  io.emit('contact-updated', contacts[index]);

  res.json(contacts[index]);
});

// Delete contact
router.delete('/:id', authenticateToken, (req, res) => {
  const contacts = readContacts();
  const index = contacts.findIndex(c => c.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  // Delete associated files
  const contact = contacts[index];
  if (contact.files) {
    contact.files.forEach(file => {
      const filePath = path.join(UPLOADS_DIR, file.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  }

  contacts.splice(index, 1);
  writeContacts(contacts);

  // Emit socket event
  const io = req.app.get('io');
  io.emit('contact-deleted', { id: req.params.id });

  res.json({ message: 'Contact deleted' });
});

// Upload file to contact
router.post('/:id/files', authenticateToken, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const contacts = readContacts();
  const index = contacts.findIndex(c => c.id === req.params.id);

  if (index === -1) {
    // Delete uploaded file if contact not found
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ message: 'Contact not found' });
  }

  const fileInfo = {
    id: uuidv4(),
    filename: req.file.filename,
    originalName: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    uploadedBy: req.user.username,
    uploadedAt: new Date().toISOString()
  };

  if (!contacts[index].files) {
    contacts[index].files = [];
  }
  contacts[index].files.push(fileInfo);
  contacts[index].updatedAt = new Date().toISOString();

  writeContacts(contacts);

  // Emit socket event
  const io = req.app.get('io');
  io.emit('contact-updated', contacts[index]);

  res.status(201).json(fileInfo);
});

// Delete file from contact
router.delete('/:contactId/files/:fileId', authenticateToken, (req, res) => {
  const contacts = readContacts();
  const contactIndex = contacts.findIndex(c => c.id === req.params.contactId);

  if (contactIndex === -1) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  const fileIndex = contacts[contactIndex].files.findIndex(f => f.id === req.params.fileId);

  if (fileIndex === -1) {
    return res.status(404).json({ message: 'File not found' });
  }

  const file = contacts[contactIndex].files[fileIndex];
  const filePath = path.join(UPLOADS_DIR, file.filename);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  contacts[contactIndex].files.splice(fileIndex, 1);
  contacts[contactIndex].updatedAt = new Date().toISOString();

  writeContacts(contacts);

  // Emit socket event
  const io = req.app.get('io');
  io.emit('contact-updated', contacts[contactIndex]);

  res.json({ message: 'File deleted' });
});

// Download file
router.get('/:contactId/files/:fileId/download', authenticateToken, (req, res) => {
  const contacts = readContacts();
  const contact = contacts.find(c => c.id === req.params.contactId);

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
});

// ==================== TASKS ====================

// Add task to contact
router.post('/:contactId/tasks', authenticateToken, (req, res) => {
  const { title, description, dueDate, priority } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ message: 'Názov úlohy je povinný' });
  }

  const contacts = readContacts();
  const index = contacts.findIndex(c => c.id === req.params.contactId);

  if (index === -1) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  const task = {
    id: uuidv4(),
    title: title.trim(),
    description: description || '',
    dueDate: dueDate || null,
    priority: priority || 'medium',
    completed: false,
    subtasks: [],
    createdBy: req.user.username,
    createdAt: new Date().toISOString()
  };

  if (!contacts[index].tasks) {
    contacts[index].tasks = [];
  }
  contacts[index].tasks.push(task);
  contacts[index].updatedAt = new Date().toISOString();

  writeContacts(contacts);

  const io = req.app.get('io');
  io.emit('contact-updated', contacts[index]);

  res.status(201).json(task);
});

// Update task
router.put('/:contactId/tasks/:taskId', authenticateToken, (req, res) => {
  const { title, description, dueDate, priority, completed } = req.body;

  const contacts = readContacts();
  const contactIndex = contacts.findIndex(c => c.id === req.params.contactId);

  if (contactIndex === -1) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  const taskIndex = contacts[contactIndex].tasks?.findIndex(t => t.id === req.params.taskId);

  if (taskIndex === -1 || taskIndex === undefined) {
    return res.status(404).json({ message: 'Task not found' });
  }

  const task = contacts[contactIndex].tasks[taskIndex];
  contacts[contactIndex].tasks[taskIndex] = {
    ...task,
    title: title !== undefined ? title : task.title,
    description: description !== undefined ? description : task.description,
    dueDate: dueDate !== undefined ? dueDate : task.dueDate,
    priority: priority !== undefined ? priority : task.priority,
    completed: completed !== undefined ? completed : task.completed
  };
  contacts[contactIndex].updatedAt = new Date().toISOString();

  writeContacts(contacts);

  const io = req.app.get('io');
  io.emit('contact-updated', contacts[contactIndex]);

  res.json(contacts[contactIndex].tasks[taskIndex]);
});

// Delete task
router.delete('/:contactId/tasks/:taskId', authenticateToken, (req, res) => {
  const contacts = readContacts();
  const contactIndex = contacts.findIndex(c => c.id === req.params.contactId);

  if (contactIndex === -1) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  const taskIndex = contacts[contactIndex].tasks?.findIndex(t => t.id === req.params.taskId);

  if (taskIndex === -1 || taskIndex === undefined) {
    return res.status(404).json({ message: 'Task not found' });
  }

  contacts[contactIndex].tasks.splice(taskIndex, 1);
  contacts[contactIndex].updatedAt = new Date().toISOString();

  writeContacts(contacts);

  const io = req.app.get('io');
  io.emit('contact-updated', contacts[contactIndex]);

  res.json({ message: 'Task deleted' });
});

// Helper function to find a subtask recursively in a subtasks array
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

// Add subtask to task (supports nested subtasks with parentSubtaskId)
router.post('/:contactId/tasks/:taskId/subtasks', authenticateToken, (req, res) => {
  const { title, parentSubtaskId } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ message: 'Nazov podulohy je povinny' });
  }

  const contacts = readContacts();
  const contactIndex = contacts.findIndex(c => c.id === req.params.contactId);

  if (contactIndex === -1) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  const taskIndex = contacts[contactIndex].tasks?.findIndex(t => t.id === req.params.taskId);

  if (taskIndex === -1 || taskIndex === undefined) {
    return res.status(404).json({ message: 'Task not found' });
  }

  const subtask = {
    id: uuidv4(),
    title: title.trim(),
    completed: false,
    subtasks: [],
    createdAt: new Date().toISOString()
  };

  const task = contacts[contactIndex].tasks[taskIndex];

  if (parentSubtaskId) {
    // Add to a specific subtask (nested)
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
    // Add to task's direct subtasks
    if (!task.subtasks) {
      task.subtasks = [];
    }
    task.subtasks.push(subtask);
  }

  contacts[contactIndex].updatedAt = new Date().toISOString();
  writeContacts(contacts);

  const io = req.app.get('io');
  io.emit('contact-updated', contacts[contactIndex]);

  res.status(201).json(subtask);
});

// Update subtask (recursive)
router.put('/:contactId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, (req, res) => {
  const { title, completed } = req.body;

  const contacts = readContacts();
  const contactIndex = contacts.findIndex(c => c.id === req.params.contactId);

  if (contactIndex === -1) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  const taskIndex = contacts[contactIndex].tasks?.findIndex(t => t.id === req.params.taskId);

  if (taskIndex === -1 || taskIndex === undefined) {
    return res.status(404).json({ message: 'Task not found' });
  }

  const task = contacts[contactIndex].tasks[taskIndex];
  const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);

  if (!found) {
    return res.status(404).json({ message: 'Subtask not found' });
  }

  found.parent[found.index] = {
    ...found.subtask,
    title: title !== undefined ? title : found.subtask.title,
    completed: completed !== undefined ? completed : found.subtask.completed
  };
  contacts[contactIndex].updatedAt = new Date().toISOString();

  writeContacts(contacts);

  const io = req.app.get('io');
  io.emit('contact-updated', contacts[contactIndex]);

  res.json(found.parent[found.index]);
});

// Delete subtask (recursive)
router.delete('/:contactId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, (req, res) => {
  const contacts = readContacts();
  const contactIndex = contacts.findIndex(c => c.id === req.params.contactId);

  if (contactIndex === -1) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  const taskIndex = contacts[contactIndex].tasks?.findIndex(t => t.id === req.params.taskId);

  if (taskIndex === -1 || taskIndex === undefined) {
    return res.status(404).json({ message: 'Task not found' });
  }

  const task = contacts[contactIndex].tasks[taskIndex];
  const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);

  if (!found) {
    return res.status(404).json({ message: 'Subtask not found' });
  }

  found.parent.splice(found.index, 1);
  contacts[contactIndex].updatedAt = new Date().toISOString();

  writeContacts(contacts);

  const io = req.app.get('io');
  io.emit('contact-updated', contacts[contactIndex]);

  res.json({ message: 'Subtask deleted' });
});

module.exports = router;
