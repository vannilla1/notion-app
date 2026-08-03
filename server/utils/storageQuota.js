/**
 * storageQuota.js — spoločná plánová storage kvóta pre uploady a kópie príloh.
 *
 * Kvóta (Tím = 1 GB, Pro = 10 GB na workspace) sa počíta z METADÁT
 * (files[].size) naprieč celým workspace-om: prílohy kontaktov
 * (contact.files) + prílohy taskov/subtaskov embedded v contact.tasks
 * + prílohy globálnych Task dokumentov. Historicky sa počítali len
 * contact.files — prílohy úloh boli úplne mimo kvóty (diera: cez 📎 pri
 * úlohe sa dala kvóta obísť).
 *
 * Base64 `data` polia legacy súborov sa explicitne vylučujú projekciou —
 * bez toho by kvótový prepočet ťahal z Mongo megabajty blobov.
 */
const Contact = require('../models/Contact');
const Task = require('../models/Task');

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

// Rekurzívny súčet files[].size v uzle + celom strome jeho subtaskov
const sumNodeFileBytes = (node) => {
  let sum = ((node && node.files) || []).reduce((s, f) => s + (f.size || 0), 0);
  for (const sub of ((node && node.subtasks) || [])) sum += sumNodeFileBytes(sub);
  return sum;
};

// Celkové využitie workspace-u v bajtoch (kontakty + ich tasky + globálne Tasky)
const computeWorkspaceFileBytes = async (workspaceId) => {
  const [contacts, tasks] = await Promise.all([
    Contact.find({ workspaceId }, CONTACT_EXCLUDE).lean(),
    Task.find({ workspaceId }, TASK_EXCLUDE).lean()
  ]);
  let sum = 0;
  for (const c of contacts) {
    sum += (c.files || []).reduce((s, f) => s + (f.size || 0), 0);
    for (const t of (c.tasks || [])) sum += sumNodeFileBytes(t);
  }
  for (const t of tasks) sum += sumNodeFileBytes(t);
  return sum;
};

module.exports = { STORAGE_LIMITS, computeWorkspaceFileBytes, sumNodeFileBytes };
