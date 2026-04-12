const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const Page = require('../models/Page');
const logger = require('../utils/logger');

const router = express.Router();

// Validate MongoDB ObjectId format
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

// Get all pages for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pages = await Page.find({ userId: req.user.id });
    res.json(pages);
  } catch (error) {
    logger.error('GET /pages error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Get single page
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Neplatné ID stránky' });
    }

    const page = await Page.findOne({ _id: req.params.id, userId: req.user.id });

    if (!page) {
      return res.status(404).json({ message: 'Stránka nenájdená' });
    }

    res.json(page);
  } catch (error) {
    logger.error('GET /pages/:id error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Create page
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, icon, parentId, content } = req.body;

    if (parentId) {
      if (!isValidObjectId(parentId)) {
        return res.status(400).json({ message: 'Neplatné ID rodičovskej stránky' });
      }
      const parentPage = await Page.findOne({ _id: parentId, userId: req.user.id });
      if (!parentPage) {
        return res.status(404).json({ message: 'Rodičovská stránka nenájdená' });
      }
    }

    const page = new Page({
      userId: req.user.id,
      title: title ? String(title).substring(0, 500) : 'Untitled',
      icon: icon || null,
      parentId: parentId || null,
      content: content ? String(content).substring(0, 500000) : ''
    });

    await page.save();

    const io = req.app.get('io');
    io.to(`user-${req.user.id}`).emit('page-created', page);

    res.status(201).json(page);
  } catch (error) {
    logger.error('POST /pages error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Update page
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Neplatné ID stránky' });
    }

    const page = await Page.findOne({ _id: req.params.id, userId: req.user.id });

    if (!page) {
      return res.status(404).json({ message: 'Stránka nenájdená' });
    }

    const { title, icon, content, parentId } = req.body;

    if (title !== undefined) page.title = String(title).substring(0, 500);
    if (icon !== undefined) page.icon = icon;
    if (content !== undefined) page.content = String(content).substring(0, 500000);
    if (parentId !== undefined) page.parentId = parentId;

    await page.save();

    const io = req.app.get('io');
    io.to(`user-${req.user.id}`).emit('page-updated', page);

    res.json(page);
  } catch (error) {
    logger.error('PUT /pages/:id error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// Delete page
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Neplatné ID stránky' });
    }

    const page = await Page.findOne({ _id: req.params.id, userId: req.user.id });

    if (!page) {
      return res.status(404).json({ message: 'Stránka nenájdená' });
    }

    const deleteChildren = async (parentId) => {
      const children = await Page.find({ parentId, userId: req.user.id });
      for (const child of children) {
        await deleteChildren(child._id);
        await Page.findByIdAndDelete(child._id);
      }
    };

    await deleteChildren(req.params.id);
    await Page.findByIdAndDelete(req.params.id);

    const io = req.app.get('io');
    io.to(`user-${req.user.id}`).emit('page-deleted', { pageId: req.params.id });

    res.json({ message: 'Stránka bola vymazaná' });
  } catch (error) {
    logger.error('DELETE /pages/:id error', { error: error.message, userId: req.user.id });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
