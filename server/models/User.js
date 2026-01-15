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

module.exports = mongoose.model('User', userSchema);
