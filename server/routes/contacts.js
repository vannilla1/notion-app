const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace, enforceWorkspaceLimits } = require('../middleware/workspace');
const Contact = require('../models/Contact');
const ContactFile = require('../models/ContactFile');
const WorkspaceMember = require('../models/WorkspaceMember');
const Workspace = require('../models/Workspace');
const Task = require('../models/Task');
const fileStorage = require('../services/fileStorage');
const User = require('../models/User');
const { isIosNativeApp } = require('../utils/platform');
const { autoSyncTaskToCalendar, autoDeleteTaskFromCalendar } = require('./googleCalendar');
const { autoSyncTaskToGoogleTasks, autoDeleteTaskFromGoogleTasks } = require('./googleTasks');
const notificationService = require('../services/notificationService');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');
const { getCachedData, setCachedData, invalidateWorkspaceData } = require('../middleware/dataCache');

// Projection to exclude Base64 file data from all nesting levels (up to 6 deep)
const EXCLUDE_FILE_DATA = {
  'files.data': 0,
  'tasks.files.data': 0,
  'tasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.subtasks.files.data': 0,
  'tasks.subtasks.subtasks.subtasks.subtasks.files.data': 0,
};

// Helper to sync contact tasks to both Google Calendar and Google Tasks
const autoSyncContactToGoogle = async (taskData, action) => {
  await Promise.all([
    autoSyncTaskToCalendar(taskData, action).catch(err =>
      logger.warn('Auto-sync Calendar (contact) error', { error: err.message })
    ),
    autoSyncTaskToGoogleTasks(taskData, action).catch(err =>
      logger.warn('Auto-sync Tasks (contact) error', { error: err.message })
    )
  ]);
};

const autoDeleteContactFromGoogle = async (taskId) => {
  await Promise.all([
    autoDeleteTaskFromCalendar(taskId).catch(err =>
      logger.warn('Auto-delete Calendar (contact) error', { error: err.message })
    ),
    autoDeleteTaskFromGoogleTasks(taskId).catch(err =>
      logger.warn('Auto-delete Tasks (contact) error', { error: err.message })
    )
  ]);
};

/**
 * When a whole contact gets deleted, every task (and every nested subtask)
 * stored inside it must also vanish from Google. Collect every ID first,
 * then fan out parallel deletes. Previously only top-level contact task
 * deletes cleaned up Google — deleting the contact itself left dozens of
 * orphan events pointing to a kontakt that no longer exists.
 */
const collectAllTaskIdsFromContact = (contact) => {
  const ids = [];
  const walk = (subtasks) => {
    if (!Array.isArray(subtasks)) return;
    for (const sub of subtasks) {
      if (sub?.id) ids.push(String(sub.id));
      if (Array.isArray(sub?.subtasks) && sub.subtasks.length > 0) walk(sub.subtasks);
    }
  };
  if (Array.isArray(contact?.tasks)) {
    for (const t of contact.tasks) {
      if (t?.id) ids.push(String(t.id));
      walk(t.subtasks);
    }
  }
  return ids;
};

const autoDeleteAllTasksOfContactFromGoogle = (contact) => {
  const ids = collectAllTaskIdsFromContact(contact);
  for (const id of ids) {
    autoDeleteContactFromGoogle(id).catch(() => {});
  }
};

/**
 * Same idea as in tasks.js — cascade delete a whole task subtree (task + all
 * nested subtasks). Used when a single contact task (with nested subtasks)
 * or a subtask tree is removed.
 */
const autoDeleteTaskTreeFromGoogle = (task) => {
  if (!task) return;
  const ids = [];
  const rootId = task.id || (task._id && task._id.toString());
  if (rootId) ids.push(String(rootId));
  const walk = (subtasks) => {
    if (!Array.isArray(subtasks)) return;
    for (const sub of subtasks) {
      if (sub?.id) ids.push(String(sub.id));
      if (Array.isArray(sub?.subtasks) && sub.subtasks.length > 0) walk(sub.subtasks);
    }
  };
  walk(task.subtasks);
  for (const id of ids) {
    autoDeleteContactFromGoogle(id).catch(() => {});
  }
};

// ==================== IDEMPOTENCIA MUTÁCIÍ ====================
// Dvojklik / retry po timeoute nesmie vytvoriť duplikát. React "busy" state
// na klientovi sa aktualizuje až po re-renderi (rýchly druhý klik prejde) a
// Cloudflare vie po ~100s prerušiť dlhé kopírovanie príloh na strane
// klienta, zatiaľ čo server request v tichosti dokončí — retry potom vyrobí
// druhú kópiu. In-memory mapa stačí (API beží ako single instance). Kľúč sa
// pri reálnej chybe uvoľní, aby legitímny retry prešiel.
const recentMutationKeys = new Map(); // key -> expiresAt (ms)
const claimMutationKey = (key, ttlMs) => {
  const now = Date.now();
  for (const [k, exp] of recentMutationKeys) {
    if (exp <= now) recentMutationKeys.delete(k);
  }
  if (recentMutationKeys.has(key)) return false;
  recentMutationKeys.set(key, now + ttlMs);
  return true;
};
const releaseMutationKey = (key) => recentMutationKeys.delete(key);

const router = express.Router();

// Auto-invalidate contacts cache after any mutation (POST/PUT/DELETE)
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    const origJson = res.json.bind(res);
    res.json = (data) => {
      // Invalidate after successful response
      if (res.statusCode < 400 && req.workspaceId) {
        invalidateWorkspaceData(req.workspaceId, 'contacts');
        invalidateWorkspaceData(req.workspaceId, 'tasks'); // contacts have embedded tasks
      }
      return origJson(data);
    };
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = /jpeg|jpg|png|gif|bmp|webp|svg|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|json|xml|zip|rar|7z|mp3|mp4|wav|avi|mov/;
    const ext = file.originalname.toLowerCase().split('.').pop();
    const extAllowed = allowedExtensions.test(ext);

    const allowedMimetypes = [
      'image/', 'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument',
      'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
      'text/', 'audio/', 'video/',
      'application/zip', 'application/x-rar', 'application/x-7z-compressed',
      'application/json', 'application/xml'
    ];
    const mimeAllowed = allowedMimetypes.some(type => file.mimetype.startsWith(type) || file.mimetype === type);

    if (extAllowed || mimeAllowed) {
      return cb(null, true);
    }
    cb(new Error('Nepovolený typ súboru'));
  }
});

// Validation helpers
const isValidEmail = (email) => {
  if (!email) return true;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const isValidPhone = (phone) => {
  if (!phone) return true;
  const phoneRegex = /^[+]?[0-9\s-]+$/;
  return phoneRegex.test(phone);
};

// Helper function to convert contact to plain object with deep copy of nested subtasks
const contactToPlainObject = (contact) => {
  const obj = contact.toObject ? contact.toObject() : contact;
  const result = JSON.parse(JSON.stringify({
    ...obj,
    id: obj._id ? obj._id.toString() : obj.id
  }));
  // Strip file data (too large for socket.io)
  if (result.files && result.files.length > 0) {
    result.files = result.files.map(f => ({
      id: f.id,
      originalName: f.originalName,
      mimetype: f.mimetype,
      size: f.size,
      uploadedAt: f.uploadedAt
    }));
  }
  return result;
};

// Helper function to find a subtask recursively
const findSubtaskRecursive = (subtasks, subtaskId) => {
  if (!subtasks) return null;
  for (let i = 0; i < subtasks.length; i++) {
    if (subtasks[i].id === subtaskId) {
      return { subtask: subtasks[i], parent: subtasks, index: i };
    }
    if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
      const found = findSubtaskRecursive(subtasks[i].subtasks, subtaskId);
      if (found) return found;
    }
  }
  return null;
};

// ==================== TRANSFER HELPERY ====================
// (kopírovanie/presun projektu alebo úlohy do projektu iného kontaktu)

// Počet uzlov stromu (uzol + všetky vnorené podúlohy) — kontrola limitov plánu
const countTreeNodes = (node) => {
  const walk = (subs) => (subs || []).reduce((sum, s) => sum + 1 + walk(s.subtasks), 0);
  return 1 + walk(node?.subtasks);
};

// Všetky fileId v strome (uzol + podúlohy v ľubovoľnej hĺbke)
const collectFileIdsFromNode = (node) => {
  const ids = [];
  const walk = (n) => {
    for (const f of (n?.files || [])) if (f?.id) ids.push(f.id);
    for (const s of (n?.subtasks || [])) walk(s);
  };
  walk(node);
  return ids;
};

// Rovnaké capy ako pri copy-to-workspace — ohraničenie práce jedného requestu
const TRANSFER_MAX_COPY_FILES = 80;
const TRANSFER_MAX_COPY_BYTES = 200 * 1024 * 1024; // 200 MB spolu

