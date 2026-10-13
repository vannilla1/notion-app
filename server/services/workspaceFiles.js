/**
 * workspaceFiles.js — kaskádové mazanie príloh kontaktov a projektov
 * (ContactFile riadky + R2 objekty) pri zmazaní celého workspace.
 *
 * Metadáta príloh (fileId) žijú v Contact/Task dokumentoch; ContactFile je
 * len resolver fileId → r2Key/data a nemá workspaceId. Preto sa fileId
 * najprv zozbierajú z dokumentov workspace (listWorkspaceAttachments) a až
 * potom sa zmažú bloby a ContactFile riadky. Volať PRED Contact/Task
 * deleteMany — po ňom už fileId niet odkiaľ zistiť.
 *
 * Best-effort: nikdy nehádže. Zlyhanie mazania blobu nesmie zastaviť
 * mazanie workspace/účtu; sirota v R2 je opraviteľná skriptom.
 *
 * Prílohy správ (Message) rieši messageFiles.deleteMessageBlobs.
 */
const ContactFile = require('../models/ContactFile');
const fileStorage = require('./fileStorage');
const { listWorkspaceAttachments } = require('../utils/attachmentIndex');
const logger = require('../utils/logger');

const BATCH_SIZE = 200;
const DELETE_CONCURRENCY = 20;

const deleteR2Keys = async (keys) => {
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    await Promise.all(keys.slice(i, i + DELETE_CONCURRENCY).map((key) =>
      fileStorage.deleteFile(key).catch((err) => {
        logger.warn('[WorkspaceFiles] R2 delete failed', { key, error: err.message });
      })
    ));
  }
};

/**
 * Zmaže bloby a ContactFile riadky všetkých príloh kontaktov a projektov
 * v daných workspace. Vracia počet spracovaných fileId.
 */
const deleteWorkspaceFileBlobs = async (workspaceIds) => {
  const ids = (Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds]).filter(Boolean);
  let processed = 0;
  for (const workspaceId of ids) {
    try {
      const entries = await listWorkspaceAttachments(workspaceId);
      const fileIds = [...new Set(entries.map((e) => e.fileId).filter(Boolean))];
      for (let i = 0; i < fileIds.length; i += BATCH_SIZE) {
        const batch = fileIds.slice(i, i + BATCH_SIZE);
        const rows = await ContactFile.find({ fileId: { $in: batch } }, { r2Key: 1 }).lean();
        const keys = rows.map((r) => r.r2Key).filter(Boolean);
        if (keys.length && fileStorage.isR2Available()) {
          await deleteR2Keys(keys);
        }
        await ContactFile.deleteMany({ fileId: { $in: batch } });
        processed += batch.length;
      }
    } catch (err) {
      logger.warn('[WorkspaceFiles] Kaskádové mazanie príloh zlyhalo (dáta sa mažú ďalej)', {
        workspaceId: String(workspaceId),
        error: err.message
      });
    }
  }
  return processed;
};

module.exports = { deleteWorkspaceFileBlobs };
