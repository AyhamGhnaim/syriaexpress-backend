// ─── Phone normalization (Syria) ────────────────────────────
// دالة نقية حتمية: تُستخدم في الفرادة، الفهرس الفريد، ومطابقة الدخول.
// متطابقة حرفياً مع تعبير الـ backfill بـ SQL (Migration Phase 1):
//   regexp_replace(... '\D','','g') → '^00' → '^963' → '^0'
// أمثلة: 0991234567 / +963 99 123 4567 / 00963991234567 → 991234567
function normalizePhone(input) {
  let d = String(input == null ? '' : input).replace(/\D/g, ''); // أرقام فقط
  d = d.replace(/^00/, '');   // بادئة دولية 00
  d = d.replace(/^963/, '');  // رمز سوريا
  d = d.replace(/^0/, '');    // صفر trunk
  return d;
}

module.exports = { normalizePhone };
