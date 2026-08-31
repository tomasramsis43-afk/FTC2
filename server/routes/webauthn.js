// ============================================================
// الدخول بالبصمة/Face ID (WebAuthn) — مكمّل لتسجيل الدخول العادي وليس بديلاً إجبارياً عنه.
// المستخدم يسجّل جهازه أولاً (بعد دخول عادي بكلمة مرور)، ثم يقدر لاحقاً يدخل من نفس الجهاز
// ببصمته/Face ID مباشرة بدون كتابة كلمة المرور. كل التحقق الفعلي (هل البصمة صحيحة؟) يحدث
// داخل نظام تشغيل الجهاز نفسه أو المتصفح — السيرفر لا يرى ولا يخزّن أي بيانات بيومترية
// إطلاقاً، فقط "مفتاح عام" (public key) خاص بكل جهاز، تماماً كأي نظام WebAuthn قياسي.
// ============================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const authRepo = require('../repo/auth.repo');
const webauthnRepo = require('../repo/webauthn.repo');
const { requireAuth, signToken, verifySecondFactor } = require('../auth');
const { authLimiter } = require('../rate-limiters');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = 'نظام إدارة مركز التدريب';

// تخزين التحدّيات (challenges) مؤقتاً فى ذاكرة السيرفر أثناء مراسم التسجيل/الدخول فقط (صالحة
// لدقيقتين). لا حاجة لجدول قاعدة بيانات لهذا الغرض القصير جداً، وتُنظَّف تلقائياً بمرور الوقت.
const pendingChallenges = new Map(); // key -> { challenge, expiresAt }
function storeChallenge(key, challenge) {
  pendingChallenges.set(key, { challenge, expiresAt: Date.now() + 2 * 60 * 1000 });
}
function takeChallenge(key) {
  const entry = pendingChallenges.get(key);
  pendingChallenges.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingChallenges) {
    if (entry.expiresAt < now) pendingChallenges.delete(key);
  }
}, 5 * 60 * 1000).unref();

// جلسات "بانتظار الكود الثاني" بعد نجاح البصمة لحساب مفعّل عنده TOTP — بنفس نمط جلسات QR:
// ذاكرة فقط، معرّف عشوائي 192-bit لا يمكن تخمينه، وعمر قصير 3 دقائق يُنظَّف دورياً.
// الاستهلاك مرة واحدة: كل محاولة إدخال كود (صحيحة أو خاطئة) تحرق pendingId، فكل محاولة
// جديدة تتطلب مسح بصمة جديد — وهذا بحد ذاته خنق طبيعي ضد تخمين الأكواد.
const pendingSecondFactor = new Map(); // pendingId -> { username, expiresAt }
const PENDING_2FA_TTL_MS = 3 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingSecondFactor) {
    if (entry.expiresAt < now) pendingSecondFactor.delete(id);
  }
}, 60 * 1000).unref();

// rpID (Relying Party ID) يجب أن يطابق تماماً الدومين الذي تُخدَّم منه الواجهة.
// إصلاح أمني: لا نثق بـ Host/Origin من العميل مباشرةً. إذا حُدد PUBLIC_ORIGIN أو ALLOWED_RP_IDS
// في البيئة، نتحقق ضده و نرفض أي Host غير مسموح.
function getRpIdAndOrigin(req) {
  const allowedEnv = (process.env.PUBLIC_ORIGIN || process.env.ALLOWED_RP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowedHosts = allowedEnv.map(v => { try { return new URL(v).hostname || v; } catch { return v; } }).filter(Boolean);
  const origin = req.headers.origin || `https://${req.headers.host}`;
  let hostname;
  try { hostname = new URL(origin).hostname; } catch (e) { hostname = req.hostname; }
  // تحقق صارم: hostname يجب أن يكون أحرف/أرقام/نقطة/شرطة فقط
  if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) hostname = req.hostname;
  if (allowedHosts.length && !allowedHosts.includes(hostname)) {
    // في الإنتاج: استخدم أول Host مسموح بدلاً من Host المهاجم
    hostname = allowedHosts[0];
    const fixedOrigin = allowedEnv[0].startsWith('http') ? allowedEnv[0] : `https://${hostname}`;
    return { rpID: hostname, origin: fixedOrigin };
  }
  return { rpID: hostname, origin };
}

/* ---------------- تسجيل جهاز جديد (يتطلب تسجيل دخول عادي بالفعل) ---------------- */

router.post('/api/auth/webauthn/register-options', requireAuth, async (req, res) => {
  try {
    const { rpID } = getRpIdAndOrigin(req);
    const existing = await webauthnRepo.listCredentialIds(req.user.username);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: req.user.username,
      userDisplayName: req.user.username,
      attestationType: 'none',
      excludeCredentials: existing.map(r => ({ id: r.credential_id })),
      // residentKey: 'required' يجعل البصمة "قابلة للاكتشاف" (discoverable) من المتصفح نفسه —
      // هذا ما يُمكّن لاحقاً من الدخول بالبصمة مباشرة دون كتابة اسم مستخدم إطلاقاً (راجع
      // login-options أسفل)، لأن المتصفح يقدر يعرض للمستخدم بصماته المسجَّلة لهذا الموقع بنفسه.
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred', requireResidentKey: true },
    });
    storeChallenge('register:' + req.user.username, options.challenge);
    res.json(options);
  } catch (e) {
    console.error('تعذّر توليد خيارات تسجيل بصمة جديدة:', e);
    res.status(500).json({ error: 'تعذّر بدء تسجيل البصمة' });
  }
});

