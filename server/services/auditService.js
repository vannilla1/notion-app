const AuditLog = require('../models/AuditLog');
const logger = require('../utils/logger');

const logAction = async ({ userId, username, email, action, category, targetType, targetId, targetName, details, ipAddress, userAgent, workspaceId }) => {
  try {
    const log = new AuditLog({ userId, username, email, action, category, targetType, targetId, targetName, details, ipAddress, userAgent, workspaceId });
    await log.save();
  } catch (err) {
    logger.error('[AuditService] Failed to log action', { error: err.message, action });
  }
};

module.exports = { logAction };
