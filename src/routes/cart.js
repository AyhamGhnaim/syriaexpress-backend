const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// GET /api/cart
router.get('/', auth(['buyer']), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ci.*, p.name_ar, p.name_en, p.unit, p.min_order_quantity,
              s.company_name_ar, s.partner_tier,
              (SELECT image_url FROM product_images WHERE product_id=p.id AND is_primary=true LIMIT 1) as product_image
       FROM cart_items ci
       JOIN products p ON ci.product_id=p.id
       JOIN sellers  s ON p.seller_id=s.id
       WHERE ci.buyer_id=$1`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/cart
router.post('/', auth(['buyer']), async (req, res) => {
  const { product_id, quantity, shipping_type, notes } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO cart_items (buyer_id,product_id,quantity,shipping_type,notes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (buyer_id,product_id) DO UPDATE SET quantity=$3,shipping_type=$4,notes=$5
       RETURNING *`,
      [req.user.id, product_id, quantity, shipping_type, notes]
    );
    res.json({ message: 'تمت الإضافة للسلة', item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// DELETE /api/cart/:product_id
router.delete('/:product_id', auth(['buyer']), async (req, res) => {
  try {
    await db.query('DELETE FROM cart_items WHERE buyer_id=$1 AND product_id=$2', [req.user.id, req.params.product_id]);
    res.json({ message: 'تم الحذف من السلة' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/cart/checkout — convert cart to orders
router.post('/checkout', auth(['buyer']), async (req, res) => {
  try {
    const items = await db.query(
      'SELECT * FROM cart_items WHERE buyer_id=$1', [req.user.id]
    );
    if (!items.rows.length) return res.status(400).json({ error: 'السلة فارغة' });

    const orders = [];
    for (const item of items.rows) {
      const product = await db.query(
        'SELECT p.*, s.id as seller_id FROM products p JOIN sellers s ON p.seller_id=s.id WHERE p.id=$1',
        [item.product_id]
      );
      if (!product.rows.length) continue;
      const p = product.rows[0];

      const order = await db.query(
        `INSERT INTO orders (buyer_id,seller_id,product_id,quantity,shipping_type,notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.user.id, p.seller_id, item.product_id, item.quantity, item.shipping_type, item.notes]
      );
      orders.push(order.rows[0].id);
    }

    // Clear cart
    await db.query('DELETE FROM cart_items WHERE buyer_id=$1', [req.user.id]);

    res.json({ message: `تم إرسال ${orders.length} طلب بنجاح`, order_ids: orders });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
