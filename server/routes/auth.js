const express = require('express');
const router = express.Router();
const authRepo = require('../repo/auth.repo');
const { signToken, requireAuth, requireRole, resolveUserFromToken, hashPassword, verifyPassword,
  verifyEmergencyAdmin, signEmergencyToken, generateTotpSecret, totpOtpauthUrl, verifyTotpToken,
  generateBackupCodes, hashBackupCodes, verifySecondFactor } = require('../auth');
const { addClient: addSseClient, removeClient: removeSseClient } = require('../sse');
const { authLimiter, licenseLimiter } = require('../rate-limiters');
const { validateLicenseKey } = require('../license');
const { alertAdmins } = require('../services/email');

// تحديد الدولة/المدينة تقريبياً من عنوان IP، عبر خدمة ipwho.is المجانية (بدون مفتاح API).
// best-effort بالكامل: أي فشل (شبكة/انتهاء مهلة/عنوان محلي) يُرجع null بهدوء دون كسر تسجيل
// الدخول نفسه أبداً. مهلة قصيرة (2.5 ثانية) حتى لا تُبطئ استجابة الدخول بشكل ملحوظ لو تعذّر
// الوصول للخدمة الخارجية.
async function geolocateIp(ip) {
  if (!ip) return null;
  // تجاهل عناوين IP المحلية/الخاصة — الاستعلام عنها لن يعطي نتيجة مفيدة على أي حال.
  if (/^(127\.|10\.|192\.168\.|::1$|::ffff:127\.|fc00:|fe80:)/.test(ip)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const resp = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await resp.json();
    if (!data || data.success === false) return null;
    return { country: data.country || null, city: data.city || null };
  } catch (e) {
    return null;
  }
}

