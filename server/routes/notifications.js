const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const Notification = require('../models/Notification');

const router = express.Router();

// Get all notifications for current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, offset = 0, unreadOnly = false } = req.query;

    const query = { userId: req.user.id };
    if (unreadOnly === 'true') {
      query.read = false;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
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
    console.error('Error fetching notifications:', error);
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
    console.error('Error counting unread notifications:', error);
    res.status(500).json({ message: 'Chyba pri počítaní notifikácií' });
  }
});

// Mark notification as read
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
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
    console.error('Error marking notification as read:', error);
    res.status(500).json({ message: 'Chyba pri označovaní notifikácie' });
  }
});

// Mark all notifications as read
router.put('/read-all', authenticateToken, async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user.id, read: false },
      { read: true }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ message: 'Chyba pri označovaní notifikácií' });
  }
});

// Delete a notification
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id
    });

    if (!notification) {
      return res.status(404).json({ message: 'Notifikácia nenájdená' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: 'Chyba pri mazaní notifikácie' });
  }
});

// Delete all notifications
router.delete('/', authenticateToken, async (req, res) => {
  try {
    await Notification.deleteMany({ userId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting all notifications:', error);
    res.status(500).json({ message: 'Chyba pri mazaní notifikácií' });
  }
});

// Test endpoint - send a test notification to yourself
router.post('/test', authenticateToken, async (req, res) => {
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
    console.log(`Test notification saved for user ${userId}`);

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
      console.log(`Test notification emitted to room: ${roomName}`);
    } else {
      console.log('IO not available for test notification');
    }

    res.json({ success: true, message: 'Test notifikácia odoslaná', notificationId: notification._id.toString() });
  } catch (error) {
    console.error('Error sending test notification:', error.message, error.stack);
    res.status(500).json({ message: 'Chyba pri odosielaní testovacej notifikácie', error: error.message });
  }
});

module.exports = router;
