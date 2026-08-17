/**
 * attachmentIndex.js — jednotný zoznam VŠETKÝCH príloh workspace-u.
 *
 * Metadáta príloh žijú na štyroch miestach a strom podúloh nemá v schéme
 * obmedzenú hĺbku (úroveň 2+ je netypované pole), takže sa nedá zostaviť
 * aggregation s fixným počtom $unwind — strom sa prechádza rekurzívne
 * v Node, rovnako ako to už robí výpočet storage kvóty (utils/storageQuota).
 *
 * Zdroje:
 *  1. contact.files              — prílohy priamo pri kontakte
 *  2. contact.tasks[].files      — projekty kontaktu + celý strom podúloh
 *  3. Task.files (+ subtasks)    — globálne projekty, ku kontaktu viazané
 *                                  cez contactIds (dual-source, viď CLAUDE.md)
 *  4. Message.*                  — ZÁMERNE mimo: base64 v Mongu, iná
 *                                  autorizácia, iný download flow
 *
 * Blob sa NEDÁ dohľadať z ContactFile (nemá workspaceId, size ani názov) —
 * ContactFile je len resolver fileId → r2Key/data, dotiahne sa až pri ZIP-e.
 */
const Contact = require('../models/Contact');
const Task = require('../models/Task');

// Projekcie bez legacy base64 `data` — bez nich by výpis ťahal megabajty blobov
const CONTACT_EXCLUDE = {
  'files.data': 0,
  'tasks.files.data': 0,
  'tasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.subtasks.subtasks.files.data': 0
};
const TASK_EXCLUDE = {
  'files.data': 0,
  'subtasks.files.data': 0,
  'subtasks.subtasks.files.data': 0,
  'subtasks.subtasks.subtasks.files.data': 0,
  'subtasks.subtasks.subtasks.subtasks.files.data': 0
};

const toEntry = (f, ctx) => ({
  fileId: f.id,
  name: f.originalName || 'subor',
  mimetype: f.mimetype || 'application/octet-stream',
  size: f.size || 0,
  uploadedAt: f.uploadedAt || null,
  contactId: ctx.contactId,
  contactName: ctx.contactName,
  taskId: ctx.taskId,
  taskTitle: ctx.taskTitle,
  // Cesta vnorenia (názvy podúloh) — priečinky v ZIP-e a stĺpec v UI
  trail: ctx.trail || []
});

// Rekurzívny zber príloh uzla (projekt/podúloha) + celého jeho podstromu
const collectNodeFiles = (node, ctx, out) => {
  for (const f of (node.files || [])) {
    if (f && f.id) out.push(toEntry(f, ctx));
  }
  for (const sub of (node.subtasks || [])) {
    collectNodeFiles(sub, { ...ctx, trail: [...(ctx.trail || []), sub.title || 'Úloha'] }, out);
  }
};

/**
 * Zoznam príloh workspace-u. Vracia ploché pole položiek s kontextom
 * (kontakt / projekt / cesta podúloh) — klient si z toho robí filtre,
 * ZIP export z toho stavia priečinky.
 */
const listWorkspaceAttachments = async (workspaceId) => {
  const [contacts, globalTasks] = await Promise.all([
    Contact.find({ workspaceId }, CONTACT_EXCLUDE).lean(),
    Task.find({ workspaceId }, TASK_EXCLUDE).lean()
  ]);

  const out = [];

  for (const c of contacts) {
    const base = { contactId: String(c._id), contactName: c.name || 'Kontakt' };
    for (const f of (c.files || [])) {
      if (f && f.id) out.push(toEntry(f, { ...base, taskId: null, taskTitle: null }));
    }
    for (const t of (c.tasks || [])) {
      collectNodeFiles(t, { ...base, taskId: t.id, taskTitle: t.title || 'Projekt', trail: [] }, out);
    }
  }

  // Globálne projekty — ku kontaktu viazané cez contactIds. Meno kontaktu
  // doplníme z už načítaných kontaktov (bez ďalšieho dotazu).
  const contactNameById = new Map(contacts.map(c => [String(c._id), c.name || 'Kontakt']));
  for (const t of globalTasks) {
    const firstContactId = (t.contactIds || []).map(String).find(id => contactNameById.has(id)) || null;
    collectNodeFiles(t, {
      contactId: firstContactId,
      contactName: firstContactId ? contactNameById.get(firstContactId) : null,
      taskId: String(t._id),
      taskTitle: t.title || 'Projekt',
      trail: []
    }, out);
  }

  return out;
};

module.exports = { listWorkspaceAttachments };
