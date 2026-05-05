const User = require('../models/User');
const logger = require('../utils/logger');
const auditService = require('./auditService');

/**
 * Plan Expiration Service
 *
 * Reverts user plans to 'free' when `subscription.paidUntil` is in the past
 * AND the user does NOT have an active Stripe subscription (those are managed
 * by Stripe webhooks — paidUntil there is always set from Stripe period_end).
 *
 * Two complementary call sites:
 *
 *  1. Lazy check in auth middleware: every authenticated request validates
 *     the current user's expiration on the fly. This prevents the server
 *     from serving premium features for even a few hours after paidUntil
 *     elapses. Cost: at most 1 atomic findOneAndUpdate per expired user
 *     per request — but only triggers when paidUntil < now, which for
 *     99.99% of requests is a no-op.
 *
 *  2. Scheduled sweep (every 6 hours): finds and downgrades all users
 *     whose paidUntil has passed but who haven't logged in. Keeps the
 *     DB consistent for admin reports / analytics, and emits audit logs
 *     even for inactive users.
 *
 * Both paths share `expireUserIfNeeded()` — a SINGLE atomic update guarded
 * by the same conditions. Concurrent calls (lazy + cron racing on the same
 * user, or two parallel requests from one user) collapse to one downgrade
 * thanks to MongoDB's atomic findOneAndUpdate.
 *
 * Plans that can expire: team, pro. Free can't expire (no-op). Admin
 * accounts seeded with paidUntil=2099 will never trip the threshold either.
 */

const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const INITIAL_DELAY_MS = 90 * 1000; // wait for DB warm-up after server boot

const PAID_PLANS = ['team', 'pro'];

/**
 * Returns true if the user record (lean object or hydrated doc) currently
 * meets the auto-expiration criteria. Pure function — no side effects.
 * Used by auth middleware as a fast pre-check before issuing the DB write.
 */
const isExpired = (user) => {
  const sub = user?.subscription;
  if (!sub) return false;
  if (!PAID_PLANS.includes(sub.plan)) return false;
  if (!sub.paidUntil) return false;
  if (new Date(sub.paidUntil) >= new Date()) return false;
  // Stripe-managed subs are renewed/cancelled via webhooks — never auto-expire.
  if (sub.stripeSubscriptionId) return false;
  return true;
};

/**
 * Atomically downgrade a single user to 'free' if they meet expiration
 * criteria. Idempotent — concurrent calls collapse via the guard query.
 * Returns the previous user document (so the caller can audit-log the
 * prior state) or null if no downgrade happened.
 */
