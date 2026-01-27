const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  // Who receives this notification
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
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
      'subtask.assigned'
    ],
    required: true
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
    enum: ['contact', 'task', 'subtask']
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

// TTL index to auto-delete expired notifications
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Notification', notificationSchema);
