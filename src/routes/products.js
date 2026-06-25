const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
// ─── GET all active products ─────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { category, category_id, seller_id, governorate, shipping, search, min_price, max_price, sort, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let where = [];

    if (category) {
      params.push(category);
      where.push(`v.category_slug = $${params.length}`);
    }
    if (category_id) {
      params.push(category_id);
      where.push(`p.category_id = $${params.length}`);
    }
    if (seller_id) {
      params.push(seller_id);
      where.push(`v.seller_id = $${params.length}`);
    }
    if (shipping === 'to_buyer' && governorate) {
      // إلى محافظة المشتري: أي منتج يصل لمحافظة المشتري (داخلي من نفس المحافظة أو خارجي ضمن قائمته)
      params.push(governorate);
      where.push(`(
        (v.ship_inside = true AND v.seller_governorate = $${params.length}) OR
        (v.ship_outside = true AND $${params.length} = ANY(p.outside_governorates))
      )`);
    } else if (shipping === 'inside' && governorate) {
      params.push(governorate);
      where.push(`(v.ship_inside = true AND v.seller_governorate = $${params.length})`);
    } else if (shipping === 'inside') {
      where.push('v.ship_inside = true');
    } else if (shipping === 'outside' && governorate) {
      params.push(governorate);
      where.push(`(v.ship_outside = true AND $${params.length} = ANY(p.outside_governorates))`);
    } else if (shipping === 'outside') {
      where.push('v.ship_outside = true');
    } else if (shipping === 'international') {
      where.push('v.ship_international = true');
    } else if (governorate) {
      params.push(governorate);
      where.push(`(
        (v.ship_inside = true AND v.seller_governorate = $${params.length}) OR
        (v.ship_outside = true AND $${params.length} = ANY(p.outside_governorates))
      )`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(v.name_ar ILIKE $${params.length} OR v.name_en ILIKE $${params.length} OR v.company_name_ar ILIKE $${params.length})`);
    }
    if (min_price) {
      params.push(min_price);
      where.push(`p.price >= $${params.length}`);
    }
    if (max_price) {
      params.push(max_price);
      where.push(`p.price <= $${params.length}`);
    }

    // بوابة الاعتماد: المشترون يرون المنتجات المعتمدة فقط
    where.push("p.approval_status = 'approved'");
    // بوابة الفئة: إخفاء منتجات الفئات غير النشطة (NULL/فئة غير موجودة = تُعرض)
    where.push("NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND c.status = 'inactive')");

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    let orderBy;
    if (sort === 'newest')          orderBy = 'ORDER BY p.created_at DESC';
    else if (sort === 'price_asc')  orderBy = 'ORDER BY p.price ASC';
    else if (sort === 'price_desc') orderBy = 'ORDER BY p.price DESC';
    else orderBy = "ORDER BY v.partner_tier = 'gold' DESC, v.partner_tier = 'silver' DESC, v.views_count DESC";

    params.push(limit, offset);
    const query = `
      SELECT v.*, s.logo_url as seller_logo_url,
             p.outside_governorates as outside_governorates,
             p.stock_qty, p.in_stock
      FROM v_products_full v
      LEFT JOIN sellers s ON s.id = v.seller_id
      LEFT JOIN products p ON p.id = v.id
      ${whereClause}
      ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const result = await db.query(query, params);

    const countResult = await db.query(
      `SELECT COUNT(*) FROM v_products_full v LEFT JOIN sellers s ON s.id = v.seller_id LEFT JOIN products p ON p.id = v.id ${whereClause}`,
      params.slice(0, -2)
    );

    res.json({
      products: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit)
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});
// —— GET my products (seller only) ——
router.get('/my', auth(['seller']), async (req, res) => {
  try {
    const seller = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows.length) return res.status(403).json({ error: 'لست بائعاً' });
    const result = await db.query(
      `SELECT p.*, c.name_ar as category_name_ar 
       FROM products p 
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.seller_id = $1 AND p.status != 'archived'
       ORDER BY p.created_at DESC`,
      [seller.rows[0].id]
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});
// ─── GET single product ──────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    // إذا كان البائع يطلب منتجه، نسمح بأي حالة غير archived
    let statusCondition = `p.status = 'active'`;
    let approvalCondition = `AND p.approval_status = 'approved'`;
    let categoryCondition = `AND c.status != 'inactive'`;  // إخفاء منتجات الفئات غير النشطة عن المشتري
    let token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.user_type === 'seller' || decoded.user_type === 'admin') {
          statusCondition = `p.status != 'archived'`;
          approvalCondition = '';  // البائع/الأدمن يعاينان أي حالة اعتماد
          categoryCondition = '';  // ويعاينان منتجهم حتى لو فئته غير نشطة
        }
      } catch(e) {}
    }

    const result = await db.query(
      `SELECT p.*, s.company_name_ar, s.company_name_en, s.partner_tier,
              s.governorate as seller_governorate, s.description as seller_description,
              s.logo_url as seller_logo_url,
              s.verification_status as seller_verification_status,
              s.avg_rating as seller_avg_rating,
              (SELECT COUNT(*) FROM reviews rv WHERE rv.seller_id = s.id AND rv.rating IS NOT NULL) as seller_review_count,
              c.name_ar as category_name_ar, c.slug as category_slug,
              u.phone as seller_phone, u.email as seller_email,
              (SELECT COUNT(*) FROM products p2 WHERE p2.seller_id = s.id AND p2.status = 'active') as active_products,
              (SELECT COUNT(*) FROM orders o WHERE o.seller_id = s.id AND o.status = 'delivered') as completed_orders
       FROM products p
       JOIN sellers s ON p.seller_id = s.id
       JOIN categories c ON p.category_id = c.id
       JOIN users u ON s.user_id = u.id
       WHERE p.id = $1 AND ${statusCondition} ${approvalCondition} ${categoryCondition}`,
      [req.params.id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: 'المنتج غير موجود' });

    const images = await db.query(
      'SELECT * FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, sort_order',
      [req.params.id]
    );

    const reviews = await db.query(
      `SELECT r.*, u.name as buyer_name
       FROM reviews r JOIN users u ON r.buyer_id = u.id
       WHERE r.seller_id = $1 ORDER BY r.created_at DESC LIMIT 5`,
      [result.rows[0].seller_id]
    );

    const tiers = await db.query(
      'SELECT id, min_qty, unit_price FROM price_tiers WHERE product_id = $1 ORDER BY min_qty ASC',
      [req.params.id]
    );

    await db.query('UPDATE products SET views_count = views_count + 1 WHERE id = $1', [req.params.id]);

    res.json({
      ...result.rows[0],
      images: images.rows,
      reviews: reviews.rows,
      price_tiers: tiers.rows
    });

  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── CREATE product (seller only) ───────────────────────
