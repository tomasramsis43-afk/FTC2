const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ متغيّر البيئة JWT_SECRET غير موجود. راجع ملف .env.example');
  process.exit(1);
}

function signToken(user) {
  return jwt.sign(
    // أضفنا role داخل التوكن نفسه، حتى تصل صلاحية المستخدم (admin/staff) إلى الواجهة
    // فوراً بعد الدخول. tv (token_version) تُستخدم في requireAuth أدناه للتحقق من
    // أن هذا التوكن لم يُبطَل بعد (تسجيل خروج، تغيير كلمة مرور، تغيير صلاحية، حذف الحساب).
    { sub: user.id, username: user.username, role: user.role || 'staff', tv: user.token_version || 0 },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'لم يتم تسجيل الدخول' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً' });
  }
  try {
    const r = await pool.query('SELECT role, token_version FROM server_users WHERE id = $1', [payload.sub]);
    const dbUser = r.rows[0];
    // dbUser غير موجود = تم حذف الحساب. token_version مختلف = تم تسجيل خروج/تغيير كلمة
    // مرور أو صلاحية بعد إصدار هذا التوكن. في الحالتين نرفض التوكن فوراً بدل انتظار انتهائه.
    if (!dbUser || (payload.tv || 0) !== dbUser.token_version) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً' });
    }
    // نأخذ role من القاعدة الآن وليس من داخل التوكن القديم، حتى يُطبَّق أي تغيير
    // صلاحية فوراً على أي جلسة مفتوحة لنفس المستخدم دون انتظار تسجيل دخول جديد.
    req.user = { sub: payload.sub, username: payload.username, role: dbUser.role };
    next();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'تعذّر التحقق من الجلسة' });
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
