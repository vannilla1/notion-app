const User = require('../models/User');
const Contact = require('../models/Contact');
const Task = require('../models/Task');
const WorkspaceMember = require('../models/WorkspaceMember');
const logger = require('../utils/logger');
const subscriptionEmailService = require('./subscriptionEmailService');

/**
 * subscriptionReminders — denný cron (3:00 ráno) ktorý posiela:
 *  - reminder_t7  → 7 dní pred paidUntil (window 6.5–7.5 dní pre robustnosť)
 *  - reminder_t1  → 24 h pred paidUntil
 *  - winback      → 14 dní po expirácii (kde subscription.notifications.expiredEmailSentAt
 *                   bolo poslané a winbackSentAt ešte nie)
 *
 * Idempotency: každý reminder type má timestamp v User.subscription.notifications.*.
 * Cron vyberá iba kandidátov kde flag JE NULL — takže reminder sa nepošle 2×.
 * Pri admin zmene paidUntil sa flagy resetujú (subscriptionEmailService.resetReminderFlags),
 * aby sa pre novú periódu znova spustili.
 *
 * Stripe-managed účty (subscription.stripeSubscriptionId !== null) sú vyňaté zo všetkých
 * reminder typov — Stripe rieši receipts a renewal cycles vlastnou cestou.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // raz denne
const INITIAL_DELAY_MS = 5 * 60 * 1000;       // 5 min po server boote (po DB warmup, po planExpiration sweep)

const PAID_PLANS = ['team', 'pro'];

/**
 * Find users whose paidUntil falls in the [now+6d, now+8d] window AND
 * who haven't received a T-7 reminder yet for the current cycle.
 * The 2-day window prevents missed sends if cron skips a day (boot delay,
 * crash, schedule jitter) — duplicates are blocked by t7ReminderSentAt anyway.
 */
const findT7Candidates = async () => {
  const now = new Date();
  return User.find({
    'subscription.plan': { $in: PAID_PLANS },
    'subscription.paidUntil': {
      $gte: new Date(now.getTime() + 6 * DAY_MS),
      $lte: new Date(now.getTime() + 8 * DAY_MS)
    },
    'subscription.stripeSubscriptionId': { $in: [null, undefined] },
    $or: [
      { 'subscription.notifications.t7ReminderSentAt': null },
      { 'subscription.notifications.t7ReminderSentAt': { $exists: false } }
    ]
  }).lean();
};

const findT1Candidates = async () => {
  const now = new Date();
  return User.find({
    'subscription.plan': { $in: PAID_PLANS },
    'subscription.paidUntil': {
      $gte: now,
      $lte: new Date(now.getTime() + 1.5 * DAY_MS)
    },
    'subscription.stripeSubscriptionId': { $in: [null, undefined] },
    $or: [
      { 'subscription.notifications.t1ReminderSentAt': null },
      { 'subscription.notifications.t1ReminderSentAt': { $exists: false } }
    ]
  }).lean();
};

/**
 * Winback: user kde expiredEmailSentAt bolo pred 13–15 dňami a winbackSentAt
 * je null. T+14 dáva čas na natural reactivation pred ďalším marketing pingom.
 */
const findWinbackCandidates = async () => {
  const now = new Date();
  return User.find({
    'subscription.plan': 'free',
    'subscription.notifications.expiredEmailSentAt': {
      $gte: new Date(now.getTime() - 15 * DAY_MS),
      $lte: new Date(now.getTime() - 13 * DAY_MS)
    },
    $or: [
      { 'subscription.notifications.winbackSentAt': null },
      { 'subscription.notifications.winbackSentAt': { $exists: false } }
    ]
  }).lean();
};

/**
 * Pre T-7 zbierame mini-stats z účtu (počet kontaktov, úloh, workspaces) na
 * personalizáciu copy. Robíme paralelne, ale s timeoutom — žiadny user nemá
 * čakať že stats blokujú odoslanie celej batch.
 */
const collectAccountStats = async (userId) => {
  try {
    const memberships = await WorkspaceMember.find({ userId }).select('workspaceId').lean();
    const workspaceIds = memberships.map((m) => m.workspaceId);

    const [contactCount, taskCount] = await Promise.all([
      Contact.countDocuments({ workspaceId: { $in: workspaceIds } }),
      Task.countDocuments({ workspaceId: { $in: workspaceIds } })
    ]);

    return {
      contactCount,
      taskCount,
      workspaceCount: workspaceIds.length
    };
  } catch (err) {
    logger.warn('[SubscriptionReminders] Failed to collect stats', { userId, error: err.message });
    return null;
  }
};

const runOnce = async () => {
  const summary = { t7: 0, t1: 0, winback: 0, errors: 0 };

  try {
    // T-7 reminders
    const t7 = await findT7Candidates();
    for (const user of t7) {
      try {
        const stats = await collectAccountStats(user._id);
        const result = await subscriptionEmailService.sendReminderT7({
          user, accountStats: stats, triggeredBy: 'cron'
        });
        if (result.ok) summary.t7++;
      } catch (err) {
        summary.errors++;
        logger.error('[SubscriptionReminders] T-7 send error', { userId: String(user._id), error: err.message });
      }
    }

    // T-1 reminders
    const t1 = await findT1Candidates();
    for (const user of t1) {
      try {
        const result = await subscriptionEmailService.sendReminderT1({ user, triggeredBy: 'cron' });
        if (result.ok) summary.t1++;
      } catch (err) {
        summary.errors++;
        logger.error('[SubscriptionReminders] T-1 send error', { userId: String(user._id), error: err.message });
      }
    }

    // Winback
    const wb = await findWinbackCandidates();
    for (const user of wb) {
      try {
        const result = await subscriptionEmailService.sendWinback({ user, triggeredBy: 'cron' });
        if (result.ok) summary.winback++;
      } catch (err) {
        summary.errors++;
        logger.error('[SubscriptionReminders] Winback send error', { userId: String(user._id), error: err.message });
      }
    }

    logger.info('[SubscriptionReminders] Run complete', summary);
    return summary;
  } catch (err) {
    logger.error('[SubscriptionReminders] Run failed', { error: err.message });
    return { ...summary, errors: summary.errors + 1, error: err.message };
  }
};

const scheduleSubscriptionReminders = () => {
  setTimeout(() => {
    runOnce().catch((err) => logger.error('[SubscriptionReminders] Initial run failed', { error: err.message }));
  }, INITIAL_DELAY_MS);

  setInterval(() => {
    runOnce().catch((err) => logger.error('[SubscriptionReminders] Scheduled run failed', { error: err.message }));
  }, RUN_INTERVAL_MS);

  logger.info('[SubscriptionReminders] Scheduled — every 24 hours');
};

module.exports = {
  scheduleSubscriptionReminders,
  runOnce,
  findT7Candidates,
  findT1Candidates,
  findWinbackCandidates
};
