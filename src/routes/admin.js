const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const settings = require('../utils/settings');

// All admin routes require admin role
router.use(auth(['admin']));

// مساعد تسجيل التدقيق — لا يُفشل الإجراء الأصلي أبداً
async function logAudit(userId, action, targetType, targetId, meta) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, action, target_type, target_id, meta, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
      [userId, action, targetType, targetId ? String(targetId) : null, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) { /* تجاهل: السجلّ ثانوي */ }
}

// ─── Dashboard overview ──────────────────────────────────
// GET /api/admin/overview
router.get('/overview', async (req, res) => {
  try {
    const [users, totalUsers, sellers, pendingSellers, orders, pending] = await Promise.all([
      db.query("SELECT COUNT(*) FROM users WHERE user_type='buyer'"),
      db.query("SELECT COUNT(*) FROM users"),
      db.query("SELECT COUNT(*) FROM sellers WHERE verification_status='verified'"),
      db.query("SELECT COUNT(*) FROM sellers WHERE verification_status NOT IN ('verified','rejected')"),
      db.query("SELECT COUNT(*) FROM orders"),
      db.query("SELECT COUNT(*) FROM verification_requests WHERE status='pending'")
    ]);

    // حساب الإيرادات بشكل آمن
    let gmv = 0, delivered = 0, active = 0;
    try {
      const rev = await db.query(`SELECT
        COALESCE(SUM(total_amount),0) as gmv,
        COUNT(CASE WHEN status='delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN status!='cancelled' THEN 1 END) as active
        FROM orders`);
      gmv       = parseFloat(rev.rows[0].gmv)       || 0;
      delivered = parseInt(rev.rows[0].delivered)   || 0;
      active    = parseInt(rev.rows[0].active)      || 0;
    } catch(e) { /* total_amount قد لا يكون موجوداً */ }

    // أكثر الفئات
    let topCategory = null;
    try {
      const topCat = await db.query(`SELECT c.name_ar, COUNT(o.id) as cnt
        FROM orders o
        LEFT JOIN products p ON o.product_id=p.id
        LEFT JOIN categories c ON p.category_id=c.id
        WHERE o.status != 'cancelled' AND c.name_ar IS NOT NULL
        GROUP BY c.name_ar ORDER BY cnt DESC LIMIT 1`);
      topCategory = topCat.rows[0]?.name_ar || null;
    } catch(e) {}

    // عدّاد المنتجات بانتظار الموافقة (دفاعي — لا يكسر اللوحة لو فشل)
    let pendingProducts = 0;
    try {
      const pp = await db.query("SELECT COUNT(*) FROM products WHERE approval_status='pending' AND status != 'archived'");
      pendingProducts = parseInt(pp.rows[0].count) || 0;
    } catch(e) {}

    const recentOrders = await db.query(
      `SELECT o.id, o.status, o.quantity, o.created_at,
              p.name_ar, s.company_name_ar, u.name as buyer_name
       FROM orders o
       LEFT JOIN products p ON o.product_id=p.id
       LEFT JOIN sellers  s ON o.seller_id=s.id
       LEFT JOIN users    u ON o.buyer_id=u.id
       ORDER BY o.created_at DESC LIMIT 10`
    );

    res.json({
      stats: {
        buyers:           parseInt(users.rows[0].count),
        total_users:      parseInt(totalUsers.rows[0].count),
        verified_sellers: parseInt(sellers.rows[0].count),
        pending_sellers:  parseInt(pendingSellers.rows[0].count),
        total_orders:     parseInt(orders.rows[0].count),
        pending_verif:    parseInt(pending.rows[0].count),
        pending_products: pendingProducts,
        total_revenue:    gmv,
        delivered_orders: delivered,
        active_orders:    active,
        top_category:     topCategory
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
         AND vr.created_at = (
           SELECT MAX(vr2.created_at) FROM verification_requests vr2
           WHERE vr2.seller_id = vr.seller_id AND vr2.status = $1
         )
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

    await logAudit(req.user.id,
      action === 'approved' ? 'verification_approve'
      : action === 'rejected' ? 'verification_reject' : 'verification_revision',
      'seller', vr.rows[0].seller_id, { action, partner_tier: partner_tier || null });

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
      `SELECT u.id,u.name,u.email,u.phone,u.user_type,u.governorate,u.is_active,u.created_at,
              COALESCE(u.avatar_url, s.logo_url) as avatar_url,
              s.verification_status, s.company_name_ar
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
    await logAudit(req.user.id, 'user_change_type', 'user', req.params.id, { user_type });
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
    await logAudit(req.user.id, is_active ? 'user_activate' : 'user_suspend', 'user', req.params.id, null);
    res.json({ message: is_active ? 'تم تفعيل الحساب' : 'تم تعليق الحساب' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Delete user (hard delete + cascade) ─────────────────
// DELETE /api/admin/users/:id
// حذف نهائي ذرّي مع تنظيف كل التبعيات (مطابق منطق DELETE /me + تقوية فرع البائع).
// غير قابل للتراجع. للحذف غير المدمّر استخدم PATCH /users/:id/status (توقيف).
router.delete('/users/:id', async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id)
    return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });

  const client = await db.connect();
  try {
    const u = await client.query('SELECT user_type FROM users WHERE id = $1', [targetId]);
    if (!u.rows.length) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }
    const targetType = u.rows[0].user_type;

    await client.query('BEGIN');

    // إن كان بائعاً: نظّف بياناته ومنتجاته أولاً
    const sellerRes = await client.query('SELECT id FROM sellers WHERE user_id = $1', [targetId]);
    const sellerId = sellerRes.rows[0]?.id;
    if (sellerId) {
      await client.query('DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE seller_id = $1)', [sellerId]);
      await client.query('DELETE FROM saved_products WHERE product_id IN (SELECT id FROM products WHERE seller_id = $1)', [sellerId]);
      await client.query('DELETE FROM reviews WHERE product_id IN (SELECT id FROM products WHERE seller_id = $1)', [sellerId]);
      await client.query('DELETE FROM cart_items WHERE product_id IN (SELECT id FROM products WHERE seller_id = $1)', [sellerId]);
      await client.query('DELETE FROM price_tiers WHERE product_id IN (SELECT id FROM products WHERE seller_id = $1)', [sellerId]);
      await client.query('DELETE FROM products WHERE seller_id = $1', [sellerId]);
      await client.query('DELETE FROM coupons WHERE seller_id = $1', [sellerId]);
      await client.query('DELETE FROM seller_documents WHERE seller_id = $1', [sellerId]);
      await client.query('DELETE FROM verification_requests WHERE seller_id = $1', [sellerId]);
      await client.query('DELETE FROM orders WHERE seller_id = $1', [sellerId]);
      await client.query('DELETE FROM sellers WHERE id = $1', [sellerId]);
    }

    // بيانات المستخدم (مشترٍ) — أعمدة المرجع: cart_items/reviews=buyer_id، الباقي=user_id
    // reviews تُحذف قبل orders لتفادي FK (reviews.order_id)
    await client.query('DELETE FROM cart_items WHERE buyer_id = $1', [targetId]);
    await client.query('DELETE FROM saved_products WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM reviews WHERE buyer_id = $1', [targetId]);
    await client.query('DELETE FROM notifications WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM orders WHERE buyer_id = $1', [targetId]);
    await client.query('DELETE FROM buyer_addresses WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM audit_log WHERE user_id = $1', [targetId]);

    // حذف المستخدم نهائياً
    await client.query('DELETE FROM users WHERE id = $1', [targetId]);

    await client.query('COMMIT');
    await logAudit(req.user.id, 'user_delete', 'user', targetId, { user_type: targetType });
    res.json({ message: 'تم حذف المستخدم نهائياً' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Admin delete user error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
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

    // عمولة المنصّة التقديرية (تقرير فقط) — على الطلبات المسلّمة.
    // لا تمسّ تدفّق الطلب ولا المال؛ مجرّد رقم للوحة الأدمن. معزولة بـ try
    // كي لا تكسر التحليلات إن فشلت.
    let commission = { rate: 0, delivered_gmv: 0, estimated: 0 };
    try {
      const rate = await settings.getNumber('commission_rate', 0);
      const g = await db.query(
        "SELECT COALESCE(SUM(total_amount),0) AS gmv FROM orders WHERE status='delivered'"
      );
      const dgmv = parseFloat(g.rows[0].gmv) || 0;
      commission = { rate, delivered_gmv: dgmv, estimated: Math.round(dgmv * rate / 100) };
    } catch (_) { /* تقرير اختياري */ }

    res.json({
      byStatus:    ordersByStatus.rows,
      byGov:       ordersByGov.rows,
      byShipping:  ordersByShipping.rows,
      topSellers:  topSellers.rows,
      monthly:     monthlyOrders.rows,
      commission
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
    const upd = await db.query(
      'UPDATE platform_settings SET value=$1, updated_by=$2, updated_at=NOW() WHERE key=$3',
      [value, req.user.id, req.params.key]
    );
    if (upd.rowCount === 0) {
      await db.query(
        'INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, NOW())',
        [req.params.key, value, req.user.id]
      );
    }
    settings.invalidate();   // تأثير فوري للإعداد الجديد (بلا انتظار انتهاء الكاش)
    await logAudit(req.user.id, 'setting_update', 'setting', req.params.key, { value });
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

// DELETE /api/admin/categories/:id — حذف فئة (ممنوع إن وُجدت منتجات مرتبطة)
router.delete('/categories/:id', async (req, res) => {
  try {
    // فحص صريح: لا نحذف فئة تحتوي على منتجات (أي حالة اعتماد/حياة) — دفاعي بلا اعتماد على الـ FK
    const used = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM products WHERE category_id = $1',
      [req.params.id]
    );
    const cnt = used.rows[0].cnt;
    if (cnt > 0) {
      return res.status(409).json({
        error: `لا يمكن حذف الفئة لأنها تحتوي على ${cnt} منتج. يمكنك تحويلها إلى "غير نشطة" بدلاً من حذفها.`,
        code: 'CATEGORY_HAS_PRODUCTS',
        product_count: cnt
      });
    }

    const del = await db.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    if (del.rowCount === 0)
      return res.status(404).json({ error: 'الفئة غير موجودة' });

    res.json({ message: 'تم حذف الفئة' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
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

// ─── All orders for analytics ────────────────────────────
// GET /api/admin/orders
router.get('/orders', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.id, o.status, o.quantity, o.shipping_price, o.created_at,
              o.seller_id, o.buyer_id, o.shipping_type,
              p.price, p.name_ar, p.category_id,
              c.name_ar as category_name_ar,
              s.company_name_ar,
              (o.quantity * p.price + o.shipping_price) as total_amount
       FROM orders o
       JOIN products p ON o.product_id = p.id
       JOIN sellers s  ON o.seller_id  = s.id
       JOIN categories c ON p.category_id = c.id
       ORDER BY o.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Product moderation (إشراف المنتجات) ─────────────────

// GET /api/admin/products — قائمة المنتجات للإشراف (فلتر بالحالة + بحث)
router.get('/products', async (req, res) => {
  try {
    const { approval, search } = req.query;
    const params = [];
    const where  = [`p.status != 'archived'`];

    if (approval) {
      params.push(approval);
      where.push(`p.approval_status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(p.name_ar ILIKE $${params.length} OR s.company_name_ar ILIKE $${params.length})`);
    }

    const w = 'WHERE ' + where.join(' AND ');
    const result = await db.query(
      `SELECT p.id, p.name_ar, p.price, p.approval_status, p.rejection_reason,
              p.created_at, p.image_url, p.category_id,
              c.name_ar as category_name_ar,
              s.id as seller_id, s.company_name_ar
       FROM products p
       LEFT JOIN sellers    s ON p.seller_id  = s.id
       LEFT JOIN categories c ON p.category_id = c.id
       ${w}
       ORDER BY (p.approval_status = 'pending') DESC, p.created_at DESC`,
      params
    );

    // عدّادات سريعة لكل حالة
    const counts = await db.query(
      `SELECT approval_status, COUNT(*) as count
       FROM products WHERE status != 'archived'
       GROUP BY approval_status`
    );

    res.json({ products: result.rows, counts: counts.rows });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PATCH /api/admin/products/:id/approval — اعتماد/رفض/تعليق/إعادة للمراجعة
router.patch('/products/:id/approval', async (req, res) => {
  const { action, reason } = req.body;
  const map = { approve: 'approved', reject: 'rejected', suspend: 'suspended', reset: 'pending' };
  const newStatus = map[action];

  if (!newStatus)
    return res.status(400).json({ error: 'إجراء غير صحيح' });
  if (action === 'reject' && (!reason || !reason.trim()))
    return res.status(400).json({ error: 'سبب الرفض مطلوب' });

  try {
    const upd = await db.query(
      `UPDATE products
       SET approval_status = $1,
           rejection_reason = $2,
           moderated_at = NOW(),
           moderated_by = $3
       WHERE id = $4 AND status != 'archived'
       RETURNING seller_id, name_ar`,
      [newStatus, action === 'reject' ? reason.trim() : null, req.user.id, req.params.id]
    );
    if (!upd.rows.length)
      return res.status(404).json({ error: 'المنتج غير موجود' });

    const titleMap = {
      approved:  'تمت الموافقة على منتجك',
      rejected:  'تم رفض منتجك',
      suspended: 'تم تعليق منتجك',
      pending:   'منتجك قيد المراجعة'
    };
    const title = titleMap[newStatus];
    const body  = newStatus === 'rejected'
      ? (reason.trim())
      : newStatus === 'approved'
        ? `أصبح منتجك «${upd.rows[0].name_ar}» منشوراً للمشترين`
        : title;

    await db.query(
      `INSERT INTO notifications(user_id, type, title_ar, body_ar, ref_type, ref_id)
       SELECT s.user_id, $1, $2, $3, 'product', $4 FROM sellers s WHERE s.id = $5`,
      ['product_moderation', title, body, req.params.id, upd.rows[0].seller_id]
    );

    await logAudit(req.user.id, 'product_' + newStatus, 'product', req.params.id,
      action === 'reject' ? { reason: reason.trim() } : null);

    res.json({ message: 'تم تحديث حالة المنتج', approval_status: newStatus });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Seller performance + SLA monitoring ─────────────────
// GET /api/admin/performance
router.get('/performance', async (req, res) => {
  // حدود SLA — تُقرأ من platform_settings مع fallback افتراضي
  let MAX_RESPONSE_HOURS = 6;
  let MAX_SHIPPING_HOURS = 48;

  try {
    try {
      const st = await db.query(
        "SELECT key, value FROM platform_settings WHERE key IN ('sla_max_response_hours','sla_max_shipping_hours')"
      );
      st.rows.forEach(r => {
        const n = parseInt(r.value);
        if (!isNaN(n) && n > 0) {
          if (r.key === 'sla_max_response_hours') MAX_RESPONSE_HOURS = n;
          if (r.key === 'sla_max_shipping_hours') MAX_SHIPPING_HOURS = n;
        }
      });
    } catch (e) { /* fallback إلى الافتراضي */ }
    // متوسطات المنصّة (محسوبة مباشرة من الطوابع — دقيقة)
    const platform = await db.query(`
      SELECT
        AVG(EXTRACT(EPOCH FROM (confirmed_at - created_at)))  FILTER (WHERE confirmed_at IS NOT NULL) AS avg_response_seconds,
        AVG(EXTRACT(EPOCH FROM (shipped_at   - confirmed_at))) FILTER (WHERE shipped_at   IS NOT NULL) AS avg_shipping_seconds,
        AVG(EXTRACT(EPOCH FROM (delivered_at - shipped_at)))   FILTER (WHERE delivered_at IS NOT NULL) AS avg_delivery_seconds
      FROM orders
    `);

    // أكثر البائعين أداءً (الأسرع رداً) — من v_seller_performance
    const topSellers = await db.query(`
      SELECT s.id, s.company_name_ar,
             vp.avg_response_seconds, vp.avg_shipping_seconds, vp.avg_delivery_seconds,
             (SELECT COUNT(*) FROM orders o WHERE o.seller_id = s.id) AS total_orders
      FROM sellers s
      JOIN v_seller_performance vp ON vp.seller_id = s.id
      WHERE s.verification_status = 'verified'
      ORDER BY vp.avg_response_seconds ASC NULLS LAST
      LIMIT 10
    `);

    // طلبات تجاوزت SLA (نشطة، غير ملغاة/مسلّمة)
    const breaches = await db.query(`
      SELECT o.id, o.status, o.created_at, o.confirmed_at,
             p.name_ar, s.company_name_ar,
             CASE WHEN o.status = 'pending' THEN 'response' ELSE 'shipping' END AS breach_type,
             EXTRACT(EPOCH FROM (NOW() - CASE WHEN o.status = 'pending' THEN o.created_at ELSE o.confirmed_at END)) AS elapsed_seconds
      FROM orders o
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN sellers  s ON o.seller_id  = s.id
      WHERE (
        (o.status = 'pending'   AND o.created_at   + make_interval(hours => $1) < NOW()) OR
        (o.status = 'confirmed' AND o.confirmed_at + make_interval(hours => $2) < NOW())
      )
      ORDER BY elapsed_seconds DESC
      LIMIT 50
    `, [MAX_RESPONSE_HOURS, MAX_SHIPPING_HOURS]);

    res.json({
      thresholds: { response_hours: MAX_RESPONSE_HOURS, shipping_hours: MAX_SHIPPING_HOURS },
      platform:   platform.rows[0] || {},
      topSellers: topSellers.rows,
      breaches:   breaches.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Audit log viewer ────────────────────────────────────
// GET /api/admin/audit
router.get('/audit', async (req, res) => {
  try {
    const { action, page = 1, limit = 50 } = req.query;
    const params = [];
    const where  = [];
    if (action) { params.push(action); where.push(`a.action = $${params.length}`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(limit, (page - 1) * limit);
    const result = await db.query(
      `SELECT a.id, a.user_id, a.action, a.target_type, a.target_id, a.meta, a.created_at,
              u.name as actor_name, u.email as actor_email
       FROM audit_log a
       LEFT JOIN users u ON a.user_id = u.id
       ${w}
       ORDER BY a.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ entries: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Reviews moderation (admin can delete abusive/fake reviews) ───
// GET /api/admin/reviews
router.get('/reviews', async (req, res) => {
  try {
    const { page = 1, limit = 50, rating, q, replied, sort } = req.query;

    const params = [];
    let where = 'WHERE r.rating IS NOT NULL';

    // فلتر عدد النجوم (1..5)
    const rt = parseInt(rating);
    if (rt >= 1 && rt <= 5) { params.push(rt); where += ` AND r.rating = $${params.length}`; }

    // تصفية حسب وجود ردّ بائع
    if (replied === 'yes') where += " AND r.seller_reply IS NOT NULL AND btrim(r.seller_reply) <> ''";
    else if (replied === 'no') where += " AND (r.seller_reply IS NULL OR btrim(r.seller_reply) = '')";

    // بحث نصّي (اسم بائع/مشتري/تعليق/منتج)
    if (q && String(q).trim()) {
      params.push('%' + String(q).trim() + '%');
      const i = params.length;
      where += ` AND (bu.name ILIKE $${i} OR s.company_name_ar ILIKE $${i} OR r.comment ILIKE $${i} OR p.name_ar ILIKE $${i})`;
    }

    // الفرز
    const orderBy = {
      newest:     'r.created_at DESC',
      oldest:     'r.created_at ASC',
      rating_high:'r.rating DESC, r.created_at DESC',
      rating_low: 'r.rating ASC, r.created_at DESC'
    }[sort] || 'r.created_at DESC';

    const lim = Math.min(parseInt(limit) || 50, 100);
    params.push(lim, (parseInt(page) - 1 || 0) * lim);

    const rows = await db.query(
      `SELECT r.id, r.rating, r.comment, r.seller_reply, r.created_at,
              bu.name            AS buyer_name,
              s.company_name_ar  AS seller_name,
              p.name_ar          AS product_name
       FROM reviews r
       LEFT JOIN users    bu ON r.buyer_id  = bu.id
       LEFT JOIN sellers  s  ON r.seller_id = s.id
       LEFT JOIN products p  ON r.product_id = p.id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ reviews: rows.rows });
  } catch (err) {
    console.error('GET /admin/reviews', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// DELETE /api/admin/reviews/:id
router.delete('/reviews/:id', async (req, res) => {
  try {
    const del = await db.query('DELETE FROM reviews WHERE id = $1 RETURNING seller_id', [req.params.id]);
    if (!del.rows.length) return res.status(404).json({ error: 'التقييم غير موجود' });
    const sellerId = del.rows[0].seller_id;
    // إعادة حساب متوسط تقييم البائع بعد الحذف
    try {
      await db.query(
        `UPDATE sellers SET avg_rating = (
           SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews
           WHERE seller_id = $1 AND rating IS NOT NULL
         ) WHERE id = $1`,
        [sellerId]
      );
    } catch (e) { /* avg_rating قد يكون في view */ }
    await logAudit(req.user.id, 'review_delete', 'review', req.params.id, { seller_id: sellerId });
    res.json({ message: 'تم حذف التقييم' });
  } catch (err) {
    console.error('DELETE /admin/reviews/:id', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
