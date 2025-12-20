const mongoose = require('mongoose');

const pageSchema = new mongoose.Schema({
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
  timestamps: true
});

module.exports = mongoose.model('Page', pageSchema);
