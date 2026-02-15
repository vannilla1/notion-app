const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// BUGFIX: Added priority field to subtask schema for consistency
const subtaskSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  title: String,
  completed: { type: Boolean, default: false },
  dueDate: String,
  notes: { type: String, default: '' },
  priority: { type: String, default: null },
  subtasks: { type: Array, default: [] },
  assignedTo: { type: [String], default: [] }, // Array of User IDs
  createdAt: { type: String, default: () => new Date().toISOString() },
  modifiedAt: { type: String, default: null },
  lastUrgencyLevel: { type: String, default: null } // For due date urgency tracking
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
  subtasks: { type: [subtaskSchema], default: [] },
  createdBy: String,
  modifiedAt: { type: String, default: null },
  lastUrgencyLevel: { type: String, default: null } // For due date urgency tracking
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