// Fyzická kópia jednej prílohy pre daný kontakt — modulová obdoba copyOneFile
// z copy-to-workspace (tá je closure nad newContact, preto sa nedá zdieľať).
// createdFiles zbiera vytvorené bloby pre error-path cleanup — cieľový kontakt
// existoval už predtým, jeho pôvodné prílohy sa mazať NESMÚ.
const copyFileToContact = async (fileMeta, sourceContactId, targetContactId, stats, createdFiles) => {
  if (!fileMeta?.id) return null;
  if (stats.count >= TRANSFER_MAX_COPY_FILES || stats.bytes >= TRANSFER_MAX_COPY_BYTES) {
    stats.skippedCapped++;
    return null;
  }
  let buffer = null;
  try {
    // Scope na zdrojový kontakt — metadáta files[] sú klientom editovateľné
    // (PUT task berie subtasks verbatim), cudzí fileId sa nesmie dať prečítať
    const cf = await ContactFile.findOne({ fileId: fileMeta.id, contactId: sourceContactId }, { r2Key: 1, data: 1 }).lean();
    if (cf?.r2Key && fileStorage.isR2Available()) buffer = await fileStorage.downloadFile(cf.r2Key);
    else if (cf?.data) buffer = Buffer.from(cf.data, 'base64');
    else if (fileMeta.data) buffer = Buffer.from(fileMeta.data, 'base64');
  } catch (e) {
    logger.warn('[Transfer] Príloha — čítanie zdroja zlyhalo (preskakujem)', { fileId: fileMeta.id, error: e.message });
    stats.skippedError++;
    return null;
  }
  if (!buffer || !buffer.length) return null; // zdroj naozaj bez dát — OK

  try {
    const newFileId = uuidv4();
    if (fileStorage.isR2Available()) {
      const newKey = fileStorage.contactFileKey(newFileId);
      await fileStorage.uploadFile(newKey, buffer, fileMeta.mimetype || 'application/octet-stream');
      // Zaznamenaj HNEĎ po upload-e — ak by ContactFile.create padol, error
      // cleanup inak nevie o R2 objekte a blob by ostal orphan navždy.
      createdFiles.push({ fileId: newFileId, r2Key: newKey });
      await ContactFile.create({ contactId: targetContactId, fileId: newFileId, r2Key: newKey, data: null });
    } else {
      await ContactFile.create({ contactId: targetContactId, fileId: newFileId, data: buffer.toString('base64') });
      createdFiles.push({ fileId: newFileId, r2Key: null });
    }
    stats.count++;
    stats.bytes += buffer.length;
    return {
      id: newFileId,
      originalName: fileMeta.originalName,
      mimetype: fileMeta.mimetype,
      size: fileMeta.size,
      uploadedAt: fileMeta.uploadedAt || new Date()
    };
  } catch (e) {
    logger.warn('[Transfer] Príloha — zápis kópie zlyhal (preskakujem)', { fileId: fileMeta.id, error: e.message });
    stats.skippedError++;
    return null;
  }
};

// Hlboká kópia uzla (projekt alebo úloha/podúloha) s NOVÝMI UUID na každej
// úrovni + fyzickou kópiou príloh. Nové UUID sú nutné: Google sync mapy sú
// per-user keyované podľa UUID (zdieľané ID by rozbilo sync) a zdieľaný
// fileId by pri zmazaní jednej strany zabil blob aj druhej. asTask určuje
// tvar top uzla — úroveň sa pri prenose prispôsobí (description ↔ notes).
const deepCopyNodeForTransfer = async (node, { asTask, sourceContactId, targetContactId, stats, createdFiles }) => {
  const copyFilesList = async (files) => {
    const out = [];
    for (const f of (files || [])) {
      const nf = await copyFileToContact(f, sourceContactId, targetContactId, stats, createdFiles);
      if (nf) out.push(nf);
    }
    return out;
  };
  const copySubtree = async (subs) => {
    const out = [];
    for (const s of (subs || [])) {
      out.push({
        id: uuidv4(),
        title: s.title,
        completed: !!s.completed,
        dueDate: s.dueDate || '',
        dueTime: s.dueTime || '',
        notes: s.notes || '',
        priority: s.priority ?? null,
        assignedTo: Array.isArray(s.assignedTo) ? [...s.assignedTo] : [],
        subtasks: await copySubtree(s.subtasks),
        files: await copyFilesList(s.files),
        createdAt: new Date().toISOString(),
        modifiedAt: null,
        timeReminders: Array.isArray(s.timeReminders) ? [...s.timeReminders] : [],
        timeRemindersSent: [],
        reminderSent: false,
        lastUrgencyLevel: null
      });
    }
    return out;
  };

  const base = {
    id: uuidv4(),
    title: node.title,
    completed: !!node.completed,
    dueDate: node.dueDate || '',
    dueTime: node.dueTime || '',
    assignedTo: Array.isArray(node.assignedTo) ? [...node.assignedTo] : [],
    subtasks: await copySubtree(node.subtasks),
    files: await copyFilesList(node.files),
    createdAt: new Date().toISOString(),
    modifiedAt: null,
    timeReminders: Array.isArray(node.timeReminders) ? [...node.timeReminders] : [],
    timeRemindersSent: [],
    reminderSent: false,
    lastUrgencyLevel: null
  };
  if (asTask) {
    base.description = node.description || node.notes || '';
    base.priority = node.priority || 'medium';
  } else {
    base.notes = node.notes || node.description || '';
    base.priority = node.priority ?? null;
  }
  return base;
};

// Premapovanie úrovne pri PRESUNE — UUID, prílohy aj stav pripomienok sa
// ZACHOVÁVAJÚ (Google sync mapy, iCal UID aj deep-linky z notifikácií ostávajú
// platné a reset príznakov by znovu vystrelil už poslané pripomienky).
// Mení sa len tvar top uzla podľa cieľovej úrovne (description ↔ notes).
const remapNodeLevelForMove = (node, { asTask }) => {
  const out = {
    id: node.id,
    title: node.title,
    completed: !!node.completed,
    dueDate: node.dueDate || '',
    dueTime: node.dueTime || '',
    assignedTo: Array.isArray(node.assignedTo) ? [...node.assignedTo] : [],
    subtasks: Array.isArray(node.subtasks) ? node.subtasks : [],
    files: Array.isArray(node.files) ? node.files : [],
    createdAt: node.createdAt || new Date().toISOString(),
    modifiedAt: node.modifiedAt || null,
    lastUrgencyLevel: node.lastUrgencyLevel ?? null,
    reminder: node.reminder,
    reminderSent: !!node.reminderSent,
    timeReminders: Array.isArray(node.timeReminders) ? [...node.timeReminders] : [],
    timeRemindersSent: Array.isArray(node.timeRemindersSent) ? [...node.timeRemindersSent] : [],
    copiedFrom: node.copiedFrom || null
  };
  if (asTask) {
    out.description = node.description || node.notes || '';
    out.priority = node.priority || 'medium';
  } else {
    out.notes = node.notes || node.description || '';
    out.priority = node.priority ?? null;
  }
  return out;
};

// Get all contacts (for current workspace) - sorted alphabetically by name
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Check cache first (avoids DB query for 30s)
    const cached = getCachedData(req.workspaceId, 'contacts');
    if (cached) return res.json(cached);

    // files.data is now stored in ContactFile collection, so Contact docs are small
    const contacts = await Contact.find(
      { workspaceId: req.workspaceId },
      EXCLUDE_FILE_DATA
    ).sort({ name: 1 }).lean();

    const contactsWithId = contacts.map(contact => ({
      ...contact,
      id: contact._id.toString()
    }));

    // Cache result for 30s
    setCachedData(req.workspaceId, 'contacts', contactsWithId);

    res.json(contactsWithId);
  } catch (error) {
    logger.error('GET /contacts error', { error: error.message, workspaceId: req.workspaceId?.toString() });
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Export contacts to CSV
router.get('/export/csv', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Plan-feature gate: CSV export je dostupný len pre Tím+.
    const exporter = await User.findById(req.user.id).select('subscription').lean();
    const exporterPlan = exporter?.subscription?.plan || 'free';
    if (exporterPlan === 'free' || exporterPlan === 'trial') {
      // Apple 3.1.1 — iOS bez akejkoľvek zmienky o pláne / tier.
      const message = isIosNativeApp(req)
        ? 'Táto funkcia nie je dostupná.'
        : 'Export do CSV je dostupný v plánoch Tím a Pro. Upgradujte plán pre prístup.';
      return res.status(403).json({ message, code: 'FEATURE_NOT_IN_PLAN' });
    }
    const contacts = await Contact.find(
      { workspaceId: req.workspaceId },
      EXCLUDE_FILE_DATA
    ).sort({ name: 1 }).lean();

    const escCsv = (val) => {
      if (val == null) return '';
      let str = String(val);
      // CSV injection protection: prefix dangerous characters
      if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
      }
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const statusMap = { new: 'Nový', active: 'Aktívny', completed: 'Dokončený', cancelled: 'Zrušený' };

    const headers = ['Meno', 'Email', 'Telefón', 'Firma', 'Web', 'Stav', 'Poznámky', 'Počet projektov', 'Dokončené projekty', 'Vytvorený'];
    const rows = contacts.map(c => {
      const taskCount = (c.tasks || []).length;
      const completedTasks = (c.tasks || []).filter(t => t.completed).length;
      return [
        escCsv(c.name),
        escCsv(c.email),
        escCsv(c.phone),
        escCsv(c.company),
        escCsv(c.website),
        escCsv(statusMap[c.status] || c.status),
        escCsv(c.notes),
        taskCount,
        completedTasks,
        escCsv(c.createdAt ? new Date(c.createdAt).toLocaleDateString('sk-SK') : '')
      ].join(',');
    });

    const bom = '\uFEFF';
    const csv = bom + headers.join(',') + '\n' + rows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kontakty.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ message: 'Chyba pri exporte' });
  }
});

