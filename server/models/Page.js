const mongoose = require('mongoose');

const pageSchema = new mongoose.Schema({
  // Workspace scoping — every page belongs to exactly one workspace.
  // All CRUD access is gated by WorkspaceMember membership in that workspace.
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true
  },
  // Creator / author. Kept for attribution and auditing, but access control
  // is based on workspace membership, not on userId match.
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  title: {
    type: String,
    default: 'Untitled'
  },
  content: {
    type: String,
    default: ''
  },
  icon: String,
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Page',
    default: null
  }
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      ret.id = ret._id.toString();
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

// Compound index: list/tree queries always filter by workspace + parent.
pageSchema.index({ workspaceId: 1, parentId: 1 });
pageSchema.index({ workspaceId: 1, updatedAt: -1 });

module.exports = mongoose.model('Page', pageSchema);
