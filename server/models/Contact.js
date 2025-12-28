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
  id: { type: String, default: () => uuidv4() },
  title: String,
  description: { type: String, default: '' },
  completed: { type: Boolean, default: false },
  priority: { type: String, default: 'medium' },
  dueDate: String,
  subtasks: { type: [subtaskSchema], default: [] },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const fileSchema = new mongoose.Schema({
  id: String,
  filename: String,
  originalName: String,
  mimetype: String,
  size: Number,
  uploadedAt: { type: Date, default: Date.now }
}, { _id: false });

const contactSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    default: ''
  },
  email: String,
  phone: String,
  company: String,
  website: String,
  notes: String,
  status: {
    type: String,
    default: 'new'
  },
  tasks: { type: [taskSchema], default: [] },
  files: { type: [fileSchema], default: [] }
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

// Pre-save middleware to ensure all tasks and subtasks have IDs
contactSchema.pre('save', function() {
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

  if (this.tasks && this.tasks.length > 0) {
    for (let i = 0; i < this.tasks.length; i++) {
      if (!this.tasks[i].id) {
        this.tasks[i].id = uuidv4();
        console.log('Generated missing task ID:', this.tasks[i].id, 'for:', this.tasks[i].title);
      }
      generateIdsRecursive(this.tasks[i].subtasks);
    }
  }
});

module.exports = mongoose.model('Contact', contactSchema);
