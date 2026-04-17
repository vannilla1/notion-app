const mongoose = require('mongoose');

/**
 * Firebase Cloud Messaging device — native Android appka (eu.prplcrm.app).
 *
 * Paralela s APNsDevice (iOS). Backend pri notifikácii pre daného usera najprv
 * skúsi zaslať FCM message na všetky jeho FCM devices a súbežne APNs / Web Push.
 *
 * `fcmToken` je idempotentný identifier — FCM ho regeneruje pri reinstall /
 * clear data / Play Services update. Pri onNewToken v appke pošleme nový token
 * a starý ticho expiruje (FCM nám vráti UNREGISTERED chybu, vtedy ho zmažeme).
 */
const fcmDeviceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  fcmToken: {
    type: String,
    required: true,
    unique: true
  },
  platform: {
    type: String,
    enum: ['android', 'android-native'],
    default: 'android'
  },
  packageName: {
    type: String,
    default: 'eu.prplcrm.app'
  },
  appVersion: {
    type: String
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

fcmDeviceSchema.index({ userId: 1, fcmToken: 1 });

module.exports = mongoose.model('FcmDevice', fcmDeviceSchema);
