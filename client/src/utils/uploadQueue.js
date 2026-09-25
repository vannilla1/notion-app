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
 *   1. Súbor sa NAJPRV uloží do IndexedDB v zariadení (aj s cieľom a
 *      vlastníkom — ID prihláseného používateľa).
 *   2. Odosielanie beží na pozadí s priebehom a automatickým opakovaním
 *      (backoff 5 s → 20 s → 1 min → 3 min), bez čakania na ďalšiu udalosť.
 *   3. Po úspechu sa položka z fronty zmaže; po dočasnej chybe tam zostane.
 *   4. Pri ďalšom otvorení appky (alebo návrate siete) sa odošle sama.
 *   5. Bez prihlásenia sa neodosiela nič a položky iného účtu sa nechajú
 *      na pokoji, kým sa ich vlastník neprihlási.
 *   6. Trvalé zlyhania ukáže používateľovi UploadQueueIndicator (na každej
 *      stránke) a tie nečakané idú aj do Diagnostiky.
 *
 * Duplicity: každá položka nesie `uploadId`, ktorý server používa na
 * idempotenciu — opakovanie po prerušení tak nevytvorí druhú kópiu.
 */
import { getStoredToken } from './authStorage';
import { getStoredWorkspaceId } from './workspaceStorage';
import { API_BASE_URL } from '../api/api';
import { debug } from './debug';
import { reportError } from './reportError';
import { addBreadcrumb } from './breadcrumbs';

const DB_NAME = 'prplUploads';
const STORE = 'pending';
const DB_VERSION = 1;
const MAX_ATTEMPTS = 5;
// Backoff po dočasnej chybe: index = počet doterajších pokusov - 1.
// Po MAX_ATTEMPTS sa automaticky neopakuje — používateľ dostane tlačidlo.
const RETRY_DELAYS_MS = [5000, 20000, 60000, 180000];
const RETRY_DELAY_MAX_MS = 300000;
// Frontu práve odosiela iný tab — skúsime o chvíľu, keď ju uvoľní.
const LOCK_BUSY_RETRY_MS = 15000;
// Server ešte spracúva prvý pokus s tým istým uploadId (409 UPLOAD_IN_PROGRESS).
const IN_PROGRESS_RETRY_MS = 20000;
// Vyčerpané položky dostanú pri návrate do appky ďalší pokus najviac raz
// za tento čas (na iOS je otvorenie appky zvyčajne resume, nie studený štart).
const REARM_ON_VISIBLE_MS = 10 * 60 * 1000;
const LOCK_NAME = 'prpl-upload-queue';
// Watchdog prenosu: rušíme len ZASEKNUTÝ prenos (žiadny odoslaný bajt), nie
// pomalý. Pevný 5-min timeout na celý request znemožnil 50 MB video na slabom
// LTE/3G — každý pokus spadol pri ~90 % a ďalší začal od nuly.
const STALL_TIMEOUT_MS = 90000;
// Po odoslaní celého tela server ešte ukladá súbor (R2) — progress už nechodí,
// čakáme na odpoveď dlhšie. Keby odpoveď prišla až po zrušení, opakovanie
// server rozpozná podľa uploadId (duplicate: true) — nič sa nezdvojí.
const RESPONSE_TIMEOUT_MS = 120000;

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

/**
 * Jedna transakcia nad frontou. Promise sa MUSÍ vyrovnať pri každom konci:
 * Chromium pri plnom úložisku (takmer plný Android, inkognito) nechá put
 * request uspieť a transakciu až pri commite zruší s QuotaExceededError —
 * príde len 'abort', žiadny 'error'. Bez onabort enqueueUpload navždy visel:
 * nič sa neodoslalo, záložné priame odoslanie sa nespustilo, žiadna hláška.
 * Spojenie sa zatvára vždy — každá transakcia si otvára vlastné.
 */
const tx = async (mode, fn) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const close = () => { try { db.close(); } catch { /* už zatvorené */ } };
    let t;
    try {
      t = db.transaction(STORE, mode);
    } catch (e) { close(); reject(e); return; }
    let result;
    try {
      result = fn(t.objectStore(STORE));
    } catch (e) {
      try { t.abort(); } catch { /* transakcia už skončila */ }
      close();
      reject(e);
      return;
    }
    t.oncomplete = () => { close(); resolve(result && result.result !== undefined ? result.result : result); };
    t.onerror = () => { close(); reject(t.error); };
    t.onabort = () => { close(); reject(t.error || new DOMException('Transaction aborted', 'AbortError')); };
  });
};