// Get single contact
router.get('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Exclude files.data field - it contains large Base64 data
    const contact = await Contact.findOne(
      { _id: req.params.id, workspaceId: req.workspaceId },
      EXCLUDE_FILE_DATA
    ).lean();
    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }
    res.json({ ...contact, id: contact._id.toString() });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Create contact
router.post('/', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
  try {
    const { name, email, phone, company, website, notes, status } = req.body;

    // Check plan contact limit
    const user = await User.findById(req.user.id);
    const plan = user?.subscription?.plan || 'free';
    const contactLimits = { free: 5, team: 25, pro: Infinity };
    const maxContacts = contactLimits[plan] || 5;
    if (maxContacts !== Infinity) {
      const contactCount = await Contact.countDocuments({ workspaceId: req.workspaceId });
      if (contactCount >= maxContacts) {
        // Apple 3.1.1 — iOS message NIESMIE spomínať plán / tier / subscription.
        // Web variant zostáva actionable.
        const message = isIosNativeApp(req)
          ? `Dosiahli ste limit ${maxContacts} kontaktov pre toto prostredie.`
          : `Váš plán umožňuje max. ${maxContacts} kontaktov. Pre viac kontaktov prejdite na vyšší plán.`;
        return res.status(403).json({ message });
      }
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: 'Neplatný formát emailu' });
    }

    if (phone && !isValidPhone(phone)) {
      return res.status(400).json({ message: 'Telefón môže obsahovať len čísla, medzery, pomlčky a znak +' });
    }

    const contact = new Contact({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      name: name || '',
      email: email || '',
      phone: phone || '',
      company: company || '',
      website: website || '',
      notes: notes || '',
      status: status || 'new',
      files: [],
      tasks: []
    });

    await contact.save();

    const io = req.app.get('io');
    const contactData = contactToPlainObject(contact);
    io.to(`workspace-${req.workspaceId}`).emit('contact-created', contactData);

    // Send notification to workspace members except creator
    await notificationService.notifyContactChange('contact.created', contact, req.user, req.workspaceId);

    res.status(201).json(contactData);

    // Audit log (fire and forget)
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'contact.created',
      category: 'contact',
      targetType: 'contact',
      targetId: contact._id.toString(),
      targetName: contact.name,
      details: { name: contact.name, email: contact.email, company: contact.company },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Kopírovanie kontaktu (so VŠETKÝM — projekty/úlohy/podúlohy/prílohy) do INÉHO
