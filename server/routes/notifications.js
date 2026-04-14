const express = require('express');
const mongoose = require('mongoose');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace } = require('../middleware/workspace');
const Notification = require('../models/Notification');
const logger = require('../utils/logger');

const router = express.Router();

// Get notifications for current user — scoped to ACTIVE workspace.
// Multi-workspace users only see notifications from their current workspace
// in the bell; other workspaces expose unread counts via /unread-by-workspace.
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { limit = 50, offset = 0, unreadOnly = false } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const parsedOffset = Math.max(parseInt(offset) || 0, 0);

    // Filter by workspace — legacy records without workspaceId stay hidden
    // (they are backfilled by the migration script on startup).
    const query = { userId: req.user.id, workspaceId: req.workspaceId };
    if (unreadOnly === 'true') {
      query.read = false;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(parsedOffset)
      .limit(parsedLimit)
      .lean();

    const total = await Notification.countDocuments(query);
    const unreadCount = await Notification.countDocuments({
      userId: req.user.id,
      workspaceId: req.workspaceId,
      read: false
    });

    res.json({
      notifications: notifications.map(n => ({
        id: n._id.toString(),
        workspaceId: n.workspaceId ? n.workspaceId.toString() : null,
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

// Get unread count — scoped to active workspace
router.get('/unread-count', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      userId: req.user.id,
      workspaceId: req.workspaceId,
      read: false
    });
    res.json({ count });
  } catch (error) {
    logger.error('[Notifications] Error counting unread', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri počítaní notifikácií' });
  }
});

// Get unread counts per workspace — used to badge the workspace switcher
// so the user knows another workspace has activity.
router.get('/unread-by-workspace', authenticateToken, async (req, res) => {
  try {
    const counts = await Notification.aggregate([
      { $match: {
          userId: new mongoose.Types.ObjectId(req.user.id),
          read: false,
          workspaceId: { $ne: null }
      }},
      { $group: { _id: '$workspaceId', count: { $sum: 1 } } }
    ]);
    const result = {};
    counts.forEach(c => {
      if (c._id) result[c._id.toString()] = c.count;
    });
    res.json(result);
  } catch (error) {
    logger.error('[Notifications] Error counting by workspace', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri počítaní notifikácií' });
  }
});

// Get unread counts grouped by section (scoped to active workspace)
router.get('/unread-by-section', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const counts = await Notification.aggregate([
      { $match: {
          userId: new mongoose.Types.ObjectId(req.user.id),
          workspaceId: new mongoose.Types.ObjectId(req.workspaceId),
          read: false
      }},
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

// Mark all notifications in a section as read (scoped to active workspace)
router.put('/read-by-section/:section', authenticateToken, requireWorkspace, async (req, res) => {
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
      { userId: req.user.id, workspaceId: req.workspaceId, read: false, type: { $regex: regex } },
      { read: true }
    );
    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    logger.error('[Notifications] Error marking section as read', { error: error.message, section: req.params.section });
    res.status(500).json({ message: 'Chyba pri označovaní sekcie' });
  }
});

// Mark all notifications for a specific related entity as read.
// Used when a deep link opens the target item (push / bell / cold-start URL)
// so the bell badge reflects that the user has actually seen it.
// Body: { relatedType: 'message'|'contact'|'task'|'subtask', relatedId: '...', commentId?: '...' }
router.put('/read-for-related', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { relatedType, relatedId } = req.body || {};
    if (!relatedType || !relatedId) {
      return res.status(400).json({ message: 'relatedType a relatedId sú povinné' });
    }
    if (!/^[0-9a-fA-F]{24}$/.test(relatedId)) {
      return res.status(400).json({ message: 'Neplatné relatedId' });
    }
    // Match by relatedId directly OR by data.messageId/taskId/contactId
    const dataKey = relatedType === 'message' ? 'data.messageId'
                  : relatedType === 'contact' ? 'data.contactId'
                  : (relatedType === 'task' || relatedType === 'subtask') ? 'data.taskId'
                  : null;
    const or = [{ relatedId: relatedId }];
    if (dataKey) or.push({ [dataKey]: relatedId });
    const result = await Notification.updateMany(
      { userId: req.user.id, workspaceId: req.workspaceId, read: false, $or: or },
      { read: true }
    );
    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    logger.error('[Notifications] Error marking related as read', { error: error.message });
    res.status(500).json({ message: 'Chyba pri označovaní' });
  }
});

// Mark notification as read
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
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

// Mark all notifications as read (in active workspace only)
router.put('/read-all', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user.id, workspaceId: req.workspaceId, read: false },
      { read: true }
    );

    logger.debug('[Notifications] Marked all as read', { userId: req.user.id, workspaceId: req.workspaceId, modified: result.modifiedCount });
    res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    logger.error('[Notifications] Error marking all as read', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri označovaní notifikácií' });
  }
});

// Delete a notification
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
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

// Delete all notifications (in active workspace only)
router.delete('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const result = await Notification.deleteMany({
      userId: req.user.id,
      workspaceId: req.workspaceId
    });
    logger.info('[Notifications] Deleted all notifications', { userId: req.user.id, workspaceId: req.workspaceId, deleted: result.deletedCount });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (error) {
    logger.error('[Notifications] Error deleting all', { error: error.message, userId: req.user?.id });
    res.status(500).json({ message: 'Chyba pri mazaní notifikácií' });
  }
});

// Test endpoint - send a test notification to yourself (development only)
router.post('/test', authenticateToken, requireWorkspace, async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ message: 'Not found' });
  }
  try {
    const io = req.app.get('io');
    const userId = req.user.id.toString();

    const notification = new Notification({
      userId: userId,
      workspaceId: req.workspaceId,
      type: 'task.created',
      title: 'Testovacia notifikácia',
      message: 'Toto je test notifikačného systému',
      actorId: userId,
      actorName: req.user.username,
      relatedType: 'task',
      data: { test: true, workspaceId: req.workspaceId?.toString() }
    });

    await notification.save();

    if (io) {
      const roomName = `user-${userId}`;
      io.to(roomName).emit('notification', {
        id: notification._id.toString(),
        workspaceId: notification.workspaceId?.toString() || null,
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
