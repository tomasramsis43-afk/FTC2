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
const { pool } = require('../db');
const { requireAuth, signToken } = require('../auth');
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

// rpID (Relying Party ID) يجب أن يطابق تماماً الدومين الذي تُخدَّم منه الواجهة فى متصفح
// المستخدم؛ نستنتجه ديناميكياً من ترويسة Origin/Host بدل تثبيته، حتى يعمل صحيحاً سواء على
// دومين Render الافتراضي أو أي دومين مخصّص يُضاف لاحقاً بدون أي تعديل فى الكود.
function getRpIdAndOrigin(req) {
  const origin = req.headers.origin || `https://${req.headers.host}`;
  let hostname;
  try { hostname = new URL(origin).hostname; } catch (e) { hostname = req.hostname; }
  return { rpID: hostname, origin };
}

/* ---------------- تسجيل جهاز جديد (يتطلب تسجيل دخول عادي بالفعل) ---------------- */

router.post('/api/auth/webauthn/register-options', requireAuth, async (req, res) => {
  try {
    const { rpID } = getRpIdAndOrigin(req);
    const existing = await pool.query('SELECT credential_id FROM webauthn_credentials WHERE username = $1', [req.user.username]);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: req.user.username,
      userDisplayName: req.user.username,
      attestationType: 'none',
      excludeCredentials: existing.rows.map(r => ({ id: r.credential_id })),
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
    await pool.query(
      `INSERT INTO webauthn_credentials (username, credential_id, public_key, counter, device_type, backed_up, transports, nickname)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.user.username,
        credential.id,
        Buffer.from(credential.publicKey).toString('base64'),
        credential.counter,
        credentialDeviceType,
        credentialBackedUp,
        JSON.stringify(credential.transports || []),
        (nickname || '').toString().slice(0, 80) || null,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('تعذّر حفظ بصمة الدخول الجديدة:', e);
    res.status(500).json({ error: 'تعذّر حفظ البصمة' });
  }
});

/* ---------------- عرض/حذف الأجهزة المسجَّلة لحساب المستخدم الحالي ---------------- */

router.get('/api/auth/webauthn/credentials', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nickname, device_type, created_at, last_used_at FROM webauthn_credentials WHERE username = $1 ORDER BY created_at DESC',
      [req.user.username]
    );
    res.json({ credentials: result.rows });
  } catch (e) {
    console.error('تعذّر جلب قائمة البصمات المسجّلة:', e);
    res.status(500).json({ error: 'تعذّر جلب القائمة' });
  }
});

router.delete('/api/auth/webauthn/credentials/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM webauthn_credentials WHERE id = $1 AND username = $2', [req.params.id, req.user.username]);
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

router.post('/api/auth/webauthn/login-options', async (req, res) => {
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

router.post('/api/auth/webauthn/login-verify', async (req, res) => {
  try {
    const { requestId, response } = req.body || {};
    if (!requestId || !response) return res.status(400).json({ error: 'بيانات ناقصة' });
    const { rpID, origin } = getRpIdAndOrigin(req);
    const expectedChallenge = takeChallenge('login:' + requestId);
    if (!expectedChallenge) return res.status(400).json({ error: 'انتهت صلاحية محاولة الدخول، حاول من جديد' });

    // نتعرّف على صاحب الحساب من credential_id نفسه (الاستجابة لا تحمل اسم مستخدم إطلاقاً).
    const credRow = await pool.query('SELECT * FROM webauthn_credentials WHERE credential_id = $1', [response.id]);
    if (!credRow.rows.length) return res.status(400).json({ error: 'هذه البصمة غير مسجَّلة على هذا الحساب' });
    const cred = credRow.rows[0];
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

    await pool.query(
      'UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE id = $2',
      [verification.authenticationInfo.newCounter, cred.id]
    );

    const userResult = await pool.query('SELECT * FROM server_users WHERE username = $1', [username]);
    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب غير موجود' });
    if (user.is_active === false) return res.status(401).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });

    const token = signToken(user);
    const loginIp = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const loginDevice = (req.headers['user-agent'] || '').toString().slice(0, 300);
    pool.query('UPDATE server_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id])
      .catch(e => console.error('تعذّر تصفير عداد المحاولات الفاشلة:', e));
    pool.query(
      'INSERT INTO login_history (username, role, ip_address, device_info) VALUES ($1, $2, $3, $4)',
      [user.username, user.role || 'staff', loginIp, loginDevice]
    ).catch(e => console.error('تعذّر تسجيل عملية الدخول بالبصمة فى السجل:', e));

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

module.exports = router;
