// ============================================================
// الدخول عبر رابط بالإيميل (Magic Link) — بديل اختياري لكتابة كلمة المرور. المستخدم يطلب
// رابطاً على إيميله المسجَّل، يضغطه فيسجّل دخوله تلقائياً. الرابط صالح لمرة واحدة فقط ولمدة
// 15 دقيقة. لا يعمل إلا للمستخدمين الذين لديهم إيميل مسجَّل (يُضاف من شاشة "المستخدمون"
// فى الإعدادات) وطالما إعدادات SMTP مضبوطة على السيرفر (متغيرات البيئة SMTP_*).
// ============================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { pool } = require('../db');
const { signToken } = require('../auth');
const { authLimiter } = require('../rate-limiters');

let cachedTransporter = null;
let cachedTransporterKey = null;
// نعيد بناء الـ transporter فقط لو تغيّرت متغيرات البيئة فعلياً (نادر جداً أثناء تشغيل السيرفر)،
// بدل إعادة الاتصال بـ SMTP فى كل طلب — أسرع وأقل حملاً على خادم البريد.
function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const key = `${host}|${user}|${process.env.SMTP_PORT || ''}`;
  if (cachedTransporter && cachedTransporterKey === key) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user, pass },
  });
  cachedTransporterKey = key;
  return cachedTransporter;
}

function getOrigin(req) {
  return req.headers.origin || `https://${req.headers.host}`;
}

// رسالة عامة واحدة دائماً بغض النظر عن وجود الحساب/الإيميل من عدمه، لمنع تسريب معلومة "هل هذا
// اليوزرنيم موجود فعلاً" لأي طرف يجرّب أسماء عشوائية — نفس منطق أمان استعادة كلمة المرور القياسي.
const GENERIC_RESPONSE = { ok: true, message: 'لو الحساب موجود وعنده إيميل مسجَّل، هيوصله رابط دخول خلال دقائق' };

router.post('/api/auth/magic-link/request', authLimiter, async (req, res) => {
  try {
    const username = (req.body.username || '').toString().trim();
    if (!username) return res.status(400).json({ error: 'اسم المستخدم مطلوب' });
    const userResult = await pool.query('SELECT * FROM server_users WHERE username = $1', [username]);
    const user = userResult.rows[0];
    if (!user || !user.email || user.is_active === false) return res.json(GENERIC_RESPONSE);
    const transport = getTransporter();
    if (!transport) {
      console.error('تعذّر إرسال رابط الدخول: إعدادات SMTP (SMTP_HOST/SMTP_USER/SMTP_PASS) غير مكتملة على السيرفر');
      return res.json(GENERIC_RESPONSE); // لا نكشف تفاصيل إعداد السيرفر لطالب الرابط
    }
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'INSERT INTO magic_link_tokens (username, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.username, tokenHash, expiresAt]
    );
    const link = `${getOrigin(req)}/?magicToken=${rawToken}&u=${encodeURIComponent(user.username)}`;
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: 'رابط الدخول إلى نظام إدارة المركز',
      html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif; line-height:1.8;">
        <p>مرحباً ${user.display_name || user.username}،</p>
        <p>اضغط الرابط التالي لتسجيل الدخول مباشرة بدون كلمة مرور (صالح لمدة 15 دقيقة فقط، ولمرة واحدة):</p>
        <p><a href="${link}" style="color:#7C5CFC;">${link}</a></p>
        <p style="color:#888; font-size:13px;">لو لم تطلب هذا الرابط، تجاهل هذه الرسالة ببساطة — لن يتم تسجيل أي دخول بدونها.</p>
      </div>`,
    });
    res.json(GENERIC_RESPONSE);
  } catch (e) {
    console.error('تعذّر إرسال رابط الدخول بالإيميل:', e);
    // نُبقي الرد عاماً حتى فى حالة الخطأ الفعلي — أي فشل داخلي لا يجب أن يكشف تفاصيل تقنية
    // لطالب الرابط، ويكفي تسجيله فى سجلات السيرفر (أعلاه) لمتابعته من طرف المدير.
    res.json(GENERIC_RESPONSE);
  }
});

router.post('/api/auth/magic-link/verify', async (req, res) => {
  try {
    const { username, token } = req.body || {};
    if (!username || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT * FROM magic_link_tokens
       WHERE username = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [username, tokenHash]
    );
    const record = result.rows[0];
    if (!record) return res.status(401).json({ error: 'الرابط غير صالح أو منتهي الصلاحية، اطلب رابطاً جديداً' });
    // نُبطل الرابط فوراً (قبل أي منطق آخر) حتى لا يُستخدم مرتين حتى لو حصل تزامن نادر فى الطلبات.
    await pool.query('UPDATE magic_link_tokens SET used_at = now() WHERE id = $1', [record.id]);

    const userResult = await pool.query('SELECT * FROM server_users WHERE username = $1', [username]);
    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب غير موجود' });
    if (user.is_active === false) return res.status(401).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });

    const jwtToken = signToken(user);
    const loginIp = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const loginDevice = (req.headers['user-agent'] || '').toString().slice(0, 300);
    pool.query('UPDATE server_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id])
      .catch(e => console.error('تعذّر تصفير عداد المحاولات الفاشلة:', e));
    pool.query(
      'INSERT INTO login_history (username, role, ip_address, device_info) VALUES ($1, $2, $3, $4)',
      [user.username, user.role || 'staff', loginIp, loginDevice]
    ).catch(e => console.error('تعذّر تسجيل عملية الدخول عبر الرابط فى السجل:', e));

    res.json({
      token: jwtToken,
      username: user.username,
      role: user.role || 'staff',
      user: { username: user.username, displayName: user.display_name, role: user.role || 'staff' },
      suspiciousAlert: [],
    });
  } catch (e) {
    console.error('تعذّر التحقق من رابط الدخول:', e);
    res.status(500).json({ error: 'تعذّر إتمام الدخول، حاول من جديد' });
  }
});

module.exports = router;
