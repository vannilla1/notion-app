const mongoose = require('mongoose');

/**
 * ServerError — paralelný in-house mirror server-side 5xx chýb.
 * Sentry zostáva primárny tracker (má source maps + breadcrumbs),
 * tento model slúži na SuperAdmin Diagnostics dashboard kde vidíme
 * chyby agregované, s count per fingerprint a resolve workflow.
 *
 * Fingerprint = sha256(normalized_stack + method + route_pattern)
 * → rovnaké chyby sa zlúčia do jedného dokumentu s `count++`.
 */
const serverErrorSchema = new mongoose.Schema({
  // Hash identifikujúci "rovnakú" chybu pre dedup/agregáciu
  fingerprint: { type: String, required: true, unique: true, index: true },

  // Zdroj chyby:
  //   'server' — unhandled Express error (5xx, crash v route handleri)
  //   'client' — prehliadač/PWA/TWA/WKWebView: ErrorBoundary,
  //              window.onerror, unhandledrejection
  // Pridané zámerne až po server-implementácii — existujúce dokumenty bez
  // tohto poľa Mongoose dotiahne ako default 'server' (zachová backfill).
  source: { type: String, enum: ['server', 'client'], default: 'server', index: true },

  // Základné info
  message: { type: String, required: true },
  stack: String,
  name: String, // Error.name (napr. 'TypeError', 'ValidationError')

  // Kontext požiadavky pri PRVOM výskyte (nepretáčame)
  // Pre client chyby: method='GET', path=URL pathname, statusCode=0
  method: String,
  path: String,
  statusCode: { type: Number, default: 500 },

  // Len pre source='client' — React component stack + URL v ktorom sa stalo
  componentStack: String,
  url: String,

  // Kto to trafil (prvý výskyt — pre ďalšie výskyty vidíme len count)
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null },
  userAgent: String,
  ipAddress: String,

  // Ľubovoľný JSON kontext — request body (bez hesiel), query params, headers subset
  context: mongoose.Schema.Types.Mixed,

  // Agregácia
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now, index: true },
  count: { type: Number, default: 1 },

  // Resolve workflow
  resolved: { type: Boolean, default: false, index: true },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt: Date,
  notes: String,

  // TTL — auto-mazanie po 90 dňoch (pattern z AuditLog.js).
  // Zámerne BEZ `index: true` tu lebo TTL index to pokryje (inak by mongoose
  // skúsil vytvoriť 2 indexy s rovnakým názvom ale rôznymi options).
  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: false
});

// TTL 90 dní (pokrýva aj bežné queries na createdAt)
serverErrorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Compound index pre default list query (unresolved, najnovšie prvé)
serverErrorSchema.index({ resolved: 1, lastSeen: -1 });

module.exports = mongoose.model('ServerError', serverErrorSchema);
