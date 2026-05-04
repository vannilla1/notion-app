const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');
const dotenv = require('dotenv');

dotenv.config();

const path = require('path');
const { connectDB } = require('./config/database');
const authRoutes = require('./routes/auth');
const authGoogleRoutes = require('./routes/auth-google');
const authAppleRoutes = require('./routes/auth-apple');
const authConnectionsRoutes = require('./routes/auth-connections');
const pageRoutes = require('./routes/pages');
const contactRoutes = require('./routes/contacts');
const taskRoutes = require('./routes/tasks');
const googleCalendarRoutes = require('./routes/googleCalendar');
const { initializeCalendarWebhooks } = require('./routes/googleCalendar');
const googleTasksRoutes = require('./routes/googleTasks');
const { startGoogleTasksPolling } = require('./routes/googleTasks');
const notificationRoutes = require('./routes/notifications');
const pushRoutes = require('./routes/push');
const workspaceRoutes = require('./routes/workspaces');
const messageRoutes = require('./routes/messages');
const adminRoutes = require('./routes/admin');
const billingRoutes = require('./routes/billing');
const contactFormRoutes = require('./routes/contact-form');
const errorRoutes = require('./routes/errors');
const notificationService = require('./services/notificationService');
const { scheduleDueDateChecks } = require('./services/dueDateChecker');
const { scheduleCleanup: scheduleSubscriptionCleanup } = require('./services/subscriptionCleanup');
const { schedulePlanExpiration } = require('./services/planExpiration');
const { scheduleErrorAlerter } = require('./jobs/errorAlerter');
const { initializeEmail } = require('./services/adminEmailService');
const { trackRequest } = require('./services/apiMetrics');
const { authenticateSocket } = require('./middleware/auth');
const { apiLimiter } = require('./middleware/rateLimiter');
const WorkspaceMember = require('./models/WorkspaceMember');
const Page = require('./models/Page');
const logger = require('./utils/logger');
const { errorMiddleware: serverErrorMirrorMiddleware, recordError } = require('./services/serverErrorService');
const onlineUsers = require('./services/onlineUsers');

const app = express();

// Trust proxy for rate limiting behind reverse proxy (Render, Heroku, etc.)
app.set('trust proxy', 1);

const server = http.createServer(app);

// CORS configuration - restrict to frontend origin
const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'https://prplcrm.eu',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Workspace-Id'],
  credentials: false,
  optionsSuccessStatus: 200,
  maxAge: 86400
};

const io = new Server(server, {
  cors: corsOptions
});

// Security headers
//
// Audit MED-001 fix: CSP zapnutý ako HTTP response header (predtým bolo
// {contentSecurityPolicy: false}). Frontend CSP via meta tag NESTAČÍ —
// browser musí dostať header pre aktivovanie XSS protections.
//
// Directívy kompromis:
//  - script-src: 'unsafe-inline' je nutné lebo index.html má inline script
//    pre iOS service worker neutralization (musí bežať pred ostatnými JS).
//    Plus JSON-LD štruktúrované dáta. Hash/nonce by vyžadovali build-time
//    injection v Vite čo nemáme. Future hardening: nonce-based CSP.
//  - style-src: 'unsafe-inline' kvôli React inline-style propom + Google Fonts
//  - connect-src: API endpoint + WebSocket pre Socket.IO + production domain
//  - frame-ancestors: 'none' — anti-clickjacking (Apple Pay / Stripe nikdy
//    nás neembedduje, len redirectne)
//  - form-action: povoľujeme Stripe Checkout pre web billing flow
//  - object-src + base-uri: prísne (žiaden Flash, žiadne base tag injekcie)
const apiHost = process.env.API_PUBLIC_HOST || 'perun-crm-api.onrender.com';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: [
        "'self'",
        `https://${apiHost}`,
        `wss://${apiHost}`,
        "https://prplcrm.eu",
        "wss://prplcrm.eu"
      ],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", "https://checkout.stripe.com"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' } // Allow frontend to load images from API
}));

// Enable pre-flight across-the-board
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// Stripe webhook needs raw body (must be before JSON parser)
app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  billingRoutes.handleWebhook
);

