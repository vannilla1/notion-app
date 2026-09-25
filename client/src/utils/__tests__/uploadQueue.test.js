import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

/**
 * Fronta nahrávaní musí súbor pred odoslaním VŽDY načítať do pamäte.
 *
 * WebKit (iPhone/iPad appka aj Safari, Safari na Macu) posiela Blob načítaný
 * z IndexedDB ako prázdne telo (Content-Length 0) → busboy „Unexpected end of
 * form" → 400. Od 26. 8. do 24. 9. 2026 tak na iPhone nešla nahrať žiadna
 * príloha (fotka z fotoaparátu ani z Fotiek). Overené v iOS 27 simulátore na
 * skutočnom kóde fronty pred aj po oprave.
 *
 * Druhá časť (audit 24. 9. 2026): správanie fronty nad malou in-memory
 * IndexedDB — opakovanie, session/vlastník, zrušená transakcia, watchdog
 * prenosu a hlásenie do Diagnostiky.
 */
const h = vi.hoisted(() => ({
  token: 'jwt-test',
  reportError: vi.fn(),
  addBreadcrumb: vi.fn()
}));
vi.mock('../authStorage', () => ({ getStoredToken: () => h.token }));
vi.mock('../workspaceStorage', () => ({ getStoredWorkspaceId: () => 'ws-1' }));
vi.mock('../../api/api', () => ({ API_BASE_URL: 'https://api.test' }));
vi.mock('../debug', () => ({ debug: { warn: vi.fn(), log: vi.fn() } }));
vi.mock('../reportError', () => ({ reportError: h.reportError }));
vi.mock('../breadcrumbs', () => ({ addBreadcrumb: h.addBreadcrumb }));

import { toSendableFile, UnreadableFileError, enqueueUpload, onUploadSettled } from '../uploadQueue';

const bytes = (n) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251));
// jsdom File nemá arrayBuffer() — kód fronty vtedy ide cez FileReader fallback;
// v testoch čítame rovnako.
const readAll = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(new Uint8Array(r.result));
  r.onerror = () => reject(r.error);
  r.readAsArrayBuffer(blob);
});

