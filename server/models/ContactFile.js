const mongoose = require('mongoose');

/**
 * ContactFile — externalizovaný file blob ku Contact alebo Task.
 *
 * MIGRÁCIA NA R2 (2026-05-21):
 * Predtým: `data` field uchovával base64 string priamo v MongoDB. Pri 83 files
 * sme narazili na 91% využitia 512 MB free tier-u Atlas.
 *
 * Teraz: `r2Key` ukazuje na object v Cloudflare R2 bucket-e. `data` je
 * legacy fallback (počas postupnej migrácie). Po migration script-e bude
 * `data: null` pre všetky records, a R2 bude zdroj pravdy.
 *
 * Backward compat: route handler-y čítajú obe polia — ak r2Key set, fetch
 * z R2; inak fallback na base64. Postupne sa stane že r2Key bude vždy set
 * a `data` schéma sa môže dropnúť úplne v ďalšej iterácii.
 */
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
  // NEW: R2 object key. Format "contactfiles/<fileId>". Null pre legacy
  // pre-R2 files (ešte nemigrované) — vtedy treba fallback na `data`.
  r2Key: {
    type: String,
    default: null,
    index: true
  },
  // LEGACY: base64-encoded file content. Po migrácii bude null.
  // Schemou required: false aby nové R2-backed records nepotrebovali túto hodnotu.
  data: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// fileId is UUID — globally unique, primary lookup key
contactFileSchema.index({ contactId: 1, fileId: 1 });

module.exports = mongoose.model('ContactFile', contactFileSchema);
