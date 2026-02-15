const mongoose = require('mongoose');

const workspaceMemberSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  role: {
    type: String,
    enum: ['owner', 'admin', 'member'],
    default: 'member'
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  joinedAt: {
    type: Date,
    default: Date.now
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

// Ensure unique membership per workspace
workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
workspaceMemberSchema.index({ userId: 1 });
workspaceMemberSchema.index({ workspaceId: 1 });

// Virtual to get user details
workspaceMemberSchema.virtual('user', {
  ref: 'User',
  localField: 'userId',
  foreignField: '_id',
  justOne: true
});

// Virtual to get workspace details
workspaceMemberSchema.virtual('workspace', {
  ref: 'Workspace',
  localField: 'workspaceId',
  foreignField: '_id',
  justOne: true
});

// Check if user can perform admin actions
workspaceMemberSchema.methods.canAdmin = function() {
  return this.role === 'owner' || this.role === 'admin';
};

// Check if user is owner
workspaceMemberSchema.methods.isOwner = function() {
  return this.role === 'owner';
};

module.exports = mongoose.model('WorkspaceMember', workspaceMemberSchema);