// خطوة 1: توليد سر مؤقّت (pending) + رابط otpauth للـ QR — لا يُفعَّل فعلياً إلا بعد
// تأكيد أول كود صحيح فى /verify (يمنع تفعيل غير مقصود لو المستخدم أغلق الصفحة قبل المسح).
router.post('/api/2fa/setup', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const secret = generateTotpSecret();
    await authRepo.setTotpPendingSecret(req.user.username, secret);
    const otpauthUrl = totpOtpauthUrl(secret, req.user.username);
    res.json({ secret, otpauthUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر بدء إعداد المصادقة الثنائية' });
  }
});
// خطوة 2: تأكيد أول كود من تطبيق المصادقة — عند النجاح ينتقل السر من pending إلى الفعلي
// وتُولَّد 10 أكواد احتياطية تُعرض للمستخدم مرة واحدة فقط (النص الصريح لا يُخزَّن أبداً).
router.post('/api/2fa/verify-setup', requireAuth, requireRole('admin'), authLimiter, async (req, res) => {
  try {
    const pending = await authRepo.getTotpPendingSecret(req.user.username);
    if (!pending) return res.status(400).json({ error: 'ابدأ خطوة الإعداد أولاً' });
    if (!verifyTotpToken(req.body?.totpCode, pending)) {
      return res.status(401).json({ error: 'الكود غير صحيح، تأكد من مزامنة الوقت فى جهازك وحاول مجدداً' });
    }
    const backupCodes = generateBackupCodes(10);
    const hashed = await hashBackupCodes(backupCodes);
    await authRepo.enableTotp(req.user.username, pending, JSON.stringify(hashed));
    res.json({ enabled: true, backupCodes }); // النص الصريح لهذه الأكواد يُعرض مرة واحدة فقط هنا
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تفعيل المصادقة الثنائية' });
  }
});
// إلغاء التفعيل — يتطلب كلمة المرور الحالية كتأكيد إضافي (مش مجرد ضغطة زر عابرة على حساب حساس)
router.post('/api/2fa/disable', requireAuth, requireRole('admin'), authLimiter, async (req, res) => {
  try {
    const passwordHash = await authRepo.getPasswordHash(req.user.username);
    const ok = passwordHash && await verifyPassword(req.body?.password || '', passwordHash);
    if (!ok) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
    await authRepo.disableTotp(req.user.username);
    res.json({ enabled: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر إلغاء المصادقة الثنائية' });
  }
});
router.get('/api/2fa/status', requireAuth, async (req, res) => {
  try {
    res.json({ enabled: await authRepo.getTotpEnabled(req.user.username) });
  } catch (e) {
    res.status(500).json({ error: 'تعذّر جلب حالة المصادقة الثنائية' });
  }
});

/* ---------------- تسجيل الدخول ---------------- */
router.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });
  }
  try {
    // ملاحظة أمنية: لا نقرأ رأس X-Forwarded-For يدوياً إطلاقاً — كان يُسمح لأي عميل بتزييفه
    // (spoofing) ليُسجَّل عنوان مزوّر في سجل الدخول. نعتمد على req.ip الذي يحسبه Express نفسه
    // وفقاً لإعداد trust proxy أعلاه (يثق فقط بأول proxy — ترتيب Render)، ففي الحالة الطبيعية عبر
    // الـ LB يُرجَع IP الزائر الحقيقي، وفي حالة الاتصال المباشر يُرجَع عنوان الاتصال الفعلي.
    const loginIp = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const loginDevice = (req.headers['user-agent'] || '').toString().slice(0, 300);
    // تحقق أولاً من حساب الطوارئ (مخزّن بالكامل في متغيرات البيئة، مستقل عن قاعدة
    // البيانات) — يسمح بالدخول للنظام حتى لو قاعدة البيانات اتغيرت أو كانت فاضية
    // تماماً أو معطّلة. لا يؤثر على حسابات جدول server_users العادية بأي شكل.
    const isEmergencyLogin = await verifyEmergencyAdmin(username.trim(), password);
    if (isEmergencyLogin) {
      const token = signEmergencyToken(username.trim());
      authRepo.recordLogin({ username: username.trim(), role: 'admin', ip: loginIp, device: loginDevice, success: true })
        .catch(e => console.error('تعذّر تسجيل عملية الدخول في السجل:', e));
      return res.json({
        token,
        username: username.trim(),
        role: 'admin',
        user: { username: username.trim(), displayName: 'حساب الطوارئ', role: 'admin' },
      });
    }
    const user = await authRepo.findByUsername(username.trim());
    if (!user) {
      authRepo.recordLogin({ username: username.trim(), role: null, ip: loginIp, device: loginDevice, success: false })
        .catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    // قفل تلقائي مؤقت (بغض النظر عن IP المُستخدَم فى المحاولة الحالية) — يحمي من محاولة تخمين
    // موزّعة على عدة أجهزة/شبكات تتفادى rate limiting العادي المبني على IP وحده.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: loginDevice, success: false })
        .catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      return res.status(403).json({ error: `الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة متكررة، حاول بعد ${minutesLeft} دقيقة` });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: loginDevice, success: false })
        .catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      // 5 محاولات فاشلة متتالية بكلمة المرور تقفل الحساب 15 دقيقة، ثم يُعاد العداد لصفر.
      authRepo.incrementFailedLogin(user.id)
        .catch(e => console.error('تعذّر تحديث عداد المحاولات الفاشلة:', e));
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    // حساب معطّل من طرف المدير: نرفض الدخول برسالة واضحة قبل إصدار أي توكن،
    // حتى لو كانت كلمة المرور صحيحة.
    if (user.is_active === false) {
      authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: loginDevice, success: false })
        .catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      return res.status(403).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });
    }
    // المصادقة الثنائية: كلمة المرور صحيحة والحساب مفعّل، لكن لو هذا المستخدم مفعّل عنده TOTP
    // فلازم نتحقق من كود إضافي قبل إصدار أي توكن — بدون هذه الخطوة، كلمة المرور وحدها كانت كافية.
    // نستخدم الدالة الموحّدة verifySecondFactor (من auth.js) التي تجرّب كود TOTP ثم تكود احتياطي
    // باستهلاك ذرّي (SELECT ... FOR UPDATE) — نفس الدلالات الأمنية تماماً، دون تكرار المنطق هنا.
    if (user.totp_enabled) {
      const sfResult = await verifySecondFactor(user, req.body || {});
      // لسه محتاجين الخطوة التانية — مش خطأ، فقط إشارة للواجهة إنها تعرض حقل الكود.
      // لا نُصدر أي توكن هنا إطلاقاً.
      if (sfResult.needed) {
        return res.json({ requires2FA: true, username: user.username });
      }
      if (!sfResult.ok) {
        authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: loginDevice, success: false })
          .catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
        return res.status(401).json({ error: 'كود التحقق غير صحيح' });
      }
    }
    // نجلب آخر عملية دخول ناجحة سابقة لهذا المستخدم قبل تسجيل عملية الدخول الحالية في السجل
    // (يجب أن يحدث هذا الاستعلام قبل الـ INSERT أسفل، وإلا سيُرجع الدخول الحالي نفسه بدل السابق له).
    // best-effort: فشل هذا الاستعلام لا يجب أن يمنع المستخدم من الدخول فعلياً.
    let lastLogin = null;
    let isNewDevice = false;
    try {
      const prevLogin = await authRepo.lastSuccessfulLogin(user.username);
      lastLogin = prevLogin || null;
      // "جهاز جديد": نفس بصمة الجهاز (User-Agent) لم تُستخدم من قبل مع هذا الحساب في أي دخول
      // ناجح سابق — تقريب بسيط بدون أي مكتبة بصمة إضافية، كافٍ لتنبيه المستخدم/المدير بدخول
      // من متصفح/جهاز لم يره من قبل. لا يُحتسب "جديد" لو كانت هذه أول مرة يدخل فيها الحساب
      // إطلاقاً (lastLogin فارغ)، لتفادي تنبيه لا فائدة منه عند أول تسجيل دخول.
      if (lastLogin && loginDevice) {
        const deviceSeen = await authRepo.deviceSeen(user.username, loginDevice);
        isNewDevice = !deviceSeen;
      }
    } catch (e) {
      console.error('تعذّر جلب آخر عملية دخول سابقة أو التحقق من الجهاز:', e);
    }
    // فحص هل عنوان IP الحالي سبق له دخول ناجح لهذا الحساب — "غير متعارف عليه خارجي" يعني IP لم يُسجَّل من قبل
    let isNewIp = false;
    try {
      if (lastLogin && loginIp) {
        const ipSeen = await authRepo.ipSeen(user.username, loginIp);
        isNewIp = !ipSeen;
      }
    } catch (e) {
      console.error('تعذّر التحقق من عنوان IP:', e);
    }
    // تحديد دولة/مدينة الدخول الحالي — لا نؤخر الاستجابة به، نُشغّله في الخلفية
    let currentGeo = null;
    let geoAlert = null;
    const geoPromise = geolocateIp(loginIp).catch(()=>null);
    const token = signToken(user);
    // نجاح كامل: تصفير عداد المحاولات الفاشلة وأي قفل مؤقت قائم لهذا الحساب.
    authRepo.resetFailedLogin(user.id)
      .catch(e => console.error('تعذّر تصفير عداد المحاولات الفاشلة:', e));
    // تسجيل الدخول + تحديد الدولة يتم في الخلفية بدون تأخير الاستجابة
    geoPromise.then(async g => {
      currentGeo = g;
      if (g && g.country) {
        authRepo.usualCountry(user.username)
          .then(r => {
            const usual = r;
            if (usual && usual !== g.country) geoAlert = { country: g.country, city: g.city, usualCountry: usual };
          }).catch(() => {});
      }
      authRepo.recordLogin({ username: user.username, role: user.role || 'staff', ip: loginIp, device: loginDevice, success: true, country: g?.country || null, city: g?.city || null })
        .catch(e => console.error('تعذّر تسجيل عملية الدخول في السجل:', e));
    });
    // نُرجع username و role صراحة في جسم الاستجابة، لأن الواجهة أصبحت تعتمد عليهما
    // مباشرة لتحديد صلاحيات المستخدم (admin/staff)، بدلاً من أي قائمة محلية داخل البرنامج.
    // الاستجابة تُرسل فوراً — بدون الانتظار في استعلام الأنشطة المشتبكة للمدراء.
    res.json({
      token,
      username: user.username,
      role: user.role || 'staff',
      user: { username: user.username, displayName: user.display_name, role: user.role || 'staff' },
      suspiciousAlert: [],
      lastLogin: lastLogin ? { at: lastLogin.logged_in_at, ip: lastLogin.ip_address, device: lastLogin.device_info } : null,
      newDeviceAlert: isNewDevice,
      geoAlert,
    });
    // تنبيه إيميل فقط للدخول غير المتعارف عليه (خارجي جديد): إذا كان الجهاز أو عنوان IP أو الدولة جديداً
    // — لو الجهاز/IP مسجّل من قبل لا يُرسل إشعار. best-effort: لا يُبطئ الاستجابة ولا يفشل الدخول.
    if (isNewDevice || isNewIp || geoAlert) {
      const reasonLines = [
        isNewDevice ? '<li>تسجيل دخول من جهاز/متصفح لم يُستخدم من قبل مع هذا الحساب</li>' : '',
        isNewIp ? `<li>تسجيل دخول من عنوان IP جديد غير مسجّل لهذا الحساب (${loginIp || 'غير معروف'})</li>` : '',
        geoAlert ? `<li>تسجيل دخول من دولة غير معتادة (${geoAlert.country || 'غير معروفة'}) بينما المعتاد هو ${geoAlert.usualCountry}</li>` : '',
      ].filter(Boolean).join('');
      alertAdmins(
        `دخول غير متعارف عليه للحساب "${user.username}"`,
        `<p>تم رصد دخول غير متعارف عليه للحساب <b>${user.username}</b> (${user.role || 'staff'}):</p>
         <ul>${reasonLines}</ul>
         <p style="color:#888; font-size:13px;">IP: ${loginIp || 'غير معروف'} — الوقت: ${new Date().toLocaleString('ar-EG')}</p>`
      ).catch(() => {});
    }
    // تنبيه استباقي للأدمن: لو فيه نشاط مشبوه (محاولات دخول مشبوهة) حصل منذ آخر مرة راجع
    // فيها شاشة "سجل الدخول"، نُرجعه على شاشة الإعدادات — لا نُبطئ تسجيل الدخول بفحصه
    // مباشرة في استجابة التركيب. يعمل الاستعلام وتحديث last_login_history_seen_at في الخلفية.
    setImmediate(() => {
      if ((user.role || 'staff') === 'admin') {
        const since = user.last_login_history_seen_at || new Date(Date.now() - 24 * 3600 * 1000);
        authRepo.markHistorySeenById(user.id)
          .catch(e => console.error('تعذّر تحديث وقت آخر مراجعة لسجل الدخول:', e));
        authRepo.suspiciousActivitySince(since)
          .then(r => {
            // نُرسل إيميلاً فقط لو فيه صفوف جديدة فعلاً (تُكتشف أول مرة بعد هذا الدخول تحديداً)،
            // لتفادي إرسال نفس التنبيه بالإيميل مع كل دخول أدمن جديد طول ما نفس المحاولات قائمة.
            if (r.length > 0) {
              const rows = r.map(x => `<li>${x.username} من ${x.ip_address || 'IP غير معروف'} — ${x.failed_count} محاولة فاشلة</li>`).join('');
              alertAdmins('محاولات دخول فاشلة متكررة', `<p>تم رصد محاولات دخول فاشلة متكررة:</p><ul>${rows}</ul>`).catch(() => {});
            }
          }).catch(e => console.error('تعذّر فحص النشاط المشبوه:', e));
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/auth/logout -> إبطال فوري لكل توكنات هذا المستخدم (بما فيها التوكن
// المُستخدَم في هذا الطلب نفسه)، بدل الاكتفاء بمسح التوكن من المتصفح فقط.
router.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await authRepo.logoutUser(req.user.sub);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تسجيل الخروج على الخادم' });
  }
});

/* ---------------- بث الأحداث اللحظية (SSE) ----------------
   اتصال يبقى مفتوحاً طوال الجلسة، يُخطِر كل الأجهزة المتصلة (أي دور) فوراً بأي تعديل/حذف/اعتماد
   يحدث من مستخدم آخر — بدل انتظار الفحص الدوري كل دقيقتين فى الواجهة. لا نستخدم requireAuth
   العادي هنا لأن EventSource فى المتصفح لا يدعم إرسال ترويسة Authorization إطلاقاً، فيصل نفس
   التوكن المعتاد عبر query string بدلاً من ذلك (نفس آلية resolveUserFromToken المستخدمة داخلياً
   فى requireAuth، فلا فرق فى قوة التحقق نفسها). خارج أي rate limiter لأنه اتصال واحد طويل لكل
   جهاز وليس سلسلة طلبات متكررة.
   ملاحظة: يظهر التوكن هنا فى الـ URL (سجلات الوصول المحتملة على السيرفر/الوسطاء) — تُقبَل هذه
   نقطة الضعف الصغيرة لأن SSE لا يدعم ترويسات أصلاً، وتوكن الجلسة نفسه (30 يوماً صلاحية) لا
   يتغيّر بذلك عن أي طلب GET آخر لو كان يُمرَّر بطريقة مشابهة. */
router.get('/api/events/stream', async (req, res) => {
  let user;
  try {
    user = await resolveUserFromToken(req.query.token);
  } catch (e) {
    return res.status(e.status || 401).end();
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // يمنع أي وسيط شبكي (proxy) يقف بين المتصفح والسيرفر من تخزين الاستجابة مؤقتاً بدل بثها
    // لحظياً — بدونه قد تصل الأحداث متأخرة أو دفعة واحدة بدل لحظياً حسب إعدادات الوسيط.
    'X-Accel-Buffering': 'no',
  });
  // تعطيل خوارزمية Nagle على هذا الاتصال تحديداً: بدونها، Node/TCP قد يؤخر إرسال حزم صغيرة
  // (مثل نبضة الحياة أو حدث تغيير واحد) بضع مئات المللي ثانية أملاً فى تجميعها مع بيانات أخرى —
  // تأخير غير مقبول لقناة الغرض الوحيد منها السرعة اللحظية.
  try { req.socket.setNoDelay(true); } catch (e) {}
  res.flushHeaders();
  res.write(': connected\n\n');
  const clientId = addSseClient(res, user);
  req.on('close', () => removeSseClient(clientId));
});

