const PushSubscription = require('../models/PushSubscription');
const logger = require('../utils/logger');

/**
 * Subscription Cleanup Service
 * Removes stale push subscriptions that haven't been used in a while
 */

// Configuration
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Run once per day
const STALE_THRESHOLD_DAYS = 30; // Remove subscriptions not used in 30 days

/**
 * Clean up stale subscriptions
 * @returns {Object} Result with counts
 */
const cleanupStaleSubscriptions = async () => {
  try {
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - STALE_THRESHOLD_DAYS);

    logger.info('[SubscriptionCleanup] Starting cleanup', {
      thresholdDate: thresholdDate.toISOString(),
      thresholdDays: STALE_THRESHOLD_DAYS
    });

    // Find and count stale subscriptions before deletion
    const staleCount = await PushSubscription.countDocuments({
      lastUsed: { $lt: thresholdDate }
    });

    if (staleCount === 0) {
      logger.info('[SubscriptionCleanup] No stale subscriptions found');
      return { deleted: 0 };
    }

    // Delete stale subscriptions
    const result = await PushSubscription.deleteMany({
      lastUsed: { $lt: thresholdDate }
    });

    logger.info('[SubscriptionCleanup] Cleanup completed', {
      deleted: result.deletedCount,
      thresholdDays: STALE_THRESHOLD_DAYS
    });

    return { deleted: result.deletedCount };
  } catch (error) {
    logger.error('[SubscriptionCleanup] Error during cleanup', {
      error: error.message
    });
    return { deleted: 0, error: error.message };
  }
};

/**
 * Get subscription statistics
 * @returns {Object} Statistics about subscriptions
 */
const getSubscriptionStats = async () => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [total, activeLastDay, activeLastWeek, stale] = await Promise.all([
      PushSubscription.countDocuments({}),
      PushSubscription.countDocuments({ lastUsed: { $gte: oneDayAgo } }),
      PushSubscription.countDocuments({ lastUsed: { $gte: oneWeekAgo } }),
      PushSubscription.countDocuments({ lastUsed: { $lt: oneMonthAgo } })
    ]);

    // Get unique user count
    const uniqueUsers = await PushSubscription.distinct('userId');

    return {
      total,
      uniqueUsers: uniqueUsers.length,
      activeLastDay,
      activeLastWeek,
      stale,
      avgSubscriptionsPerUser: uniqueUsers.length > 0
        ? (total / uniqueUsers.length).toFixed(2)
        : 0
    };
  } catch (error) {
    logger.error('[SubscriptionCleanup] Error getting stats', {
      error: error.message
    });
    return null;
  }
};

/**
 * Schedule periodic cleanup
 * Should be called once when the server starts
 */
const scheduleCleanup = () => {
  // Run initial cleanup after 1 minute (to let DB connect)
  setTimeout(async () => {
    const result = await cleanupStaleSubscriptions();
    const stats = await getSubscriptionStats();
    if (stats) {
      logger.info('[SubscriptionCleanup] Initial stats', stats);
    }
  }, 60 * 1000);

  // Then run periodically
  setInterval(async () => {
    await cleanupStaleSubscriptions();
  }, CLEANUP_INTERVAL_MS);

  logger.info('[SubscriptionCleanup] Scheduled to run every 24 hours', {
    staleThresholdDays: STALE_THRESHOLD_DAYS
  });
};

module.exports = {
  cleanupStaleSubscriptions,
  getSubscriptionStats,
  scheduleCleanup,
  STALE_THRESHOLD_DAYS
};
