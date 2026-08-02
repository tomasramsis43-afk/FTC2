const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const otplib = require('otplib');
const crypto = require('crypto');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ متغيّر البيئة JWT_SECRET غير موجود. راجع ملف .env.example');
  process.exit(1);
}
// دعم تدوير (rotation) آمن للمفتاح: أثناء التدوير فقط، اضبط JWT_SECRET على القيمة الجديدة
// و JWT_SECRET_PREVIOUS على القيمة القديمة معاً. كل توكن جديد يُوقَّع بالمفتاح الجديد فوراً،
// بينما التوكنات القديمة (حتى 30 يوماً، مدة صلاحيتها القصوى) تظل تعمل عبر المحاولة بالمفتاح
// القديم كخط رجعة، فلا يُسجَّل خروج أي مستخدم بالقوة أثناء التدوير. بعد مرور 30 يوماً على
// التدوير (تأكد عملياً بمرور شهر كامل)، احذف JWT_SECRET_PREVIOUS نهائياً من متغيرات البيئة.
const JWT_SECRET_PREVIOUS = process.env.JWT_SECRET_PREVIOUS || '';
function verifyAnyJwtSecret(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    if (JWT_SECRET_PREVIOUS) return jwt.verify(token, JWT_SECRET_PREVIOUS);
    throw e;
  }
}

/* ---------------- حساب الطوارئ (Break-glass account) ----------------
   حساب دخول ثابت مخزّن بالكامل في متغيرات البيئة (اسم المستخدم + hash كلمة
   المرور)، مستقل تماماً عن جدول server_users وعن قاعدة البيانات بشكل عام.
   الغرض منه: ضمان إمكانية الدخول للنظام حتى لو تغيّرت قاعدة البيانات بالكامل،
   أو أُفرغت، أو حصل خطأ في جدول المستخدمين. إن لم تُضبط القيمتان في البيئة،
   يبقى هذا الحساب معطّلاً تلقائياً بدون أي تأثير على باقي النظام. */
const EMERGENCY_ADMIN_USERNAME = process.env.EMERGENCY_ADMIN_USERNAME || '';
const EMERGENCY_ADMIN_PASSWORD_HASH = process.env.EMERGENCY_ADMIN_PASSWORD_HASH || '';

async function verifyEmergencyAdmin(username, password) {
  if (!EMERGENCY_ADMIN_USERNAME || !EMERGENCY_ADMIN_PASSWORD_HASH) return false;
  if (username !== EMERGENCY_ADMIN_USERNAME) return false;
  try {
    return await bcrypt.compare(password, EMERGENCY_ADMIN_PASSWORD_HASH);
  } catch (e) {
    return false;
  }
}

function signEmergencyToken(username) {
  // صلاحية قصيرة (8 ساعات) لتقليل نافذة الخطر لو تسرّب التوكن.
  // لإبطال كل توكنات الطوارئ فوراً: امسح EMERGENCY_ADMIN_USERNAME من متغيرات البيئة
  // وأعد تشغيل السيرفر — requireAuth يرفض أي توكن طوارئ لا يطابق هذا المتغيّر.
  return jwt.sign(
    { sub: 'emergency-admin', username, role: 'admin', emergency: true },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
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
    payload = verifyAnyJwtSecret(token);
  } catch (e) {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً' });
  }
  // توكن حساب الطوارئ: لا يمر على قاعدة البيانات إطلاقاً، فيستمر في العمل حتى لو
  // كانت قاعدة البيانات غير متاحة أو تم استبدالها بالكامل. نتحقق فقط أن متغيرات
  // البيئة لا تزال تطابق نفس اسم المستخدم المذكور في التوكن (تُبطَل الجلسات القديمة
  // تلقائياً لو غُيّر EMERGENCY_ADMIN_USERNAME لاحقاً).
  if (payload.emergency && payload.sub === 'emergency-admin') {
    if (!EMERGENCY_ADMIN_USERNAME || payload.username !== EMERGENCY_ADMIN_USERNAME) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً' });
    }
    req.user = { sub: 'emergency-admin', username: payload.username, role: 'admin' };
    return next();
  }
  try {
    const r = await pool.query('SELECT role, token_version, is_active FROM server_users WHERE id = $1', [payload.sub]);
    const dbUser = r.rows[0];
    // dbUser غير موجود = تم حذف الحساب. token_version مختلف = تم تسجيل خروج/تغيير كلمة
    // مرور أو صلاحية بعد إصدار هذا التوكن. في الحالتين نرفض التوكن فوراً بدل انتظار انتهائه.
    if (!dbUser || (payload.tv || 0) !== dbUser.token_version) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً' });
    }
    // الحساب معطّل من طرف المدير: نقطع الجلسة فوراً حتى لو كان التوكن لا يزال صالحاً،
    // بدل انتظار انتهاء صلاحيته (30 يوماً).
    if (dbUser.is_active === false) {
      return res.status(401).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });
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

/* ---------------- المصادقة الثنائية (TOTP) ---------------- */
// otplib v13 يستخدم دوال مستقلة بمعاملات-كائن بدل كائن authenticator القديم (v12).
// epochTolerance:1 = تسامح خطوة واحدة (٣٠ ثانية) قبل/بعد — تعويض فروق ساعة بسيطة بين
// جهاز المستخدم والسيرفر، نفس الإعداد الافتراضي الشائع فى تطبيقات المصادقة.
function generateTotpSecret() {
  return otplib.generateSecret(); // base32
}
function totpOtpauthUrl(secret, username) {
  return otplib.generateURI({ issuer: 'FTC2', label: username, secret });
}
function verifyTotpToken(token, secret) {
  try {
    const cleaned = String(token || '').replace(/\s/g, '');
    if (!cleaned) return false;
    return !!otplib.verifySync({ secret, token: cleaned, epochTolerance: 1 }).valid;
  } catch (e) { return false; }
}
// أكواد احتياطية أحادية الاستخدام (10 أكواد، 8 أرقام لكل كود) — لحالة فقدان جهاز المصادقة.
// تُخزَّن كـ bcrypt hash فقط، وتُستهلك (تُحذف) فور استخدام أي كود منها مرة واحدة.
// أرقام عشوائية آمنة تشفيرياً (crypto.randomInt بدل Math.random — الأخير غير آمن لأكواد المصادقة).
function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(String(crypto.randomInt(10000000, 100000000)));
  }
  return codes;
}
async function hashBackupCodes(codes) {
  const hashed = [];
  for (const c of codes) hashed.push({ hash: await bcrypt.hash(c, 10), usedAt: null });
  return hashed;
}
async function consumeBackupCode(storedJson, code) {
  let list;
  try { list = JSON.parse(storedJson || '[]'); } catch (e) { list = []; }
  for (let i = 0; i < list.length; i++) {
    if (list[i].usedAt) continue;
    if (await bcrypt.compare(String(code || ''), list[i].hash)) {
      list.splice(i, 1); // استهلاك فوري: حذف الكود المستخدم نهائياً بدل مجرد وضع علامة عليه
      return { ok: true, remaining: JSON.stringify(list) };
    }
  }
  return { ok: false, remaining: storedJson };
}

module.exports = {
  signToken, requireAuth, requireRole, hashPassword, verifyPassword, verifyEmergencyAdmin, signEmergencyToken,
  generateTotpSecret, totpOtpauthUrl, verifyTotpToken, generateBackupCodes, hashBackupCodes, consumeBackupCode,
};
