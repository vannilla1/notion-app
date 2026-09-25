/**
 * storageQuota.js — spoločná plánová storage kvóta pre uploady a kópie príloh.
 *
 * Kvóta (Tím = 1 GB, Pro = 10 GB na workspace) sa počíta z METADÁT
 * (files[].size) naprieč celým workspace-om: prílohy kontaktov
 * (contact.files) + prílohy taskov/subtaskov embedded v contact.tasks
 * + prílohy globálnych Task dokumentov + prílohy správ (legacy attachment,
 * files[], prílohy komentárov). Historicky sa počítali len contact.files —
 * prílohy úloh boli úplne mimo kvóty (diera: cez 📎 pri úlohe sa dala kvóta
 * obísť); prílohy správ pribudli s presunom do R2 (dovtedy žili base64 v
 * Mongo dokumente a kvóta úložiska sa ich netýkala).
 *
 * Base64 `data` polia legacy súborov sa explicitne vylučujú projekciou —
 * bez toho by kvótový prepočet ťahal z Mongo megabajty blobov.
 */
const Contact = require('../models/Contact');
const Task = require('../models/Task');
const Message = require('../models/Message');

const STORAGE_LIMITS = { team: 1024 * 1024 * 1024, pro: 10 * 1024 * 1024 * 1024 };

// Rovnaká hĺbka vylúčení ako EXCLUDE_FILE_DATA v routes (5 úrovní vnorenia)
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
// Správy: inkluzívna projekcia len na veľkosti — nikdy base64 ani text
// správ/komentárov (súkromná komunikácia členov tímu).
const MESSAGE_SIZES = {
  'attachment.size': 1,
  'files.size': 1,
  'comments.attachment.size': 1
};

// Rekurzívny súčet files[].size v uzle + celom strome jeho subtaskov
const sumNodeFileBytes = (node) => {
  let sum = ((node && node.files) || []).reduce((s, f) => s + (f.size || 0), 0);
  for (const sub of ((node && node.subtasks) || [])) sum += sumNodeFileBytes(sub);
  return sum;
};

// Súčet veľkostí všetkých príloh jednej správy (legacy + files + komentáre)
const sumMessageFileBytes = (msg) => {
  let sum = (msg && msg.attachment && msg.attachment.size) || 0;
  sum += ((msg && msg.files) || []).reduce((s, f) => s + (f.size || 0), 0);
  for (const c of ((msg && msg.comments) || [])) sum += (c && c.attachment && c.attachment.size) || 0;
  return sum;
};

// Celkové využitie workspace-u v bajtoch (kontakty + ich tasky + globálne
// Tasky + prílohy správ)
const computeWorkspaceFileBytes = async (workspaceId) => {
  const [contacts, tasks, messages] = await Promise.all([
    Contact.find({ workspaceId }, CONTACT_EXCLUDE).lean(),
    Task.find({ workspaceId }, TASK_EXCLUDE).lean(),
    Message.find({ workspaceId }, MESSAGE_SIZES).lean()
  ]);
  let sum = 0;
  for (const c of contacts) {
    sum += (c.files || []).reduce((s, f) => s + (f.size || 0), 0);
    for (const t of (c.tasks || [])) sum += sumNodeFileBytes(t);
  }
  for (const t of tasks) sum += sumNodeFileBytes(t);
  for (const m of messages) sum += sumMessageFileBytes(m);
  return sum;
};

module.exports = { STORAGE_LIMITS, computeWorkspaceFileBytes, sumNodeFileBytes, sumMessageFileBytes };
