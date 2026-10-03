const Task = require('../models/Task');
const Contact = require('../models/Contact');
const User = require('../models/User');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');
const {
  mapNodeChains,
  treeMissingIds,
  ensureNodeIds,
  createNestedUpdate,
  reminderProjection
} = require('../utils/nestedTaskUpdate');

// ─── Recipient resolution ────────────────────────────────────────────────
//
// Príjemcovia notifikácií sa skladajú z viacerých polí, ktoré historicky
// nemajú jednotný typ:
//   - task.assignedTo  → [ObjectId]  (vždy platné)
//   - task.createdBy   → String      (legacy môže byť username, napr. "mkm")
//   - subtask.assignedTo → [String]  (môže byť ObjectId string aj username)
//   - contact.userId   → ObjectId
// Notification.userId je striktne ObjectId, takže username "mkm" spôsobí
// BSONError pri caste. Tu username → _id dohľadáme a nevalidné preskočíme.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const isObjectId = (v) => OBJECT_ID_RE.test(String(v == null ? '' : v));

// Podúloha môže mať vlastných riešiteľov (subtaskSchema.assignedTo) — tí
// majú dostať pripomienku k SVOJEJ podúlohe, nielen riešitelia/autor
// rodičovského projektu. resolveRecipientIds nižšie preloží username → _id
// a zahodí neplatné hodnoty.
const addSubtaskAssignees = (set, subtask) => {
  if (subtask && Array.isArray(subtask.assignedTo)) {
    subtask.assignedTo.forEach(id => { if (id != null) set.add(String(id)); });
  }
};

/**
 * Resolve a collection of raw recipient identifiers (ObjectId strings alebo
 * legacy usernames) na pole platných ObjectId stringov. Username hodnoty
 * dohľadáme cez User.username → _id; nevyriešené preskočíme s warnom (žiadny
 * hard error).
 * @param {Iterable<string>} rawIds
 * @returns {Promise<string[]>}
 */
const resolveRecipientIds = async (rawIds) => {
  const ids = Array.from(new Set(
    Array.from(rawIds || []).map(v => String(v == null ? '' : v)).filter(Boolean)
  ));

  const valid = [];
  const usernames = [];
  for (const id of ids) {
    if (isObjectId(id)) valid.push(id);
    else usernames.push(id);
  }

  if (usernames.length > 0) {
    try {
      const users = await User.find({ username: { $in: usernames } }, '_id username').lean();
      const byName = new Map(users.map(u => [u.username, u._id.toString()]));
      for (const name of usernames) {
        const resolved = byName.get(name);
        if (resolved) {
          valid.push(resolved);
        } else {
          logger.warn('[DueDateChecker] Could not resolve recipient to a valid userId, skipping', { recipient: name });
        }
      }
    } catch (err) {
      logger.warn('[DueDateChecker] Failed to resolve usernames to userIds', { error: err.message, usernames });
    }
  }

  return Array.from(new Set(valid));
};

/**
 * Due date urgency levels based on days remaining
 * - success: 8-14 days (green)
 * - warning: 4-7 days (yellow)
 * - danger: 1-3 days (red)
 * - overdue: 0 or negative (past due)
 */
const getUrgencyLevel = (dueDate) => {
  if (!dueDate) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);

  const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'overdue'; // Today is also considered overdue/urgent
  if (diffDays <= 3) return 'danger';
  if (diffDays <= 7) return 'warning';
  if (diffDays <= 14) return 'success';
  return null; // More than 14 days - no urgency
};

// ─── Ranné okno pre date-only notifikácie ───────────────────────────────
//
// Date-only notifikácie (urgency level changes + custom reminders, ktoré
// nemajú presný čas) sa posielajú IBA v rannom okne 06:00–06:59
// Europe/Bratislava. Bez tohto by chodili pri prepočte dní o UTC polnoci =
// 01:00–02:00 ráno SK (Render server beží v UTC), čo budí používateľov.
//
// Časové pripomienky (timeReminders s presným HH:MM) sú NEdotknuté — tie
// majú vlastný presný čas a posielajú sa hneď v danú minútu.
//
// Mechanizmus: mimo okna sa urgency/reminder DETEKCIA preskočí → `changes`
// ostane prázdne → žiadna notifikácia A žiadny update lastUrgencyLevel
// (stav sa "podrží"). Pri prvom cron tiku v 06:00 sa detekcia spustí,
// notifikácia odošle a stav updatne. Cron beží každých 5 min (12 tikov za
// hodinu) — idempotenciu zabezpečí lastUrgencyLevel/reminderSent (ďalšie
// tiky už nič nepošlú, lebo level/flag sa nezmenil).
//
// Robustnosť: ak by server zmeškal celé 06:00 okno (výpadok), stav ostane
// stale a notifikácia sa pošle pri ďalšom 06:00 (možno s vyšším levelom).
// Nestratí sa, len sa oneskorí.
const MORNING_SEND_HOUR = 6;
const isMorningSendWindow = (now = new Date()) => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Bratislava', hour: '2-digit', hour12: false
    }).formatToParts(now);
    const hh = parseInt(parts.find(p => p.type === 'hour')?.value, 10) % 24;
    return hh === MORNING_SEND_HOUR;
  } catch {
    // Ak Intl zlyhá (nemalo by) — fallback povolí (radšej poslať než nikdy)
    return true;
  }
};

