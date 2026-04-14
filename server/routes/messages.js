const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace, enforceWorkspaceLimits } = require('../middleware/workspace');
const Message = require('../models/Message');
const User = require('../models/User');
const notificationService = require('../services/notificationService');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');

// Projection that excludes ALL Base64 blobs so comment CRUD never pulls
// megabytes of existing attachments into Node memory. Root cause of
// 10+ sec comment operations was `message.save()` rewriting the full
// document (including every Base64 attachment of every other comment).
const NO_BASE64_PROJECTION = {
  'attachment.data': 0,
  'files.data': 0,
  'comments.attachment.data': 0
};

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
  proposal: 'Návrh',
  poll: 'Anketa'
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
  // Strip files data
  if (obj.files) {
    obj.files = obj.files.map(f => ({
      id: f.id,
      originalName: f.originalName,
      mimetype: f.mimetype,
      size: f.size,
      uploadedAt: f.uploadedAt
    }));
  }
  // Strip comment attachment data too
  if (obj.comments) {
    obj.comments = obj.comments.map(c => {
      if (c.attachment && c.attachment.data) {
        c.attachment = {
          originalName: c.attachment.originalName,
          mimetype: c.attachment.mimetype,
          size: c.attachment.size,
          uploadedAt: c.attachment.uploadedAt
        };
      }
      return c;
    });
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
    } else if (tab === 'all') {
      query.$or = [{ fromUserId: req.user.id }, { toUserId: req.user.id }];
    } else {
      query.toUserId = req.user.id;
    }

    if (status && status !== 'all') {
      query.status = status;
    }

    const messages = await Message.find(query, { 'attachment.data': 0, 'files.data': 0, 'comments.attachment.data': 0 })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Add id field and strip any remaining base64 data from nested arrays
    const result = messages.map(m => {
      // Strip files.data (projection may not work on nested arrays in all MongoDB versions)
      if (m.files?.length) {
        m.files = m.files.map(f => { const { data, ...rest } = f; return rest; });
      }
      // Strip comments attachment data
      if (m.comments?.length) {
        m.comments = m.comments.map(c => {
          if (c.attachment?.data) {
            const { data, ...attRest } = c.attachment;
            c.attachment = attRest;
          }
          return c;
        });
      }
      return { ...m, id: m._id.toString() };
    });

    res.json(result);
  } catch (error) {
    logger.error('Get messages error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/by-linked — messages linked to a contact or task
router.get('/by-linked', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { linkedType, linkedId } = req.query;
    if (!linkedType || !linkedId) {
      return res.status(400).json({ message: 'linkedType a linkedId sú povinné' });
    }

    const messages = await Message.find(
      { workspaceId: req.workspaceId, linkedType, linkedId },
      { 'attachment.data': 0, 'files.data': 0 }
    )
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const result = messages.map(m => ({ ...m, id: m._id.toString() }));
    res.json(result);
  } catch (error) {
    logger.error('Get linked messages error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/pending-count — count unread pending messages for current user
router.get('/pending-count', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const count = await Message.countDocuments({
      workspaceId: req.workspaceId,
      toUserId: req.user.id,
      status: 'pending',
      readBy: { $ne: req.user.id }
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

    // PERF: single findOneAndUpdate + .lean() instead of findOne + updateOne.
    // $addToSet is idempotent so it's safe to always run; one DB round-trip
    // instead of two, and .lean() skips Mongoose document hydration (big win
    // for messages with many comments / attachments).
    // PERF: exclude Base64 attachment/file/comment-attachment blobs from the
    // payload. These can be MBs each and are only needed on explicit download
    // via the /attachment endpoints. This was making message detail open take
    // tens of seconds when large attachments were present.
    const message = await Message.findOneAndUpdate(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ]
      },
      { $addToSet: { readBy: req.user.id } },
      { new: true, projection: NO_BASE64_PROJECTION }
    ).lean();

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

      if (!['approval', 'info', 'request', 'proposal', 'poll'].includes(type)) {
        return res.status(400).json({ message: 'Neplatný typ odkazu' });
      }

      // Validate poll options
      let parsedPollOptions = [];
      let pollMultipleChoice = false;
      if (type === 'poll') {
        try {
          parsedPollOptions = JSON.parse(req.body.pollOptions || '[]');
        } catch {
          parsedPollOptions = [];
        }
        if (!Array.isArray(parsedPollOptions) || parsedPollOptions.length < 2) {
          return res.status(400).json({ message: 'Anketa musí mať aspoň 2 možnosti' });
        }
        if (parsedPollOptions.length > 10) {
          return res.status(400).json({ message: 'Anketa môže mať maximálne 10 možností' });
        }
        parsedPollOptions = parsedPollOptions
          .map(opt => ({ text: (typeof opt === 'string' ? opt : opt.text || '').trim().substring(0, 200) }))
          .filter(opt => opt.text.length > 0);
        if (parsedPollOptions.length < 2) {
          return res.status(400).json({ message: 'Anketa musí mať aspoň 2 neprázdne možnosti' });
        }
        pollMultipleChoice = req.body.pollMultipleChoice === 'true' || req.body.pollMultipleChoice === true;
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
        pollOptions: type === 'poll' ? parsedPollOptions : [],
        pollMultipleChoice: type === 'poll' ? pollMultipleChoice : false,
        status: 'pending'
      });

      await message.save();

      // Send notification to recipient
      const typeLabel = typeLabels[type] || type;
      try {
        await notificationService.createNotification({
          userId: recipient._id.toString(),
          workspaceId: req.workspaceId,
          type: 'message.created',
          title: `📨 Nový odkaz: ${typeLabel}`,
          message: `${req.user.username} vám poslal odkaz "${subject}"`,
          actorName: req.user.username,
          relatedType: 'message',
          relatedId: message._id.toString(),
          relatedName: subject,
          data: { messageId: message._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
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

      // Audit log (fire and forget)
      auditService.logAction({
        userId: req.user.id,
        username: req.user.username,
        email: req.user.email,
        action: 'message.created',
        category: 'message',
        targetType: 'message',
        targetId: message._id.toString(),
        targetName: subject,
        details: { subject, recipient: recipient.username, type },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        workspaceId: req.workspaceId || null
      });
    } catch (error) {
      logger.error('Create message error', { error: error.message, userId: req.user.id });
      res.status(500).json({ message: 'Chyba servera' });
    }
  });
});

// PUT /api/messages/:id — edit message (only sender can edit)
router.put('/:id', authenticateToken, requireWorkspace, (req, res) => {
  upload.single('attachment')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'Chyba pri nahrávaní súboru' });
    }

    try {
      const message = await Message.findOne({
        _id: req.params.id,
        workspaceId: req.workspaceId,
        fromUserId: req.user.id
      });

      if (!message) {
        return res.status(404).json({ message: 'Odkaz nenájdený' });
      }

      // Update allowed fields
      const { subject, description, type, dueDate, linkedType, linkedId, linkedName, removeAttachment } = req.body;

      if (subject !== undefined) message.subject = subject.trim().substring(0, 200);
      if (description !== undefined) message.description = description.trim().substring(0, 5000);
      if (type !== undefined && ['approval', 'info', 'request', 'proposal', 'poll'].includes(type)) message.type = type;
      if (dueDate !== undefined) message.dueDate = dueDate || null;
      if (linkedType !== undefined) {
        message.linkedType = linkedType || null;
        message.linkedId = linkedId || null;
        message.linkedName = linkedName || null;
      }

      // Handle attachment: new file replaces old, or remove existing
      if (req.file) {
        message.attachment = {
          originalName: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
          data: req.file.buffer.toString('base64'),
          uploadedAt: new Date()
        };
      } else if (removeAttachment === 'true') {
        message.attachment = undefined;
      }

      await message.save();

      // Notify recipient about edit
      const io = req.app.get('io');
      if (io) {
        io.to(`user-${message.toUserId.toString()}`).emit('message-updated', {
          id: message._id.toString(),
          status: message.status
        });
      }

      res.json(stripAttachmentData(message));
    } catch (error) {
      logger.error('Edit message error', { error: error.message, userId: req.user.id });
      res.status(500).json({ message: 'Chyba servera' });
    }
  });
});