const expireUserIfNeeded = async (userId) => {
  const now = new Date();

  // Atomic guard: only update if all conditions still hold at write time.
  // Using { new: false } gives us the PRE-update doc so we can audit-log
  // what the user had before (plan, paidUntil, discount).
  const previous = await User.findOneAndUpdate(
    {
      _id: userId,
      'subscription.plan': { $in: PAID_PLANS },
      'subscription.paidUntil': { $lt: now, $ne: null },
      $or: [
        { 'subscription.stripeSubscriptionId': null },
        { 'subscription.stripeSubscriptionId': { $exists: false } },
      ],
    },
    {
      $set: {
        'subscription.plan': 'free',
        'subscription.paidUntil': null,
        // Clear discount metadata — if it was a planUpgrade with expiresAt,
        // the upgrade has now ended; if it was percentage/fixed, it was
        // tied to a Stripe subscription which doesn't exist here. Leave
        // the audit log as the historical record.
        'subscription.discount.type': null,
        'subscription.discount.value': null,
        'subscription.discount.targetPlan': null,
        'subscription.discount.expiresAt': null,
      },
    },
    { new: false }
  );

  if (!previous) return null; // race lost or already downgraded

  // Audit log — system-initiated, no req.user available.
  // Wrapped in try because audit is best-effort; we don't want to block
  // the downgrade if AuditLog write fails.
  try {
    await auditService.logAction({
      userId: null,
      username: 'system',
      email: null,
      action: 'user.plan_auto_expired',
      category: 'billing',
      targetType: 'user',
      targetId: String(previous._id),
      targetName: previous.username,
      details: {
        previousPlan: previous.subscription?.plan,
        previousPaidUntil: previous.subscription?.paidUntil,
        previousDiscount: previous.subscription?.discount?.type || null,
      },
      ipAddress: null,
    });
  } catch (auditErr) {
    logger.warn('[PlanExpiration] Audit log failed', { error: auditErr.message });
  }

  // Invalidate the auth user cache so the next request reads fresh state.
  // Lazy require avoids the auth ↔ planExpiration circular import.
  try {
    const { invalidateUserCache } = require('../middleware/auth');
    await invalidateUserCache(previous._id);
  } catch (cacheErr) {
    logger.warn('[PlanExpiration] Cache invalidation failed', { error: cacheErr.message });
  }

  logger.info('[PlanExpiration] User auto-downgraded to free', {
    userId: String(previous._id),
    username: previous.username,
    previousPlan: previous.subscription?.plan,
    previousPaidUntil: previous.subscription?.paidUntil,
  });

  // Send "your plan expired" email + winback offer. Lazy require to avoid
  // a circular load order — subscriptionEmailService doesn't depend on this
  // module, but we want to keep planExpiration loadable even if email
  // service has init errors.
  try {
    const subscriptionEmailService = require('./subscriptionEmailService');
    await subscriptionEmailService.sendExpired({
      user: previous,
      previousPlan: previous.subscription?.plan,
      triggeredBy: 'system'
    });
  } catch (emailErr) {
    logger.warn('[PlanExpiration] Expired email failed', { error: emailErr.message });
  }

  return previous;
};

/**
 * Bulk sweep: find all expiration candidates and downgrade them one by one.
 * Each gets its own atomic update + audit log (vs a single updateMany,
 * which would lose per-user "previous state" needed for the audit trail).
 * Runs every 6 hours via schedulePlanExpiration().
 */
const sweepExpiredPlans = async () => {
  const now = new Date();
  try {
    const candidates = await User.find({
      'subscription.plan': { $in: PAID_PLANS },
      'subscription.paidUntil': { $lt: now, $ne: null },
      $or: [
        { 'subscription.stripeSubscriptionId': null },
        { 'subscription.stripeSubscriptionId': { $exists: false } },
      ],
    }).select('_id').lean();

    if (candidates.length === 0) {
      logger.info('[PlanExpiration] Sweep: no expired plans');
      return { downgraded: 0, candidates: 0 };
    }

    let count = 0;
    for (const c of candidates) {
      const result = await expireUserIfNeeded(c._id);
      if (result) count++;
    }

    logger.info('[PlanExpiration] Sweep complete', {
      candidates: candidates.length,
      downgraded: count,
    });
    return { downgraded: count, candidates: candidates.length };
  } catch (err) {
    logger.error('[PlanExpiration] Sweep failed', { error: err.message });
    return { downgraded: 0, error: err.message };
  }
};

/**
 * Start the periodic sweep. Called once from server boot (index.js).
 * Initial run is delayed 90 s so it doesn't compete with first user requests.
 */
const schedulePlanExpiration = () => {
  setTimeout(() => {
    sweepExpiredPlans().catch((err) => {
      logger.error('[PlanExpiration] Initial sweep failed', { error: err.message });
    });
  }, INITIAL_DELAY_MS);

  setInterval(() => {
    sweepExpiredPlans().catch((err) => {
      logger.error('[PlanExpiration] Scheduled sweep failed', { error: err.message });
    });
  }, SCHEDULE_INTERVAL_MS);

  logger.info('[PlanExpiration] Scheduled — every 6 hours', {
    intervalHours: SCHEDULE_INTERVAL_MS / (60 * 60 * 1000),
  });
};

module.exports = {
  isExpired,
  expireUserIfNeeded,
  sweepExpiredPlans,
  schedulePlanExpiration,
  PAID_PLANS,
};
