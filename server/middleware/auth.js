const jwt = require('jsonwebtoken');
const User = require('../models/User');

// JWT_SECRET must be set in environment variables for security
// In development, a fallback is used but production MUST set this
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET environment variable is not set in production!');
    process.exit(1);
  } else {
    console.warn('WARNING: JWT_SECRET not set, using development fallback. DO NOT use in production!');
  }
}

// Use fallback only in development
const SECRET_KEY = JWT_SECRET || 'dev-only-secret-change-in-production';

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Prístupový token je povinný' });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY, { algorithms: ['HS256'] });
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'Neplatný token' });
    }

    req.user = {
      id: user._id,
      username: user.username,
      email: user.email,
      color: user.color,
      avatar: user.avatar,
      role: user.role
    };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Neplatný alebo expirovaný token' });
  }
};

const authenticateSocket = async (socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY, { algorithms: ['HS256'] });
    const user = await User.findById(decoded.id);

    if (!user) {
      return next(new Error('User not found'));
    }

    socket.user = {
      id: user._id,
      username: user.username,
      email: user.email,
      color: user.color,
      role: user.role
    };
    next();
  } catch (err) {
    return next(new Error('Invalid token'));
  }
};

module.exports = { authenticateToken, authenticateSocket, JWT_SECRET: SECRET_KEY };
