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
  // Subscription / plan
  subscription: {
    plan: { type: String, enum: ['free', 'team', 'pro', 'trial'], default: 'free' },
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    stripePriceId: { type: String, default: null },
    billingPeriod: { type: String, enum: ['monthly', 'yearly', null], default: null },
    trialEndsAt: { type: Date, default: null },
    paidUntil: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    // Admin-applied discount
    discount: {
      type: { type: String, enum: ['percentage', 'fixed', 'freeMonths', 'planUpgrade', null], default: null },
      value: { type: Number, default: null },
      targetPlan: { type: String, enum: ['team', 'pro', null], default: null },
      reason: { type: String, default: null },
      expiresAt: { type: Date, default: null },
      createdAt: { type: Date, default: null },
      createdBy: { type: String, default: null }
    }
  },
  // Current active workspace
  currentWorkspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    default: null
  },
  // Password reset flow — token sa v DB ukladá ako SHA-256 hash, nie plain.
  // Plain token vidí len user v emaili a v URL query stringu.
  resetPasswordTokenHash: {
    type: String,
    default: null,
    index: true // lookup pri POST /reset-password
  },
  resetPasswordExpires: {
    type: Date,
    default: null
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
  //
  // Multi-workspace model (PR2): one Google calendar per workspace, named
  // "Prpl CRM — {workspace name}". Before PR2, every workspace shared
  // `calendarId` (usually "primary"), which meant events from workspace A
  // and workspace B ended up in the same bucket — users couldn't tell which
  // task came from which workspace.
  //
  // Migration strategy: `calendarId` stays as the legacy/fallback for users
  // who connected before PR2. `workspaceCalendars` is the map used going
  // forward — key = workspaceId (string), value = { calendarId, createdAt }.
  // Lazy population: on the first sync for a given workspace, we create a
  // secondary calendar via Google Calendar API and record the mapping.
  //
  // `syncedTaskCalendars` maps taskId → calendarId so delete paths know
  // which calendar to hit without having to re-read the Task document
  // (which may already be gone).
  googleCalendar: {
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    tokenExpiry: { type: Date, default: null },
    calendarId: { type: String, default: 'primary' },
    // Per-workspace calendars (PR2). taskId-level overrides via syncedTaskCalendars.
    workspaceCalendars: {
      type: Map,
      of: new mongoose.Schema({
        calendarId: { type: String, required: true },
        createdAt: { type: Date, default: Date.now }
      }, { _id: false }),
      default: () => new Map()
    },
    enabled: { type: Boolean, default: false },
    connectedAt: { type: Date, default: null },
    lastSyncAt: { type: Date, default: null },
    syncedTaskIds: { type: Map, of: String, default: new Map() }, // taskId -> googleEventId
    // Which calendar a given synced event lives in. Without this, delete paths
    // would have to re-fetch the Task document just to resolve workspaceId →
    // calendarId — and by then the task is often already gone.
    syncedTaskCalendars: { type: Map, of: String, default: () => new Map() }, // taskId -> calendarId
    // Watch channel for push notifications (Google → CRM)
    watchChannelId: { type: String, default: null },
    watchResourceId: { type: String, default: null },
    watchExpiry: { type: Date, default: null },
    // Sync token for incremental event list (only changed events since last sync)
    syncToken: { type: String, default: null }
  },
  // Google Tasks integration — same per-workspace model as Calendar above.
  googleTasks: {
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    tokenExpiry: { type: Date, default: null },
    taskListId: { type: String, default: null }, // Google Tasks list ID (legacy / single-workspace fallback)
    // Per-workspace task lists (PR2).
    workspaceTaskLists: {
      type: Map,
      of: new mongoose.Schema({
        taskListId: { type: String, required: true },
        createdAt: { type: Date, default: Date.now }
      }, { _id: false }),
      default: () => new Map()
    },
    enabled: { type: Boolean, default: false },
    connectedAt: { type: Date, default: null },
    syncedTaskIds: { type: Map, of: String, default: new Map() }, // crmTaskId -> googleTaskId
    // Which Google task list holds a given synced task. Mirrors
    // syncedTaskCalendars on the Calendar side — see comment there.
    syncedTaskLists: { type: Map, of: String, default: () => new Map() }, // crmTaskId -> taskListId
    // Track sync metadata for incremental sync
    syncedTaskHashes: { type: Map, of: String, default: new Map() }, // crmTaskId -> hash of task data
    lastSyncAt: { type: Date, default: null },
    // Daily quota tracking (resets at midnight UTC)
    quotaUsedToday: { type: Number, default: 0 },
    quotaResetDate: { type: Date, default: null },
    // Sync token for incremental task list (only changes since last poll)
    syncToken: { type: String, default: null }
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
