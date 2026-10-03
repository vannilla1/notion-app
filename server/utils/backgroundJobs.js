/**
 * backgroundJobs.js — beh dlhých request handlerov (Google Calendar/Tasks
 * /sync, až ~10 min) na pozadí s okamžitou odpoveďou 202.
 *
 * Prečo: mobilné WebView, proxy a Render request timeout dlhé HTTP spojenie
 * prerušia, kým server ďalej synchronizuje — klient ukázal chybu, hoci sync
 * prebehol. S `?async=1` dostane klient hneď `202 { jobId }` a stav si zisťuje
 * cez GET /api/jobs/:id.
 *
 * `runInBackground(handler)` obalí existujúci Express handler bez jeho
 * prepisovania: handler dostane náhradný `res`, ktorý zachytí status + JSON
 * telo a uloží ho ako výsledok jobu. Bez `?async=1` beží handler ako doteraz
 * (staršie klienty).
 *
 * Úložisko: Redis (zdieľané medzi inštanciami), inak in-memory Map. TTL 1 h.
 */
const crypto = require('crypto');
const { getRedis } = require('./redisClient');
const logger = require('./logger');

const JOB_TTL_SEC = 60 * 60;
const KEY = (id) => `bgjob:${id}`;
const memJobs = new Map();

const saveJob = async (job) => {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.setex(KEY(job.id), JOB_TTL_SEC, JSON.stringify(job));
      return;
    } catch (err) {
      logger.warn('[backgroundJobs] Redis setex failed, using memory', { error: err.message });
    }
  }
  memJobs.set(job.id, { job, expiresAt: Date.now() + JOB_TTL_SEC * 1000 });
  // Lacný úklid expirovaných
  if (memJobs.size > 500) {
    const now = Date.now();
    for (const [id, entry] of memJobs) if (entry.expiresAt < now) memJobs.delete(id);
  }
};

const getJob = async (id) => {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(KEY(id));
      if (raw) return JSON.parse(raw);
    } catch (err) {
      logger.warn('[backgroundJobs] Redis get failed', { error: err.message });
    }
  }
  const entry = memJobs.get(id);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.job;
};

// Náhradný response objekt — zachytí, čo by handler poslal klientovi.
const createCaptureRes = (onFinish) => {
  let statusCode = 200;
  let finished = false;
  const finish = (body) => {
    if (finished) return;
    finished = true;
    onFinish(statusCode, body);
  };
  const res = {
    headersSent: false,
    status(code) { statusCode = code; return res; },
    set() { return res; },
    setHeader() { return res; },
    json(body) { finish(body); return res; },
    send(body) { finish(body); return res; },
    end() { finish(null); return res; }
  };
  return res;
};

/**
 * Express wrapper. `label` slúži len do logov.
 */
const runInBackground = (label, handler) => async (req, res, next) => {
  if (req.query?.async !== '1') return handler(req, res, next);

  const job = {
    id: crypto.randomUUID(),
    label,
    userId: String(req.user?.id || ''),
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    httpStatus: null,
    body: null
  };
  await saveJob(job);
  res.status(202).json({ jobId: job.id, status: job.status });

  const captureRes = createCaptureRes((statusCode, body) => {
    job.status = statusCode >= 400 ? 'error' : 'done';
    job.httpStatus = statusCode;
    job.body = body;
    job.finishedAt = new Date().toISOString();
    saveJob(job).catch(() => {});
  });

  try {
    await handler(req, captureRes, (err) => {
      if (err) captureRes.status(500).json({ message: 'Chyba servera' });
    });
    // Handler skončil bez odpovede → job uzavrieme (no-op, ak už odpovedal).
    captureRes.end();
  } catch (err) {
    logger.error('[backgroundJobs] Job crashed', { label, jobId: job.id, error: err.message });
    captureRes.status(500).json({ message: 'Chyba servera' });
  }
};

module.exports = { runInBackground, getJob };