describe('toSendableFile', () => {
  it('vráti NOVÝ File s rovnakými bajtmi, názvom a typom', async () => {
    const original = new File([bytes(1234)], 'IMG_0005.jpeg', { type: 'image/jpeg' });
    const out = await toSendableFile({ file: original, size: 1234, fileName: 'fotka šaca.jpg' });
    expect(out).not.toBe(original);
    expect(out).toBeInstanceOf(File);
    expect(out.name).toBe('fotka šaca.jpg');
    expect(out.type).toBe('image/jpeg');
    expect(out.size).toBe(1234);
    expect(await readAll(out)).toEqual(bytes(1234));
  });

  it('súbor prázdny už pri výbere → prázdny File, nie chyba', async () => {
    const out = await toSendableFile({ file: new File([], 'a.txt', { type: 'text/plain' }), size: 0, fileName: 'a.txt' });
    expect(out.size).toBe(0);
    expect(out.name).toBe('a.txt');
  });

  it('pri výbere mal bajty, teraz je prázdny → UnreadableFileError (neposielať prázdne telo)', async () => {
    const lost = new File([], 'image.jpg', { type: 'image/jpeg' });
    await expect(toSendableFile({ file: lost, size: 5000, fileName: 'image.jpg' }))
      .rejects.toBeInstanceOf(UnreadableFileError);
  });

  it('iná veľkosť než pri výbere → UnreadableFileError', async () => {
    const cut = new File([bytes(10)], 'image.jpg');
    await expect(toSendableFile({ file: cut, size: 11, fileName: 'image.jpg' }))
      .rejects.toMatchObject({ name: 'UnreadableFileError', reason: 'size-mismatch 10/11' });
  });

  it('čítanie zlyhá → UnreadableFileError so slovenskou hláškou', async () => {
    const broken = { size: 100, type: 'image/jpeg', arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError')) };
    const err = await toSendableFile({ file: broken, size: 100, fileName: 'x.jpg' }).catch(e => e);
    expect(err).toBeInstanceOf(UnreadableFileError);
    expect(err.message).toMatch(/nepodarilo načítať/);
    expect(err.reason).toMatch(/read-failed/);
  });

  it('staršia položka bez size s obsahom prejde', async () => {
    const out = await toSendableFile({ file: new File([bytes(7)], 'a.bin'), fileName: 'a.bin' });
    expect(out.size).toBe(7);
  });
});

describe('odoslanie — do FormData ide kópia, nie pôvodný Blob', () => {
  let sent;
  class FakeXHR {
    constructor() { this.upload = {}; this.listeners = {}; this.headers = {}; this.status = 0; this.responseText = ''; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    send(body) {
      sent = { body, headers: this.headers, url: this.url };
      this.status = 200; this.responseText = '{}';
      queueMicrotask(() => this.listeners.load?.());
    }
  }

  beforeEach(() => {
    sent = null;
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    // jsdom nemá IndexedDB → enqueueUpload ide záložnou cestou priameho odoslania
    vi.stubGlobal('indexedDB', undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pošle materializovaný File so všetkými bajtmi a správnymi hlavičkami', async () => {
    const original = new File([bytes(4096)], 'image.jpg', { type: 'image/jpeg' });
    const settled = vi.fn();
    const off = onUploadSettled(settled);
    const res = await enqueueUpload({ kind: 'task', taskId: 't1', subtaskId: 's1', file: original, customName: 'image.jpg' });
    off();

    expect(res.ok).toBe(true);
    const part = sent.body.get('file');
    expect(part).not.toBe(original);
    expect(part.size).toBe(4096);
    expect(await readAll(part)).toEqual(bytes(4096));
    expect(sent.body.get('uploadId')).toBeTruthy();
    expect(sent.url).toBe('https://api.test/api/tasks/t1/files?subtaskId=s1');
    expect(sent.headers.Authorization).toBe('Bearer jwt-test');
    expect(sent.headers['X-Workspace-Id']).toBe('ws-1');
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('nečitateľný súbor sa NEODOŠLE a volajúci dostane zrozumiteľnú chybu', async () => {
    const broken = { name: 'image.jpg', size: 900, type: 'image/jpeg', arrayBuffer: () => Promise.reject(new Error('gone')) };
    const settled = vi.fn();
    const off = onUploadSettled(settled);
    await enqueueUpload({ kind: 'contact', contactId: 'c1', file: broken, customName: 'image.jpg' });
    off();
    expect(sent).toBeNull();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, message: expect.stringMatching(/nepodarilo načítať/) }));
  });
});

// ── Fronta nad in-memory IndexedDB ─────────────────────────────────────────

/**
 * Minimálna IndexedDB: open → db.transaction → objectStore get/put/delete.
 * Udalosti chodia cez mikroúlohy (ako v prehliadači — asynchrónne).
 * `failPut` napodobní Chromium pri plnom úložisku: put request uspeje,
 * transakcia skončí LEN udalosťou 'abort' s QuotaExceededError.
 */
const createFakeIdb = () => {
  const data = new Map();
  const stats = { opened: 0, closed: 0 };
  const later = (fn) => Promise.resolve().then(fn);
  const fake = {
    data, stats, failPut: null,
    open() {
      const req = {};
      later(() => {
        stats.opened++;
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          close() { stats.closed++; },
          transaction() {
            let abortErr = null;
            const t = { error: null };
            const store = {
              getAll: () => ({ result: [...data.values()].map(v => ({ ...v })) }),
              put: (v) => {
                if (fake.failPut) { abortErr = fake.failPut(); return { result: v.uploadId }; }
                data.set(v.uploadId, { ...v });
                return { result: v.uploadId };
              },
              delete: (k) => { data.delete(k); return { result: undefined }; }
            };
            t.objectStore = () => store;
            t.abort = () => { abortErr = abortErr || new DOMException('aborted', 'AbortError'); };
            later(() => later(() => {
              if (abortErr) { t.error = abortErr; t.onabort?.(); } else t.oncomplete?.();
            }));
            return t;
          }
        };
        req.onsuccess?.();
      });
      return req;
    }
  };
  return fake;
};

/** Ovládateľné XHR — test rozhoduje, kedy a ako server odpovie. */
class QueueXHR {
  static sent = [];
  static onSend = null;
  constructor() { this.upload = {}; this.listeners = {}; this.headers = {}; this.status = 0; this.responseText = ''; this.aborted = false; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  abort() { this.aborted = true; this.listeners.abort?.(); }
  send(body) { this.body = body; QueueXHR.sent.push(this); QueueXHR.onSend?.(this); }
  finish(status, json) {
    this.status = status;
    this.responseText = json === undefined ? '' : JSON.stringify(json);
    this.listeners.load?.();
  }
  fail() { this.listeners.error?.(); }
  progress(loaded, total) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }); }
  get fileName() { return this.body?.get('file')?.name; }
}

