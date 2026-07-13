const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

async function sellerIdOf(userId) {
  const r = await db.query('SELECT id FROM sellers WHERE user_id = $1', [userId]);
  return r.rows.length ? r.rows[0].id : null;
}

// ─── GET /api/coupons/mine — كوبونات البائع ───
router.get('/mine', auth(['seller']), async (req, res) => {
  try {
    const sid = await sellerIdOf(req.user.id);
    if (!sid) return res.status(403).json({ error: 'غير مصرح' });
    const r = await db.query('SELECT * FROM coupons WHERE seller_id = $1 ORDER BY created_at DESC', [sid]);
    res.json({ coupons: r.rows });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

// ─── POST /api/coupons — إنشاء كوبون ───
router.post('/', auth(['seller']), async (req, res) => {
  try {
    const sid = await sellerIdOf(req.user.id);
    if (!sid) return res.status(403).json({ error: 'غير مصرح' });
    let { code, discount_type, value, min_total, expires_at } = req.body;
    code = (code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'أدخل رمز الكوبون' });
    if (!['percent', 'fixed'].includes(discount_type))
      return res.status(400).json({ error: 'نوع الخصم غير صحيح' });
    const v = parseFloat(value);
    if (!(v > 0)) return res.status(400).json({ error: 'قيمة الخصم يجب أن تكون أكبر من صفر' });
    if (discount_type === 'percent' && v > 100)
      return res.status(400).json({ error: 'نسبة الخصم لا تتجاوز 100%' });

    const r = await db.query(
      `INSERT INTO coupons (seller_id, code, discount_type, value, min_total, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [sid, code, discount_type, v, parseFloat(min_total) || 0, expires_at || null]
    );
    res.status(201).json({ message: 'تم إنشاء الكوبون', coupon: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'هذا الرمز مستخدم مسبقاً' });
    console.error('POST /coupons', e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── PATCH /api/coupons/:id — تعديل/تفعيل/تعطيل ───
router.patch('/:id', auth(['seller']), async (req, res) => {
  try {
    const sid = await sellerIdOf(req.user.id);
    if (!sid) return res.status(403).json({ error: 'غير مصرح' });
    const fields = ['active', 'value', 'min_total', 'expires_at', 'discount_type'];

    // تحقّق مطابق لـ POST — كان PATCH يقبل أي discount_type، وأي قيمة غير 'percent'
    // تُعامَل عند الطلب كخصم ثابت.
    const dt = req.body.discount_type;
    if (dt !== undefined && !['percent', 'fixed'].includes(dt))
      return res.status(400).json({ error: 'نوع الخصم غير صحيح' });

    if (req.body.value !== undefined) {
      const v = parseFloat(req.body.value);
      if (!(v > 0)) return res.status(400).json({ error: 'قيمة الخصم يجب أن تكون أكبر من صفر' });
      // النوع الفعّال بعد التعديل: الوارد إن وُجد، وإلا النوع الحالي للكوبون
      // (وإلا تمرّ نسبة 150% عند إرسال value وحدها على كوبون percent).
      let effType = dt;
      if (effType === undefined) {
        const cur = await db.query(
          'SELECT discount_type FROM coupons WHERE id = $1 AND seller_id = $2', [req.params.id, sid]
        );
        if (!cur.rows.length) return res.status(404).json({ error: 'الكوبون غير موجود' });
        effType = cur.rows[0].discount_type;
      }
      if (effType === 'percent' && v > 100)
        return res.status(400).json({ error: 'نسبة الخصم لا تتجاوز 100%' });
    }

    const updates = [], values = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) { values.push(req.body[f] === '' ? null : req.body[f]); updates.push(`${f} = $${values.length}`); }
    });
    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    values.push(req.params.id, sid);
    const r = await db.query(
      `UPDATE coupons SET ${updates.join(',')} WHERE id = $${values.length-1} AND seller_id = $${values.length} RETURNING *`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'الكوبون غير موجود' });
    res.json({ message: 'تم التحديث', coupon: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

// ─── DELETE /api/coupons/:id ───
router.delete('/:id', auth(['seller']), async (req, res) => {
  try {
    const sid = await sellerIdOf(req.user.id);
    if (!sid) return res.status(403).json({ error: 'غير مصرح' });
    const r = await db.query('DELETE FROM coupons WHERE id = $1 AND seller_id = $2 RETURNING id', [req.params.id, sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'الكوبون غير موجود' });
    res.json({ message: 'تم حذف الكوبون' });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

// ─── POST /api/coupons/validate — تحقّق من كوبون (مشترٍ) ───
// body: { code, seller_id } → يعيد معاملات الكوبون إن كان صالحاً (الواجهة تحسب الخصم لكل سطر)
router.post('/validate', auth(['buyer']), async (req, res) => {
  try {
    const { code, seller_id } = req.body;
    if (!code || !seller_id) return res.status(400).json({ error: 'بيانات ناقصة' });
    const r = await db.query(
      `SELECT discount_type, value, min_total, expires_at, active
       FROM coupons
       WHERE seller_id = $1 AND lower(code) = lower($2)`,
      [seller_id, code.trim()]
    );
    if (!r.rows.length) return res.status(404).json({ valid: false, error: 'كوبون غير موجود' });
    const c = r.rows[0];
    if (!c.active) return res.status(400).json({ valid: false, error: 'هذا الكوبون غير مفعّل' });
    if (c.expires_at && new Date(c.expires_at) < new Date())
      return res.status(400).json({ valid: false, error: 'انتهت صلاحية الكوبون' });
    res.json({
      valid: true,
      code: code.trim().toUpperCase(),
      discount_type: c.discount_type,
      value: parseFloat(c.value),
      min_total: parseFloat(c.min_total) || 0
    });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

module.exports = router;