// workspace, kde má user prístup. Vytvorí NEZÁVISLÚ kópiu (originál ostane).
//   - nové UUID pre kontakt (_id), všetky task/subtask id a file id →
//     kópia sa nepletie so zdrojom ani s Google sync mapami (tie sú user-scoped
//     kľúčované práve týmto UUID), preto sa kópia bude syncovať nanovo.
//   - prílohy sa FYZICKY duplikujú (blob R2/base64 → nový kľúč → nový ContactFile),
//     aby zmazanie jednej kópie nezhodilo druhú. Zvláda aj legacy base64.
//   - assignedTo sa filtruje len na členov cieľového workspace.
//   - žiadny Google sync (rovnako ako /duplicate); "už odoslané" reminder markery
//     sa resetujú. Stav dokončenia, termíny, poznámky a priority sa zachovajú.
// requireWorkspace validuje len ZDROJOVÝ workspace; cieľ overujeme manuálne
// (WorkspaceMember), aby sme negenerovali falošné cross-workspace IDOR alarmy.
// ─────────────────────────────────────────────────────────────────────────
router.post('/:id/copy-to-workspace', authenticateToken, requireWorkspace, async (req, res) => {
  let createdContactId = null;
  let idemKey = null;
  const targetWorkspaceId = req.body?.targetWorkspaceId;
  try {
    const sourceWorkspaceId = req.workspaceId;

    if (!targetWorkspaceId || !mongoose.Types.ObjectId.isValid(targetWorkspaceId)) {
      return res.status(400).json({ message: 'Chýba alebo neplatné cieľové prostredie' });
    }
    if (String(targetWorkspaceId) === String(sourceWorkspaceId)) {
      return res.status(400).json({ message: 'Cieľové prostredie je rovnaké ako zdrojové' });
    }

    // 1) Zdrojový kontakt — scoped na aktuálny (zdrojový) workspace
    const source = await Contact.findOne({ _id: req.params.id, workspaceId: sourceWorkspaceId });
    if (!source) return res.status(404).json({ message: 'Kontakt nenájdený' });

    // 2) Členstvo v cieľovom workspace (manuálne — nie cez X-Workspace-Id header)
    const targetMembership = await WorkspaceMember.findOne({ workspaceId: targetWorkspaceId, userId: req.user.id });
    if (!targetMembership) return res.status(403).json({ message: 'Do tohto prostredia nemáte prístup' });

    // 3) Limity CIEĽOVÉHO prostredia — podľa plánu VLASTNÍKA cieľa (nie žiadateľa),
    // aby sa cez copy nedal zaplaviť napr. Free workspace nad jeho strop.
    const targetWs = await Workspace.findById(targetWorkspaceId);
    if (!targetWs) return res.status(404).json({ message: 'Cieľové prostredie neexistuje' });
    const owner = await User.findById(targetWs.ownerId, 'subscription');
    const ownerPlan = owner?.subscription?.plan || 'free';

    // 3a) Member-over-limit (zrkadlí enforceWorkspaceLimits) — ak je cieľ nad
    // seat limitom vlastníka, je v read-only režime a nepridávame doň obsah.
    const memberLimits = { free: 2, trial: 2, team: 10 };
    if (ownerPlan !== 'pro') {
      const maxMembers = (memberLimits[ownerPlan] || 2) + (targetWs.paidSeats || 0);
      const memberCount = await WorkspaceMember.countDocuments({ workspaceId: targetWorkspaceId });
      if (memberCount > maxMembers) {
        return res.status(403).json({ message: 'Cieľové prostredie prekročilo limit členov a je len na čítanie.' });
      }
    }

    // 3b) Limit počtu kontaktov cieľa (plán vlastníka)
    const contactLimits = { free: 5, team: 25, pro: Infinity };
    const maxContacts = contactLimits[ownerPlan] || 5;
    if (maxContacts !== Infinity) {
      const count = await Contact.countDocuments({ workspaceId: targetWorkspaceId });
      if (count >= maxContacts) {
        return res.status(403).json({
          message: isIosNativeApp(req)
            ? `Cieľové prostredie dosiahlo limit ${maxContacts} kontaktov.`
            : `Cieľové prostredie dosiahlo limit ${maxContacts} kontaktov (plán vlastníka prostredia).`
        });
      }
    }

    // Platní členovia cieľa — na filtrovanie assignedTo (nečlenov ticho zahodíme)
    const targetMembers = await WorkspaceMember.find({ workspaceId: targetWorkspaceId }, 'userId').lean();
    const targetUserIds = new Set(targetMembers.map(m => String(m.userId)));
    const filterAssignees = (arr) => (Array.isArray(arr) ? arr.filter(uid => targetUserIds.has(String(uid))) : []);

    // Idempotencia — až PO validáciách (skoršie returny nesmú spáliť kľúč).
    // Explicitný kľúč posiela klient (jeden na otvorenie modálu + cieľ);
    // fallback okno 15 s chráni aj starších (cache-ovaných) klientov.
    const clientKey = typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey.trim()
      ? req.body.idempotencyKey.trim().slice(0, 100)
      : null;
    idemKey = clientKey
      ? `copyws:k:${clientKey}`
      : `copyws:f:${req.user.id}:${req.params.id}:${targetWorkspaceId}`;
    if (!claimMutationKey(idemKey, clientKey ? 5 * 60 * 1000 : 15 * 1000)) {
      idemKey = null; // kľúč drží prvý request — v catch ho neuvoľňovať
      return res.status(409).json({
        message: 'Kopírovanie tohto kontaktu už prebieha alebo práve prebehlo. Skontroluj cieľové prostredie skôr, než to skúsiš znova.'
      });
    }

    // 4) Vytvor kontakt v cieli (najprv prázdny — potrebujeme _id pre ContactFile)
    const newContact = new Contact({
      workspaceId: targetWorkspaceId,
      userId: req.user.id,
      name: source.name || '',
      email: source.email || '',
      phone: source.phone || '',
      company: source.company || '',
      website: source.website || '',
      notes: source.notes || '',
      status: source.status || 'new',
      files: [],
      tasks: []
    });
    await newContact.save();
    createdContactId = newContact._id;

    // Ohraničenie práce jedného requestu — pri veľa/veľkých prílohách by inak
    // sekvenčné R2 download+upload prekročilo request timeout / pamäť.
    const MAX_COPY_FILES = 80;
    const MAX_COPY_BYTES = 200 * 1024 * 1024; // 200 MB spolu
    const copyStats = { skippedError: 0, skippedCapped: 0, bytes: 0, count: 0 };

    // Skopíruj JEDEN súbor: blob (R2 → ContactFile.data → embedded legacy) →
    // nový fileId → nový R2 objekt / ContactFile riadok. Vráti nové metadata
    // alebo null. null z troch dôvodov: (a) zdroj naozaj nemá dáta (bezpečné
    // preskočenie), (b) prekročený cap, (c) reálna chyba pri kópii — (b)+(c)
    // sa POČÍTAJÚ a nahlásia klientovi (kópia je čiastočná).
    const copyOneFile = async (fileMeta) => {
      if (!fileMeta?.id) return null;
      if (copyStats.count >= MAX_COPY_FILES || copyStats.bytes >= MAX_COPY_BYTES) {
        copyStats.skippedCapped++;
        return null;
      }
      let buffer = null;
      try {
        const cf = await ContactFile.findOne({ fileId: fileMeta.id }, { r2Key: 1, data: 1 }).lean();
        if (cf?.r2Key && fileStorage.isR2Available()) buffer = await fileStorage.downloadFile(cf.r2Key);
        else if (cf?.data) buffer = Buffer.from(cf.data, 'base64');
        else if (fileMeta.data) buffer = Buffer.from(fileMeta.data, 'base64');
      } catch (e) {
        // Zdroj mal dáta (r2Key existoval), ale download zlyhal → REÁLNA chyba
        logger.warn('[Copy] Príloha — čítanie zdroja zlyhalo (preskakujem)', { fileId: fileMeta.id, error: e.message });
        copyStats.skippedError++;
        return null;
      }
      if (!buffer || !buffer.length) return null; // zdroj naozaj bez dát — OK

      try {
        const newFileId = uuidv4();
        if (fileStorage.isR2Available()) {
          const newKey = fileStorage.contactFileKey(newFileId);
          await fileStorage.uploadFile(newKey, buffer, fileMeta.mimetype || 'application/octet-stream');
          await ContactFile.create({ contactId: newContact._id, fileId: newFileId, r2Key: newKey, data: null });
        } else {
          await ContactFile.create({ contactId: newContact._id, fileId: newFileId, data: buffer.toString('base64') });
        }
        copyStats.count++;
        copyStats.bytes += buffer.length;
        return {
          id: newFileId,
          originalName: fileMeta.originalName,
          mimetype: fileMeta.mimetype,
          size: fileMeta.size,
          uploadedAt: fileMeta.uploadedAt || new Date()
        };
      } catch (e) {
        logger.warn('[Copy] Príloha — zápis kópie zlyhal (preskakujem)', { fileId: fileMeta.id, error: e.message });
        copyStats.skippedError++;
        return null;
      }
    };

    const copyFiles = async (files) => {
      const out = [];
      for (const f of (files || [])) {
        const nf = await copyOneFile(f);
        if (nf) out.push(nf);
      }
      return out;
    };

    // Rekurzívne — nested subtasks sú v schéme netypovaný Array (plain objekty)
    const copySubtasks = async (subs) => {
      const out = [];
      for (const s of (subs || [])) {
        out.push({
          id: uuidv4(),
          title: s.title,
          completed: !!s.completed,
          dueDate: s.dueDate || '',
          dueTime: s.dueTime || '',
          notes: s.notes || '',
          priority: s.priority ?? null,
          assignedTo: filterAssignees(s.assignedTo),
          subtasks: await copySubtasks(s.subtasks),
          files: await copyFiles(s.files),
          createdAt: new Date().toISOString(),
          modifiedAt: null,
          timeReminders: Array.isArray(s.timeReminders) ? [...s.timeReminders] : [],
          timeRemindersSent: [],
          reminderSent: false,
          lastUrgencyLevel: null
        });
      }
      return out;
    };

    const copyTasks = async (tasks) => {
      const out = [];
      for (const t of (tasks || [])) {
        out.push({
          id: uuidv4(),
          title: t.title,
          description: t.description || '',
          completed: !!t.completed,
          priority: t.priority || 'medium',
          dueDate: t.dueDate || '',
          dueTime: t.dueTime || '',
          assignedTo: filterAssignees(t.assignedTo),
          subtasks: await copySubtasks(t.subtasks),
          files: await copyFiles(t.files),
          createdAt: new Date().toISOString(),
          modifiedAt: null,
          timeReminders: Array.isArray(t.timeReminders) ? [...t.timeReminders] : [],
          timeRemindersSent: [],
          reminderSent: false,
          lastUrgencyLevel: null
        });
      }
      return out;
    };

    // Projekty kontaktu žijú na DVOCH miestach: embedded v contact.tasks a
    // ako samostatné Task dokumenty priradené cez contactIds (projekt
    // vytvorený na stránke Úlohy a až potom priradený kontaktu). CRM oboje
    // zobrazuje ako projekty kontaktu — kópia musí obsahovať oboje, inak sa
    // kontakt "prenesie bez projektov". V cieli sa stanú embedded projektmi
    // kópie (referencie medzi prostrediami neexistujú).
    const linkedGlobalTasks = await Task.find({
      workspaceId: sourceWorkspaceId,
      contactIds: String(source._id)
    }).lean();

    // 5) Naplň kópiu obsahom (kontakt-level prílohy + projekty so všetkým)
    newContact.files = await copyFiles(source.files);
    newContact.tasks = [
      ...(await copyTasks(source.tasks)),
      ...(await copyTasks(linkedGlobalTasks))
    ];
    newContact.markModified('files');
    newContact.markModified('tasks');
    await newContact.save();

    // 6) Emit do CIEĽOVÉHO workspace (nie zdrojového — kópia je tam)
    const io = req.app.get('io');
    const plain = contactToPlainObject(newContact);
    io.to(`workspace-${targetWorkspaceId}`).emit('contact-created', plain);

    // Invaliduj cache CIEĽOVÉHO workspace — auto-invalidate wrapper čistí len
    // req.workspaceId (zdroj), takže cieľové listy by ostali stale (30s-2min).
    try {
      invalidateWorkspaceData(targetWorkspaceId, 'contacts');
      invalidateWorkspaceData(targetWorkspaceId, 'tasks');
    } catch { /* cache invalidation best-effort */ }

    const skippedFiles = copyStats.skippedError + copyStats.skippedCapped;
    logger.info('[Copy] Kontakt skopírovaný do iného workspace', {
      sourceContactId: String(source._id),
      newContactId: String(newContact._id),
      sourceWs: String(sourceWorkspaceId),
      targetWs: String(targetWorkspaceId),
      tasks: newContact.tasks.length,
      filesCopied: copyStats.count,
      filesSkipped: skippedFiles
    });

    // Audit log (cross-tenant akcia — patrí do audit trailu)
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'contact.copied',
      category: 'contact',
      targetType: 'contact',
      targetId: String(newContact._id),
      targetName: newContact.name,
      details: {
        sourceContactId: String(source._id),
        sourceWorkspaceId: String(sourceWorkspaceId),
        targetWorkspaceId: String(targetWorkspaceId),
        filesCopied: copyStats.count,
        filesSkipped: skippedFiles
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: targetWorkspaceId
    });

    return res.status(201).json({
      message: 'Kontakt skopírovaný',
      contact: plain,
      targetWorkspaceId: String(targetWorkspaceId),
      skippedFiles // klient upozorní, ak sa nejaké prílohy nepodarilo skopírovať
    });
  } catch (error) {
    logger.error('[Copy] Kopírovanie kontaktu zlyhalo', { error: error.message, stack: error.stack });
    // Po reálnej chybe uvoľni idempotency kľúč — retry musí prejsť
    if (idemKey) releaseMutationKey(idemKey);
    // Cleanup — nenechať polovičný kontakt v cieli. Zmažeme aj R2 objekty
    // (nielen ContactFile riadky), nech nezostanú orphan bloby.
    if (createdContactId) {
      (async () => {
        try {
          const rows = await ContactFile.find({ contactId: createdContactId }, { r2Key: 1 }).lean();
          for (const r of rows) {
            if (r.r2Key) await fileStorage.deleteFile(r.r2Key).catch(() => {});
          }
          await ContactFile.deleteMany({ contactId: createdContactId }).catch(() => {});
          await Contact.deleteOne({ _id: createdContactId, workspaceId: targetWorkspaceId }).catch(() => {});
        } catch { /* best-effort cleanup */ }
      })();
    }
    return res.status(500).json({ message: 'Kopírovanie kontaktu zlyhalo' });
  }
});

// Update contact
// Status change na 'cancelled' alebo 'completed' = deal sa neuskutočnil /
// je zavretý, takže aj všetky otvorené úlohy a podúlohy pod kontaktom, ktoré
// boli zosynchronizované do Google Calendara a Google Tasks, už nemajú v
// používateľovom kalendári čo hľadať — inak tam visia ako ghost-eventy,
// stále pending, a používateľ ich musí manuálne odklikávať vo dvoch
// aplikáciach zvlášť.
//
// Rovnaký cascade helper ako pri hard-delete — walk cez tasks[].subtasks[]
// → autoDeleteContactFromGoogle per id → paralelné calendar.events.delete +
// tasks.tasks.delete. Používateľovo mapping (syncedTaskIds) je user-scoped,
// takže cleanup funguje aj bez toho, aby sa Contact dokument mazal.
const TERMINAL_STATUSES = new Set(['cancelled', 'completed']);