const getAll = () => tx('readonly', s => s.getAll());
const putItem = (item) => tx('readwrite', s => s.put(item));
const deleteItem = (uploadId) => tx('readwrite', s => s.delete(uploadId));

// ── Vlastník položky ──────────────────────────────────────────────────────
/**
 * ID používateľa z JWT (payload `{ id }`, podpisuje server v routes/auth.js).
 * Podpis tu neoverujeme — slúži len na to, aby účet B v tom istom
 * prehliadači / na zdieľanom telefóne neodoslal čakajúci súbor účtu A
 * (web drží token per tab, IndexedDB je spoločná pre celý origin).
 */
const tokenUserId = (token) => {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const id = JSON.parse(atob(b64))?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
};

// Položky bez ownerId sú zo staršej verzie fronty — tie smú ísť pod
// ktorýmkoľvek prihláseným účtom (tak sa správali doteraz).
const ownedBy = (item, uid) => !item.ownerId || (!!uid && item.ownerId === uid);

// ── Odber stavu pre UI ────────────────────────────────────────────────────
const listeners = new Set();
let state = { pending: 0, active: null, progress: 0, failed: 0, retrying: 0, lastError: null };

// Prenos iného účtu (A sa odhlásil uprostred nahrávania, prihlásil sa B —
// odhlásenie je „mäkké", bez reloadu) beží ďalej, ale B ho nesmie vidieť.
const visibleState = () => (state.active && !ownedBy(state.active, tokenUserId(getStoredToken()))
  ? { ...state, active: null, progress: 0 }
  : state);

export const subscribeUploads = (fn) => {
  listeners.add(fn);
  fn(visibleState());
  return () => listeners.delete(fn);
};

const emit = (patch) => {
  state = { ...state, ...patch };
  const view = visibleState();
  listeners.forEach(fn => { try { fn(view); } catch { /* UI chyba nesmie zhodiť upload */ } });
};

const refreshCounts = async () => {
  try {
    const uid = tokenUserId(getStoredToken());
    // Len vlastné položky — cudzie (iný účet na zariadení) by visel ako
    // „1 príloha čaká" navždy, bez možnosti s tým niečo spraviť.
    const items = (await getAll()).filter(i => ownedBy(i, uid));
    const waitingAfterError = items.filter(i => (i.attempts || 0) > 0 && (i.attempts || 0) < MAX_ATTEMPTS);
    emit({
      pending: items.length,
      failed: items.filter(i => (i.attempts || 0) >= MAX_ATTEMPTS).length,
      retrying: waitingAfterError.length,
      lastError: waitingAfterError[0]?.lastError || null
    });
  } catch { /* IndexedDB nedostupná (privátne okno) */ }
};

// Chyby používateľa / plánu — nie sú to bugy, do Diagnostiky nepatria
// a ich hlášku servera (aj bez diakritiky) ukazujeme vždy tak, ako prišla.
const USER_ERROR_CODES = new Set([
  'FEATURE_NOT_IN_PLAN', 'PLAN_LIMIT', 'STORAGE_LIMIT', 'FILE_TOO_LARGE',
  'BLOCKED_EXTENSION', 'WORKSPACE_OVER_LIMIT', 'NOT_MEMBER', 'NO_WORKSPACE'
]);

// Chyby prenosu, ktoré server sám zapisuje do Diagnostiky (handleUploadError
// / rejectMissingFilePart v server/utils/uploadTracking.js).
const SERVER_RECORDED_CODES = new Set(['UPLOAD_BODY_INCOMPLETE', 'UPLOAD_REJECTED', 'NO_FILE_PART']);

// ── Hlášky pre používateľa ────────────────────────────────────────────────
// Server posiela slovenské hlášky s kódom. Staršie verzie servera (a proxy
// pred ním) vracali surový anglický text multera/busboya („Unexpected end of
// form") — ten používateľ nesmie vidieť nikdy, preto mapa kódov + rozpoznanie.
const CODE_MESSAGES = {
  UPLOAD_BODY_INCOMPLETE: 'Súbor sa na server nedostal celý. Vyberte ho prosím znova a nahrajte.',
  FILE_TOO_LARGE: 'Súbor je príliš veľký. Maximum je 50 MB.',
  BLOCKED_EXTENSION: 'Tento typ súboru nie je z bezpečnostných dôvodov povolený (spustiteľný súbor).',
  UPLOAD_REJECTED: 'Server súbor neprijal. Skúste ho prosím nahrať znova.',
  NO_FILE_PART: 'Na server neprišiel žiadny súbor. Vyberte ho prosím znova.',
  UPLOAD_IN_PROGRESS: 'Súbor sa ešte spracúva — o chvíľu to skúsime znova.'
};

