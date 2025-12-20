const mongoose = require('mongoose');

const subtaskSchema = new mongoose.Schema({
  id: String,
  title: String,
  completed: { type: Boolean, default: false },
  subtasks: { type: [this], default: [] }
}, { _id: false });

const taskSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  contactId: {
    type: String,
    default: null
  },
  title: {
    type: String,
    required: true
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
  subtasks: { type: [subtaskSchema], default: [] }
}, {
  timestamps: true
});

module.exports = mongoose.model('Task', taskSchema);
