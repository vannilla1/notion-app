const Sentry = require('@sentry/node');
const logger = require('./logger');

// Initialize Sentry
const initSentry = (app) => {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    logger.info('Sentry DSN not configured, error tracking disabled');
    return {
      requestHandler: null,
      errorHandler: (err, req, res, next) => next(err),
      captureException: () => {},
      captureMessage: () => {},
      setUser: () => {},
      clearUser: () => {}
    };
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    beforeSend(event) {
      // Filter out sensitive data
      if (event.request?.data) {
        if (event.request.data.password) {
          event.request.data.password = '[FILTERED]';
        }
        if (event.request.data.currentPassword) {
          event.request.data.currentPassword = '[FILTERED]';
        }
        if (event.request.data.newPassword) {
          event.request.data.newPassword = '[FILTERED]';
        }
      }
      return event;
    }
  });

  logger.info('Sentry initialized', { environment: process.env.NODE_ENV });

  return {
    requestHandler: null, // Not needed in newer Sentry versions

    // Custom error handler middleware
    errorHandler: (err, req, res, next) => {
      // Capture 5xx errors or unhandled errors
      if (!err.status || err.status >= 500) {
        Sentry.captureException(err, {
          extra: {
            path: req.path,
            method: req.method,
            userId: req.user?.id
          }
        });
      }
      next(err);
    },

    // Manual error capture
    captureException: (error, context = {}) => {
      Sentry.captureException(error, {
        extra: context
      });
    },

    // Manual message capture
    captureMessage: (message, level = 'info', context = {}) => {
      Sentry.captureMessage(message, {
        level,
        extra: context
      });
    },

    // Set user context
    setUser: (user) => {
      Sentry.setUser({
        id: user.id,
        username: user.username,
        email: user.email
      });
    },

    // Clear user context
    clearUser: () => {
      Sentry.setUser(null);
    }
  };
};

module.exports = { initSentry };