// Surové chyby multera/busboya zo starších serverov → náš kód
const RAW_SERVER_ERRORS = [
  [/unexpected end of (form|file|multipart)|malformed part header|boundary not found|malformed content type|missing content-type|unsupported content type/i, 'UPLOAD_BODY_INCOMPLETE'],
  [/^file too large$/i, 'FILE_TOO_LARGE'],
  [/^no file uploaded$/i, 'NO_FILE_PART'],
  [/^(too many (parts|files|fields)|field (name|value) too long|unexpected field|field name missing)$/i, 'UPLOAD_REJECTED']
];

const inferCode = (status, message) => {
  for (const [re, code] of RAW_SERVER_ERRORS) if (re.test(message || '')) return code;
  if (status === 413) return 'FILE_TOO_LARGE';
  return null;
};

// Anglický technický text (bez diakritiky + jednoznačne anglické slová) —
// radšej ho nahradíme slovenskou hláškou, než by ho videl používateľ.
// Pozor: aj slovenské hlášky servera bývajú bez diakritiky (iOS „Dosiahli
// ste storage limit (10/10 MB).") — preto len slová, ktoré v slovenčine nie sú.
const looksRawEnglish = (m) => /^[\x20-\x7e]*$/.test(m)
  && /\b(the|of|not|found|unexpected|invalid|error|missing|too|failed|uploaded|malformed|unsupported|payload|entity|gateway|bad|timeout|unavailable|internal|field|boundary|header|forbidden|unauthorized|requests|aborted)\b/i.test(m);

/** Slovenská hláška k odpovedi servera — pre UI aj lastError. */
export const uploadErrorMessage = ({ status, code, serverMessage } = {}) => {
  const msg = typeof serverMessage === 'string' ? serverMessage.trim() : '';
  const rawCode = msg ? inferCode(0, msg) : null; // surový text multera/busboya
  if (msg && !rawCode && (USER_ERROR_CODES.has(code) || !looksRawEnglish(msg))) return msg;
  const known = code || rawCode || inferCode(status, '');
  if (known && CODE_MESSAGES[known]) return CODE_MESSAGES[known];
  if (status === 401) return 'Prihlásenie vypršalo — prihláste sa prosím znova.';
  if (status === 404) return 'Kontakt alebo úloha, ku ktorej príloha patrí, už neexistuje.';
  if (status === 429) return 'Príliš veľa požiadaviek naraz — skúsim to o chvíľu znova.';
  if (status >= 500) return `Server je dočasne nedostupný (HTTP ${status}).`;
  if (status) return `Server súbor odmietol (HTTP ${status}).`;
  return 'Nepodarilo sa odoslať';
};

// ── Diagnostika ───────────────────────────────────────────────────────────
// Dôvod nečitateľného súboru bez voľného textu (správa výnimky by mohla
// niesť čokoľvek) — len druh + názov DOMException / počty bajtov.
const safeReason = (reason) => {
  const m = String(reason || '').match(/^(missing|empty|size-mismatch \d+\/\d+|read-failed(?::\s*[A-Za-z]+Error)?)/);
  return m ? m[1] : 'unknown';
};

const TRANSIENT_LABELS = { network: 'sieťová chyba', stall: 'prenos sa zastavil', abort: 'prenos prerušený' };
const transientLabel = (res) => (res?.status ? `HTTP ${res.status}` : (TRANSIENT_LABELS[res?.kind] || 'neznáma chyba'));

/**
 * Premenlivé detaily (veľkosť, typ, pokusy, fáza, status) idú LEN do
 * breadcrumbu. Správa reportu musí byť stabilná — je to kľúč dedupu
 * (reportError.js) aj fingerprint na serveri; veľkosť alebo ID v nej by
 * vyrobili jeden riadok Diagnostiky na každý upload. Názov súboru nikdy
 * (osobné údaje). Pozor aj na slová „Load failed"/„cancelled" — tie
 * reportError zahadzuje (IGNORED_PATTERNS).
 */
const uploadBreadcrumb = (item, res, stage) => {
  try {
    const f = item?.file;
    const size = typeof item?.size === 'number' ? item.size : (typeof f?.size === 'number' ? f.size : -1);
    const parts = [
      `upload ${item?.kind || '?'} ${stage}`,
      `status=${res?.status || 0}`,
      `code=${res?.code || '-'}`,
      `size=${size}`,
      `type=${String(f?.type || '?').slice(0, 40)}`,
      `sent=${res?.loaded ?? '?'}/${res?.total ?? '?'}`,
      `attempts=${item?.attempts || 0}`
    ];
    if (res?.reason) parts.push(`reason=${safeReason(res.reason)}`);
    addBreadcrumb({ category: 'upload', level: 'error', message: parts.join(' ') });
  } catch { /* diagnostika nesmie zhodiť frontu */ }
};

