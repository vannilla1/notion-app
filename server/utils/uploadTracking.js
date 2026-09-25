/**
 * uploadTracking.js — viditeľnosť prerušených a odmietnutých nahrávaní.
 *
 * Prerušený upload (používateľ zavrel appku, zamkol telefón, vypadol
 * signál) bol doteraz ÚPLNE neviditeľný: server súbor nezaložil, do
 * Diagnostiky nešlo nič (nie je to chyba appky) a ani do štatistík
 * requestov — tie sa počítajú až na `res.finish`, ktorý nikdy nenastane.
 * Preto sa nedalo zistiť, ako často k tomu dochádza.
 *
 * Teraz sa každý prerušený prenos zapíše do audit logu (AdminPanel →
 * Audit log, akcia 'file.upload_aborted') aj s tým, koľko bajtov sa
 * stihlo preniesť — z toho vidno, či ide o ojedinelý prípad alebo vzor.
 *
 * Odmietnuté nahrávanie (multer/busboy chyba, chýbajúca časť so súborom)
 * končí 400-kou, ktorú Diagnostika sama nezachytí (errorMiddleware aj
 * captureResponseErrors zapisujú len 5xx). Presne preto bol iOS bug
 * „Unexpected end of form" (26.8.–24.9.2026) celý čas neviditeľný.
 * handleUploadError / rejectMissingFilePart ho teraz zapíšu do Diagnostiky
 * a klientovi vrátia slovenskú správu + `code`, podľa ktorého vie
 * rozlíšiť chybu používateľa (veľký/zakázaný súbor) od chyby prenosu.
 */
const auditService = require('../services/auditService');
const { recordError } = require('../services/serverErrorService');
const logger = require('./logger');
const { mutationKeyState } = require('./idempotency');

const trackUploadAbort = (req, context = {}) => {
  // Bajty TELA tohto requestu. req.socket.bytesRead je kumulatívny za celé
  // keep-alive spojenie (Render proxy spojenia recykluje) a zahŕňa aj
  // hlavičky — audit ukazoval napr. 70 % aj 370 % pri reálnych 10 %.
  // Listener sa registruje synchrónne tesne pred upload.single(): multer
  // v tom istom ticku volá req.pipe(busboy), takže sa nestratí žiadny chunk
  // (aj tie, čo sa nabufferovali počas async auth middleware, sa prehrajú
  // ako 'data' až keď stream začne tiecť).
  let bodyBytes = 0;
  req.on('data', (chunk) => { bodyBytes += chunk.length; });
  req.uploadBodyBytes = () => bodyBytes;

  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    // writableFinished = odpoveď sa stihla celá odoslať. Ak nie, klient
    // zmizol skôr — presne prípad zavretej appky uprostred prenosu.
    if (req.res && req.res.writableFinished) return;
    const expected = Number(req.headers['content-length'] || 0);
    const received = bodyBytes;
    logger.warn('[Upload] Prerušený prenos', {
      path: req.originalUrl,
      expectedBytes: expected,
      receivedBytes: received,
      userId: req.user?.id
    });
    auditService.logAction({
      userId: req.user?.id,
      username: req.user?.username,
      email: req.user?.email,
      action: 'file.upload_aborted',
      category: 'file',
      targetType: 'file',
      targetName: context.target || 'príloha',
      details: {
        expectedBytes: expected,
        receivedBytes: received,
        // Poistka — percento nad 100 nedáva zmysel (napr. chunked prenos
        // s nepresnou Content-Length hlavičkou).
        percent: expected > 0 ? Math.min(100, Math.round((received / expected) * 100)) : null,
        path: req.originalUrl
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId
    });
  };
  if (req.res) req.res.on('close', onClose);
};

// Chyby busboy, ktoré znamenajú „telo prišlo neúplné/poškodené". Klientsky
// abort ich NEVYVOLÁ (multer callback sa pri odpojení vôbec nezavolá), takže
// ide o chybu kódovania na strane klienta — presne to, čo má Diagnostika vidieť.
const BODY_INCOMPLETE_RE = /Unexpected end of (form|multipart data)|Malformed part header|Boundary not found/i;

const REJECTION_NAMES = {
  task: 'TaskUploadRejected',
  contact: 'ContactUploadRejected'
};

// Kontext pre Diagnostiku — len technické údaje o prenose. Nikdy názov
// súboru, obsah ani token (Authorization hlavičku nečítame).
const uploadDiagContext = (req, err) => {
  const headers = req.headers || {};
  const ct = String(headers['content-type'] || '');
  const ua = String((typeof req.get === 'function' ? req.get('user-agent') : headers['user-agent']) || '');
  const shell = ua.match(/PrplCRM-(iOS|Android)\/[\w.]+/);
  const rawLength = headers['content-length'];
  return {
    upload: {
      multerCode: err?.code || null,
      contentLength: rawLength === undefined ? null : Number(rawLength),
      bodyBytes: typeof req.uploadBodyBytes === 'function' ? req.uploadBodyBytes() : null,
      contentType: ct.split(';')[0].trim().slice(0, 60) || null,
      hasBoundary: /boundary=/i.test(ct),
      shell: shell ? shell[0] : 'web'
    }
  };
};

