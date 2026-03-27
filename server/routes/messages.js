const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace, enforceWorkspaceLimits } = require('../middleware/workspace');
const Message = require('../models/Message');
const User = require('../models/User');
const notificationService = require('../services/notificationService');
const logger = require('../utils/logger');

const router = express.Router();

// Multer for attachment uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedExtensions = /jpeg|jpg|png|gif|bmp|webp|svg|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|json|xml|zip|rar|7z/;
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (allowedExtensions.test(ext)) return cb(null, true);
    cb(new Error('Nepovolený typ súboru'));
  }
});

// Type labels for notifications
const typeLabels = {
  approval: 'Schválenie',
  info: 'Informácia',
  request: 'Žiadosť',
  proposal: 'Návrh'
};

// Helper: strip attachment data for list views
const stripAttachmentData = (msg) => {
  const obj = msg.toObject ? msg.toObject() : { ...msg };
  obj.id = obj._id ? obj._id.toString() : obj.id;
  if (obj.attachment && obj.attachment.data) {
    obj.attachment = {
      id: obj.attachment.id,
      originalName: obj.attachment.originalName,
      mimetype: obj.attachment.mimetype,
      size: obj.attachment.size,
      uploadedAt: obj.attachment.uploadedAt
    };
  }
  return obj;
};

// GET /api/messages — get messages for current user (received + sent)
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const userId = req.user.id.toString();
    const { tab = 'received', status } = req.query;

    const query = { workspaceId: req.workspaceId };

    if (tab === 'sent') {
      query.fromUserId = req.user.id;
    } else {
      query.toUserId = req.user.id;
    }

    if (status && status !== 'all') {
      query.status = status;
    }

    const messages = await Message.find(query, { 'attachment.data': 0 })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Add id field
    const result = messages.map(m => ({ ...m, id: m._id.toString() }));

    res.json(result);
  } catch (error) {
    logger.error('Get messages error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/pending-count — count pending messages for current user
router.get('/pending-count', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const count = await Message.countDocuments({
      workspaceId: req.workspaceId,
      toUserId: req.user.id,
      status: 'pending'
    });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/:id — get single message (with attachment data for download)
router.get('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return res.status(400).json({ message: 'Neplatné ID' });
    }

    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      $or: [
        { fromUserId: req.user.id },
        { toUserId: req.user.id }
      ]
    });

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený' });
    }

    res.json(stripAttachmentData(message));
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/messages — create a new message
router.post('/', authenticateToken, requireWorkspace, enforceWorkspaceLimits, (req, res) => {
  upload.single('attachment')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'Súbor je príliš veľký. Maximum je 10MB.' });
      }
      return res.status(400).json({ message: err.message || 'Chyba pri nahrávaní' });
    }

    try {
      const { toUserId, type, subject, description, linkedType, linkedId, linkedName, dueDate } = req.body;

      // Validate required fields
      if (!toUserId || !type || !subject) {
        return res.status(400).json({ message: 'Príjemca, typ a predmet sú povinné' });
      }

      if (!['approval', 'info', 'request', 'proposal'].includes(type)) {
        return res.status(400).json({ message: 'Neplatný typ odkazu' });
      }

      // Get recipient
      const recipient = await User.findById(toUserId);
      if (!recipient) {
        return res.status(404).json({ message: 'Príjemca nenájdený' });
      }

      // Cannot send to yourself
      if (toUserId === req.user.id.toString()) {
        return res.status(400).json({ message: 'Nemôžete poslať odkaz sami sebe' });
      }

      // Build attachment if file uploaded
      let attachment = null;
      if (req.file) {
        attachment = {
          id: uuidv4(),
          originalName: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
          data: req.file.buffer.toString('base64'),
          uploadedAt: new Date()
        };
      }

      const message = new Message({
        workspaceId: req.workspaceId,
        fromUserId: req.user.id,
        fromUsername: req.user.username,
        toUserId: recipient._id,
        toUsername: recipient.username,
        type,
        subject: subject.trim().substring(0, 200),
        description: (description || '').trim().substring(0, 5000),
        attachment,
        linkedType: linkedType || null,
        linkedId: linkedId || null,
        linkedName: linkedName || null,
        dueDate: dueDate || null,
        status: 'pending'
      });

      await message.save();

      // Send notification to recipient
      const typeLabel = typeLabels[type] || type;
      try {
        await notificationService.createNotification({
          userId: recipient._id.toString(),
          type: 'message.created',
          title: `📨 Nový odkaz: ${typeLabel}`,
          message: `${req.user.username} vám poslal odkaz "${subject}"`,
          actorName: req.user.username,
          relatedType: 'message',
          relatedId: message._id.toString(),
          relatedName: subject,
          data: { messageId: message._id.toString() }
        });
      } catch (notifErr) {
        logger.warn('Message notification failed', { error: notifErr.message });
      }

      // Emit socket event
      const io = req.app.get('io');
      if (io) {
        io.to(`user-${recipient._id.toString()}`).emit('message-created', {
          id: message._id.toString(),
          fromUsername: req.user.username,
          type,
          subject,
          status: 'pending'
        });
      }

      res.status(201).json(stripAttachmentData(message));
    } catch (error) {
      logger.error('Create message error', { error: error.message, userId: req.user.id });
      res.status(500).json({ message: 'Chyba servera' });
    }
  });
});

