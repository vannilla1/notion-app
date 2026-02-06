const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  color: {
    type: String,
    default: '#3B82F6'
  },
  avatar: {
    type: String,
    default: null
  },
  avatarData: {
    type: String,  // Base64 encoded image data
    default: null
  },
  avatarMimetype: {
    type: String,
    default: null
  },
  role: {
    type: String,
    enum: ['admin', 'manager', 'user'],
    default: 'user'
  },
  lastCalendarExport: {
    type: Date,
    default: null
  },
  exportedTaskIds: {
    type: [String],
    default: []
  },
  calendarFeedToken: {
    type: String,
    default: null,
    unique: true,
    sparse: true
  },
  calendarFeedEnabled: {
    type: Boolean,
    default: false
  },
  calendarFeedCreatedAt: {
    type: Date,
    default: null
  },
  // Google Calendar integration
  googleCalendar: {
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    tokenExpiry: { type: Date, default: null },
    calendarId: { type: String, default: 'primary' },
    enabled: { type: Boolean, default: false },
    connectedAt: { type: Date, default: null },
    syncedTaskIds: { type: Map, of: String, default: new Map() } // taskId -> googleEventId
  },
  // Google Tasks integration
  googleTasks: {
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    tokenExpiry: { type: Date, default: null },
    taskListId: { type: String, default: null }, // Google Tasks list ID
    enabled: { type: Boolean, default: false },
    connectedAt: { type: Date, default: null },
    syncedTaskIds: { type: Map, of: String, default: new Map() }, // crmTaskId -> googleTaskId
    // Track sync metadata for incremental sync
    syncedTaskHashes: { type: Map, of: String, default: new Map() }, // crmTaskId -> hash of task data
    lastSyncAt: { type: Date, default: null },
    // Daily quota tracking (resets at midnight UTC)
    quotaUsedToday: { type: Number, default: 0 },
    quotaResetDate: { type: Date, default: null }
  }
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      ret.id = ret._id.toString();
      delete ret.password;
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

// Indexes for efficient lookups
userSchema.index({ 'googleCalendar.enabled': 1 });
userSchema.index({ 'googleTasks.enabled': 1 });
userSchema.index({ role: 1 });

module.exports = mongoose.model('User', userSchema);
