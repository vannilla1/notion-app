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

// Inkluzívna projekcia LEN na veľkosti príloh v strome podúloh (do hĺbky
// MAX_DEPTH). Predtým exclusion projekcia ťahala celé dokumenty (názvy,
// poznámky, celé stromy, nad 5. úrovňou aj legacy base64) pri KAŽDOM
// uploade a kópii. Strom podúloh nemá v schéme obmedzenú hĺbku; 10 úrovní
// je s rezervou nad tým, čo UI dovolí vytvoriť.
const MAX_DEPTH = 10;
const sizePaths = (prefix) => {
  const paths = {};
  let p = prefix;
  for (let i = 0; i <= MAX_DEPTH; i++) {
    paths[`${p}files.size`] = 1;
    p += 'subtasks.';
  }
  return paths;
};
const CONTACT_SIZES = { 'files.size': 1, ...sizePaths('tasks.') };
const TASK_SIZES = sizePaths('');

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
  const mongoose = require('mongoose');
  const wsId = typeof workspaceId === 'string' ? new mongoose.Types.ObjectId(workspaceId) : workspaceId;
  const [contacts, tasks, messageAgg] = await Promise.all([
    Contact.find({ workspaceId }, CONTACT_SIZES).lean(),
    Task.find({ workspaceId }, TASK_SIZES).lean(),
    // Správy majú plochú štruktúru → súčet priamo v DB, klientovi nejde
    // ani jeden dokument (nikdy text správ/komentárov).
    Message.aggregate([
      { $match: { workspaceId: wsId } },
      {
        $project: {
          b: {
            $add: [
              { $ifNull: ['$attachment.size', 0] },
              { $sum: { $ifNull: ['$files.size', []] } },
              { $sum: { $ifNull: ['$comments.attachment.size', []] } }
            ]
          }
        }
      },
      { $group: { _id: null, total: { $sum: '$b' } } }
    ])
  ]);
  let sum = messageAgg[0]?.total || 0;
  for (const c of contacts) {
    sum += (c.files || []).reduce((s, f) => s + (f.size || 0), 0);
    for (const t of (c.tasks || [])) sum += sumNodeFileBytes(t);
  }
  for (const t of tasks) sum += sumNodeFileBytes(t);
  return sum;
};

module.exports = { STORAGE_LIMITS, computeWorkspaceFileBytes, sumNodeFileBytes, sumMessageFileBytes };
