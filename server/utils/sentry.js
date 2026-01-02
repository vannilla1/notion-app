const Sentry = require('@sentry/node');
const logger = require('./logger');

// Initialize Sentry
const initSentry = (app) => {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    logger.info('Sentry DSN not configured, error tracking disabled');
    return {
      errorHandler: (err, req, res, next) => next(err),
      captureException: () => {},
      captureMessage: () => {}
    };
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    integrations: [
      // Enable HTTP calls tracing
      Sentry.httpIntegration(),
      // Enable Express.js middleware tracing
      Sentry.expressIntegration({ app })
    ],
    beforeSend(event, hint) {
      // Filter out sensitive data
      if (event.request?.data) {
        // Remove password from request data
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
    // Request handler - must be first middleware
    requestHandler: Sentry.Handlers.requestHandler(),

    // Error handler - must be before any other error handlers
    errorHandler: Sentry.Handlers.errorHandler({
      shouldHandleError(error) {
        // Capture 5xx errors
        if (error.status >= 500) {
          return true;
        }
        // Also capture unhandled errors
        if (!error.status) {
          return true;
        }
        return false;
      }
    }),

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