/* ---------------- إدارة المستخدمين (للمدير admin فقط) ----------------
   بديل عن تشغيل seed-user.js يدوياً من الطرفية في كل مرة — نفس المنطق بالضبط لكن عبر API
   محمي بـ requireRole('admin') على مستوى الخادم نفسه (مش مجرد إخفاء زر في الواجهة). */
const VALID_SERVER_ROLES = ['admin', 'accountant', 'reception', 'staff'];

// GET /api/users -> قائمة المستخدمين (بدون كلمات المرور المشفّرة أبداً)
router.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const users = await authRepo.listUsers();
    res.json({ users });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة المستخدمين' });
  }
});

// GET /api/users/reception -> قائمة مختصرة (اسم المستخدم + الاسم الظاهر فقط) بموظفي دور الاستقبال حصراً،
// متاحة للمدير والمحاسب معاً (على عكس /api/users الكاملة المقصورة على المدير فقط) — تُستخدم فقط لتعبئة
// فلتر "موظفي الاستقبال" في شيت العملاء وشيت الحركات المالية، ولا تُرجع أي بيانات حساسة أخرى.
router.get('/api/users/reception', requireAuth, requireRole('admin', 'accountant'), async (req, res) => {
  try {
    const users = await authRepo.listReceptionUsers();
    res.json({ users });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة موظفي الاستقبال' });
  }
});

