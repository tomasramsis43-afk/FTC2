const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ متغيّر البيئة JWT_SECRET غير موجود. راجع ملف .env.example');
  process.exit(1);
}

function signToken(user) {
  return jwt.sign(
    // أضفنا role داخل التوكن نفسه، حتى تصل صلاحية المستخدم (admin/staff) إلى الواجهة
    // ويُتحقّق منها أيضاً في أي مسار حساس عبر requireRole أدناه.
    { sub: user.id, username: user.username, role: user.role || 'staff' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'لم يتم تسجيل الدخول' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً' });
  }
}

/* حارس إضافي اختياري: يُستخدم بعد requireAuth على أي مسار تريد قصره على المدراء فقط
   (مثال: app.delete('/api/storage/:key', requireAuth, requireRole('admin'), ...)).
   بهذا يصبح تقييد الصلاحيات فعلياً على مستوى الخادم، وليس مجرد إخفاء أزرار في الواجهة. */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'ليست لديك صلاحية كافية لتنفيذ هذا الإجراء' });
    }
    next();
  };
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}
async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

module.exports = { signToken, requireAuth, requireRole, hashPassword, verifyPassword };