/** Nahlási neúspech do Diagnostiky, ak nejde o chybu používateľa / plánu. */
const reportUploadFailure = (item, res, stage) => {
  try {
    if (!res || res.ok || res.authLost) return;
    if (res.unreadable) {
      uploadBreadcrumb(item, res, stage);
      const kind = safeReason(res.reason).split(/[\s:]/)[0];
      reportError({ name: 'UploadUnreadableFile', message: `Príloha sa v zariadení nedala načítať (${kind})` });
      return;
    }
    if (stage === 'retries-exhausted') {
      uploadBreadcrumb(item, res, stage);
      reportError({ name: 'AttachmentUploadError', message: `Príloha neodoslaná ani po ${MAX_ATTEMPTS} pokusoch: ${transientLabel(res)}` });
      return;
    }
    if (!res.permanent) return; // dočasná chyba — rieši backoff
    if (USER_ERROR_CODES.has(res.code) || res.status === 404) return;
    // Tieto kódy už do Diagnostiky zapísal server (uploadTracking.js) aj
    // s kontextom prenosu — druhý záznam z klienta by každý incident zdvojil.
    if (SERVER_RECORDED_CODES.has(res.serverCode)) return;
    uploadBreadcrumb(item, res, stage);
    reportError({
      name: 'AttachmentUploadError',
      message: `Príloha neodoslaná: HTTP ${res.status || 0}${res.code ? ` ${res.code}` : ''}`
    });
  } catch { /* diagnostika nesmie zhodiť frontu */ }
};

// ── Odoslanie jednej položky ──────────────────────────────────────────────
const endpointFor = (item) => {
  if (item.kind === 'task') {
    const q = item.subtaskId ? `?subtaskId=${encodeURIComponent(item.subtaskId)}` : '';
    return `${API_BASE_URL}/api/tasks/${item.taskId}/files${q}`;
  }
  return `${API_BASE_URL}/api/contacts/${item.contactId}/files`;
};

/**
 * Súbor pripravený na odoslanie — VŽDY nový File s bajtmi v pamäti.
 *
 * WebKit (iOS/iPadOS appka aj Safari, Safari na Macu) posiela Blob načítaný
 * z IndexedDB ako PRÁZDNE telo: XHR s FormData odíde s Content-Length 0, hoci
 * blob.arrayBuffer() vráti všetky bajty. Server (busboy) potom hlási
 * „Unexpected end of form" → 400 a príloha sa nenahrá. Od zavedenia fronty
 * (26. 8. 2026) tak na iPhone nešla nahrať žiadna príloha. Overené 24. 9. 2026
 * v iOS 27 simulátore s vygenerovaným JPEG aj s fotkou z knižnice Fotky;
 * Chromium (Chrome, Edge, Android) to robí správne, ale kópia do pamäte mu
 * neuškodí, takže cesta je jedna pre všetky platformy.
 *
 * Súbor, ktorý sa nedá prečítať (zmazaný z úložiska prehliadača, prázdny,
 * iná veľkosť než pri výbere), NEPOSIELAME — prázdne telo by skončilo tou
 * istou kryptickou 400-kou. Volajúci dostane UnreadableFileError.
 */
export class UnreadableFileError extends Error {
  constructor(reason) {
    super('Súbor sa v zariadení nepodarilo načítať. Vyberte ho prosím znova.');
    this.name = 'UnreadableFileError';
    this.reason = reason;
  }
}

const readBytes = (blob) => {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  // Staršie WebKity bez Blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsArrayBuffer(blob);
  });
};

export const toSendableFile = async (item) => {
  const src = item.file;
  if (!src || typeof src.size !== 'number') throw new UnreadableFileError('missing');
  const type = src.type || 'application/octet-stream';
  // Súbor bol prázdny už pri výbere — nie je čo čítať, pošleme prázdny súbor
  // (nie je to chyba úložiska; server rozhodne sám).
  if (item.size === 0) return new File([], item.fileName, { type });
  let buf;
  try {
    buf = await readBytes(src);
  } catch (e) {
    throw new UnreadableFileError(`read-failed: ${e?.name || e?.message || 'unknown'}`);
  }
  // Pri výbere mal bajty, teraz nemá nič / má iný počet → úložisko prehliadača
  // súbor stratilo alebo poškodilo. Staršie položky vo fronte size nemajú —
  // tam je prázdny obsah jediný spoľahlivý signál.
  if (!buf || buf.byteLength === 0) throw new UnreadableFileError('empty');
  if (typeof item.size === 'number' && buf.byteLength !== item.size) {
    throw new UnreadableFileError(`size-mismatch ${buf.byteLength}/${item.size}`);
  }
  return new File([buf], item.fileName, { type });
};