// POST /api/users  body: { username, password, displayName, role, email } -> إنشاء مستخدم جديد أو تحديث كلمة مرور/صلاحية مستخدم موجود
router.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, displayName, role, email } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: 'اسم المستخدم مطلوب' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 6 أحرف' });
  const finalRole = VALID_SERVER_ROLES.includes(role) ? role : 'staff';
  const finalEmail = (email || '').trim() || null;
  try {
    const hash = await hashPassword(password);
    const created = await authRepo.createOrUpdateUser({
      username: username.trim(),
      hash,
      displayName: displayName || username.trim(),
      role: finalRole,
      email: finalEmail,
    });
    res.json({ user: created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حفظ المستخدم' });
  }
});

// DELETE /api/users/:username -> حذف مستخدم (لا يمكن للمدير حذف حسابه الحالي بنفسه لتفادي فقدان الوصول بالخطأ)
router.delete('/api/users/:username', requireAuth, requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  if (target === req.user.username) {
    return res.status(400).json({ error: 'لا يمكنك حذف حسابك الحالي وأنت مسجّل دخول به' });
  }
  try {
    await authRepo.deleteUser(target);
    res.json({ username: target, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف المستخدم' });
  }
});

// GET /api/login-history -> آخر عمليات الدخول (ناجحة وفاشلة) لكل المستخدمين (admin فقط)، بالإضافة
// لملخص "نشاط مشبوه" (تجميع محاولات فاشلة حسب اسم المستخدم/الـ IP خلال آخر ساعة)، حتى يلاحظ
// المدير أي محاولات دخول غير مصرّح بها لم تصل لحد rate limiting نفسه (محاولات متفرقة بطيئة).
router.get('/api/login-history', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const history = await authRepo.loginHistory(300);
    const suspicious = await authRepo.suspiciousLastHour();
    // تسجيل أن هذا الأدمن راجع الشاشة الآن — يمنع تكرار نفس التنبيه الاستباقي عند دخوله لاحقاً
    // لو مفيش نشاط جديد بعد هذه اللحظة.
    authRepo.markHistorySeen(req.user.username)
      .catch(e => console.error('تعذّر تحديث وقت آخر مراجعة لسجل الدخول:', e));
    res.json({ history, suspiciousActivity: suspicious });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب سجل الدخول' });
  }
});

