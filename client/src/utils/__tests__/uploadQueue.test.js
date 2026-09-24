import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Fronta nahrávaní musí súbor pred odoslaním VŽDY načítať do pamäte.
 *
 * WebKit (iPhone/iPad appka aj Safari, Safari na Macu) posiela Blob načítaný
 * z IndexedDB ako prázdne telo (Content-Length 0) → busboy „Unexpected end of
 * form" → 400. Od 26. 8. do 24. 9. 2026 tak na iPhone nešla nahrať žiadna
 * príloha (fotka z fotoaparátu ani z Fotiek). Overené v iOS 27 simulátore na
 * skutočnom kóde fronty pred aj po oprave.
 */
vi.mock('../authStorage', () => ({ getStoredToken: () => 'jwt-test' }));
vi.mock('../workspaceStorage', () => ({ getStoredWorkspaceId: () => 'ws-1' }));
vi.mock('../../api/api', () => ({ API_BASE_URL: 'https://api.test' }));
vi.mock('../debug', () => ({ debug: { warn: vi.fn(), log: vi.fn() } }));

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
