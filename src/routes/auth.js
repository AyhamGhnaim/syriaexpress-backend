const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../config/db');

// ─── Register ───────────────────────────────────────────
// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, phone, password, user_type, governorate } = req.body;

  try {
    // Check email exists
    const exists = await db.query('SELECT id FROM users WHERE email = $1', [email]);
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
  const { email, password } = req.body;

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
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
      'SELECT id, name, email, phone, user_type, governorate, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