router.post('/api/auth/webauthn/register-verify', requireAuth, async (req, res) => {
  try {
    const { rpID, origin } = getRpIdAndOrigin(req);
    const expectedChallenge = takeChallenge('register:' + req.user.username);
    if (!expectedChallenge) return res.status(400).json({ error: 'انتهت صلاحية طلب التسجيل، حاول من جديد' });
    const { nickname, ...credentialResponse } = req.body || {};
    const verification = await verifyRegistrationResponse({
      response: credentialResponse,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'تعذّر التحقق من البصمة' });
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await webauthnRepo.insertCredential({
      username: req.user.username,
      credentialId: credential.id,
      publicKeyB64: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transportsJson: JSON.stringify(credential.transports || []),
      nickname: (nickname || '').toString().slice(0, 80) || null,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('تعذّر حفظ بصمة الدخول الجديدة:', e);
    res.status(500).json({ error: 'تعذّر حفظ البصمة' });
  }
});

/* ---------------- عرض/حذف الأجهزة المسجَّلة لحساب المستخدم الحالي ---------------- */

router.get('/api/auth/webauthn/credentials', requireAuth, async (req, res) => {
  try {
    const credentials = await webauthnRepo.listCredentials(req.user.username);
    res.json({ credentials });
  } catch (e) {
    console.error('تعذّر جلب قائمة البصمات المسجّلة:', e);
    res.status(500).json({ error: 'تعذّر جلب القائمة' });
  }
});

router.delete('/api/auth/webauthn/credentials/:id', requireAuth, async (req, res) => {
  try {
    await webauthnRepo.deleteCredential(req.params.id, req.user.username);
    res.json({ ok: true });
  } catch (e) {
    console.error('تعذّر حذف البصمة:', e);
    res.status(500).json({ error: 'تعذّر حذف البصمة' });
  }
});

/* ---------------- الدخول بالبصمة (بدون كلمة مرور) ---------------- */

/* ---------------- الدخول بالبصمة (بدون كلمة مرور، وبدون كتابة اسم مستخدم إطلاقاً) ----------------
   يعتمد على "البصمات القابلة للاكتشاف" (discoverable credentials) — المتصفح نفسه يعرض للمستخدم
   قائمة بصماته المسجَّلة لهذا الموقع فيختار منها مباشرة، فنعرف صاحب الحساب من الاستجابة نفسها
   (عبر credential_id الفريد) دون الحاجة لأي اسم مستخدم مُدخَل يدوياً. */

router.post('/api/auth/webauthn/login-options', authLimiter, async (req, res) => {
  try {
    const { rpID } = getRpIdAndOrigin(req);
    // لا نحدد allowCredentials إطلاقاً هنا عمداً — ده اللي بيخلي المتصفح يعرض كل البصمات
    // المسجَّلة على هذا الجهاز لهذا الموقع بنفسه (usernameless / discoverable flow).
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
    });
    const requestId = crypto.randomBytes(16).toString('base64url');
    storeChallenge('login:' + requestId, options.challenge);
    res.json({ ...options, requestId });
  } catch (e) {
    console.error('تعذّر توليد خيارات الدخول بالبصمة:', e);
    res.status(500).json({ error: 'تعذّر بدء الدخول بالبصمة' });
  }
});

