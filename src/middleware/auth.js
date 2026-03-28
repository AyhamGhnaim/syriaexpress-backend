const jwt = require('jsonwebtoken');

const auth = (roles = []) => {
  return (req, res, next) => {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'غير مصرح — يجب تسجيل الدخول' });

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;

      if (roles.length > 0 && !roles.includes(decoded.user_type)) {
        return res.status(403).json({ error: 'غير مسموح — صلاحيات غير كافية' });
      }

      next();
    } catch (err) {
      return res.status(401).json({ error: 'جلسة منتهية — الرجاء تسجيل الدخول مجدداً' });
    }
  };
};

module.exports = auth;
