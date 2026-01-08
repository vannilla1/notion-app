const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const Task = require('../models/Task');
const Contact = require('../models/Contact');
const User = require('../models/User');

const router = express.Router();

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

    // Enrich global tasks (these should have no contacts)
    const enrichedGlobalTasks = globalTasks.map(task => {
      const taskObj = task.toObject();
      taskObj.id = taskObj._id.toString();
      return { ...taskObj, contactIds: [], contactNames: [], contactName: null, source: 'global' };
    });

    // Extract tasks from contacts
    const contactTasks = [];
    contacts.forEach(contact => {
      if (contact.tasks && contact.tasks.length > 0) {
        contact.tasks.forEach(task => {
          // Deep copy to ensure nested subtasks are properly included
          const taskObj = JSON.parse(JSON.stringify(task));
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
      const nextDay = new Date(event.dueDate);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = formatICalDate(nextDay.toISOString());

      ical += 'BEGIN:VEVENT\r\n';
      ical += `UID:${event.uid}\r\n`;
      ical += `DTSTAMP:${dtstamp}\r\n`;
      ical += `DTSTART;VALUE=DATE:${dateStr}\r\n`;
      ical += `DTEND;VALUE=DATE:${nextDayStr}\r\n`;
      ical += `SUMMARY:${event.title.replace(/[,;\\]/g, '\\$&')}\r\n`;
      if (event.description) {
        ical += `DESCRIPTION:${event.description.replace(/\n/g, '\\n').replace(/[,;\\]/g, '\\$&')}\r\n`;
      }
      if (event.contact) {
        ical += `LOCATION:Kontakt: ${event.contact.replace(/[,;\\]/g, '\\$&')}\r\n`;
      }
      ical += `CREATED:${dtstamp}\r\n`;
      ical += `LAST-MODIFIED:${dtstamp}\r\n`;
      ical += 'TRANSP:TRANSPARENT\r\n';
      ical += 'END:VEVENT\r\n';
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
    return {
      id: uuidv4(),
      title: subtask.title || '',
      completed: subtask.completed || false,
      dueDate: subtask.dueDate || null,
      notes: subtask.notes || '',
      priority: subtask.priority || null, // Preserve priority
      subtasks: cloneSubtasksWithNewIds(subtask.subtasks),
      createdAt: new Date().toISOString()
    };
  }).filter(Boolean); // Remove null entries from invalid subtasks
};

// Create task - creates independent embedded tasks in each selected contact
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, description, dueDate, priority, contactId, contactIds, subtasks } = req.body;
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
        subtasks: cloneSubtasksWithNewIds(subtasks),
        createdBy: req.user.username
      });

      await task.save();

      const taskObj = task.toObject();
      taskObj.id = taskObj._id.toString();
      taskObj.contactIds = [];
      taskObj.contactNames = [];
      taskObj.contactName = null;
      taskObj.source = 'global';

      io.emit('task-created', taskObj);

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
        subtasks: cloneSubtasksWithNewIds(subtasks),
        createdAt: new Date().toISOString()
      };

      // Ensure tasks array exists
      if (!contact.tasks) {
        contact.tasks = [];
      }
      contact.tasks.push(newTask);
      contact.markModified('tasks');
      await contact.save();

      createdTasks.push({ ...newTask, contactId: contact._id.toString(), contactName: contact.name, source: 'contact' });
      updatedContacts.push(contact);
    }

    // Emit updates for all affected contacts
    for (const contact of updatedContacts) {
      io.emit('contact-updated', contactToPlainObject(contact));
    }

    // Emit task-created for each new task so Tasks view updates in real-time
    for (const task of createdTasks) {
      io.emit('task-created', task);
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

// Update task (global or from contact)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { title, description, dueDate, priority, completed, contactId, contactIds, source } = req.body;
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
              subtasks: req.body.subtasks !== undefined ? req.body.subtasks : task.subtasks,
              createdAt: task.createdAt
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

      task.title = title !== undefined ? title : task.title;
      task.description = description !== undefined ? description : task.description;
      task.dueDate = dueDate !== undefined ? dueDate : task.dueDate;
      task.priority = priority !== undefined ? priority : task.priority;
      task.completed = completed !== undefined ? completed : task.completed;
      task.contactIds = finalContactIds;
      // Preserve subtasks if not explicitly provided
      if (req.body.subtasks !== undefined) {
        task.subtasks = req.body.subtasks;
      }

      await task.save();

      const taskData = taskToPlainObject(task, {
        source: 'global',
        id: task._id.toString(),
        contactIds: finalContactIds,
        contactNames: contactNames,
        contactName: contactNames.join(', ') || null
      });

      io.emit('task-updated', taskData);
      return res.json(taskData);
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
    return {
      id: uuidv4(),
      title: subtask.title || '',
      completed: false,
      dueDate: subtask.dueDate || null,
      notes: subtask.notes || '',
      priority: subtask.priority || null, // Preserve priority
      subtasks: duplicateSubtasksRecursive(subtask.subtasks),
      createdAt: new Date().toISOString()
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
        createdBy: req.user.username
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
      const newTask = {
        id: uuidv4(),
        title: originalTask.title + ' (kópia)',
        description: originalTask.description || '',
        completed: false,
        priority: originalTask.priority || 'medium',
        dueDate: originalTask.dueDate || null,
        subtasks: duplicateSubtasksRecursive(originalTask.subtasks),
        createdAt: new Date().toISOString()
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
    const { title, source, parentSubtaskId, dueDate, notes, priority } = req.body;
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
      createdAt: now,
      updatedAt: now
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

              io.emit('contact-updated', contactToPlainObject(contact));
              io.emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
                contactId: contact._id.toString(),
                contactName: contact.name,
                source: 'contact'
              }));

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

        io.emit('task-updated', taskToPlainObject(task, { source: 'global', id: task._id.toString() }));
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

            io.emit('contact-updated', contactToPlainObject(contact));
            io.emit('task-updated', taskToPlainObject(contact.tasks[taskIndex], {
              contactId: contact._id.toString(),
              contactName: contact.name,
              source: 'contact'
            }));

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
    const { title, completed, source, dueDate, notes } = req.body;
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
          subtasks: found.subtask.subtasks || [], // Preserve nested subtasks
          createdAt: found.subtask.createdAt, // Preserve createdAt
          updatedAt: new Date().toISOString() // Update timestamp
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
