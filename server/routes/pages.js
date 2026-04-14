const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireWorkspace } = require('../middleware/workspace');
const Page = require('../models/Page');
const logger = require('../utils/logger');

const router = express.Router();

// Validate MongoDB ObjectId format
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

// All page routes are scoped to the caller's active workspace.
// `requireWorkspace` middleware:
//   - 401 if not authenticated (applied before)
//   - 403 if the user is not a member of their active workspace
//   - populates req.workspaceId with the active workspace ObjectId
// Every query below filters by `workspaceId: req.workspaceId`, so cross-
// workspace access is impossible even if a user guesses a page _id.

// GET /api/pages — list all pages in the active workspace
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const pages = await Page.find({ workspaceId: req.workspaceId }).sort({ updatedAt: -1 });
    res.json(pages);
  } catch (error) {
    logger.error('GET /pages error', { error: error.message, userId: req.user.id, workspaceId: req.workspaceId });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// GET /api/pages/:id — single page (must be in active workspace)
router.get('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Neplatné ID stránky' });
    }

    const page = await Page.findOne({ _id: req.params.id, workspaceId: req.workspaceId });

    if (!page) {
      return res.status(404).json({ message: 'Stránka nenájdená' });
    }

    res.json(page);
  } catch (error) {
    logger.error('GET /pages/:id error', { error: error.message, userId: req.user.id, workspaceId: req.workspaceId });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// POST /api/pages — create a page in the active workspace
router.post('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { title, icon, parentId, content } = req.body;

    if (parentId) {
      if (!isValidObjectId(parentId)) {
        return res.status(400).json({ message: 'Neplatné ID rodičovskej stránky' });
      }
      // Parent must live in the SAME workspace. Prevents cross-workspace
      // nesting even if a user guesses another workspace's page _id.
      const parentPage = await Page.findOne({ _id: parentId, workspaceId: req.workspaceId });
      if (!parentPage) {
        return res.status(404).json({ message: 'Rodičovská stránka nenájdená' });
      }
    }

    const page = new Page({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      title: title ? String(title).substring(0, 500) : 'Untitled',
      icon: icon || null,
      parentId: parentId || null,
      content: content ? String(content).substring(0, 500000) : ''
    });

    await page.save();

    // Broadcast to the whole workspace room so every member's client updates,
    // not just the author (it's a collaborative workspace resource).
    const io = req.app.get('io');
    if (io) io.to(`workspace-${req.workspaceId}`).emit('page-created', page);

    res.status(201).json(page);
  } catch (error) {
    logger.error('POST /pages error', { error: error.message, userId: req.user.id, workspaceId: req.workspaceId });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// PUT /api/pages/:id — update page (any workspace member can edit)
router.put('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Neplatné ID stránky' });
    }

    const page = await Page.findOne({ _id: req.params.id, workspaceId: req.workspaceId });

    if (!page) {
      return res.status(404).json({ message: 'Stránka nenájdená' });
    }

    const { title, icon, content, parentId } = req.body;

    if (title !== undefined) page.title = String(title).substring(0, 500);
    if (icon !== undefined) page.icon = icon;
    if (content !== undefined) page.content = String(content).substring(0, 500000);
    if (parentId !== undefined) {
      if (parentId === null) {
        page.parentId = null;
      } else {
        if (!isValidObjectId(parentId)) {
          return res.status(400).json({ message: 'Neplatné ID rodičovskej stránky' });
        }
        // Reparent must stay inside the same workspace.
        const parentPage = await Page.findOne({ _id: parentId, workspaceId: req.workspaceId });
        if (!parentPage) {
          return res.status(404).json({ message: 'Rodičovská stránka nenájdená' });
        }
        page.parentId = parentId;
      }
    }

    await page.save();

    const io = req.app.get('io');
    if (io) io.to(`workspace-${req.workspaceId}`).emit('page-updated', page);

    res.json(page);
  } catch (error) {
    logger.error('PUT /pages/:id error', { error: error.message, userId: req.user.id, workspaceId: req.workspaceId });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

// DELETE /api/pages/:id — delete page + its subtree (scoped to workspace)
router.delete('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Neplatné ID stránky' });
    }

    const page = await Page.findOne({ _id: req.params.id, workspaceId: req.workspaceId });

    if (!page) {
      return res.status(404).json({ message: 'Stránka nenájdená' });
    }

    // Recursively delete descendants — children are also filtered by the same
    // workspace so we never accidentally touch another workspace's data.
    const deleteChildren = async (parentId) => {
      const children = await Page.find({ parentId, workspaceId: req.workspaceId });
      for (const child of children) {
        await deleteChildren(child._id);
        await Page.findByIdAndDelete(child._id);
      }
    };

    await deleteChildren(req.params.id);
    await Page.findByIdAndDelete(req.params.id);

    const io = req.app.get('io');
    if (io) io.to(`workspace-${req.workspaceId}`).emit('page-deleted', { pageId: req.params.id });

    res.json({ message: 'Stránka bola vymazaná' });
  } catch (error) {
    logger.error('DELETE /pages/:id error', { error: error.message, userId: req.user.id, workspaceId: req.workspaceId });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
