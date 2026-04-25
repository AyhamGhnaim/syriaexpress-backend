const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../config/db');

// ─── Register ───────────────────────────────────────────
// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, phone, password, user_type, governorate } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();

  try {
    // Check email exists
    const exists = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    if (exists.rows.length > 0)
      return res.status(400).json({ error: 'البريد الإلكتروني مسجّل مسبقاً' });

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Insert user
    const result = await db.query(
      `INSERT INTO users (name, email, phone, password_hash, user_type, governorate)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, user_type, governorate, created_at`,
      [name, email, phone, password_hash, user_type || 'buyer', governorate]
    );

    const user = result.rows[0];

    // If seller → create seller profile + verification request
    if (user_type === 'seller') {
      const { company_name_ar, company_name_en, activity_type } = req.body;

      const sellerResult = await db.query(
        `INSERT INTO sellers (user_id, company_name_ar, company_name_en, activity_type, governorate)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [user.id, company_name_ar, company_name_en, activity_type, governorate]
      );

      await db.query(
        `INSERT INTO verification_requests (seller_id) VALUES ($1)`,
        [sellerResult.rows[0].id]
      );
    }

    // Generate token
    const token = jwt.sign(
      { id: user.id, email: user.email, user_type: user.user_type },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({ message: 'تم إنشاء الحساب بنجاح', token, user });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Login ───────────────────────────────────────────────
// POST /api/auth/login
router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const { password } = req.body;

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE LOWER(email) = $1 AND is_active = true',
      [email]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ error: 'البريد أو كلمة المرور غير صحيحة' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid)
      return res.status(401).json({ error: 'البريد أو كلمة المرور غير صحيحة' });

    const token = jwt.sign(
      { id: user.id, email: user.email, user_type: user.user_type },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // If seller, get seller info
    let sellerInfo = null;
    if (user.user_type === 'seller') {
      const s = await db.query(
        'SELECT id, company_name_ar, partner_tier, verification_status FROM sellers WHERE user_id = $1',
        [user.id]
      );
      sellerInfo = s.rows[0] || null;
    }

    res.json({
      message: 'تم تسجيل الدخول بنجاح',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        user_type: user.user_type,
        governorate: user.governorate,
        seller: sellerInfo
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Get current user ────────────────────────────────────
// GET /api/auth/me
const auth = require('../middleware/auth');
router.get('/me', auth(), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, email, phone, user_type, governorate, created_at, avatar_url FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Change Password ─────────────────────────────────────
// PUT /api/auth/change-password
router.put('/change-password', auth(), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'يرجى إدخال كلمة المرور الحالية والجديدة' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
    }

    // جلب كلمة المرور الحالية من الداتابيز
    const { rows } = await db.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    // التحقق من كلمة المرور الحالية
    const isMatch = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
    }

    // تشفير كلمة المرور الجديدة وتحديثها
    const newHash = await bcrypt.hash(new_password, 12);
    await db.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ message: 'تم تغيير كلمة المرور بنجاح' });

  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'خطأ في تغيير كلمة المرور' });
  }
});

// ─── Upload Avatar ───────────────────────────────────────
// POST /api/auth/avatar
const cloudinary = require('../config/cloudinary');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/avatar', auth(), upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع صورة' });

    const b64 = req.file.buffer.toString('base64');
    const dataUri = `data:${req.file.mimetype};base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'syriaexpress/avatars',
      transformation: [{ width: 200, height: 200, crop: 'fill', gravity: 'face' }]
    });

    await db.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [result.secure_url, req.user.id]);

    res.json({ avatar_url: result.secure_url });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'خطأ في رفع الصورة' });
  }
});

// ─── Update profile (email, phone, name) ────────────────
// PUT /api/auth/me
router.put('/me', auth(), async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const fields = [];
    const vals = [];

    if (name)  { vals.push(name.trim());  fields.push(`name=$${vals.length}`); }
    if (phone) { vals.push(phone.trim()); fields.push(`phone=$${vals.length}`); }
    if (email) {
      const newEmail = email.trim().toLowerCase();
      // Check email not taken by another user
      const exists = await db.query(
        'SELECT id FROM users WHERE LOWER(email)=$1 AND id!=$2', [newEmail, req.user.id]
      );
      if (exists.rows.length) return res.status(400).json({ error: 'البريد الإلكتروني مستخدم من حساب آخر' });
      vals.push(newEmail);
      fields.push(`email=$${vals.length}`);
    }

    if (!fields.length) return res.status(400).json({ error: 'لا توجد بيانات للتحديث' });

    vals.push(req.user.id);
    const result = await db.query(
      `UPDATE users SET ${fields.join(',')} WHERE id=$${vals.length} RETURNING id,name,email,phone,user_type,governorate`,
      vals
    );
    res.json({ message: 'تم تحديث البيانات بنجاح', user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Delete account ───────────────────────────────────────
// DELETE /api/auth/me — حذف الحساب كاملاً مع كل البيانات
router.delete('/me', auth(), async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.id;

    // جلب seller_id إن وُجد
    const sellerRes = await client.query('SELECT id FROM sellers WHERE user_id = $1', [userId]);
    const sellerId = sellerRes.rows[0]?.id;

    if (sellerId) {
      await client.query('DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE seller_id = $1)', [sellerId]);
      await client.query('DELETE FROM saved_products WHERE product_id IN (SELECT id FROM products WHERE seller_id = $1)', [sellerId]);
      await client.query('DELETE FROM reviews WHERE product_id IN (SELECT id FROM products WHERE seller_id = $1)', [sellerId]);
      await client.query('DELETE FROM cart_items WHERE product_id IN (SELECT id FROM products WHERE seller_id = $1)', [sellerId]);
      await client.query('DELETE FROM products WHERE seller_id = $1', [sellerId]);
      await client.query('DELETE FROM seller_documents WHERE seller_id = $1', [sellerId]);
      await client.query('DELETE FROM verification_requests WHERE seller_id = $1', [sellerId]);
      await client.query('DELETE FROM orders WHERE seller_id = $1', [sellerId]);
      await client.query('DELETE FROM sellers WHERE id = $1', [sellerId]);
    }

    // حذف بيانات المشتري
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM saved_products WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM reviews WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM orders WHERE buyer_id = $1', [userId]);
    await client.query('DELETE FROM audit_log WHERE user_id = $1', [userId]);

    // حذف المستخدم نهائياً
    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    await client.query('COMMIT');
    res.json({ message: 'تم حذف الحساب نهائياً' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

// ─── Delete Avatar ───────────────────────────────────────
// DELETE /api/auth/avatar
router.delete('/avatar', auth(), async (req, res) => {
  try {
    await db.query('UPDATE users SET avatar_url = NULL WHERE id = $1', [req.user.id]);
    res.json({ message: 'تم حذف الصورة' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