router.post('/api/auth/webauthn/login-verify', authLimiter, async (req, res) => {
  try {
    const { requestId, response } = req.body || {};
    if (!requestId || !response) return res.status(400).json({ error: 'بيانات ناقصة' });
    const { rpID, origin } = getRpIdAndOrigin(req);
    const expectedChallenge = takeChallenge('login:' + requestId);
    if (!expectedChallenge) return res.status(400).json({ error: 'انتهت صلاحية محاولة الدخول، حاول من جديد' });

    // نتعرّف على صاحب الحساب من credential_id نفسه (الاستجابة لا تحمل اسم مستخدم إطلاقاً).
    const cred = await webauthnRepo.findByCredentialId(response.id);
    if (!cred) return res.status(400).json({ error: 'هذه البصمة غير مسجَّلة على هذا الحساب' });
    const username = cred.username;

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.credential_id,
        publicKey: Buffer.from(cred.public_key, 'base64'),
        counter: Number(cred.counter),
        transports: JSON.parse(cred.transports || '[]'),
      },
    });
    if (!verification.verified) return res.status(401).json({ error: 'تعذّر التحقق من البصمة' });

    await webauthnRepo.updateCounter(cred.id, verification.authenticationInfo.newCounter);

    const user = await authRepo.findByUsername(username);
    if (!user) return res.status(401).json({ error: 'الحساب غير موجود' });
    if (user.is_active === false) return res.status(401).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });
    const loginIp = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const loginDevice = (req.headers['user-agent'] || '').toString().slice(0, 300);
    // قفل المحاولات الفاشلة يسري على كل مسارات الدخول بلا استثناء.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(403).json({ error: `الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة متكررة، حاول بعد ${minutesLeft} دقيقة` });
    }
    // المصادقة الثنائية: البصمة تثبت حيازة الجهاز المسجَّل، ولو الحساب مفعّل عنده TOTP نطلب
    // الكود الثاني قبل إصدار التوكن — عبر جلسة قصيرة العمر تُستهلك في /login-2fa أسفل.
    if (user.totp_enabled) {
      const { totpCode, backupCode } = req.body || {};
      const second = await verifySecondFactor(user, { totpCode, backupCode });
      if (second.needed) {
        const pendingId = crypto.randomBytes(24).toString('base64url');
        pendingSecondFactor.set(pendingId, { username: user.username, expiresAt: Date.now() + PENDING_2FA_TTL_MS });
        return res.json({ requires2FA: true, username: user.username, pendingId });
      }
      if (!second.ok) {
        authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: loginDevice, success: false })
          .catch(() => {});
        return res.status(401).json({ error: 'كود التحقق غير صحيح' });
      }
    }

    const token = signToken(user);
    authRepo.resetFailedLogin(user.id)
      .catch(e => console.error('تعذّر تصفير عداد المحاولات الفاشلة:', e));
    authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: loginDevice, success: true })
      .catch(e => console.error('تعذّر تسجيل عملية الدخول بالبصمة فى السجل:', e));

    res.json({
      token,
      username: user.username,
      role: user.role || 'staff',
      user: { username: user.username, displayName: user.display_name, role: user.role || 'staff' },
      suspiciousAlert: [],
    });
  } catch (e) {
    console.error('تعذّر إتمام الدخول بالبصمة:', e);
    res.status(500).json({ error: 'تعذّر إتمام الدخول' });
  }
});

// الخطوة الثانية لدخول البصمة لحساب مفعّل عنده TOTP: يستلم pendingId القصير العمر من
// استجابة login-verify (requires2FA) مع الكود، فيُصدر التوكن عند النجاح. pendingId يُستهلك
// مرة واحدة (خذ-واحذف) فكل محاولة خاطئة تتطلب مسح بصمة جديد من جديد — خنق طبيعي مضاعف
// فوق authLimiter. لا يمكن تخمين pendingId (192-bit عشوائي) ولا الوصول إليه إلا بعد نجاح
// البصمة فعلاً، فهذا المسار لا يفتح أي باب لحامل اسم مستخدم فقط.
router.post('/api/auth/webauthn/login-2fa', authLimiter, async (req, res) => {
  try {
    const { pendingId, totpCode, backupCode } = req.body || {};
    if (!pendingId) return res.status(400).json({ error: 'بيانات ناقصة' });
    const entry = pendingSecondFactor.get(pendingId);
    if (!entry || entry.expiresAt < Date.now()) {
      pendingSecondFactor.delete(pendingId);
      return res.status(401).json({ error: 'انتهت صلاحية جلسة التحقق — امسح بصمتك من جديد' });
    }
    // استهلاك فوري قبل أي تحقق: محاولة واحدة لكل مسح بصمة.
    pendingSecondFactor.delete(pendingId);

    const user = await authRepo.findByUsername(entry.username);
    if (!user) return res.status(401).json({ error: 'الحساب غير موجود' });
    if (user.is_active === false) return res.status(401).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(403).json({ error: `الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة متكررة، حاول بعد ${minutesLeft} دقيقة` });
    }

    const second = await verifySecondFactor(user, { totpCode, backupCode });
    const loginIp = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const loginDevice = (req.headers['user-agent'] || '').toString().slice(0, 300);
    if (!second.ok) {
      authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: loginDevice, success: false })
        .catch(() => {});
      return res.status(401).json({ error: 'كود التحقق غير صحيح' });
    }

    const token = signToken(user);
    authRepo.resetFailedLogin(user.id)
      .catch(e => console.error('تعذّر تصفير عداد المحاولات الفاشلة:', e));
    authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: 'دخول بالبصمة + كود مصادقة ثنائي', success: true })
      .catch(e => console.error('تعذّر تسجيل عملية الدخول فى السجل:', e));

    res.json({
      token,
      username: user.username,
      role: user.role || 'staff',
      user: { username: user.username, displayName: user.display_name, role: user.role || 'staff' },
      suspiciousAlert: [],
    });
  } catch (e) {
    console.error('تعذّر التحقق من كود المصادقة بعد البصمة:', e);
    res.status(500).json({ error: 'تعذّر إتمام الدخول' });
  }
});

module.exports = router;