// Zápis do Diagnostiky — fire-and-forget, odpoveď na to nikdy nečaká.
// Správa je zámerne bez premenných hodnôt (veľkosť, UA idú do contextu):
// fingerprint = meno + route + stack, takže opakovanie zvýši count
// namiesto nového riadku.
const recordUploadRejection = (err, req, target, code) => {
  try {
    const e = new Error(`${code}: ${String(err?.message || 'Upload rejected').slice(0, 200)}`);
    e.name = REJECTION_NAMES[target] || 'UploadRejected';
    e.status = 400;
    const frames = String(err?.stack || e.stack || '').split('\n').slice(1);
    e.stack = [`${e.name}: ${e.message}`, ...frames].join('\n');
    recordError(e, req, uploadDiagContext(req, err)).catch(() => {});
  } catch (_) {
    // Sledovanie nesmie nikdy zhodiť samotnú odpoveď.
  }
};

/**
 * Spoločné ošetrenie chyby z multer callbacku (upload.single) pre prílohy
 * kontaktov a úloh. Vždy pošle 400 s `code` a slovenskou správou:
 *  - FILE_TOO_LARGE / BLOCKED_EXTENSION — chyba používateľa, do Diagnostiky nejde
 *  - UPLOAD_BODY_INCOMPLETE — busboy dostal prázdne/useknuté telo → Diagnostika
 *  - UPLOAD_REJECTED — akákoľvek iná MulterError/busboy chyba → Diagnostika
 * target: 'task' | 'contact' (meno chyby v Diagnostike).
 */
const handleUploadError = (err, req, res, target, { maxMb = 50 } = {}) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ code: 'FILE_TOO_LARGE', message: `Súbor je príliš veľký. Maximum je ${maxMb} MB.` });
  }
  if (err?.code === 'BLOCKED_EXTENSION') {
    return res.status(400).json({ code: 'BLOCKED_EXTENSION', message: err.message });
  }
  const emptyBody = String(req.headers?.['content-length'] ?? '') === '0';
  if (emptyBody || BODY_INCOMPLETE_RE.test(String(err?.message || ''))) {
    recordUploadRejection(err, req, target, 'UPLOAD_BODY_INCOMPLETE');
    return res.status(400).json({
      code: 'UPLOAD_BODY_INCOMPLETE',
      message: 'Súbor sa na server nedostal celý. Vyberte ho prosím znova a nahrajte.'
    });
  }
  recordUploadRejection(err, req, target, 'UPLOAD_REJECTED');
  return res.status(400).json({ code: 'UPLOAD_REJECTED', message: 'Súbor sa nepodarilo prijať.' });
};

/**
 * Multipart telo bez časti „file" — náš klient ho nikdy neposiela zámerne
 * (vždy FormData s jedným súborom), takže je to chyba klienta → Diagnostika.
 */
const rejectMissingFilePart = (req, res, target) => {
  recordUploadRejection(
    { message: 'No file part in multipart body', code: 'NO_FILE_PART' },
    req,
    target,
    'NO_FILE_PART'
  );
  return res.status(400).json({ code: 'NO_FILE_PART', message: 'Žiadny súbor' });
};

/**
 * Opakovaný upload s uploadId, ktorého kľúč je už zabratý:
 *  - prvý request sa DOKONČIL → 200 duplicate (klient položku z fronty zmaže),
 *  - prvý request ešte BEŽÍ (napr. pomalé R2) → 409 UPLOAD_IN_PROGRESS; klient
 *    položku NECHÁ a skúsi neskôr. Keby dostal „duplicate" a prvý request by
 *    potom zlyhal, príloha by sa stratila (kópia v zariadení už zmazaná).
 */
const respondToHeldUploadKey = (res, key) => {
  if (mutationKeyState(key) === 'done') {
    return res.status(200).json({ message: 'Súbor už bol nahraný', duplicate: true });
  }
  return res.status(409).json({
    code: 'UPLOAD_IN_PROGRESS',
    message: 'Súbor sa ešte spracúva — o chvíľu to skúsime znova.'
  });
};

module.exports = {
  trackUploadAbort,
  handleUploadError,
  rejectMissingFilePart,
  respondToHeldUploadKey,
  // Pre testy
  _uploadDiagContext: uploadDiagContext,
  _BODY_INCOMPLETE_RE: BODY_INCOMPLETE_RE
};
