const mongoose = require('mongoose');
const crypto = require('crypto');

const commentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  text: { type: String, required: true },
  attachment: {
    originalName: String,
    mimetype: String,
    size: Number,
    data: String, // Base64
    uploadedAt: Date
  },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const messageSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true
  },
  // Sender
  fromUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  fromUsername: { type: String, required: true },
  // Recipient
  toUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  toUsername: { type: String, required: true },
  // Content
  type: {
    type: String,
    enum: ['approval', 'info', 'request', 'proposal'],
    required: true
  },
  subject: {
    type: String,
    required: true,
    maxlength: 200
  },
  description: {
    type: String,
    default: '',
    maxlength: 5000
  },
  // Optional attachment (Base64 in MongoDB)
  attachment: {
    id: String,
    originalName: String,
    mimetype: String,
    size: Number,
    data: String, // Base64
    uploadedAt: Date
  },
  // Optional link to contact or task
  linkedType: {
    type: String,
    enum: ['contact', 'task', null],
    default: null
  },
  linkedId: { type: String, default: null },
  linkedName: { type: String, default: null },
  // Optional deadline
  dueDate: { type: Date, default: null },
  // Status
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'commented'],
    default: 'pending'
  },
  // Rejection reason
  rejectionReason: { type: String, default: '' },
  // Comments thread
  comments: { type: [commentSchema], default: [] },
  // Who resolved it and when
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt: { type: Date, default: null }
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      ret.id = ret._id.toString();
      // Strip attachment data from list views
      if (ret.attachment && ret.attachment.data) {
        ret.attachment = {
          id: ret.attachment.id,
          originalName: ret.attachment.originalName,
          mimetype: ret.attachment.mimetype,
          size: ret.attachment.size,
          uploadedAt: ret.attachment.uploadedAt
        };
      }
      return ret;
    }
  }
});

// Indexes
messageSchema.index({ workspaceId: 1, toUserId: 1, status: 1, createdAt: -1 });
messageSchema.index({ workspaceId: 1, fromUserId: 1, createdAt: -1 });
messageSchema.index({ workspaceId: 1, status: 1 });

module.exports = mongoose.model('Message', messageSchema);
