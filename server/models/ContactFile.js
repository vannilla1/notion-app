const mongoose = require('mongoose');

const contactFileSchema = new mongoose.Schema({
  contactId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact',
    required: true,
    index: true
  },
  fileId: {
    type: String,
    required: true,
    index: true
  },
  data: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

contactFileSchema.index({ contactId: 1, fileId: 1 }, { unique: true });

module.exports = mongoose.model('ContactFile', contactFileSchema);
