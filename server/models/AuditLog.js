const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  username: String,
  email: String,
  action: { type: String, required: true, index: true }, // e.g. 'user.role_changed', 'user.plan_changed', 'user.deleted', 'workspace.created', 'workspace.deleted', 'contact.created', 'task.created', etc.
  category: { type: String, enum: ['user', 'workspace', 'contact', 'task', 'message', 'system', 'auth', 'billing'], index: true },
  targetType: String, // 'user', 'workspace', 'contact', 'task', 'message'
  targetId: String,
  targetName: String,
  details: mongoose.Schema.Types.Mixed, // Additional context (old/new values, etc.)
  ipAddress: String,
  userAgent: String,
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  // NOTE: Zámerne BEZ `index: true` tu — duplikovalo by sa s TTL indexom nižšie.
  // Mongoose by potom skúšal vytvoriť dva indexy s rovnakým názvom (createdAt_1)
  // ale rôznymi opciami (s/bez expireAfterSeconds) → MongoServerError a TTL
  // by v produkcii nemusel fungovať (logy by sa nikdy samy nemazali).
  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: false // we manage createdAt ourselves
});

// Auto-delete after 90 days — tento index pokrýva aj bežné queries na createdAt.
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
// Compound indexes for common queries
auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