// Súbor s arrayBuffer() — bez jsdom FileReadera, všetko ide cez mikroúlohy
const memFile = (name, size, type = 'image/jpeg', readSize = size) => ({
  name, size, type, arrayBuffer: () => Promise.resolve(bytes(readSize).buffer)
});

const b64url = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwtFor = (id, extra = {}) => `${b64url({ alg: 'HS256' })}.${b64url({ id, ...extra })}.sig`;

// Jedno kolo makroúlohy spláchne všetky reťazené mikroúlohy (fake IDB aj XHR)
const drain = async () => {
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
};

const seedItem = (idb, overrides = {}) => {
  const item = {
    uploadId: overrides.uploadId || `seed-${Math.random().toString(16).slice(2)}`,
    kind: 'task', taskId: 't1', contactId: null, subtaskId: null,
    file: memFile(overrides.fileName || 'seed.jpg', 50),
    size: 50, fileName: 'seed.jpg', customName: '', workspaceId: 'ws-1',
    createdAt: 1, attempts: 0, ...overrides
  };
  idb.data.set(item.uploadId, item);
  return item;
};

describe('fronta nahrávaní (in-memory IndexedDB)', () => {
  let idb;
  let q;

  beforeEach(async () => {
    // Časovače fronty (backoff, watchdog) sú falošné — test ich posúva sám
    // a žiadny nepretečie do ďalšieho testu. setImmediate ostáva skutočný.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    idb = createFakeIdb();
    vi.stubGlobal('indexedDB', idb);
    vi.stubGlobal('XMLHttpRequest', QueueXHR);
    QueueXHR.sent = [];
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(201, { ok: true }));
    h.token = jwtFor('user-a');
    h.reportError.mockClear();
    h.addBreadcrumb.mockClear();
    vi.resetModules();
    q = await import('../uploadQueue');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('druhá príloha pridaná počas prenosu prvej sa odošle hneď po nej (bez ďalšej udalosti)', async () => {
    QueueXHR.onSend = null; // odpovedáme ručne
    const settled = vi.fn();
    q.onUploadSettled(settled);

    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('A.jpg', 40) });
    await drain();
    expect(QueueXHR.sent.map(x => x.fileName)).toEqual(['A.jpg']);

    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('B.jpg', 30) });
    await drain();
    expect(QueueXHR.sent).toHaveLength(1); // A ešte beží

    QueueXHR.sent[0].finish(201, {});
    await drain();
    expect(QueueXHR.sent.map(x => x.fileName)).toEqual(['A.jpg', 'B.jpg']);

    QueueXHR.sent[1].finish(201, {});
    await drain();
    expect(idb.data.size).toBe(0);
    expect(settled.mock.calls.map(c => [c[0].ok, c[0].item.fileName])).toEqual([[true, 'A.jpg'], [true, 'B.jpg']]);
  });

  it('volanie processUploadQueue počas behu sa nestratí (rerun) a vráti bežiaci Promise', async () => {
    QueueXHR.onSend = null;
    seedItem(idb, { uploadId: 'a', fileName: 'A.jpg' });
    const first = q.processUploadQueue();
    await drain();
    expect(q.processUploadQueue()).toBe(first);
    QueueXHR.sent[0].finish(201, {});
    await first;
    expect(idb.data.size).toBe(0);
  });

  it('dočasná chyba → automatický pokus po 5 s (backoff), bez online/visibility udalosti', async () => {
    let n = 0;
    QueueXHR.onSend = (xhr) => queueMicrotask(() => (n++ === 0 ? xhr.fail() : xhr.finish(201, {})));
    await q.enqueueUpload({ kind: 'contact', contactId: 'c1', file: memFile('foto.jpg', 20) });
    await drain();
    expect(QueueXHR.sent).toHaveLength(1);
    const [stored] = [...idb.data.values()];
    expect(stored).toMatchObject({ attempts: 1, lastError: 'Chyba siete' });

    await vi.advanceTimersByTimeAsync(4999);
    await drain();
    expect(QueueXHR.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect(QueueXHR.sent).toHaveLength(2);
    expect(idb.data.size).toBe(0);
  });

  it('401 → položka OSTÁVA, pokus sa nepočíta, s tým istým tokenom sa znova neposiela', async () => {
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(401, { message: 'Neplatný alebo expirovaný token' }));
    const failed = vi.fn();
    q.onUploadFailed(failed);
    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('foto.jpg', 20) });
    await drain();

    expect(QueueXHR.sent).toHaveLength(1);
    expect([...idb.data.values()]).toEqual([expect.objectContaining({ attempts: 0, fileName: 'foto.jpg' })]);
    expect(failed).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();

    await q.processUploadQueue();
    expect(QueueXHR.sent).toHaveLength(1); // odmietnutý token sa znova neskúša

    // Po novom prihlásení (nový token toho istého účtu) príloha odíde
    h.token = jwtFor('user-a', { iat: 2 });
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(201, {}));
    await q.processUploadQueue();
    expect(QueueXHR.sent).toHaveLength(2);
    expect(QueueXHR.sent[1].headers.Authorization).toBe(`Bearer ${h.token}`);
    expect(idb.data.size).toBe(0);
  });

  it('bez tokenu (odhlásenie bez reloadu) sa neposiela nič a položka čaká', async () => {
    seedItem(idb, { uploadId: 'x', ownerId: 'user-a' });
    h.token = null;
    await q.processUploadQueue();
    expect(QueueXHR.sent).toHaveLength(0);
    expect(idb.data.has('x')).toBe(true);

    h.token = jwtFor('user-a');
    await q.processUploadQueue();
    expect(QueueXHR.sent).toHaveLength(1);
    expect(QueueXHR.sent[0].headers.Authorization).not.toMatch(/null/);
  });

  it('položky iného účtu sa neodošlú ani nezobrazia; staršie bez vlastníka áno', async () => {
    seedItem(idb, { uploadId: 'cudzia', ownerId: 'user-a', createdAt: 1, fileName: 'A.jpg' });
    seedItem(idb, { uploadId: 'stara', createdAt: 2, fileName: 'legacy.jpg' }); // bez ownerId
    const states = [];
    q.subscribeUploads(s => states.push(s));

    h.token = jwtFor('user-b');
    await q.processUploadQueue();
    expect(QueueXHR.sent.map(x => x.fileName)).toEqual(['legacy.jpg']);
    expect(idb.data.has('cudzia')).toBe(true);
    expect(states.at(-1).pending).toBe(0); // B cudziu položku nevidí

    h.token = jwtFor('user-a');
    await q.processUploadQueue();
    expect(QueueXHR.sent.map(x => x.fileName)).toEqual(['legacy.jpg', 'A.jpg']);
    expect(idb.data.size).toBe(0);
  });

  it('enqueue uloží ownerId z JWT', async () => {
    QueueXHR.onSend = null;
    h.token = jwtFor('65f0c0ffee');
    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('a.jpg', 5) });
    await drain(); // prechod musí dobehnúť k falošnému XHR, nie po teste k skutočnému
    expect([...idb.data.values()][0].ownerId).toBe('65f0c0ffee');
    expect(QueueXHR.sent).toHaveLength(1);
  });

  it('iný tab drží zámok fronty → tento tab neposiela (Web Locks)', async () => {
    const request = vi.fn((name, opts, cb) => Promise.resolve(cb(null)));
    vi.stubGlobal('navigator', { ...navigator, onLine: true, locks: { request } });
    seedItem(idb, { uploadId: 'x' });
    await q.processUploadQueue();
    expect(request).toHaveBeenCalledWith('prpl-upload-queue', { ifAvailable: true }, expect.any(Function));
    expect(QueueXHR.sent).toHaveLength(0);
    expect(idb.data.has('x')).toBe(true);
  });

  it('zrušená transakcia (QuotaExceededError len cez abort) → enqueue nezavisne, ide priamo a hlási sa', async () => {
    idb.failPut = () => new DOMException('quota', 'QuotaExceededError');
    const res = await q.enqueueUpload({ kind: 'contact', contactId: 'c1', file: memFile('video.mp4', 64, 'video/mp4') });
    expect(res).toMatchObject({ queued: false, ok: true });
    expect(QueueXHR.sent).toHaveLength(1);
    expect(h.reportError).toHaveBeenCalledWith({
      name: 'QuotaExceededError',
      message: 'Fronta príloh: úložisko v zariadení nie je dostupné, príloha ide priamo'
    });
    await drain();
    expect(idb.stats.closed).toBe(idb.stats.opened); // spojenie sa zatvára pri každom konci
  });

  it('watchdog: pomalý prenos beží ďalej, zaseknutý (90 s bez bajtu) sa zruší a ostane vo fronte', async () => {
    QueueXHR.onSend = null;
    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('video.mp4', 1000, 'video/mp4') });
    await drain();
    const xhr = QueueXHR.sent[0];
    expect(xhr.timeout).toBe(0); // žiadny celkový limit na prenos

    // 6 minút pomalého, ale živého prenosu — starý 5-min timeout by ho zabil
    for (let i = 1; i <= 6; i++) {
      await vi.advanceTimersByTimeAsync(60000);
      xhr.progress(i * 100, 1000);
    }
    expect(xhr.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(89999);
    expect(xhr.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(xhr.aborted).toBe(true);
    await drain();

    const [stored] = [...idb.data.values()];
    expect(stored).toMatchObject({ attempts: 1, lastError: 'Prenos sa zastavil (slabý signál)' });
  });

  it('watchdog: po odoslaní celého tela čaká na spracovanie servera dlhšie', async () => {
    QueueXHR.onSend = null;
    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('a.jpg', 1000) });
    await drain();
    const xhr = QueueXHR.sent[0];
    xhr.progress(1000, 1000);
    await vi.advanceTimersByTimeAsync(100000);
    expect(xhr.aborted).toBe(false);
    xhr.finish(201, {});
    await drain();
    expect(idb.data.size).toBe(0);
  });

  it('starý server so surovým „Unexpected end of form" → slovenská hláška + stabilný report', async () => {
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(400, { message: 'Unexpected end of form' }));
    const failed = vi.fn();
    q.onUploadFailed(failed);

    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('Faktúra šéf.jpg', 1234) });
    await drain();
    await q.enqueueUpload({ kind: 'contact', contactId: 'c1', file: memFile('iné.png', 99, 'image/png') });
    await drain();

    expect(idb.data.size).toBe(0);
    expect(failed).toHaveBeenCalledTimes(2);
    for (const [o] of failed.mock.calls) {
      expect(o.ok).toBe(false);
      expect(o.code).toBe('UPLOAD_BODY_INCOMPLETE');
      expect(o.message).not.toMatch(/Unexpected end of form/);
      expect(o.message).toMatch(/nedostal celý/);
    }
    // Rovnaká správa pre rôzne súbory → jeden riadok v Diagnostike
    expect(h.reportError.mock.calls.map(c => c[0])).toEqual([
      { name: 'AttachmentUploadError', message: 'Príloha neodoslaná: HTTP 400 UPLOAD_BODY_INCOMPLETE' },
      { name: 'AttachmentUploadError', message: 'Príloha neodoslaná: HTTP 400 UPLOAD_BODY_INCOMPLETE' }
    ]);
    const crumb = h.addBreadcrumb.mock.calls[0][0];
    expect(crumb.category).toBe('upload');
    expect(crumb.message).toMatch(/status=400/);
    expect(crumb.message).toMatch(/size=1234/);
    expect(crumb.message).toMatch(/type=image\/jpeg/);
    expect(crumb.message).not.toMatch(/Faktúra|jpg/);
    expect(crumb.message.length).toBeLessThan(200);
  });

  it('nový server s kódom UPLOAD_BODY_INCOMPLETE → klient NEhlási (server ho už zapísal), hláška ostáva', async () => {
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(400, {
      code: 'UPLOAD_BODY_INCOMPLETE', message: 'Súbor sa na server nedostal celý. Vyberte ho prosím znova a nahrajte.'
    }));
    const failed = vi.fn();
    q.onUploadFailed(failed);
    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('a.jpg', 500) });
    await drain();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].message).toMatch(/nedostal celý/);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('plánový limit a 404 sa do Diagnostiky NEhlásia; plan-gate kód ide k odberateľovi', async () => {
    const replies = [
      [403, { message: 'Táto funkcia nie je dostupná.', code: 'FEATURE_NOT_IN_PLAN' }],
      [404, { message: 'Contact not found' }]
    ];
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(...replies.shift()));
    const failed = vi.fn();
    q.onUploadFailed(failed);
    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('a.jpg', 5) });
    await drain();
    await q.enqueueUpload({ kind: 'contact', contactId: 'c1', file: memFile('b.jpg', 5) });
    await drain();

    expect(h.reportError).not.toHaveBeenCalled();
    expect(failed.mock.calls[0][0]).toMatchObject({ ok: false, code: 'FEATURE_NOT_IN_PLAN', message: 'Táto funkcia nie je dostupná.' });
    expect(failed.mock.calls[1][0].message).toBe('Kontakt alebo úloha, ku ktorej príloha patrí, už neexistuje.');
  });

  it('nečitateľný súbor → UploadUnreadableFile so stabilnou správou, detaily len v breadcrumbe', async () => {
    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('image.jpg', 900, 'image/jpeg', 10) });
    await drain();
    expect(QueueXHR.sent).toHaveLength(0);
    expect(h.reportError).toHaveBeenCalledWith({ name: 'UploadUnreadableFile', message: 'Príloha sa v zariadení nedala načítať (size-mismatch)' });
    expect(h.addBreadcrumb.mock.calls[0][0].message).toMatch(/reason=size-mismatch 10\/900/);
  });

  it('409 UPLOAD_IN_PROGRESS → položka ostáva bez započítania pokusu, o 20 s sa odošle znova', async () => {
    let n = 0;
    QueueXHR.onSend = (xhr) => queueMicrotask(() => (++n === 1
      ? xhr.finish(409, { code: 'UPLOAD_IN_PROGRESS', message: 'Súbor sa ešte spracúva — o chvíľu to skúsime znova.' })
      : xhr.finish(201, {})));
    const failed = vi.fn();
    q.onUploadFailed(failed);
    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('a.jpg', 100) });
    await drain();
    expect(QueueXHR.sent).toHaveLength(1);
    const [only] = [...idb.data.values()];
    expect(only.attempts).toBe(0);

    await vi.advanceTimersByTimeAsync(20000);
    await drain();
    expect(QueueXHR.sent).toHaveLength(2);
    expect(idb.data.size).toBe(0);
    expect(failed).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('vyčerpaná položka dostane pri štarte appky ďalší pokus; opätovné vyčerpanie sa už nehlási', async () => {
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.fail());
    seedItem(idb, { uploadId: 'x', attempts: 5, exhaustedReported: true, ownerId: 'user-a' });
    await q.startUploadQueue();
    await drain();
    expect(QueueXHR.sent).toHaveLength(1);
    expect(idb.data.get('x').attempts).toBe(5);
    expect(h.reportError).not.toHaveBeenCalled();

    // server sa medzitým spamätal → ďalší štart ju odošle
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(201, {}));
    await q.startUploadQueue();
    await drain();
    expect(QueueXHR.sent).toHaveLength(2);
    expect(idb.data.size).toBe(0);
  });

  it('cudzia položka (iný účet) sa pri štarte neoživí', async () => {
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(201, {}));
    seedItem(idb, { uploadId: 'foreign', attempts: 5, ownerId: 'user-b' });
    await q.startUploadQueue();
    await drain();
    expect(QueueXHR.sent).toHaveLength(0);
    expect(idb.data.get('foreign').attempts).toBe(5);
  });

  it('po mäkkom odhlásení: B nevidí prenos ani zlyhanie A; A ho dostane po návrate', async () => {
    let pending = null;
    QueueXHR.onSend = (xhr) => { pending = xhr; };
    seedItem(idb, { uploadId: 'a1', fileName: 'A.jpg', ownerId: 'user-a' });
    const run = q.processUploadQueue();
    await drain();
    expect(pending).toBeTruthy();

    // A sa odhlási, prihlási sa B (bez reloadu)
    h.token = jwtFor('user-b');
    const seenByB = [];
    q.subscribeUploads(st => seenByB.push(st));
    expect(seenByB.at(-1).active).toBeNull();
    pending.progress(50, 100);
    expect(seenByB.every(st => st.active === null)).toBe(true);

    const bFailed = vi.fn();
    q.onUploadFailed(bFailed);
    pending.finish(403, { code: 'NOT_MEMBER', message: 'Nie ste členom prostredia.' });
    await run;
    await drain();
    expect(bFailed).not.toHaveBeenCalled();

    // A sa vráti → kartička o jeho súbore sa mu doručí
    h.token = jwtFor('user-a');
    const aFailed = vi.fn();
    q.onUploadFailed(aFailed);
    expect(aFailed).toHaveBeenCalledTimes(1);
    expect(aFailed.mock.calls[0][0].item.uploadId).toBe('a1');
  });

  it('vyčerpané pokusy → jeden report, žiadny ďalší automatický pokus', async () => {
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.fail());
    seedItem(idb, { uploadId: 'x', attempts: 4 });
    await q.processUploadQueue();
    expect(idb.data.get('x').attempts).toBe(5);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith({ name: 'AttachmentUploadError', message: 'Príloha neodoslaná ani po 5 pokusoch: sieťová chyba' });

    await vi.advanceTimersByTimeAsync(600000);
    await drain();
    expect(QueueXHR.sent).toHaveLength(1);
  });

  it('položka, ktorá vyčerpá pokusy, nezablokuje ďalšie — idú hneď, bez udalosti', async () => {
    // Video A zlyháva na slabom signáli, fotka B bola pridaná medzitým.
    // Doteraz: 5. zlyhanie A → break bez časovača → B nečakane visela, kým
    // neprišla udalosť (návrat do appky, sieť, prihlásenie).
    QueueXHR.onSend = (xhr) => queueMicrotask(() => (xhr.fileName === 'A.mp4' ? xhr.fail() : xhr.finish(201, {})));
    seedItem(idb, { uploadId: 'a', fileName: 'A.mp4', attempts: 4, createdAt: 1 });
    seedItem(idb, { uploadId: 'b', fileName: 'B.jpg', attempts: 0, createdAt: 2 });
    const states = [];
    q.subscribeUploads(s => states.push(s));

    await q.processUploadQueue();
    expect(QueueXHR.sent.map(x => x.fileName)).toEqual(['A.mp4', 'B.jpg']);
    expect(idb.data.has('b')).toBe(false);
    expect(idb.data.get('a')).toMatchObject({ attempts: 5, lastError: 'Chyba siete' });
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith({ name: 'AttachmentUploadError', message: 'Príloha neodoslaná ani po 5 pokusoch: sieťová chyba' });
    expect(states.at(-1)).toMatchObject({ active: null, pending: 1, failed: 1, retrying: 0 });

    // Vyčerpaná A sa sama znova neskúša (rozhodne používateľ)
    await vi.advanceTimersByTimeAsync(3600000);
    await drain();
    expect(QueueXHR.sent).toHaveLength(2);
  });

  it('za vyčerpanou položkou zlyhá aj ďalšia (sieť je preč) → tá si naplánuje backoff', async () => {
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.fail());
    seedItem(idb, { uploadId: 'a', fileName: 'A.mp4', attempts: 4, createdAt: 1 });
    seedItem(idb, { uploadId: 'b', fileName: 'B.jpg', attempts: 0, createdAt: 2 });

    await q.processUploadQueue();
    expect(QueueXHR.sent.map(x => x.fileName)).toEqual(['A.mp4', 'B.jpg']);
    expect(idb.data.get('a').attempts).toBe(5);
    expect(idb.data.get('b').attempts).toBe(1);

    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(201, {}));
    await vi.advanceTimersByTimeAsync(5000);
    await drain();
    expect(QueueXHR.sent.map(x => x.fileName)).toEqual(['A.mp4', 'B.jpg', 'B.jpg']);
    expect(idb.data.has('b')).toBe(false);
    expect(idb.data.has('a')).toBe(true); // vyčerpaná ostáva pre tlačidlo
  });

  it('indikátor: vyčerpaná príloha popri čakajúcej má „Skúsiť znova" aj „Zahodiť neodoslané"', async () => {
    // Presne stav z auditu: pending 2, failed 1, retrying 0 (B ešte neodišla —
    // tu offline). Doteraz len „2 príloh čaká na odoslanie…" bez tlačidla.
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    seedItem(idb, { uploadId: 'a', fileName: 'A.mp4', attempts: 5, createdAt: 1, lastError: 'Chyba siete' });
    seedItem(idb, { uploadId: 'b', fileName: 'B.jpg', attempts: 0, createdAt: 2 });
    await q.processUploadQueue();
    expect(QueueXHR.sent).toHaveLength(0);

    // Indikátor až po resetModules v beforeEach → zdieľa tú istú inštanciu fronty
    const { default: UploadQueueIndicator } = await import('../../components/UploadQueueIndicator');
    render(createElement(UploadQueueIndicator));
    expect(screen.getByRole('status')).toHaveTextContent('1 príloha čaká na odoslanie…');
    expect(screen.getByRole('status')).toHaveTextContent('1 príloha sa neodoslala ani po opakovaných pokusoch');
    expect(screen.getByRole('button', { name: 'Zahodiť neodoslané' })).toBeInTheDocument();

    // „Skúsiť znova" vráti pokusy A a hneď pošle obe (najstaršia najprv)
    onLine.mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skúsiť znova' }));
      await drain();
    });
    expect(QueueXHR.sent.map(x => x.fileName)).toEqual(['A.mp4', 'B.jpg']);
    expect(idb.data.size).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('indikátor: „Zahodiť neodoslané" zmaže len vyčerpanú, čakajúca ostane aj s dôvodom opakovania', async () => {
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.fail());
    seedItem(idb, { uploadId: 'a', fileName: 'A.mp4', attempts: 4, createdAt: 1 });
    seedItem(idb, { uploadId: 'b', fileName: 'B.jpg', attempts: 0, createdAt: 2 });
    await q.processUploadQueue(); // A vyčerpaná, B čaká na backoff

    const { default: UploadQueueIndicator } = await import('../../components/UploadQueueIndicator');
    render(createElement(UploadQueueIndicator));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('1 príloha čaká na odoslanie…');
    expect(status).toHaveTextContent('Posledný pokus zlyhal: Chyba siete');
    expect(status).toHaveTextContent('1 príloha sa neodoslala ani po opakovaných pokusoch');
    expect(screen.queryByRole('button', { name: 'Skúsiť teraz' })).toBeNull(); // „Skúsiť znova" pokryje obe

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Zahodiť neodoslané' }));
      await drain();
    });
    expect(idb.data.has('a')).toBe(false);
    expect(idb.data.get('b')).toMatchObject({ attempts: 1 });
    expect(screen.getByRole('status')).not.toHaveTextContent('neodoslala');
    expect(screen.getByRole('button', { name: 'Skúsiť teraz' })).toBeInTheDocument();
  });

  it('zlyhanie bez globálneho odberateľa sa podrží a doručí po pripojení indikátora', async () => {
    QueueXHR.onSend = (xhr) => queueMicrotask(() => xhr.finish(400, { message: 'Súbor je poškodený.', code: 'UPLOAD_REJECTED' }));
    await q.enqueueUpload({ kind: 'task', taskId: 't1', file: memFile('a.jpg', 5) });
    await drain();
    const failed = vi.fn();
    q.onUploadFailed(failed);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ ok: false, message: 'Súbor je poškodený.', code: 'UPLOAD_REJECTED' }));
  });

  it('startUploadQueue pridá listenery len raz, prechod spustí zakaždým', async () => {
    const winAdd = vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    const docAdd = vi.spyOn(document, 'addEventListener').mockImplementation(() => {});
    QueueXHR.onSend = null;
    h.token = null;
    seedItem(idb, { uploadId: 'x' });
    await q.startUploadQueue();
    h.token = jwtFor('user-a');
    q.startUploadQueue();
    await drain();
    expect(winAdd.mock.calls.filter(c => c[0] === 'online')).toHaveLength(1);
    expect(docAdd.mock.calls.filter(c => c[0] === 'visibilitychange')).toHaveLength(1);
    expect(QueueXHR.sent).toHaveLength(1); // druhé volanie (po prihlásení) frontu rozbehlo
  });
});

