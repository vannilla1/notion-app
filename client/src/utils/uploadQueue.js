/**
 * uploadQueue.js — fronta nahrávaní príloh, ktorá prežije zavretie appky.
 *
 * Problém, ktorý rieši: upload bol jeden pokus bez poistky. Keď sa prenos
 * prerušil (používateľ zavrel appku, zamkol telefón, vypadol signál),
 * súbor sa stratil BEZ STOPY — server ho nezaložil, do Diagnostiky nešlo
 * nič (nie je to chyba appky) a ani do štatistík (tie sa počítajú až pri
 * dokončení odpovede). Presne to sa stalo s fotkou z terénu.
 *
 * Ako to funguje teraz:
 *   1. Súbor sa NAJPRV uloží do IndexedDB v zariadení (aj s cieľom).
 *   2. Odosielanie beží na pozadí s priebehom a automatickým opakovaním.
 *   3. Po úspechu sa položka z fronty zmaže; po neúspechu tam zostane.
 *   4. Pri ďalšom otvorení appky (alebo návrate siete) sa odošle sama.
 *
 * Duplicity: každá položka nesie `uploadId`, ktorý server používa na
 * idempotenciu — opakovanie po prerušení tak nevytvorí druhú kópiu.
 */
import { getStoredToken } from './authStorage';
import { getStoredWorkspaceId } from './workspaceStorage';
import { API_BASE_URL } from '../api/api';
import { debug } from './debug';

const DB_NAME = 'prplUploads';
const STORE = 'pending';
const DB_VERSION = 1;
const MAX_ATTEMPTS = 5;

// ── IndexedDB (bez závislostí — plain API) ────────────────────────────────
const openDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'uploadId' });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const tx = async (mode, fn) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
  });
};

const getAll = () => tx('readonly', s => s.getAll());
const putItem = (item) => tx('readwrite', s => s.put(item));
const deleteItem = (uploadId) => tx('readwrite', s => s.delete(uploadId));

// ── Odber stavu pre UI ────────────────────────────────────────────────────
const listeners = new Set();
let state = { pending: 0, active: null, progress: 0, failed: 0 };

export const subscribeUploads = (fn) => {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
};

const emit = (patch) => {
  state = { ...state, ...patch };
  listeners.forEach(fn => { try { fn(state); } catch { /* UI chyba nesmie zhodiť upload */ } });
};

const refreshCounts = async () => {
  try {
    const items = await getAll();
    emit({
      pending: items.length,
      failed: items.filter(i => (i.attempts || 0) >= MAX_ATTEMPTS).length
    });
  } catch { /* IndexedDB nedostupná (privátne okno) */ }
};

// ── Odoslanie jednej položky ──────────────────────────────────────────────
const endpointFor = (item) => {
  if (item.kind === 'task') {
    const q = item.subtaskId ? `?subtaskId=${encodeURIComponent(item.subtaskId)}` : '';
    return `${API_BASE_URL}/api/tasks/${item.taskId}/files${q}`;
  }
  return `${API_BASE_URL}/api/contacts/${item.contactId}/files`;
};

const sendItem = (item) => new Promise((resolve) => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', endpointFor(item));
  xhr.setRequestHeader('Authorization', `Bearer ${getStoredToken()}`);
  // Workspace sa berie z položky, nie z aktuálneho stavu — používateľ mohol
  // medzitým prepnúť prostredie a príloha musí pristáť tam, kam patrí.
  const wsId = item.workspaceId || getStoredWorkspaceId();
  if (wsId) xhr.setRequestHeader('X-Workspace-Id', wsId);
  xhr.timeout = 300000;

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) emit({ active: item, progress: Math.round((e.loaded / e.total) * 100) });
  };

  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
    // 4xx (okrem 429) sa opakovaním nespraví — plán, kvóta, neplatný typ,
    // zmazaný kontakt. Položku zahodíme a chybu ukážeme.
    let message = '';
    let code = null;
    try {
      const data = JSON.parse(xhr.responseText || '{}');
      message = data.message || '';
      code = data.code || null;
    } catch { /* nie JSON */ }
    const permanent = xhr.status >= 400 && xhr.status < 500 && xhr.status !== 429;
    resolve({ ok: false, permanent, message, code, status: xhr.status });
  });
  // Sieťová chyba / timeout / prerušenie — položka ostáva vo fronte
  xhr.addEventListener('error', () => resolve({ ok: false, permanent: false, message: 'Chyba siete' }));
  xhr.addEventListener('timeout', () => resolve({ ok: false, permanent: false, message: 'Časový limit' }));
  xhr.addEventListener('abort', () => resolve({ ok: false, permanent: false, message: 'Prerušené' }));

  const fd = new FormData();
  if (item.customName) fd.append('customName', item.customName);
  fd.append('uploadId', item.uploadId); // server-side idempotencia proti duplikátom
  fd.append('file', item.file, item.fileName);
  xhr.send(fd);
});

