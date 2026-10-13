/**
 * GET /api/jobs/:id — stav úlohy spustenej na pozadí (`?async=1`, viď
 * utils/backgroundJobs). Vráti len vlastníkovi jobu.
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getJob } = require('../utils/backgroundJobs');

const router = express.Router();

router.get('/:id', authenticateToken, async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job || job.userId !== String(req.user.id)) {
    return res.status(404).json({ message: 'Úloha neexistuje alebo vypršala' });
  }
  res.json({
    id: job.id,
    status: job.status,          // running | done | error
    httpStatus: job.httpStatus,  // stav, ktorý by vrátil synchrónny endpoint
    body: job.body,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  });
});

module.exports = router;
