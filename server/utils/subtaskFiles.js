/**
 * subtaskFiles.js — prílohy podúloh sa NIKDY neberú z tela požiadavky.
 *
 * PUT /api/tasks/:id a PUT /api/contacts/:contactId/tasks/:taskId prijímajú
 * celý strom `subtasks` od klienta (úprava názvu, poradia, dokončenia…).
 * Do 9/2026 sa ukladal doslovne, vrátane `files[]` — používateľ tak mohol do
 * svojej podúlohy podstrčiť cudzie fileId a potom ho stiahnuť alebo zmazať
 * cez /api/tasks/:taskId/files/:fileId (bloby globálnych úloh majú
 * ContactFile.contactId = null, takže ich nič neviaže na prostredie).
 *
 * Prílohy pribúdajú a ubúdajú len cez upload/delete routy. Tu ich preto pri
 * každom PUT vezmeme zo servera podľa ID podúlohy (hľadá sa v celom strome,
 * takže presun podúlohy pod iného rodiča ich zachová). Nová podúloha, ktorú
 * server nepozná, začína bez príloh.
 *
 * Rovnako zo servera ide stav pripomienok (reminderSent, timeRemindersSent,
 * lastUrgencyLevel), copiedFrom a createdAt; klientské polia sa whitelistujú
 * s typmi a dĺžkami a strom má strop hĺbky a počtu uzlov (od 2. úrovne je
 * `subtasks` v schéme netypované pole, Mongoose tam nič nekontroluje).
 */
const { v4: uuidv4 } = require('uuid');
const toPlain = (s) => (s && typeof s.toObject === 'function' ? s.toObject() : s);

// Limity stromu z klienta. Od 2. úrovne je `subtasks` v schéme netypované
// pole (Mixed), takže Mongoose nič nevaliduje — preto tu.
const MAX_DEPTH = 10;
const MAX_NODES = 1000;
const MAX_TITLE = 500;
const MAX_NOTES = 10000;
const PRIORITIES = new Set(['low', 'medium', 'high']);
const UUID_LIKE = /^[A-Za-z0-9_-]{1,64}$/;
const OID = /^[0-9a-fA-F]{24}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// Serverom spravované polia podľa ID uzla (prílohy, stav pripomienok,
// pôvod kópie, čas vytvorenia) — klient ich nesmie nastaviť.
const collectServerState = (subtasks, map = new Map()) => {
  if (!Array.isArray(subtasks)) return map;
  for (const raw of subtasks) {
    const s = toPlain(raw);
    if (!s || typeof s !== 'object') continue;
    if (s.id != null) map.set(String(s.id), s);
    collectServerState(s.subtasks, map);
  }
  return map;
};

const sanitizeNode = (raw, serverMap, depth, counter, seenIds) => {
  const s = toPlain(raw);
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (counter.n >= MAX_NODES) return null;
  counter.n++;

  // ID: klient generuje UUID pre nové podúlohy (optimistické UI na ne
  // odkazuje) — ponecháme ho, ak má rozumný tvar a nie je duplicitné.
  let id = typeof s.id === 'string' && UUID_LIKE.test(s.id) ? s.id : null;
  if (!id || seenIds.has(id)) id = uuidv4();
  seenIds.add(id);
  const server = serverMap.get(id);

  const dueDate = typeof s.dueDate === 'string' && s.dueDate.length <= 30 ? s.dueDate : null;
  const dueTime = typeof s.dueTime === 'string' && HHMM.test(s.dueTime) ? s.dueTime : '';
  const reminder = Number.isFinite(Number(s.reminder)) && s.reminder !== null && s.reminder !== '' ? Number(s.reminder) : null;
  const timeReminders = Array.isArray(s.timeReminders)
    ? [...new Set(s.timeReminders.map(Number).filter(n => Number.isFinite(n) && n > 0 && n <= 60 * 24 * 31))].slice(0, 10)
    : [];

  // Zmena termínu → odoslané pripomienky sa vynulujú (rovnako ako pri
  // úprave podúlohy cez jej vlastnú routu).
  const dueChanged = !server || server.dueDate !== dueDate || (server.dueTime || '') !== dueTime;
  const reminderChanged = !server || (server.reminder ?? null) !== reminder;

  const node = {
    id,
    title: str(s.title, MAX_TITLE),
    completed: s.completed === true,
    dueDate,
    dueTime,
    notes: str(s.notes, MAX_NOTES),
    priority: PRIORITIES.has(s.priority) ? s.priority : null,
    assignedTo: Array.isArray(s.assignedTo)
      ? [...new Set(s.assignedTo.map(String).filter(x => OID.test(x)))].slice(0, 50)
      : [],
    modifiedAt: typeof s.modifiedAt === 'string' && s.modifiedAt.length <= 40 ? s.modifiedAt : null,
    reminder,
    timeReminders,
    order: Number.isFinite(Number(s.order)) ? Number(s.order) : 0,
    // ── serverové polia ──
    files: server && Array.isArray(server.files) ? server.files : [],
    reminderSent: server && !reminderChanged ? !!server.reminderSent : false,
    timeRemindersSent: server && !dueChanged && Array.isArray(server.timeRemindersSent) ? server.timeRemindersSent : [],
    lastUrgencyLevel: server && !dueChanged ? (server.lastUrgencyLevel ?? null) : null,
    createdAt: server?.createdAt || new Date().toISOString(),
    subtasks: depth < MAX_DEPTH ? sanitizeTree(s.subtasks, serverMap, depth + 1, counter, seenIds) : []
  };
  if (server?.copiedFrom) node.copiedFrom = server.copiedFrom;
  return node;
};

const sanitizeTree = (subtasks, serverMap, depth, counter, seenIds) => {
  // Nie-pole (objekt, {0:…, length:1}) by Mongoose zabalil do [obj] a uložil
  // aj s podstrčenými poliami — preto sa z neho nič neprevezme.
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .map(raw => sanitizeNode(raw, serverMap, depth, counter, seenIds))
    .filter(Boolean);
};

/**
 * @param {Array} incoming  strom podúloh z req.body.subtasks
 * @param {Array} existing  aktuálny strom podúloh z DB
 * @returns {Array} sanitizovaný strom: povolené polia s typmi a limitmi,
 *          serverové polia (files, stav pripomienok, copiedFrom, createdAt)
 *          prevzaté zo servera podľa ID; pri nie-poli vráti `existing`
 */
const withServerSubtaskFiles = (incoming, existing) => {
  // Poškodený strom (nie pole) ignorujeme a necháme serverový — žiadny
  // legitímny klient taký neposiela a doslovné uloženie by otvorilo presne
  // tú dieru, ktorú tento modul zatvára.
  if (!Array.isArray(incoming)) return existing;
  return sanitizeTree(incoming, collectServerState(existing), 1, { n: 0 }, new Set());
};

// Počet uzlov stromu (rekurzívne) — pre plánový limit podúloh pri PUT.
const countSubtaskNodes = (subtasks) => (Array.isArray(subtasks)
  ? subtasks.reduce((sum, s) => sum + 1 + countSubtaskNodes(s?.subtasks), 0)
  : 0);

module.exports = { withServerSubtaskFiles, countSubtaskNodes };
