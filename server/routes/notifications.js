const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const Notification = require('../models/Notification');
const logger = require('../utils/logger');

const router = express.Router();

// Get all notifications for current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, offset = 0, unreadOnly = false } = req.query;

    // Validate and sanitize pagination params
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const parsedOffset = Math.max(parseInt(offset) || 0, 0);

    const query = { userId: req.user.id };
    if (unreadOnly === 'true') {
      query.read = false;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(parsedOffset)
      .limit(parsedLimit)
      .lean();

    const total = await Notification.countDocuments(query);
    const unreadCount = await Notification.countDocuments({ userId: req.user.id, read: false });

    res.json({
      notifications: notifications.map(n => ({
        id: n._id.toString(),
        type: n.type,
        title: n.title,
        message: n.message,
        actorName: n.actorName,
        relatedType: n.relatedType,
        relatedId: n.relatedId,
        relatedName: n.relatedName,
        data: n.data,
        read: n.read,
        createdAt: n.createdAt
      })),
      total,
      unreadCount
    });
  } catch (error) {
    logger.error('[Notifications] Error fetching notifications', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri načítaní notifikácií' });
  }
});

// Get unread count
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      userId: req.user.id,
      read: false
    });
    res.json({ count });
  } catch (error) {
    logger.error('[Notifications] Error counting unread', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri počítaní notifikácií' });
  }
});

// Get unread counts grouped by section
router.get('/unread-by-section', authenticateToken, async (req, res) => {
  try {
    const counts = await Notification.aggregate([
      { $match: { userId: new (require('mongoose').Types.ObjectId)(req.user.id), read: false } },
      {
        $addFields: {
          section: {
            $switch: {
              branches: [
                { case: { $regexMatch: { input: '$type', regex: /^contact\./ } }, then: 'crm' },
                { case: { $regexMatch: { input: '$type', regex: /^(task\.|subtask\.)/ } }, then: 'tasks' },
                { case: { $regexMatch: { input: '$type', regex: /^message\./ } }, then: 'messages' }
              ],
              default: 'other'
            }
          }
        }
      },
      { $group: { _id: '$section', count: { $sum: 1 } } }
    ]);

    const result = { crm: 0, tasks: 0, messages: 0 };
    counts.forEach(c => { if (result.hasOwnProperty(c._id)) result[c._id] = c.count; });
    res.json(result);
  } catch (error) {
    logger.error('[Notifications] Error counting by section', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri počítaní notifikácií' });
  }
});

// Mark all notifications in a section as read
router.put('/read-by-section/:section', authenticateToken, async (req, res) => {
  const sectionMap = {
    crm: /^contact\./,
    tasks: /^(task\.|subtask\.)/,
    messages: /^message\./
  };

  const regex = sectionMap[req.params.section];
  if (!regex) {
    return res.status(400).json({ message: 'Neplatná sekcia' });
  }

  try {
    const result = await Notification.updateMany(
      { userId: req.user.id, read: false, type: { $regex: regex } },
      { read: true }
    );
    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    logger.error('[Notifications] Error marking section as read', { error: error.message, section: req.params.section });
    res.status(500).json({ message: 'Chyba pri označovaní sekcie' });
  }
});

// Mark notification as read
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
    // Validate ObjectId format
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: 'Neplatné ID notifikácie' });
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notifikácia nenájdená' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('[Notifications] Error marking as read', { error: error.message, userId: req.user?.id, notificationId: req.params.id });
    res.status(500).json({ message: 'Chyba pri označovaní notifikácie' });
  }
});

// Mark all notifications as read
router.put('/read-all', authenticateToken, async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user.id, read: false },
      { read: true }
    );

    logger.debug('[Notifications] Marked all as read', { userId: req.user.id, modified: result.modifiedCount });
    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    logger.error('[Notifications] Error marking all as read', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri označovaní notifikácií' });
  }
});

// Delete a notification
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    // Validate ObjectId format
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: 'Neplatné ID notifikácie' });
    }

    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id
    });

    if (!notification) {
      return res.status(404).json({ message: 'Notifikácia nenájdená' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('[Notifications] Error deleting notification', { error: error.message, userId: req.user?.id, notificationId: req.params.id });
    res.status(500).json({ message: 'Chyba pri mazaní notifikácie' });
  }
});

// Delete all notifications
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const result = await Notification.deleteMany({ userId: req.user.id });
    logger.info('[Notifications] Deleted all notifications', { userId: req.user.id, deleted: result.deletedCount });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (error) {
    logger.error('[Notifications] Error deleting all', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri mazaní notifikácií' });
  }
});

// Test endpoint - send a test notification to yourself (development only)
router.post('/test', authenticateToken, async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ message: 'Not found' });
  }
  try {
    const io = req.app.get('io');
    const userId = req.user.id.toString();

    const notification = new Notification({
      userId: userId,
      type: 'task.created',
      title: 'Testovacia notifikácia',
      message: 'Toto je test notifikačného systému',
      actorId: userId,
      actorName: req.user.username,
      relatedType: 'task',
      data: { test: true }
    });

    await notification.save();

    // Send real-time notification via Socket.IO
    if (io) {
      const roomName = `user-${userId}`;
      io.to(roomName).emit('notification', {
        id: notification._id.toString(),
        type: notification.type,
        title: notification.title,
        message: notification.message,
        actorName: notification.actorName,
        relatedType: notification.relatedType,
        data: notification.data,
        read: notification.read,
        createdAt: notification.createdAt
      });
    }

    logger.debug('[Notifications] Test notification sent', { userId });
    res.json({ success: true, message: 'Test notifikácia odoslaná', notificationId: notification._id.toString() });
  } catch (error) {
    logger.error('[Notifications] Error sending test notification', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri odosielaní testovacej notifikácie' });
  }
});

module.exports = router;
