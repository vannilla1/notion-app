/**
 * uploadFilter.js — spoločný multer fileFilter pre prílohy kontaktov a úloh.
 *
 * Prílohy sú dokumentový sklad tímu — allowlist povolených typov večne
 * odmietal legitímne dokumenty (HEIC fotky z iPhonu, ODT/ODS z LibreOffice,
 * EML/MSG e-maily, PAGES/NUMBERS…). Preto BLOCKLIST: povolené je všetko
 * OKREM spustiteľných/inštalačných formátov (vektor šírenia malvéru v tíme).
 *
 * Bezpečnostný kontext: bloby žijú v R2 a download ide VŽDY s
 * Content-Disposition: attachment (contacts.js/tasks.js) — prehliadač súbor
 * stiahne, nikdy nevykreslí na API origine, takže HTML/SVG tu nie sú XSS
 * vektor. Blocklist chráni pred „kolega mi poslal appku, tak som ju spustil".
 *
 * Messages majú vlastný prísnejší filter (base64 v Mongo, videá zakázané
 * kvôli 16 MB BSON stropu) — tento util sa ich netýka.
 */
const BLOCKED_EXTENSIONS = new Set([
  // Windows spustiteľné / skripty
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'msc', 'hta',
  'vbs', 'vbe', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'reg', 'lnk',
  // Unix / mac spustiteľné a balíky
  'sh', 'bash', 'zsh', 'command', 'app', 'dmg', 'pkg', 'deb', 'rpm',
  // Mobil / Java
  'apk', 'aab', 'ipa', 'jar',
  // Diskové obrazy (obchádzajú mail filtre, bežný malvér vektor)
  'iso', 'img', 'vhd'
]);

/**
 * Názov súboru z multipart hlavičky → správny Unicode.
 *
 * multer 1.4.5-lts.2 vytvára busboy bez defParamCharset, takže busboy dekóduje
 * `filename="…"` ako latin1. Prehliadače (desktop, iOS, Android) ale posielajú
 * surové UTF-8 bajty → „faktúra č. 5.pdf" sa uložilo ako „faktÃºra Ä. 5.pdf".
 * Prílohy kontaktov/úloh to doteraz obchádzali len vďaka poľu customName;
 * správy (messages.js) ho nemajú.
 *
 * Bezpečné voči dvojitému dekódovaniu: ak názov obsahuje znak mimo latin1
 * (busboy ho už dekódoval správne, napr. z `filename*=UTF-8''…`), alebo
 * latin1 bajty nie sú platné UTF-8 (naozaj to bol latin1), nechá ho tak.
 */
const normalizeUploadName = (name) => {
  if (typeof name !== 'string' || !name) return name;
  if (!/^[\x00-\xff]*$/.test(name)) return name;
  if (!/[\x80-\xff]/.test(name)) return name; // čisté ASCII — nie je čo opravovať
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
};

/**
 * Zobrazovaný názov prílohy (customName / originalName) bez znakov, ktoré
 * rozbíjajú ukladanie na zariadení: „/" a „\" (iOS bridge fileDownload píše do
 * tmp/<názov> → „Faktúra 3/2026" = neexistujúci podpriečinok, Stiahnuť ticho
 * zlyhá), riadiace znaky, bodky/medzery na krajoch. Prázdny výsledok → null.
 */
const sanitizeDisplayName = (name) => {
  if (typeof name !== 'string') return null;
  const cleaned = name
    .replace(/[\/\\]/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 255);
  return cleaned || null;
};

/**
 * Prípona tak, ako bude uložená a ponúknutá na stiahnutie. Zobrazovaný názov
 * prechádza sanitizeDisplayName (orezá koncové bodky, medzery, riadiace
 * znaky) — „faktura.exe." by inak prešla blocklistom (prípona „") a uložila
 * sa ako „faktura.exe".
 */
const effectiveExtension = (name) => {
  const cleaned = sanitizeDisplayName(typeof name === 'string' ? name : '') || '';
  const dot = cleaned.lastIndexOf('.');
  return dot === -1 ? '' : cleaned.slice(dot + 1).toLowerCase();
};

const hasBlockedExtension = (name) => BLOCKED_EXTENSIONS.has(effectiveExtension(name));

const attachmentFileFilter = (req, file, cb) => {
  // Musí byť prvé: multer odovzdáva ten istý objekt ďalej ako req.file,
  // takže oprava názvu sa prenesie do route handlera.
  file.originalname = normalizeUploadName(file.originalname);
  if (hasBlockedExtension(file.originalname)) {
    const err = new Error('Tento typ súboru nie je z bezpečnostných dôvodov povolený (spustiteľný súbor).');
    err.code = 'BLOCKED_EXTENSION';
    return cb(err);
  }
  cb(null, true);
};

module.exports = { attachmentFileFilter, BLOCKED_EXTENSIONS, normalizeUploadName, sanitizeDisplayName, effectiveExtension, hasBlockedExtension };
