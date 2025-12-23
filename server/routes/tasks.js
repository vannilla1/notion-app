const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const Task = require('../models/Task');
const Contact = require('../models/Contact');

const router = express.Router();

// Helper to emit to specific user only
const emitToUser = (io, userId, event, data) => {
  io.to(`user-${userId}`).emit(event, data);
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

// Get all tasks (including tasks from contacts) for current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const globalTasks = await Task.find({ userId: req.user.id });
    const contacts = await Contact.find({ userId: req.user.id });

    // Enrich global tasks with contact info
    const enrichedGlobalTasks = globalTasks.map(task => {
      const taskObj = task.toObject();
      taskObj.id = taskObj._id.toString();
      if (taskObj.contactId) {
        const contact = contacts.find(c => c._id.toString() === taskObj.contactId.toString());
        return {
          ...taskObj,
          contactName: contact ? contact.name : null,
          source: 'global'
        };
      }
      return { ...taskObj, source: 'global' };
    });

    // Extract tasks from contacts
    const contactTasks = [];
    contacts.forEach(contact => {
      if (contact.tasks && contact.tasks.length > 0) {
        contact.tasks.forEach(task => {
          const taskObj = typeof task.toObject === 'function' ? task.toObject() : { ...task };
          contactTasks.push({
            ...taskObj,
            id: task.id,
            contactId: contact._id.toString(),
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
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get single task (from global tasks or contacts)
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    // First check global tasks
    const task = await Task.findById(req.params.id);
    if (task) {
      const taskObj = task.toObject();
      taskObj.id = taskObj._id.toString();
      return res.json({ ...taskObj, source: 'global' });
    }

    // Check tasks in contacts
    const contacts = await Contact.find({});
    for (const contact of contacts) {
      if (contact.tasks) {
        const foundTask = contact.tasks.find(t => t.id === req.params.id);
        if (foundTask) {
          return res.json({
            ...foundTask,
            contactId: contact._id.toString(),
            contactName: contact.name,
            source: 'contact'
          });
        }
      }
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create task
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, description, dueDate, priority, contactId } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Názov úlohy je povinný' });
    }

    // Verify contact exists if contactId is provided
    let contactName = null;
    if (contactId) {
      const contact = await Contact.findById(contactId);
      if (!contact) {
        return res.status(400).json({ message: 'Kontakt neexistuje' });
      }
      contactName = contact.name;
    }

    const task = new Task({
      userId: req.user.id,
      title: title.trim(),
      description: description || '',
      dueDate: dueDate || null,
      priority: priority || 'medium',
      completed: false,
      contactId: contactId || null,
      subtasks: [],
      createdBy: req.user.username
    });

    await task.save();

    const taskObj = task.toObject();
    taskObj.id = taskObj._id.toString();
    taskObj.contactName = contactName;
    taskObj.source = 'global';

    // Emit socket event
    const io = req.app.get('io');
    emitToUser(io, req.user.id, 'task-created', taskObj);

    res.status(201).json(taskObj);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update task (global or from contact)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { title, description, dueDate, priority, completed, contactId, source } = req.body;
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
              title: title !== undefined ? title : task.title,
              description: description !== undefined ? description : task.description,
              dueDate: dueDate !== undefined ? dueDate : task.dueDate,
              priority: priority !== undefined ? priority : task.priority,
              completed: completed !== undefined ? completed : task.completed
            };
            contact.markModified('tasks');
            await contact.save();

            emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
            emitToUser(io, req.user.id, 'task-updated', {
              ...contact.tasks[taskIndex],
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            });

            return res.json({
              ...contact.tasks[taskIndex],
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            });
          }
        }
      }
      return res.status(404).json({ message: 'Task not found in contacts' });
    }

    // Try to update global task
    let task = await Task.findById(req.params.id);

    if (task) {
      // Verify contact exists if contactId is provided
      if (contactId) {
        const contact = await Contact.findById(contactId);
        if (!contact) {
          return res.status(400).json({ message: 'Kontakt neexistuje' });
        }
      }

      task.title = title !== undefined ? title : task.title;
      task.description = description !== undefined ? description : task.description;
      task.dueDate = dueDate !== undefined ? dueDate : task.dueDate;
      task.priority = priority !== undefined ? priority : task.priority;
      task.completed = completed !== undefined ? completed : task.completed;
      task.contactId = contactId !== undefined ? contactId : task.contactId;

      await task.save();

      const taskObj = task.toObject();
      taskObj.id = taskObj._id.toString();

      emitToUser(io, req.user.id, 'task-updated', { ...taskObj, source: 'global' });
      return res.json({ ...taskObj, source: 'global' });
    }

    // Task not found in global tasks, try to find in contacts
    const contacts = await Contact.find({});
    for (const contact of contacts) {
      if (contact.tasks) {
        const taskIndex = contact.tasks.findIndex(t => t.id === req.params.id);
        if (taskIndex !== -1) {
          const ctask = contact.tasks[taskIndex];
          contact.tasks[taskIndex] = {
            ...ctask,
            title: title !== undefined ? title : ctask.title,
            description: description !== undefined ? description : ctask.description,
            dueDate: dueDate !== undefined ? dueDate : ctask.dueDate,
            priority: priority !== undefined ? priority : ctask.priority,
            completed: completed !== undefined ? completed : ctask.completed
          };
          contact.markModified('tasks');
          await contact.save();

          emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
          emitToUser(io, req.user.id, 'task-updated', {
            ...contact.tasks[taskIndex],
            contactId: contact._id.toString(),
            contactName: contact.name,
            source: 'contact'
          });

          return res.json({
            ...contact.tasks[taskIndex],
            contactId: contact._id.toString(),
            contactName: contact.name,
            source: 'contact'
          });
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

            emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
            emitToUser(io, req.user.id, 'task-deleted', { id: req.params.id, source: 'contact' });

            return res.json({ message: 'Task deleted' });
          }
        }
      }
      return res.status(404).json({ message: 'Task not found in contacts' });
    }

    // Try to delete from global tasks first
    const task = await Task.findByIdAndDelete(req.params.id);
    if (task) {
      emitToUser(io, req.user.id, 'task-deleted', { id: req.params.id, source: 'global' });
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

          emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
          emitToUser(io, req.user.id, 'task-deleted', { id: req.params.id, source: 'contact' });

          return res.json({ message: 'Task deleted' });
        }
      }
    }

    return res.status(404).json({ message: 'Task not found' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== SUBTASKS (RECURSIVE) ====================

// Add subtask to task (global or from contact)
router.post('/:taskId/subtasks', authenticateToken, async (req, res) => {
  try {
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
        if (!task.subtasks) {
          task.subtasks = [];
        }
        task.subtasks.push(subtask);
        return true;
      }
    };

    // If source is specified as contact, look in contacts first
    if (source === 'contact') {
      const contacts = await Contact.find({});
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
          if (taskIndex !== -1) {
            if (addToParent(contact.tasks[taskIndex])) {
              contact.markModified('tasks');
              await contact.save();

              emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
              const taskObj = typeof contact.tasks[taskIndex].toObject === 'function'
                ? contact.tasks[taskIndex].toObject()
                : { ...contact.tasks[taskIndex] };
              emitToUser(io, req.user.id, 'task-updated', {
                ...taskObj,
                contactId: contact._id.toString(),
                contactName: contact.name,
                source: 'contact'
              });

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
        task.markModified('subtasks');
        await task.save();

        const taskObj = task.toObject();
        taskObj.id = taskObj._id.toString();
        emitToUser(io, req.user.id, 'task-updated', { ...taskObj, source: 'global' });
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
            contact.markModified('tasks');
            await contact.save();

            emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
            emitToUser(io, req.user.id, 'task-updated', {
              ...contact.tasks[taskIndex],
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            });

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
      const contacts = await Contact.find({});
      for (const contact of contacts) {
        if (contact.tasks) {
          const taskIndex = contact.tasks.findIndex(t => t.id === req.params.taskId);
          if (taskIndex !== -1) {
            const updated = updateSubtaskInTask(contact.tasks[taskIndex]);
            if (updated) {
              contact.markModified('tasks');
              await contact.save();

              emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
              emitToUser(io, req.user.id, 'task-updated', {
                ...contact.tasks[taskIndex],
                contactId: contact._id.toString(),
                contactName: contact.name,
                source: 'contact'
              });

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

        const taskObj = task.toObject();
        taskObj.id = taskObj._id.toString();
        emitToUser(io, req.user.id, 'task-updated', { ...taskObj, source: 'global' });
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

            emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
            emitToUser(io, req.user.id, 'task-updated', {
              ...contact.tasks[taskIndex],
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            });

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

              emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
              emitToUser(io, req.user.id, 'task-updated', {
                ...contact.tasks[taskIndex],
                contactId: contact._id.toString(),
                contactName: contact.name,
                source: 'contact'
              });

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

        const taskObj = task.toObject();
        taskObj.id = taskObj._id.toString();
        emitToUser(io, req.user.id, 'task-updated', { ...taskObj, source: 'global' });
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

            emitToUser(io, req.user.id, 'contact-updated', contact.toJSON());
            emitToUser(io, req.user.id, 'task-updated', {
              ...contact.tasks[taskIndex],
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            });

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
