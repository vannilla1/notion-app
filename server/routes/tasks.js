const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Data file paths
const DATA_DIR = path.join(__dirname, '../data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(TASKS_FILE)) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify([], null, 2));
}

// Helper functions
const readTasks = () => {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return [];
  }
};

const writeTasks = (tasks) => {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
};

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

// Get all tasks (including tasks from contacts)
router.get('/', authenticateToken, (req, res) => {
  const globalTasks = readTasks();
  const contacts = readContacts();

  // Enrich global tasks with contact info
  const enrichedGlobalTasks = globalTasks.map(task => {
    if (task.contactId) {
      const contact = contacts.find(c => c.id === task.contactId);
      return {
        ...task,
        contactName: contact ? contact.name : null,
        source: 'global'
      };
    }
    return { ...task, source: 'global' };
  });

  // Extract tasks from contacts
  const contactTasks = [];
  contacts.forEach(contact => {
    if (contact.tasks && contact.tasks.length > 0) {
      contact.tasks.forEach(task => {
        contactTasks.push({
          ...task,
          contactId: contact.id,
          contactName: contact.name,
          source: 'contact'
        });
      });
    }
  });

  // Combine all tasks
  const allTasks = [...enrichedGlobalTasks, ...contactTasks];

  // Sort by createdAt descending (newest first)
  allTasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(allTasks);
});

// Get single task (from global tasks or contacts)
router.get('/:id', authenticateToken, (req, res) => {
  // First check global tasks
  const tasks = readTasks();
  let task = tasks.find(t => t.id === req.params.id);

  if (task) {
    return res.json({ ...task, source: 'global' });
  }

  // Check tasks in contacts
  const contacts = readContacts();
  for (const contact of contacts) {
    if (contact.tasks) {
      task = contact.tasks.find(t => t.id === req.params.id);
      if (task) {
        return res.json({
          ...task,
          contactId: contact.id,
          contactName: contact.name,
          source: 'contact'
        });
      }
    }
  }

  return res.status(404).json({ message: 'Task not found' });
});

// Create task
router.post('/', authenticateToken, (req, res) => {
  const { title, description, dueDate, priority, contactId } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ message: 'Názov úlohy je povinný' });
  }

  // Verify contact exists if contactId is provided
  if (contactId) {
    const contacts = readContacts();
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) {
      return res.status(400).json({ message: 'Kontakt neexistuje' });
    }
  }

  const task = {
    id: uuidv4(),
    title: title.trim(),
    description: description || '',
    dueDate: dueDate || null,
    priority: priority || 'medium',
    completed: false,
    contactId: contactId || null,
    subtasks: [],
    createdBy: req.user.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const tasks = readTasks();
  tasks.push(task);
  writeTasks(tasks);

  // Emit socket event
  const io = req.app.get('io');
  io.emit('task-created', task);

  res.status(201).json(task);
});

