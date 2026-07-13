const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../config/db');
const { normalizePhone } = require('../utils/phone');
const settings = require('../utils/settings');

// ─── Register ───────────────────────────────────────────
// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { password, user_type } = req.body;
  const name        = (req.body.name || '').trim();
  const phoneRaw    = (req.body.phone || '').trim();
  const emailRaw    = (req.body.email || '').trim().toLowerCase();
  const email       = emailRaw || null;                 // اختياري → NULL لا ''
  const phone_normalized = normalizePhone(phoneRaw);
  const governorate = (req.body.governorate || '').trim();

  try {
    // ── تحقّق المُدخلات ──
    if (!name)
      return res.status(400).json({ error: 'يرجى إدخال الاسم' });
    if (!phoneRaw)
      return res.status(400).json({ error: 'رقم الهاتف مطلوب' });
    if (!/^[\d\s+\-()]+$/.test(phoneRaw) || phone_normalized.length < 9)
      return res.status(400).json({ error: 'رقم الهاتف غير صالح' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'البريد الإلكتروني غير صالح' });
    if (!password || password.length < 8)
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });

    // قائمة بيضاء لنوع الحساب — التسجيل الذاتي للمشتري/البائع فقط.
    // (القاعدة تحمي أصلاً عبر users_user_type_check؛ هذا تحقّق خادمي مبكّر برسالة واضحة
    //  بدل خطأ 23514 خام. غياب القيمة يبقى كما هو → 'buyer' عند الإدراج.)
    if (user_type !== undefined && user_type !== null && user_type !== '' &&
        !['buyer', 'seller'].includes(user_type)) {
      return res.status(400).json({ error: 'نوع الحساب غير صالح' });
    }

    // البائعون يجب أن يكونوا داخل سوريا
    if (user_type === 'seller' && governorate === 'خارج سوريا') {
      return res.status(400).json({ error: 'البائعون يجب أن يكونوا داخل سوريا' });
    }

    // بوّابة تسجيل المشترين (إعداد منصّة) — البائعون لا يتأثرون
    const isSeller = user_type === 'seller';
    if (!isSeller) {
      const buyerOpen = await settings.getBool('buyer_open_registration', true);
      if (!buyerOpen)
        return res.status(403).json({ error: 'تسجيل المشترين مغلق حالياً' });
    }
    // توثيق تلقائي للبائع عند إيقاف التوثيق اليدوي (الافتراضي: يدوي)
    const autoVerify = isSeller && !(await settings.getBool('seller_manual_verify', true));

    // ── فحص الفرادة (مسار سريع ودود؛ القيود تحمي من السباق) ──
    const dupPhone = await db.query(
      'SELECT 1 FROM users WHERE phone_normalized = $1', [phone_normalized]
    );
    if (dupPhone.rows.length)
      return res.status(400).json({ error: 'رقم الهاتف مسجّل مسبقاً' });

    if (email) {
      const dupEmail = await db.query(
        'SELECT 1 FROM users WHERE LOWER(email) = $1', [email]
      );
      if (dupEmail.rows.length)
        return res.status(400).json({ error: 'البريد الإلكتروني مسجّل مسبقاً' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // ── إنشاء ذرّي: user + seller + verification في معاملة واحدة ──
    const client = await db.connect();
    let user, newSellerId = null;
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO users (name, email, phone, phone_normalized, password_hash, user_type, governorate)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, email, user_type, governorate, created_at`,
        [name, email, phoneRaw, phone_normalized, password_hash, user_type || 'buyer', governorate]
      );
      user = result.rows[0];

      // If seller → create seller profile + verification request
      if (user_type === 'seller') {
        const { company_name_ar, company_name_en, activity_type } = req.body;

        const sellerResult = await client.query(
          `INSERT INTO sellers (user_id, company_name_ar, company_name_en, activity_type, governorate)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [user.id, company_name_ar, company_name_en, activity_type, governorate]
        );

        await client.query(
          `INSERT INTO verification_requests (seller_id) VALUES ($1)`,
          [sellerResult.rows[0].id]
        );
        newSellerId = sellerResult.rows[0].id;

        // توثيق تلقائي (seller_manual_verify=false): يوثّق البائع فوراً
        if (autoVerify) {
          await client.query(
            `UPDATE sellers SET verification_status='verified', verified_at=NOW() WHERE id=$1`,
            [newSellerId]
          );
          await client.query(
            `UPDATE verification_requests SET status='approved', reviewed_at=NOW() WHERE seller_id=$1`,
            [newSellerId]
          );
        }
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // إشعار الأدمن: طلب توثيق جديد بانتظار المراجعة (مجمّع — نداء واحد غير مقروء لكل أدمن).
    // خارج المعاملة — فشله يجب ألا يؤثر على إنشاء الحساب.
    if (user_type === 'seller' && newSellerId && !autoVerify) {
      try {
        await db.query(
          `INSERT INTO notifications (user_id, type, title_ar, body_ar, ref_type, ref_id)
           SELECT u.id, 'verification_pending', 'طلبات توثيق بانتظار المراجعة',
                  'هناك بائع جديد بانتظار توثيق حسابه — افتح مراجعة التوثيق', 'admin_verifications', $1
           FROM users u
           WHERE u.user_type = 'admin'
             AND NOT EXISTS (
               SELECT 1 FROM notifications n
               WHERE n.user_id = u.id AND n.type = 'verification_pending' AND n.is_read IS NOT TRUE
             )`,
          [newSellerId]
        );
      } catch (e) { console.error('admin verification_pending notify failed:', e.message); }
    }

    // Generate token
    const token = jwt.sign(
      { id: user.id, email: user.email, user_type: user.user_type, governorate: user.governorate },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({ message: 'تم إنشاء الحساب بنجاح', token, user });

  } catch (err) {
    // شبكة أمان ضد سباق الفرادة (race) — القيود تردّ بـ 23505
    if (err && err.code === '23505') {
      if (err.constraint === 'uniq_users_phone_normalized')
        return res.status(400).json({ error: 'رقم الهاتف مسجّل مسبقاً' });
      if (err.constraint === 'users_email_key')
        return res.status(400).json({ error: 'البريد الإلكتروني مسجّل مسبقاً' });
      return res.status(400).json({ error: 'الحساب مسجّل مسبقاً' });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Login ───────────────────────────────────────────────
// POST /api/auth/login
router.post('/login', async (req, res) => {
  // مُعرّف مزدوج: identifier (الجديد) أو email (توافق رجعي مع الواجهة القديمة)
  const identifierRaw = (req.body.identifier || req.body.email || '').trim();
  const { password } = req.body;

  try {
    if (!identifierRaw || !password)
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    // حلّ الحساب server-side: فيه @ → بريد، وإلا → هاتف عبر phone_normalized.
    // العميل لا يرى أبداً المُعرّف الآخر → لا تسريب phone→email.
    let result;
    if (identifierRaw.includes('@')) {
      result = await db.query(
        'SELECT * FROM users WHERE LOWER(email) = $1 AND is_active = true',
        [identifierRaw.toLowerCase()]
      );
    } else {
      result = await db.query(
        'SELECT * FROM users WHERE phone_normalized = $1 AND is_active = true',
        [normalizePhone(identifierRaw)]
      );
    }

    // anti-enumeration: نفس الرسالة لـ (غير موجود / غير مفعّل / كلمة سر خاطئة)
    if (result.rows.length === 0)
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid)
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const token = jwt.sign(
      { id: user.id, email: user.email, user_type: user.user_type, governorate: user.governorate },
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

    if (new_password.length < 8) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل' });
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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  // صور فقط؛ نوع مرفوض → req.file غائب → 400 القائم
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype || ''))
});

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
    const { name, phone, email, governorate } = req.body;
    const fields = [];
    const vals = [];

    if (name)  { vals.push(name.trim());  fields.push(`name=$${vals.length}`); }
    if (phone) {
      const phoneTrim = phone.trim();
      const pn = normalizePhone(phoneTrim);
      if (!/^[\d\s+\-()]+$/.test(phoneTrim) || pn.length < 9)
        return res.status(400).json({ error: 'رقم الهاتف غير صالح' });
      // فرادة الرقم المطبَّع (سدّ ثغرة: كان يُغيَّر بلا فحص)
      const taken = await db.query(
        'SELECT id FROM users WHERE phone_normalized = $1 AND id != $2', [pn, req.user.id]
      );
      if (taken.rows.length)
        return res.status(400).json({ error: 'رقم الهاتف مستخدم من حساب آخر' });
      vals.push(phoneTrim); fields.push(`phone=$${vals.length}`);
      vals.push(pn);        fields.push(`phone_normalized=$${vals.length}`);
    }
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
    if (governorate !== undefined) {
      const gov = (governorate || '').trim();
      // البائعون يجب أن يكونوا داخل سوريا
      if (gov === 'خارج سوريا' && req.user.user_type === 'seller') {
        return res.status(400).json({ error: 'البائعون يجب أن يكونوا داخل سوريا' });
      }
      vals.push(gov);
      fields.push(`governorate=$${vals.length}`);
    }

    if (!fields.length) return res.status(400).json({ error: 'لا توجد بيانات للتحديث' });

    vals.push(req.user.id);
    const result = await db.query(
      `UPDATE users SET ${fields.join(',')} WHERE id=$${vals.length} RETURNING id,name,email,phone,user_type,governorate`,
      vals
    );
    const updatedUser = result.rows[0];
    const newToken = jwt.sign(
      { id: updatedUser.id, email: updatedUser.email, user_type: updatedUser.user_type, governorate: updatedUser.governorate },
      process.env.JWT_SECRET || 'syriaexpress_secret_2025_ayham',
      { expiresIn: '7d' }
    );
    res.json({ message: 'تم تحديث البيانات بنجاح', user: updatedUser, token: newToken });
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

    // حذف بيانات المشتري — cart_items/reviews=buyer_id، الباقي=user_id
    await client.query('DELETE FROM cart_items WHERE buyer_id = $1', [userId]);
    await client.query('DELETE FROM saved_products WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM reviews WHERE buyer_id = $1', [userId]);
    await client.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM orders WHERE buyer_id = $1', [userId]);
    await client.query('DELETE FROM buyer_addresses WHERE user_id = $1', [userId]);
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
