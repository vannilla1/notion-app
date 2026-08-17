/**
 * attachments.js — prehľad príloh workspace-u + hromadné stiahnutie ako ZIP.
 *
 * Prečo dvojkrokový flow (POST pripraví → GET stiahne):
 * Sťahovanie musí ísť ako obyčajná navigácia prehliadača, nie ako axios
 * request — axios má 60 s timeout a blob odpovede sa neopakujú, takže veľký
 * ZIP by spoľahlivo padal. Navigácia ale neposiela Authorization hlavičku
 * (JWT-only auth, žiadna cookie), preto POST vytvorí jednorazový job
 * s náhodným 256-bitovým tokenom a GET sa autorizuje ním.
 *
 * ZIP sa STREAMUJE: archiver ťahá súbory z R2 po jednom a rovno ich posiela
 * do odpovede. Pamäť inštancie tak zostáva plochá bez ohľadu na to, či ide
 * o 5 alebo 500 súborov (Render Starter má 512 MB).
 */
const express = require('express');
const crypto = require('crypto');
const archiver = require('archiver');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace } = require('../middleware/workspace');
const ContactFile = require('../models/ContactFile');
const fileStorage = require('../services/fileStorage');
const { listWorkspaceAttachments } = require('../utils/attachmentIndex');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');
const { recordError } = require('../services/serverErrorService');

// Strop jedného ZIP-u — zrkadlí existujúci limit hromadného kopírovania
// (TRANSFER_MAX_COPY_BYTES). Nad tým UI vypíše „rozdeľte výber".
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_FILES = 500;
const JOB_TTL_MS = 15 * 60 * 1000;

// In-memory jednorazové joby. Reštart Renderu ich stratí — používateľ dá
// stiahnuť znova (15 min TTL), takže perzistencia nemá zmysel.
const jobs = new Map();

const sweepJobs = () => {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.expiresAt < now) jobs.delete(id);
};

/** Bezpečný názov pre položku v ZIP-e (bez lomítok a riadiacich znakov). */
const safeName = (s, fallback = 'subor') => {
  const cleaned = String(s || '')
    .replace(/[/\\]/g, '-')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
};

/** Cesta v ZIP-e: Kontakt/Projekt/Podúloha/subor.pdf (unikátna pri kolízii). */
const zipPathFor = (entry, used) => {
  const parts = [];
  parts.push(safeName(entry.contactName, 'Bez kontaktu'));
  parts.push(entry.taskTitle ? safeName(entry.taskTitle, 'Projekt') : '_kontakt');
  for (const t of (entry.trail || [])) parts.push(safeName(t, 'Uloha'));
  const base = safeName(entry.name);
  let candidate = [...parts, base].join('/');
  if (used.has(candidate)) {
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let i = 2;
    while (used.has(candidate)) {
      candidate = [...parts, `${stem} (${i})${ext}`].join('/');
      i++;
    }
  }
  used.add(candidate);
  return candidate;
};

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ── Zoznam príloh workspace-u (pre stránku Prílohy) ──────────────────────
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const items = await listWorkspaceAttachments(req.workspaceId);
    res.json({
      items,
      totalBytes: items.reduce((s, i) => s + (i.size || 0), 0),
      limits: { maxZipBytes: MAX_ZIP_BYTES, maxZipFiles: MAX_ZIP_FILES }
    });
  } catch (error) {
    logger.error('[Attachments] Zoznam príloh zlyhal', { error: error.message });
    res.status(500).json({ message: 'Nepodarilo sa načítať prílohy' });
  }
});

// ── Príprava ZIP-u: overí výber, vráti jednorazový odkaz ─────────────────
// Body: { fileIds: [] }  ALEBO  { contactId } / { taskId } (rýchle tlačidlá)
router.post('/export', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { fileIds, contactId, taskId } = req.body || {};
    const all = await listWorkspaceAttachments(req.workspaceId);

    let selected;
    if (Array.isArray(fileIds) && fileIds.length > 0) {
      const wanted = new Set(fileIds.map(String));
      selected = all.filter(e => wanted.has(String(e.fileId)));
    } else if (contactId) {
      selected = all.filter(e => String(e.contactId) === String(contactId));
    } else if (taskId) {
      selected = all.filter(e => String(e.taskId) === String(taskId));
    } else {
      return res.status(400).json({ message: 'Nič nie je vybrané' });
    }

    if (selected.length === 0) {
      return res.status(404).json({ message: 'Vo výbere nie sú žiadne prílohy' });
    }
    if (selected.length > MAX_ZIP_FILES) {
      return res.status(413).json({
        message: `Naraz sa dá stiahnuť max. ${MAX_ZIP_FILES} príloh. Rozdeľte výber na menšie časti.`,
        code: 'ZIP_TOO_MANY'
      });
    }
    const totalBytes = selected.reduce((s, e) => s + (e.size || 0), 0);
    if (totalBytes > MAX_ZIP_BYTES) {
      const mb = Math.round(totalBytes / (1024 * 1024));
      const limitMb = Math.round(MAX_ZIP_BYTES / (1024 * 1024));
      return res.status(413).json({
        message: `Výber má ${mb} MB, maximum na jedno stiahnutie je ${limitMb} MB. Rozdeľte ho na menšie časti.`,
        code: 'ZIP_TOO_LARGE'
      });
    }

    sweepJobs();
    // 256 bitov entropie — token JE autorizácia (GET nemá hlavičky)
    const jobId = crypto.randomBytes(32).toString('hex');
    jobs.set(jobId, {
      workspaceId: String(req.workspaceId),
      userId: req.user.id,
      entries: selected,
      expiresAt: Date.now() + JOB_TTL_MS
    });

    res.json({
      downloadPath: `/api/attachments/export/${jobId}`,
      fileCount: selected.length,
      totalBytes,
      expiresInSec: Math.floor(JOB_TTL_MS / 1000)
    });
  } catch (error) {
    logger.error('[Attachments] Príprava ZIP zlyhala', { error: error.message });
    res.status(500).json({ message: 'Príprava sťahovania zlyhala' });
  }
});

