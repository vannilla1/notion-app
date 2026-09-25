const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// Spoločný tvar prílohy správy (legacy `attachment`, `files[]`, príloha
// komentára). Blob žije buď v Cloudflare R2 (`r2Key`, rovnako ako prílohy
// kontaktov/úloh), alebo — len pri záznamoch spred migrácie a pri base64
// fallbacku bez R2 — v `data`. Nikdy oboje: migrácia (services/
// messageFileMigration.js) nastaví r2Key a `data` odstráni v jednom update.
// Do klienta idú iba metadáta + príznak `inline` (routes/messages.js),
// r2Key ani data sa nikdy nevracajú.
const attachmentFields = {
  originalName: String,
  mimetype: String,
  size: Number,
  r2Key: { type: String, default: null },
  data: String, // Legacy base64 — chýba/null, keď je blob v R2
  uploadedAt: Date
};

const fileSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  ...attachmentFields,
  uploadedAt: { type: Date, default: Date.now }
}, { _id: false });

// Legacy príloha správy a príloha komentára sú JEDNODUCHÉ vnorené sub-dokumenty
// (nie „nested path"): pri nested path by `default: null` na r2Key vytvoril
// fantómový `attachment: { r2Key: null }` v každej správe bez prílohy a
// všetky kontroly `if (!message.attachment)` by prestali platiť. Sub-schéma
// ostáva undefined, kým sa príloha nenastaví; id sa pri nej negeneruje
// automaticky (starým prílohám bez id by hydratácia menila verziu/ETag —
// id im dopíše až migrácia spolu s r2Key).
const attachmentSchema = new mongoose.Schema({
  id: String,
  ...attachmentFields
}, { _id: false });

const pollOptionSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 200 },
  votes: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    votedAt: { type: Date, default: Date.now }
  }]
}, { _id: true });

// Reakcie na komentár (like/dislike). Jeden používateľ môže mať maximálne
// jednu aktívnu reakciu na komentár — enforcenuté na route úrovni ($pull
// pred $push). Uchovávame username pre rýchle zobrazenie v tooltipe bez
// populate lookup.
const commentReactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  type: { type: String, enum: ['like', 'dislike'], required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const commentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  text: { type: String, required: true },
  attachment: attachmentSchema,
  reactions: { type: [commentReactionSchema], default: [] },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

// Verejný tvar prílohy pre toJSON (poistka, keby niekto poslal dokument
// priamo cez res.json bez stripAttachmentData): bez base64 aj bez r2Key.
// Rovnaké pravidlo ako services/messageFiles.js publicAttachment (model
// service nevyžaduje — kruhová závislosť).
const publicAttachment = (att) => {
  if (!att) return att;
  return {
    id: att.id,
    originalName: att.originalName,
    mimetype: att.mimetype,
    size: att.size,
    uploadedAt: att.uploadedAt,
    inline: !att.r2Key
  };
};

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
  attachment: attachmentSchema,
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
      // Strip attachment data (and R2 keys) from list views
      if (ret.attachment) ret.attachment = publicAttachment(ret.attachment);
      if (Array.isArray(ret.files)) ret.files = ret.files.map(publicAttachment);
      if (Array.isArray(ret.comments)) {
        ret.comments = ret.comments.map(c => (
          c && c.attachment ? { ...c, attachment: publicAttachment(c.attachment) } : c
        ));
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
