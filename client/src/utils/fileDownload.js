/**
 * Stiahnutie blobu — web, iOS shell aj Android shell.
 *
 * Každá platforma potrebuje inú cestu:
 *  - iOS   → WKScriptMessage 'fileDownload' (base64) → share sheet
 *  - Android → NativeBridge.saveFile (base64) → priečinok Stiahnuté
 *              (WebView bez tohto nestiahne NIČ — blob: aj <a download>
 *               sú tichý no-op; do 1.0.5 tam sťahovanie vôbec nefungovalo)
 *  - web   → <a download> s object URL
 *
 * Veľké súbory (hromadný ZIP) NEIDÚ cez túto funkciu — tam sa naviguje
 * priamo na odkaz a shell si to zoberie natívne (iOS share sheet /
 * Android DownloadManager), bez base64 v pamäti.
 */
import { isIosNativeApp } from './platform';

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
  reader.readAsDataURL(blob);
});

// Horná hranica názvu v UTF-8 bajtoch. APFS (iOS) aj súborové systémy
// Androidu dovolia 255 bajtov na jeden názov. Server reže customName na 200
// ZNAKOV, ale š/č/ž/ú majú po 2 bajty — dlhý názov s diakritikou by v iOS
// shelli zlyhal pri zápise (ENAMETOOLONG) rovnako potichu ako názov s '/'.
const MAX_NAME_BYTES = 200;
// Dlhší „koniec za bodkou" nie je prípona, ale kus názvu (napr. „Zmluva.verzia-…").
const MAX_EXT_LENGTH = 16;

const byteLength = (s) => new TextEncoder().encode(s).length;

function truncateKeepingExtension(name, maxBytes) {
  if (byteLength(name) <= maxBytes) return name;
  // Príponu (.jpg, .pdf) zachováme — podľa nej iOS share sheet ponúkne
  // „Uložiť obrázok" a Android/desktop vyberie appku na otvorenie.
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= MAX_EXT_LENGTH ? name.slice(dot) : '';
  const base = ext ? name.slice(0, dot) : name;
  let budget = maxBytes - byteLength(ext);
  let out = '';
  // for…of ide po code pointoch — nerozsekne surrogate pár (emoji).
  for (const ch of base) {
    const size = byteLength(ch);
    if (size > budget) break;
    budget -= size;
    out += ch;
  }
  return (out.replace(/[.\s]+$/, '') || 'subor') + ext;
}

/**
 * Názov súboru bezpečný pre web, iOS aj Android shell.
 *
 * Príloha sa dá pomenovať „Faktúra 3/2026" (FileRenameModal ani server '/'
 * neodstraňujú). iOS shell do 1.0.18 zapisuje base64 do tmp/<názov> — '/'
 * z neho urobí neexistujúci podpriečinok, zápis zlyhá a „Stiahnuť" potichu
 * neurobí nič (bez hlášky, bez záznamu v Diagnostike). Čistením tu opravíme
 * už uložené názvy aj shelly v teréne bez rebuildu. Rovnaké pravidlá majú
 * sanitizeDownloadName (ContentView.swift) a sanitizeFileName (WebAppInterface.kt),
 * takže dvojité čistenie nič nemení.
 */
export function safeDownloadName(fileName) {
  const cleaned = String(fileName ?? '')
    .replace(/[/\\\u0000-\u001f\u007f]/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!cleaned) return 'subor';
  return truncateKeepingExtension(cleaned, MAX_NAME_BYTES);
}

export function downloadBlob(blob, rawFileName) {
  // Čistíme PRED vetvením — každá platforma dostane ten istý bezpečný názov.
  const fileName = safeDownloadName(rawFileName);

  // iOS shell. Gate na isIosNativeApp(): samotný názov handlera nestačí —
  // cudzí WKWebView (in-app prehliadač inej appky) môže mať svoj handler
  // s rovnakým menom a náš base64 payload by zmizol bez stiahnutia súboru.
  // Náš shell registruje iosNative aj fileDownload spolu (ContentView.swift).
  if (isIosNativeApp() && window.webkit?.messageHandlers?.fileDownload) {
    toBase64(blob).then(base64 => {
      window.webkit.messageHandlers.fileDownload.postMessage({
        data: base64,
        fileName,
        mimetype: blob.type || 'application/octet-stream'
      });
    }).catch(() => alert('Súbor sa nepodarilo pripraviť na stiahnutie.'));
    return;
  }

  // Android shell — feature detection, nie user-agent: v teréne zostávajú
  // staršie APK bez saveFile a tie musia dostať zrozumiteľnú hlášku,
  // nie tichý no-op.
  if (window.NativeBridge) {
    if (typeof window.NativeBridge.saveFile !== 'function') {
      alert('Sťahovanie súborov vyžaduje novšiu verziu aplikácie. Aktualizujte ju v Google Play.');
      return;
    }
    toBase64(blob).then(base64 => {
      const res = window.NativeBridge.saveFile(base64, fileName, blob.type || 'application/octet-stream');
      if (res && String(res).startsWith('error')) {
        alert('Súbor sa nepodarilo uložiť do priečinka Stiahnuté.');
      }
      // Úspech hlási natívny Toast — bez duplicitnej web hlášky
    }).catch(() => alert('Súbor sa nepodarilo pripraviť na stiahnutie.'));
    return;
  }

  // Web
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
