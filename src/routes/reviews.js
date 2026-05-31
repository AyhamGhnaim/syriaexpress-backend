const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// ─── POST /api/reviews — إنشاء تقييم (مشترٍ، بعد التسليم فقط) ───
router.post('/', auth(['buyer']), async (req, res) => {
  const { order_id, rating, comment } = req.body;
  const r = parseInt(rating);
  if (!order_id) return res.status(400).json({ error: 'رقم الطلب مطلوب' });
  if (!(r >= 1 && r <= 5)) return res.status(400).json({ error: 'التقييم يجب أن يكون بين 1 و 5' });

  try {
    // الطلب يخصّ المشتري وبحالة مُسلَّم
    const ord = await db.query(
      'SELECT id, seller_id, product_id, status FROM orders WHERE id = $1 AND buyer_id = $2',
      [order_id, req.user.id]
    );
    if (!ord.rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });
    const o = ord.rows[0];
    if (o.status !== 'delivered')
      return res.status(400).json({ error: 'يمكنك التقييم بعد تسلّم الطلب فقط' });

    // تقييم واحد لكل طلب
    const exists = await db.query('SELECT id FROM reviews WHERE order_id = $1', [order_id]);
    if (exists.rows.length) return res.status(400).json({ error: 'تم تقييم هذا الطلب مسبقاً' });

    await db.query(
      `INSERT INTO reviews (buyer_id, seller_id, product_id, order_id, rating, comment)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.id, o.seller_id, o.product_id, order_id, r, (comment || '').trim() || null]
    );

    // إعادة حساب متوسط تقييم البائع
    try {
      await db.query(
        `UPDATE sellers SET avg_rating = (
           SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews
           WHERE seller_id = $1 AND rating IS NOT NULL
         ) WHERE id = $1`,
        [o.seller_id]
      );
    } catch (e) { /* avg_rating قد يكون محسوباً في الـ view */ }

    // إشعار البائع
    try {
      await db.query(
        `INSERT INTO notifications (user_id, type, title_ar, body_ar, ref_type, ref_id)
         SELECT s.user_id, 'new_review', 'تقييم جديد', $1, 'order', $2
         FROM sellers s WHERE s.id = $3`,
        [`حصلت على تقييم ${r} نجوم`, order_id, o.seller_id]
      );
    } catch (e) { /* الإشعارات اختيارية */ }

    res.status(201).json({ message: 'تم إرسال تقييمك، شكراً لك' });
  } catch (err) {
    console.error('POST /reviews', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── GET /api/reviews/seller/:id — قائمة تقييمات بائع (عام) ───
router.get('/seller/:id', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, u.name as buyer_name
       FROM reviews r JOIN users u ON r.buyer_id = u.id
       WHERE r.seller_id = $1 AND r.rating IS NOT NULL
       ORDER BY r.created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ reviews: rows.rows });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
