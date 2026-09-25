const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace, enforceWorkspaceLimits } = require('../middleware/workspace');
const Message = require('../models/Message');
const User = require('../models/User');
const notificationService = require('../services/notificationService');
const auditService = require('../services/auditService');
const { recordError } = require('../services/serverErrorService');
const logger = require('../utils/logger');
const { attachmentFileFilter, sanitizeDisplayName, effectiveExtension } = require('../utils/uploadFilter');
const fileStorage = require('../services/fileStorage');
const { publicAttachment, isInlineAttachment, collectMessageR2Keys, deleteBlobs, R2_KEY_PROJECTION } = require('../services/messageFiles');
const { STORAGE_LIMITS, computeWorkspaceFileBytes } = require('../utils/storageQuota');
const { logPlanGateHit } = require('../utils/planGate');
const { isIosNativeApp } = require('../utils/platform');

// Projection that excludes ALL Base64 blobs so comment CRUD never pulls
// megabytes of existing attachments into Node memory. Root cause of
// 10+ sec comment operations was `message.save()` rewriting the full
// document (including every Base64 attachment of every other comment).
const NO_BASE64_PROJECTION = {
  'attachment.data': 0,
  'files.data': 0,
  'comments.attachment.data': 0
};

const router = express.Router();

// ─── Prílohy správ: limity, filter, chyby ─────────────────────
//
// Prílohy správ (files[], legacy attachment, prílohy komentárov) žijú od
// 9/2026 v Cloudflare R2 rovnako ako prílohy kontaktov/úloh — v Mongo
// dokumente ostávajú len metadáta + r2Key (services/messageFiles.js).
// Do migrácie (services/messageFileMigration.js) a bez R2 (lokálny vývoj,
// testy) je blob base64 priamo v dokumente: +33 %, BSON strop 16 MB → do
// jednej správy sa zmestí ~12 MB. Strop preto strážime PRED zápisom, ale
// len pre INLINE prílohy — R2 prílohy dokument nezväčšujú.
//
// Limit na súbor: s R2 rovnaký ako pri úlohách (50 MB), bez R2 ostáva 10 MB.
// Dostupnosť R2 je daná env pri štarte, takže sa vyhodnotí raz — multer
// vzniká pri načítaní modulu.
const MESSAGE_FILE_LIMIT = fileStorage.isR2Available() ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
const MESSAGE_FILE_LIMIT_MB = Math.round(MESSAGE_FILE_LIMIT / (1024 * 1024));
const BSON_DOC_LIMIT = 16 * 1024 * 1024;
// Rezerva na všetko okrem príloh (predmet, popis, komentáre, anketa, readBy,
// BSON kľúče). Bez nej by sa správa naplnila po okraj a zlyhal by aj ďalší
// čisto textový komentár.
const MESSAGE_DOC_RESERVE = 512 * 1024;
const MESSAGE_ATTACHMENT_BUDGET = BSON_DOC_LIMIT - MESSAGE_DOC_RESERVE;
const ATTACHMENT_META_OVERHEAD = 1024; // názov, mimetype, id, dátum, kľúče
const MESSAGE_TOO_LARGE_CODE = 'MESSAGE_ATTACHMENTS_TOO_LARGE';
const MESSAGE_TOO_LARGE_TEXT = 'Prílohy tejto správy by spolu presiahli limit približne 12 MB. Ďalšie súbory pridajte do novej správy alebo k úlohe.';

// Rovnaké pravidlo počíta aj klient (Messages.jsx msgAttachmentsWouldOverflow)
// — z veľkostí v metadátach, takže netreba ťahať base64 z Monga. Pri zmene
// ho uprav na OBOCH miestach.
const encodedAttachmentBytes = (size) =>
  Math.ceil(Math.max(0, Number(size) || 0) / 3) * 4 + ATTACHMENT_META_OVERHEAD;

// Ráta len INLINE prílohy (bez r2Key) — tie jediné sedia v dokumente.
// Projekcie, ktoré sem posielajú metadáta, preto MUSIA niesť aj r2Key.
const estimateMessageAttachmentBytes = (msg, { skipLegacyAttachment = false } = {}) => {
  const inlineBytes = (att) => (isInlineAttachment(att) && att.size ? encodedAttachmentBytes(att.size) : 0);
  let total = 0;
  if (!skipLegacyAttachment) total += inlineBytes(msg?.attachment);
  for (const f of msg?.files || []) total += inlineBytes(f);
  for (const c of msg?.comments || []) total += inlineBytes(c?.attachment);
  return total;
};

const wouldExceedMessageDocLimit = (msg, newFileSize, opts) => {
  // S R2 nový súbor do dokumentu nejde — strop sa ho netýka.
  if (fileStorage.isR2Available()) return false;
  return estimateMessageAttachmentBytes(msg, opts) + encodedAttachmentBytes(newFileSize) > MESSAGE_ATTACHMENT_BUDGET;
};

const rejectTooLarge = (res) =>
  res.status(413).json({ code: MESSAGE_TOO_LARGE_CODE, message: MESSAGE_TOO_LARGE_TEXT });

// Poistka pre prípady, ktoré odhad nezachytí (súbežné nahrávania, veľa
// textu v komentároch): Mongo „dokument je väčší ako 16 MB" → rovnaká 413
// namiesto generickej 500. 10334 = BSONObjectTooLarge (aj „Resulting document
// after update is larger than 16777216"), 17419/17420 = staršie varianty
// update/upsert. RangeError ERR_OUT_OF_RANGE hodí BSON serializér ovládača,
// keď dokument presiahne jeho ~17 MB buffer ešte pred odoslaním na server.
const isDocTooLargeError = (err) => {
  if (!err) return false;
  if ([10334, 17419, 17420].includes(err.code)) return true;
  if (err.codeName === 'BSONObjectTooLarge') return true;
  if (err.code === 'ERR_OUT_OF_RANGE' && /offset/i.test(err.message || '')) return true;
  return /larger than (the maximum size )?16777216|BSONObjectTooLarge/i.test(err.message || '');
};

// Diagnostika (recordError) ukladá req.body — pri správach je to predmet,
// popis a text komentára, teda súkromná komunikácia medzi členmi tímu. Do
// Diagnostiky pošleme namiesto toho len metadáta prílohy. Object.create
// zachová všetko ostatné (method, path, user, UA, IP) cez prototyp.
const diagnosticReq = (req) => Object.create(req, {
  body: {
    value: req.file ? { fileSize: req.file.size, mimetype: req.file.mimetype } : undefined,
    enumerable: true
  }
});

