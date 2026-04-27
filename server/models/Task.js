const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const fileSchema = new mongoose.Schema({
  id: String,
  originalName: String,
  mimetype: String,
  size: Number,
  data: String, // Base64 encoded file data
  uploadedAt: { type: Date, default: Date.now }
}, { _id: false });

const subtaskSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  title: String,
  completed: { type: Boolean, default: false },
  dueDate: String,
  // Optional time-of-day for the dueDate, format "HH:MM" (24h). Empty/null =
  // all-day. Google Calendar: dueTime present → timed event (start.dateTime +
  // 1h duration). Google Tasks API ignores time, takže sa len odzrkadlí do
  // task.notes pre user-side readability.
  dueTime: { type: String, default: '' },
  notes: { type: String, default: '' },
  priority: { type: String, default: null },
  subtasks: { type: Array, default: [] },
  assignedTo: { type: [String], default: [] }, // Array of User IDs
  files: { type: [fileSchema], default: [] },
  createdAt: { type: String, default: () => new Date().toISOString() },
  modifiedAt: { type: String, default: null },
  lastUrgencyLevel: { type: String, default: null }, // For due date urgency tracking
  reminder: { type: Number, default: null }, // legacy: days-before reminder. Deprecated v prospech timeReminders.
  reminderSent: { type: Boolean, default: false }, // legacy
  // ─── Time-of-day reminders (vyžadujú nastavený `dueTime`) ──────────────
  // Pole minút PRED `dueDateTime` v ktorých sa má spustiť push pripomienka.
  // Príklad: [60, 15] = pošli push 60 min pred a 15 min pred presným časom.
  // User si môže vybrať jednu alebo viacero hodnôt z {15, 30, 60, 120, 1440}.
  // Posielajú sa ako 'direct' notifikácie (vždy push) — user ich explicitne
  // nastavil takže o nich CHCE vedieť.
  timeReminders: { type: [Number], default: [] },
  // Pole minút ktoré už boli odoslané v tomto cykle. Po zmene dueDate/dueTime
  // sa toto pole zresetuje (cron checkne, že dueDateTime už neukazuje na ten
  // istý moment). Pre teraz ho server-side resetuje pri save() ak sa dueDate
  // alebo dueTime zmenil.
  timeRemindersSent: { type: [Number], default: [] },
  order: { type: Number, default: 0 }
}, { _id: false });

const taskSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  contactIds: {
    type: [String],
    default: []
  },
  assignedTo: {
    type: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    default: []
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  completed: {
    type: Boolean,
    default: false
  },
  priority: {
    type: String,
    default: 'medium'
  },
  dueDate: String,
  // Voliteľný čas "HH:MM" — viď komentár v subtaskSchema.
  dueTime: { type: String, default: '' },
  subtasks: { type: [subtaskSchema], default: [] },
  files: { type: [fileSchema], default: [] },
  createdBy: String,
  modifiedAt: { type: String, default: null },
  lastUrgencyLevel: { type: String, default: null }, // For due date urgency tracking
  reminder: { type: Number, default: null }, // legacy
  reminderSent: { type: Boolean, default: false }, // legacy
  // Viď komentár pri subtaskSchema. Funguje rovnako pre projekt aj úlohu.
  timeReminders: { type: [Number], default: [] },
  timeRemindersSent: { type: [Number], default: [] },
  order: { type: Number, default: 0 }
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      ret.id = ret._id.toString();
      return ret;
    }
  },
  toObject: {
    virtuals: true,
    transform: function(doc, ret) {
      ret.id = ret._id.toString();
      return ret;
    }
  }
});

// Database indexes for better query performance
taskSchema.index({ workspaceId: 1, userId: 1 });
taskSchema.index({ workspaceId: 1, completed: 1 });
taskSchema.index({ workspaceId: 1, dueDate: 1 });
taskSchema.index({ workspaceId: 1, priority: 1 });
taskSchema.index({ workspaceId: 1, contactIds: 1 });

// Pre-save middleware to ensure all subtasks have IDs
taskSchema.pre('save', function() {
  const generateIdsRecursive = (subtasks) => {
    if (!subtasks || !Array.isArray(subtasks)) return;
    for (let i = 0; i < subtasks.length; i++) {
      if (!subtasks[i].id) {
        subtasks[i].id = uuidv4();
      }
      if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
        generateIdsRecursive(subtasks[i].subtasks);
      }
    }
  };

  generateIdsRecursive(this.subtasks);
});

module.exports = mongoose.model('Task', taskSchema);