// ── Spracovanie fronty ────────────────────────────────────────────────────
let processing = false;
const onDoneCallbacks = new Set();

/** Callback po úspešnom odoslaní — stránky si podľa neho obnovia dáta. */
export const onUploadSettled = (fn) => {
  onDoneCallbacks.add(fn);
  return () => onDoneCallbacks.delete(fn);
};

export const processUploadQueue = async () => {
  if (processing) return;
  processing = true;
  try {
    let items = await getAll();
    // Najstaršie najprv; položky s vyčerpanými pokusmi preskakujeme
    items = items
      .filter(i => (i.attempts || 0) < MAX_ATTEMPTS)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    for (const item of items) {
      if (!navigator.onLine) break;
      emit({ active: item, progress: 0 });
      const res = await sendItem(item);

      if (res.ok) {
        await deleteItem(item.uploadId);
        onDoneCallbacks.forEach(fn => { try { fn({ ok: true, item }); } catch { /* ignore */ } });
      } else if (res.permanent) {
        await deleteItem(item.uploadId);
        onDoneCallbacks.forEach(fn => { try { fn({ ok: false, item, message: res.message, code: res.code }); } catch { /* ignore */ } });
      } else {
        // Dočasná chyba — necháme vo fronte a skúsime neskôr
        item.attempts = (item.attempts || 0) + 1;
        item.lastError = res.message || 'Nepodarilo sa odoslať';
        await putItem(item);
        debug.warn('[Upload] Pokus zlyhal, zostáva vo fronte', item.fileName, item.attempts);
        break; // ďalšie položky nemá zmysel skúšať hneď (najskôr je preč sieť)
      }
      await refreshCounts();
    }
  } catch (e) {
    debug.warn('[Upload] Spracovanie fronty zlyhalo', e);
  } finally {
    processing = false;
    emit({ active: null, progress: 0 });
    await refreshCounts();
  }
};

/** Zaradí súbor do fronty a hneď sa pokúsi odoslať. */
export const enqueueUpload = async ({ kind, contactId, taskId, subtaskId, file, customName }) => {
  const uploadId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const item = {
    uploadId,
    kind,
    contactId: contactId || null,
    taskId: taskId || null,
    subtaskId: subtaskId || null,
    file,
    fileName: customName || file.name,
    customName: customName || '',
    workspaceId: getStoredWorkspaceId() || null,
    createdAt: Date.now(),
    attempts: 0
  };
  try {
    await putItem(item);
  } catch (e) {
    // IndexedDB nedostupná (privátne okno, plné úložisko) — odošleme priamo,
    // bez poistky. Lepšie než neodoslať nič.
    debug.warn('[Upload] IndexedDB nedostupná, posielam priamo', e);
    emit({ active: item, progress: 0 });
    const res = await sendItem(item);
    emit({ active: null, progress: 0 });
    onDoneCallbacks.forEach(fn => { try { fn({ ok: res.ok, item, message: res.message, code: res.code }); } catch { /* ignore */ } });
    return { uploadId, queued: false, ok: res.ok };
  }
  await refreshCounts();
  processUploadQueue();
  return { uploadId, queued: true };
};

/** Zmaže položky, ktoré vyčerpali pokusy (používateľ ich vzdal). */
export const discardFailedUploads = async () => {
  const items = await getAll();
  for (const i of items) {
    if ((i.attempts || 0) >= MAX_ATTEMPTS) await deleteItem(i.uploadId);
  }
  await refreshCounts();
};

/** Znova povolí pokusy pre zlyhané položky (tlačidlo „Skúsiť znova"). */
export const retryFailedUploads = async () => {
  const items = await getAll();
  for (const i of items) {
    if ((i.attempts || 0) >= MAX_ATTEMPTS) { i.attempts = 0; await putItem(i); }
  }
  await refreshCounts();
  processUploadQueue();
};

/** Spustí sledovanie — volá sa raz pri štarte appky (App.jsx). */
export const startUploadQueue = () => {
  refreshCounts().then(() => processUploadQueue());
  window.addEventListener('online', processUploadQueue);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) processUploadQueue();
  });
};