// Zápis správy/prílohy zlyhal: plný dokument → 413 so slovenskou radou,
// všetko ostatné → SKUTOČNÁ príčina do Diagnostiky (inak by captureResponseErrors
// zachytil len syntetické „HTTP 500 POST /api/messages/:id/files" bez stacku).
const handleMessageWriteError = (error, req, res, label) => {
  // POST / po odpovedi ešte loguje audit — chyba tam už nesmie posielať
  // druhú odpoveď (ERR_HTTP_HEADERS_SENT), len sa zaznamená.
  if (res.headersSent) {
    logger.error(label, { error: error.message, userId: req.user?.id });
    recordError(error, diagnosticReq(req)).catch(() => {});
    return undefined;
  }
  if (isDocTooLargeError(error)) {
    logger.warn(`${label}: message document too large`, {
      userId: req.user?.id,
      fileSize: req.file?.size,
      mongoCode: error.code
    });
    return rejectTooLarge(res);
  }
  logger.error(label, { error: error.message, userId: req.user?.id });
  recordError(error, diagnosticReq(req)).catch(() => {});
  if (res.locals) res.locals.__errorRecorded = true;
  return res.status(500).json({ message: 'Chyba servera' });
};

// Videá sú bez R2 zakázané: aj krátke video z telefónu presiahne 10 MB a
// base64 v Mongo dokumente by rýchlo vyčerpalo 16 MB strop. S R2 idú ako
// pri úlohách. Kontrola aj podľa prípony — Android/desktop niekedy pošle
// application/octet-stream.
const VIDEO_EXTENSIONS = new Set(['mov', 'mp4', 'm4v', 'avi', 'mkv', 'webm', '3gp', '3g2', 'wmv', 'flv', 'mpg', 'mpeg', 'mts', 'm2ts']);

// Pôvodný allowlist prípon odmietal HEIC fotky z iPhonu/Macu, ODT/ODS, EML…
// (tie isté súbory k úlohe prešli). Teraz rovnaký blocklist ako kontakty
// a úlohy — attachmentFileFilter zároveň opraví UTF-8 názov súboru
// (multer ho dekóduje ako latin1 → „faktÃºra.pdf"). Download ide vždy
// s Content-Disposition: attachment + nosniff, takže HTML/SVG sa nikdy
// nevykreslí na API origine.
const messageFileFilter = (req, file, cb) => {
  attachmentFileFilter(req, file, (err, accepted) => {
    if (err) return cb(err);
    const mime = String(file.mimetype || '').toLowerCase();
    // effectiveExtension: „video.mp4." sa uloží ako „video.mp4" — prípona
    // sa musí brať z názvu tak, ako bude uložený
    const ext = effectiveExtension(file.originalname);
    if (!fileStorage.isR2Available() && (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(ext))) {
      const videoErr = new Error('Videá sa k správam nedajú priložiť. Pridajte video k úlohe alebo kontaktu.');
      videoErr.code = 'VIDEO_NOT_ALLOWED';
      return cb(videoErr);
    }
    return cb(null, accepted);
  });
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MESSAGE_FILE_LIMIT },
  fileFilter: messageFileFilter
});

// Chyby z multer/busboy → slovenská hláška + kód, ktorý klient vie rozlíšiť.
// Do 9/2026 sa používateľovi zobrazil surový anglický text („Unexpected end
// of form") a Diagnostika nedostala nič, lebo 4xx sa nezaznamenávajú.
const UPLOAD_BODY_INCOMPLETE_RE = /Unexpected end of (form|multipart data)|Malformed part header|Boundary not found/i;

// Technický kontext prenosu pre Diagnostiku — nikdy názov súboru, obsah
// správy ani token (Authorization hlavičku nečítame).
const uploadDiagContext = (req, err) => {
  const headers = req.headers || {};
  const ct = String(headers['content-type'] || '');
  const ua = String((typeof req.get === 'function' && req.get('user-agent')) || '');
  const shell = ua.match(/PrplCRM-(iOS|Android)\/[\w.]+/);
  return {
    upload: {
      multerCode: err?.code || null,
      contentLength: headers['content-length'] === undefined ? null : Number(headers['content-length']),
      bodyBytes: typeof req.uploadBodyBytes === 'function' ? req.uploadBodyBytes() : null,
      contentType: ct.split(';')[0].trim().slice(0, 60) || null,
      hasBoundary: /boundary=/i.test(ct),
      shell: shell ? shell[0] : 'web'
    }
  };
};

// Zápis do Diagnostiky BEZ obsahu správy a bez názvu súboru. Správa je
// zámerne bez premenných hodnôt (tie idú do contextu) → fingerprint je
// jeden riadok na druh chyby a opakovanie len zvýši count.
const reportUploadRejection = (err, req, code) => {
  try {
    const e = new Error(`${code}: ${String(err?.message || 'Upload rejected').slice(0, 200)}`);
    e.name = 'MessageUploadRejected';
    e.status = 400;
    recordError(e, diagnosticReq(req), uploadDiagContext(req, err)).catch(() => {});
  } catch (_) {
    // Sledovanie nesmie nikdy zhodiť samotnú odpoveď.
  }
};

const respondUploadError = (err, req, res) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ code: 'FILE_TOO_LARGE', message: `Súbor je príliš veľký. Maximum pre správy je ${MESSAGE_FILE_LIMIT_MB} MB.` });
  }
  if (err.code === 'BLOCKED_EXTENSION' || err.code === 'VIDEO_NOT_ALLOWED') {
    return res.status(400).json({ code: err.code, message: err.message });
  }
  const incomplete = UPLOAD_BODY_INCOMPLETE_RE.test(err.message || '') || req.headers['content-length'] === '0';
  const code = incomplete ? 'UPLOAD_BODY_INCOMPLETE' : 'UPLOAD_REJECTED';
  reportUploadRejection(err, req, code);
  return res.status(400).json({
    code,
    message: incomplete
      ? 'Súbor sa na server nedostal celý. Vyberte ho prosím znova a nahrajte.'
      : 'Súbor sa nepodarilo prijať. Skúste ho nahrať znova.'
  });
};

// Zobrazovaný názov prílohy: už opravené UTF-8 (fileFilter) + bez „/", „\"
// a riadiacich znakov, ktoré rozbíjajú uloženie na zariadení.
const storedFileName = (file) => sanitizeDisplayName(file.originalname) || file.originalname || 'priloha';

/**
 * Uloží nahraný súbor a vráti metadáta prílohy pre Message dokument.
 * S R2: upload PRED zápisom do DB (ako tasks.js), v dokumente len r2Key.
 * Bez R2: base64 inline (lokálny vývoj, testy). Ak zápis do DB potom zlyhá,
 * volajúci blob zmaže cez deleteBlobs — inak by v R2 ostala sirota.
 */
const persistUpload = async (file) => {
  const id = uuidv4();
  const meta = {
    id,
    originalName: storedFileName(file),
    mimetype: file.mimetype,
    size: file.size,
    uploadedAt: new Date()
  };
  if (fileStorage.isR2Available()) {
    const r2Key = fileStorage.messageFileKey(id);
    await fileStorage.uploadFile(r2Key, file.buffer, file.mimetype || 'application/octet-stream');
    return { ...meta, r2Key };
  }
  return { ...meta, data: file.buffer.toString('base64') };
};

