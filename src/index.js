require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const app = express();app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────
// helmet: security headers (X-Content-Type-Options, HSTS, frameguard...) — آمن لـ API يخدم JSON فقط
app.use(helmet());

// CORS مقيّد: نطاقات الواجهة المعروفة فقط.
// الطلبات بلا Origin (curl / keep-alive / server-to-server) تمرّ — لا تُرسَل لها headers أصلاً.
const ALLOWED_ORIGINS = [
  'https://syriaexpressapp.com',
  'https://www.syriaexpressapp.com',
  'https://ayhamghnaim.github.io'   // GitHub Pages المباشر (تحقّق سريع بتجاوز Cloudflare)
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(null, false); // غير مسموح: بلا CORS headers (المتصفح يحجب) — لا 500
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate limiting ────────────────────────────────────────
// إعدادات مشتركة: ترسل headers معيارية ولا تحسب طلبات health
const baseLimit = {
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health'
};

// 1) عام لكل /api — يسمح بتصفح مريح
const generalLimiter = rateLimit({
  ...baseLimit,
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'طلبات كثيرة، حاول بعد قليل' }
});

// 2) login — صارم ضد brute force، يتجاهل المحاولات الناجحة
const loginLimiter = rateLimit({
  ...baseLimit,
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'محاولات دخول كثيرة، انتظر 15 دقيقة' }
});

// 3) register — منع spam، يتجاهل التسجيل الناجح
const registerLimiter = rateLimit({
  ...baseLimit,
  windowMs: 60 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: { error: 'عدد كبير من محاولات التسجيل، انتظر ساعة' }
});

// 4) change-password — حساس لكن نادر
const passwordLimiter = rateLimit({
  ...baseLimit,
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: { error: 'محاولات كثيرة لتغيير كلمة السر، انتظر 15 دقيقة' }
});

// تطبيق الـ limiters قبل الـ routes
app.use('/api', generalLimiter);
app.use('/api/auth/login',           loginLimiter);
app.use('/api/auth/register',        registerLimiter);
app.use('/api/auth/change-password', passwordLimiter);

// ─── Maintenance mode (صيانة ناعمة) ───────────────────────
// عند تفعيل maintenance_mode: تُمنع العمليات (POST/PUT/PATCH/DELETE) لغير
// الأدمن (503)، بينما يبقى متاحاً دائماً: التصفّح (GET/OPTIONS)، /health
// (المراقبة + self-ping)، و /auth/login (ليتمكّن الأدمن من الدخول وإيقاف
// الصيانة). الأدمن يتجاوز كلياً. fail-open: أي خطأ → المرور (لا قفل غلطاً).
const settings = require('./utils/settings');
const jwtMaint = require('jsonwebtoken');
app.use('/api', async (req, res, next) => {
  if (req.method === 'GET' || req.method === 'OPTIONS') return next();
  if (req.path === '/health' || req.path === '/auth/login') return next();

  let on = false;
  try { on = await settings.getBool('maintenance_mode', false); } catch (_) { on = false; }
  if (!on) return next();

  // الأدمن يتجاوز الصيانة
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      const decoded = jwtMaint.verify(token, process.env.JWT_SECRET);
      if (decoded.user_type === 'admin') return next();
    }
  } catch (_) { /* توكن غير صالح → يُعامَل كغير أدمن */ }

  return res.status(503).json({ error: 'المنصّة في وضع الصيانة حالياً، يرجى المحاولة لاحقاً' });
});

// ─── Routes ───────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/products',      require('./routes/products'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/sellers',       require('./routes/sellers'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/reviews',       require('./routes/reviews'));
app.use('/api/coupons',       require('./routes/coupons'));
app.use('/api/saved',         require('./routes/saved'));
app.use('/api/addresses',     require('./routes/addresses'));

// ─── Categories (public) ─────────────────────────────────
const db = require('./config/db');
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name_ar, name_en, slug, status, icon, sort_order
       FROM categories
       WHERE status != 'inactive'
       ORDER BY sort_order`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── Health check ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  // version = علامة نشر: تتغيّر مع كل دفعة لتأكيد أن Render خدم آخر كود (آخرها: إنفاذ التوقيف بالـ middleware)
  res.json({ status: 'ok', message: 'SyriaExpress API is running 🚀', version: 'suspend-enforce', time: new Date() });
});

// ─── 404 handler ─────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `المسار ${req.path} غير موجود` });
});

// ─── Error handler ───────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'خطأ غير متوقع في الخادم' });
});

// ─── Start server ─────────────────────────────────────────

// ─── Global error handlers (منع crash غير متوقع) ────────
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SyriaExpress API running on port ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/api/health`);

  // ─── Auto-migration: ensure products.status accepts 'inactive' ───
  (async () => {
    try {
      await db.query(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check`);
      await db.query(`ALTER TABLE products ADD CONSTRAINT products_status_check CHECK (status IN ('active','inactive','archived','draft','pending'))`);
      console.log('✅ products_status_check constraint updated');
    } catch (e) {
      console.error('⚠️ migration error:', e.message);
    }
  })();

  // ─── Self-ping كل 14 دقيقة لمنع نوم Render ────────────
  if (process.env.NODE_ENV === 'production') {
    setInterval(() => {
      const https = require('https');
      https.get('https://syriaexpress-backend.onrender.com/api/health', (res) => {
        console.log(`🏓 Self-ping: ${res.statusCode}`);
      }).on('error', (e) => {
        console.error(`🏓 Self-ping failed: ${e.message}`);
      });
    }, 14 * 60 * 1000); // كل 14 دقيقة
  }
});

module.exports = app;