const sendItem = async (item, token) => {
  let file;
  try {
    file = await toSendableFile(item);
  } catch (e) {
    return { ok: false, permanent: true, unreadable: true, message: e.message, reason: e.reason };
  }
  return sendFile(item, file, token);
};

const STALL_MESSAGE = 'Prenos sa zastavil (slabý signál)';

const sendFile = (item, file, token) => new Promise((resolve) => {
  // Bez tokenu NEPOSIELAME — „Bearer null" skončil 401-kou a položka sa
  // doteraz zmazala. Položka počká na prihlásenie.
  if (!token) {
    resolve({ ok: false, permanent: false, authLost: true, status: 0, message: uploadErrorMessage({ status: 401 }) });
    return;
  }
  const xhr = new XMLHttpRequest();
  let loaded = 0;
  let total = typeof file?.size === 'number' ? file.size : 0;
  let watchdog = null;
  let stalled = false;
  let settled = false;
  const settle = (res) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    resolve({ ...res, loaded, total });
  };
  // Watchdog: každý odoslaný bajt ho posunie; zruší len zaseknutý prenos
  const arm = (ms) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      try { xhr.abort(); } catch { /* už skončil */ }
      // Niektoré WebView po abort() udalosť nepošlú — vyrovnáme sami
      settle({ ok: false, permanent: false, kind: 'stall', message: STALL_MESSAGE });
    }, ms);
  };

  xhr.open('POST', endpointFor(item));
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  // Workspace sa berie z položky, nie z aktuálneho stavu — používateľ mohol
  // medzitým prepnúť prostredie a príloha musí pristáť tam, kam patrí.
  const wsId = item.workspaceId || getStoredWorkspaceId();
  if (wsId) xhr.setRequestHeader('X-Workspace-Id', wsId);
  xhr.timeout = 0; // celkový limit nahrádza watchdog vyššie

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      loaded = e.loaded;
      total = e.total;
      emit({ active: item, progress: Math.round((e.loaded / e.total) * 100) });
      if (e.total > 0 && e.loaded >= e.total) { arm(RESPONSE_TIMEOUT_MS); return; }
    }
    arm(STALL_TIMEOUT_MS);
  };
  // Telo odišlo celé → už čakáme len na spracovanie na serveri
  xhr.upload.onload = () => arm(RESPONSE_TIMEOUT_MS);

  xhr.addEventListener('load', () => {
    const status = xhr.status;
    if (status >= 200 && status < 300) return settle({ ok: true, status });
    let serverMessage = '';
    let code = null;
    try {
      const data = JSON.parse(xhr.responseText || '{}');
      serverMessage = typeof data.message === 'string' ? data.message : '';
      code = typeof data.code === 'string' ? data.code : null;
    } catch { /* nie JSON (napr. HTML z proxy) */ }
    // Kód poslaný serverom (nie odvodený z textu) = server chybu už sám
    // zapísal do Diagnostiky — viď SERVER_RECORDED_CODES.
    const serverCode = code;
    code = code || inferCode(status, serverMessage);
    const message = uploadErrorMessage({ status, code, serverMessage });
    // 401 = neplatná / vypršaná session, nie chyba súboru. Položku necháme
    // a počkáme na ďalšie prihlásenie (doteraz sa súbor ticho zmazal).
    if (status === 401) return settle({ ok: false, permanent: false, authLost: true, status, code, message });
    // 4xx (okrem 408/429) sa opakovaním nespraví — plán, kvóta, neplatný typ,
    // zmazaný kontakt. Položku zahodíme a chybu ukážeme.
    // 409 UPLOAD_IN_PROGRESS = server ešte ukladá prvý pokus s týmto uploadId
    // → položku nechať a skúsiť neskôr (nie „hotovo", nie „chyba").
    if (status === 409 && serverCode === 'UPLOAD_IN_PROGRESS') {
      return settle({ ok: false, permanent: false, inProgress: true, status, code, message });
    }
    const permanent = status >= 400 && status < 500 && status !== 429 && status !== 408;
    settle({ ok: false, permanent, kind: 'http', message, code, serverCode, status });
  });
  // Sieťová chyba / prerušenie — položka ostáva vo fronte
  xhr.addEventListener('error', () => settle({ ok: false, permanent: false, kind: 'network', message: 'Chyba siete' }));
  xhr.addEventListener('timeout', () => settle({ ok: false, permanent: false, kind: 'stall', message: 'Časový limit' }));
  xhr.addEventListener('abort', () => settle(stalled
    ? { ok: false, permanent: false, kind: 'stall', message: STALL_MESSAGE }
    : { ok: false, permanent: false, kind: 'abort', message: 'Prerušené' }));

  const fd = new FormData();
  if (item.customName) fd.append('customName', item.customName);
  fd.append('uploadId', item.uploadId); // server-side idempotencia proti duplikátom
  fd.append('file', file, item.fileName);
  arm(STALL_TIMEOUT_MS);
  xhr.send(fd);
});