// POST /api/users/:username/force-logout -> تسجيل خروج فوري لهذا المستخدم من كل الأجهزة/الجلسات
// دفعة واحدة (عبر زيادة token_version، بنفس آلية /api/auth/logout الحالية)، بدون حاجة لكلمة مروره.
router.post('/api/users/:username/force-logout', requireAuth, requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  try {
    const loggedOut = await authRepo.forceLogout(target);
    if (!loggedOut) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ username: target, loggedOut: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر إنهاء جلسات هذا المستخدم' });
  }
});

// POST /api/users/:username/toggle-active -> تعطيل/تفعيل حساب مستخدم (بدون حذفه).
// عند التعطيل: يُرفض دخوله فوراً من الآن فصاعداً، وأي جلسة مفتوحة له حالياً تُقطع
// فوراً أيضاً (نزيد token_version بنفس آلية force-logout، بالإضافة لتحقق is_active
// في requireAuth). لا يمكن للمدير تعطيل حسابه الحالي بنفسه لتفادي فقدان الوصول بالخطأ.
router.post('/api/users/:username/toggle-active', requireAuth, requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  if (target === req.user.username) {
    return res.status(400).json({ error: 'لا يمكنك تعطيل حسابك الحالي وأنت مسجّل دخول به' });
  }
  try {
    const updated = await authRepo.toggleActive(target);
    if (!updated) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ username: updated.username, isActive: updated.is_active });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تغيير حالة المستخدم' });
  }
});

