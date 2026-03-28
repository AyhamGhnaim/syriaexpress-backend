const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// GET /api/notifications
router.get('/', auth(), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',
      [req.user.id]
    );
    const unread = result.rows.filter(n => !n.is_read).length;
    res.json({ notifications: result.rows, unread });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', auth(), async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read=true WHERE user_id=$1', [req.user.id]);
    res.json({ message: 'تم تحديد الكل كمقروء' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', auth(), async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ message: 'تم' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
