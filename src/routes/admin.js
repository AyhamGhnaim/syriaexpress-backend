const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// All admin routes require admin role
router.use(auth(['admin']));

// ─── Dashboard overview ──────────────────────────────────
// GET /api/admin/overview
router.get('/overview', async (req, res) => {
  try {
    const [users, sellers, orders, pending] = await Promise.all([
      db.query("SELECT COUNT(*) FROM users WHERE user_type='buyer'"),
      db.query("SELECT COUNT(*) FROM sellers WHERE verification_status='verified'"),
      db.query("SELECT COUNT(*) FROM orders"),
      db.query("SELECT COUNT(*) FROM verification_requests WHERE status='pending'")
    ]);

    const recentOrders = await db.query(
      `SELECT o.id, o.status, o.quantity, o.created_at,
              p.name_ar, s.company_name_ar, u.name as buyer_name
       FROM orders o
       JOIN products p ON o.product_id=p.id
       JOIN sellers  s ON o.seller_id=s.id
       JOIN users    u ON o.buyer_id=u.id
       ORDER BY o.created_at DESC LIMIT 10`
    );

    res.json({
      stats: {
        buyers:          parseInt(users.rows[0].count),
        verified_sellers:parseInt(sellers.rows[0].count),
        total_orders:    parseInt(orders.rows[0].count),
        pending_verif:   parseInt(pending.rows[0].count)
      },
      recentOrders: recentOrders.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Verification requests ───────────────────────────────
// GET /api/admin/verifications
router.get('/verifications', async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const result = await db.query(
      `SELECT vr.*, s.company_name_ar, s.company_name_en, s.activity_type,
              s.governorate, u.name as owner_name, u.email as owner_email, u.phone as owner_phone,
              json_agg(json_build_object('type',sd.doc_type,'name',sd.doc_name,'url',sd.file_url)) as documents
       FROM verification_requests vr
       JOIN sellers s ON vr.seller_id = s.id
       JOIN users   u ON s.user_id = u.id
       LEFT JOIN seller_documents sd ON sd.seller_id = s.id
       WHERE vr.status = $1
       GROUP BY vr.id, s.company_name_ar, s.company_name_en, s.activity_type,
                s.governorate, u.name, u.email, u.phone
       ORDER BY vr.created_at ASC`,
      [status]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Approve / Reject verification ──────────────────────
// PATCH /api/admin/verifications/:id
router.patch('/verifications/:id', async (req, res) => {
  const { action, admin_notes, partner_tier } = req.body;
  if (!['approved','rejected','needs_revision'].includes(action))
    return res.status(400).json({ error: 'إجراء غير صحيح' });

  try {
    // Update verification request
    const vr = await db.query(
      `UPDATE verification_requests
       SET status=$1, admin_notes=$2, reviewed_by=$3, reviewed_at=NOW()
       WHERE id=$4 RETURNING seller_id`,
      [action, admin_notes, req.user.id, req.params.id]
    );
    if (!vr.rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    // Update seller status
    if (action === 'approved') {
      await db.query(
        `UPDATE sellers SET verification_status='verified', partner_tier=$1,
         verified_at=NOW(), verified_by=$2 WHERE id=$3`,
        [partner_tier || 'none', req.user.id, vr.rows[0].seller_id]
      );
    } else if (action === 'rejected') {
      await db.query(
        "UPDATE sellers SET verification_status='rejected' WHERE id=$1",
        [vr.rows[0].seller_id]
      );
    }

    // Notify seller
    const msg = action === 'approved' ? 'تم قبول توثيق حسابك' :
                action === 'rejected' ? 'تم رفض طلب التوثيق' : 'يرجى مراجعة وثائقك';
    await db.query(
      `INSERT INTO notifications(user_id,type,title_ar,body_ar,ref_type,ref_id)
       SELECT s.user_id,$1,$2,$3,'verification',$4 FROM sellers s WHERE s.id=$5`,
      ['verification_update', msg, admin_notes || msg, req.params.id, vr.rows[0].seller_id]
    );

    res.json({ message: 'تم تحديث حالة التوثيق' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Users management ────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { type, search, page = 1, limit = 20 } = req.query;
    const params = [];
    const where  = [];

    if (type)   { params.push(type);        where.push(`user_type = $${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`); }

    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(limit, (page-1)*limit);

    const result = await db.query(
      `SELECT u.id,u.name,u.email,u.phone,u.user_type,u.governorate,u.is_active,u.created_at,u.avatar_url,
              s.verification_status
       FROM users u
       LEFT JOIN sellers s ON s.user_id = u.id
       ${w} ORDER BY u.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Change user type ────────────────────────────────────
// PATCH /api/admin/users/:id
router.patch('/users/:id', async (req, res) => {
  try {
    const { user_type } = req.body;
    if (!['buyer','seller','admin'].includes(user_type))
      return res.status(400).json({ error: 'نوع مستخدم غير صحيح' });
    await db.query('UPDATE users SET user_type=$1 WHERE id=$2', [user_type, req.params.id]);
    res.json({ message: 'تم تغيير نوع المستخدم' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Suspend / Activate user ─────────────────────────────
router.patch('/users/:id/status', async (req, res) => {
  try {
    const { is_active } = req.body;
    await db.query('UPDATE users SET is_active=$1 WHERE id=$2', [is_active, req.params.id]);
    res.json({ message: is_active ? 'تم تفعيل الحساب' : 'تم تعليق الحساب' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Analytics ───────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const [ordersByStatus, ordersByGov, ordersByShipping, topSellers, monthlyOrders] = await Promise.all([
      db.query(`SELECT status, COUNT(*) as count FROM orders GROUP BY status`),
      db.query(`SELECT u.governorate, COUNT(o.id) as orders
                FROM orders o JOIN users u ON o.buyer_id=u.id
                GROUP BY u.governorate ORDER BY orders DESC LIMIT 10`),
      db.query(`SELECT shipping_type, COUNT(*) as count FROM orders GROUP BY shipping_type`),
      db.query(`SELECT s.company_name_ar, s.partner_tier, COUNT(o.id) as orders
                FROM sellers s LEFT JOIN orders o ON o.seller_id=s.id
                GROUP BY s.id, s.company_name_ar, s.partner_tier
                ORDER BY orders DESC LIMIT 10`),
      db.query(`SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) as orders
                FROM orders WHERE created_at >= NOW() - INTERVAL '6 months'
                GROUP BY month ORDER BY month`)
    ]);

    res.json({
      byStatus:    ordersByStatus.rows,
      byGov:       ordersByGov.rows,
      byShipping:  ordersByShipping.rows,
      topSellers:  topSellers.rows,
      monthly:     monthlyOrders.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Platform settings ───────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM platform_settings ORDER BY key');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/settings/:key', async (req, res) => {
  try {
    const { value } = req.body;
    await db.query(
      'UPDATE platform_settings SET value=$1, updated_by=$2, updated_at=NOW() WHERE key=$3',
      [value, req.user.id, req.params.key]
    );
    res.json({ message: 'تم تحديث الإعداد' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Categories management ───────────────────────────────

// GET /api/admin/categories
router.get('/categories', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name_ar, name_en, status, icon, sort_order
       FROM categories ORDER BY sort_order`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PATCH /api/admin/categories/:id — تعديل اسم / حالة / أيقونة
router.patch('/categories/:id', async (req, res) => {
  try {
    const { name_ar, status, icon } = req.body;

    if (status && !['available', 'soon', 'inactive'].includes(status))
      return res.status(400).json({ error: 'حالة غير صحيحة' });

    const fields = [];
    const params = [];

    if (name_ar    !== undefined) { params.push(name_ar);              fields.push(`name_ar = $${params.length}`); }
    if (status     !== undefined) { params.push(status);               fields.push(`status = $${params.length}`); }
    if (icon       !== undefined) { params.push(icon);                 fields.push(`icon = $${params.length}`); }
    if (req.body.sort_order !== undefined) { params.push(req.body.sort_order); fields.push(`sort_order = $${params.length}`); }

    if (fields.length === 0)
      return res.status(400).json({ error: 'لا توجد حقول للتعديل' });

    params.push(req.params.id);
    await db.query(
      `UPDATE categories SET ${fields.join(', ')} WHERE id = $${params.length}`,
      params
    );

    res.json({ message: 'تم تحديث الفئة' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/admin/categories — إضافة فئة جديدة
router.post('/categories', async (req, res) => {
  try {
    const { name_ar, name_en = '', status = 'soon', icon = '📦' } = req.body;
    if (!name_ar) return res.status(400).json({ error: 'اسم الفئة مطلوب' });

    // احسب sort_order التالي
    const maxOrder = await db.query('SELECT COALESCE(MAX(sort_order), 0) as max FROM categories');
    const sortOrder = parseInt(maxOrder.rows[0].max) + 1;

    // أنشئ slug من الاسم الإنجليزي أو العربي
    const slug = (name_en || name_ar)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\u0600-\u06ff-]/g, '')
      + '-' + Date.now();

    const result = await db.query(
      `INSERT INTO categories (name_ar, name_en, slug, status, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name_ar, name_en, slug, status, icon, sortOrder]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// DELETE /api/admin/categories/:id — حذف فئة
router.delete('/categories/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ message: 'تم حذف الفئة' });
  } catch (err) {
    // إذا فيه منتجات مرتبطة، غيّر الحالة بدل الحذف
    await db.query("UPDATE categories SET status='inactive' WHERE id=$1", [req.params.id])
      .catch(() => {});
    res.json({ message: 'تم إخفاء الفئة (تحتوي على منتجات)' });
  }
});
// GET /api/admin/sellers/:id/documents
router.get('/sellers/:id/documents', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM seller_documents WHERE seller_id = $1 ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ documents: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});
module.exports = router;