// Body parsers with size limits.
//
// Audit MED-004 fix: globálny limit znížený z 20MB na 1MB. 20MB na
// unauthenticated endpointoch (register, login, forgot-password) bolo
// memory-DoS riziko na Render Starter (~512MB RAM). File uploads idú
// cez multer (multipart/form-data) s vlastnými fileSize limitmi v
// jednotlivých routes — express.json sa ich netýka.
//
// Override pre routy ktoré reálne potrebujú väčšie JSON payloady (rich
// content, pages editor, batch operations) idú s 5MB. Tieto sú za auth-om
// takže útočná plocha je menšia.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// Override pre Pages (rich-text editor, content limit 500K znakov ×
// JSON overhead ≈ 2-3MB v krajnom prípade)
app.use('/api/pages', express.json({ limit: '5mb' }));

// Apply general API rate limiting
app.use('/api', apiLimiter);

// Track API requests for admin metrics
app.use('/api', trackRequest);

// Health check endpoint
app.get('/health', (req, res) => {
  const mongoose = require('mongoose');
  const dbReady = mongoose.connection.readyState === 1;
  res.json({ status: dbReady ? 'ok' : 'starting', db: dbReady, timestamp: new Date().toISOString() });
});

// DB readiness check - return 503 if DB not connected yet (frontend will retry)
const mongoose = require('mongoose');
app.use('/api', (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Server sa spúšťa, skúste o chvíľu...', retryable: true });
  }
  next();
});

// Make io accessible to routes
app.set('io', io);

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
// OAuth routery sú mounted na podadresároch /api/auth/google, /api/auth/apple,
// /api/auth/connections — express ich vyrieši pred fallthrough na authRoutes
// (ktorý handle-uje /register, /login, /me, atď.).
app.use('/api/auth/google', authGoogleRoutes);
app.use('/api/auth/apple', authAppleRoutes);
app.use('/api/auth/connections', authConnectionsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/pages', pageRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/google-calendar', googleCalendarRoutes);
app.use('/api/google-tasks', googleTasksRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/contact-form', contactFormRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/errors', errorRoutes);

// Initialize notification service with Socket.IO
notificationService.initialize(io);

// In-house server error mirror — zapisuje všetky 5xx chyby do Mongo
// (ServerError model) pre SuperAdmin → Diagnostics → Chyby dashboard.
// Musí byť PRED finálnym error handlerom. next(err) posúva chybu ďalej.
app.use(serverErrorMirrorMiddleware);

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