router.put('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { name, email, phone, company, website, notes, status } = req.body;

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: 'Neplatný formát emailu' });
    }

    if (phone && !isValidPhone(phone)) {
      return res.status(400).json({ message: 'Telefón môže obsahovať len čísla, medzery, pomlčky a znak +' });
    }

    // Načítame pôvodný kontakt PRED updatom — potrebujeme:
    //   1. starý status na detekciu prechodu → terminal,
    //   2. celý strom tasks/subtasks, ktorý po update-e stále existuje
    //      (status change nemaže tasks) a z ktorého vyčítame ids pre cascade
    //      Google cleanup. Keby sme si strom neuložili pred update-om, boli
    //      by sme závislí od toho, že `findOneAndUpdate` ho vráti — čo síce
    //      vracia (new: true), ale čistejšie je oddeliť read a write.
    const previousContact = await Contact.findOne(
      { _id: req.params.id, workspaceId: req.workspaceId }
    );

    if (!previousContact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const previousStatus = previousContact.status;

    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspaceId },
      {
        name, email, phone, company, website, notes, status
      },
      { new: true }
    );

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    // Detekcia prechodu na terminálny status (zrušený / dokončený).
    // Spustíme cascade iba pri ZMENE statusu — ak už bol kontakt dlhodobo
    // 'cancelled' a user len edituje poznámku, nepúšťame opäť delete cez
    // Google API (mapping by aj tak bol prázdny, ale ušetríme kopec zbytočných
    // 404-tok a log šumu).
    const becameTerminal = status
      && TERMINAL_STATUSES.has(status)
      && !TERMINAL_STATUSES.has(previousStatus);

    if (becameTerminal) {
      // Fire-and-forget — response nečakáme na Google, aby UI nebolo blokované
      // niekoľkými sekundami kým paralelné events.delete / tasks.delete
      // dobehnú. Chyby sú zalogované vnútri helperu.
      autoDeleteAllTasksOfContactFromGoogle(previousContact);
    }

    const io = req.app.get('io');
    const contactData = contactToPlainObject(contact);
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactData);

    // Send notification to workspace members except updater
    await notificationService.notifyContactChange('contact.updated', contact, req.user, req.workspaceId);

    res.json(contactData);

    // Audit log (fire and forget)
    const changedFields = Object.keys(req.body).filter(k => req.body[k] !== undefined);
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'contact.updated',
      category: 'contact',
      targetType: 'contact',
      targetId: contact._id.toString(),
      targetName: contact.name,
      details: { changedFields },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete contact
