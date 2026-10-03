const mongoose = require('mongoose');
const crypto = require('crypto');

const workspaceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  description: {
    type: String,
    default: '',
    maxlength: 500
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Invite code for joining workspace
  inviteCode: {
    type: String,
    unique: true,
    sparse: true
  },
  inviteCodeEnabled: {
    type: Boolean,
    default: true
  },
  // Settings
  settings: {
    allowMemberInvites: { type: Boolean, default: false }, // Can members invite others?
    // WorkspaceMember.role pozná len owner/manager/member. 'admin' ostáva v
    // enum-e len kvôli legacy dokumentom (inak by save() takého workspace
    // padol na ValidationError) — join ho mapuje na 'member'.
    defaultMemberRole: { type: String, enum: ['member', 'manager', 'admin'], default: 'member' }
  },
  // Extra paid seats beyond the 2 included in Pro plan
  paidSeats: {
    type: Number,
    default: 0
  },
  // Workspace color/branding
  color: {
    type: String,
    default: '#6366f1'
  }
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      ret.id = ret._id.toString();
      return ret;
    }
  }
});

// Generate unique slug from name
workspaceSchema.statics.generateSlug = async function(name) {
  let slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  // Názov len z cyriliky/emoji/symbolov → prázdny slug by padol na
  // required validácii (500). Fallback s náhodným suffixom.
  if (!slug) slug = 'ws-' + crypto.randomBytes(3).toString('hex');

  // Check if slug exists and add number if needed
  let finalSlug = slug;
  let counter = 1;
  while (await this.findOne({ slug: finalSlug })) {
    finalSlug = `${slug}-${counter}`;
    counter++;
  }

  return finalSlug;
};

// Generate invite code — 12 hex znakov = 48 bitov entropie (predtým 8 znakov
// = 32 bitov, pri 100 req/min brute-force reálne dosiahnuteľné). Existujúce
// 8-znakové kódy ostávajú platné; /join má navyše vlastný rate limit.
workspaceSchema.statics.generateInviteCode = function() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
};

// Indexes (slug and inviteCode already indexed via unique: true in schema)
workspaceSchema.index({ ownerId: 1 });

module.exports = mongoose.model('Workspace', workspaceSchema);