// ── Výsledky pre UI ───────────────────────────────────────────────────────
const onDoneCallbacks = new Set();
const failureHandlers = new Set();
// Zlyhania, ktoré prišli, keď nikto globálny nepočúval (napr. admin route)
// — doručia sa hneď, ako sa UploadQueueIndicator pripojí. Nič sa nestratí.
const undeliveredFailures = [];
const MAX_UNDELIVERED = 10;

/** Callback po dokončení (úspech aj neúspech) — stránky si obnovia dáta. */
export const onUploadSettled = (fn) => {
  onDoneCallbacks.add(fn);
  return () => onDoneCallbacks.delete(fn);
};

/**
 * Globálny odber zlyhaní (UploadQueueIndicator). Stránky Tasks/CRM sa pri
 * odchode odpájajú — zlyhanie, ktoré prišlo mimo nich, sa doteraz zahodilo
 * úplne potichu a používateľ si myslel, že fotka je pripojená.
 */
export const onUploadFailed = (fn) => {
  failureHandlers.add(fn);
  // Len zlyhania TOHTO používateľa — indikátor sa odpája pri odhlásení, takže
  // bez filtra by sa hláška o cudzej fotke ukázala ďalšiemu účtu na zariadení.
  const uid = tokenUserId(getStoredToken());
  const foreign = [];
  undeliveredFailures.splice(0).forEach(o => {
    // cudzie ponecháme pre ich vlastníka (predtým sa zahodili)
    if (!ownedBy(o.item || {}, uid)) { foreign.push(o); return; }
    try { fn(o); } catch { /* ignore */ }
  });
  undeliveredFailures.push(...foreign);
  return () => failureHandlers.delete(fn);
};

const notifySettled = (outcome) => {
  onDoneCallbacks.forEach(fn => { try { fn(outcome); } catch { /* ignore */ } });
  if (outcome.ok) return;
  // Nikto nepočúva, alebo je prihlásený iný účet → odložiť pre vlastníka
  // (inak by B videl kartičku s názvom A-ho súboru, prípadne UpgradeModal
  // za A-ho limit).
  if (failureHandlers.size === 0 || !ownedBy(outcome.item || {}, tokenUserId(getStoredToken()))) {
    undeliveredFailures.push(outcome);
    if (undeliveredFailures.length > MAX_UNDELIVERED) undeliveredFailures.shift();
    return;
  }
  failureHandlers.forEach(fn => { try { fn(outcome); } catch { /* ignore */ } });
};

// ── Spracovanie fronty ────────────────────────────────────────────────────
let running = null;       // Promise práve bežiaceho spracovania (aj s opakovaniami)
let rerun = false;        // počas behu niekto požiadal o ďalší (nová položka, retry)
let retryTimer = null;    // backoff po dočasnej chybe / obsadenom zámku
let rejectedToken = null; // token, ktorý server odmietol 401 — kým sa nezmení, neposielame

const clearRetryTimer = () => {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
};

const scheduleRetry = (ms) => {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; processUploadQueue(); }, ms);
};

/**
 * Jeden tab naraz: dva taby by poslali tú istú položku dvakrát (a pri
 * rôznych účtoch pod cudzím menom). Kde Web Locks API nie je, chráni aspoň
 * príznak `running` v rámci tabu.
 */
const withQueueLock = async (fn) => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') return fn();
  let entered = false;
  try {
    const res = await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return null;
      entered = true;
      return fn();
    });
    return entered ? res : { lockBusy: true };
  } catch (e) {
    if (entered) throw e;
    return fn(); // Locks API existuje, ale nefunguje (napr. SecurityError) — bez zámku
  }
};

