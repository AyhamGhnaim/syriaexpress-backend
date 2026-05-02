require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');

const app = express();app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) { callback(null, true); },
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
  skip: (req) => req.path === '/api/health'
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

// 3) register — منع spam حسابات
const registerLimiter = rateLimit({
  ...baseLimit,
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'عدد كبير من محاولات التسجيل، انتظر ساعة' }
});

// 4) change-password — حساس لكن نادر
const passwordLimiter = rateLimit({
  ...baseLimit,
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'محاولات كثيرة لتغيير كلمة السر، انتظر 15 دقيقة' }
});

// تطبيق الـ limiters قبل الـ routes
app.use('/api', generalLimiter);
app.use('/api/auth/login',           loginLimiter);
app.use('/api/auth/register',        registerLimiter);
app.use('/api/auth/change-password', passwordLimiter);

// ─── Routes ───────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/products',      require('./routes/products'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/sellers',       require('./routes/sellers'));
app.use('/api/cart',          require('./routes/cart'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin',         require('./routes/admin'));

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
  res.json({ status: 'ok', message: 'SyriaExpress API is running 🚀', time: new Date() });
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SyriaExpress API running on port ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/api/health`);
});

module.exports = app;
