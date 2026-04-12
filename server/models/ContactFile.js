const mongoose = require('mongoose');

const contactFileSchema = new mongoose.Schema({
  contactId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact',
    index: true,
    default: null
  },
  fileId: {
    type: String,
    required: true,
    unique: true
  },
  data: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// fileId is UUID — globally unique, primary lookup key
contactFileSchema.index({ contactId: 1, fileId: 1 });

module.exports = mongoose.model('ContactFile', contactFileSchema);