/** Jeden prechod frontou; vráti, prečo skončil (pre plánovanie ďalšieho). */
const runPass = async () => {
  const outcome = { transientFail: null, authLost: false };
  const tried = new Set();
  for (;;) {
    const token = getStoredToken();
    // Bez prihlásenia (odhlásenie bez reloadu v iOS/Android shelli) alebo
    // s tokenom, ktorý server už odmietol, nerobíme nič — položky čakajú.
    if (!token || token === rejectedToken) break;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
    const uid = tokenUserId(token);
    // Zoznam čítame pred KAŽDOU položkou — súbor pridaný počas prenosu
    // (aj z iného tabu) ide hneď po aktuálnom, nečaká na ďalšiu udalosť.
    const items = (await getAll())
      .filter(i => (i.attempts || 0) < MAX_ATTEMPTS && !tried.has(i.uploadId) && ownedBy(i, uid))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // najstaršie najprv
    const item = items[0];
    if (!item) break;
    tried.add(item.uploadId);

    emit({ active: item, progress: 0 });
    const res = await sendItem(item, token);

    if (res.ok) {
      await deleteItem(item.uploadId);
      notifySettled({ ok: true, item });
    } else if (res.authLost) {
      // Pokus sa nepočíta, položka ostáva; po prihlásení pokračujeme
      rejectedToken = token;
      outcome.authLost = true;
      break;
    } else if (res.inProgress) {
      // Server ešte spracúva prvý pokus — nepočíta sa, skúsime o chvíľu
      outcome.inProgress = true;
      break;
    } else if (res.permanent) {
      await deleteItem(item.uploadId);
      reportUploadFailure(item, res, res.unreadable ? 'unreadable' : 'permanent');
      notifySettled({ ok: false, item, message: res.message, code: res.code, status: res.status });
    } else {
      // Dočasná chyba — necháme vo fronte a skúsime neskôr (backoff)
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = res.message || 'Nepodarilo sa odoslať';
      await putItem(item);
      debug.warn('[Upload] Pokus zlyhal, zostáva vo fronte', item.attempts);
      if (item.attempts < MAX_ATTEMPTS) {
        outcome.transientFail = item;
        break; // ďalšie položky nemá zmysel skúšať hneď (najskôr je preč sieť)
      }
      // Položka práve vyčerpala pokusy — automaticky ju už neskúšame (rozhodne
      // používateľ tlačidlom v indikátore), ale ostatné MUSIA ísť ďalej. Doteraz
      // tu bol break a časovač sa plánuje len pre položku s pokusmi k dobru —
      // fotka pridaná počas zlyhávania veľkého videa tak čakala na vonkajšiu
      // udalosť (návrat do appky, sieť, prihlásenie). Ak je sieť naozaj preč,
      // zlyhá aj ďalšia položka a tá si backoff naplánuje sama.
      // `tried` zaručí, že sa k tejto položke v tomto prechode nevrátime.
      // Do Diagnostiky len pri PRVOM vyčerpaní — oživené položky (viď
      // rearmExhausted) by inak pridávali riadok pri každom návrate siete.
      if (!item.exhaustedReported) {
        reportUploadFailure(item, res, 'retries-exhausted');
        item.exhaustedReported = true;
        await putItem(item);
      }
    }
    await refreshCounts();
  }
  return outcome;
};

/**
 * Spracuje frontu. Volanie počas behu sa nestratí (doteraz sa vrátilo hneď
 * a druhá fotka pridaná počas prenosu prvej čakala do ďalšej udalosti) —
 * nastaví `rerun` a vráti Promise bežiaceho spracovania.
 */