// Update task (global or from contact)
router.put('/:id', authenticateToken, (req, res) => {
  const { title, description, dueDate, priority, completed, contactId, source } = req.body;
  const io = req.app.get('io');

  // If source is 'contact', update in contacts
  if (source === 'contact') {
    const contacts = readContacts();
    for (let i = 0; i < contacts.length; i++) {
      if (contacts[i].tasks) {
        const taskIndex = contacts[i].tasks.findIndex(t => t.id === req.params.id);
        if (taskIndex !== -1) {
          const task = contacts[i].tasks[taskIndex];
          contacts[i].tasks[taskIndex] = {
            ...task,
            title: title !== undefined ? title : task.title,
            description: description !== undefined ? description : task.description,
            dueDate: dueDate !== undefined ? dueDate : task.dueDate,
            priority: priority !== undefined ? priority : task.priority,
            completed: completed !== undefined ? completed : task.completed
          };
          contacts[i].updatedAt = new Date().toISOString();
          writeContacts(contacts);

          io.emit('contact-updated', contacts[i]);
          io.emit('task-updated', {
            ...contacts[i].tasks[taskIndex],
            contactId: contacts[i].id,
            contactName: contacts[i].name,
            source: 'contact'
          });

          return res.json({
            ...contacts[i].tasks[taskIndex],
            contactId: contacts[i].id,
            contactName: contacts[i].name,
            source: 'contact'
          });
        }
      }
    }
    return res.status(404).json({ message: 'Task not found in contacts' });
  }

  // Update global task
  const tasks = readTasks();
  const index = tasks.findIndex(t => t.id === req.params.id);

  if (index === -1) {
    // Task not found in global tasks, try to find in contacts
    const contacts = readContacts();
    for (let i = 0; i < contacts.length; i++) {
      if (contacts[i].tasks) {
        const taskIndex = contacts[i].tasks.findIndex(t => t.id === req.params.id);
        if (taskIndex !== -1) {
          const task = contacts[i].tasks[taskIndex];
          contacts[i].tasks[taskIndex] = {
            ...task,
            title: title !== undefined ? title : task.title,
            description: description !== undefined ? description : task.description,
            dueDate: dueDate !== undefined ? dueDate : task.dueDate,
            priority: priority !== undefined ? priority : task.priority,
            completed: completed !== undefined ? completed : task.completed
          };
          contacts[i].updatedAt = new Date().toISOString();
          writeContacts(contacts);

          io.emit('contact-updated', contacts[i]);
          io.emit('task-updated', {
            ...contacts[i].tasks[taskIndex],
            contactId: contacts[i].id,
            contactName: contacts[i].name,
            source: 'contact'
          });

          return res.json({
            ...contacts[i].tasks[taskIndex],
            contactId: contacts[i].id,
            contactName: contacts[i].name,
            source: 'contact'
          });
        }
      }
    }
    return res.status(404).json({ message: 'Task not found' });
  }

  // Verify contact exists if contactId is provided
  if (contactId) {
    const contacts = readContacts();
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) {
      return res.status(400).json({ message: 'Kontakt neexistuje' });
    }
  }

  tasks[index] = {
    ...tasks[index],
    title: title !== undefined ? title : tasks[index].title,
    description: description !== undefined ? description : tasks[index].description,
    dueDate: dueDate !== undefined ? dueDate : tasks[index].dueDate,
    priority: priority !== undefined ? priority : tasks[index].priority,
    completed: completed !== undefined ? completed : tasks[index].completed,
    contactId: contactId !== undefined ? contactId : tasks[index].contactId,
    updatedAt: new Date().toISOString()
  };

  writeTasks(tasks);

  io.emit('task-updated', { ...tasks[index], source: 'global' });

  res.json({ ...tasks[index], source: 'global' });
});

// Delete task (global or from contact)
router.delete('/:id', authenticateToken, (req, res) => {
  const io = req.app.get('io');
  const source = req.query.source;

  // If source is 'contact', delete from contacts
  if (source === 'contact') {
    const contacts = readContacts();
    for (let i = 0; i < contacts.length; i++) {
      if (contacts[i].tasks) {
        const taskIndex = contacts[i].tasks.findIndex(t => t.id === req.params.id);
        if (taskIndex !== -1) {
          contacts[i].tasks.splice(taskIndex, 1);
          contacts[i].updatedAt = new Date().toISOString();
          writeContacts(contacts);

          io.emit('contact-updated', contacts[i]);
          io.emit('task-deleted', { id: req.params.id, source: 'contact' });

          return res.json({ message: 'Task deleted' });
        }
      }
    }
    return res.status(404).json({ message: 'Task not found in contacts' });
  }

  // Try to delete from global tasks first
  const tasks = readTasks();
  const index = tasks.findIndex(t => t.id === req.params.id);

  if (index !== -1) {
    tasks.splice(index, 1);
    writeTasks(tasks);
    io.emit('task-deleted', { id: req.params.id, source: 'global' });
    return res.json({ message: 'Task deleted' });
  }

  // If not found in global tasks, try contacts
  const contacts = readContacts();
  for (let i = 0; i < contacts.length; i++) {
    if (contacts[i].tasks) {
      const taskIndex = contacts[i].tasks.findIndex(t => t.id === req.params.id);
      if (taskIndex !== -1) {
        contacts[i].tasks.splice(taskIndex, 1);
        contacts[i].updatedAt = new Date().toISOString();
        writeContacts(contacts);

        io.emit('contact-updated', contacts[i]);
        io.emit('task-deleted', { id: req.params.id, source: 'contact' });

        return res.json({ message: 'Task deleted' });
      }
    }
  }

  return res.status(404).json({ message: 'Task not found' });
});

// ==================== SUBTASKS (RECURSIVE) ====================

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

// Helper function to find task in global tasks or contacts
const findTaskLocation = (taskId) => {
  // Check global tasks first
  const tasks = readTasks();
  const globalIndex = tasks.findIndex(t => t.id === taskId);
  if (globalIndex !== -1) {
    return { type: 'global', tasks, taskIndex: globalIndex };
  }

  // Check contacts
  const contacts = readContacts();
  for (let i = 0; i < contacts.length; i++) {
    if (contacts[i].tasks) {
      const taskIndex = contacts[i].tasks.findIndex(t => t.id === taskId);
      if (taskIndex !== -1) {
        return { type: 'contact', contacts, contactIndex: i, taskIndex };
      }
    }
  }

  return null;
};