router.delete('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    // Store contact data for notification before deletion
    const contactData = { _id: contact._id, name: contact.name };

    // Cascade cleanup to Google BEFORE removing the contact from Mongo.
    // If we deleted first, autoSync would have no workspace context to look
    // up (task is gone) and the events would orphan forever in Google.
    autoDeleteAllTasksOfContactFromGoogle(contact);

    // Cascade: zmaž aj prílohy v ContactFile kolekcii + R2 objects.
    // Bez tohto zostanú orphaned files (MongoDB base64 alebo R2 objects)
    // aj po zmazaní kontaktu. R2 účtuje per-GB, nie per-object, ale aj tak
    // sa hromadí storage cost ak by sme to nemazali.
    if (fileStorage.isR2Available()) {
      // Najprv získať všetky r2Keys patriace k tomuto kontaktu
      const r2Files = await ContactFile.find(
        { contactId: req.params.id, r2Key: { $ne: null } },
        { r2Key: 1 }
      ).lean();
      // Paralel delete z R2 (fire-and-forget, individual errors logged inside)
      Promise.all(r2Files.map(cf => fileStorage.deleteFile(cf.r2Key))).catch(() => {});
    }
    await ContactFile.deleteMany({ contactId: req.params.id });
    await Contact.findByIdAndDelete(req.params.id);

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-deleted', { id: req.params.id });

    // Send notification to workspace members except deleter
    await notificationService.notifyContactChange('contact.deleted', contactData, req.user, req.workspaceId);

    res.json({ message: 'Contact deleted' });

    // Audit log (fire and forget)
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'contact.deleted',
      category: 'contact',
      targetType: 'contact',
      targetId: req.params.id,
      targetName: contactData.name,
      details: { name: contactData.name },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ==================== TASKS ====================

// Add task to contact
router.post('/:contactId/tasks', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
  try {
    const { title, description, dueDate, dueTime, priority, assignedTo } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Názov projektu je povinný' });
    }

    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const now = new Date().toISOString();
    const task = {
      id: uuidv4(),
      title: title.trim(),
      description: description || '',
      dueDate: dueDate || null,
      dueTime: dueDate ? (dueTime || '') : '',
      priority: priority || 'medium',
      completed: false,
      assignedTo: assignedTo || [],
      subtasks: [],
      createdAt: now,
      modifiedAt: now // Set on creation for "new" filter
    };

    contact.tasks.push(task);
    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-sync to Google
    autoSyncContactToGoogle({
      id: task.id,
      title: task.title,
      description: task.description,
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      completed: task.completed,
      assignedTo: task.assignedTo,
      workspaceId: req.workspaceId?.toString(),
      contact: contact.name
    }, 'create');

    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update task
router.put('/:contactId/tasks/:taskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { title, description, dueDate, dueTime, priority, completed, assignedTo } = req.body;

    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const task = contact.tasks[taskIndex];
    // KRITICKÝ FIX: Mongoose subdoc spread {...task} nepreserve schema fields
    // (vracia interné _doc/$__ properties). Bez .toObject() by sa stratili
    // files, notes, lastUrgencyLevel pri každom edit-e tasku cez tento route.
    const taskPlain = typeof task.toObject === 'function' ? task.toObject() : task;
    contact.tasks[taskIndex] = {
      ...taskPlain,
      id: task.id,
      title: title !== undefined ? title : task.title,
      description: description !== undefined ? description : task.description,
      dueDate: dueDate !== undefined ? dueDate : task.dueDate,
      dueTime: dueTime !== undefined ? (dueDate !== undefined ? (dueDate ? dueTime : '') : dueTime) : (task.dueTime || ''),
      priority: priority !== undefined ? priority : task.priority,
      completed: completed !== undefined ? completed : task.completed,
      assignedTo: assignedTo !== undefined ? assignedTo : task.assignedTo,
      subtasks: req.body.subtasks !== undefined ? req.body.subtasks : task.subtasks,
      createdAt: task.createdAt,
      modifiedAt: new Date().toISOString()
    };

    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-sync to Google
    const updatedTask = contact.tasks[taskIndex];
    autoSyncContactToGoogle({
      id: updatedTask.id,
      title: updatedTask.title,
      description: updatedTask.description,
      dueDate: updatedTask.dueDate,
      dueTime: updatedTask.dueTime,
      completed: updatedTask.completed,
      assignedTo: updatedTask.assignedTo,
      workspaceId: req.workspaceId?.toString(),
      contact: contact.name
    }, 'update');

    res.json(contact.tasks[taskIndex]);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete task
router.delete('/:contactId/tasks/:taskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Snapshot before splice so we can walk the subtask tree for cleanup.
    const deletedTask = contact.tasks[taskIndex];
    contact.tasks.splice(taskIndex, 1);
    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-delete from Google (cascades to nested subtasks so nothing orphans).
    autoDeleteTaskTreeFromGoogle(deletedTask);

    res.json({ message: 'Task deleted' });
  } catch (error) {
    logger.error('Delete task error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Add subtask to task
router.post('/:contactId/tasks/:taskId/subtasks', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
  try {
    const { title, parentSubtaskId, dueDate, dueTime, notes, priority } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Nazov ulohy je povinny' });
    }

    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check plan limit for subtasks per task
    const user = await User.findById(req.user.id);
    const plan = user?.subscription?.plan || 'free';
    const subtaskLimits = { free: 10, team: 25, pro: Infinity };
    const maxSubtasks = subtaskLimits[plan] || 10;
    if (maxSubtasks !== Infinity) {
      const countSubtasks = (subs) => (subs || []).reduce((sum, s) => sum + 1 + countSubtasks(s.subtasks), 0);
      if (countSubtasks(contact.tasks[taskIndex].subtasks) >= maxSubtasks) {
        return res.status(403).json({ message: `Váš plán umožňuje max. ${maxSubtasks} úloh na projekt. Pre viac prejdite na vyšší plán.` });
      }
    }

    const now = new Date().toISOString();
    const subtask = {
      id: uuidv4(),
      title: title.trim(),
      completed: false,
      dueDate: dueDate || null,
      dueTime: dueDate ? (dueTime || '') : '',
      notes: notes || '',
      priority: priority || null,
      subtasks: [],
      createdAt: now,
      modifiedAt: now // Set on creation for "new" filter
    };

    const task = contact.tasks[taskIndex];

    if (parentSubtaskId) {
      const found = findSubtaskRecursive(task.subtasks, parentSubtaskId);
      if (found) {
        if (!found.subtask.subtasks) {
          found.subtask.subtasks = [];
        }
        found.subtask.subtasks.push(subtask);
        // Update parent subtask's modifiedAt when child is added
        found.subtask.modifiedAt = now;
      } else {
        return res.status(404).json({ message: 'Parent subtask not found' });
      }
    } else {
      if (!task.subtasks) {
        task.subtasks = [];
      }
      task.subtasks.push(subtask);
    }

    // Update parent task's modifiedAt when subtask is added
    task.modifiedAt = now;

    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-sync subtask to Google
    autoSyncContactToGoogle({
      id: subtask.id,
      title: `${subtask.title} (${task.title})`,
      description: subtask.notes,
      dueDate: subtask.dueDate,
      dueTime: subtask.dueTime,
      completed: subtask.completed,
      assignedTo: task.assignedTo || [],
      workspaceId: req.workspaceId?.toString(),
      contact: contact.name
    }, 'create');

    res.status(201).json(subtask);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update subtask
router.put('/:contactId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { title, completed, dueDate, dueTime, notes } = req.body;

    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const task = contact.tasks[taskIndex];
    const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);

    if (!found) {
      return res.status(404).json({ message: 'Subtask not found' });
    }

    found.parent[found.index] = {
      ...found.subtask,
      id: found.subtask.id, // Ensure ID is preserved
      title: title !== undefined ? title : found.subtask.title,
      completed: completed !== undefined ? completed : found.subtask.completed,
      dueDate: dueDate !== undefined ? dueDate : found.subtask.dueDate,
      dueTime: dueTime !== undefined ? (dueDate !== undefined ? (dueDate ? dueTime : '') : dueTime) : (found.subtask.dueTime || ''),
      notes: notes !== undefined ? notes : found.subtask.notes,
      priority: found.subtask.priority, // Preserve priority
      subtasks: found.subtask.subtasks || [], // Preserve nested subtasks
      createdAt: found.subtask.createdAt, // Preserve createdAt
      modifiedAt: new Date().toISOString() // Set modification timestamp
    };

    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Auto-sync subtask to Google
    const updatedSubtask = found.parent[found.index];
    autoSyncContactToGoogle({
      id: updatedSubtask.id,
      title: `${updatedSubtask.title} (${task.title})`,
      description: updatedSubtask.notes,
      dueDate: updatedSubtask.dueDate,
      dueTime: updatedSubtask.dueTime,
      completed: updatedSubtask.completed,
      assignedTo: task.assignedTo || [],
      workspaceId: req.workspaceId?.toString(),
      contact: contact.name
    }, 'update');

    res.json(found.parent[found.index]);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete subtask
router.delete('/:contactId/tasks/:taskId/subtasks/:subtaskId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });

    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const taskIndex = contact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const task = contact.tasks[taskIndex];
    const found = findSubtaskRecursive(task.subtasks, req.params.subtaskId);

    if (!found) {
      return res.status(404).json({ message: 'Subtask not found' });
    }

    // Snapshot the subtask (with any nested sub-subtasks) before splicing
    // so we can cascade the Google cleanup properly.
    const deletedSubtask = found.subtask;
    found.parent.splice(found.index, 1);

    contact.markModified('tasks');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    // Cascades to nested sub-subtasks so no orphan events remain.
    autoDeleteTaskTreeFromGoogle(deletedSubtask);

    res.json({ message: 'Subtask deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ==================== TRANSFER: KOPÍROVANIE / PRESUN DO INÉHO PROJEKTU ====================
//
// Prenesie projekt (:taskId) alebo úlohu/podúlohu (body.subtaskId, ľubovoľná
// hĺbka) do projektového stromu iného kontaktu V RÁMCI TOHO ISTÉHO workspace.
//
// Body: { subtaskId?, targetContactId, targetTaskId?, mode: 'copy'|'move' }
//  - targetTaskId zadané  → vloží sa DO projektu (ako úloha najvyššej úrovne)
//  - targetTaskId chýba   → vloží sa ako NOVÝ PROJEKT cieľového kontaktu
//  - úroveň sa automaticky prispôsobí (projekt↔úloha, description↔notes)
//
// copy → nové UUID + fyzická kópia príloh + reset reminder príznakov
//        + copiedFrom odkaz na originál (viď deepCopyNodeForTransfer)
// move → UUID/prílohy/reminder stav zachované; ContactFile.contactId sa
//        prepne na cieľ (inak by zmazanie zdrojového kontaktu zmazalo bloby
//        presunutej úlohy — delete kaskáduje podľa contactId)
router.post('/:contactId/tasks/:taskId/transfer', authenticateToken, requireWorkspace, enforceWorkspaceLimits, async (req, res) => {
  const createdFiles = []; // bloby vytvorené TÝMTO requestom — pre error cleanup
  let idemKey = null;
  try {
    const { subtaskId, targetContactId, targetTaskId, mode } = req.body || {};

    if (mode !== 'copy' && mode !== 'move') {
      return res.status(400).json({ message: 'Neplatný režim (copy/move)' });
    }
    if (!targetContactId || !mongoose.Types.ObjectId.isValid(targetContactId)) {
      return res.status(400).json({ message: 'Chýba alebo neplatný cieľový kontakt' });
    }

    const sourceContact = await Contact.findOne({ _id: req.params.contactId, workspaceId: req.workspaceId });
    if (!sourceContact) return res.status(404).json({ message: 'Kontakt nenájdený' });

    const sameContact = String(targetContactId) === String(sourceContact._id);
    const targetContact = sameContact
      ? sourceContact
      : await Contact.findOne({ _id: targetContactId, workspaceId: req.workspaceId });
    if (!targetContact) return res.status(404).json({ message: 'Cieľový kontakt nenájdený' });

    // Zdrojový uzol
    const taskIndex = sourceContact.tasks.findIndex(t =>
      t.id === req.params.taskId || (t._id && t._id.toString() === req.params.taskId)
    );
    if (taskIndex === -1) return res.status(404).json({ message: 'Projekt nenájdený' });
    const sourceTask = sourceContact.tasks[taskIndex];

    let sourceFound = null; // { subtask, parent, index } pri podúlohe
    if (subtaskId) {
      sourceFound = findSubtaskRecursive(sourceTask.subtasks, subtaskId);
      if (!sourceFound) return res.status(404).json({ message: 'Úloha nenájdená' });
    }
    const sourceNodeDoc = subtaskId ? sourceFound.subtask : sourceTask;
    // Plain deep-copy — Mongoose subdoc sa nesmie spreadovať priamo (viď PUT task)
    const sourceNode = JSON.parse(JSON.stringify(
      typeof sourceNodeDoc.toObject === 'function' ? sourceNodeDoc.toObject() : sourceNodeDoc
    ));

    // Cieľový projekt (ak nejde o "nový projekt")
    let targetTask = null;
    if (targetTaskId) {
      const ti = targetContact.tasks.findIndex(t =>
        t.id === targetTaskId || (t._id && t._id.toString() === targetTaskId)
      );
      if (ti === -1) return res.status(404).json({ message: 'Cieľový projekt nenájdený' });
      targetTask = targetContact.tasks[ti];
    }

    // Nezmyselné kombinácie
    if (!subtaskId && targetTask && sameContact && targetTask.id === sourceTask.id) {
      return res.status(400).json({ message: 'Projekt nemožno vložiť do seba samého' });
    }
    if (mode === 'move' && !subtaskId && !targetTask && sameContact) {
      return res.status(400).json({ message: 'Projekt už patrí tomuto kontaktu' });
    }

    // Limity plánu na CIEĽOVEJ strane (zrkadlí bežné vytváranie)
    const user = await User.findById(req.user.id);
    const plan = user?.subscription?.plan || 'free';
    if (!targetTask) {
      const taskLimits = { free: 5, team: 25, pro: Infinity };
      const maxTasks = taskLimits[plan] || 5;
      if (maxTasks !== Infinity && (targetContact.tasks?.length || 0) >= maxTasks) {
        return res.status(403).json({
          message: isIosNativeApp(req)
            ? `Cieľový kontakt dosiahol limit ${maxTasks} projektov.`
            : `Váš plán umožňuje max. ${maxTasks} projektov na kontakt. Pre viac prejdite na vyšší plán.`
        });
      }
      // Aj KÓPIA ako nový projekt musí rešpektovať limit podúloh — inak by sa
      // opakovaným kopírovaním dal množiť obsah nad strop, ktorý bežné
      // vytváranie vynucuje. Presun obsah nemení, preto sa nekontroluje.
      const subtaskLimits = { free: 10, team: 25, pro: Infinity };
      const maxSubtasks = subtaskLimits[plan] || 10;
      if (mode === 'copy' && maxSubtasks !== Infinity && countTreeNodes(sourceNode) - 1 > maxSubtasks) {
        return res.status(403).json({
          message: isIosNativeApp(req)
            ? `Prenášaný projekt prekračuje limit ${maxSubtasks} úloh.`
            : `Váš plán umožňuje max. ${maxSubtasks} úloh na projekt. Pre viac prejdite na vyšší plán.`
        });
      }
    } else {
      // Presun v rámci TOHO ISTÉHO projektu nemení celkový počet podúloh
      const sameProject = mode === 'move' && subtaskId && sameContact && targetTask.id === sourceTask.id;
      if (!sameProject) {
        const subtaskLimits = { free: 10, team: 25, pro: Infinity };
        const maxSubtasks = subtaskLimits[plan] || 10;
        if (maxSubtasks !== Infinity) {
          const countSubtasks = (subs) => (subs || []).reduce((sum, s) => sum + 1 + countSubtasks(s.subtasks), 0);
          if (countSubtasks(targetTask.subtasks) + countTreeNodes(sourceNode) > maxSubtasks) {
            return res.status(403).json({
              message: isIosNativeApp(req)
                ? `Cieľový projekt by prekročil limit ${maxSubtasks} úloh.`
                : `Váš plán umožňuje max. ${maxSubtasks} úloh na projekt. Pre viac prejdite na vyšší plán.`
            });
          }
        }
      }
    }

    // Idempotencia — dvojklik nesmie vytvoriť duplikát (klientsky busy state
    // je asynchrónny). Krátke okno; kľúč sa pri chybe uvoľní.
    idemKey = `transfer:${req.user.id}:${req.params.contactId}:${req.params.taskId}:${subtaskId || ''}:${targetContactId}:${targetTaskId || ''}:${mode}`;
    if (!claimMutationKey(idemKey, 15 * 1000)) {
      idemKey = null; // kľúč drží prvý request — v catch ho neuvoľňovať
      return res.status(409).json({
        message: 'Rovnaká operácia práve prebehla. Ak chceš ďalšiu kópiu, počkaj pár sekúnd a skús znova.'
      });
    }

    const now = new Date().toISOString();
    const copyStats = { skippedError: 0, skippedCapped: 0, bytes: 0, count: 0 };
    let insertedNode;

    if (mode === 'copy') {
      insertedNode = await deepCopyNodeForTransfer(sourceNode, {
        asTask: !targetTask,
        sourceContactId: sourceContact._id,
        targetContactId: targetContact._id,
        stats: copyStats,
        createdFiles
      });
      insertedNode.modifiedAt = now; // "new" filter zvýrazní čerstvú kópiu
      insertedNode.copiedFrom = {
        contactId: String(sourceContact._id),
        contactName: sourceContact.name || '',
        taskId: sourceTask.id,
        subtaskId: subtaskId || null,
        copiedAt: now
      };
    } else {
      insertedNode = remapNodeLevelForMove(sourceNode, { asTask: !targetTask });
      insertedNode.modifiedAt = now;
    }

    // Poradie zápisov: najprv vlož do cieľa, až potom (pri move) odstráň zo
    // zdroja — pri páde medzi zápismi radšej dočasný duplikát než stratený strom.
    if (targetTask) {
      if (!targetTask.subtasks) targetTask.subtasks = [];
      targetTask.subtasks.push(insertedNode);
      targetTask.modifiedAt = now;
    } else {
      targetContact.tasks.push(insertedNode);
    }

    if (mode === 'move') {
      if (subtaskId) {
        sourceFound.parent.splice(sourceFound.index, 1);
        sourceTask.modifiedAt = now;
      } else {
        sourceContact.tasks.splice(taskIndex, 1);
      }
    }

    targetContact.markModified('tasks');
    if (sameContact) {
      await sourceContact.save(); // ten istý dokument — jeden zápis
    } else {
      await targetContact.save();
      if (mode === 'move') {
        sourceContact.markModified('tasks');
        try {
          await sourceContact.save();
        } catch (e) {
          // Kompenzácia — odstráň vložený uzol z cieľa, nech nevznikne duplikát
          try {
            const arr = targetTask ? targetTask.subtasks : targetContact.tasks;
            const i = arr.findIndex(n => n.id === insertedNode.id);
            if (i !== -1) arr.splice(i, 1);
            targetContact.markModified('tasks');
            await targetContact.save();
          } catch { /* best-effort */ }
          throw e;
        }
      }
    }

    // Pri presune medzi kontaktmi prepni vlastníka blobov príloh — download
    // ide podľa fileId (funguje aj bez toho), ale delete kontaktu kaskáduje
    // podľa contactId a zmazal by bloby presunutej úlohy.
    if (mode === 'move' && !sameContact) {
      const fileIds = collectFileIdsFromNode(sourceNode);
      if (fileIds.length > 0) {
        // Scope na zdrojový kontakt — bez neho by klientom editovateľné
        // metadáta files[] dovolili prepnúť (a neskôr kaskádou zmazať)
        // cudzie bloby len na základe uhádnutého fileId.
        const repoint = () => ContactFile.updateMany(
          { fileId: { $in: fileIds }, contactId: sourceContact._id },
          { $set: { contactId: targetContact._id } }
        );
        try {
          await repoint();
        } catch (err) {
          // Jeden retry; potom error (nie warn) — bez prepnutia by zmazanie
          // zdrojového kontaktu zničilo bloby presunutej úlohy.
          try {
            await repoint();
          } catch (err2) {
            logger.error('[Transfer] Prepnutie príloh na cieľový kontakt zlyhalo (aj po retry)', {
              error: err2.message,
              fileIds,
              sourceContactId: String(sourceContact._id),
              targetContactId: String(targetContact._id)
            });
          }
        }
      }
    }

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(targetContact));
    if (mode === 'move' && !sameContact) {
      io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(sourceContact));
    }

    // Google sync: pri PRESUNE sa mení kontext (meno kontaktu / názov
    // nadradeného projektu v titulku) — obnov event presunutého uzla.
    // Kópie sa nesyncujú (konzistentné s copy-to-workspace) — zachytí ich
    // najbližší bulk sync alebo prvá editácia.
    if (mode === 'move') {
      autoSyncContactToGoogle(targetTask ? {
        id: insertedNode.id,
        title: `${insertedNode.title} (${targetTask.title})`,
        description: insertedNode.notes || '',
        dueDate: insertedNode.dueDate,
        dueTime: insertedNode.dueTime,
        completed: insertedNode.completed,
        assignedTo: targetTask.assignedTo || [],
        workspaceId: req.workspaceId?.toString(),
        contact: targetContact.name
      } : {
        id: insertedNode.id,
        title: insertedNode.title,
        description: insertedNode.description || '',
        dueDate: insertedNode.dueDate,
        dueTime: insertedNode.dueTime,
        completed: insertedNode.completed,
        assignedTo: insertedNode.assignedTo || [],
        workspaceId: req.workspaceId?.toString(),
        contact: targetContact.name
      }, 'update');
    }

    const skippedFiles = copyStats.skippedError + copyStats.skippedCapped;
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: mode === 'copy' ? 'task.copied' : 'task.moved',
      category: 'task',
      targetType: 'task',
      targetId: insertedNode.id,
      targetName: insertedNode.title,
      details: {
        mode,
        level: subtaskId ? 'subtask' : 'project',
        sourceContactId: String(sourceContact._id),
        targetContactId: String(targetContact._id),
        sourceTaskId: sourceTask.id,
        sourceSubtaskId: subtaskId || null,
        targetTaskId: targetTask ? targetTask.id : null,
        filesCopied: copyStats.count,
        filesSkipped: skippedFiles
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId
    });

    return res.status(mode === 'copy' ? 201 : 200).json({
      message: mode === 'copy' ? 'Skopírované' : 'Presunuté',
      mode,
      newId: insertedNode.id,
      targetContactId: String(targetContact._id),
      targetTaskId: targetTask ? targetTask.id : null,
      skippedFiles
    });
  } catch (error) {
    logger.error('[Transfer] Kopírovanie/presun položky zlyhalo', { error: error.message, stack: error.stack });
    // Po reálnej chybe uvoľni idempotency kľúč — retry musí prejsť
    if (idemKey) releaseMutationKey(idemKey);
    // Cleanup — zmaž LEN bloby vytvorené týmto requestom (nie existujúce
    // prílohy cieľového kontaktu!)
    if (createdFiles.length > 0) {
      (async () => {
        try {
          for (const f of createdFiles) {
            if (f.r2Key) await fileStorage.deleteFile(f.r2Key).catch(() => {});
          }
          await ContactFile.deleteMany({ fileId: { $in: createdFiles.map(f => f.fileId) } }).catch(() => {});
        } catch { /* best-effort cleanup */ }
      })();
    }
    return res.status(500).json({ message: 'Operácia zlyhala' });
  }
});

// ==================== FILE UPLOAD ====================

// Upload file to contact (stored in MongoDB as Base64)
router.post('/:id/files', authenticateToken, requireWorkspace, enforceWorkspaceLimits, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    try {
      // Handle multer errors
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ message: 'Súbor je príliš veľký. Maximum je 10MB.' });
        }
        return res.status(400).json({ message: err.message || 'Chyba pri nahrávaní súboru' });
      }

      // Plan-feature gate: file attachments len pre Tím+. Plus per-plan
      // celková storage kvóta (Tím=1GB, Pro=10GB).
      const uploader = await User.findById(req.user.id).select('subscription').lean();
      const uploaderPlan = uploader?.subscription?.plan || 'free';
      if (uploaderPlan === 'free' || uploaderPlan === 'trial') {
        const message = isIosNativeApp(req)
          // Apple 3.1.1 — iOS bez akejkoľvek zmienky o pláne / tier.
          ? 'Táto funkcia nie je dostupná.'
          : 'Pripájanie súborov je dostupné v plánoch Tím a Pro. Upgradujte plán pre prístup.';
        return res.status(403).json({ message, code: 'FEATURE_NOT_IN_PLAN' });
      }

      const contact = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
      if (!contact) {
        return res.status(404).json({ message: 'Contact not found' });
      }

      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      // Per-plan total storage quota check (workspace-scope). Tím = 1 GB,
      // Pro = 10 GB. Sčítame size existujúcich files všetkých kontaktov vo
      // workspace + chystaný upload size.
      const storageLimits = { team: 1024 * 1024 * 1024, pro: 10 * 1024 * 1024 * 1024 };
      const storageBytes = storageLimits[uploaderPlan];
      if (storageBytes) {
        const wsContacts = await Contact.find({ workspaceId: req.workspaceId }, 'files.size').lean();
        const usedBytes = wsContacts.reduce((sum, c) => sum + (c.files || []).reduce((s, f) => s + (f.size || 0), 0), 0);
        if (usedBytes + req.file.size > storageBytes) {
          const usedMb = Math.round(usedBytes / (1024 * 1024));
          const limitMb = Math.round(storageBytes / (1024 * 1024));
          const message = isIosNativeApp(req)
            ? `Dosiahli ste storage limit (${usedMb}/${limitMb} MB).`
            : `Dosiahli ste storage limit pre váš plán (${usedMb}/${limitMb} MB). Upgradujte plán pre vyšší limit.`;
          return res.status(403).json({ message, code: 'STORAGE_LIMIT' });
        }
      }

      // Convert file buffer to Base64
      const base64Data = req.file.buffer.toString('base64');
      const fileId = uuidv4();

      // customName — voliteľný vlastný názov z UI (user prepíše "image.jpg").
      // Frontend posiela hotový názov vrátane prípony. Fallback na pôvodný.
      const customName = (req.body.customName || '').trim().slice(0, 200);

      const fileData = {
        id: fileId,
        originalName: customName || req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date()
      };

      // Storage strategy: R2 preferred, base64-MongoDB fallback.
      // R2 = ~5 MB pravý binary blob; MongoDB base64 = 6.65 MB string (33%
      // expanzia). Po naplnení Atlas free tier-u presúvame všetky nové
      // uploady do R2. Legacy files (data field) stále podporujeme v
      // download flow-e.
      if (fileStorage.isR2Available()) {
        const r2Key = fileStorage.contactFileKey(fileId);
        await fileStorage.uploadFile(r2Key, req.file.buffer, req.file.mimetype);
        await ContactFile.create({
          contactId: contact._id,
          fileId: fileId,
          r2Key: r2Key,
          data: null
        });
        logger.debug('[Contact upload] Stored in R2', { fileId, r2Key, size: req.file.size });
      } else {
        await ContactFile.create({
          contactId: contact._id,
          fileId: fileId,
          data: base64Data
        });
        logger.warn('[Contact upload] R2 unavailable, stored as base64 in MongoDB', { fileId });
      }

      // Only store metadata in Contact (no data field)
      contact.files.push(fileData);
      await contact.save();

      const io = req.app.get('io');
      if (io) {
        io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));
      }

      // Don't send the data field back to client (too large)
      const responseData = {
        id: fileData.id,
        originalName: fileData.originalName,
        mimetype: fileData.mimetype,
        size: fileData.size,
        uploadedAt: fileData.uploadedAt
      };

      res.status(201).json(responseData);
    } catch (error) {
      logger.error('File upload error', { error: error.message });
      res.status(500).json({ message: 'Chyba servera' });
    }
  });
});

