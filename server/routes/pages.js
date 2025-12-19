const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all pages for user
router.get('/', authenticateToken, (req, res) => {
  try {
    const pages = db.pages.findByUser(req.user.id);
    res.json(pages);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get single page
router.get('/:id', authenticateToken, (req, res) => {
  try {
    const page = db.pages.findById(req.params.id);

    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    // Check access
    if (page.ownerId !== req.user.id && !page.sharedWith.includes(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(page);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create page
router.post('/', authenticateToken, (req, res) => {
  try {
    const { title, icon, parentId } = req.body;

    // Get all users except current user for sharing
    const allUsers = db.users.findAll();
    const otherUserIds = allUsers
      .filter(u => u.id !== req.user.id)
      .map(u => u.id);

    const page = db.pages.create({
      title: title || 'Untitled',
      icon: icon || '📄',
      ownerId: req.user.id,
      ownerName: req.user.username,
      parentId: parentId || null,
      sharedWith: otherUserIds, // Share with all other users by default
      blocks: [
        {
          id: uuidv4(),
          type: 'paragraph',
          content: ''
        }
      ]
    });

    // Emit to socket
    const io = req.app.get('io');
    io.emit('page-created', page);

    res.status(201).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update page
router.put('/:id', authenticateToken, (req, res) => {
  try {
    const page = db.pages.findById(req.params.id);

    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    // Check access
    if (page.ownerId !== req.user.id && !page.sharedWith.includes(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { title, icon, blocks, sharedWith } = req.body;
    const updates = {};

    if (title !== undefined) updates.title = title;
    if (icon !== undefined) updates.icon = icon;
    if (blocks !== undefined) updates.blocks = blocks;
    if (sharedWith !== undefined) updates.sharedWith = sharedWith;

    const updatedPage = db.pages.update(req.params.id, updates);

    res.json(updatedPage);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete page
router.delete('/:id', authenticateToken, (req, res) => {
  try {
    const page = db.pages.findById(req.params.id);

    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    // Only owner can delete
    if (page.ownerId !== req.user.id) {
      return res.status(403).json({ message: 'Only owner can delete page' });
    }

    db.pages.delete(req.params.id);

    // Emit to socket
    const io = req.app.get('io');
    io.emit('page-deleted', { pageId: req.params.id });

    res.json({ message: 'Page deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Add block to page
router.post('/:id/blocks', authenticateToken, (req, res) => {
  try {
    const page = db.pages.findById(req.params.id);

    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    if (page.ownerId !== req.user.id && !page.sharedWith.includes(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { type, content, afterBlockId } = req.body;
    const newBlock = {
      id: uuidv4(),
      type: type || 'paragraph',
      content: content || ''
    };

    const blocks = [...page.blocks];
    if (afterBlockId) {
      const index = blocks.findIndex(b => b.id === afterBlockId);
      if (index !== -1) {
        blocks.splice(index + 1, 0, newBlock);
      } else {
        blocks.push(newBlock);
      }
    } else {
      blocks.push(newBlock);
    }

    const updatedPage = db.pages.update(req.params.id, { blocks });

    res.status(201).json(newBlock);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update block
router.put('/:pageId/blocks/:blockId', authenticateToken, (req, res) => {
  try {
    const page = db.pages.findById(req.params.pageId);

    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    if (page.ownerId !== req.user.id && !page.sharedWith.includes(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { type, content } = req.body;
    const blocks = page.blocks.map(b => {
      if (b.id === req.params.blockId) {
        return {
          ...b,
          type: type !== undefined ? type : b.type,
          content: content !== undefined ? content : b.content
        };
      }
      return b;
    });

    const updatedPage = db.pages.update(req.params.pageId, { blocks });
    const updatedBlock = updatedPage.blocks.find(b => b.id === req.params.blockId);

    res.json(updatedBlock);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete block
router.delete('/:pageId/blocks/:blockId', authenticateToken, (req, res) => {
  try {
    const page = db.pages.findById(req.params.pageId);

    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    if (page.ownerId !== req.user.id && !page.sharedWith.includes(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const blocks = page.blocks.filter(b => b.id !== req.params.blockId);

    // Ensure at least one block exists
    if (blocks.length === 0) {
      blocks.push({
        id: uuidv4(),
        type: 'paragraph',
        content: ''
      });
    }

    db.pages.update(req.params.pageId, { blocks });

    res.json({ message: 'Block deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
