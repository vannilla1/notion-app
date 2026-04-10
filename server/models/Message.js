const mongoose = require('mongoose');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const fileSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  originalName: String,
  mimetype: String,
  size: Number,
  data: String, // Base64
  uploadedAt: { type: Date, default: Date.now }
}, { _id: false });

const pollOptionSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 200 },
  votes: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    votedAt: { type: Date, default: Date.now }
  }]
}, { _id: true });

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
    enum: ['approval', 'info', 'request', 'proposal', 'poll'],
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
  // Legacy single attachment (kept for backward compatibility)
  attachment: {
    id: String,
    originalName: String,
    mimetype: String,
    size: Number,
    data: String, // Base64
    uploadedAt: Date
  },
  // Multiple file attachments (same pattern as Tasks)
  files: { type: [fileSchema], default: [] },
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
  // Poll options (only for type 'poll')
  pollOptions: { type: [pollOptionSchema], default: [] },
  pollMultipleChoice: { type: Boolean, default: false },
  // Comments thread
  comments: { type: [commentSchema], default: [] },
  // Read tracking — array of userIds who have opened/read this message
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
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
