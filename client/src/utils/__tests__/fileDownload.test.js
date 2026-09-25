import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeDownloadName, downloadBlob } from '../fileDownload';
import { __resetPlatformCache } from '../platform';

/**
 * „Stiahnuť" na prílohe s '/' v názve (napr. „Faktúra 3/2026.pdf") v iOS
 * appke potichu nerobilo nič: shell zapisoval do tmp/<názov>, '/' z neho
 * urobil neexistujúci podpriečinok a zápis zlyhal bez hlášky aj bez záznamu
 * v Diagnostike. Web preto názov čistí pred KAŽDOU platformou — oprava tak
 * platí aj pre shelly v teréne, ktoré ešte nemajú natívnu sanitizáciu.
 */
const utf8Bytes = (s) => new TextEncoder().encode(s).length;

describe('safeDownloadName', () => {
  it('lomku a spätnú lomku nahradí pomlčkou, diakritiku nechá', () => {
    expect(safeDownloadName('Faktúra 3/2026.pdf')).toBe('Faktúra 3-2026.pdf');
    expect(safeDownloadName('a\\b\\c.jpg')).toBe('a-b-c.jpg');
    expect(safeDownloadName('Účtenka č. 5 — šťava.jpg')).toBe('Účtenka č. 5 — šťava.jpg');
  });

  it('riadiace znaky (\\n, \\t, NUL, DEL) nahradí pomlčkou', () => {
    expect(safeDownloadName('riadok\ndruhy\t\u0000\u007f.txt')).toBe('riadok-druhy---.txt');
  });

  it('oreže bodky a medzery na okrajoch (žiadne skryté ani ".." súbory)', () => {
    expect(safeDownloadName('  ..report.pdf.. ')).toBe('report.pdf');
    expect(safeDownloadName('.htaccess')).toBe('htaccess');
  });

  it('prázdny alebo nepoužiteľný názov → „subor"', () => {
    for (const bad of ['', '   ', '.', '..', '...', ' . ', null, undefined]) {
      expect(safeDownloadName(bad)).toBe('subor');
    }
  });

  it('je idempotentná — natívna sanitizácia v shelli už nič nezmení', () => {
    const once = safeDownloadName(' ../Faktúra 3/2026\n.pdf ');
    expect(safeDownloadName(once)).toBe(once);
  });

  it('dlhý názov s diakritikou skráti pod 200 bajtov a príponu zachová', () => {
    // 200 ZNAKOV (serverový limit) × 2 bajty = 400 bajtov > 255 (APFS limit)
    const long = 'š'.repeat(196) + '.jpg';
    const out = safeDownloadName(long);
    expect(out.endsWith('.jpg')).toBe(true);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(200);
    expect(out.startsWith('ššš')).toBe(true);
  });

  it('emoji nerozsekne na polovicu surrogate páru', () => {
    const out = safeDownloadName('😀'.repeat(80) + '.png');
    expect(out.endsWith('.png')).toBe(true);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(200);
    // Žiadny osamelý surrogate — encode/decode musí vrátiť ten istý text
    expect(new TextDecoder().decode(new TextEncoder().encode(out))).toBe(out);
  });

  it('krátky názov nechá presne tak, ako je', () => {
    expect(safeDownloadName('IMG_0005.jpeg')).toBe('IMG_0005.jpeg');
  });
});

describe('downloadBlob — čistý názov na každej platforme', () => {
  const ORIGINAL_UA = navigator.userAgent;
  const setUserAgent = (ua) => {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  };
  const blob = () => new Blob(['abc'], { type: 'image/jpeg' });
  // jsdom nemá URL.createObjectURL — web vetvu testujeme so stubom
  const { createObjectURL, revokeObjectURL } = URL;

  beforeEach(() => {
    __resetPlatformCache();
    delete window.webkit;
    delete window.NativeBridge;
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    __resetPlatformCache();
    delete window.webkit;
    delete window.NativeBridge;
    setUserAgent(ORIGINAL_UA);
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.restoreAllMocks();
  });

  it('iOS shell: postMessage dostane očistený názov, base64 dáta a mimetype', async () => {
    setUserAgent('PrplCRM-iOS/1.0 Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)');
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { iosNative: { postMessage() {} }, fileDownload: { postMessage } } };

    downloadBlob(blob(), 'Faktúra 3/2026.jpg');

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage).toHaveBeenCalledWith({
      data: 'YWJj', // base64('abc')
      fileName: 'Faktúra 3-2026.jpg',
      mimetype: 'image/jpeg',
    });
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('cudzí WKWebView s handlerom „fileDownload" nedostane nič (gate isIosNativeApp ostáva)', async () => {
    const foreign = vi.fn();
    window.webkit = { messageHandlers: { fileDownload: { postMessage: foreign } } };
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadBlob(blob(), 'x.jpg');

    expect(click).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(foreign).not.toHaveBeenCalled();
  });

  it('Android shell: saveFile dostane očistený názov', async () => {
    const saveFile = vi.fn(() => 'ok');
    window.NativeBridge = { saveFile };

    downloadBlob(blob(), 'Faktúra 3/2026.jpg');

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile).toHaveBeenCalledWith('YWJj', 'Faktúra 3-2026.jpg', 'image/jpeg');
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('web: <a download> dostane očistený názov', () => {
    let downloadAttr;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      downloadAttr = this.download;
    });

    downloadBlob(blob(), '../Faktúra 3/2026.jpg');

    expect(downloadAttr).toBe('-Faktúra 3-2026.jpg');
  });
});
