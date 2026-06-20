// ─── قارئ إعدادات المنصّة (platform_settings) مع كاش بالذاكرة ───
// يُستهلك في مسارات ساخنة (middleware الصيانة، التسجيل، إنشاء الطلب)،
// فالكاش يقلّل ضرب قاعدة البيانات عبر الـ pooler. القيم jsonb:
// boolean/number ترجع كأنواع JS مباشرة من node-pg.
const db = require('../config/db');

let cache = null;            // { key: value }
let cacheAt = 0;
const TTL_MS = 60 * 1000;    // تحديث كل دقيقة

async function refresh() {
  const r = await db.query('SELECT key, value FROM platform_settings');
  const m = {};
  r.rows.forEach(row => { m[row.key] = row.value; });
  cache = m;
  cacheAt = Date.now();
  return m;
}

// يرجع خريطة الإعدادات (من الكاش إن كان حديثاً، وإلا يحدّث).
// fail-soft: عند فشل القراءة يرجع آخر كاش معروف أو {} — لا يرمي.
async function getAll() {
  if (cache && (Date.now() - cacheAt) < TTL_MS) return cache;
  try {
    return await refresh();
  } catch (e) {
    console.error('⚠️ settings refresh failed:', e.message);
    return cache || {};
  }
}

// قراءة منطقية: تقبل boolean الحقيقي أو نص "true"/"false". خلاف ذلك → fallback.
async function getBool(key, fallback = false) {
  const all = await getAll();
  const v = all[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string')  return v.trim().toLowerCase() === 'true';
  return fallback;
}

// قراءة عددية: تقبل number أو نصاً رقمياً. غير ذلك → fallback.
async function getNumber(key, fallback = 0) {
  const all = await getAll();
  const n = parseFloat(all[key]);
  return Number.isFinite(n) ? n : fallback;
}

// تفريغ الكاش — يُستدعى بعد تحديث إعداد ليصبح أثره فورياً.
function invalidate() { cache = null; cacheAt = 0; }

module.exports = { getAll, getBool, getNumber, invalidate, refresh };
