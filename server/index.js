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
const { authenticateSocket } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000', 'http://localhost:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Make io accessible to routes
app.set('io', io);

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/pages', pageRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/tasks', taskRoutes);

// Socket.io for real-time collaboration
io.use(authenticateSocket);

io.on('connection', (socket) => {
  console.log('User connected:', socket.user.username);

  // Join user's personal room for private updates
  socket.join(`user-${socket.user.id}`);

  socket.on('join-page', (pageId) => {
    socket.join(`page-${pageId}`);
    console.log(`${socket.user.username} joined page ${pageId}`);
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
    console.log('User disconnected:', socket.user.username);
  });
});

const PORT = process.env.PORT || 5001;

// Connect to MongoDB and start server
const startServer = async () => {
  const dbConnected = await connectDB();
  if (!dbConnected) {
    console.log('Warning: MongoDB not connected. Some features may not work.');
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();
