const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// GET /api/saved — قائمة المنتجات المحفوظة (المعتمدة فقط) للمستخدم الحالي
router.get('/', auth(['buyer']), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sp.product_id, sp.created_at AS saved_at,
              v.*, s.logo_url AS seller_logo_url,
              p.stock_qty, p.in_stock,
              COALESCE((SELECT image_url FROM product_images WHERE product_id = v.id AND is_primary=true LIMIT 1), v.image_url) AS product_image
       FROM saved_products sp
       JOIN v_products_full v ON v.id = sp.product_id
       LEFT JOIN products p ON p.id = v.id
       LEFT JOIN sellers  s ON s.id = v.seller_id
       WHERE sp.user_id = $1 AND p.approval_status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND c.status = 'inactive')
       ORDER BY sp.created_at DESC`,
      [req.user.id]
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// GET /api/saved/ids — قائمة خفيفة بمعرّفات المنتجات المحفوظة (لحالة زر القلب)
router.get('/ids', auth(['buyer']), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT product_id FROM saved_products WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ ids: result.rows.map(r => r.product_id) });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/saved { product_id } — حفظ منتج
router.post('/', auth(['buyer']), async (req, res) => {
  try {
    const { product_id } = req.body;
    if (!product_id) return res.status(400).json({ error: 'معرّف المنتج مطلوب' });
    await db.query(
      `INSERT INTO saved_products (user_id, product_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, product_id) DO NOTHING`,
      [req.user.id, product_id]
    );
    res.json({ saved: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// DELETE /api/saved/:product_id — إزالة منتج من المحفوظات
router.delete('/:product_id', auth(['buyer']), async (req, res) => {
  try {
    await db.query(
      'DELETE FROM saved_products WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.product_id]
    );
    res.json({ saved: false });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