io.on('connection', async (socket) => {
  logger.socket('connected', socket.user.id, socket.user.username);

  // Registrácia do online-users registry pre SuperAdmin dashboard.
  // Toto je ľahký in-memory Map, pri reštarte sa zmaže (a to je OK —
  // klienti sa reconnectnú a znova zapíšu).
  onlineUsers.addConnection(socket.user.id, socket.id, {
    username: socket.user.username,
    email: socket.user.email,
    userAgent: socket.handshake?.headers?.['user-agent']
  });

  // Join user's personal room for private updates
  socket.join(`user-${socket.user.id}`);

  // Join all workspace rooms the user belongs to, and build an in-memory
  // Set of their workspaceIds. The Set is the source of truth for all
  // subsequent workspace-membership checks on this socket (used by
  // canAccessPage below), so we don't hit Mongo on every page-related event.
  // Trade-off: if a user is added/removed from a workspace mid-session, the
  // change takes effect on next reconnect. Acceptable — REST API enforces
  // membership on every request anyway; this only affects real-time deltas.
  const userWorkspaceIds = new Set();
  try {
    const memberships = await WorkspaceMember.find({ userId: socket.user.id }, 'workspaceId').lean();
    for (const m of memberships) {
      const wsId = m.workspaceId.toString();
      socket.join(`workspace-${wsId}`);
      userWorkspaceIds.add(wsId);
    }
    logger.debug('Socket joined workspace rooms', { userId: socket.user.id, count: memberships.length });
  } catch (err) {
    logger.error('Failed to join workspace rooms', { error: err.message, userId: socket.user.id });
  }
  socket.data.userWorkspaceIds = userWorkspaceIds;
  // Cache pageId → workspaceId after a successful join-page check, so
  // re-joining or re-checking the same page in this session is a Set lookup,
  // not a Mongo query.
  socket.data.pageAccess = new Map();
  // Anti-enumeration: count denied joins per socket inside a 60s sliding
  // window. Repeated attempts to join unauthorized pages (e.g. someone
  // brute-forcing ObjectIds) → disconnect. Legit users never hit this.
  socket.data.joinDenied = { count: 0, firstAt: 0 };

  // Helper: does this socket's user belong to the workspace that owns `pageId`?
  // SECURITY CRITICAL: every collaborative page event flows through this check.
  // Previously missing — any authenticated user could call
  // `socket.emit('join-page', anyPageId)` and start receiving page content,
  // block updates and cursor positions from other customers' workspaces (GDPR
  // leak). Format-validates pageId first to avoid $-operator injection if a
  // client sends a non-string payload, and to fail fast on garbage.
  async function canAccessPage(pageId) {
    if (typeof pageId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(pageId)) return false;
    if (socket.data.pageAccess.has(pageId)) return true;
    try {
      const page = await Page.findById(pageId, 'workspaceId').lean();
      if (!page) return false;
      const wsId = page.workspaceId.toString();
      if (!socket.data.userWorkspaceIds.has(wsId)) return false;
      socket.data.pageAccess.set(pageId, wsId);
      return true;
    } catch (err) {
      logger.error('canAccessPage failed', { error: err.message, userId: socket.user.id, pageId });
      return false;
    }
  }

  socket.on('join-page', async (pageId) => {
    if (!(await canAccessPage(pageId))) {
      // Silently drop — never ack failure, to avoid leaking whether the page
      // exists vs. is simply not accessible (timing-oracle style enumeration).
      const d = socket.data.joinDenied;
      const now = Date.now();
      if (now - d.firstAt > 60_000) { d.count = 0; d.firstAt = now; }
      d.count++;
      logger.warn('Socket: join-page DENIED', {
        userId: socket.user.id,
        username: socket.user.username,
        pageId: typeof pageId === 'string' ? pageId : typeof pageId,
        deniedInWindow: d.count
      });
      if (d.count >= 10) {
        logger.warn('Socket: disconnecting for repeated join-page denials', {
          userId: socket.user.id,
          username: socket.user.username
        });
        socket.disconnect(true);
      }
      return;
    }
    socket.join(`page-${pageId}`);
    logger.socket('join-page', socket.user.id, socket.user.username, { pageId });
  });

  socket.on('leave-page', (pageId) => {
    if (typeof pageId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(pageId)) return;
    socket.leave(`page-${pageId}`);
    socket.data.pageAccess.delete(pageId);
  });

  // For page-update / block-update / cursor-move we only accept events from
  // sockets that are ALREADY IN the page room. Room membership is proof of a
  // prior successful join-page check — so we avoid a DB hit per event. This
  // matters for cursor-move which fires ~20x/sec per user.
  function isInPageRoom(pageId) {
    return typeof pageId === 'string' && socket.rooms.has(`page-${pageId}`);
  }

  // All three handlers below accept the payload as a single param and guard
  // against non-object inputs BEFORE destructuring — otherwise a malicious
  // client emitting `socket.emit('page-update', null)` would throw inside the
  // destructure, bubble to process.on('uncaughtException') which calls
  // process.exit(1), and crash the whole server.
  socket.on('page-update', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { pageId, content, title } = payload;
    if (!isInPageRoom(pageId)) return;
    // Broadcast to all users in the page room except sender
    socket.to(`page-${pageId}`).emit('page-updated', {
      pageId,
      content,
      title,
      updatedBy: socket.user.username
    });
  });

  socket.on('block-update', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { pageId, blockId, content, type } = payload;
    if (!isInPageRoom(pageId)) return;
    socket.to(`page-${pageId}`).emit('block-updated', {
      pageId,
      blockId,
      content,
      type,
      updatedBy: socket.user.username
    });
  });

  socket.on('cursor-move', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { pageId, position } = payload;
    if (!isInPageRoom(pageId)) return;
    socket.to(`page-${pageId}`).emit('cursor-moved', {
      userId: socket.user.id,
      username: socket.user.username,
      position
    });
  });

  socket.on('disconnect', () => {
    logger.socket('disconnected', socket.user.id, socket.user.username);
    onlineUsers.removeConnection(socket.id);
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

// Handle uncaught exceptions — zapíše do ServerError mirror pred exit
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  // Fire-and-forget — proces už aj tak padá; ak sa Mongo nestihne, trudno.
  recordError(error, null).catch(() => {});
  // Daj 500 ms na flush IO, potom exit
  setTimeout(() => process.exit(1), 500).unref?.();
});

