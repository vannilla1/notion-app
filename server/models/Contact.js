const mongoose = require('mongoose');

const subtaskSchema = new mongoose.Schema({
  id: String,
  title: String,
  completed: { type: Boolean, default: false },
  subtasks: { type: Array, default: [] }
}, { _id: false });

const taskSchema = new mongoose.Schema({
  id: String,
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

module.exports = mongoose.model('Contact', contactSchema);
