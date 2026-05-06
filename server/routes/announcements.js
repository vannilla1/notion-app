const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const announcementsService = require('../services/announcementsService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/announcements/active
 * Vráti zoznam announcementov ktoré má prihlásený user aktuálne vidieť.
 * Frontend ich rendruje ako pill v hlavičke + modal pri kliknutí.
 */
router.get('/active', authenticateToken, async (req, res) => {
  try {
    const list = await announcementsService.getActiveAnnouncementsForUser(req.user.id);
    res.json({ announcements: list });
  } catch (err) {
    logger.error('Get active announcements error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

/**
 * POST /api/announcements/:id/dismiss
 * Manuálny dismiss — user klikol ✕ na banneri. Uloží timestamp do
 * user.preferences.dismissedAnnouncements[<id>]. Pri budúcom GET /active
 * sa už nezobrazí.
 */
router.post('/:id/dismiss', authenticateToken, async (req, res) => {
  try {
    const result = await announcementsService.dismissAnnouncement(req.user.id, req.params.id);
    if (!result.ok) return res.status(400).json({ message: result.error });
    res.json({ success: true });
  } catch (err) {
    logger.error('Dismiss announcement error', { error: err.message });
    res.status(500).json({ message: 'Chyba servera' });
  }
});

module.exports = router;
