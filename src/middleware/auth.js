const jwt = require('jsonwebtoken');
const db = require('../config/db');

// ─── تتبّع «آخر ظهور» (مكبوح + fire-and-forget) ───────────────────
// نكتب last_seen مرة كل 5 دقائق كحدّ أقصى لكل مستخدم، خارج المسار الحرج للطلب.
// الكبح in-memory يوفّر معظم الكتابات؛ لا ينتظر ولا يكسر الطلب لو فشل.
const SEEN_THROTTLE_MS = 5 * 60 * 1000;
const lastSeenAt = new Map(); // userId -> آخر كتابة (epoch ms)
function touchLastSeen(userId) {
  if (!userId) return;
  const now = Date.now();
  const prev = lastSeenAt.get(userId);
  if (prev && (now - prev) < SEEN_THROTTLE_MS) return; // مكبوح — لا كتابة
  lastSeenAt.set(userId, now);
  // ضبط حجم الذاكرة: كنس المداخل المنتهية إن كبر الـ Map
  if (lastSeenAt.size > 5000) {
    for (const [k, t] of lastSeenAt) {
      if ((now - t) > SEEN_THROTTLE_MS) lastSeenAt.delete(k);
    }
  }
  db.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId])
    .catch(() => {}); // fire-and-forget
}

const auth = (roles = []) => {
  return async (req, res, next) => {
    let decoded;
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'غير مصرح — يجب تسجيل الدخول' });

      decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;

      if (roles.length > 0 && !roles.includes(decoded.user_type)) {
        return res.status(403).json({ error: 'غير مسموح — صلاحيات غير كافية' });
      }
    } catch (err) {
      return res.status(401).json({ error: 'جلسة منتهية — الرجاء تسجيل الدخول مجدداً' });
    }

    // إنفاذ التوقيف: التوكن صالح لكن الحساب قد يكون موقوفاً/محذوفاً بعد إصداره.
    // fail-open عند خلل DB عابر (لا نسقط كل الـ API) — الاستعلامات اللاحقة ستفشل بأي حال.
    try {
      const chk = await db.query('SELECT is_active FROM users WHERE id = $1', [decoded.id]);
      if (chk.rows.length === 0) {
        // مستخدم محذوف وتوكنه ما زال حياً
        return res.status(401).json({ error: 'جلسة منتهية — الرجاء تسجيل الدخول مجدداً' });
      }
      if (chk.rows[0].is_active === false) {
        return res.status(401).json({ error: 'الحساب موقوف — يرجى التواصل مع الإدارة', code: 'ACCOUNT_SUSPENDED' });
      }
    } catch (dbErr) {
      console.error('auth is_active check failed (fail-open):', dbErr.message);
    }

    // تحديث «آخر ظهور» لمستخدم صالح وفعّال (مكبوح، لا ينتظر)
    touchLastSeen(decoded.id);

    next();
  };
};

module.exports = auth;