/**
 * Get urgency change message
 */
const getUrgencyMessage = (oldLevel, newLevel, title, dueDate) => {
  const formattedDate = new Date(dueDate).toLocaleDateString('sk-SK');

  const messages = {
    'success-warning': {
      title: '⚠️ Blíži sa termín',
      body: `Projekt "${title}" má termín do 7 dní (${formattedDate})`
    },
    'warning-danger': {
      title: '🔴 Urgentný termín',
      body: `Projekt "${title}" má termín do 3 dní (${formattedDate})!`
    },
    'danger-overdue': {
      title: '❗ Termín vypršal',
      body: `Projekt "${title}" je po termíne (${formattedDate})!`
    },
    'success-danger': {
      title: '🔴 Urgentný termín',
      body: `Projekt "${title}" má termín do 3 dní (${formattedDate})!`
    },
    'success-overdue': {
      title: '❗ Termín vypršal',
      body: `Projekt "${title}" je po termíne (${formattedDate})!`
    },
    'warning-overdue': {
      title: '❗ Termín vypršal',
      body: `Projekt "${title}" je po termíne (${formattedDate})!`
    },
    'null-warning': {
      title: '⚠️ Blíži sa termín',
      body: `Projekt "${title}" má termín do 7 dní (${formattedDate})`
    },
    'null-danger': {
      title: '🔴 Urgentný termín',
      body: `Projekt "${title}" má termín do 3 dní (${formattedDate})!`
    },
    'null-overdue': {
      title: '❗ Termín vypršal',
      body: `Projekt "${title}" je po termíne (${formattedDate})!`
    }
  };

  const key = `${oldLevel || 'null'}-${newLevel}`;
  return messages[key] || null;
};

// ─── Time-of-day reminders ───────────────────────────────────────────────
//
// Prerequisite: úloha má vyplnený dueDate aj dueTime ("HH:MM"). User si
// nastaví pole minút pred presným časom v `timeReminders` — napr. [60, 15]
// znamená "pošli push 1 hodinu pred a 15 minút pred". Po prvom odpálení
// daná hodnota presúva do `timeRemindersSent` aby sa neopakovala. Cron beží
// každých 5 min, takže najmenšia rozumná hodnota je 5 — ponúkame 15 ako
// minimum aby bolo bezpečné okno aj pri jitter-i medzi behmi cronu.

const REMINDER_INTERVAL_MS = 5 * 60 * 1000; // matches cron frequency

// dueDate + dueTime sú slovenský "nástenný" čas (klient aj Google Calendar
// ich berú v Europe/Bratislava). Server na Render beží v UTC, takže
// `new Date('YYYY-MM-DDTHH:MM:00')` (bez offsetu = lokálny čas servera) by
// termín posunul o +1 h (zima) / +2 h (leto) a pripomienky by chodili
// neskoro — v lete aj po termíne. Prepočet robíme cez Intl bez závislostí.
const DUE_TIME_ZONE = 'Europe/Bratislava';

// Offset zóny voči UTC (ms) v okamihu utcMs.
const getZoneOffsetMs = (utcMs) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DUE_TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs));
  const get = (type) => parseInt(parts.find(p => p.type === type)?.value, 10);
  const zonedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'));
  return zonedAsUtc - Math.floor(utcMs / 1000) * 1000;
};

// Nástenný čas v Europe/Bratislava → UTC ms. Druhá iterácia rieši deň
// prechodu letného/zimného času.
const zonedWallTimeToUtcMs = (y, mo, d, hh, mm) => {
  const wallAsUtc = Date.UTC(y, mo - 1, d, hh, mm);
  const firstGuess = wallAsUtc - getZoneOffsetMs(wallAsUtc);
  return wallAsUtc - getZoneOffsetMs(firstGuess);
};

