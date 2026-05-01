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
    // OPTIONAL kvôli OAuth-only userom (Google / Apple). User vytvorený cez OAuth
    // nemá heslo, kým si ho nenastaví cez "Forgot password" reset flow. Bežný
    // password-flow ďalej validuje povinnosť hesla v register/login route-ách.
    type: String,
    required: false,
    default: null
  },
  // ─── OAuth identita ──────────────────────────────────────────────────
  // Provider IDs sú unikátne. User môže mať pripojené 0..2 OAuth providery —
  // ich ID kľúče sa nastavia až keď user prejde úspešným OAuth callbackom
  // alebo si pripojí účet v Settings.
  //
  // POZOR: zámerne BEZ `default: null`. Sparse index v MongoDB skipuje len
  // dokumenty, kde dané pole CHÝBA, nie tie kde je explicitne null. Keby sme
  // mali default:null, každý password-only user by mal googleId=null a druhý
  // taký user by padol na E11000 (oba null = "duplicate" pre unique index).
  // Keď pole nie je v dokumente vôbec, sparse správne preskočí. Query
  // `{ googleId: null }` v MongoDB matchuje oba prípady (null aj missing),
  // takže existing app code "find user without google" stále funguje.
  googleId: {
    type: String,
    sparse: true,
    unique: true
  },
  appleId: {
    type: String,
    sparse: true,
    unique: true
  },
  // Zoznam metód, ktorými sa user môže prihlásiť. Bezpečnostný gate pre
  // disconnect: nikdy nesmieme dovoliť odpojiť POSLEDNÚ metódu, inak by
  // user nemal ako sa prihlásiť. Default ['password'] kvôli legacy userom
  // (pred OAuth update mali heslo). Migration script doplní existujúcich.
  authProviders: {
    type: [String],
    enum: ['password', 'google', 'apple'],
    default: ['password']
  },
  // True iff email overený providerom (OAuth) alebo registračným potvrdzovacím
  // mailom (zatiaľ neimplementované). Použitie: auto-link pri OAuth flow —
  // password-only userov so zhodným emailom AUTO-PRIPOJÍME ku Google/Apple
  // iba ak provider potvrdí email_verified. Ináč by útočník vytvoril Google
  // účet s niečím cudzím emailom a získal cudzí account.
  emailVerified: {
    type: Boolean,
    default: false
  },
  // URL avatara z OAuth provider profilu (Google poskytuje, Apple nie). Ak
  // user nemá uploadnutý vlastný avatar (avatarData), frontend môže fall-back
  // na túto URL. Distinct od `avatar` (legacy URL field) a `avatarData`
  // (base64 nahraný cez UI).
  avatarUrl: {
    type: String,
    default: null
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
    plan: { type: String, enum: ['free', 'team', 'pro'], default: 'free' },
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    stripePriceId: { type: String, default: null },
    billingPeriod: { type: String, enum: ['monthly', 'yearly', null], default: null },
    // 'trialEndsAt' field (and 'trial' plan) was removed — local trial flow
    // was inert and confusing. Stripe-side trial state ('trialing' status)
    // is still tracked separately by Stripe webhooks. Existing docs may
    // have a stale trialEndsAt — Mongoose silently ignores it (strict mode).
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
  // ─────────────────────────────────────────────────────────────────────
  // Notification preferences — per-user push opt-ins.
  //
  // 'direct' notifikácie (priradenia, dokončenie mojej priradenej úlohy
  // niekým iným, správa pre mňa) sa do bell-panela ukladajú vždy a push
  // chodí vždy — toto sú akcie, ktoré si pýtajú reakciu user-a.
  //
  // 'general' notifikácie (cudzie zmeny, blížiace sa termíny, po termíne,
  // pridanie člena do workspace) sa vždy ukladajú do bell-panela, ale
  // push sa posiela LEN ak má user explicitne zapnutý príslušný toggle.
  // Default je všade false — anti-spam.
  // ─────────────────────────────────────────────────────────────────────
  notificationPreferences: {
    pushTeamActivity: { type: Boolean, default: false }, // cudzie projekty/úlohy/kontakty
    pushDeadlines:    { type: Boolean, default: false }, // 7d / 3d / dnes pripomienky
    pushOverdue:      { type: Boolean, default: false }, // po termíne
    pushNewMember:    { type: Boolean, default: false }  // nový člen workspace
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
    // Hash of last-synced event data per taskId — same pattern as googleTasks
    // below. Lets /sync short-circuit events.update when the event hasn't
    // changed, matching the speed of the Tasks sync for large workspaces.
    syncedEventHashes: { type: Map, of: String, default: () => new Map() }, // taskId -> content hash
    // Per-workspace opt-OUT (blacklist). Each entry is a workspaceId (string)
    // for which sync is explicitly disabled. Default empty = every workspace
    // the user is a member of syncs automatically.
    // Blacklist > whitelist: new workspaces the user joins later auto-sync
    // without requiring an extra "enable" click. Users who want tight control
    // add entries here.
    syncDisabledWorkspaces: { type: [String], default: [] },
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
    // Per-workspace opt-OUT — same shape + semantics as googleCalendar.
    syncDisabledWorkspaces: { type: [String], default: [] },
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
