const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const subtaskSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  title: String,
  completed: { type: Boolean, default: false },
  dueDate: String,
  notes: { type: String, default: '' },
  subtasks: { type: Array, default: [] }
}, { _id: false });

const taskSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  contactIds: {
    type: [String],
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
  createdBy: String
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

// Pre-save middleware to ensure all subtasks have IDs
taskSchema.pre('save', function(next) {
  const generateIdsRecursive = (subtasks) => {
    if (!subtasks || !Array.isArray(subtasks)) return;
    for (let i = 0; i < subtasks.length; i++) {
      if (!subtasks[i].id) {
        subtasks[i].id = uuidv4();
        console.log('Generated missing subtask ID:', subtasks[i].id, 'for:', subtasks[i].title);
      }
      if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
        generateIdsRecursive(subtasks[i].subtasks);
      }
    }
  };

  generateIdsRecursive(this.subtasks);
  next();
});

module.exports = mongoose.model('Task', taskSchema);
