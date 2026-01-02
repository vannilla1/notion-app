const winston = require('winston');
const path = require('path');

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }
    if (stack) {
      log += `\n${stack}`;
    }
    return log;
  })
);

// JSON format for production
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? jsonFormat : logFormat,
  defaultMeta: { service: 'perun-crm' },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production'
        ? jsonFormat
        : winston.format.combine(
            winston.format.colorize(),
            logFormat
          )
    })
  ]
});

// Add file transports in production
if (process.env.NODE_ENV === 'production') {
  const logsDir = path.join(__dirname, '../logs');

  // Error log
  logger.add(new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    maxsize: 5242880, // 5MB
    maxFiles: 5
  }));

  // Combined log
  logger.add(new winston.transports.File({
    filename: path.join(logsDir, 'combined.log'),
    maxsize: 5242880, // 5MB
    maxFiles: 5
  }));
}

// Helper methods for common logging patterns
logger.http = (req, statusCode, duration) => {
  const meta = {
    method: req.method,
    url: req.originalUrl,
    statusCode,
    duration: `${duration}ms`,
    ip: req.ip,
    userId: req.user?.id
  };

  if (statusCode >= 500) {
    logger.error('HTTP Request Error', meta);
  } else if (statusCode >= 400) {
    logger.warn('HTTP Request Warning', meta);
  } else {
    logger.info('HTTP Request', meta);
  }
};

logger.auth = (action, userId, username, success, ip) => {
  const level = success ? 'info' : 'warn';
  logger.log(level, `Auth: ${action}`, { userId, username, success, ip });
};

logger.socket = (event, userId, username, data = {}) => {
  logger.info(`Socket: ${event}`, { userId, username, ...data });
};

module.exports = logger;