const parseDueDateTimeMs = (item) => {
  if (!item.dueDate) return null;
  // dueTime "HH:MM" alebo prázdny — bez času fallback na začiatok dňa.
  const hasTime = item.dueTime && /^\d{2}:\d{2}$/.test(item.dueTime);
  const datePart = String(item.dueDate).split('T')[0];
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (dm) {
    try {
      const [hh, mm] = hasTime ? item.dueTime.split(':').map(Number) : [0, 0];
      const ms = zonedWallTimeToUtcMs(Number(dm[1]), Number(dm[2]), Number(dm[3]), hh, mm);
      if (Number.isFinite(ms)) return ms;
    } catch {
      // Intl zlyhal (nemalo by) — padneme na pôvodný výpočet nižšie
    }
  }
  const dt = hasTime
    ? `${datePart}T${item.dueTime}:00`
    : `${datePart}T00:00:00`;
  const ms = new Date(dt).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Returns array of time-reminder minutes that should fire NOW for this item.
 * Each entry: { mins, dueDateTimeMs }. Caller fires notif + marks sent.
 */
const checkTimeReminders = (item, nowMs = Date.now()) => {
  if (!item.timeReminders || item.timeReminders.length === 0) return [];
  if (!item.dueTime) return []; // require explicit time
  if (item.completed) return [];

  const dueMs = parseDueDateTimeMs(item);
  if (dueMs === null) return [];

  const sent = new Set((item.timeRemindersSent || []).map(Number));
  const fired = [];

  for (const minsRaw of item.timeReminders) {
    const mins = Number(minsRaw);
    if (!Number.isFinite(mins) || mins <= 0) continue;
    if (sent.has(mins)) continue;

    const triggerMs = dueMs - mins * 60 * 1000;
    // Fire ak sme presne v 5-min okne pred dueMs - mins. Tolerujeme tiež
    // staršie nezachytené pripomienky (server bol dole) — fire-once-late.
    if (nowMs >= triggerMs && nowMs < dueMs) {
      fired.push({ mins, dueMs });
    }
  }

  return fired;
};

const formatTimeReminderMessage = (title, dueMs, mins) => {
  // timeZone: dueMs je skutočný UTC okamih — bez zóny by sa na UTC serveri
  // zobrazil čas o 1–2 h nižší, než si používateľ nastavil.
  const dueLocal = new Date(dueMs).toLocaleString('sk-SK', {
    timeZone: DUE_TIME_ZONE,
    day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  let label;
  if (mins < 60) label = `${mins} min`;
  else if (mins < 1440) {
    const h = Math.round(mins / 60);
    label = h === 1 ? '1 hodinu' : `${h} hodiny`;
  } else {
    const d = Math.round(mins / 1440);
    label = d === 1 ? '1 deň' : `${d} dni`;
  }
  return {
    title: `🔔 Pripomienka — ${label} pred termínom`,
    body: `Projekt "${title}" má termín ${dueLocal}.`
  };
};

/**
 * Check if a custom reminder should fire for a task/subtask
 * Returns reminder info if it should fire, null otherwise
 */
const checkReminder = (item) => {
  if (!item.dueDate || !item.reminder || item.reminderSent || item.completed) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(item.dueDate);
  due.setHours(0, 0, 0, 0);

  const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

  // Fire reminder when days remaining <= reminder days and not overdue yet
  if (diffDays >= 0 && diffDays <= item.reminder) {
    return {
      daysRemaining: diffDays,
      reminderDays: item.reminder,
      dueDate: item.dueDate
    };
  }
  return null;
};

/**
 * Get reminder message
 */
const getReminderMessage = (title, dueDate, daysRemaining) => {
  const formattedDate = new Date(dueDate).toLocaleDateString('sk-SK');
  if (daysRemaining === 0) {
    return {
      title: '🔔 Pripomienka: dnes je termín',
      body: `Projekt "${title}" má termín dnes (${formattedDate})`
    };
  }
  if (daysRemaining === 1) {
    return {
      title: '🔔 Pripomienka: zajtra je termín',
      body: `Projekt "${title}" má termín zajtra (${formattedDate})`
    };
  }
  return {
    title: `🔔 Pripomienka: termín o ${daysRemaining} dní`,
    body: `Projekt "${title}" má termín ${formattedDate} (zostáva ${daysRemaining} dní)`
  };
};

/**
 * Process subtasks recursively and collect reminder triggers
 */
const processSubtaskReminders = (subtasks, taskId, reminders = []) => {
  if (!subtasks || subtasks.length === 0) return reminders;

  for (const subtask of subtasks) {
    if (subtask.completed) continue;

    const reminderInfo = checkReminder(subtask);
    if (reminderInfo) {
      reminders.push({
        type: 'subtask',
        subtask,
        taskId,
        ...reminderInfo
      });
    }

    if (subtask.subtasks && subtask.subtasks.length > 0) {
      processSubtaskReminders(subtask.subtasks, taskId, reminders);
    }
  }

  return reminders;
};

/**
 * Process subtasks recursively and collect urgency changes
 */
const processSubtasks = (subtasks, taskId, changes = []) => {
  if (!subtasks || subtasks.length === 0) return changes;

  for (const subtask of subtasks) {
    if (subtask.completed) continue;

    const currentLevel = getUrgencyLevel(subtask.dueDate);
    const storedLevel = subtask.lastUrgencyLevel || null;

    if (currentLevel && currentLevel !== storedLevel) {
      // Check if this is an escalation (not de-escalation)
      const levelOrder = { 'success': 1, 'warning': 2, 'danger': 3, 'overdue': 4 };
      const currentOrder = levelOrder[currentLevel] || 0;
      const storedOrder = levelOrder[storedLevel] || 0;

      if (currentOrder > storedOrder) {
        changes.push({
          type: 'subtask',
          subtask,
          taskId,
          oldLevel: storedLevel,
          newLevel: currentLevel
        });
      }
    }

    // Process nested subtasks
    if (subtask.subtasks && subtask.subtasks.length > 0) {
      processSubtasks(subtask.subtasks, taskId, changes);
    }
  }

  return changes;
};

/**
 * Check all tasks for due date urgency changes and send notifications
 */
// Ochrana proti prekrývaniu behov: interval je 5 min, ale beh prechádza
// sekvenčne všetky úlohy a kontakty s mnohými await — pri väčšom objeme
// trvá dlhšie a druhý beh by poslal tie isté notifikácie znova (stav
// „odoslané" sa ukladá až na konci spracovania úlohy). Platí v rámci jednej
// inštancie; pri viacerých inštanciách by bol potrebný zdieľaný zámok.
let checkInProgress = false;

const checkDueDates = async () => {
  if (checkInProgress) {
    logger.warn('[DueDateChecker] Predošlý beh ešte prebieha — tento sa preskakuje');
    return { notificationsSent: 0, tasksUpdated: 0, skipped: true };
  }
  checkInProgress = true;
  try {
    return await runDueDateCheck();
  } finally {
    checkInProgress = false;
  }
};

// Polia, ktoré plánovač z Task číta (bez description/files — predtým sa
// načítali celé dokumenty vrátane legacy base64 súborov).
const TASK_PROJECTION = {
  ...reminderProjection(''),
  createdBy: 1,
  workspaceId: 1,
  contactId: 1
};
const CONTACT_PROJECTION = {
  name: 1,
  workspaceId: 1,
  userId: 1,
  ...reminderProjection('tasks.')
};

/**
 * Do `marks` pridá nový lastUrgencyLevel pre koreň a všetky podúlohy, ktorých
 * uložená úroveň sa líši od aktuálnej (predtým sa prepisovalo celé pole
 * podúloh).
 */
const addUrgencyLevelMarks = (marks, root, rootChain, chains) => {
  const visit = (node, chain) => {
    if (!chain) return;
    const level = getUrgencyLevel(node.dueDate);
    if ((node.lastUrgencyLevel || null) !== level) marks.set(chain, 'lastUrgencyLevel', level);
  };
  visit(root, rootChain);
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      visit(node, chains.get(node));
      walk(node.subtasks);
    }
  };
  walk(root.subtasks);
};

const runDueDateCheck = async () => {
  try {
    logger.info('[DueDateChecker] Starting due date check...');

    // Date-only notifikácie (urgency + reminder) posielame len v rannom okne
    // 06:00 SK. timeReminders (presný čas) bežia vždy. Mimo okna sa urgency/
    // reminder detekcia preskočí (changes ostane prázdne → bez notifikácie
    // a bez update stavu).
    const morningWindow = isMorningSendWindow();

    // Get all incomplete tasks with due dates or reminders.
    // Kurzor (nie jedno veľké pole): každá úloha sa spracuje krátko po
    // načítaní a v pamäti je naraz len jedna dávka.
    const cursor = Task.find({
      completed: false,
      $or: [
        { dueDate: { $exists: true, $ne: null } },
        { 'subtasks.dueDate': { $exists: true, $ne: null } },
        { reminder: { $exists: true, $ne: null } },
        { 'subtasks.reminder': { $exists: true, $ne: null } }
      ]
    }, TASK_PROJECTION).lean().batchSize(50).maxTimeMS(20000).cursor();

    let tasksChecked = 0;
    let notificationsSent = 0;
    let tasksUpdated = 0;

    for await (let task of cursor) {
      tasksChecked++;
      // Chyba jednej úlohy (validácia, legacy dáta, výpadok pri
      // notifikácii) nesmie zastaviť kontrolu všetkých ostatných úloh ani
      // kontaktov — predtým výnimka vyletela z cyklu a checkContactDueDates
      // sa v tom behu vôbec nespustil.
      try {
        // Cielený zápis potrebuje id na každej podúlohe (legacy dáta ich
        // nemusia mať) — doplníme ich a pracujeme s čerstvou kópiou.
        if (treeMissingIds(task.subtasks)) {
          const ready = await ensureNodeIds(Task.collection, task._id, 'subtasks');
          if (!ready) {
            logger.warn('[DueDateChecker] Task changed while assigning subtask ids — skipped this run', { taskId: task._id?.toString() });
            continue;
          }
          task = await Task.findById(task._id, TASK_PROJECTION).lean();
          if (!task) continue;
        }
        const chains = mapNodeChains(task.subtasks, 'subtasks');
        const chainOf = (node) => (node === task ? [] : chains.get(node));

        const changes = [];

        // Check main task due date — len v rannom okne (date-only notifikácia)
        if (morningWindow && task.dueDate && !task.completed) {
          const currentLevel = getUrgencyLevel(task.dueDate);
          const storedLevel = task.lastUrgencyLevel || null;

          if (currentLevel && currentLevel !== storedLevel) {
            const levelOrder = { 'success': 1, 'warning': 2, 'danger': 3, 'overdue': 4 };
            const currentOrder = levelOrder[currentLevel] || 0;
            const storedOrder = levelOrder[storedLevel] || 0;

            if (currentOrder > storedOrder) {
              changes.push({
                type: 'task',
                task,
                oldLevel: storedLevel,
                newLevel: currentLevel
              });
            }
          }
        }

        // Check subtasks — len v rannom okne
        if (morningWindow) processSubtasks(task.subtasks, task._id, changes);

        // --- Custom reminders --- (date-only → len v rannom okne)
        const reminders = [];
        if (morningWindow) {
          // Check main task reminder
          const taskReminder = checkReminder(task);
          if (taskReminder) {
            reminders.push({ type: 'task', task, ...taskReminder });
          }
          // Check subtask reminders
          processSubtaskReminders(task.subtasks, task._id, reminders);
        }

        // --- Time-of-day reminders (pole minút pred dueDateTime) ---
        // User si explicitne nastavil → category: 'direct' (vždy push).
        const timeFires = [];
        const nowMs = Date.now();

        // Main task time reminders
        const taskTimeFires = checkTimeReminders(task, nowMs);
        for (const f of taskTimeFires) {
          timeFires.push({ kind: 'task', taskRef: task, ...f });
        }

        // Subtask time reminders (recursive walk)
        const walkSubtasksForTime = (subs) => {
          if (!subs || subs.length === 0) return;
          for (const sub of subs) {
            if (sub.completed) continue;
            const fires = checkTimeReminders(sub, nowMs);
            for (const f of fires) {
              timeFires.push({ kind: 'subtask', taskRef: task, subtask: sub, ...f });
            }
            if (sub.subtasks && sub.subtasks.length > 0) walkSubtasksForTime(sub.subtasks);
          }
        };
        walkSubtasksForTime(task.subtasks);

        if (changes.length === 0 && reminders.length === 0 && timeFires.length === 0) continue;

        // Stav (odoslané pripomienky + nové úrovne urgentnosti) zapíšeme
        // PRED odoslaním a cielene len do dotknutých uzlov — prekrývajúci sa
        // beh nepošle duplikáty a zmeny používateľa v úlohe sa neprepíšu.
        // Ak zápis zlyhá, notifikácie sa neodošlú: inak by časová
        // pripomienka chodila každých 5 min až do termínu.
        const marks = createNestedUpdate();
        for (const rem of reminders) {
          const chain = chainOf(rem.type === 'task' ? task : rem.subtask);
          if (chain) marks.set(chain, 'reminderSent', true);
        }
        for (const f of timeFires) {
          const node = f.kind === 'task' ? task : f.subtask;
          const chain = chainOf(node);
          if (chain) marks.addToSet(chain, 'timeRemindersSent', [f.mins], node.timeRemindersSent);
        }
        if (changes.length > 0) addUrgencyLevelMarks(marks, task, [], chains);

        if (!marks.isEmpty()) {
          try {
            const { update, options } = marks.build();
            await Task.collection.updateOne({ _id: task._id }, update, options);
          } catch (err) {
            logger.error('[DueDateChecker] Failed to persist reminder state — notifications skipped', {
              error: err.message, taskId: task._id?.toString()
            });
            continue;
          }
        }
        if (changes.length > 0) tasksUpdated++;

        // Send notifications for changes
        for (const change of changes) {
          const message = getUrgencyMessage(
            change.oldLevel,
            change.newLevel,
            change.type === 'task' ? change.task.title : change.subtask.title,
            change.type === 'task' ? change.task.dueDate : change.subtask.dueDate
          );

          if (message) {
            // Get users to notify - task assignees or creator
            const usersToNotify = new Set();

            if (task.assignedTo && task.assignedTo.length > 0) {
              task.assignedTo.forEach(userId => usersToNotify.add(userId.toString()));
            }
            if (task.createdBy) {
              usersToNotify.add(task.createdBy.toString());
            }

            // Send full notification (in-app + web push + APNs) to each user.
            // Resolve username→_id a vyhoď nevalidné, nech sa subtask vetva
            // nezasekne na createdBy="mkm" (legacy username v ObjectId poli).
            addSubtaskAssignees(usersToNotify, change.type === 'subtask' ? change.subtask : null);
            const recipientIds = await resolveRecipientIds(usersToNotify);
            for (const userId of recipientIds) {
              try {
                const notificationType = change.type === 'task' ? 'task.dueDate' : 'subtask.dueDate';
                await notificationService.createNotification({
                  userId,
                  workspaceId: task.workspaceId,
                  type: notificationType,
                  title: message.title,
                  message: message.body,
                  actorName: 'Systém',
                  relatedType: change.type,
                  relatedId: change.type === 'task' ? task._id.toString() : change.subtask.id,
                  relatedName: change.type === 'task' ? task.title : change.subtask.title,
                  data: {
                    taskId: task._id.toString(),
                    subtaskId: change.type === 'subtask' ? change.subtask.id : null,
                    contactId: task.contactId || null,
                    // urgency: podľa nej notificationService rozlíši „po termíne"
                    // (preferencia pushOverdue) od bežnej pripomienky termínu.
                    urgency: change.newLevel
                  }
                });
                notificationsSent++;
              } catch (err) {
                logger.error('[DueDateChecker] Failed to send notification', {
                  error: err.message,
                  userId,
                  taskId: task._id
                });
              }
            }
          }
        }

        // Send reminder notifications
        for (const rem of reminders) {
          const title = rem.type === 'task' ? rem.task.title : rem.subtask.title;
          const message = getReminderMessage(title, rem.dueDate, rem.daysRemaining);

          const usersToNotify = new Set();
          if (task.assignedTo && task.assignedTo.length > 0) {
            task.assignedTo.forEach(userId => usersToNotify.add(userId.toString()));
          }
          if (task.createdBy) {
            usersToNotify.add(task.createdBy.toString());
          }
          addSubtaskAssignees(usersToNotify, rem.type === 'subtask' ? rem.subtask : null);

          const recipientIds = await resolveRecipientIds(usersToNotify);
          for (const userId of recipientIds) {
            try {
              const notificationType = rem.type === 'task' ? 'task.dueDate' : 'subtask.dueDate';
              await notificationService.createNotification({
                userId,
                workspaceId: task.workspaceId,
                type: notificationType,
                title: message.title,
                message: message.body,
                actorName: 'Systém',
                relatedType: rem.type,
                relatedId: rem.type === 'task' ? task._id.toString() : rem.subtask.id,
                relatedName: title,
                data: {
                  taskId: task._id.toString(),
                  subtaskId: rem.type === 'subtask' ? rem.subtask.id : null,
                  contactId: task.contactId || null
                }
              });
              notificationsSent++;
            } catch (err) {
              logger.error('[DueDateChecker] Failed to send reminder', {
                error: err.message,
                userId,
                taskId: task._id
              });
            }
          }
        }

        // Send time-of-day reminders
        for (const f of timeFires) {
          const title = f.kind === 'task' ? task.title : f.subtask.title;
          const msg = formatTimeReminderMessage(title, f.dueMs, f.mins);

          const usersToNotify = new Set();
          if (task.assignedTo && task.assignedTo.length > 0) {
            task.assignedTo.forEach(uid => usersToNotify.add(uid.toString()));
          }
          if (task.createdBy) usersToNotify.add(task.createdBy.toString());
          addSubtaskAssignees(usersToNotify, f.kind === 'task' ? null : f.subtask);

          const recipientIds = await resolveRecipientIds(usersToNotify);
          for (const userId of recipientIds) {
            try {
              await notificationService.createNotification({
                userId,
                workspaceId: task.workspaceId,
                type: f.kind === 'task' ? 'task.dueDate' : 'subtask.dueDate',
                category: 'direct', // explicit reminder → vždy push, bez ohľadu na pushDeadlines
                title: msg.title,
                message: msg.body,
                actorName: 'Systém',
                relatedType: f.kind,
                relatedId: f.kind === 'task' ? task._id.toString() : f.subtask.id,
                relatedName: title,
                data: {
                  taskId: task._id.toString(),
                  subtaskId: f.kind === 'subtask' ? f.subtask.id : null,
                  contactId: task.contactId || null
                }
              });
              notificationsSent++;
            } catch (err) {
              logger.error('[DueDateChecker] Failed to send time reminder', {
                error: err.message, userId, taskId: task._id, mins: f.mins
              });
            }
          }
        }
      } catch (taskErr) {
        logger.error('[DueDateChecker] Task processing failed', { taskId: task._id?.toString(), error: taskErr.message });
      }
    }

    // Also check contact tasks (rovnaké ranné okno pre date-only)
    const contactResult = await checkContactDueDates(morningWindow);
    notificationsSent += contactResult.notificationsSent;

    logger.info(`[DueDateChecker] Completed. Tasks checked: ${tasksChecked}, Notifications sent: ${notificationsSent}, Tasks updated: ${tasksUpdated}, Contacts updated: ${contactResult.contactsUpdated}`);

    return { notificationsSent, tasksUpdated };
  } catch (error) {
    logger.error('[DueDateChecker] Error checking due dates', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
};

/**
 * Check contact tasks for due date urgency changes and reminders
 */
const checkContactDueDates = async (morningWindow = true) => {
  try {
    // files.data is now in ContactFile collection. Projekcia len polí, ktoré
    // plánovač číta; kurzor namiesto jedného poľa všetkých kontaktov.
    const cursor = Contact.find(
      {
        'tasks.0': { $exists: true },
        'tasks': { $elemMatch: { completed: { $ne: true }, $or: [
          { dueDate: { $exists: true, $ne: null } },
          { reminder: { $exists: true, $ne: null } }
        ]}}
      },
      CONTACT_PROJECTION
    ).lean().batchSize(50).maxTimeMS(20000).cursor();

    let notificationsSent = 0;
    let contactsUpdated = 0;

    for await (let contact of cursor) {
      // Rovnako ako pri Task cykle — chyba jedného kontaktu nezastaví ostatné.
      try {
        if (treeMissingIds(contact.tasks)) {
          const ready = await ensureNodeIds(Contact.collection, contact._id, 'tasks');
          if (!ready) {
            logger.warn('[DueDateChecker] Contact changed while assigning task ids — skipped this run', { contactId: contact._id?.toString() });
            continue;
          }
          contact = await Contact.findById(contact._id, CONTACT_PROJECTION).lean();
          if (!contact) continue;
        }
        const chains = mapNodeChains(contact.tasks, 'tasks');
        const marks = createNestedUpdate();
        const pending = [];
        const nowMs = Date.now();

        for (const task of contact.tasks || []) {
          if (!task || task.completed) continue;
          const taskChain = chains.get(task);
          if (!taskChain) continue;

          const changes = [];

          // Check task due date — len v rannom okne (date-only notifikácia)
          if (morningWindow && task.dueDate) {
            const currentLevel = getUrgencyLevel(task.dueDate);
            const storedLevel = task.lastUrgencyLevel || null;

            if (currentLevel && currentLevel !== storedLevel) {
              const levelOrder = { success: 1, warning: 2, danger: 3, overdue: 4 };
              if ((levelOrder[currentLevel] || 0) > (levelOrder[storedLevel] || 0)) {
                changes.push({ type: 'task', task, oldLevel: storedLevel, newLevel: currentLevel });
              }
            }
          }

          // Check subtasks — len v rannom okne
          if (morningWindow) processSubtasks(task.subtasks, contact._id, changes);

          // Custom reminders — date-only → len v rannom okne
          const reminders = [];
          if (morningWindow) {
            const taskReminder = checkReminder(task);
            if (taskReminder) reminders.push({ type: 'task', task, ...taskReminder });
            processSubtaskReminders(task.subtasks, contact._id, reminders);
          }

          // --- Time-of-day reminders for contact tasks/subtasks ---
          const fires = [];
          const taskTimeFires = checkTimeReminders(task, nowMs);
          for (const f of taskTimeFires) fires.push({ kind: 'task', taskRef: task, ...f });

          const walkSubsForTime = (subs) => {
            if (!subs || subs.length === 0) return;
            for (const sub of subs) {
              if (sub.completed) continue;
              const subFires = checkTimeReminders(sub, nowMs);
              for (const f of subFires) fires.push({ kind: 'subtask', taskRef: task, subtask: sub, ...f });
              if (sub.subtasks?.length > 0) walkSubsForTime(sub.subtasks);
            }
          };
          walkSubsForTime(task.subtasks);

          if (changes.length === 0 && reminders.length === 0 && fires.length === 0) continue;

          for (const rem of reminders) {
            const chain = rem.type === 'task' ? taskChain : chains.get(rem.subtask);
            if (chain) marks.set(chain, 'reminderSent', true);
          }
          for (const f of fires) {
            const node = f.kind === 'task' ? task : f.subtask;
            const chain = f.kind === 'task' ? taskChain : chains.get(node);
            if (chain) marks.addToSet(chain, 'timeRemindersSent', [f.mins], node.timeRemindersSent);
          }
          if (changes.length > 0) addUrgencyLevelMarks(marks, task, taskChain, chains);

          pending.push({ task, changes, reminders, fires });
        }

        if (pending.length === 0) continue;

        // Stav zapíšeme PRED odoslaním, cielene do dotknutých úloh/podúloh.
        // Predtým sa po odoslaní všetkých notifikácií prepísalo celé pole
        // `tasks` snapshotom zo začiatku behu (strata zmien používateľa) a pri
        // zlyhaní zápisu sa pripomienky posielali znova každých 5 minút.
        if (!marks.isEmpty()) {
          try {
            const { update, options } = marks.build();
            await Contact.collection.updateOne({ _id: contact._id }, update, options);
            contactsUpdated++;
          } catch (err) {
            logger.error('[DueDateChecker] Failed to persist contact reminder state — notifications skipped', {
              error: err.message, contactId: contact._id?.toString()
            });
            continue;
          }
        }

        for (const { task, changes, reminders, fires } of pending) {
          // Send urgency notifications
          for (const change of changes) {
            const message = getUrgencyMessage(
              change.oldLevel, change.newLevel,
              change.type === 'task' ? change.task.title : change.subtask.title,
              change.type === 'task' ? change.task.dueDate : change.subtask.dueDate
            );

            if (message) {
              const usersToNotify = new Set();
              if (task.assignedTo?.length > 0) task.assignedTo.forEach(uid => usersToNotify.add(uid));
              usersToNotify.add(contact.userId.toString());
              addSubtaskAssignees(usersToNotify, change.type === 'subtask' ? change.subtask : null);

              const recipientIds = await resolveRecipientIds(usersToNotify);
              for (const userId of recipientIds) {
                try {
                  await notificationService.createNotification({
                    userId,
                    workspaceId: contact.workspaceId,
                    type: change.type === 'task' ? 'task.dueDate' : 'subtask.dueDate',
                    title: message.title,
                    message: message.body,
                    actorName: 'Systém',
                    relatedType: 'contact',
                    relatedId: contact._id.toString(),
                    relatedName: contact.name || 'Kontakt',
                    data: {
                      contactId: contact._id.toString(),
                      taskId: task.id,
                      subtaskId: change.type === 'subtask' ? change.subtask.id : null,
                      urgency: change.newLevel // viď globálne úlohy vyššie (pushOverdue)
                    }
                  });
                  notificationsSent++;
                } catch (err) {
                  logger.error('[DueDateChecker] Contact task notification failed', { error: err.message });
                }
              }
            }
          }

          // Send reminder notifications
          for (const rem of reminders) {
            const title = rem.type === 'task' ? rem.task.title : rem.subtask.title;
            const msg = getReminderMessage(title, rem.dueDate, rem.daysRemaining);

            const usersToNotify = new Set();
            if (task.assignedTo?.length > 0) task.assignedTo.forEach(uid => usersToNotify.add(uid));
            usersToNotify.add(contact.userId.toString());
            addSubtaskAssignees(usersToNotify, rem.type === 'subtask' ? rem.subtask : null);

            const recipientIds = await resolveRecipientIds(usersToNotify);
            for (const userId of recipientIds) {
              try {
                await notificationService.createNotification({
                  userId,
                  workspaceId: contact.workspaceId,
                  type: rem.type === 'task' ? 'task.dueDate' : 'subtask.dueDate',
                  title: msg.title,
                  message: msg.body,
                  actorName: 'Systém',
                  relatedType: 'contact',
                  relatedId: contact._id.toString(),
                  relatedName: contact.name || 'Kontakt',
                  data: {
                    contactId: contact._id.toString(),
                    taskId: task.id,
                    subtaskId: rem.type === 'subtask' ? rem.subtask.id : null
                  }
                });
                notificationsSent++;
              } catch (err) {
                logger.error('[DueDateChecker] Contact task reminder failed', { error: err.message });
              }
            }
          }

          // Send time-of-day reminders
          for (const f of fires) {
            const title = f.kind === 'task' ? task.title : f.subtask.title;
            const msg = formatTimeReminderMessage(title, f.dueMs, f.mins);

            const usersToNotify = new Set();
            if (task.assignedTo?.length > 0) task.assignedTo.forEach(uid => usersToNotify.add(uid));
            usersToNotify.add(contact.userId.toString());
            addSubtaskAssignees(usersToNotify, f.kind === 'task' ? null : f.subtask);

            const recipientIds = await resolveRecipientIds(usersToNotify);
            for (const userId of recipientIds) {
              try {
                await notificationService.createNotification({
                  userId,
                  workspaceId: contact.workspaceId,
                  type: f.kind === 'task' ? 'task.dueDate' : 'subtask.dueDate',
                  category: 'direct', // explicit time reminder → vždy push
                  title: msg.title,
                  message: msg.body,
                  actorName: 'Systém',
                  relatedType: 'contact',
                  relatedId: contact._id.toString(),
                  relatedName: contact.name || 'Kontakt',
                  data: {
                    contactId: contact._id.toString(),
                    taskId: task.id,
                    subtaskId: f.kind === 'subtask' ? f.subtask.id : null
                  }
                });
                notificationsSent++;
              } catch (err) {
                logger.error('[DueDateChecker] Contact time-reminder failed', { error: err.message });
              }
            }
          }
        }
      } catch (contactErr) {
        logger.error('[DueDateChecker] Contact processing failed', { contactId: contact._id?.toString(), error: contactErr.message });
      }
    }

    logger.info(`[DueDateChecker] Contact tasks: ${notificationsSent} notifications, ${contactsUpdated} contacts updated`);
    return { notificationsSent, contactsUpdated };
  } catch (error) {
    logger.error('[DueDateChecker] Error checking contact due dates', { error: error.message });
    throw error;
  }
};

/**
 * Schedule due date checks to run at specific times
 * This should be called once when the server starts
 */
// Handly časovačov — aby sa plánovač nedal spustiť dvakrát (dvojitý interval
// = dvojité notifikácie) a aby ho šlo zastaviť (stopDueDateChecks).
let startTimer = null;
let intervalTimer = null;

const scheduleDueDateChecks = () => {
  if (intervalTimer) {
    logger.warn('[DueDateChecker] Scheduler už beží — druhé volanie ignorujem');
    return;
  }
  // Beží každých 5 minút, aby sa stihli zachytiť time-of-day reminders
  // (najmenšia rozumná hodnota timeReminders je 15 min — máme 3-násobnú
  // rezervu). Aut. urgency-level prechody (warning/danger/overdue) sú
  // odolnejšie, fungujú rovnako ako predtým.
  const INTERVAL_MS = 5 * 60 * 1000; // 5 min

  // Run immediately on startup (after a short delay to let DB connect)
  startTimer = setTimeout(() => {
    checkDueDates().catch(err => {
      logger.error('[DueDateChecker] Initial check failed', { error: err.message });
    });
  }, 10000); // 10 seconds after startup
  startTimer.unref?.();

  // Then run periodically
  intervalTimer = setInterval(() => {
    checkDueDates().catch(err => {
      logger.error('[DueDateChecker] Scheduled check failed', { error: err.message });
    });
  }, INTERVAL_MS);
  // unref: časovač sám nedrží proces nažive (graceful shutdown, Jest).
  intervalTimer.unref?.();

  logger.info('[DueDateChecker] Scheduled to run every 5 minutes');
};

const stopDueDateChecks = () => {
  clearTimeout(startTimer);
  clearInterval(intervalTimer);
  startTimer = null;
  intervalTimer = null;
};

module.exports = {
  checkDueDates,
  scheduleDueDateChecks,
  stopDueDateChecks,
  getUrgencyLevel
};
