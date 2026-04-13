const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// GET /api/sellers — all verified sellers
router.get('/', async (req, res) => {
  try {
    const { tier, governorate, page = 1, limit = 20 } = req.query;
    const params = [];
    const where  = ["s.verification_status = 'verified'"];

    if (tier)        { params.push(tier);        where.push(`s.partner_tier = $${params.length}`); }
    if (governorate) { params.push(governorate);  where.push(`s.governorate = $${params.length}`); }

    params.push(limit, (page-1)*limit);
    const result = await db.query(
      `SELECT s.id, s.company_name_ar, s.company_name_en, s.partner_tier,
              s.activity_type, s.governorate, s.logo_url, s.description,
              vs.total_orders, vs.avg_rating, vs.active_products
       FROM sellers s
       LEFT JOIN v_seller_stats vs ON vs.seller_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY s.partner_tier = 'gold' DESC, s.partner_tier = 'silver' DESC, vs.total_orders DESC NULLS LAST
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});


// GET /api/sellers/me/dashboard — seller dashboard stats
router.get('/me/dashboard', auth(['seller']), async (req, res) => {
  try {
    const seller = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows.length) return res.status(403).json({ error: 'غير مصرح' });
    const sid = seller.rows[0].id;

    const [stats, recentOrders, topProducts] = await Promise.all([
      db.query('SELECT * FROM v_seller_stats WHERE seller_id = $1', [sid]),
      db.query(
        `SELECT o.*, p.name_ar, p.unit, u.name as buyer_name, u.governorate as buyer_gov
         FROM orders o JOIN products p ON o.product_id=p.id JOIN users u ON o.buyer_id=u.id
         WHERE o.seller_id=$1 ORDER BY o.created_at DESC LIMIT 5`, [sid]
      ),
      db.query(
        `SELECT p.name_ar, COUNT(o.id) as order_count
         FROM products p LEFT JOIN orders o ON o.product_id=p.id
         WHERE p.seller_id=$1 GROUP BY p.id, p.name_ar ORDER BY order_count DESC LIMIT 5`, [sid]
      )
    ]);

    res.json({
      stats:        stats.rows[0] || {},
      recentOrders: recentOrders.rows,
      topProducts:  topProducts.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// GET /api/sellers/me — get my profile
router.get('/me', auth(['seller']), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM sellers WHERE user_id = $1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'لم يُوجد' });
    res.json({ seller: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PUT /api/sellers/me — update seller profile
router.put('/me', auth(['seller']), async (req, res) => {
  try {
    const { company_name_ar, company_name_en, activity_type, governorate, address, description, established_year, phone, logo_url } = req.body;
    const result = await db.query(
      `UPDATE sellers SET company_name_ar=$1, company_name_en=$2, activity_type=$3,
       governorate=$4, address=$5, description=$6, established_year=$7, phone=$8, logo_url=$9
       WHERE user_id=$10 RETURNING *`,
      [company_name_ar, company_name_en, activity_type, governorate, address, description, established_year || null, phone || null, logo_url || null, req.user.id]
    );
    res.json({ message: 'تم تحديث الملف', seller: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});


// POST /api/sellers/documents — upload seller document
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const upload = multer({ storage: multer.memoryStorage() });

router.post('/documents', auth(['seller']), upload.single('document'), async (req, res) => {
  try {
    const seller = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows.length) return res.status(403).json({ error: 'غير مصرح' });
    const sellerId = seller.rows[0].id;

    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع أي ملف' });

    // رفع لـ Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'seller_documents', resource_type: 'auto' },
        (error, result) => { if (error) reject(error); else resolve(result); }
      );
      stream.end(req.file.buffer);
    });

    const docType = req.body.doc_type || 'document';
    const docName = req.file.originalname || docType;

    await db.query(
      `INSERT INTO seller_documents (seller_id, doc_type, doc_name, file_url)
       VALUES ($1, $2, $3, $4)`,
      [sellerId, docType, docName, uploadResult.secure_url]
    );

    res.json({ message: 'تم رفع الوثيقة', url: uploadResult.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في رفع الوثيقة' });
  }
});

// POST /api/sellers/me/logo — upload company logo
router.post('/me/logo', auth(['seller']), upload.single('logo'), async (req, res) => {
  try {
    const seller = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows.length) return res.status(403).json({ error: 'غير مصرح' });
    const sellerId = seller.rows[0].id;

    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع أي صورة' });

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'seller_logos', resource_type: 'image', transformation: [{ width: 400, height: 400, crop: 'fill' }] },
        (error, result) => { if (error) reject(error); else resolve(result); }
      );
      stream.end(req.file.buffer);
    });

    await db.query(
      'UPDATE sellers SET logo_url = $1 WHERE id = $2',
      [uploadResult.secure_url, sellerId]
    );

    res.json({ message: 'تم رفع اللوغو', logo_url: uploadResult.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في رفع اللوغو' });
  }
});

// GET /api/sellers/:id/products — products of a specific seller
router.get('/:id/products', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM v_products_full WHERE seller_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// GET /api/sellers/:id — seller details
router.get('/:id', async (req, res) => {
  try {
    const seller = await db.query(
      `SELECT s.*, vs.total_orders, vs.completed_orders, vs.avg_rating,
              vs.unique_buyers, vs.active_products
       FROM sellers s
       LEFT JOIN v_seller_stats vs ON vs.seller_id = s.id
       WHERE s.id = $1 AND s.verification_status = 'verified'`,
      [req.params.id]
    );
    if (!seller.rows.length) return res.status(404).json({ error: 'البائع غير موجود' });

    const products = await db.query(
      'SELECT * FROM v_products_full WHERE seller_id = $1 LIMIT 10',
      [req.params.id]
    );

    res.json({ ...seller.rows[0], products: products.rows });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});



module.exports = router;