describe('uploadErrorMessage', () => {
  let q;
  beforeEach(async () => { vi.resetModules(); q = await import('../uploadQueue'); });

  it('surový anglický text multera/busboya sa používateľovi nikdy neukáže', () => {
    expect(q.uploadErrorMessage({ status: 400, serverMessage: 'Unexpected end of form' })).not.toMatch(/Unexpected/);
    expect(q.uploadErrorMessage({ status: 400, serverMessage: 'Unexpected field' })).not.toMatch(/Unexpected/);
    expect(q.uploadErrorMessage({ status: 500, serverMessage: 'Internal Server Error' })).toBe('Server je dočasne nedostupný (HTTP 500).');
    expect(q.uploadErrorMessage({ status: 400, code: 'BLOCKED_EXTENSION' })).toMatch(/nie je z bezpečnostných dôvodov povolený/);
  });

  it('slovenskú hlášku servera nechá tak', () => {
    expect(q.uploadErrorMessage({ status: 403, code: 'STORAGE_LIMIT', serverMessage: 'Dosiahli ste storage limit (10/10 MB).' }))
      .toBe('Dosiahli ste storage limit (10/10 MB).');
    // iOS variant servera je bez diakritiky — nesmie sa pomýliť s angličtinou
    expect(q.uploadErrorMessage({ status: 403, serverMessage: 'Dosiahli ste storage limit (10/10 MB).' }))
      .toBe('Dosiahli ste storage limit (10/10 MB).');
    expect(q.uploadErrorMessage({ status: 400, serverMessage: 'Chyba servera' })).toBe('Chyba servera');
    expect(q.uploadErrorMessage({ status: 404, serverMessage: 'Contact not found' })).toMatch(/už neexistuje/);
  });
});
