const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  // Who receives this notification
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // Which workspace this notification belongs to — critical for multi-workspace users
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false, // Not required during migration of old records
    index: true
  },
  // Type of notification
  type: {
    type: String,
    enum: [
      'contact.created',
      'contact.updated',
      'contact.deleted',
      'task.created',
      'task.updated',
      'task.completed',
      'task.deleted',
      'task.assigned',
      'subtask.created',
      'subtask.updated',
      'subtask.completed',
      'subtask.deleted',
      'subtask.assigned',
      'task.dueDate',
      'subtask.dueDate',
      'message.created',
      'message.approved',
      'message.rejected',
      'message.commented',
      'message.comment.reacted',
      'workspace.memberAdded'
    ],
    required: true
  },
  // Notification category — determines visual treatment in the bell panel
  // and whether push is sent (direct = always push, general = only if user
  // opted in via notificationPreferences).
  //   'direct'  — explicit assignment to this user OR completion of this
  //               user's assigned task by someone else; high attention.
  //   'general' — passive team activity, deadlines, member events, etc.
  category: {
    type: String,
    enum: ['direct', 'general'],
    default: 'general',
    index: true
  },
  // Title shown in notification
  title: {
    type: String,
    required: true
  },
  // Detailed message
  message: {
    type: String,
    default: ''
  },
  // Who triggered this notification
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  actorName: String,
  // Related entity
  relatedType: {
    type: String,
    enum: ['contact', 'task', 'subtask', 'message']
  },
  relatedId: String,
  relatedName: String,
  // Additional data
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Read status
  read: {
    type: Boolean,
    default: false,
    index: true
  },
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  // Auto-expire after 30 days
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, workspaceId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, workspaceId: 1, createdAt: -1 });

// TTL index to auto-delete expired notifications
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Notification', notificationSchema);