// PUT /api/messages/:id/approve — approve message (recipient or workspace admin)
router.put('/:id/approve', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const query = {
      _id: req.params.id,
      workspaceId: req.workspaceId,
      status: { $in: ['pending', 'commented'] }
    };
    // Recipient can always approve; admin/manager can too
    const isAdmin = req.workspaceMember.canAdmin();
    if (!isAdmin) {
      query.toUserId = req.user.id;
    }

    const message = await Message.findOne(query);

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
        workspaceId: req.workspaceId,
        type: 'message.approved',
        title: '✅ Odkaz schválený',
        message: `${req.user.username} schválil váš odkaz "${message.subject}"`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: message._id.toString(),
        relatedName: message.subject,
        data: { messageId: message._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
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

    // Audit log (fire and forget)
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'message.approved',
      category: 'message',
      targetType: 'message',
      targetId: message._id.toString(),
      targetName: message.subject,
      details: { subject: message.subject },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// PUT /api/messages/:id/reject — reject message (recipient or workspace admin)
router.put('/:id/reject', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { reason } = req.body;

    const query = {
      _id: req.params.id,
      workspaceId: req.workspaceId,
      status: { $in: ['pending', 'commented'] }
    };
    const isAdmin = req.workspaceMember.canAdmin();
    if (!isAdmin) {
      query.toUserId = req.user.id;
    }

    const message = await Message.findOne(query);

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
        workspaceId: req.workspaceId,
        type: 'message.rejected',
        title: '❌ Odkaz zamietnutý',
        message: `${req.user.username} zamietol váš odkaz "${message.subject}"${reason ? ` — ${reason}` : ''}`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: message._id.toString(),
        relatedName: message.subject,
        data: { messageId: message._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
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

    // Audit log (fire and forget)
    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'message.rejected',
      category: 'message',
      targetType: 'message',
      targetId: message._id.toString(),
      targetName: message.subject,
      details: { subject: message.subject, reason: message.rejectionReason },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// PUT /api/messages/:id/reopen — revert approval/rejection back to pending/commented
router.put('/:id/reopen', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      status: { $in: ['approved', 'rejected'] }
    });

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený alebo nie je schválený/zamietnutý' });
    }

    // Only workspace admin (owner/manager) or the recipient can reopen
    const isAdmin = req.workspaceMember.canAdmin();
    const isRecipient = message.toUserId.toString() === req.user.id.toString();
    if (!isAdmin && !isRecipient) {
      return res.status(403).json({ message: 'Nemáte oprávnenie zrušiť rozhodnutie' });
    }

    const previousStatus = message.status;
    // If there are comments, set to 'commented', otherwise 'pending'
    message.status = message.comments?.length > 0 ? 'commented' : 'pending';
    message.resolvedBy = null;
    message.resolvedAt = null;
    message.rejectionReason = '';
    // Clear readBy so it shows as unread again
    message.readBy = [];
    await message.save();

    // Notify both parties
    const otherUserId = message.fromUserId.toString() === req.user.id.toString()
      ? message.toUserId.toString()
      : message.fromUserId.toString();

    try {
      await notificationService.createNotification({
        userId: otherUserId,
        workspaceId: req.workspaceId,
        type: 'message.created',
        title: '🔄 Rozhodnutie zrušené',
        message: `${req.user.username} zrušil ${previousStatus === 'approved' ? 'schválenie' : 'zamietnutie'} odkazu "${message.subject}"`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: message._id.toString(),
        relatedName: message.subject,
        data: { messageId: message._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
      });
    } catch (notifErr) {
      logger.warn('Reopen notification failed', { error: notifErr.message });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.fromUserId.toString()}`).emit('message-updated', {
        id: message._id.toString(), status: message.status
      });
      io.to(`user-${message.toUserId.toString()}`).emit('message-updated', {
        id: message._id.toString(), status: message.status
      });
    }

    res.json(stripAttachmentData(message));

    auditService.logAction({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      action: 'message.reopened',
      category: 'message',
      targetType: 'message',
      targetId: message._id.toString(),
      targetName: message.subject,
      details: { subject: message.subject, previousStatus },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      workspaceId: req.workspaceId || null
    });
  } catch (error) {
    logger.error('Reopen message error', { error: error.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/messages/:id/vote — vote on a poll option
router.post('/:id/vote', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { optionId } = req.body;

    if (!optionId) {
      return res.status(400).json({ message: 'optionId je povinný' });
    }

    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      type: 'poll',
      $or: [
        { fromUserId: req.user.id },
        { toUserId: req.user.id }
      ]
    });

    if (!message) {
      return res.status(404).json({ message: 'Anketa nenájdená' });
    }

    const option = message.pollOptions.id(optionId);
    if (!option) {
      return res.status(404).json({ message: 'Možnosť nenájdená' });
    }

    const userId = req.user.id.toString();

    if (message.pollMultipleChoice) {
      // Toggle vote on this option
      const existingVoteIdx = option.votes.findIndex(v => v.userId.toString() === userId);
      if (existingVoteIdx >= 0) {
        option.votes.splice(existingVoteIdx, 1);
      } else {
        option.votes.push({ userId: req.user.id, username: req.user.username });
      }
    } else {
      // Single choice — remove vote from all options, then add to selected
      const alreadyVotedHere = option.votes.some(v => v.userId.toString() === userId);
      for (const opt of message.pollOptions) {
        opt.votes = opt.votes.filter(v => v.userId.toString() !== userId);
      }
      if (!alreadyVotedHere) {
        option.votes.push({ userId: req.user.id, username: req.user.username });
      }
    }

    await message.save();

    // Notify the other party
    const notifyUserId = message.fromUserId.toString() === userId
      ? message.toUserId.toString()
      : message.fromUserId.toString();

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${notifyUserId}`).emit('message-updated', {
        id: message._id.toString(),
        status: message.status
      });
    }

    res.json(stripAttachmentData(message));
  } catch (error) {
    logger.error('Vote error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/messages/:id/comment — add comment (with optional attachment)
router.post('/:id/comment', authenticateToken, requireWorkspace, (req, res) => {
  upload.single('attachment')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'Chyba pri nahrávaní súboru' });
    }

    try {
      const { text } = req.body;

      if (!text || !text.trim()) {
        return res.status(400).json({ message: 'Text komentára je povinný' });
      }

      // PERF: load only metadata fields (NO Base64) for authorization +
      // status-transition decision. Full message was previously pulled,
      // mutated, and re-saved → rewrote every Base64 blob.
      const meta = await Message.findOne(
        {
          _id: req.params.id,
          workspaceId: req.workspaceId,
          $or: [
            { fromUserId: req.user.id },
            { toUserId: req.user.id }
          ]
        },
        { fromUserId: 1, toUserId: 1, status: 1, subject: 1 }
      ).lean();

      if (!meta) {
        return res.status(404).json({ message: 'Odkaz nenájdený' });
      }

      const comment = {
        _id: new mongoose.Types.ObjectId(),
        userId: req.user.id,
        username: req.user.username,
        text: text.trim().substring(0, 2000),
        createdAt: new Date()
      };

      // Attach file if uploaded
      if (req.file) {
        comment.attachment = {
          originalName: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
          data: req.file.buffer.toString('base64'),
          uploadedAt: new Date()
        };
      }

      // Atomic $push — only the new comment is sent over the wire.
      const update = { $push: { comments: comment } };
      const shouldTransition =
        meta.toUserId.toString() === req.user.id.toString() &&
        meta.status === 'pending';
      if (shouldTransition) {
        update.$set = { status: 'commented' };
      }

      await Message.updateOne({ _id: meta._id }, update);

      // Notify the other party
      const notifyUserId = meta.fromUserId.toString() === req.user.id.toString()
        ? meta.toUserId.toString()
        : meta.fromUserId.toString();

      // Fire-and-forget notification (see notificationService setImmediate)
      notificationService.createNotification({
        userId: notifyUserId,
        workspaceId: req.workspaceId,
        type: 'message.commented',
        title: '💬 Nový komentár',
        message: `${req.user.username} komentoval odkaz "${meta.subject}"`,
        actorName: req.user.username,
        relatedType: 'message',
        relatedId: meta._id.toString(),
        relatedName: meta.subject,
        data: { messageId: meta._id.toString(), commentId: comment._id.toString(), workspaceId: req.workspaceId ? req.workspaceId.toString() : undefined }
      }).catch(notifErr => {
        logger.warn('Comment notification failed', { error: notifErr.message });
      });

      const io = req.app.get('io');
      if (io) {
        io.to(`user-${notifyUserId}`).emit('message-updated', {
          id: meta._id.toString(),
          status: shouldTransition ? 'commented' : meta.status
        });
      }

      // Return updated message WITHOUT re-fetching Base64 blobs.
      const updated = await Message.findById(meta._id, NO_BASE64_PROJECTION).lean();
      res.json(stripAttachmentData(updated));
    } catch (error) {
      res.status(500).json({ message: 'Chyba servera' });
    }
  });
});

