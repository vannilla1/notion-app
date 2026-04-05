const mongoose = require('mongoose');

const apnsDeviceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  deviceToken: {
    type: String,
    required: true,
    unique: true
  },
  bundleId: {
    type: String,
    default: 'sk.perunelectromobility.prplcrm'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastUsed: {
    type: Date,
    default: Date.now
  }
});

apnsDeviceSchema.index({ userId: 1, deviceToken: 1 });

module.exports = mongoose.model('APNsDevice', apnsDeviceSchema);
