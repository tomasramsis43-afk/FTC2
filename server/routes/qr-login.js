// ============================================================
// الدخول بمسح الكود (QR) — زي واتساب ويب: جهاز غير مسجَّل دخول (عادة ديسكتوب) يولّد رمز QR
// يحتوي على رابط لنفس البرنامج بمعرّف جلسة مؤقت وعشوائي. يفتح المستخدم هذا الرابط بمسح الكود
// بكاميرا موبايله العادية (بدون أي ماسح داخل البرنامج نفسه)، وموبايله مسجَّل دخول بالفعل، فيوافق
// هناك على ربط الجهازين — فيدخل الجهاز الأول تلقائياً بنفس الحساب. كل جلسة QR صالحة لمرة واحدة
// فقط ولمدة 3 دقائق.
// ============================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, signToken } = require('../auth');
const { authLimiter } = require('../rate-limiters');

// نخزّن جلسات QR مؤقتاً فى ذاكرة السيرفر فقط (لا حاجة لجدول قاعدة بيانات لبيانات قصيرة الأمد
// كهذه؛ أقصى عمر 3 دقائق) — تُنظَّف تلقائياً بمرور الوقت.
const qrSessions = new Map(); // id -> { status, username, token, role, user, createdAt, expiresAt }
const QR_SESSION_TTL_MS = 3 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of qrSessions) {
    if (session.expiresAt < now) qrSessions.delete(id);
  }
}, 60 * 1000).unref();

router.post('/api/auth/qr-login/create', authLimiter, (req, res) => {
  const id = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + QR_SESSION_TTL_MS;
  qrSessions.set(id, { status: 'pending', createdAt: Date.now(), expiresAt });
  res.json({ sessionId: id, expiresAt: new Date(expiresAt).toISOString() });
});

router.get('/api/auth/qr-login/status/:id', authLimiter, (req, res) => {
  const session = qrSessions.get(req.params.id);
  if (!session || session.expiresAt < Date.now()) return res.json({ status: 'expired' });
  if (session.status === 'approved') {
    // نُرجع بيانات الدخول مرة واحدة فقط ثم نحذف الجلسة فوراً — منعاً لإعادة استخدام نفس الاستجابة
    // (replay) لو تكرر الـ polling بعد التقاطها بالفعل من الديسكتوب.
    qrSessions.delete(req.params.id);
    return res.json({
      status: 'approved',
      token: session.token,
      username: session.username,
      role: session.role,
      user: session.user,
    });
  }
  res.json({ status: session.status });
});

router.post('/api/auth/qr-login/approve/:id', requireAuth, async (req, res) => {
  try {
    const session = qrSessions.get(req.params.id);
    if (!session || session.expiresAt < Date.now() || session.status !== 'pending') {
      return res.status(404).json({ error: 'انتهت صلاحية الكود أو تم استخدامه بالفعل' });
    }
    const userResult = await pool.query('SELECT * FROM server_users WHERE username = $1', [req.user.username]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
    const token = signToken(user);
    session.status = 'approved';
    session.username = user.username;
    session.role = user.role || 'staff';
    session.token = token;
    session.user = { username: user.username, displayName: user.display_name, role: user.role || 'staff' };

    const loginIp = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    pool.query('UPDATE server_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id])
      .catch(e => console.error('تعذّر تصفير عداد المحاولات الفاشلة:', e));
    pool.query(
      'INSERT INTO login_history (username, role, ip_address, device_info) VALUES ($1, $2, $3, $4)',
      [user.username, user.role || 'staff', loginIp, 'دخول بمسح الكود (QR) — تمت الموافقة من جهاز آخر']
    ).catch(e => console.error('تعذّر تسجيل عملية الدخول بالكود فى السجل:', e));

    res.json({ ok: true });
  } catch (e) {
    console.error('تعذّر الموافقة على طلب الدخول بالكود:', e);
    res.status(500).json({ error: 'تعذّر إتمام العملية' });
  }
});

router.post('/api/auth/qr-login/reject/:id', requireAuth, (req, res) => {
  const session = qrSessions.get(req.params.id);
  if (session && session.status === 'pending') session.status = 'rejected';
  res.json({ ok: true });
});

module.exports = router;