export const processUploadQueue = () => {
  if (running) { rerun = true; return running; }
  running = (async () => {
    let outcome = null;
    do {
      rerun = false;
      clearRetryTimer(); // prechod beží teraz — naplánovaný pokus je zbytočný
      try {
        outcome = await withQueueLock(runPass);
      } catch (e) {
        outcome = null;
        try {
          reportError({ name: e?.name || 'UploadQueueError', message: `Fronta príloh zlyhala: ${String(e?.message || e).slice(0, 200)}` });
        } catch { /* ignore */ }
        debug.warn('[Upload] Spracovanie fronty zlyhalo', e);
      }
      emit({ active: null, progress: 0 });
      await refreshCounts();
    } while (rerun);
    running = null;
    if (outcome?.lockBusy) {
      scheduleRetry(LOCK_BUSY_RETRY_MS);
    } else if (outcome?.inProgress) {
      scheduleRetry(IN_PROGRESS_RETRY_MS);
    } else if (outcome?.transientFail) {
      // transientFail nesie len položku s pokusmi k dobru — vyčerpaná prechod
      // nezastaví (viď runPass), takže tu už netreba kontrolovať MAX_ATTEMPTS
      const attempts = outcome.transientFail.attempts || 0;
      scheduleRetry(RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAY_MAX_MS);
    }
  })();
  return running;
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
    size: file.size, // kontrola pri odoslaní — viď toSendableFile
    fileName: customName || file.name,
    customName: customName || '',
    workspaceId: getStoredWorkspaceId() || null,
    ownerId: tokenUserId(getStoredToken()),
    createdAt: Date.now(),
    attempts: 0
  };
  try {
    await putItem(item);
  } catch (e) {
    // IndexedDB nedostupná (privátne okno, plné úložisko) — odošleme priamo,
    // bez poistky. Lepšie než neodoslať nič. Do Diagnostiky s názvom výnimky
    // (QuotaExceededError, InvalidStateError…), nech vidno, koľkých sa to týka.
    uploadBreadcrumb(item, { status: 0, code: e?.name }, 'storage-fallback');
    try {
      reportError({ name: e?.name || 'UploadQueueStorageError', message: 'Fronta príloh: úložisko v zariadení nie je dostupné, príloha ide priamo' });
    } catch { /* ignore */ }
    debug.warn('[Upload] IndexedDB nedostupná, posielam priamo', e);
    emit({ active: item, progress: 0 });
    const res = await sendItem(item, getStoredToken());
    emit({ active: null, progress: 0 });
    reportUploadFailure(item, res, res.unreadable ? 'unreadable' : 'direct');
    notifySettled({ ok: res.ok, item, message: res.message, code: res.code, status: res.status });
    return { uploadId, queued: false, ok: res.ok };
  }
  await refreshCounts();
  processUploadQueue();
  return { uploadId, queued: true };
};

/** Zmaže položky, ktoré vyčerpali pokusy (používateľ ich vzdal). */
export const discardFailedUploads = async () => {
  const uid = tokenUserId(getStoredToken());
  const items = await getAll();
  for (const i of items) {
    // Cudzie položky (iný účet na tomto zariadení) nechávame ich vlastníkovi
    if (ownedBy(i, uid) && (i.attempts || 0) >= MAX_ATTEMPTS) await deleteItem(i.uploadId);
  }
  await refreshCounts();
};

/** Znova povolí pokusy pre zlyhané položky (tlačidlo „Skúsiť znova"). */
export const retryFailedUploads = async () => {
  const uid = tokenUserId(getStoredToken());
  const items = await getAll();
  for (const i of items) {
    if (ownedBy(i, uid) && (i.attempts || 0) >= MAX_ATTEMPTS) { i.attempts = 0; await putItem(i); }
  }
  await refreshCounts();
  return processUploadQueue();
};

/**
 * Spustí sledovanie. App.jsx ho volá pri každej zmene prihlásenia —
 * listenery sa pridajú len raz, ale prechod frontou sa spustí zakaždým
 * (po novom prihlásení tak dobehnú položky, ktoré čakali na session).
 */
/**
 * Vyčerpané položky (MAX_ATTEMPTS dočasných zlyhaní — backoff ich minie za
 * ~4,5 min, napr. pri výpadku servera alebo slabom signáli) dostanú ďalší
 * JEDEN pokus pri vonkajšej udalosti: návrat siete, štart appky, návrat do
 * appky (najviac raz za REARM_ON_VISIBLE_MS). Predtým po vyčerpaní nešlo
 * nič, kým používateľ nenašiel tlačidlo — ani po obnovení servera.
 * Trvalé chyby sa mažú hneď, takže sem patria len dočasné.
 */
let lastRearmAt = 0;
const rearmExhausted = async () => {
  try {
    lastRearmAt = Date.now();
    const uid = tokenUserId(getStoredToken());
    for (const i of await getAll()) {
      if (ownedBy(i, uid) && (i.attempts || 0) >= MAX_ATTEMPTS) {
        i.attempts = MAX_ATTEMPTS - 1;
        await putItem(i);
      }
    }
  } catch { /* IndexedDB zlyhanie nesmie zablokovať frontu */ }
};

let started = false;
export const startUploadQueue = () => {
  if (!started) {
    started = true;
    window.addEventListener('online', () => { rearmExhausted().then(() => processUploadQueue()); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (Date.now() - lastRearmAt > REARM_ON_VISIBLE_MS) {
        rearmExhausted().then(() => processUploadQueue());
      } else {
        processUploadQueue();
      }
    });
  }
  return rearmExhausted().then(refreshCounts).then(() => processUploadQueue());
};