// PUT /api/messages/:id/comment/:commentId — edit comment (only author)
router.put('/:id/comment/:commentId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Text komentára je povinný' });
    }

    // PERF: atomic $set on the matched comment — no full doc save.
    // Authorship + workspace + membership enforced via filter.
    const newText = text.trim().substring(0, 2000);
    const result = await Message.updateOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ],
        comments: {
          $elemMatch: { _id: req.params.commentId, userId: req.user.id }
        }
      },
      { $set: { 'comments.$.text': newText } }
    );

    if (result.matchedCount === 0) {
      // Either message not found, comment not found, or user not author.
      return res.status(404).json({ message: 'Komentár nenájdený alebo nie ste autor' });
    }

    // Fetch minimal metadata for socket + response (no Base64).
    const updated = await Message.findById(req.params.id, NO_BASE64_PROJECTION).lean();

    // Notify the other party
    const notifyUserId = updated.fromUserId.toString() === req.user.id.toString()
      ? updated.toUserId.toString()
      : updated.fromUserId.toString();

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${notifyUserId}`).emit('message-updated', {
        id: updated._id.toString(),
        status: updated.status
      });
    }

    res.json(stripAttachmentData(updated));
  } catch (error) {
    logger.error('Edit comment error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// DELETE /api/messages/:id/comment/:commentId — delete comment (only author)
router.delete('/:id/comment/:commentId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // PERF: atomic $pull with authorship check in filter. No full doc save.
    const pullResult = await Message.updateOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ],
        comments: {
          $elemMatch: { _id: req.params.commentId, userId: req.user.id }
        }
      },
      { $pull: { comments: { _id: req.params.commentId } } }
    );

    if (pullResult.matchedCount === 0) {
      return res.status(404).json({ message: 'Komentár nenájdený alebo nie ste autor' });
    }

    // If status was 'commented' and no comments remain, revert to 'pending'.
    // Use conditional update — only fires if condition is met, no re-save.
    await Message.updateOne(
      {
        _id: req.params.id,
        status: 'commented',
        comments: { $size: 0 }
      },
      { $set: { status: 'pending' } }
    );

    // Fetch minimal metadata for response + socket (no Base64).
    const updated = await Message.findById(req.params.id, NO_BASE64_PROJECTION).lean();

    const notifyUserId = updated.fromUserId.toString() === req.user.id.toString()
      ? updated.toUserId.toString()
      : updated.fromUserId.toString();

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${notifyUserId}`).emit('message-updated', {
        id: updated._id.toString(),
        status: updated.status
      });
    }

    res.json(stripAttachmentData(updated));
  } catch (error) {
    logger.error('Delete comment error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/:id/attachment — download attachment
router.get('/:id/attachment', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // PERF: early 304 short-circuit — if browser already has this blob
    // cached (immutable files, deterministic ETag), skip Mongo + Node
    // buffer allocation + network transfer entirely. Repeat preview = instant.
    const etag = `"msg-${req.params.id}-attach"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // PERF: project only the main attachment — do NOT pull comments[].attachment.data
    // or files[].data. A message with 5 other 10 MB attachments was previously
    // shipping 50+ MB from Mongo just to return one file.
    const message = await Message.findOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ]
      },
      { attachment: 1 }
    ).lean();

    if (!message || !message.attachment || !message.attachment.data) {
      return res.status(404).json({ message: 'Príloha nenájdená' });
    }

    const fileBuffer = Buffer.from(message.attachment.data, 'base64');
    res.set({
      'Content-Type': message.attachment.mimetype,
      'Content-Disposition': `inline; filename="${encodeURIComponent(message.attachment.originalName)}"`,
      'Content-Length': fileBuffer.length,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'ETag': etag
    });
    res.send(fileBuffer);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/messages/:id/comment/:commentId/attachment — download comment attachment
router.get('/:id/comment/:commentId/attachment', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const etag = `"cmt-${req.params.commentId}-attach"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // PERF: $elemMatch projection returns ONLY the matching comment, not
    // the whole comments array. Main attachment + files are excluded entirely.
    const message = await Message.findOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ]
      },
      { comments: { $elemMatch: { _id: req.params.commentId } } }
    ).lean();

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený' });
    }

    const comment = message.comments && message.comments[0];
    if (!comment || !comment.attachment || !comment.attachment.data) {
      return res.status(404).json({ message: 'Príloha nenájdená' });
    }

    const fileBuffer = Buffer.from(comment.attachment.data, 'base64');
    res.set({
      'Content-Type': comment.attachment.mimetype,
      'Content-Disposition': `inline; filename="${encodeURIComponent(comment.attachment.originalName)}"`,
      'Content-Length': fileBuffer.length,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'ETag': etag
    });
    res.send(fileBuffer);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// ─── FILE ATTACHMENTS (same pattern as Tasks) ─────────────────

