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

const PLAN_RANK = { free: 0, trial: 0, team: 1, pro: 2 };

/**
 * Plán, ktorým sa riadia limity OBSAHU workspace (kontakty, projekty,
 * podúlohy, prílohy/úložisko) = VYŠŠÍ z plánov vlastníka workspace
 * a volajúceho člena.
 *
 * Do 7ae8aae sa bral len plán volajúceho: Free člen v Pro/Tím workspace
 * narážal na Free limity, hoci vlastník platí za tím. Audit (0a558a2) prepol
 * na plán vlastníka, ale to by po nasadení zobralo funkcie platiacim členom
 * vo workspace Free vlastníka (prílohy, limity, 10 GB → 1 GB) a upsell by
 * im ponúkal plán, ktorý by im nič neodomkol. Vyšší z oboch = nikto nič
 * nestratí a členovia platiaceho tímu dostanú limity tímu. Osobné funkcie
 * (Google sync, CSV export) ostávajú na pláne používateľa.
 */
const getWorkspacePlan = async (req) => {
  // Lazy require — planGate načítava aj auth vrstva (žiadny cyklus pri štarte)
  const User = require('../models/User');
  const ids = [req.workspace?.ownerId, req.user?.id].filter(Boolean);
  if (ids.length === 0) return 'free';
  const docs = await User.find({ _id: { $in: ids } }).select('subscription.plan').lean();
  let best = 'free';
  for (const doc of docs) {
    const plan = doc?.subscription?.plan || 'free';
    if ((PLAN_RANK[plan] ?? 0) > (PLAN_RANK[best] ?? 0)) best = plan;
  }
  return best;
};

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

const SUBTASK_LIMITS = { free: 10, team: 25, pro: Infinity };

/**
 * Plánový limit podúloh aj pre PUT celého stromu (POST ho mal, PUT celý
 * strom od klienta ho obchádzal). Blokuje len RAST nad limit — úprava už
 * väčšieho stromu (napr. po downgrade) bez pridávania ostáva možná.
 * Vráti true, ak odpovedal 403.
 */
const respondIfSubtaskLimitExceeded = async (req, res, newTree, oldTree) => {
  const { countSubtaskNodes } = require('./subtaskFiles');
  const newCount = countSubtaskNodes(newTree);
  if (newCount <= countSubtaskNodes(oldTree)) return false;
  const plan = await getWorkspacePlan(req);
  const max = SUBTASK_LIMITS[plan] ?? SUBTASK_LIMITS.free;
  if (max === Infinity || newCount <= max) return false;
  const { isIosNativeApp } = require('./platform');
  const message = isIosNativeApp(req)
    ? `Dosiahli ste limit ${max} podúloh v projekte.`
    : `Váš plán umožňuje max. ${max} podúloh v projekte. Pre viac prejdite na vyšší plán.`;
  logPlanGateHit(req, { code: 'PLAN_LIMIT', feature: 'subtasks', limit: max });
  res.status(403).json({ message, code: 'PLAN_LIMIT' });
  return true;
};

module.exports = { logPlanGateHit, getWorkspacePlan, respondIfSubtaskLimitExceeded };
