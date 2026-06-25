const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const settings = require('../utils/settings');

// ─── Create order (buyer) ────────────────────────────────
// POST /api/orders
router.post('/', auth(['buyer']), async (req, res) => {
  const { product_id, quantity, shipping_type, shipping_address, notes, coupon_code } = req.body;

  // ── موعد التوصيل المفضّل (اختياري) ──
  let preferred_delivery_date = (typeof req.body.preferred_delivery_date === 'string' && req.body.preferred_delivery_date.trim())
    ? req.body.preferred_delivery_date.trim() : null;
  let preferred_delivery_slot = (typeof req.body.preferred_delivery_slot === 'string' && req.body.preferred_delivery_slot.trim())
    ? req.body.preferred_delivery_slot.trim() : null;

  if (preferred_delivery_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(preferred_delivery_date))
      return res.status(400).json({ error: 'صيغة موعد التوصيل غير صحيحة' });
    const dParts = preferred_delivery_date.split('-').map(Number);
    const pd = new Date(Date.UTC(dParts[0], dParts[1] - 1, dParts[2]));
    // تحقق round-trip: يرفض التواريخ المستحيلة التي يدوّرها JS (مثل 2026-02-30)
    if (isNaN(pd.getTime()) || pd.getUTCFullYear() !== dParts[0] || pd.getUTCMonth() !== dParts[1] - 1 || pd.getUTCDate() !== dParts[2])
      return res.status(400).json({ error: 'موعد التوصيل غير صالح' });
    const todayUTC = new Date(); todayUTC.setUTCHours(0, 0, 0, 0);
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (pd.getTime() < todayUTC.getTime() - DAY_MS)         // سماحية يوم واحد لفروقات التوقيت
      return res.status(400).json({ error: 'موعد التوصيل لا يمكن أن يكون في الماضي' });
    if (pd.getTime() > todayUTC.getTime() + 365 * DAY_MS)   // حد أعلى منطقي: سنة
      return res.status(400).json({ error: 'موعد التوصيل بعيد جداً' });
  } else {
    preferred_delivery_slot = null; // فترة بلا تاريخ تُتجاهَل
  }
  if (preferred_delivery_slot && !['morning', 'afternoon', 'evening'].includes(preferred_delivery_slot))
    return res.status(400).json({ error: 'فترة التوصيل غير صحيحة' });

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
      const intlOn = await settings.getBool('international_shipping', true);
      if (!intlOn) return res.status(400).json({ error: 'الشحن الدولي غير متاح حالياً' });
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
      `INSERT INTO orders (buyer_id, seller_id, product_id, quantity, shipping_type, shipping_address, shipping_price, notes, unit_price, coupon_code, discount, preferred_delivery_date, preferred_delivery_slot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [req.user.id, p.seller_id, product_id, quantity, resolved_shipping, shipping_address, shipping_price, notes, unit_price, appliedCoupon, discount, preferred_delivery_date, preferred_delivery_slot]
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

// ─── Predictive reorder suggestions (buyer) ──────────────
// GET /api/orders/reorder-suggestions
// منطق خادمي بالكامل من تاريخ طلبات المشتري + حالة المخزون — لا جداول/أعمدة جديدة
router.get('/reorder-suggestions', auth(['buyer']), async (req, res) => {
  try {
    // كل تواريخ وكميات الطلبات (غير الملغاة) لكل منتج اشتراه المشتري
    const hist = await db.query(
      `SELECT o.product_id, o.quantity, o.created_at,
              p.name_ar, p.name_en, p.unit, p.price, p.stock_qty, p.in_stock, p.low_stock_threshold,
              p.approval_status, p.seller_id,
              s.company_name_ar,
              COALESCE((SELECT image_url FROM product_images WHERE product_id = p.id AND is_primary=true LIMIT 1), p.image_url) AS product_image
       FROM orders o
       JOIN products p ON o.product_id = p.id
       JOIN sellers  s ON o.seller_id  = s.id
       WHERE o.buyer_id = $1 AND o.status <> 'cancelled' AND p.approval_status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND c.status = 'inactive')
       ORDER BY o.product_id, o.created_at ASC`,
      [req.user.id]
    );

    // المنتجات المحفوظة (لتنبيه النفاد حتى لو لم تُطلب)
    const saved = await db.query(
      `SELECT v.id AS product_id, v.name_ar, v.name_en, v.unit, v.price,
              p.stock_qty, p.in_stock, p.low_stock_threshold, p.seller_id, p.approval_status,
              s.company_name_ar,
              COALESCE((SELECT image_url FROM product_images WHERE product_id = v.id AND is_primary=true LIMIT 1), v.image_url) AS product_image
       FROM saved_products sp
       JOIN v_products_full v ON v.id = sp.product_id
       LEFT JOIN products p ON p.id = v.id
       LEFT JOIN sellers  s ON s.id = v.seller_id
       WHERE sp.user_id = $1 AND p.approval_status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND c.status = 'inactive')`,
      [req.user.id]
    );

    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // تجميع تاريخ كل منتج
    const byProduct = new Map();
    for (const r of hist.rows) {
      if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, { meta: r, dates: [], lastQty: null });
      const g = byProduct.get(r.product_id);
      g.dates.push(new Date(r.created_at).getTime());
      g.meta = r;               // آخر صف = أحدث بيانات المنتج (مرتّب ASC)
      g.lastQty = r.quantity;   // آخر كمية
    }

    function stockState(m) {
      if (m.in_stock === false) return 'out_of_stock';
      if (m.stock_qty !== null && m.stock_qty !== undefined &&
          m.low_stock_threshold !== null && m.low_stock_threshold !== undefined &&
          m.stock_qty <= m.low_stock_threshold) return 'low_stock';
      return 'in_stock';
    }

    const suggestions = [];
    const seen = new Set();

    for (const [pid, g] of byProduct) {
      const m = g.meta;
      const stk = stockState(m);
      const lastDate = g.dates[g.dates.length - 1];

      // الإيقاع: يحتاج ≥ طلبين لحساب متوسط فجوة موثوق
      let cadenceDays = null, dueDate = null, isDue = false;
      if (g.dates.length >= 2) {
        let sum = 0;
        for (let i = 1; i < g.dates.length; i++) sum += (g.dates[i] - g.dates[i - 1]);
        cadenceDays = (sum / (g.dates.length - 1)) / DAY_MS;
        if (cadenceDays >= 1) {                       // تجاهل الإيقاعات غير الواقعية
          dueDate = lastDate + cadenceDays * DAY_MS;
          isDue = now >= (dueDate - cadenceDays * 0.2 * DAY_MS);  // حلّ الموعد أو قارب (20%)
        }
      }

      // أُدرج إن: نفد/قارب النفاد (فرصة ضائعة) أو حان وقت إعادة الطلب
      let reason = null;
      if (stk === 'out_of_stock') reason = 'out_of_stock';
      else if (stk === 'low_stock') reason = 'low_stock';
      else if (isDue) reason = 'due_reorder';

      if (reason) {
        seen.add(pid);
        suggestions.push({
          product_id: pid,
          name_ar: m.name_ar, name_en: m.name_en, unit: m.unit,
          price: m.price, seller_id: m.seller_id, company_name_ar: m.company_name_ar,
          product_image: m.product_image,
          last_quantity: g.lastQty,
          last_ordered_at: new Date(lastDate).toISOString(),
          order_count: g.dates.length,
          cadence_days: cadenceDays ? Math.round(cadenceDays) : null,
          stock_state: stk,
          reason
        });
      }
    }

    // إضافة المحفوظات النافدة/القاربة التي لم تظهر من التاريخ
    for (const r of saved.rows) {
      if (seen.has(r.product_id)) continue;
      const stk = stockState(r);
      if (stk === 'out_of_stock' || stk === 'low_stock') {
        seen.add(r.product_id);
        suggestions.push({
          product_id: r.product_id,
          name_ar: r.name_ar, name_en: r.name_en, unit: r.unit,
          price: r.price, seller_id: r.seller_id, company_name_ar: r.company_name_ar,
          product_image: r.product_image,
          last_quantity: null, last_ordered_at: null, order_count: 0,
          cadence_days: null,
          stock_state: stk,
          reason: stk === 'out_of_stock' ? 'saved_out_of_stock' : 'saved_low_stock'
        });
      }
    }

    // الترتيب: الإلحاح أولاً (نفد → قارب → مستحق)، ثم الأحدث طلباً
    const rank = { out_of_stock: 0, saved_out_of_stock: 1, low_stock: 2, saved_low_stock: 3, due_reorder: 4 };
    suggestions.sort((a, b) => {
      const d = (rank[a.reason] ?? 9) - (rank[b.reason] ?? 9);
      if (d !== 0) return d;
      return (new Date(b.last_ordered_at || 0)) - (new Date(a.last_ordered_at || 0));
    });

    res.json({ suggestions: suggestions.slice(0, 8) });
  } catch (err) {
    console.error('reorder-suggestions error:', err.message || err);
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
    } else if (req.user.user_type === 'seller') {
      // البائع: فقط طلباته — إغلاق IDOR (كان يحدّث أي طلب)
      query = `UPDATE orders SET status = $1, ${timestampField} = NOW(), cancel_reason = $2
               WHERE id = $3 AND seller_id = (SELECT id FROM sellers WHERE user_id = $4) RETURNING *`;
      params = [status, cancel_reason || null, req.params.id, req.user.id];
    } else {
      // الأدمن: بلا قيد ملكية
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

    // إشعار المشتري عند تحديث حالة الطلب من البائع/الأدمن (يشمل الإلغاء)
    if (!isBuyer && ['confirmed', 'shipped', 'delivered', 'cancelled'].includes(status)) {
      try {
        const msg = {
          confirmed: ['تم تأكيد طلبك', 'أكّد البائع طلبك وجارٍ تجهيزه'],
          shipped:   ['تم شحن طلبك', 'طلبك في الطريق إليك'],
          delivered: ['تم تسليم طلبك', 'تم تسليم طلبك — لا تنسَ تقييم البائع'],
          cancelled: ['تم إلغاء طلبك', 'تم إلغاء طلبك' + (o.cancel_reason ? ' — السبب: ' + o.cancel_reason : '')]
        }[status];
        const notifType = status === 'cancelled' ? 'order_cancelled' : 'order_status';
        await db.query(
          `INSERT INTO notifications (user_id, type, title_ar, body_ar, ref_type, ref_id)
           VALUES ($1, $2, $3, $4, 'order', $5)`,
          [o.buyer_id, notifType, msg[0], msg[1], o.id]
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
              s.company_name_ar, s.partner_tier, s.governorate as seller_gov, s.phone as seller_phone,
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

    // تقييد الوصول بطرفَي الطلب: المشتري صاحبه / البائع صاحبه / الأدمن
    const o = result.rows[0];
    if (req.user.user_type === 'buyer') {
      if (o.buyer_id !== req.user.id)
        return res.status(403).json({ error: 'غير مصرح بالاطلاع على هذا الطلب' });
    } else if (req.user.user_type === 'seller') {
      const sl = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
      if (!sl.rows.length || sl.rows[0].id !== o.seller_id)
        return res.status(403).json({ error: 'غير مصرح بالاطلاع على هذا الطلب' });
    } else if (req.user.user_type !== 'admin') {
      return res.status(403).json({ error: 'غير مصرح بالاطلاع على هذا الطلب' });
    }

    res.json(o);
  } catch (err) {
    console.error('orders route error:', err.message || err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