// Download file (from ContactFile collection or legacy Contact.files.data)
router.get('/:id/files/:fileId/download', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { id: contactId, fileId } = req.params;
    logger.info('Contact file download request', { contactId, fileId });

    // Load contact with file metadata only (no Base64 data)
    const contact = await Contact.findOne(
      { _id: contactId, workspaceId: req.workspaceId },
      { files: 1, 'tasks.id': 1, 'tasks.files': 1, 'tasks.subtasks': 1 }
    ).lean();
    if (!contact) {
      logger.warn('Contact file download: contact not found', { contactId });
      return res.status(404).json({ message: 'Contact not found' });
    }

    // Search in contact-level files first
    let fileMeta = (contact.files || []).find(f => f.id === fileId);

    // If not found, search in contact task files
    if (!fileMeta) {
      const findFileInTasks = (tasks) => {
        if (!Array.isArray(tasks)) return null;
        for (const t of tasks) {
          const f = (t.files || []).find(f => f.id === fileId);
          if (f) return f;
          if (Array.isArray(t.subtasks)) {
            const found = findFileInTasks(t.subtasks);
            if (found) return found;
          }
        }
        return null;
      };
      fileMeta = findFileInTasks(contact.tasks);
    }

    if (!fileMeta) {
      logger.warn('Contact file download: file metadata not found', {
        contactId, fileId,
        contactFileCount: (contact.files || []).length,
        contactFileIds: (contact.files || []).map(f => f.id),
      });
      return res.status(404).json({ message: 'File not found' });
    }

    // 3-tier resolution v poradí preference:
    //   1. R2 (r2Key set) — primary storage, najmenšie ConsumeR, žiadny
    //      base64 overhead, scaluje do nekonečna
    //   2. ContactFile.data (legacy base64) — pre files pred-R2-migrácie
    //   3. fileMeta.data (very-legacy embedded v Contact docu)
    let fileBuffer;
    const contactFile = await ContactFile.findOne(
      { fileId },
      { r2Key: 1, data: 1 }
    ).lean();

    if (contactFile?.r2Key && fileStorage.isR2Available()) {
      // Modern path — fetch z R2
      try {
        fileBuffer = await fileStorage.downloadFile(contactFile.r2Key);
        logger.info('Contact file download: from R2', { fileId, r2Key: contactFile.r2Key, size: fileBuffer.length });
      } catch (r2Err) {
        logger.error('Contact file download: R2 fetch failed', { fileId, r2Key: contactFile.r2Key, error: r2Err.message });
        return res.status(500).json({ message: 'Chyba pri sťahovaní súboru z úložiska' });
      }
    } else if (contactFile?.data) {
      // Legacy: base64 v ContactFile collection
      fileBuffer = Buffer.from(contactFile.data, 'base64');
      logger.info('Contact file download: legacy base64 from ContactFile', { fileId, size: fileBuffer.length });
    } else if (fileMeta.data) {
      // Very-legacy: base64 embedded priamo v Contact docu — migruj on-the-fly
      fileBuffer = Buffer.from(fileMeta.data, 'base64');
      logger.info('Contact file download: very-legacy embedded data, migrating', { fileId });
      ContactFile.updateOne(
        { fileId },
        { $setOnInsert: { contactId, fileId, data: fileMeta.data } },
        { upsert: true }
      ).catch(() => {});
    } else {
      logger.error('Contact file download: NO DATA anywhere', { contactId, fileId, fileName: fileMeta.originalName });
      return res.status(404).json({ message: 'File data not found — file may need to be re-uploaded' });
    }

    res.set({
      'Content-Type': fileMeta.mimetype,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileMeta.originalName)}"`,
      'Content-Length': fileBuffer.length
    });

    res.send(fileBuffer);
  } catch (error) {
    logger.error('Contact file download error', { error: error.message, stack: error.stack, contactId: req.params.id, fileId: req.params.fileId });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete file from contact
router.delete('/:id/files/:fileId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!contact) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    const fileIndex = contact.files.findIndex(f => f.id === req.params.fileId);
    if (fileIndex === -1) {
      return res.status(404).json({ message: 'File not found' });
    }

    const deletedFileId = contact.files[fileIndex].id;
    contact.files.splice(fileIndex, 1);
    await contact.save();

    // Vymaž z oboch storage layers: R2 (ak existuje) + MongoDB. Robíme to v
    // tomto poradí: 1) lookup r2Key, 2) delete z R2 (best-effort), 3) delete
    // ContactFile row. Ak by 2 zlyhalo, ostane R2 orphan — opraviteľné cez
    // bulk cleanup script (cheap; R2 účtuje za GB, nie za počet objektov).
    const cfRow = await ContactFile.findOne({ contactId: contact._id, fileId: deletedFileId }, { r2Key: 1 }).lean();
    if (cfRow?.r2Key && fileStorage.isR2Available()) {
      fileStorage.deleteFile(cfRow.r2Key).catch(() => {}); // fire-and-forget
    }
    await ContactFile.deleteOne({ contactId: contact._id, fileId: deletedFileId }).catch(() => {});

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    res.json({ message: 'File deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Premenovanie už nahratého súboru kontaktu — meníme iba originalName
// v dokumente (R2/ContactFile obsah ostáva, mení sa len zobrazovaný názov).
router.patch('/:id/files/:fileId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const newName = (req.body.originalName || '').trim().slice(0, 200);
    if (!newName) return res.status(400).json({ message: 'Názov nesmie byť prázdny' });

    const contact = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!contact) return res.status(404).json({ message: 'Contact not found' });

    const file = (contact.files || []).find(f => f.id === req.params.fileId);
    if (!file) return res.status(404).json({ message: 'File not found' });

    file.originalName = newName;
    contact.markModified('files');
    await contact.save();

    const io = req.app.get('io');
    io.to(`workspace-${req.workspaceId}`).emit('contact-updated', contactToPlainObject(contact));

    res.json({ message: 'Názov upravený', originalName: newName });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