router.post('/', auth(['seller']), async (req, res) => {
  try {
   const {
  category_id, name_ar, name_en,
  description_ar = req.body.description || null,
  description_en,
  min_order_quantity, unit, price,
  ship_inside, ship_outside, ship_international,
  ship_price_inside, ship_price_outside, ship_price_intl,
  outside_governorates,
  stock_qty, low_stock_threshold, price_tiers
} = req.body;

    const seller = await db.query('SELECT id, verification_status FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows.length) return res.status(403).json({ error: 'لست بائعاً معتمداً' });
    if (seller.rows[0].verification_status === 'rejected') return res.status(403).json({ error: 'تم رفض طلب توثيقك — لا يمكنك إضافة منتجات' });
    if (seller.rows[0].verification_status !== 'verified') return res.status(403).json({ error: 'حسابك قيد المراجعة — يمكنك إضافة المنتجات بعد قبول التوثيق' });

    // Normalize outside_governorates to a clean string array
    const govList = Array.isArray(outside_governorates)
      ? outside_governorates.filter(g => typeof g === 'string' && g.trim()).map(g => g.trim())
      : [];

    const sQty = (stock_qty === '' || stock_qty === undefined || stock_qty === null) ? null : parseInt(stock_qty);
    const lowT = (low_stock_threshold === '' || low_stock_threshold === undefined || low_stock_threshold === null) ? null : parseInt(low_stock_threshold);
    const inStock = sQty === null ? true : sQty > 0;

    const result = await db.query(
      `INSERT INTO products
      (seller_id, category_id, name_ar, name_en, description_ar, description_en,
      min_order_quantity, unit, price, ship_inside, ship_outside, ship_international,
      ship_price_inside, ship_price_outside, ship_price_intl, outside_governorates, status,
      stock_qty, in_stock, low_stock_threshold)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',$17,$18,$19)
      RETURNING *`,
      [seller.rows[0].id, category_id, name_ar, name_en, description_ar, description_en,
     min_order_quantity || 1, unit || 'كرتون', parseFloat(price) || 0,
      ship_inside || true, ship_outside || false, ship_international || false,
      ship_price_inside, ship_price_outside, ship_price_intl, govList,
      sQty, inStock, lowT]
    );

    const newProduct = result.rows[0];

    // شرائح التسعير (اختياري)
    if (Array.isArray(price_tiers) && price_tiers.length) {
      for (const t of price_tiers) {
        const mq = parseInt(t.min_qty);
        const up = parseFloat(t.unit_price);
        if (mq > 0 && up >= 0) {
          await db.query(
            'INSERT INTO price_tiers (product_id, min_qty, unit_price) VALUES ($1,$2,$3)',
            [newProduct.id, mq, up]
          );
        }
      }
    }

    // إشعار الأدمن: منتج جديد بانتظار المراجعة (مجمّع — نداء واحد غير مقروء لكل أدمن
    // لتفادي السبام عند الرفع الجماعي CSV؛ العدد الدقيق يظهر كـ badge من /overview).
    // اختياري — فشله يجب ألا يُفشل إضافة المنتج.
    try {
      await db.query(
        `INSERT INTO notifications (user_id, type, title_ar, body_ar, ref_type, ref_id)
         SELECT u.id, 'product_pending', 'منتجات بانتظار المراجعة',
                'هناك منتجات جديدة تحتاج موافقتك — افتح إشراف المنتجات', 'admin_products', $1
         FROM users u
         WHERE u.user_type = 'admin'
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.user_id = u.id AND n.type = 'product_pending' AND n.is_read IS NOT TRUE
           )`,
        [newProduct.id]
      );
    } catch (e) { console.error('admin product_pending notify failed:', e.message); }

    res.status(201).json({ message: 'تم إضافة المنتج', product: newProduct });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── UPDATE product ──────────────────────────────────────
router.put('/:id', auth(['seller']), async (req, res) => {
  try {
    const seller = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows.length) return res.status(403).json({ error: 'غير مصرح' });

    const fields = ['name_ar','name_en','description_ar','description_en',
                    'min_order_quantity','unit','price','ship_inside','ship_outside',
                    'ship_international','ship_price_inside','ship_price_outside',
                    'ship_price_intl','status','category_id','outside_governorates'];

    const updates = [];
    const values  = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        // Normalize outside_governorates if present
        if (f === 'outside_governorates') {
          const arr = Array.isArray(req.body[f])
            ? req.body[f].filter(g => typeof g === 'string' && g.trim()).map(g => g.trim())
            : [];
          values.push(arr);
        } else {
          values.push(req.body[f]);
        }
        updates.push(`${f} = $${values.length}`);
      }
    });

    // المخزون: مزامنة in_stock تلقائياً
    if (req.body.stock_qty !== undefined) {
      const sQty = (req.body.stock_qty === '' || req.body.stock_qty === null) ? null : parseInt(req.body.stock_qty);
      values.push(sQty); updates.push(`stock_qty = $${values.length}`);
      values.push(sQty === null ? true : sQty > 0); updates.push(`in_stock = $${values.length}`);
    }
    if (req.body.low_stock_threshold !== undefined) {
      const lowT = (req.body.low_stock_threshold === '' || req.body.low_stock_threshold === null) ? null : parseInt(req.body.low_stock_threshold);
      values.push(lowT); updates.push(`low_stock_threshold = $${values.length}`);
    }

    if (!updates.length && req.body.price_tiers === undefined)
      return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });

    let result;
    if (updates.length) {
      values.push(req.params.id, seller.rows[0].id);
      result = await db.query(
        `UPDATE products SET ${updates.join(',')} WHERE id = $${values.length-1} AND seller_id = $${values.length} RETURNING *`,
        values
      );
    } else {
      // تعديل الشرائح فقط — نتحقق من ملكية المنتج
      result = await db.query(
        'SELECT * FROM products WHERE id = $1 AND seller_id = $2',
        [req.params.id, seller.rows[0].id]
      );
    }

    if (!result.rows.length) return res.status(404).json({ error: 'المنتج غير موجود' });

    // مزامنة شرائح التسعير (استبدال كامل)
    if (Array.isArray(req.body.price_tiers)) {
      await db.query('DELETE FROM price_tiers WHERE product_id = $1', [req.params.id]);
      for (const t of req.body.price_tiers) {
        const mq = parseInt(t.min_qty);
        const up = parseFloat(t.unit_price);
        if (mq > 0 && up >= 0) {
          await db.query(
            'INSERT INTO price_tiers (product_id, min_qty, unit_price) VALUES ($1,$2,$3)',
            [req.params.id, mq, up]
          );
        }
      }
    }

    res.json({ message: 'تم تحديث المنتج', product: result.rows[0] });

  } catch (err) {
    console.error('PUT /products/:id error:', err);
    res.status(500).json({ error: 'خطأ في الخادم', details: err.message, code: err.code });
  }
});

// ─── DELETE product ──────────────────────────────────────
router.delete('/:id', auth(['seller','admin']), async (req, res) => {
  try {
    await db.query(
      `UPDATE products SET status = 'archived' WHERE id = $1`,
      [req.params.id]
    );
    res.json({ message: 'تم حذف المنتج' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});
// POST /api/products/:id/image
router.post('/:id/image', auth(['seller']), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع صورة' });
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'syriaexpress/products' },
        (error, result) => { if (error) reject(error); else resolve(result); }
      ).end(req.file.buffer);
    });
    await db.query('UPDATE products SET image_url = $1 WHERE id = $2', [result.secure_url, req.params.id]);
    res.json({ image_url: result.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل رفع الصورة' });
  }
});
module.exports = router;
