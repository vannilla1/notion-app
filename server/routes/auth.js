const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const User = require('../models/User');
const { JWT_SECRET, authenticateToken } = require('../middleware/auth');
const { loginLimiter, registerLimiter, passwordChangeLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

// Configure multer for avatar uploads - using memory storage for Base64
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Neplatný typ súboru. Povolené sú len obrázky (JPEG, PNG, GIF, WebP).'));
    }
  }
});

// Register - with rate limiting
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Všetky polia sú povinné' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Heslo musí mať aspoň 6 znakov' });
    }

    // Check if user exists
    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      logger.auth('register', null, null, false, req.ip);
      return res.status(400).json({ message: 'Email already registered' });
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      logger.auth('register', null, null, false, req.ip);
      return res.status(400).json({ message: 'Username already taken' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate random color for user
    const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];
    const color = colors[Math.floor(Math.random() * colors.length)];

    // First user becomes admin, others become regular users
    const userCount = await User.countDocuments();
    const role = userCount === 0 ? 'admin' : 'user';

    // Create user
    const user = new User({
      username,
      email,
      password: hashedPassword,
      color,
      role
    });
    await user.save();

    // Generate token
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });

    logger.auth('register', user._id, username, true, req.ip);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        color: user.color,
        role: user.role
      }
    });
  } catch (error) {
    logger.error('Registration error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Login - with rate limiting
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ message: 'Email a heslo sú povinné' });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      logger.auth('login', null, email, false, req.ip);
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      logger.auth('login', user._id, user.username, false, req.ip);
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });

    logger.auth('login', user._id, user.username, true, req.ip);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        color: user.color,
        avatar: user.avatar,
        role: user.role
      }
    });
  } catch (error) {
    logger.error('Login error', { error: error.message, ip: req.ip });
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get current user
router.get('/me', authenticateToken, (req, res) => {
  res.json(req.user);
});

// Get user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }
    res.json({
      id: user._id,
      username: user.username,
      email: user.email,
      color: user.color,
      avatar: user.avatar || null,
      role: user.role,
      createdAt: user.createdAt
    });
  } catch (error) {
    logger.error('Get profile error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Update user profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { username, email, color } = req.body;
    const userId = req.user.id;

    // Check if email is taken by another user
    if (email) {
      const existingUser = await User.findOne({ email, _id: { $ne: userId } });
      if (existingUser) {
        return res.status(400).json({ message: 'Email je už registrovaný' });
      }
    }

    // Check if username is taken by another user
    if (username) {
      const existingUser = await User.findOne({ username, _id: { $ne: userId } });
      if (existingUser) {
        return res.status(400).json({ message: 'Užívateľské meno je už obsadené' });
      }
    }

    const updates = {};
    if (username) updates.username = username;
    if (email) updates.email = email;
    if (color) updates.color = color;

    const updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true });

    logger.info('Profile updated', { userId, updates: Object.keys(updates) });

    res.json({
      id: updatedUser._id,
      username: updatedUser.username,
      email: updatedUser.email,
      color: updatedUser.color,
      avatar: updatedUser.avatar || null,
      role: updatedUser.role
    });
  } catch (error) {
    logger.error('Update profile error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Upload avatar - stores Base64 in MongoDB
router.post('/avatar', authenticateToken, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      logger.error('Avatar upload multer error', { error: err.message, userId: req.user?.id });
      return res.status(400).json({ message: err.message || 'Chyba pri nahrávaní avatara' });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Žiadny súbor nebol nahraný' });
      }

      const userId = req.user.id;

      // Convert to Base64
      const base64Data = req.file.buffer.toString('base64');

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        {
          avatar: `avatar-${userId}`,  // Just an identifier
          avatarData: base64Data,
          avatarMimetype: req.file.mimetype
        },
        { new: true }
      );

      logger.info('Avatar uploaded', { userId, mimetype: req.file.mimetype, size: req.file.size });

      res.json({
        message: 'Avatar bol úspešne nahraný',
        avatar: updatedUser.avatar
      });
    } catch (error) {
      logger.error('Avatar upload error', { error: error.message, userId: req.user.id });
      res.status(500).json({ message: 'Chyba pri nahrávaní avatara', error: error.message });
    }
  });
});

