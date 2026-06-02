const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// ─── Create order (buyer) ────────────────────────────────
// POST /api/orders
router.post('/', auth(['buyer']), async (req, res) => {
  const { product_id, quantity, shipping_type, shipping_address, notes, coupon_code } = req.body;
  try {
    // Get product & seller
    const product = await db.query(
      `SELECT p.*, s.id as seller_id, s.governorate as seller_governorate
       FROM products p JOIN sellers s ON p.seller_id = s.id WHERE p.id = $1`,
      [product_id]
    );
    if (!product.rows.length) return res.status(404).json({ error: 'المنتج غير موجود' });

    const p = product.rows[0];
    if (quantity < p.min_order_quantity)
      return res.status(400).json({ error: `الحد الأدنى للطلب هو ${p.min_order_quantity} ${p.unit}` });

    // تحقق المخزون (المنتج بمخزون محدود)
    if (p.in_stock === false)
      return res.status(400).json({ error: 'هذا المنتج غير متوفر حالياً' });
    if (p.stock_qty !== null && p.stock_qty !== undefined && quantity > p.stock_qty)
      return res.status(400).json({ error: `الكمية المتوفرة فقط ${p.stock_qty} ${p.unit}` });

    // جلب محافظة المشتري
    const buyerRow = await db.query('SELECT governorate FROM users WHERE id = $1', [req.user.id]);
    const buyerGov = buyerRow.rows[0]?.governorate || '';

    // ترجمة to_buyer → inside أو outside حسب منطق المشتري والبائع
    let resolved_shipping = shipping_type;
    if (shipping_type === 'to_buyer') {
      if (!buyerGov) {
        return res.status(400).json({ error: 'يجب تحديد محافظتك من الملف الشخصي قبل الطلب' });
      }
      const sameGov = p.seller_governorate === buyerGov;

      // أولوية: نفس المحافظة → inside
      if (sameGov && p.ship_inside) {
        resolved_shipping = 'inside';
      } else if (p.ship_outside) {
        // outside: لازم المحافظة بالقائمة أو القائمة فاضية = كل المحافظات
        const list = Array.isArray(p.outside_governorates) ? p.outside_governorates : [];
        if (list.length > 0 && !list.includes(buyerGov)) {
          return res.status(400).json({ error: `هذا المنتج لا يشحن إلى محافظة ${buyerGov}` });
        }
        resolved_shipping = 'outside';
      } else {
        return res.status(400).json({ error: `لا يوجد شحن متاح إلى محافظة ${buyerGov}` });
      }
    }

    // تحقق من صلاحية الشحن
    if (resolved_shipping === 'inside') {
      if (!p.ship_inside) return res.status(400).json({ error: 'هذا المنتج لا يدعم الشحن الداخلي' });
      if (buyerGov && p.seller_governorate && p.seller_governorate !== buyerGov)
        return res.status(400).json({ error: `الشحن الداخلي متاح فقط داخل محافظة ${p.seller_governorate}` });
    }
    if (resolved_shipping === 'outside') {
      if (!p.ship_outside) return res.status(400).json({ error: 'هذا المنتج لا يدعم الشحن خارج المحافظة' });
      if (buyerGov && Array.isArray(p.outside_governorates) && p.outside_governorates.length > 0) {
        if (!p.outside_governorates.includes(buyerGov))
          return res.status(400).json({ error: `هذا المنتج لا يشحن إلى محافظة ${buyerGov}` });
      }
    }
    if (resolved_shipping === 'international') {
      if (!p.ship_international) return res.status(400).json({ error: 'هذا المنتج لا يدعم الشحن الدولي' });
    }

    // Calculate shipping price
    let shipping_price = 0;
    if (resolved_shipping === 'inside')        shipping_price = p.ship_price_inside || 0;
    if (resolved_shipping === 'outside')       shipping_price = p.ship_price_outside || 0;
    if (resolved_shipping === 'international') shipping_price = p.ship_price_intl || 0;

    // سعر الوحدة الفعّال حسب شرائح التسعير (أكبر min_qty لا يتجاوز الكمية)
    let unit_price = parseFloat(p.price) || 0;
    const tier = await db.query(
      `SELECT unit_price FROM price_tiers
       WHERE product_id = $1 AND min_qty <= $2
       ORDER BY min_qty DESC LIMIT 1`,
      [product_id, quantity]
    );
    if (tier.rows.length) unit_price = parseFloat(tier.rows[0].unit_price);

    // كوبون الخصم (يحسبه الخادم على قيمة البضاعة لهذا السطر)
    let discount = 0, appliedCoupon = null;
    if (coupon_code && String(coupon_code).trim()) {
      const cp = await db.query(
        `SELECT code, discount_type, value, min_total, active, expires_at
         FROM coupons
         WHERE seller_id = $1 AND lower(code) = lower($2)`,
        [p.seller_id, String(coupon_code).trim()]
      );
      if (cp.rows.length) {
        const c = cp.rows[0];
        const valid = c.active && (!c.expires_at || new Date(c.expires_at) >= new Date());
        const goods = quantity * unit_price;
        if (valid && goods >= (parseFloat(c.min_total) || 0)) {
          if (c.discount_type === 'percent') discount = Math.round(goods * parseFloat(c.value) / 100);
          else discount = Math.min(parseFloat(c.value), goods);
          if (discount > 0) appliedCoupon = c.code;
        }
      }
    }

    const result = await db.query(
      `INSERT INTO orders (buyer_id, seller_id, product_id, quantity, shipping_type, shipping_address, shipping_price, notes, unit_price, coupon_code, discount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.user.id, p.seller_id, product_id, quantity, resolved_shipping, shipping_address, shipping_price, notes, unit_price, appliedCoupon, discount]
    );

    // تنقيص المخزون (إن كان محدوداً) مع حماية من السالب
    if (p.stock_qty !== null && p.stock_qty !== undefined) {
      await db.query(
        `UPDATE products
         SET stock_qty = GREATEST(stock_qty - $1, 0),
             in_stock  = (GREATEST(stock_qty - $1, 0) > 0)
         WHERE id = $2`,
        [quantity, product_id]
      );
    }

    // Notify seller (الإشعار اختياري — فشله يجب ألا يُفشل الطلب)
    try {
      await db.query(
        `INSERT INTO notifications (user_id, type, title_ar, body_ar, ref_type, ref_id)
         SELECT s.user_id, 'new_order', 'طلب جديد', $1, 'order', $2
         FROM sellers s WHERE s.id = $3`,
        [`طلب جديد بكمية ${quantity} ${p.unit}`, result.rows[0].id, p.seller_id]
      );
    } catch (e) { console.error('order notify seller failed:', e.message); }

    res.status(201).json({ message: 'تم إرسال طلبك بنجاح', order: result.rows[0] });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Get buyer orders ────────────────────────────────────
// GET /api/orders/my
router.get('/my', auth(['buyer']), async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    const params = [req.user.id];
    let where = 'WHERE o.buyer_id = $1';

    if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }

    params.push(limit, offset);
    const result = await db.query(
      `SELECT o.*, p.name_ar, p.name_en, p.unit, p.price,
              s.company_name_ar, s.partner_tier,
              s.governorate as seller_governorate,
              p.outside_governorates as outside_governorates,
              COALESCE((SELECT image_url FROM product_images WHERE product_id = p.id AND is_primary=true LIMIT 1), p.image_url) as product_image,
              EXISTS(SELECT 1 FROM reviews rv WHERE rv.order_id = o.id) as reviewed,
              (o.quantity * COALESCE(o.unit_price, p.price) - COALESCE(o.discount,0) + o.shipping_price) as total_amount
       FROM orders o
       JOIN products p ON o.product_id = p.id
       JOIN sellers s  ON o.seller_id  = s.id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('orders route error:', err.message || err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Get seller orders ───────────────────────────────────
// GET /api/orders/seller
router.get('/seller', auth(['seller']), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const seller = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows.length) return res.status(403).json({ error: 'غير مصرح' });

    const params = [seller.rows[0].id];
    let where = 'WHERE o.seller_id = $1';
    if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }

    params.push(limit, (page-1)*limit);
    const result = await db.query(
      `SELECT o.*, p.name_ar, p.unit, p.price,
              u.name as buyer_name, u.phone as buyer_phone, u.governorate as buyer_gov,
              COALESCE((SELECT image_url FROM product_images WHERE product_id = p.id AND is_primary=true LIMIT 1), p.image_url) as product_image,
              (o.quantity * COALESCE(o.unit_price, p.price) - COALESCE(o.discount,0) + o.shipping_price) as total_amount
       FROM orders o
       JOIN products p ON o.product_id = p.id
       JOIN users u    ON o.buyer_id   = u.id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('orders route error:', err.message || err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Update order status (seller/admin/buyer cancel) ─────
// PATCH /api/orders/:id/status
router.patch('/:id/status', auth(['seller','admin','buyer']), async (req, res) => {
  const { status, cancel_reason } = req.body;
  const validStatuses = ['confirmed','shipped','delivered','cancelled'];

  if (!validStatuses.includes(status))
    return res.status(400).json({ error: 'حالة غير صحيحة' });

  const isBuyer = req.user.user_type === 'buyer';

  // المشتري يستطيع فقط الإلغاء
  if (isBuyer && status !== 'cancelled')
    return res.status(403).json({ error: 'غير مسموح' });

  try {
    const timestampField = {
      confirmed: 'confirmed_at',
      shipped:   'shipped_at',
      delivered: 'delivered_at',
      cancelled: 'cancelled_at'
    }[status];

    let query, params;

    if (isBuyer) {
      // المشتري: فقط طلباته بحالة pending
      query = `UPDATE orders SET status = $1, ${timestampField} = NOW(), cancel_reason = $2
               WHERE id = $3 AND buyer_id = $4 AND status = 'pending' RETURNING *`;
      params = [status, cancel_reason || 'إلغاء من المشتري', req.params.id, req.user.id];
    } else {
      query = `UPDATE orders SET status = $1, ${timestampField} = NOW(), cancel_reason = $2
               WHERE id = $3 RETURNING *`;
      params = [status, cancel_reason || null, req.params.id];
    }

    const result = await db.query(query, params);

    if (!result.rows.length) return res.status(404).json({ error: 'الطلب غير موجود أو لا يمكن إلغاؤه' });

    const o = result.rows[0];

    // استرجاع المخزون عند الإلغاء (للمنتجات بمخزون محدود)
    if (status === 'cancelled') {
      await db.query(
        `UPDATE products
         SET stock_qty = stock_qty + $1, in_stock = true
         WHERE id = $2 AND stock_qty IS NOT NULL`,
        [o.quantity, o.product_id]
      );
    }

    // إشعار المشتري عند تحديث حالة الطلب من البائع/الأدمن
    if (!isBuyer && ['confirmed', 'shipped', 'delivered'].includes(status)) {
      try {
        const msg = {
          confirmed: ['تم تأكيد طلبك', 'أكّد البائع طلبك وجارٍ تجهيزه'],
          shipped:   ['تم شحن طلبك', 'طلبك في الطريق إليك'],
          delivered: ['تم تسليم طلبك', 'تم تسليم طلبك — لا تنسَ تقييم البائع']
        }[status];
        await db.query(
          `INSERT INTO notifications (user_id, type, title_ar, body_ar, ref_type, ref_id)
           VALUES ($1, 'order_status', $2, $3, 'order', $4)`,
          [o.buyer_id, msg[0], msg[1], o.id]
        );
      } catch (e) { /* الإشعارات اختيارية */ }
    }

    // إشعار البائع عند إلغاء المشتري للطلب
    if (isBuyer && status === 'cancelled') {
      try {
        await db.query(
          `INSERT INTO notifications (user_id, type, title_ar, body_ar, ref_type, ref_id)
           SELECT s.user_id, 'order_cancelled', 'تم إلغاء طلب', $1, 'order', $2
           FROM sellers s WHERE s.id = $3`,
          [`ألغى المشتري طلباً${o.cancel_reason ? ' — السبب: ' + o.cancel_reason : ''}`, o.id, o.seller_id]
        );
      } catch (e) { /* الإشعارات اختيارية */ }
    }

    res.json({ message: 'تم تحديث حالة الطلب', order: o });
  } catch (err) {
    console.error('orders route error:', err.message || err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Get single order ────────────────────────────────────
router.get('/:id', auth(), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.*, p.name_ar, p.name_en, p.unit, p.min_order_quantity, p.price,
              s.company_name_ar, s.partner_tier, s.governorate as seller_gov,
              u.name as buyer_name, u.phone as buyer_phone,
              COALESCE((SELECT image_url FROM product_images WHERE product_id = p.id AND is_primary=true LIMIT 1), p.image_url) as product_image,
              (o.quantity * COALESCE(o.unit_price, p.price) - COALESCE(o.discount,0) + o.shipping_price) as total_amount
       FROM orders o
       JOIN products p ON o.product_id = p.id
       JOIN sellers s  ON o.seller_id  = s.id
       JOIN users u    ON o.buyer_id   = u.id
       WHERE o.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('orders route error:', err.message || err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