// ── Stiahnutie ZIP-u (autorizácia jednorazovým tokenom v URL) ────────────
router.get('/export/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.expiresAt < Date.now()) {
    jobs.delete(req.params.jobId);
    // Sťahovanie beží ako navigácia — pri chybe by holý text nechal
    // používateľa na prázdnej stránke. Vraciame stránku s cestou späť.
    return res.status(404).type('html').send(
      '<!doctype html><meta charset="utf-8"><title>Odkaz vypršal</title>' +
      '<body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto">' +
      '<h2>Odkaz na stiahnutie vypršal</h2>' +
      '<p>Platnosť odkazu je 15 minút a dá sa použiť raz. Vráťte sa do aplikácie a spustite sťahovanie znova.</p>' +
      '<p><a href="javascript:history.back()">← Späť do aplikácie</a></p></body>'
    );
  }
  // Jednorazový — token v URL sa môže dostať do histórie prehliadača
  jobs.delete(req.params.jobId);

  const stamp = new Date().toISOString().slice(0, 10);
  const zipName = `prilohy-${stamp}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.setHeader('Cache-Control', 'no-store');

  const archive = archiver('zip', { zlib: { level: 1 } }); // level 1 — prílohy sú väčšinou už komprimované
  let failed = 0;

  archive.on('warning', (err) => logger.warn('[Attachments] ZIP warning', { error: err.message }));
  archive.on('error', (err) => {
    logger.error('[Attachments] ZIP stream zlyhal', { error: err.message });
    // Hlavičky sú dávno odoslané — jediné, čo sa dá, je prerušiť spojenie,
    // aby prehliadač označil súbor ako neúplný namiesto tichého orezania.
    res.destroy();
  });
  archive.pipe(res);
  // Klient zavrel kartu / zrušil sťahovanie — nedoťahuj zvyšok z R2
  res.on('close', () => { if (!res.writableEnded) archive.abort(); });

  try {
    const ids = job.entries.map(e => e.fileId);
    const blobs = await ContactFile.find({ fileId: { $in: ids } }).lean();
    const byId = new Map(blobs.map(b => [b.fileId, b]));
    const used = new Set();
    const manifest = ['Kontakt;Projekt;Úloha;Súbor;Veľkosť (B);Nahraté'];

    for (const entry of job.entries) {
      const rec = byId.get(entry.fileId);
      const path = zipPathFor(entry, used);
      manifest.push([
        csvCell(entry.contactName || ''),
        csvCell(entry.taskTitle || ''),
        csvCell((entry.trail || []).join(' / ')),
        csvCell(path),
        entry.size || 0,
        csvCell(entry.uploadedAt ? new Date(entry.uploadedAt).toISOString().slice(0, 10) : '')
      ].join(';'));

      try {
        if (rec && rec.r2Key && fileStorage.isR2Available()) {
          // Stream priamo z R2 do ZIP-u — súbor sa nikdy nedrží celý v RAM
          const stream = await fileStorage.getFileStream(rec.r2Key);
          archive.append(stream, { name: path });
        } else if (rec && rec.data) {
          archive.append(Buffer.from(rec.data, 'base64'), { name: path }); // legacy base64
        } else {
          failed++;
          logger.warn('[Attachments] Príloha bez obsahu — preskočená', { fileId: entry.fileId });
        }
      } catch (e) {
        failed++;
        logger.warn('[Attachments] Prílohu sa nepodarilo pridať do ZIP', { fileId: entry.fileId, error: e.message });
      }
    }

    if (failed > 0) {
      manifest.push('');
      manifest.push(`# ${failed} príloh sa nepodarilo pridať (chýbajúci obsah v úložisku)`);
    }
    archive.append('﻿' + manifest.join('\n'), { name: '_obsah.csv' });
    await archive.finalize();

    auditService.logAction({
      userId: job.userId,
      action: 'attachments.bulk_downloaded',
      category: 'file',
      targetType: 'attachments',
      targetName: `${job.entries.length} príloh`,
      details: { fileCount: job.entries.length, failed },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: job.workspaceId
    });
  } catch (error) {
    logger.error('[Attachments] ZIP export zlyhal', { error: error.message, stack: error.stack });
    recordError(error, req).catch(() => {});
    if (res.locals) res.locals.__errorRecorded = true;
    try { archive.abort(); } catch { /* už mohol skončiť */ }
    if (!res.headersSent) res.status(500).send('Export zlyhal');
    else res.destroy();
  }
});

module.exports = router;
