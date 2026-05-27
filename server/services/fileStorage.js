/**
 * fileStorage.js — Cloudflare R2 (S3-compatible) file storage service.
 *
 * Prečo R2 a nie MongoDB? MongoDB Atlas free tier má 512 MB limit a base64
 * súbory tam expandujú na 1.33× pôvodnú veľkosť. Pri 83 contact files
 * sme narazili na 91% využitia DB. R2 dáva 10 GB grátis a $0.015/GB/mes
 * over to, zero egress fee.
 *
 * Tento module:
 *   - Inicializuje S3 client smerovaný na R2 endpoint
 *   - Poskytuje uploadFile(), downloadFile(), deleteFile(), getPresignedUrl()
 *   - Fail-safe: ak chýbajú env vars, isR2Available() vráti false a routes
 *     môžu fallnúť na legacy MongoDB base64 storage (počas migrácie)
 *
 * R2 endpoint format: https://<account_id>.r2.cloudflarestorage.com
 * Region MUSI byť 'auto' (R2 quirk — odlišne od AWS S3).
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('../utils/logger');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'prplcrm-files';

const isConfigured = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);

let s3Client = null;
if (isConfigured) {
  s3Client = new S3Client({
    region: 'auto', // R2 nepoužíva regions; 'auto' je dokumentovaná hodnota
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY
    }
  });
  logger.info('[FileStorage] R2 configured', { bucket: R2_BUCKET });
} else {
  logger.warn('[FileStorage] R2 NOT configured — file uploads will fall back to MongoDB base64 (DEPRECATED)');
}

/**
 * Či je R2 storage k dispozícii. Použiteľné v route handler-och ako gate
 * — ak false, fall-back na legacy base64 do MongoDB.
 */
function isR2Available() {
  return isConfigured;
}

/**
 * Upload buffera do R2 pod daným key-om.
 *
 * @param {string} key — path v buckete, napr. "contactfiles/abc-123"
 * @param {Buffer} buffer — file content
 * @param {string} contentType — MIME type (napr. "image/jpeg")
 * @returns {Promise<string>} — vráti key (pre uloženie do DB)
 */
async function uploadFile(key, buffer, contentType) {
  if (!isConfigured) throw new Error('R2 not configured');
  if (!Buffer.isBuffer(buffer)) throw new Error('uploadFile: buffer must be a Buffer');

  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream'
  });

  await s3Client.send(cmd);
  logger.debug('[FileStorage] Uploaded', { key, size: buffer.length });
  return key;
}

/**
 * Stiahnutie file-u z R2 ako Buffer. Pre menšie files (do ~5 MB) ide priamo
 * cez Node Body stream. Pre väčšie files je lepšie použiť getPresignedUrl()
 * a presmerovať user-a → menšia záťaž na backend.
 */
async function downloadFile(key) {
  if (!isConfigured) throw new Error('R2 not configured');
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  const response = await s3Client.send(cmd);
  // Body je Readable stream (Node) alebo ReadableStream (Web)
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Vymaže file z R2. Bezpečné aj keď file neexistuje (R2 vráti 204 buď
 * tak buď tak). Idempotentné.
 */
async function deleteFile(key) {
  if (!isConfigured) return;
  try {
    const cmd = new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key });
    await s3Client.send(cmd);
    logger.debug('[FileStorage] Deleted', { key });
  } catch (err) {
    // R2 nehádže 404 pri delete, ale rate-limit alebo connectivity issue áno
    logger.warn('[FileStorage] Delete failed (non-fatal)', { key, error: err.message });
  }
}

/**
 * Vygeneruje time-limited pre-signed URL pre direct download. Klient stiahne
 * file priamo z R2 → backend nemusí streamovať (úspora CPU + RAM + bandwidth).
 *
 * TTL default 5 min (dosť na začať download, nie tak veľa aby URL ostala
 * platná navždy ak ju user prepošle).
 */
async function getPresignedUrl(key, ttlSec = 300) {
  if (!isConfigured) throw new Error('R2 not configured');
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  return getSignedUrl(s3Client, cmd, { expiresIn: ttlSec });
}

/**
 * Overí že file existuje v R2 (HEAD request, neprenáša body). Vráti true/false.
 * Hodí sa pre migration script — overiť že upload reálne dorazil pred unset-om
 * legacy `data` field-u.
 */
async function fileExists(key) {
  if (!isConfigured) return false;
  try {
    const cmd = new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key });
    await s3Client.send(cmd);
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err; // iné error-y propagujeme
  }
}

/**
 * Helper — vygeneruje canonical key pre contact file. Format zámerne plochý
 * (žiadne nested paths) lebo R2 nemá adresáre, key je opaque string.
 *
 * Použité v upload endpoint-och: `contactfiles/<fileId>` kde fileId je UUID v4.
 */
function contactFileKey(fileId) {
  return `contactfiles/${fileId}`;
}

/**
 * Vráti aggregate stats pre celý bucket: počet objektov + total bytes.
 *
 * Implementácia: ListObjectsV2 s pagination (max 1000 objektov per call).
 * Pre tvojich 83 files = 1 call. Pri 10000 files = 10 calls. Stále v
 * Cloudflare R2 free tier (1M class A ops/mes).
 *
 * Pre prehľad v admin paneli — paralela k MongoDB tier usage card.
 * Cache na strane volajúceho, neukladáme tu (každý refresh fetchne fresh).
 */
async function getBucketStats() {
  if (!isConfigured) {
    return { configured: false, objectCount: 0, totalBytes: 0 };
  }

  let objectCount = 0;
  let totalBytes = 0;
  let continuationToken = undefined;

  // Pagination loop — Cloudflare R2 limit je 1000 objektov per response
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      MaxKeys: 1000,
      ContinuationToken: continuationToken
    });
    const response = await s3Client.send(cmd);
    const contents = response.Contents || [];
    objectCount += contents.length;
    totalBytes += contents.reduce((sum, obj) => sum + (obj.Size || 0), 0);
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return {
    configured: true,
    bucket: R2_BUCKET,
    objectCount,
    totalBytes,
    // R2 free tier: 10 GB storage, 1M class A ops, 10M class B ops / mes
    freeTierStorageBytes: 10 * 1024 * 1024 * 1024,
    usagePct: parseFloat(((totalBytes / (10 * 1024 * 1024 * 1024)) * 100).toFixed(2))
  };
}

module.exports = {
  isR2Available,
  uploadFile,
  downloadFile,
  deleteFile,
  getPresignedUrl,
  fileExists,
  contactFileKey,
  getBucketStats,
  // Vystavujeme bucket name pre logging / diagnostiku
  bucket: R2_BUCKET
};
