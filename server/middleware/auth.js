const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'notion-app-secret-key-2024';

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }

    const user = db.users.findById(decoded.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      color: user.color
    };
    next();
  });
};

const authenticateSocket = (socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error('Authentication required'));
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return next(new Error('Invalid token'));
    }

    const user = db.users.findById(decoded.id);
    if (!user) {
      return next(new Error('User not found'));
    }

    socket.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      color: user.color
    };
    next();
  });
};

module.exports = { authenticateToken, authenticateSocket, JWT_SECRET };
