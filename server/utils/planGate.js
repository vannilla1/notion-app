/**
 * planGate.js — audit záznam pri narazení na plánový limit / feature gate.
 *
 * Každé miesto, kde server vráti 403 s kódom FEATURE_NOT_IN_PLAN /
 * PLAN_LIMIT / STORAGE_LIMIT, zavolá logPlanGateHit() tesne pred
 * odpoveďou. V AdminPaneli → Audit log (action 'plan.limit_hit') potom
 * vidno, na KTORÝ strop používatelia narážajú najčastejšie — podklad
 * pre ladenie cenníka podľa dát, nie pocitu.
 *
 * Fire-and-forget: zlyhanie audit zápisu nesmie ovplyvniť odpoveď.
 */
const auditService = require('../services/auditService');

const logPlanGateHit = (req, { code, feature, limit = null }) => {
  try {
    auditService.logAction({
      userId: req.user?.id,
      username: req.user?.username,
      email: req.user?.email,
      action: 'plan.limit_hit',
      category: 'billing',
      targetType: 'plan',
      targetId: code,
      targetName: feature,
      details: { code, feature, limit, path: req.originalUrl, method: req.method },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId
    });
  } catch { /* audit je bonus — nikdy nezhodí request */ }
};

module.exports = { logPlanGateHit };
