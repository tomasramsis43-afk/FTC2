// ============================================================
// الدخول عبر رابط بالإيميل (Magic Link) — بديل اختياري لكتابة كلمة المرور. المستخدم يطلب
// رابطاً على إيميله المسجَّل، يضغطه فيسجّل دخوله تلقائياً. الرابط صالح لمرة واحدة فقط ولمدة
// 15 دقيقة. لا يعمل إلا للمستخدمين الذين لديهم إيميل مسجَّل (يُضاف من شاشة "المستخدمون"
// فى الإعدادات) وطالما إعدادات SMTP مضبوطة على السيرفر (متغيرات البيئة SMTP_*).
// ============================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { signToken, verifySecondFactor } = require('../auth');
const { authLimiter } = require('../rate-limiters');
const { sendEmail, isConfigured } = require('../services/email');

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
    if (!isConfigured()) {
      console.error('تعذّر إرسال رابط الدخول: لا يوجد RESEND_API_KEY ولا إعدادات SMTP كاملة على السيرفر');
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
    await sendEmail({
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

router.post('/api/auth/magic-link/verify', authLimiter, async (req, res) => {
  try {
    const { username, token, totpCode, backupCode } = req.body || {};
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
    // استيلاء ذري على الرابط (لمرة واحدة): الشرط "AND used_at IS NULL" يمنع طلبين متزامنين
    // من النجاح معاً — من يفوز بالتحديث أولاً يكمل، والثاني يُرفض كرابط مستهلك.
    const claim = await pool.query(
      'UPDATE magic_link_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL',
      [record.id]
    );
    if (claim.rowCount === 0) return res.status(401).json({ error: 'الرابط غير صالح أو منتهي الصلاحية، اطلب رابطاً جديداً' });
    // لو احتجنا إرجاع الرابط لحياته (طلب الكود الثاني أو خطأ فيه) نحرره بهذه الدالة،
    // حتى لا يخسر المستخدم رابطه لمجرد أنه لم يدخل الكود بعد.
    const releaseLink = () => pool.query('UPDATE magic_link_tokens SET used_at = NULL WHERE id = $1', [record.id]).catch(() => {});

    const userResult = await pool.query('SELECT * FROM server_users WHERE username = $1', [username]);
    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب غير موجود' });
    if (user.is_active === false) return res.status(401).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });
    // قفل المحاولات الفاشلة يسري على كل مسارات الدخول بلا استثناء — كان مفقوداً هنا تماماً،
    // فيسمح بالدخول عبر الرابط لحساب مقفل بسبب محاولات تخمين كلمة المرور.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(403).json({ error: `الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة متكررة، حاول بعد ${minutesLeft} دقيقة` });
    }
    // المصادقة الثنائية: صاحب الرابط أثبت حيازة الإيميل فقط — لو الحساب مفعّل عنده TOTP
    // فالكود الثاني مطلوب هنا كما هو مطلوب في تسجيل الدخول العادي، وإلا فالـ TOTP كان
    // مجرد ديكور يمكن تجاوزه برسالة إيميل واحدة.
    if (user.totp_enabled) {
      const second = await verifySecondFactor(user, { totpCode, backupCode });
      if (second.needed) {
        await releaseLink();
        return res.json({ requires2FA: true, username: user.username });
      }
      if (!second.ok) {
        await releaseLink();
        const loginIp = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
        pool.query(
          'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
          [user.username, user.role || 'staff', loginIp, (req.headers['user-agent'] || '').toString().slice(0, 300)]
        ).catch(() => {});
        return res.status(401).json({ error: 'كود التحقق غير صحيح' });
      }
    }

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
