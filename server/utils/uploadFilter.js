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

const attachmentFileFilter = (req, file, cb) => {
  const ext = file.originalname.toLowerCase().split('.').pop();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return cb(new Error('Tento typ súboru nie je z bezpečnostných dôvodov povolený (spustiteľný súbor).'));
  }
  cb(null, true);
};

module.exports = { attachmentFileFilter, BLOCKED_EXTENSIONS };