// PUT /api/messages/:id/approve — approve message
router.put('/:id/approve', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      toUserId: req.user.id,
      status: 'pending'
    });

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený alebo už bol vybavený' });
    }

    message.status = 'approved';
    message.resolvedBy = req.user.id;
    message.resolvedAt = new Date();
    await message.save();

    // Notify sender
    try {
      await notificationService.createNotification({
        userId: message.fromUserId.toString(),
        type: 'message.approved',
        title: '✅ Odkaz schválený',
        message: `${req.user.username} schválil váš odkaz "${message.subject}"`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: message._id.toString(),
        relatedName: message.subject,
        data: { messageId: message._id.toString() }
      });
    } catch (notifErr) {
      logger.warn('Approve notification failed', { error: notifErr.message });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.fromUserId.toString()}`).emit('message-updated', {
        id: message._id.toString(),
        status: 'approved'
      });
    }

    res.json(stripAttachmentData(message));
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// PUT /api/messages/:id/reject — reject message
router.put('/:id/reject', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { reason } = req.body;

    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      toUserId: req.user.id,
      status: 'pending'
    });

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený alebo už bol vybavený' });
    }

    message.status = 'rejected';
    message.rejectionReason = (reason || '').trim().substring(0, 1000);
    message.resolvedBy = req.user.id;
    message.resolvedAt = new Date();
    await message.save();

    // Notify sender
    try {
      await notificationService.createNotification({
        userId: message.fromUserId.toString(),
        type: 'message.rejected',
        title: '❌ Odkaz zamietnutý',
        message: `${req.user.username} zamietol váš odkaz "${message.subject}"${reason ? ` — ${reason}` : ''}`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: message._id.toString(),
        relatedName: message.subject,
        data: { messageId: message._id.toString() }
      });
    } catch (notifErr) {
      logger.warn('Reject notification failed', { error: notifErr.message });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.fromUserId.toString()}`).emit('message-updated', {
        id: message._id.toString(),
        status: 'rejected'
      });
    }

    res.json(stripAttachmentData(message));
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/messages/:id/comment — add comment
router.post('/:id/comment', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Text komentára je povinný' });
    }

    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      $or: [
        { fromUserId: req.user.id },
        { toUserId: req.user.id }
      ]
    });

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený' });
    }

    const comment = {
      userId: req.user.id,
      username: req.user.username,
      text: text.trim().substring(0, 2000),
      createdAt: new Date()
    };

    message.comments.push(comment);

    // If comment is from recipient and status is pending, change to commented
    if (message.toUserId.toString() === req.user.id.toString() && message.status === 'pending') {
      message.status = 'commented';
    }

    await message.save();

    // Notify the other party
    const notifyUserId = message.fromUserId.toString() === req.user.id.toString()
      ? message.toUserId.toString()
      : message.fromUserId.toString();

    try {
      await notificationService.createNotification({
        userId: notifyUserId,
        type: 'message.commented',
        title: '💬 Nový komentár',
        message: `${req.user.username} komentoval odkaz "${message.subject}"`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: message._id.toString(),
        relatedName: message.subject,
        data: { messageId: message._id.toString() }
      });
    } catch (notifErr) {
      logger.warn('Comment notification failed', { error: notifErr.message });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${notifyUserId}`).emit('message-updated', {
        id: message._id.toString(),
        status: message.status
      });
    }

    res.json(stripAttachmentData(message));
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/:id/attachment — download attachment
router.get('/:id/attachment', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      $or: [
        { fromUserId: req.user.id },
        { toUserId: req.user.id }
      ]
    });

    if (!message || !message.attachment || !message.attachment.data) {
      return res.status(404).json({ message: 'Príloha nenájdená' });
    }

    const fileBuffer = Buffer.from(message.attachment.data, 'base64');
    res.set({
      'Content-Type': message.attachment.mimetype,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(message.attachment.originalName)}"`,
      'Content-Length': fileBuffer.length
    });
    res.send(fileBuffer);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// DELETE /api/messages/:id — delete message (only sender can delete)
router.delete('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      fromUserId: req.user.id
    });

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený' });
    }

    await Message.deleteOne({ _id: req.params.id });

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.toUserId.toString()}`).emit('message-deleted', {
        id: req.params.id
      });
    }

    res.json({ message: 'Odkaz bol vymazaný' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