// Get avatar image
router.get('/avatar/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);

    if (!user || !user.avatarData) {
      return res.status(404).json({ message: 'Avatar nenájdený' });
    }

    const buffer = Buffer.from(user.avatarData, 'base64');
    res.set('Content-Type', user.avatarMimetype || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');  // Cache for 24 hours
    res.send(buffer);
  } catch (error) {
    logger.error('Avatar get error', { error: error.message, userId: req.params.userId });
    res.status(500).json({ message: 'Chyba pri načítaní avatara' });
  }
});

// Delete avatar
router.delete('/avatar', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    await User.findByIdAndUpdate(userId, {
      avatar: null,
      avatarData: null,
      avatarMimetype: null
    });
    logger.info('Avatar deleted', { userId });

    res.json({ message: 'Avatar bol odstránený' });
  } catch (error) {
    logger.error('Avatar delete error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba pri odstraňovaní avatara', error: error.message });
  }
});

// Change password - with rate limiting
router.put('/password', authenticateToken, passwordChangeLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Nové heslo musí mať aspoň 6 znakov' });
    }

    const user = await User.findById(userId);

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      logger.auth('password-change', userId, user.username, false, req.ip);
      return res.status(400).json({ message: 'Aktuálne heslo nie je správne' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await User.findByIdAndUpdate(userId, { password: hashedPassword });

    logger.auth('password-change', userId, user.username, true, req.ip);

    res.json({ message: 'Heslo bolo úspešne zmenené' });
  } catch (error) {
    logger.error('Password change error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba pri zmene hesla', error: error.message });
  }
});

// Get all users (for sharing)
router.get('/users', authenticateToken, async (req, res) => {
  try {
    const users = await User.find({}, 'username email color avatar role');
    res.json(users.map(u => ({
      id: u._id,
      username: u.username,
      email: u.email,
      color: u.color,
      avatar: u.avatar,
      role: u.role
    })));
  } catch (error) {
    logger.error('Get users error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Set admin by username (internal use - protected by secret)
router.post('/set-admin', async (req, res) => {
  try {
    const { username, secret } = req.body;

    // Simple secret check - should match JWT_SECRET
    if (secret !== JWT_SECRET) {
      return res.status(403).json({ message: 'Neplatný prístup' });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }

    await User.findByIdAndUpdate(user._id, { role: 'admin' });

    logger.info('Admin set via secret', { username });

    res.json({ message: `Užívateľ ${username} bol nastavený ako admin`, success: true });
  } catch (error) {
    logger.error('Set admin error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

// Update user role (admin only)
router.put('/users/:userId/role', authenticateToken, async (req, res) => {
  try {
    const { role } = req.body;

    // Check if current user is admin
    const currentUser = await User.findById(req.user.id);
    if (currentUser.role !== 'admin') {
      return res.status(403).json({ message: 'Len admin môže meniť role' });
    }

    // Validate role
    if (!['admin', 'manager', 'user'].includes(role)) {
      return res.status(400).json({ message: 'Neplatná rola' });
    }

    // Prevent removing last admin
    if (role !== 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      const targetUser = await User.findById(req.params.userId);
      if (targetUser && targetUser.role === 'admin' && adminCount <= 1) {
        return res.status(400).json({ message: 'Nemôže existovať systém bez admina' });
      }
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.params.userId,
      { role },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: 'Užívateľ nenájdený' });
    }

    const io = req.app.get('io');
    io.emit('user-role-updated', {
      userId: updatedUser._id,
      role: updatedUser.role
    });

    logger.info('User role updated', {
      adminId: req.user.id,
      targetUserId: req.params.userId,
      newRole: role
    });

    res.json({
      id: updatedUser._id,
      username: updatedUser.username,
      email: updatedUser.email,
      color: updatedUser.color,
      avatar: updatedUser.avatar,
      role: updatedUser.role
    });
  } catch (error) {
    logger.error('Update user role error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera', error: error.message });
  }
});

module.exports = router;
