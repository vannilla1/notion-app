const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const dotenv = require('dotenv');

dotenv.config();

const path = require('path');
const { connectDB } = require('./config/database');
const authRoutes = require('./routes/auth');
const pageRoutes = require('./routes/pages');
const contactRoutes = require('./routes/contacts');
const taskRoutes = require('./routes/tasks');
const googleCalendarRoutes = require('./routes/googleCalendar');
const googleTasksRoutes = require('./routes/googleTasks');
const notificationRoutes = require('./routes/notifications');
const notificationService = require('./services/notificationService');
const { authenticateSocket } = require('./middleware/auth');
const { apiLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');
const { initSentry } = require('./utils/sentry');

const app = express();

// Trust proxy for rate limiting behind reverse proxy (Render, Heroku, etc.)
app.set('trust proxy', 1);

// Initialize Sentry
const sentry = initSentry(app);

const server = http.createServer(app);

// CORS configuration - allow all origins
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false,
  optionsSuccessStatus: 200,
  maxAge: 86400
};

const io = new Server(server, {
  cors: corsOptions
});

// Enable pre-flight across-the-board
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply general API rate limiting
app.use('/api', apiLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Make io and sentry accessible to routes
app.set('io', io);
app.set('sentry', sentry);

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/pages', pageRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/google-calendar', googleCalendarRoutes);
app.use('/api/google-tasks', googleTasksRoutes);
app.use('/api/notifications', notificationRoutes);

// Initialize notification service with Socket.IO
notificationService.initialize(io);

// Sentry error handler (must be before other error handlers)
app.use(sentry.errorHandler);

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id
  });

  res.status(err.status || 500).json({
    message: process.env.NODE_ENV === 'production'
      ? 'Nastala chyba servera'
      : err.message
  });
});

// Socket.io for real-time collaboration
io.use(authenticateSocket);

io.on('connection', (socket) => {
  logger.socket('connected', socket.user.id, socket.user.username);

  // Join user's personal room for private updates
  socket.join(`user-${socket.user.id}`);

  socket.on('join-page', (pageId) => {
    socket.join(`page-${pageId}`);
    logger.socket('join-page', socket.user.id, socket.user.username, { pageId });
  });

  socket.on('leave-page', (pageId) => {
    socket.leave(`page-${pageId}`);
  });

  socket.on('page-update', ({ pageId, content, title }) => {
    // Broadcast to all users in the page room except sender
    socket.to(`page-${pageId}`).emit('page-updated', {
      pageId,
      content,
      title,
      updatedBy: socket.user.username
    });
  });

  socket.on('block-update', ({ pageId, blockId, content, type }) => {
    socket.to(`page-${pageId}`).emit('block-updated', {
      pageId,
      blockId,
      content,
      type,
      updatedBy: socket.user.username
    });
  });

  socket.on('cursor-move', ({ pageId, position }) => {
    socket.to(`page-${pageId}`).emit('cursor-moved', {
      userId: socket.user.id,
      username: socket.user.username,
      position
    });
  });

  socket.on('disconnect', () => {
    logger.socket('disconnected', socket.user.id, socket.user.username);
  });

  socket.on('error', (error) => {
    logger.error('Socket error', {
      error: error.message,
      userId: socket.user.id,
      username: socket.user.username
    });
  });
});

const PORT = process.env.PORT || 5001;

// Connect to MongoDB and start server
const startServer = async () => {
  const dbConnected = await connectDB();
  if (!dbConnected) {
    logger.warn('MongoDB not connected. Some features may not work.');
  }

  server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`, {
      port: PORT,
      environment: process.env.NODE_ENV || 'development'
    });
  });
};

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  sentry.captureException(error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason: reason?.message || reason, stack: reason?.stack });
  sentry.captureException(reason);
});

startServer();
