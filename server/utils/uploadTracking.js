/**
 * uploadTracking.js — viditeľnosť prerušených nahrávaní.
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
 */
const auditService = require('../services/auditService');
const logger = require('./logger');

const trackUploadAbort = (req, context = {}) => {
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    // writableFinished = odpoveď sa stihla celá odoslať. Ak nie, klient
    // zmizol skôr — presne prípad zavretej appky uprostred prenosu.
    if (req.res && req.res.writableFinished) return;
    const expected = Number(req.headers['content-length'] || 0);
    const received = req.socket ? req.socket.bytesRead : 0;
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
        percent: expected > 0 ? Math.round((received / expected) * 100) : null,
        path: req.originalUrl
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId
    });
  };
  if (req.res) req.res.on('close', onClose);
};

module.exports = { trackUploadAbort };