// POST /api/messages/:id/files — add file to message
router.post('/:id/files', authenticateToken, requireWorkspace, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    if (!req.file) return res.status(400).json({ message: 'Žiadny súbor' });

    try {
      const message = await Message.findOne({
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [{ fromUserId: req.user.id }, { toUserId: req.user.id }]
      });
      if (!message) return res.status(404).json({ message: 'Odkaz nenájdený' });

      const { v4: uuidv4 } = require('uuid');
      message.files.push({
        id: uuidv4(),
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        data: req.file.buffer.toString('base64'),
        uploadedAt: new Date()
      });

      await message.save();
      res.json(stripAttachmentData(message));
    } catch (error) {
      res.status(500).json({ message: 'Chyba servera' });
    }
  });
});

// GET /api/messages/:id/files/:fileId/download — download file
router.get('/:id/files/:fileId/download', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const etag = `"file-${req.params.fileId}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // PERF: $elemMatch projection — return only the matching file, not
    // the whole files array nor any comment attachments.
    const message = await Message.findOne(
      {
        _id: req.params.id,
        workspaceId: req.workspaceId,
        $or: [{ fromUserId: req.user.id }, { toUserId: req.user.id }]
      },
      { files: { $elemMatch: { id: req.params.fileId } } }
    ).lean();
    if (!message) return res.status(404).json({ message: 'Odkaz nenájdený' });

    const file = message.files && message.files[0];
    if (!file || !file.data) return res.status(404).json({ message: 'Súbor nenájdený' });

    const buffer = Buffer.from(file.data, 'base64');
    res.set({
      'Content-Type': file.mimetype,
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.originalName)}"`,
      'Content-Length': buffer.length,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'ETag': etag
    });
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// DELETE /api/messages/:id/files/:fileId — delete file from message
router.delete('/:id/files/:fileId', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
      $or: [{ fromUserId: req.user.id }, { toUserId: req.user.id }]
    });
    if (!message) return res.status(404).json({ message: 'Odkaz nenájdený' });

    message.files = message.files.filter(f => f.id !== req.params.fileId);
    await message.save();
    res.json(stripAttachmentData(message));
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// DELETE /api/messages/:id — sender or workspace owner/manager can delete
router.delete('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId
    });

    if (!message) {
      return res.status(404).json({ message: 'Odkaz nenájdený' });
    }

    const isSender = message.fromUserId.toString() === req.user.id;
    const isAdmin = req.workspaceMember.canAdmin();

    if (!isSender && !isAdmin) {
      return res.status(403).json({ message: 'Nemáte oprávnenie vymazať tento odkaz' });
    }

    await Message.deleteOne({ _id: req.params.id });

    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.toUserId.toString()}`).emit('message-deleted', {
        id: req.params.id
      });
      if (!isSender) {
        io.to(`user-${message.fromUserId.toString()}`).emit('message-deleted', {
          id: req.params.id
        });
      }
    }

    res.json({ message: 'Odkaz bol vymazaný' });
  } catch (error) {
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