/**
 * Plánová kvóta úložiska (Tím 1 GB / Pro 10 GB) — prílohy správ sa do nej
 * rátajú od presunu do R2 (utils/storageQuota.js). Free/trial kvótu nemá a
 * správy nikdy nemali plánovú bránu na prílohy, takže tam sa nič nemení.
 * Vráti telo 403 alebo null.
 */
const messageStorageQuotaError = async (req, fileSize) => {
  const uploader = await User.findById(req.user.id).select('subscription').lean();
  const plan = uploader?.subscription?.plan || 'free';
  const storageBytes = STORAGE_LIMITS[plan];
  if (!storageBytes) return null;
  const usedBytes = await computeWorkspaceFileBytes(req.workspaceId);
  if (usedBytes + fileSize <= storageBytes) return null;
  const usedMb = Math.round(usedBytes / (1024 * 1024));
  const limitMb = Math.round(storageBytes / (1024 * 1024));
  const message = isIosNativeApp(req)
    // Apple 3.1.1 — iOS bez akejkoľvek zmienky o pláne / tier.
    ? `Dosiahli ste storage limit (${usedMb}/${limitMb} MB).`
    : `Dosiahli ste storage limit pre váš plán (${usedMb}/${limitMb} MB). Upgradujte plán pre vyšší limit.`;
  logPlanGateHit(req, { code: 'STORAGE_LIMIT', feature: 'storage', limit: limitMb });
  return { message, code: 'STORAGE_LIMIT' };
};

/**
 * Odošle obsah prílohy: z R2 (r2Key) alebo z legacy base64 (data). Hlavičky
 * (attachment + nosniff + cache/ETag od volajúceho) rovnako pre obe cesty.
 * Chýbajúci objekt v R2 → 404, nie 500 — metadáta síce sú, ale súbor treba
 * nahrať znova.
 */
const sendStoredAttachment = async (res, att, extraHeaders) => {
  let buffer;
  if (att.r2Key) {
    try {
      buffer = await fileStorage.downloadFile(att.r2Key);
    } catch (err) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ message: 'Dáta súboru nenájdené — súbor treba znovu nahrať' });
      }
      throw err;
    }
  } else if (att.data) {
    buffer = Buffer.from(att.data, 'base64');
  } else {
    return res.status(404).json({ message: 'Príloha nenájdená' });
  }
  setDownloadHeaders(res, att, { 'Content-Length': buffer.length, ...extraHeaders });
  return res.send(buffer);
};

// Download hlavičky pre všetky prílohy správ: VŽDY attachment (RFC 6266
// filename* s UTF-8 cez res.attachment) + nosniff, ako kontakty/úlohy.
// Náhľad v appke to neovplyvní — FilePreviewModal aj ⬇️ sťahujú cez XHR blob
// a náhľad zobrazujú z blob: URL, nie priamo z tejto adresy.
const setDownloadHeaders = (res, meta, extra) => {
  res.attachment(sanitizeDisplayName(meta.originalName) || 'priloha');
  res.set({
    'Content-Type': meta.mimetype || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    ...extra
  });
};

// Verzia legacy prílohy (message.attachment) pre URL ?v= a ETag. Príloha sa
// dá v úprave správy nahradiť NA MIESTE — URL aj ETag podľa id správy by
// vracali rok starý súbor z HTTP cache. Klient počíta to isté (Messages.jsx).
const attachmentVersion = (att) => {
  if (!att) return 'none';
  if (att.id) return String(att.id);
  const ts = att.uploadedAt ? new Date(att.uploadedAt).getTime() : NaN;
  return Number.isFinite(ts) ? String(ts) : 'legacy';
};

// Type labels for notifications
const typeLabels = {
  approval: 'Schválenie',
  info: 'Informácia',
  request: 'Žiadosť',
  proposal: 'Návrh',
  poll: 'Anketa'
};

// Verejný tvar správy pre klienta: prílohy len ako metadáta + `inline`
// (services/messageFiles.js publicAttachment) — nikdy base64 ani r2Key.
// Funguje na Mongoose dokumente aj na lean objekte.
const stripAttachmentData = (msg) => {
  const obj = msg.toObject ? msg.toObject() : { ...msg };
  obj.id = obj._id ? obj._id.toString() : obj.id;
  if (obj.attachment) obj.attachment = publicAttachment(obj.attachment);
  if (Array.isArray(obj.files)) obj.files = obj.files.map(publicAttachment);
  if (Array.isArray(obj.comments)) {
    obj.comments = obj.comments.map(c => (c && c.attachment ? { ...c, attachment: publicAttachment(c.attachment) } : c));
  }
  return obj;
};

