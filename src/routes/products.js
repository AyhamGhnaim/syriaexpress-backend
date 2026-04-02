const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// ─── GET all active products ─────────────────────────────
// GET /api/products?category=food&governorate=دمشق&shipping=inside&page=1
router.get('/', async (req, res) => {
  try {
    const { category, governorate, shipping, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let where = [];

    if (category) {
      params.push(category);
      where.push(`category_slug = $${params.length}`);
    }
    if (governorate) {
      params.push(governorate);
      where.push(`seller_governorate = $${params.length}`);
    }
    if (shipping === 'inside')        where.push('ship_inside = true');
    if (shipping === 'outside')       where.push('ship_outside = true');
    if (shipping === 'international') where.push('ship_international = true');
    if (search) {
      params.push(`%${search}%`);
      where.push(`(name_ar ILIKE $${params.length} OR name_en ILIKE $${params.length} OR company_name_ar ILIKE $${params.length})`);
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    params.push(limit, offset);
    const query = `
      SELECT * FROM v_products_full
      ${whereClause}
      ORDER BY partner_tier = 'gold' DESC, partner_tier = 'silver' DESC, views_count DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const result = await db.query(query, params);

    // Count total
    const countResult = await db.query(
      `SELECT COUNT(*) FROM v_products_full ${whereClause}`,
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

// ─── GET single product ──────────────────────────────────
// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, s.company_name_ar, s.company_name_en, s.partner_tier,
              s.governorate as seller_governorate, s.description as seller_description,
              c.name_ar as category_name_ar, c.slug as category_slug,
              u.phone as seller_phone, u.email as seller_email
       FROM products p
       JOIN sellers s ON p.seller_id = s.id
       JOIN categories c ON p.category_id = c.id
       JOIN users u ON s.user_id = u.id
       WHERE p.id = $1 AND p.status = 'active'`,
      [req.params.id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: 'المنتج غير موجود' });

    // Get images
    const images = await db.query(
      'SELECT * FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, sort_order',
      [req.params.id]
    );

    // Get reviews
    const reviews = await db.query(
      `SELECT r.*, u.name as buyer_name
       FROM reviews r JOIN users u ON r.buyer_id = u.id
       WHERE r.seller_id = $1 ORDER BY r.created_at DESC LIMIT 5`,
      [result.rows[0].seller_id]
    );

    // Increment views
    await db.query('UPDATE products SET views_count = views_count + 1 WHERE id = $1', [req.params.id]);

    res.json({
      ...result.rows[0],
      images: images.rows,
      reviews: reviews.rows
    });

  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── CREATE product (seller only) ───────────────────────
// POST /api/products
router.post('/', auth(['seller']), async (req, res) => {
  try {
    const {
      category_id, name_ar, name_en, description_ar, description_en,
  min_order_quantity, unit, price,
      ship_inside, ship_outside, ship_international,
      ship_price_inside, ship_price_outside, ship_price_intl
    } = req.body;

    // Get seller_id from user
    const seller = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows.length) return res.status(403).json({ error: 'لست بائعاً معتمداً' });

    const result = await db.query(
 const result = await db.query(
  `INSERT INTO products
  (seller_id, category_id, name_ar, name_en, description_ar, description_en,
  min_order_quantity, unit, price, ship_inside, ship_outside, ship_international,
  ship_price_inside, ship_price_outside, ship_price_intl, status)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active')
  RETURNING *`,
  [seller.rows[0].id, category_id, name_ar, name_en, description_ar, description_en,
  min_order_quantity || 1, unit || 'كرتون', price || 0, ship_inside || true,
  ship_outside || false, ship_international || false,
  ship_price_inside, ship_price_outside, ship_price_intl]
);
    );

    res.status(201).json({ message: 'تم إضافة المنتج كمسودة', product: result.rows[0] });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── UPDATE product ──────────────────────────────────────
// PUT /api/products/:id
router.put('/:id', auth(['seller']), async (req, res) => {
  try {
    const seller = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows.length) return res.status(403).json({ error: 'غير مصرح' });

    const fields = ['name_ar','name_en','description_ar','description_en',
                    'min_order_quantity','unit','ship_inside','ship_outside',
                    'ship_international','ship_price_inside','ship_price_outside',
                    'ship_price_intl','status','category_id'];

    const updates = [];
    const values  = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        values.push(req.body[f]);
        updates.push(`${f} = $${values.length}`);
      }
    });

    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });

    values.push(req.params.id, seller.rows[0].id);
    const result = await db.query(
      `UPDATE products SET ${updates.join(',')} WHERE id = $${values.length-1} AND seller_id = $${values.length} RETURNING *`,
      values
    );

    if (!result.rows.length) return res.status(404).json({ error: 'المنتج غير موجود' });
    res.json({ message: 'تم تحديث المنتج', product: result.rows[0] });

  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
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

module.exports = router;