// Helper to count all subtasks recursively
const countSubtasksRecursive = (subtasks) => {
  if (!subtasks || subtasks.length === 0) return { total: 0, completed: 0 };
  let total = 0;
  let completed = 0;
  for (const subtask of subtasks) {
    total++;
    if (subtask.completed) completed++;
    if (subtask.subtasks && subtask.subtasks.length > 0) {
      const childCounts = countSubtasksRecursive(subtask.subtasks);
      total += childCounts.total;
      completed += childCounts.completed;
    }
  }
  return { total, completed };
};

// Add subtask to task (global or from contact)
// Now supports parentSubtaskId for nested subtasks
router.post('/:taskId/subtasks', authenticateToken, (req, res) => {
  const { title, source, parentSubtaskId } = req.body;
  const io = req.app.get('io');

  if (!title || !title.trim()) {
    return res.status(400).json({ message: 'Nazov podulohy je povinny' });
  }

  const subtask = {
    id: uuidv4(),
    title: title.trim(),
    completed: false,
    subtasks: [],
    createdAt: new Date().toISOString()
  };

  // Helper to add subtask to parent (task or subtask)
  const addToParent = (task) => {
    if (parentSubtaskId) {
      // Add to a specific subtask (nested)
      const found = findSubtaskRecursive(task.subtasks, parentSubtaskId);
      if (found) {
        if (!found.subtask.subtasks) {
          found.subtask.subtasks = [];
        }
        found.subtask.subtasks.push(subtask);
        return true;
      }
      return false;
    } else {
      // Add to task's direct subtasks
      if (!task.subtasks) {
        task.subtasks = [];
      }
      task.subtasks.push(subtask);
      return true;
    }
  };

  // If source is specified as contact, look in contacts first
  if (source === 'contact') {
    const contacts = readContacts();
    for (let i = 0; i < contacts.length; i++) {
      if (contacts[i].tasks) {
        const taskIndex = contacts[i].tasks.findIndex(t => t.id === req.params.taskId);
        if (taskIndex !== -1) {
          if (addToParent(contacts[i].tasks[taskIndex])) {
            contacts[i].updatedAt = new Date().toISOString();
            writeContacts(contacts);

            io.emit('contact-updated', contacts[i]);
            io.emit('task-updated', {
              ...contacts[i].tasks[taskIndex],
              contactId: contacts[i].id,
              contactName: contacts[i].name,
              source: 'contact'
            });

            return res.status(201).json(subtask);
          }
        }
      }
    }
  }

  // Try global tasks
  const tasks = readTasks();
  const taskIndex = tasks.findIndex(t => t.id === req.params.taskId);

  if (taskIndex !== -1) {
    if (addToParent(tasks[taskIndex])) {
      tasks[taskIndex].updatedAt = new Date().toISOString();
      writeTasks(tasks);

      io.emit('task-updated', { ...tasks[taskIndex], source: 'global' });
      return res.status(201).json(subtask);
    }
    return res.status(404).json({ message: 'Parent subtask not found' });
  }

  // If not found in global, search in contacts
  const contacts = readContacts();
  for (let i = 0; i < contacts.length; i++) {
    if (contacts[i].tasks) {
      const ctIndex = contacts[i].tasks.findIndex(t => t.id === req.params.taskId);
      if (ctIndex !== -1) {
        if (addToParent(contacts[i].tasks[ctIndex])) {
          contacts[i].updatedAt = new Date().toISOString();
          writeContacts(contacts);

          io.emit('contact-updated', contacts[i]);
          io.emit('task-updated', {
            ...contacts[i].tasks[ctIndex],
            contactId: contacts[i].id,
            contactName: contacts[i].name,
            source: 'contact'
          });

          return res.status(201).json(subtask);
        }
        return res.status(404).json({ message: 'Parent subtask not found' });
      }
    }
  }

  return res.status(404).json({ message: 'Task not found' });
});