// GET /api/messages — get messages for current user (received + sent)
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const userId = req.user.id.toString();
    const { tab = 'received', status } = req.query;

    const query = { workspaceId: req.workspaceId };

    if (tab === 'sent') {
      query.fromUserId = req.user.id;
    } else if (tab === 'all') {
      query.$or = [{ fromUserId: req.user.id }, { toUserId: req.user.id }];
    } else {
      query.toUserId = req.user.id;
    }

    if (status && status !== 'all') {
      query.status = status;
    }

    const messages = await Message.find(query, { 'attachment.data': 0, 'files.data': 0, 'comments.attachment.data': 0 })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Verejný tvar (id, metadáta príloh + inline; bez base64 a r2Key — projekcia
    // vylúči data, r2Key by inak prešiel do klienta)
    const result = messages.map(stripAttachmentData);

    res.json(result);
  } catch (error) {
    logger.error('Get messages error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/by-linked — messages linked to a contact or task
router.get('/by-linked', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { linkedType, linkedId } = req.query;
    if (!linkedType || !linkedId) {
      return res.status(400).json({ message: 'linkedType a linkedId sú povinné' });
    }

    const messages = await Message.find(
      { workspaceId: req.workspaceId, linkedType, linkedId },
      NO_BASE64_PROJECTION
    )
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const result = messages.map(stripAttachmentData);
    res.json(result);
  } catch (error) {
    logger.error('Get linked messages error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/pending-count — count unread pending messages for current user
router.get('/pending-count', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const count = await Message.countDocuments({
      workspaceId: req.workspaceId,
      toUserId: req.user.id,
      status: 'pending',
      readBy: { $ne: req.user.id }
    });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/:id — get single message (with attachment data for download)
router.get('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return res.status(400).json({ message: 'Neplatné ID' });
    }

    // PERF: single findOneAndUpdate + .lean() instead of findOne + updateOne.
    // $addToSet is idempotent so it's safe to always run; one DB round-trip
    // instead of two, and .lean() skips Mongoose document hydration (big win
    // for messages with many comments / attachments).
    // PERF: exclude Base64 attachment/file/comment-attachment blobs from the
    // payload. These can be MBs each and are only needed on explicit download
    // via the /attachment endpoints. This was making message detail open take
    // tens of seconds when large attachments were present.
    const message = await Message.findOneAndUpdate(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ]
      },
      { $addToSet: { readBy: req.user.id } },
      { new: true, projection: NO_BASE64_PROJECTION }
    ).lean();

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený' });
    }

    res.json(stripAttachmentData(message));
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/messages — create a new message
router.post('/', authenticateToken, requireWorkspace, enforceWorkspaceLimits, (req, res) => {
  upload.single('attachment')(req, res, async (err) => {
    if (err) return respondUploadError(err, req, res);

    // Blob už nahraný do R2, ale správa ešte nie je uložená — pri chybe ho
    // treba zmazať. Po save() sa nuluje (prípadná neskoršia chyba, napr.
    // notifikácia, blob NESMIE zmazať).
    let uncommittedKey = null;
    try {
      const { toUserId, type, subject, description, linkedType, linkedId, linkedName, dueDate } = req.body;

      // Validate required fields
      if (!toUserId || !type || !subject) {
        return res.status(400).json({ message: 'Príjemca, typ a predmet sú povinné' });
      }

      if (!['approval', 'info', 'request', 'proposal', 'poll'].includes(type)) {
        return res.status(400).json({ message: 'Neplatný typ odkazu' });
      }

      // Validate poll options
      let parsedPollOptions = [];
      let pollMultipleChoice = false;
      if (type === 'poll') {
        try {
          parsedPollOptions = JSON.parse(req.body.pollOptions || '[]');
        } catch {
          parsedPollOptions = [];
        }
        if (!Array.isArray(parsedPollOptions) || parsedPollOptions.length < 2) {
          return res.status(400).json({ message: 'Anketa musí mať aspoň 2 možnosti' });
        }
        if (parsedPollOptions.length > 10) {
          return res.status(400).json({ message: 'Anketa môže mať maximálne 10 možností' });
        }
        parsedPollOptions = parsedPollOptions
          .map(opt => ({ text: (typeof opt === 'string' ? opt : opt.text || '').trim().substring(0, 200) }))
          .filter(opt => opt.text.length > 0);
        if (parsedPollOptions.length < 2) {
          return res.status(400).json({ message: 'Anketa musí mať aspoň 2 neprázdne možnosti' });
        }
        pollMultipleChoice = req.body.pollMultipleChoice === 'true' || req.body.pollMultipleChoice === true;
      }

      // Get recipient
      const recipient = await User.findById(toUserId);
      if (!recipient) {
        return res.status(404).json({ message: 'Príjemca nenájdený' });
      }

      // Cannot send to yourself
      if (toUserId === req.user.id.toString()) {
        return res.status(400).json({ message: 'Nemôžete poslať odkaz sami sebe' });
      }

      // Build attachment if file uploaded
      let attachment = null;
      if (req.file) {
        const quotaError = await messageStorageQuotaError(req, req.file.size);
        if (quotaError) return res.status(403).json(quotaError);
        attachment = await persistUpload(req.file);
        uncommittedKey = attachment.r2Key || null;
      }

      const message = new Message({
        workspaceId: req.workspaceId,
        fromUserId: req.user.id,
        fromUsername: req.user.username,
        toUserId: recipient._id,
        toUsername: recipient.username,
        type,
        subject: subject.trim().substring(0, 200),
        description: (description || '').trim().substring(0, 5000),
        attachment,
        linkedType: linkedType || null,
        linkedId: linkedId || null,
        linkedName: linkedName || null,
        dueDate: dueDate || null,
        pollOptions: type === 'poll' ? parsedPollOptions : [],
        pollMultipleChoice: type === 'poll' ? pollMultipleChoice : false,
        status: 'pending'
      });

      await message.save();
      uncommittedKey = null;

      // Send notification to recipient
      const typeLabel = typeLabels[type] || type;
      try {
        await notificationService.createNotification({
          userId: recipient._id.toString(),
          workspaceId: req.workspaceId,
          type: 'message.created',
          title: `📨 Nový odkaz: ${typeLabel}`,
          message: `${req.user.username} vám poslal odkaz "${subject}"`,
          actorName: req.user.username,
          relatedType: 'message',
          relatedId: message._id.toString(),
          relatedName: subject,
          data: { messageId: message._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
        });
      } catch (notifErr) {
        logger.warn('Message notification failed', { error: notifErr.message });
      }

      // Emit socket event
      const io = req.app.get('io');
      if (io) {
        io.to(`user-${recipient._id.toString()}`).emit('message-created', {
          id: message._id.toString(),
          fromUsername: req.user.username,
          type,
          subject,
          status: 'pending'
        });
      }

      res.status(201).json(stripAttachmentData(message));

      // Audit log (fire and forget)
      auditService.logAction({
        userId: req.user.id,
        username: req.user.username,
        email: req.user.email,
        action: 'message.created',
        category: 'message',
        targetType: 'message',
        targetId: message._id.toString(),
        targetName: subject,
        details: { subject, recipient: recipient.username, type },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        workspaceId: req.workspaceId || null
      });
    } catch (error) {
      if (uncommittedKey) deleteBlobs([uncommittedKey]);
      handleMessageWriteError(error, req, res, 'Create message error');
    }
  });
});

// PUT /api/messages/:id — edit message (only sender can edit)
router.put('/:id', authenticateToken, requireWorkspace, (req, res) => {
  upload.single('attachment')(req, res, async (err) => {
    if (err) return respondUploadError(err, req, res);

    let uncommittedKey = null; // nový blob v R2 pred úspešným save()
    try {
      const message = await Message.findOne({
        _id: req.params.id,
        workspaceId: req.workspaceId,
        fromUserId: req.user.id
      });

      if (!message) {
        return res.status(404).json({ message: 'Odkaz nenájdený' });
      }

      // Update allowed fields
      const { subject, description, type, dueDate, linkedType, linkedId, linkedName, removeAttachment } = req.body;

      if (subject !== undefined) message.subject = subject.trim().substring(0, 200);
      if (description !== undefined) message.description = description.trim().substring(0, 5000);
      if (type !== undefined && ['approval', 'info', 'request', 'proposal', 'poll'].includes(type)) message.type = type;
      if (dueDate !== undefined) message.dueDate = dueDate || null;
      if (linkedType !== undefined) {
        message.linkedType = linkedType || null;
        message.linkedId = linkedId || null;
        message.linkedName = linkedName || null;
      }

      // Handle attachment: new file replaces old, or remove existing.
      // Starý blob v R2 sa maže až PO úspešnom save() — keby zápis zlyhal,
      // pôvodná príloha musí ostať funkčná.
      let replacedKey = null;
      if (req.file) {
        const quotaError = await messageStorageQuotaError(req, req.file.size);
        if (quotaError) return res.status(403).json(quotaError);
        // Stará príloha sa nahrádza → do odhadu ju nerátame.
        if (wouldExceedMessageDocLimit(message, req.file.size, { skipLegacyAttachment: true })) {
          return rejectTooLarge(res);
        }
        replacedKey = message.attachment?.r2Key || null;
        // persistUpload dáva nové id pri KAŽDEJ výmene = nová verzia v URL
        // (?v=) aj ETagu. Bez neho klient rok zobrazoval pôvodný súbor z cache.
        message.attachment = await persistUpload(req.file);
        uncommittedKey = message.attachment.r2Key || null;
      } else if (removeAttachment === 'true') {
        replacedKey = message.attachment?.r2Key || null;
        message.attachment = undefined;
      }

      await message.save();
      uncommittedKey = null;
      if (replacedKey) deleteBlobs([replacedKey]);

      // Notify recipient about edit
      const io = req.app.get('io');
      if (io) {
        io.to(`user-${message.toUserId.toString()}`).emit('message-updated', {
          id: message._id.toString(),
          status: message.status
        });
      }

      res.json(stripAttachmentData(message));
    } catch (error) {
      if (uncommittedKey) deleteBlobs([uncommittedKey]);
      handleMessageWriteError(error, req, res, 'Edit message error');
    }
  });
});

// PUT /api/messages/:id/approve — approve message (recipient or workspace admin)
router.put('/:id/approve', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const query = {
      _id: req.params.id,
      workspaceId: req.workspaceId,
      status: { $in: ['pending', 'commented'] }
    };
    // Recipient can always approve; admin/manager can too
    const isAdmin = req.workspaceMember.canAdmin();
    if (!isAdmin) {
      query.toUserId = req.user.id;
    }

    const message = await Message.findOne(query);

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený alebo už bol vybavený' });
    }

    message.status = 'approved';
    message.resolvedBy = req.user.id;
    message.resolvedAt = new Date();
    await message.save();

    // Notify sender
    try {
      await notificationService.createNotification({
        userId: message.fromUserId.toString(),
        workspaceId: req.workspaceId,
        type: 'message.approved',
        title: '✅ Odkaz schválený',
        message: `${req.user.username} schválil váš odkaz "${message.subject}"`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: message._id.toString(),
        relatedName: message.subject,
        data: { messageId: message._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
      });
    } catch (notifErr) {
      logger.warn('Approve notification failed', { error: notifErr.message });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.fromUserId.toString()}`).emit('message-updated', {
        id: message._id.toString(),
        status: 'approved'
      });
    }

    res.json(stripAttachmentData(message));

    // Audit log (fire and forget)
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'message.approved',
      category: 'message',
      targetType: 'message',
      targetId: message._id.toString(),
      targetName: message.subject,
      details: { subject: message.subject },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// PUT /api/messages/:id/reject — reject message (recipient or workspace admin)
router.put('/:id/reject', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { reason } = req.body;

    const query = {
      _id: req.params.id,
      workspaceId: req.workspaceId,
      status: { $in: ['pending', 'commented'] }
    };
    const isAdmin = req.workspaceMember.canAdmin();
    if (!isAdmin) {
      query.toUserId = req.user.id;
    }

    const message = await Message.findOne(query);

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený alebo už bol vybavený' });
    }

    message.status = 'rejected';
    message.rejectionReason = (reason || '').trim().substring(0, 1000);
    message.resolvedBy = req.user.id;
    message.resolvedAt = new Date();
    await message.save();

    // Notify sender
    try {
      await notificationService.createNotification({
        userId: message.fromUserId.toString(),
        workspaceId: req.workspaceId,
        type: 'message.rejected',
        title: '❌ Odkaz zamietnutý',
        message: `${req.user.username} zamietol váš odkaz "${message.subject}"${reason ? ` — ${reason}` : ''}`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: message._id.toString(),
        relatedName: message.subject,
        data: { messageId: message._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
      });
    } catch (notifErr) {
      logger.warn('Reject notification failed', { error: notifErr.message });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.fromUserId.toString()}`).emit('message-updated', {
        id: message._id.toString(),
        status: 'rejected'
      });
    }

    res.json(stripAttachmentData(message));

    // Audit log (fire and forget)
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'message.rejected',
      category: 'message',
      targetType: 'message',
      targetId: message._id.toString(),
      targetName: message.subject,
      details: { subject: message.subject, reason: message.rejectionReason },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// PUT /api/messages/:id/reopen — revert approval/rejection back to pending/commented
router.put('/:id/reopen', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      status: { $in: ['approved', 'rejected'] }
    });

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený alebo nie je schválený/zamietnutý' });
    }

    // Only workspace admin (owner/manager) or the recipient can reopen
    const isAdmin = req.workspaceMember.canAdmin();
    const isRecipient = message.toUserId.toString() === req.user.id.toString();
    if (!isAdmin && !isRecipient) {
      return res.status(403).json({ message: 'Nemáte oprávnenie zrušiť rozhodnutie' });
    }

    const previousStatus = message.status;
    // If there are comments, set to 'commented', otherwise 'pending'
    message.status = message.comments?.length > 0 ? 'commented' : 'pending';
    message.resolvedBy = null;
    message.resolvedAt = null;
    message.rejectionReason = '';
    // Clear readBy so it shows as unread again
    message.readBy = [];
    await message.save();

    // Notify both parties
    const otherUserId = message.fromUserId.toString() === req.user.id.toString()
      ? message.toUserId.toString()
      : message.fromUserId.toString();

    try {
      await notificationService.createNotification({
        userId: otherUserId,
        workspaceId: req.workspaceId,
        type: 'message.created',
        title: '🔄 Rozhodnutie zrušené',
        message: `${req.user.username} zrušil ${previousStatus === 'approved' ? 'schválenie' : 'zamietnutie'} odkazu "${message.subject}"`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: message._id.toString(),
        relatedName: message.subject,
        data: { messageId: message._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
      });
    } catch (notifErr) {
      logger.warn('Reopen notification failed', { error: notifErr.message });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.fromUserId.toString()}`).emit('message-updated', {
        id: message._id.toString(), status: message.status
      });
      io.to(`user-${message.toUserId.toString()}`).emit('message-updated', {
        id: message._id.toString(), status: message.status
      });
    }

    res.json(stripAttachmentData(message));

    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'message.reopened',
      category: 'message',
      targetType: 'message',
      targetId: message._id.toString(),
      targetName: message.subject,
      details: { subject: message.subject, previousStatus },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    logger.error('Reopen message error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/messages/:id/vote — vote on a poll option
router.post('/:id/vote', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { optionId } = req.body;

    if (!optionId) {
      return res.status(400).json({ message: 'optionId je povinný' });
    }

    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      type: 'poll',
      $or: [
        { fromUserId: req.user.id },
        { toUserId: req.user.id }
      ]
    });

    if (!message) {
      return res.status(404).json({ message: 'Anketa nenájdená' });
    }

    const option = message.pollOptions.id(optionId);
    if (!option) {
      return res.status(404).json({ message: 'Možnosť nenájdená' });
    }

    const userId = req.user.id.toString();

    if (message.pollMultipleChoice) {
      // Toggle vote on this option
      const existingVoteIdx = option.votes.findIndex(v => v.userId.toString() === userId);
      if (existingVoteIdx >= 0) {
        option.votes.splice(existingVoteIdx, 1);
      } else {
        option.votes.push({ userId: req.user.id, username: req.user.username });
      }
    } else {
      // Single choice — remove vote from all options, then add to selected
      const alreadyVotedHere = option.votes.some(v => v.userId.toString() === userId);
      for (const opt of message.pollOptions) {
        opt.votes = opt.votes.filter(v => v.userId.toString() !== userId);
      }
      if (!alreadyVotedHere) {
        option.votes.push({ userId: req.user.id, username: req.user.username });
      }
    }

    await message.save();

    // Notify the other party
    const notifyUserId = message.fromUserId.toString() === userId
      ? message.toUserId.toString()
      : message.fromUserId.toString();

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${notifyUserId}`).emit('message-updated', {
        id: message._id.toString(),
        status: message.status
      });
    }

    res.json(stripAttachmentData(message));
  } catch (error) {
    logger.error('Vote error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/messages/:id/comment — add comment (with optional attachment)
router.post('/:id/comment', authenticateToken, requireWorkspace, (req, res) => {
  upload.single('attachment')(req, res, async (err) => {
    if (err) return respondUploadError(err, req, res);

    let uncommittedKey = null; // blob v R2 pred úspešným updateOne
    try {
      const { text } = req.body;

      if (!text || !text.trim()) {
        return res.status(400).json({ message: 'Text komentára je povinný' });
      }

      // PERF: load only metadata fields (NO Base64) for authorization +
      // status-transition decision. Full message was previously pulled,
      // mutated, and re-saved → rewrote every Base64 blob.
      const meta = await Message.findOne(
        {
          _id: req.params.id,
          workspaceId: req.workspaceId,
          $or: [
            { fromUserId: req.user.id },
            { toUserId: req.user.id }
          ]
        },
        {
          fromUserId: 1, toUserId: 1, status: 1, subject: 1,
          // Len veľkosti + r2Key príloh (bez base64) pre odhad 16 MB stropu —
          // r2Key rozhoduje, ktoré prílohy sú ešte inline.
          'attachment.size': 1, 'files.size': 1, 'comments.attachment.size': 1,
          ...R2_KEY_PROJECTION
        }
      ).lean();

      if (!meta) {
        return res.status(404).json({ message: 'Odkaz nenájdený' });
      }

      if (req.file) {
        const quotaError = await messageStorageQuotaError(req, req.file.size);
        if (quotaError) return res.status(403).json(quotaError);
        if (wouldExceedMessageDocLimit(meta, req.file.size)) return rejectTooLarge(res);
      }

      const comment = {
        _id: new mongoose.Types.ObjectId(),
        userId: req.user.id,
        username: req.user.username,
        text: text.trim().substring(0, 2000),
        createdAt: new Date()
      };

      // Attach file if uploaded (s id — potrebuje ho R2 kľúč aj klient)
      if (req.file) {
        comment.attachment = await persistUpload(req.file);
        uncommittedKey = comment.attachment.r2Key || null;
      }

      // Atomic $push — only the new comment is sent over the wire.
      const update = { $push: { comments: comment } };
      const shouldTransition =
        meta.toUserId.toString() === req.user.id.toString() &&
        meta.status === 'pending';
      if (shouldTransition) {
        update.$set = { status: 'commented' };
      }

      await Message.updateOne({ _id: meta._id }, update);
      uncommittedKey = null;

      // Notify the other party
      const notifyUserId = meta.fromUserId.toString() === req.user.id.toString()
        ? meta.toUserId.toString()
        : meta.fromUserId.toString();

      // Fire-and-forget notification (see notificationService setImmediate)
      notificationService.createNotification({
        userId: notifyUserId,
        workspaceId: req.workspaceId,
        type: 'message.commented',
        title: '💬 Nový komentár',
        message: `${req.user.username} komentoval odkaz "${meta.subject}"`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: meta._id.toString(),
        relatedName: meta.subject,
        data: { messageId: meta._id.toString(), commentId: comment._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
      }).catch(notifErr => {
        logger.warn('Comment notification failed', { error: notifErr.message });
      });

      const io = req.app.get('io');
      if (io) {
        io.to(`user-${notifyUserId}`).emit('message-updated', {
          id: meta._id.toString(),
          status: shouldTransition ? 'commented' : meta.status
        });
      }

      // Return updated message WITHOUT re-fetching Base64 blobs.
      const updated = await Message.findById(meta._id, NO_BASE64_PROJECTION).lean();
      res.json(stripAttachmentData(updated));
    } catch (error) {
      if (uncommittedKey) deleteBlobs([uncommittedKey]);
      handleMessageWriteError(error, req, res, 'Add comment error');
    }
  });
});

// PUT /api/messages/:id/comment/:commentId — edit comment (only author)
router.put('/:id/comment/:commentId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Text komentára je povinný' });
    }

    // PERF: atomic $set on the matched comment — no full doc save.
    // Authorship + workspace + membership enforced via filter.
    const newText = text.trim().substring(0, 2000);
    const result = await Message.updateOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ],
        comments: {
          $elemMatch: { _id: req.params.commentId, userId: req.user.id }
        }
      },
      { $set: { 'comments.$.text': newText } }
    );

    if (result.matchedCount === 0) {
      // Either message not found, comment not found, or user not author.
      return res.status(404).json({ message: 'Komentár nenájdený alebo nie ste autor' });
    }

    // Fetch minimal metadata for socket + response (no Base64).
    const updated = await Message.findById(req.params.id, NO_BASE64_PROJECTION).lean();

    // Notify the other party
    const notifyUserId = updated.fromUserId.toString() === req.user.id.toString()
      ? updated.toUserId.toString()
      : updated.fromUserId.toString();

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${notifyUserId}`).emit('message-updated', {
        id: updated._id.toString(),
        status: updated.status
      });
    }

    res.json(stripAttachmentData(updated));
  } catch (error) {
    logger.error('Edit comment error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// DELETE /api/messages/:id/comment/:commentId — delete comment (only author)
router.delete('/:id/comment/:commentId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // R2 kľúč prílohy komentára treba prečítať PRED $pull — po ňom už niet
    // odkiaľ. Rovnaký filter (vrátane autorstva) ako samotný $pull.
    const pre = await Message.findOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ],
        comments: { $elemMatch: { _id: req.params.commentId, userId: req.user.id } }
      },
      { comments: { $elemMatch: { _id: req.params.commentId } } }
    ).lean();
    const commentBlobKey = pre?.comments?.[0]?.attachment?.r2Key || null;

    // PERF: atomic $pull with authorship check in filter. No full doc save.
    const pullResult = await Message.updateOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ],
        comments: {
          $elemMatch: { _id: req.params.commentId, userId: req.user.id }
        }
      },
      { $pull: { comments: { _id: req.params.commentId } } }
    );

    if (pullResult.matchedCount === 0) {
      return res.status(404).json({ message: 'Komentár nenájdený alebo nie ste autor' });
    }
    if (commentBlobKey) deleteBlobs([commentBlobKey]);

    // If status was 'commented' and no comments remain, revert to 'pending'.
    // Use conditional update — only fires if condition is met, no re-save.
    await Message.updateOne(
      {
        _id: req.params.id,
        status: 'commented',
        comments: { $size: 0 }
      },
      { $set: { status: 'pending' } }
    );

    // Fetch minimal metadata for response + socket (no Base64).
    const updated = await Message.findById(req.params.id, NO_BASE64_PROJECTION).lean();

    const notifyUserId = updated.fromUserId.toString() === req.user.id.toString()
      ? updated.toUserId.toString()
      : updated.fromUserId.toString();

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${notifyUserId}`).emit('message-updated', {
        id: updated._id.toString(),
        status: updated.status
      });
    }

    res.json(stripAttachmentData(updated));
  } catch (error) {
    logger.error('Delete comment error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/messages/:id/comment/:commentId/reaction
// Toggle like/dislike reakcie na komentári.
// Body: { type: 'like' | 'dislike' | null }
//  - null alebo rovnaký typ ako existujúca reakcia → odstránenie (toggle off)
//  - iný typ → prepnutie (remove + add)
//  - nový → pridanie
// Reakciu môže pridať iba user, ktorý je sender alebo recipient odkazu
// (workspace guard). Autor komentára nedostane notifikáciu za vlastnú reakciu.
router.post('/:id/comment/:commentId/reaction', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { type } = req.body;
    if (type !== null && type !== 'like' && type !== 'dislike') {
      return res.status(400).json({ message: 'Neplatný typ reakcie' });
    }

    // Overenie prístupu + získanie autora komentára pre notifikáciu.
    // Načítame len metadata (žiadny Base64) + konkrétny komentár cez
    // $elemMatch projection.
    const meta = await Message.findOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ],
        'comments._id': req.params.commentId
      },
      {
        fromUserId: 1,
        toUserId: 1,
        subject: 1,
        'comments.$': 1
      }
    ).lean();

    if (!meta || !meta.comments || meta.comments.length === 0) {
      return res.status(404).json({ message: 'Komentár nenájdený' });
    }

    const comment = meta.comments[0];
    const existingReaction = (comment.reactions || []).find(
      r => r.userId.toString() === req.user.id.toString()
    );
    const existingType = existingReaction?.type || null;

    // Vyriešime výslednú reakciu:
    //  - ak klikol na rovnaký typ ako má, alebo poslal null → odstránime
    //  - inak nastavíme nový typ (add alebo change)
    const finalType = (type === null || type === existingType) ? null : type;

    // Vždy najprv vypadnúť existujúcu reakciu tohto usera (atomic $pull),
    // aby sme zachovali invariant "max 1 reakcia per user per komentár".
    if (existingReaction) {
      await Message.updateOne(
        { _id: meta._id, 'comments._id': req.params.commentId },
        { $pull: { 'comments.$.reactions': { userId: req.user.id } } }
      );
    }

    // Ak výsledný stav je reakcia (nie odstránenie), pridáme novú.
    if (finalType) {
      await Message.updateOne(
        { _id: meta._id, 'comments._id': req.params.commentId },
        {
          $push: {
            'comments.$.reactions': {
              userId: req.user.id,
              username: req.user.username,
              type: finalType,
              createdAt: new Date()
            }
          }
        }
      );
    }

    // Notifikácia len ak je to nová alebo zmenená reakcia (nie remove),
    // a len ak reagoval niekto iný ako autor komentára.
    const commentAuthorId = comment.userId.toString();
    const shouldNotify = finalType && commentAuthorId !== req.user.id.toString();

    if (shouldNotify) {
      const emoji = finalType === 'like' ? '👍' : '👎';
      const label = finalType === 'like' ? 'páči' : 'nepáči';
      const preview = (comment.text || '').trim().substring(0, 60);
      notificationService.createNotification({
        userId: commentAuthorId,
        workspaceId: req.workspaceId,
        type: 'message.comment.reacted',
        title: `${emoji} Reakcia na komentár`,
        message: `${req.user.username} reagoval "${label}" na váš komentár v odkaze "${meta.subject}"${preview ? `: "${preview}${comment.text.length > 60 ? '…' : ''}"` : ''}`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: meta._id.toString(),
        relatedName: meta.subject,
        data: {
          messageId: meta._id.toString(),
          commentId: req.params.commentId,
          reactionType: finalType,
          workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined
        }
      }).catch(notifErr => {
        logger.warn('Reaction notification failed', { error: notifErr.message });
      });
    }

    // Refetch dokumentu (bez Base64) a socket emit na oboch účastníkov,
    // aby sa UI okamžite aktualizovalo na druhej strane.
    const updated = await Message.findById(meta._id, NO_BASE64_PROJECTION).lean();
    const io = req.app.get('io');
    if (io) {
      const otherUserId = meta.fromUserId.toString() === req.user.id.toString()
        ? meta.toUserId.toString()
        : meta.fromUserId.toString();
      io.to(`user-${otherUserId}`).emit('message-updated', {
        id: meta._id.toString(),
        status: updated.status
      });
    }

    res.json(stripAttachmentData(updated));
  } catch (error) {
    logger.error('Comment reaction error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/:id/attachment — download attachment
router.get('/:id/attachment', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return res.status(404).json({ message: 'Príloha nenájdená' });
    }
    const filter = {
      _id: req.params.id,
      workspaceId: req.workspaceId,
      $or: [
        { fromUserId: req.user.id },
        { toUserId: req.user.id }
      ]
    };

    // Legacy príloha sa dá v úprave správy NAHRADIŤ na mieste, takže ETag
    // aj cache musia niesť jej verziu (attachment.id), nie len id správy —
    // inak prehliadač/WKWebView rok vracal pôvodný súbor. Najprv lacný
    // dotaz len na metadáta (bez base64): opakovaný náhľad → 304 bez
    // ťahania megabajtov z Monga.
    const meta = await Message.findOne(filter, {
      'attachment.id': 1, 'attachment.uploadedAt': 1, 'attachment.size': 1,
      'attachment.originalName': 1, 'attachment.mimetype': 1, 'attachment.r2Key': 1
    }).lean();
    if (!meta || !meta.attachment) {
      return res.status(404).json({ message: 'Príloha nenájdená' });
    }

    // Immutable len keď klient pýta presne aktuálnu verziu (?v=). Bez v
    // (staršia verzia appky) alebo so zastaranou v → no-cache, aby sa
    // pod touto URL neuložila stará/nová verzia natrvalo.
    const cacheFor = (version) => {
      const requested = typeof req.query.v === 'string' ? req.query.v : '';
      return requested && requested === version
        ? 'private, max-age=31536000, immutable'
        : 'private, no-cache';
    };

    const metaVersion = attachmentVersion(meta.attachment);
    const metaEtag = `"msg-att-${metaVersion}"`;
    if (req.headers['if-none-match'] === metaEtag) {
      res.set({ 'ETag': metaEtag, 'Cache-Control': cacheFor(metaVersion) });
      return res.status(304).end();
    }

    // R2 príloha: metadáta už máme, base64 z Monga netreba.
    if (meta.attachment.r2Key) {
      return await sendStoredAttachment(res, meta.attachment, {
        'Cache-Control': cacheFor(metaVersion),
        'ETag': metaEtag
      });
    }

    // Legacy inline: PERF — project only the main attachment, do NOT pull
    // comments[].attachment.data or files[].data. A message with 5 other 10 MB
    // attachments was previously shipping 50+ MB from Mongo to return one file.
    const message = await Message.findOne(filter, { attachment: 1 }).lean();

    if (!message || !message.attachment || !(message.attachment.data || message.attachment.r2Key)) {
      return res.status(404).json({ message: 'Príloha nenájdená' });
    }

    // Verziu počítame z dokumentu, ktorého bajty naozaj posielame (príloha
    // sa medzi dvoma dotazmi mohla vymeniť).
    const version = attachmentVersion(message.attachment);
    return await sendStoredAttachment(res, message.attachment, {
      'Cache-Control': cacheFor(version),
      'ETag': `"msg-att-${version}"`
    });
  } catch (error) {
    logger.error('Message attachment download error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/:id/comment/:commentId/attachment — download comment attachment
router.get('/:id/comment/:commentId/attachment', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const etag = `"cmt-${req.params.commentId}-attach"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // PERF: $elemMatch projection returns ONLY the matching comment, not
    // the whole comments array. Main attachment + files are excluded entirely.
    const message = await Message.findOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ]
      },
      { comments: { $elemMatch: { _id: req.params.commentId } } }
    ).lean();

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený' });
    }

    const comment = message.comments && message.comments[0];
    if (!comment || !comment.attachment || !(comment.attachment.r2Key || comment.attachment.data)) {
      return res.status(404).json({ message: 'Príloha nenájdená' });
    }

    // Príloha komentára sa nedá vymeniť (PUT komentára mení len text),
    // takže ETag podľa commentId ostáva nemenný.
    return await sendStoredAttachment(res, comment.attachment, {
      'Cache-Control': 'private, max-age=31536000, immutable',
      'ETag': etag
    });
  } catch (error) {
    logger.error('Comment attachment download error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─── FILE ATTACHMENTS (same pattern as Tasks) ─────────────────

// POST /api/messages/:id/files — add file to message
router.post('/:id/files', authenticateToken, requireWorkspace, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return respondUploadError(err, req, res);
    if (!req.file) return res.status(400).json({ message: 'Žiadny súbor' });

    let uncommittedKey = null; // blob v R2 pred úspešným save()
    try {
      const message = await Message.findOne({
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [{ fromUserId: req.user.id }, { toUserId: req.user.id }]
      });
      if (!message) return res.status(404).json({ message: 'Odkaz nenájdený' });

      const quotaError = await messageStorageQuotaError(req, req.file.size);
      if (quotaError) return res.status(403).json(quotaError);
      if (wouldExceedMessageDocLimit(message, req.file.size)) {
        return rejectTooLarge(res);
      }

      const stored = await persistUpload(req.file);
      uncommittedKey = stored.r2Key || null;
      message.files.push(stored);

      await message.save();
      uncommittedKey = null;
      res.json(stripAttachmentData(message));
    } catch (error) {
      if (uncommittedKey) deleteBlobs([uncommittedKey]);
      handleMessageWriteError(error, req, res, 'Add message file error');
    }
  });
});

// GET /api/messages/:id/files/:fileId/download — download file
router.get('/:id/files/:fileId/download', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const etag = `"file-${req.params.fileId}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // PERF: $elemMatch projection — return only the matching file, not
    // the whole files array nor any comment attachments.
    const message = await Message.findOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [{ fromUserId: req.user.id }, { toUserId: req.user.id }]
      },
      { files: { $elemMatch: { id: req.params.fileId } } }
    ).lean();
    if (!message) return res.status(404).json({ message: 'Odkaz nenájdený' });

    const file = message.files && message.files[0];
    if (!file || !(file.r2Key || file.data)) return res.status(404).json({ message: 'Súbor nenájdený' });

    // files[] majú pri každom nahraní nové id — obsah pod ním sa nemení.
    return await sendStoredAttachment(res, file, {
      'Cache-Control': 'private, max-age=31536000, immutable',
      'ETag': etag
    });
  } catch (error) {
    logger.error('Message file download error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// DELETE /api/messages/:id/files/:fileId — delete file from message
router.delete('/:id/files/:fileId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      $or: [{ fromUserId: req.user.id }, { toUserId: req.user.id }]
    });
    if (!message) return res.status(404).json({ message: 'Odkaz nenájdený' });

    const removed = (message.files || []).find(f => f.id === req.params.fileId);
    message.files = message.files.filter(f => f.id !== req.params.fileId);
    await message.save();
    // Blob v R2 až po uložení metadát — keby save() zlyhal, súbor ostane.
    if (removed?.r2Key) deleteBlobs([removed.r2Key]);
    res.json(stripAttachmentData(message));
  } catch (error) {
    logger.error('Delete message file error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// DELETE /api/messages/:id — sender or workspace owner/manager can delete
router.delete('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Len to, čo treba: odosielateľ/príjemca + R2 kľúče príloh (bez base64
    // a bez textu) — bloby sa mažú po deleteOne.
    const message = await Message.findOne(
      { _id: req.params.id, workspaceId: req.workspaceId },
      { fromUserId: 1, toUserId: 1, ...R2_KEY_PROJECTION }
    ).lean();

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený' });
    }

    const isSender = message.fromUserId.toString() === req.user.id;
    const isAdmin = req.workspaceMember.canAdmin();

    if (!isSender && !isAdmin) {
      return res.status(403).json({ message: 'Nemáte oprávnenie vymazať tento odkaz' });
    }

    await Message.deleteOne({ _id: req.params.id });
    // Metadáta sú preč → bloby v R2 (best-effort, fire-and-forget)
    deleteBlobs(collectMessageR2Keys(message));

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.toUserId.toString()}`).emit('message-deleted', {
        id: req.params.id
      });
      if (!isSender) {
        io.to(`user-${message.fromUserId.toString()}`).emit('message-deleted', {
          id: req.params.id
        });
      }
    }

    res.json({ message: 'Odkaz bol vymazaný' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
