const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const Page = require('../models/Page');

const router = express.Router();

// Get all pages for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pages = await Page.find({ userId: req.user.id });
    res.json(pages);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get single page
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const page = await Page.findById(req.params.id);

    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    // Check access - for now all users can access all pages
    res.json(page);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create page
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, icon, parentId, content } = req.body;

    const page = new Page({
      userId: req.user.id,
      title: title || 'Untitled',
      icon: icon || null,
      parentId: parentId || null,
      content: content || ''
    });

    await page.save();

    // Emit to socket
    const io = req.app.get('io');
    io.emit('page-created', page);

    res.status(201).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update page
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const page = await Page.findById(req.params.id);

    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    const { title, icon, content, parentId } = req.body;

    if (title !== undefined) page.title = title;
    if (icon !== undefined) page.icon = icon;
    if (content !== undefined) page.content = content;
    if (parentId !== undefined) page.parentId = parentId;

    await page.save();

    // Emit to socket
    const io = req.app.get('io');
    io.emit('page-updated', page);

    res.json(page);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete page
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const page = await Page.findById(req.params.id);

    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    // Delete all child pages recursively
    const deleteChildren = async (parentId) => {
      const children = await Page.find({ parentId });
      for (const child of children) {
        await deleteChildren(child._id);
        await Page.findByIdAndDelete(child._id);
      }
    };

    await deleteChildren(req.params.id);
    await Page.findByIdAndDelete(req.params.id);

    // Emit to socket
    const io = req.app.get('io');
    io.emit('page-deleted', { pageId: req.params.id });

    res.json({ message: 'Page deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
