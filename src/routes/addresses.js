const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// GET /api/addresses — عناوين المشتري الحالي
router.get('/', auth(['buyer']), async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM buyer_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
      [req.user.id]
    );
    res.json({ addresses: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

// POST /api/addresses — إضافة عنوان
router.post('/', auth(['buyer']), async (req, res) => {
  try {
    const { label, governorate, address, phone, is_default } = req.body;
    if (!address) return res.status(400).json({ error: 'العنوان مطلوب' });
    if (is_default) await db.query('UPDATE buyer_addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    const r = await db.query(
      `INSERT INTO buyer_addresses (user_id, label, governorate, address, phone, is_default)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, label || null, governorate || null, address, phone || null, !!is_default]
    );
    res.json({ address: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

// PATCH /api/addresses/:id — تعديل / تعيين افتراضي
router.patch('/:id', auth(['buyer']), async (req, res) => {
  try {
    const { label, governorate, address, phone, is_default } = req.body;
    const own = await db.query('SELECT id FROM buyer_addresses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'العنوان غير موجود' });
    if (is_default === true) await db.query('UPDATE buyer_addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    const r = await db.query(
      `UPDATE buyer_addresses SET
         label       = COALESCE($2, label),
         governorate = COALESCE($3, governorate),
         address     = COALESCE($4, address),
         phone       = COALESCE($5, phone),
         is_default  = COALESCE($6, is_default)
       WHERE id = $1 AND user_id = $7 RETURNING *`,
      [req.params.id, label ?? null, governorate ?? null, address ?? null, phone ?? null,
       (typeof is_default === 'boolean' ? is_default : null), req.user.id]
    );
    res.json({ address: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

// DELETE /api/addresses/:id — حذف عنوان
router.delete('/:id', auth(['buyer']), async (req, res) => {
  try {
    await db.query('DELETE FROM buyer_addresses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

module.exports = router;