/* ---------------- التحقق من كود الترخيص (لا يتطلب تسجيل دخول) ---------------- */
// ربط الترخيص بالجهاز: عند كل تحقق ناجح، نقارن IP الاتصال الحالي (يُحسب من الاتصال نفسه على
// السيرفر تماماً كما فى تسجيل الدخول أعلاه، وليس من أي رأس يمكن للعميل تزييفه) وبصمة الجهاز
// (deviceFingerprint، مُشتقة على الفرونت-إند من خصائص العتاد/المتصفح الفعلية عبر Web Crypto،
// وليست قيمة مخزَّنة فى كاش المتصفح) بالقيم المرتبطة أصلاً بهذا الترخيص (clientId). أول تحقق
// ناجح لأي clientId يُسجَّل كـ"الجهاز الأصلي" تلقائياً. أي اختلاف لاحق (IP أو بصمة أو الاثنين)
// يُسجَّل فى license_activity ويُرسَل تنبيه بالإيميل للإدارة فقط — best-effort بالكامل، لا يمنع
// التحقق من النجاح إطلاقاً حتى لو فشل أي جزء من هذا المنطق.
router.post('/api/license/validate', licenseLimiter, async (req, res) => {
  const { licenseKey, deviceFingerprint } = req.body || {};
  const result = validateLicenseKey(licenseKey);
  if (!result.valid || !result.clientId) {
    return res.json(result);
  }
  try {
    const ip = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const fp = (deviceFingerprint || '').toString().slice(0, 200);
    const existing = await authRepo.getLicenseBinding(result.clientId);
    let isNewIp = false, isNewDevice = false;
    if (existing) {
      const bound = existing;
      isNewIp = !!(ip && bound.bound_ip && ip !== bound.bound_ip);
      isNewDevice = !!(fp && bound.bound_fingerprint && fp !== bound.bound_fingerprint);
      await authRepo.updateLicenseBindingLastSeen(result.clientId, ip, fp);
    } else {
      // أول تحقق ناجح لهذا الترخيص على الإطلاق — يُسجَّل كـ"الجهاز الأصلي" المرجعي.
      await authRepo.insertLicenseBinding(result.clientId, ip, fp);
    }
    if (isNewIp || isNewDevice) {
      const geo = await geolocateIp(ip);
      authRepo.recordLicenseActivity({
          clientId: result.clientId, ip, fp,
          country: geo?.country || null, city: geo?.city || null, isNewIp, isNewDevice,
        })
        .catch(e => console.error('تعذّر تسجيل نشاط ربط الترخيص:', e));
      // تم إلغاء إرسال إشعار الإيميل عند استخدام الترخيص/فتح البرنامج نهائياً حسب الطلب
    }
  } catch (e) {
    // فشل منطق الربط لا يجب أبداً أن يمنع تحقق ترخيص صحيح من النجاح.
    console.error('تعذّر التحقق من ربط الترخيص بالجهاز:', e);
  }
  res.json(result);
});

module.exports = router;
