// ============================================================
// الدخول عبر رابط بالإيميل (Magic Link) — بديل اختياري لكتابة كلمة المرور. المستخدم يطلب
// رابطاً على إيميله المسجَّل، يضغطه فيسجّل دخوله تلقائياً. الرابط صالح لمرة واحدة فقط ولمدة
// 15 دقيقة. لا يعمل إلا للمستخدمين الذين لديهم إيميل مسجَّل (يُضاف من شاشة "المستخدمون"
// فى الإعدادات) وطالما إعدادات SMTP مضبوطة على السيرفر (متغيرات البيئة SMTP_*).
// ============================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const authRepo = require('../repo/auth.repo');
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
    const user = await authRepo.findByUsername(username);
    if (!user || !user.email || user.is_active === false) return res.json(GENERIC_RESPONSE);
    if (!isConfigured()) {
      console.error('تعذّر إرسال رابط الدخول: لا يوجد RESEND_API_KEY ولا إعدادات SMTP كاملة على السيرفر');
      return res.json(GENERIC_RESPONSE); // لا نكشف تفاصيل إعداد السيرفر لطالب الرابط
    }
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await authRepo.insertMagicLink(user.username, tokenHash, expiresAt);
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
    const record = await authRepo.findValidMagicLink(username, tokenHash);
    if (!record) return res.status(401).json({ error: 'الرابط غير صالح أو منتهي الصلاحية، اطلب رابطاً جديداً' });
    const claimed = await authRepo.claimMagicLink(record.id);
    if (!claimed) return res.status(401).json({ error: 'الرابط غير صالح أو منتهي الصلاحية، اطلب رابطاً جديداً' });
    const releaseLink = () => authRepo.releaseMagicLink(record.id).catch(() => {});

    const user = await authRepo.findByUsername(username);
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
        authRepo.recordLogin({
          username: user.username, role: user.role || 'staff', ip: loginIp,
          device: (req.headers['user-agent'] || '').toString().slice(0, 300), success: false,
        }).catch(() => {});
        return res.status(401).json({ error: 'كود التحقق غير صحيح' });
      }
    }

    const jwtToken = signToken(user);
    const loginIp = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const loginDevice = (req.headers['user-agent'] || '').toString().slice(0, 300);
    authRepo.resetFailedLogin(user.id)
      .catch(e => console.error('تعذّر تصفير عداد المحاولات الفاشلة:', e));
    authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: loginDevice, success: true })
      .catch(e => console.error('تعذّر تسجيل عملية الدخول عبر الرابط فى السجل:', e));

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
