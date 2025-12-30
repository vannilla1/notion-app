const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const Task = require('../models/Task');
const Contact = require('../models/Contact');

const router = express.Router();

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
    console.log('=== GET TASKS ===');
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

    console.log('Global tasks count:', enrichedGlobalTasks.length);
    console.log('Contact tasks count:', contactTasks.length);
    console.log('Total tasks:', allTasks.length);

    res.json(allTasks);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Export tasks to iCal format - MUST be before /:id route
router.get('/export/calendar', authenticateToken, async (req, res) => {
  try {
    const contacts = await Contact.find({});
    const globalTasks = await Task.find({});
    const events = [];

    const formatICalDate = (dateString) => {
      const date = new Date(dateString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}${month}${day}`;
    };

    const createUID = (id) => `${id}@peruncrm`;

    const collectSubtasks = (subtasks, parentTitle, contactName) => {
      if (!subtasks) return;
      for (const subtask of subtasks) {
        if (subtask.dueDate && !subtask.completed) {
          events.push({
            uid: createUID(subtask.id),
            title: `${subtask.title} (${parentTitle})`,
            dueDate: subtask.dueDate,
            description: subtask.notes || '',
            contact: contactName
          });
        }
        if (subtask.subtasks && subtask.subtasks.length > 0) {
          collectSubtasks(subtask.subtasks, parentTitle, contactName);
        }
      }
    };

    // Collect from global tasks
    for (const task of globalTasks) {
      if (task.dueDate && !task.completed) {
        events.push({
          uid: createUID(task._id.toString()),
          title: task.title,
          dueDate: task.dueDate,
          description: task.description || '',
          contact: null
        });
      }
      collectSubtasks(task.subtasks, task.title, null);
    }

    // Collect from contact tasks
    for (const contact of contacts) {
      if (contact.tasks) {
        for (const task of contact.tasks) {
          if (task.dueDate && !task.completed) {
            events.push({
              uid: createUID(task.id),
              title: task.title,
              dueDate: task.dueDate,
              description: task.description || '',
              contact: contact.name
            });
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

    for (const event of events) {
      const dateStr = formatICalDate(event.dueDate);
      const nextDay = new Date(event.dueDate);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = formatICalDate(nextDay.toISOString());

      ical += 'BEGIN:VEVENT\r\n';
      ical += `UID:${event.uid}\r\n`;
      ical += `DTSTART;VALUE=DATE:${dateStr}\r\n`;
      ical += `DTEND;VALUE=DATE:${nextDayStr}\r\n`;
      ical += `SUMMARY:${event.title.replace(/[,;\\]/g, '\\$&')}\r\n`;
      if (event.description) {
        ical += `DESCRIPTION:${event.description.replace(/\n/g, '\\n').replace(/[,;\\]/g, '\\$&')}\r\n`;
      }
      if (event.contact) {
        ical += `LOCATION:Kontakt: ${event.contact.replace(/[,;\\]/g, '\\$&')}\r\n`;
      }
      ical += 'END:VEVENT\r\n';
    }

    ical += 'END:VCALENDAR\r\n';

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

// Create task - creates independent embedded tasks in each selected contact
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, description, dueDate, priority, contactId, contactIds } = req.body;
    const io = req.app.get('io');

    console.log('=== CREATE TASK ===');
    console.log('Request body:', req.body);
    console.log('contactIds:', contactIds);
    console.log('contactId:', contactId);

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
        subtasks: [],
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
        subtasks: [],
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
      console.log('Task embedded in contact:', contact.name, 'Task ID:', newTask.id);
    }

    console.log('Created tasks:', createdTasks.length);
    console.log('Tasks:', JSON.stringify(createdTasks, null, 2));

    // Emit updates for all affected contacts
    for (const contact of updatedContacts) {
      io.emit('contact-updated', contact.toJSON());
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
              title: title !== undefined ? title : task.title,
              description: description !== undefined ? description : task.description,
              dueDate: dueDate !== undefined ? dueDate : task.dueDate,
              priority: priority !== undefined ? priority : task.priority,
              completed: completed !== undefined ? completed : task.completed
            };
            contact.markModified('tasks');
            await contact.save();

            io.emit('contact-updated', contact.toJSON());
            io.emit('task-updated', {
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

      await task.save();

      const taskObj = task.toObject();
      taskObj.id = taskObj._id.toString();
      taskObj.contactIds = finalContactIds;
      taskObj.contactNames = contactNames;
      taskObj.contactName = contactNames.join(', ') || null;

      io.emit('task-updated', { ...taskObj, source: 'global' });
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

          io.emit('contact-updated', contact.toJSON());
          io.emit('task-updated', {
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

            io.emit('contact-updated', contact.toJSON());
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

          io.emit('contact-updated', contact.toJSON());
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
const duplicateSubtasksRecursive = (subtasks) => {
  if (!subtasks || !Array.isArray(subtasks)) return [];
  return subtasks.map(subtask => ({
    id: uuidv4(),
    title: subtask.title,
    completed: false,
    dueDate: subtask.dueDate || null,
    notes: subtask.notes || '',
    subtasks: duplicateSubtasksRecursive(subtask.subtasks),
    createdAt: new Date().toISOString()
  }));
};

// Duplicate task with new contact assignment - creates independent embedded tasks in each contact
router.post('/:id/duplicate', authenticateToken, async (req, res) => {
  try {
    const { contactIds, source } = req.body;
    const io = req.app.get('io');
    const mongoose = require('mongoose');

    console.log('Duplicate request for task ID:', req.params.id);
    console.log('Request body:', req.body);

    let originalTask = null;

    // Check if ID is valid MongoDB ObjectId
    const isValidObjectId = mongoose.Types.ObjectId.isValid(req.params.id);
    console.log('Is valid ObjectId:', isValidObjectId);

    // Find original task - check global tasks first (only if valid ObjectId)
    if (isValidObjectId) {
      const globalTask = await Task.findById(req.params.id);
      console.log('Global task found:', !!globalTask);
      if (globalTask) {
        originalTask = globalTask.toObject();
        originalTask.source = 'global';
      }
    }

    // If not found in global tasks, search in contacts
    if (!originalTask) {
      console.log('Searching in contacts...');
      const allContacts = await Contact.find({});
      console.log('Total contacts:', allContacts.length);
      for (const contact of allContacts) {
        if (contact.tasks && contact.tasks.length > 0) {
          console.log(`Contact ${contact.name} has ${contact.tasks.length} tasks`);
          const found = contact.tasks.find(t => {
            console.log(`  Comparing task.id "${t.id}" with "${req.params.id}"`);
            return t.id === req.params.id;
          });
          if (found) {
            console.log('Found task in contact:', contact.name);
            originalTask = typeof found.toObject === 'function' ? found.toObject() : { ...found };
            originalTask.source = 'contact';
            break;
          }
        }
      }
    }

    console.log('Original task found:', !!originalTask);

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
      io.emit('contact-updated', contact.toJSON());
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
    const { title, source, parentSubtaskId, dueDate, notes } = req.body;
    const io = req.app.get('io');

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Nazov podulohy je povinny' });
    }

    const subtask = {
      id: uuidv4(),
      title: title.trim(),
      completed: false,
      dueDate: dueDate || null,
      notes: notes || '',
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

              io.emit('contact-updated', contact.toJSON());
              const taskObj = typeof contact.tasks[taskIndex].toObject === 'function'
                ? contact.tasks[taskIndex].toObject()
                : { ...contact.tasks[taskIndex] };
              io.emit('task-updated', {
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
        io.emit('task-updated', { ...taskObj, source: 'global' });
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

            io.emit('contact-updated', contact.toJSON());
            io.emit('task-updated', {
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
    const { title, completed, source, dueDate, notes } = req.body;
    const io = req.app.get('io');

    // Helper to update subtask recursively
    const updateSubtaskInTask = (task) => {
      const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);
      if (found) {
        found.parent[found.index] = {
          ...found.subtask,
          title: title !== undefined ? title : found.subtask.title,
          completed: completed !== undefined ? completed : found.subtask.completed,
          dueDate: dueDate !== undefined ? dueDate : found.subtask.dueDate,
          notes: notes !== undefined ? notes : found.subtask.notes
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

              io.emit('contact-updated', contact.toJSON());
              io.emit('task-updated', {
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
        io.emit('task-updated', { ...taskObj, source: 'global' });
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

            io.emit('contact-updated', contact.toJSON());
            io.emit('task-updated', {
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

              io.emit('contact-updated', contact.toJSON());
              io.emit('task-updated', {
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
        io.emit('task-updated', { ...taskObj, source: 'global' });
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

            io.emit('contact-updated', contact.toJSON());
            io.emit('task-updated', {
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