// Handle unhandled promise rejections — NEexitujeme (historicky sme to tak
// mali so Sentry), ale zapíšeme do mirror, aby sme videli trend.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason: reason?.message || reason, stack: reason?.stack });
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordError(err, null).catch(() => {});
});

// Start server FIRST (so Render sees it's alive), then connect DB in background
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, {
    port: PORT,
    environment: process.env.NODE_ENV || 'development'
  });

  // Connect to MongoDB in background - don't block server startup
  connectDB().then(async (dbConnected) => {
    if (!dbConnected) {
      logger.warn('MongoDB not connected. Some features may not work.');
    } else {
      // Set Pro plan for team accounts (skip if user has active Stripe subscription)
      const User = require('./models/User');
      try {
        const proEmails = (process.env.PRO_EMAILS || 'project.manager@eperun.sk,martin.kosco@eperun.sk').split(',').map(e => e.trim()).filter(Boolean);
        for (const email of proEmails) {
          const existing = await User.findOne({ email });
          if (!existing) continue;
          // Don't override if user has an active Stripe subscription
          if (existing.subscription?.stripeSubscriptionId) {
            logger.info(`Skipping pro override for ${email} — has Stripe subscription`);
            continue;
          }
          existing.subscription = {
            ...existing.subscription?.toObject(),
            plan: 'pro',
            paidUntil: new Date('2099-12-31')
          };
          await existing.save();
          logger.info(`Pro plan ensured for ${email} (plan: pro)`);
        }
      } catch (err) {
        logger.error('Failed to set pro plans', { error: err.message });
      }

      // One-shot migration: 'trial' plán bol odstránený z aplikácie. Užívatelia
      // ktorí v DB stále majú 'trial' (z čias keď to bola validná hodnota)
      // sa preklopia na 'free'. Po pár restartoch produkcie keď žiadny user
      // nemá 'trial' to môžeme odstrániť. Ponechávame aj tu (defenzívne)
      // aby sa zlé dáta neprekĺzli cez enum validáciu po deployi.
      try {
        const migrated = await User.updateMany(
          { 'subscription.plan': 'trial' },
          { $set: { 'subscription.plan': 'free' }, $unset: { 'subscription.trialEndsAt': '' } }
        );
        if (migrated.modifiedCount > 0) logger.info(`Migrated ${migrated.modifiedCount} legacy trial users to free plan`);
      } catch (err) {
        logger.error('Failed to migrate legacy trial users', { error: err.message });
      }

      // Migrate workspace members with 'admin' role to 'manager'
      try {
        const WorkspaceMember = require('./models/WorkspaceMember');
        const migrated = await WorkspaceMember.updateMany(
          { role: 'admin' },
          { role: 'manager' }
        );
        if (migrated.modifiedCount > 0) {
          logger.info(`Migrated ${migrated.modifiedCount} workspace members from admin to manager`);
        }
      } catch (err) {
        logger.error('Failed to migrate admin roles', { error: err.message });
      }

      // Initialize admin email service immediately
      initializeEmail();

      // Defer schedulers - run after 60s to not compete with first requests
      setTimeout(() => {
        scheduleDueDateChecks();
        scheduleSubscriptionCleanup();
        // Auto-revert expired paid plans (admin-granted free months / planUpgrade
        // discounts) back to 'free'. Runs every 6h; complemented by lazy check
        // in auth middleware for instant downgrade on next request.
        schedulePlanExpiration();
        scheduleErrorAlerter();
        startGoogleTasksPolling(io);
        initializeCalendarWebhooks(io);
        // Health monitor — každých 5 min kontroluje Mongo/SMTP/APNs/Google/Memory
        // a pri 3× zlyhaní za sebou pošle email na support@prplcrm.eu
        try {
          require('./jobs/healthMonitor').start();
        } catch (err) {
          logger.error('Failed to start health monitor', { error: err.message });
        }
      }, 60000);

    }
  }).catch(err => {
    logger.error('MongoDB connection failed', { error: err.message });
  });
});