// Update subtask (global or from contact) - now with recursive search
router.put('/:taskId/subtasks/:subtaskId', authenticateToken, (req, res) => {
  const { title, completed, source } = req.body;
  const io = req.app.get('io');

  // Helper to update subtask recursively
  const updateSubtaskInTask = (task) => {
    const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);
    if (found) {
      found.parent[found.index] = {
        ...found.subtask,
        title: title !== undefined ? title : found.subtask.title,
        completed: completed !== undefined ? completed : found.subtask.completed
      };
      return found.parent[found.index];
    }
    return null;
  };

  // If source is contact, look in contacts
  if (source === 'contact') {
    const contacts = readContacts();
    for (let i = 0; i < contacts.length; i++) {
      if (contacts[i].tasks) {
        const taskIndex = contacts[i].tasks.findIndex(t => t.id === req.params.taskId);
        if (taskIndex !== -1) {
          const updated = updateSubtaskInTask(contacts[i].tasks[taskIndex]);
          if (updated) {
            contacts[i].updatedAt = new Date().toISOString();
            writeContacts(contacts);

            io.emit('contact-updated', contacts[i]);
            io.emit('task-updated', {
              ...contacts[i].tasks[taskIndex],
              contactId: contacts[i].id,
              contactName: contacts[i].name,
              source: 'contact'
            });

            return res.json(updated);
          }
        }
      }
    }
  }

  // Try global tasks
  const tasks = readTasks();
  const taskIndex = tasks.findIndex(t => t.id === req.params.taskId);

  if (taskIndex !== -1) {
    const updated = updateSubtaskInTask(tasks[taskIndex]);
    if (updated) {
      tasks[taskIndex].updatedAt = new Date().toISOString();
      writeTasks(tasks);

      io.emit('task-updated', { ...tasks[taskIndex], source: 'global' });
      return res.json(updated);
    }
  }

  // Search in contacts
  const contacts = readContacts();
  for (let i = 0; i < contacts.length; i++) {
    if (contacts[i].tasks) {
      const ctIndex = contacts[i].tasks.findIndex(t => t.id === req.params.taskId);
      if (ctIndex !== -1) {
        const updated = updateSubtaskInTask(contacts[i].tasks[ctIndex]);
        if (updated) {
          contacts[i].updatedAt = new Date().toISOString();
          writeContacts(contacts);

          io.emit('contact-updated', contacts[i]);
          io.emit('task-updated', {
            ...contacts[i].tasks[ctIndex],
            contactId: contacts[i].id,
            contactName: contacts[i].name,
            source: 'contact'
          });

          return res.json(updated);
        }
      }
    }
  }

  return res.status(404).json({ message: 'Task or subtask not found' });
});

// Delete subtask (global or from contact) - now with recursive search
router.delete('/:taskId/subtasks/:subtaskId', authenticateToken, (req, res) => {
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
    const contacts = readContacts();
    for (let i = 0; i < contacts.length; i++) {
      if (contacts[i].tasks) {
        const taskIndex = contacts[i].tasks.findIndex(t => t.id === req.params.taskId);
        if (taskIndex !== -1) {
          if (deleteSubtaskInTask(contacts[i].tasks[taskIndex])) {
            contacts[i].updatedAt = new Date().toISOString();
            writeContacts(contacts);

            io.emit('contact-updated', contacts[i]);
            io.emit('task-updated', {
              ...contacts[i].tasks[taskIndex],
              contactId: contacts[i].id,
              contactName: contacts[i].name,
              source: 'contact'
            });

            return res.json({ message: 'Subtask deleted' });
          }
        }
      }
    }
  }

  // Try global tasks
  const tasks = readTasks();
  const taskIndex = tasks.findIndex(t => t.id === req.params.taskId);

  if (taskIndex !== -1) {
    if (deleteSubtaskInTask(tasks[taskIndex])) {
      tasks[taskIndex].updatedAt = new Date().toISOString();
      writeTasks(tasks);

      io.emit('task-updated', { ...tasks[taskIndex], source: 'global' });
      return res.json({ message: 'Subtask deleted' });
    }
  }

  // Search in contacts
  const contacts = readContacts();
  for (let i = 0; i < contacts.length; i++) {
    if (contacts[i].tasks) {
      const ctIndex = contacts[i].tasks.findIndex(t => t.id === req.params.taskId);
      if (ctIndex !== -1) {
        if (deleteSubtaskInTask(contacts[i].tasks[ctIndex])) {
          contacts[i].updatedAt = new Date().toISOString();
          writeContacts(contacts);

          io.emit('contact-updated', contacts[i]);
          io.emit('task-updated', {
            ...contacts[i].tasks[ctIndex],
            contactId: contacts[i].id,
            contactName: contacts[i].name,
            source: 'contact'
          });

          return res.json({ message: 'Subtask deleted' });
        }
      }
    }
  }

  return res.status(404).json({ message: 'Task or subtask not found' });
});

module.exports = router;
