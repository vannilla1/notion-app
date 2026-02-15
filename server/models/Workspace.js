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
    defaultMemberRole: { type: String, enum: ['member', 'admin'], default: 'member' }
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

  // Check if slug exists and add number if needed
  let finalSlug = slug;
  let counter = 1;
  while (await this.findOne({ slug: finalSlug })) {
    finalSlug = `${slug}-${counter}`;
    counter++;
  }

  return finalSlug;
};

// Generate invite code
workspaceSchema.statics.generateInviteCode = function() {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 character code
};

// Indexes (slug and inviteCode already indexed via unique: true in schema)
workspaceSchema.index({ ownerId: 1 });

module.exports = mongoose.model('Workspace', workspaceSchema);
