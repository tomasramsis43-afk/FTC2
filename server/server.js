require('dotenv').config();
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const { pool, ensureSchema } = require('./db');
const { signToken, requireAuth, requireRole, hashPassword, verifyPassword, verifyEmergencyAdmin, signEmergencyToken,
  generateTotpSecret, totpOtpauthUrl, verifyTotpToken, generateBackupCodes, hashBackupCodes, consumeBackupCode } = require('./auth');

const app = express();
// Render (وأغلب منصّات الاستضافة السحابية) تعمل خلف reverse proxy، فبدون هذا
// الإعداد يقرأ Express IP واحد للجميع (IP الـ proxy نفسه) بدل IP الزائر الحقيقي
// من X-Forwarded-For، مما يُبطل عمل rate limiting أدناه تماماً (كل الطلبات
// تُحسب كأنها من نفس المصدر). القيمة 1 تعني "ثق بأول proxy فقط" وهو ترتيب Render.
app.set('trust proxy', 1);
// رؤوس أمان HTTP أساسية (X-Content-Type-Options, X-Frame-Options, HSTS...).
// نعطّل Content-Security-Policy الافتراضي حالياً: الواجهة تحمّل سكريبتات من
// cdnjs.cloudflare.com ولديها معالجات onclick مضمّنة عبر innerHTML، وتفعيل CSP
// الصارم بدون اختبار حي قد يمنعها من العمل. تفعيله لاحقاً كخطوة منفصلة بعد
// حصر كل مصادر السكريبت والتحقق من الواجهة فعلياً.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      // 'unsafe-inline' مطلوبة لأن الواجهة تستخدم innerHTML مع onclick ومعالجات أحداث مضمّنة.
      // cdnjs.cloudflare.com مطلوب للمكتبات الخارجية (xlsx, qrious, html2canvas, jspdf).
      scriptSrc:     ["'self'", "cdnjs.cloudflare.com"],
      styleSrc:      ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc:       ["'self'", "fonts.gstatic.com"],
      imgSrc:        ["'self'", "data:", "blob:"],
      // api.anthropic.com مطلوب لميزة قراءة الفواتير بالذكاء الاصطناعي.
      // fonts.googleapis.com و cdnjs.cloudflare.com مطلوبان لأن Service Worker
      // (sw.js) يعترض طلبات هذه الموارد ويعيد تنفيذ fetch() لها من داخله، وهذا
      // الـ fetch الداخلي يخضع لـ connect-src (وليس فقط style-src/script-src)،
      // فبدون إضافتهما هنا كانت هذه الموارد (الخطوط، xlsx، qrious، html2canvas،
      // jspdf) تفشل بصمت ويُعيد الـ Service Worker استجابة 503 بدلاً منها.
      connectSrc:    ["'self'", "https://api.anthropic.com", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      workerSrc:     ["'self'"],
      frameAncestors:["'none'"],   // حماية من Clickjacking
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
    },
  },
}));
// السماح فقط بالأصول المحدَّدة صراحة عبر متغيّر البيئة CORS_ORIGIN (قائمة مفصولة بفواصل).
// الفرونت-إند والـ API يُخدَّمان أصلاً من نفس الأصل (نفس الدومين)، فلا حاجة فعلية لفتح CORS
// للعالم كله؛ ده كان بيسمح لأي موقع تاني يكلّم الـ API مباشرة من متصفح أي زائر.
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : { origin: false }));
// ضغط كل الاستجابات (gzip) — يقلّل حجم app.html (~1.8MB) واستجابات
// /api/storage (بيانات العملاء/الحركات المشفّرة كنصوص طويلة) بشكل كبير جداً
// أثناء النقل عبر الشبكة، بدون أي تأثير على المحتوى أو المنطق.
app.use(compression());
app.use(express.json({ limit: '25mb' })); // بيانات مشفّرة كاملة (آلاف العملاء) قد تكون كبيرة نسبياً

/* حماية من محاولات التخمين المتكررة (Brute-force) على المسارات التي لا تتطلب
   تسجيل دخول مسبق. نحدّد بالـ IP لأن هذين المسارين تحديداً هما هدف مباشر
   لأي محاولة تخمين آلية (كلمة مرور أو كود ترخيص). */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 20, // 20 محاولة كحد أقصى لكل IP خلال النافذة الزمنية
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة جداً، يرجى الانتظار قليلاً قبل إعادة المحاولة' },
});
const licenseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة جداً، يرجى الانتظار قليلاً قبل إعادة المحاولة' },
});

const storageLimiter = rateLimit({
  windowMs: 60 * 1000, // نافذة دقيقة واحدة
  max: 120,            // 120 عملية حفظ كحد أقصى لكل IP في الدقيقة — يكفي دفعات "مسح + رفع استعادة" كاملة
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'طلبات حفظ كثيرة جداً، يرجى الانتظار قليلاً قبل إعادة المحاولة' },
});
// نقاط الذكاء الاصطناعي (قراءة فواتير OCR / تصنيف مصروفات) هي الوحيدة فى كل السيرفر التي تستدعي
// Anthropic API خارجياً بتكلفة فعلية لكل طلب — بدون حد لمعدل الطلبات، حساب مُخترَق أو مسيء يقدر
// يستهلك رصيد الـ API بسرعة (خصوصاً read-invoices اللي بتقبل حتى 30 ملف فى الطلب الواحد).
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 طلب لكل IP خلال 15 دقيقة (كل طلب read-invoices قد يحتوي حتى 30 ملف بالفعل)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'طلبات ذكاء اصطناعي كثيرة جداً، يرجى الانتظار قليلاً قبل إعادة المحاولة' },
});


/* ---------------- المصادقة الثنائية (TOTP) — أدمن فقط حالياً ---------------- */
// خطوة 1: توليد سر مؤقّت (pending) + رابط otpauth للـ QR — لا يُفعَّل فعلياً إلا بعد
// تأكيد أول كود صحيح فى /verify (يمنع تفعيل غير مقصود لو المستخدم أغلق الصفحة قبل المسح).
app.post('/api/2fa/setup', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const secret = generateTotpSecret();
    await pool.query('UPDATE server_users SET totp_pending_secret = $1 WHERE username = $2', [secret, req.user.username]);
    const otpauthUrl = totpOtpauthUrl(secret, req.user.username);
    res.json({ secret, otpauthUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر بدء إعداد المصادقة الثنائية' });
  }
});
// خطوة 2: تأكيد أول كود من تطبيق المصادقة — عند النجاح ينتقل السر من pending إلى الفعلي
// وتُولَّد 10 أكواد احتياطية تُعرض للمستخدم مرة واحدة فقط (النص الصريح لا يُخزَّن أبداً).
app.post('/api/2fa/verify-setup', requireAuth, requireRole('admin'), authLimiter, async (req, res) => {
  try {
    const r = await pool.query('SELECT totp_pending_secret FROM server_users WHERE username = $1', [req.user.username]);
    const pending = r.rows[0]?.totp_pending_secret;
    if (!pending) return res.status(400).json({ error: 'ابدأ خطوة الإعداد أولاً' });
    if (!verifyTotpToken(req.body?.totpCode, pending)) {
      return res.status(401).json({ error: 'الكود غير صحيح، تأكد من مزامنة الوقت فى جهازك وحاول مجدداً' });
    }
    const backupCodes = generateBackupCodes(10);
    const hashed = await hashBackupCodes(backupCodes);
    await pool.query(
      `UPDATE server_users SET totp_secret = $1, totp_pending_secret = NULL, totp_enabled = true,
       totp_backup_codes = $2, token_version = token_version + 1 WHERE username = $3`,
      [pending, JSON.stringify(hashed), req.user.username]
    );
    res.json({ enabled: true, backupCodes }); // النص الصريح لهذه الأكواد يُعرض مرة واحدة فقط هنا
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تفعيل المصادقة الثنائية' });
  }
});
// إلغاء التفعيل — يتطلب كلمة المرور الحالية كتأكيد إضافي (مش مجرد ضغطة زر عابرة على حساب حساس)
app.post('/api/2fa/disable', requireAuth, requireRole('admin'), authLimiter, async (req, res) => {
  try {
    const r = await pool.query('SELECT password_hash FROM server_users WHERE username = $1', [req.user.username]);
    const ok = r.rows[0] && await verifyPassword(req.body?.password || '', r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
    await pool.query(
      `UPDATE server_users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = false,
       totp_backup_codes = NULL WHERE username = $1`,
      [req.user.username]
    );
    res.json({ enabled: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر إلغاء المصادقة الثنائية' });
  }
});
app.get('/api/2fa/status', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT totp_enabled FROM server_users WHERE username = $1', [req.user.username]);
    res.json({ enabled: !!(r.rows[0] && r.rows[0].totp_enabled) });
  } catch (e) {
    res.status(500).json({ error: 'تعذّر جلب حالة المصادقة الثنائية' });
  }
});

/* ---------------- تسجيل الدخول ---------------- */
app.post('/api/auth/login', authLimiter, async (req, res) => {
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
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info) VALUES ($1, $2, $3, $4)',
        [username.trim(), 'admin', loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل عملية الدخول في السجل:', e));
      return res.json({
        token,
        username: username.trim(),
        role: 'admin',
        user: { username: username.trim(), displayName: 'حساب الطوارئ', role: 'admin' },
      });
    }
    const r = await pool.query('SELECT * FROM server_users WHERE username = $1', [username.trim()]);
    const user = r.rows[0];
    if (!user) {
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
        [username.trim(), null, loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    // قفل تلقائي مؤقت (بغض النظر عن IP المُستخدَم فى المحاولة الحالية) — يحمي من محاولة تخمين
    // موزّعة على عدة أجهزة/شبكات تتفادى rate limiting العادي المبني على IP وحده.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
        [user.username, user.role || 'staff', loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      return res.status(403).json({ error: `الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة متكررة، حاول بعد ${minutesLeft} دقيقة` });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
        [user.username, user.role || 'staff', loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      // 5 محاولات فاشلة متتالية بكلمة المرور تقفل الحساب 15 دقيقة، ثم يُعاد العداد لصفر.
      pool.query(
        `UPDATE server_users SET
           failed_login_count = CASE WHEN failed_login_count + 1 >= 5 THEN 0 ELSE failed_login_count + 1 END,
           locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + INTERVAL '15 minutes' ELSE locked_until END
         WHERE id = $1`,
        [user.id]
      ).catch(e => console.error('تعذّر تحديث عداد المحاولات الفاشلة:', e));
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    // حساب معطّل من طرف المدير: نرفض الدخول برسالة واضحة قبل إصدار أي توكن،
    // حتى لو كانت كلمة المرور صحيحة.
    if (user.is_active === false) {
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
        [user.username, user.role || 'staff', loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      return res.status(403).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });
    }
    // المصادقة الثنائية: كلمة المرور صحيحة والحساب مفعّل، لكن لو هذا المستخدم مفعّل عنده TOTP
    // فلازم نتحقق من كود إضافي قبل إصدار أي توكن — بدون هذه الخطوة، كلمة المرور وحدها كانت كافية.
    if (user.totp_enabled) {
      const { totpCode, backupCode } = req.body || {};
      if (!totpCode && !backupCode) {
        // لسه محتاجين الخطوة التانية — مش خطأ، فقط إشارة للواجهة إنها تعرض حقل الكود.
        // لا نُصدر أي توكن هنا إطلاقاً.
        return res.json({ requires2FA: true, username: user.username });
      }
      let verified = false;
      if (totpCode) {
        verified = verifyTotpToken(totpCode, user.totp_secret);
      } else if (backupCode) {
        // استهلاك الكود الاحتياطي بشكل ذرّي (قفل الصف داخل معاملة قصيرة) — يُغلق نافذة TOCTOU
        // التي كانت تسمح لطلبين متزامنين يحملان نفس الكود بالنجاح معاً قبل أن يلحق أيٌّ منهما
        // بحفظ القائمة المحدَّثة (مقارنة bcrypt البطيئة توسّع النافذة). SELECT ... FOR UPDATE
        // يجعل الطلب الثاني ينتظر حتى يُنفَّذ الأولُ ويُحفظ نتيجةَ الاستهلاك فيكتب فوقها،
        // فيستهلك الكودَ طلبٌ واحد فقط مهما تزامن معه غيره.
        const tx = await pool.connect();
        try {
          await tx.query('BEGIN');
          const locked = await tx.query('SELECT totp_backup_codes FROM server_users WHERE id = $1 FOR UPDATE', [user.id]);
          const result = await consumeBackupCode(locked.rows[0].totp_backup_codes, backupCode);
          verified = result.ok;
          if (result.ok) {
            await tx.query('UPDATE server_users SET totp_backup_codes = $1 WHERE id = $2', [result.remaining, user.id]);
          }
          await tx.query('COMMIT');
        } catch (e) {
          await tx.query('ROLLBACK').catch(() => {});
          console.error(e);
          verified = false;
        } finally {
          tx.release();
        }
      }
      if (!verified) {
        pool.query(
          'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
          [user.username, user.role || 'staff', loginIp, loginDevice]
        ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
        return res.status(401).json({ error: 'كود التحقق غير صحيح' });
      }
    }
    const token = signToken(user);
    // نجاح كامل: تصفير عداد المحاولات الفاشلة وأي قفل مؤقت قائم لهذا الحساب.
    pool.query('UPDATE server_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id])
      .catch(e => console.error('تعذّر تصفير عداد المحاولات الفاشلة:', e));
    // تسجيل عملية الدخول في سجل الدخول (best-effort — فشل هذا التسجيل لا يجب أن يمنع
    // المستخدم من الدخول فعلياً، لذا لا ننتظره ولا نُفشل الطلب لو حدث خطأ فيه).
    pool.query(
      'INSERT INTO login_history (username, role, ip_address, device_info) VALUES ($1, $2, $3, $4)',
      [user.username, user.role || 'staff', loginIp, loginDevice]
    ).catch(e => console.error('تعذّر تسجيل عملية الدخول في السجل:', e));
    // تنبيه استباقي للأدمن: لو فيه نشاط مشبوه (محاولات فاشلة متكررة) حصل منذ آخر مرة راجع فيها
    // شاشة "سجل الدخول" ولسه ما شافوش، نُرجعه هنا فوراً بدل ما يفضل مدفون فى السجل لحد ما يفتحه
    // بنفسه بالصدفة.
    let suspiciousAlert = [];
    if ((user.role || 'staff') === 'admin') {
      try {
        const since = user.last_login_history_seen_at || new Date(Date.now() - 24 * 3600 * 1000);
        const sus = await pool.query(
          `SELECT username, ip_address, COUNT(*)::int AS failed_count, MAX(logged_in_at) AS last_attempt
           FROM login_history
           WHERE success = false AND logged_in_at > $1
           GROUP BY username, ip_address
           HAVING COUNT(*) >= 3
           ORDER BY failed_count DESC LIMIT 10`,
          [since]
        );
        suspiciousAlert = sus.rows;
      } catch (e) { console.error('تعذّر فحص النشاط المشبوه:', e); }
    }
    // نُرجع username و role صراحة في جسم الاستجابة، لأن الواجهة أصبحت تعتمد عليهما
    // مباشرة لتحديد صلاحيات المستخدم (admin/staff)، بدل أي قائمة محلية داخل البرنامج.
    res.json({
      token,
      username: user.username,
      role: user.role || 'staff',
      user: { username: user.username, displayName: user.display_name, role: user.role || 'staff' },
      suspiciousAlert,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/auth/logout -> إبطال فوري لكل توكنات هذا المستخدم (بما فيها التوكن
// المُستخدَم في هذا الطلب نفسه)، بدل الاكتفاء بمسح التوكن من المتصفح فقط.
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE server_users SET token_version = token_version + 1 WHERE id = $1', [req.user.sub]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تسجيل الخروج على الخادم' });
  }
});

/* ---------------- إدارة المستخدمين (للمدير admin فقط) ----------------
   بديل عن تشغيل seed-user.js يدوياً من الطرفية في كل مرة — نفس المنطق بالضبط لكن عبر API
   محمي بـ requireRole('admin') على مستوى الخادم نفسه (مش مجرد إخفاء زر في الواجهة). */
const VALID_SERVER_ROLES = ['admin', 'accountant', 'reception', 'staff'];

// GET /api/users -> قائمة المستخدمين (بدون كلمات المرور المشفّرة أبداً)
app.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, username, display_name, role, is_active, created_at FROM server_users ORDER BY created_at ASC'
    );
    res.json({ users: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة المستخدمين' });
  }
});

// GET /api/users/reception -> قائمة مختصرة (اسم المستخدم + الاسم الظاهر فقط) بموظفي دور الاستقبال حصراً،
// متاحة للمدير والمحاسب معاً (على عكس /api/users الكاملة المقصورة على المدير فقط) — تُستخدم فقط لتعبئة
// فلتر "موظفي الاستقبال" في شيت العملاء وشيت الحركات المالية، ولا تُرجع أي بيانات حساسة أخرى.
app.get('/api/users/reception', requireAuth, requireRole('admin', 'accountant'), async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT username, display_name FROM server_users WHERE role = 'reception' ORDER BY created_at ASC"
    );
    res.json({ users: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة موظفي الاستقبال' });
  }
});

// POST /api/users  body: { username, password, displayName, role } -> إنشاء مستخدم جديد أو تحديث كلمة مرور/صلاحية مستخدم موجود
app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, displayName, role } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: 'اسم المستخدم مطلوب' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 6 أحرف' });
  const finalRole = VALID_SERVER_ROLES.includes(role) ? role : 'staff';
  try {
    const hash = await hashPassword(password);
    const r = await pool.query(
      `INSERT INTO server_users (username, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
         display_name = COALESCE(EXCLUDED.display_name, server_users.display_name),
         role = EXCLUDED.role,
         token_version = server_users.token_version + 1
       RETURNING id, username, display_name, role, created_at`,
      [username.trim(), hash, displayName || username.trim(), finalRole]
    );
    res.json({ user: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حفظ المستخدم' });
  }
});

// DELETE /api/users/:username -> حذف مستخدم (لا يمكن للمدير حذف حسابه الحالي بنفسه لتفادي فقدان الوصول بالخطأ)
app.delete('/api/users/:username', requireAuth, requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  if (target === req.user.username) {
    return res.status(400).json({ error: 'لا يمكنك حذف حسابك الحالي وأنت مسجّل دخول به' });
  }
  try {
    await pool.query('DELETE FROM server_users WHERE username = $1', [target]);
    res.json({ username: target, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف المستخدم' });
  }
});

// GET /api/login-history -> آخر عمليات الدخول (ناجحة وفاشلة) لكل المستخدمين (admin فقط)، بالإضافة
// لملخص "نشاط مشبوه" (تجميع محاولات فاشلة حسب اسم المستخدم/الـ IP خلال آخر ساعة)، حتى يلاحظ
// المدير أي محاولات دخول غير مصرّح بها لم تصل لحد rate limiting نفسه (محاولات متفرقة بطيئة).
app.get('/api/login-history', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT username, role, ip_address, device_info, logged_in_at, success FROM login_history ORDER BY logged_in_at DESC LIMIT 300'
    );
    const suspicious = await pool.query(
      `SELECT username, ip_address, COUNT(*)::int AS failed_count, MAX(logged_in_at) AS last_attempt
       FROM login_history
       WHERE success = false AND logged_in_at > now() - INTERVAL '1 hour'
       GROUP BY username, ip_address
       HAVING COUNT(*) >= 3
       ORDER BY failed_count DESC`
    );
    // تسجيل أن هذا الأدمن راجع الشاشة الآن — يمنع تكرار نفس التنبيه الاستباقي عند دخوله لاحقاً
    // لو مفيش نشاط جديد بعد هذه اللحظة.
    pool.query('UPDATE server_users SET last_login_history_seen_at = now() WHERE username = $1', [req.user.username])
      .catch(e => console.error('تعذّر تحديث وقت آخر مراجعة لسجل الدخول:', e));
    res.json({ history: r.rows, suspiciousActivity: suspicious.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب سجل الدخول' });
  }
});

// POST /api/users/:username/force-logout -> تسجيل خروج فوري لهذا المستخدم من كل الأجهزة/الجلسات
// دفعة واحدة (عبر زيادة token_version، بنفس آلية /api/auth/logout الحالية)، بدون حاجة لكلمة مروره.
app.post('/api/users/:username/force-logout', requireAuth, requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  try {
    const r = await pool.query('UPDATE server_users SET token_version = token_version + 1 WHERE username = $1 RETURNING username', [target]);
    if (!r.rows[0]) return res.status(404).json({ error: 'المستخدم غير موجود' });
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
app.post('/api/users/:username/toggle-active', requireAuth, requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  if (target === req.user.username) {
    return res.status(400).json({ error: 'لا يمكنك تعطيل حسابك الحالي وأنت مسجّل دخول به' });
  }
  try {
    const r = await pool.query(
      `UPDATE server_users
       SET is_active = NOT is_active, token_version = token_version + 1
       WHERE username = $1
       RETURNING username, is_active`,
      [target]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ username: r.rows[0].username, isActive: r.rows[0].is_active });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تغيير حالة المستخدم' });
  }
});

/* ---------------- التحقق من كود الترخيص (لا يتطلب تسجيل دخول) ---------------- */
const { validateLicenseKey } = require('./license');
app.post('/api/license/validate', licenseLimiter, (req, res) => {
  const { licenseKey } = req.body || {};
  const result = validateLicenseKey(licenseKey);
  res.json(result);
});

/* ---------------- مخزن المفاتيح/القيم (يطابق واجهة window.storage) ---------------- */

/* مشروع تقييد صلاحيات kv_store حسب الدور — تدريجي وليس دفعة واحدة، لأن أغلب
   المفاتيح مُحمَّلة فعلياً من كل الأدوار عبر مسارات كود مشتركة (مثال: ملخص لوحة
   التحكم المتاحة للاستقبال كان يعتمد على بيانات الخزنة رغم أن تبويب "الخزنة"
   نفسه محجوب عنهم — تم فصل هذا في الواجهة، راجع renderCfoDashboard). كل مفتاح
   يُضاف هنا فقط بعد فحص فعلي (grep شامل على كل دوال render في app-inline.js)
   يتأكد أنه غير مُستخدَم من أي شاشة متاحة للأدوار الممنوعة منه.

   مطابقة تماماً لنفس ROLE_PERMISSIONS/RESTRICTED_STAFF_VIEWS في app-inline.js —
   يجب تحديث الاثنين معاً لو تغيّرت صلاحيات الأدوار مستقبلاً. */
const ROLE_PERMISSIONS = {
  admin: null,
  staff: null,
  accountant: ['dashboard', 'clients', 'vault', 'accounting', 'budget', 'reports', 'purchases', 'companies'],
  reception: ['dashboard', 'clients', 'courses', 'courseinvoices', 'bags'],
};
const RESTRICTED_STAFF_VIEWS = ['settings', 'audit', 'accounting', 'zatca', 'budget'];
function roleCanAccessView(role, view) {
  if (role === 'admin') return true;
  const allow = ROLE_PERMISSIONS[role];
  if (allow) return allow.includes(view);
  return !RESTRICTED_STAFF_VIEWS.includes(view); // staff (أو أي دور غير معروف): كل شيء ما عدا القائمة المحظورة
}
// key -> null: مقصور على admin دائماً (بلا علاقة بأي "شاشة"، مثال: users نظام قديم).
// key -> اسم شاشة: يُطبَّق عليه roleCanAccessView بنفس منطق الواجهة.
const RESTRICTED_STORAGE_KEYS = {
  users: null,
  companyTransfers: 'companies',
  // تحقّقتُ عبر فحص كل دالة render تستخدم كل مفتاح من هذه: كلها مقصورة فعلياً
  // على شاشتها (لا تُستخدم إطلاقاً من أي شاشة متاحة لـ'استقبال'، وهو الدور
  // الوحيد الأضيق صلاحية هنا؛ منطق roleCanAccessView يغطي 'موظف عام' تلقائياً
  // عبر RESTRICTED_STAFF_VIEWS بما يطابق الواجهة تماماً).
  journalEntries: 'accounting',
  chartOfAccounts: 'accounting',
  journalDE: 'accounting',
  manualSalesInvoices: 'accounting',
  budgetEntries: 'budget',
  suppliers: 'purchases',
  zakatAdjustments: 'zatca',
  // تحقّقت أن الاتنين دول مقصورين فعلياً على شاشة 'الخزنة' (renderVault/renderBankRecon)
  // ولا يُستخدمان من أي شاشة متاحة للاستقبال — بخلاف vaultTx وdeletedVaultTx وdeletedInvoices
  // اللي فحصتها ولقيتها متشابكة فعلياً مع ميزات شرعية في شاشتي 'العملاء' و'الحقائب'.
  vaultDenomTx: 'vault',
  bankStatementRows: 'vault',
  // سجل التدقيق محتواه حساس (من؟ ماذا؟ متى؟) ويُقرأ فقط من شاشة 'التدقيق' المغلقة عن كل الأدوار
  // غير الأدمن (راجع RESTRICTED_STAFF_VIEWS/ROLE_PERMISSIONS) — فيُقيَّد هنا على نفس الشاشة بدل
  // بقائه مفتوحاً كتصنيف بيانات عادي لأي دور مصادق يفتح /api/records/auditLog مباشرة.
  auditLog: 'audit',
};
function restrictKeyToAdmin(req, res, next) {
  const key = req.params.key;
  // 'clients' مفتاح قديم (كتلة واحدة لكل عملاء الشركة) قبل ميلاد نظام client_records. لسه مستخدَم
  // كخط رجعة فقط عند انقطاع الاتصال أو أول تحميل قبل تأكيد المزامنة (راجع saveClients فى
  // ui-framework.js). بعد عزل كل مستخدم استقبال عن الآخر، مصفوفة "clients" فى ذاكرة أي مستخدم
  // استقبال بقت تحتوي بياناته الشخصية فقط (مش كل مستخدمي الاستقبال زي الأول) — فلو خط الرجعة ده
  // اشتغل واستبدل الكتلة المشتركة الكاملة (كل عملاء الشركة) بمصفوفة مستخدم استقبال واحد الصغيرة،
  // هيمحو بيانات باقي الشركة. نمنع دور 'reception' نهائياً من الكتابة/القراءة على هذا المفتاح
  // تحديداً (بخلاف كل الأدوار الأخرى التي تبقى كما كانت)، فيعتمد فقط على مسار client_records الآمن.
  if (key === 'clients' && req.user.role === 'reception') {
    return res.status(403).json({ error: 'ليست لديك صلاحية الوصول لهذا المفتاح' });
  }
  if (!(key in RESTRICTED_STORAGE_KEYS)) return next();
  const view = RESTRICTED_STORAGE_KEYS[key];
  const allowed = view === null ? req.user.role === 'admin' : roleCanAccessView(req.user.role, view);
  if (!allowed) return res.status(403).json({ error: 'ليست لديك صلاحية كافية للوصول لهذه البيانات' });
  next();
}

// GET /api/storage/:key  -> { key, value, version }
// يدعم If-None-Match: لو الجهاز عنده نفس النسخة (version) بالفعل، نرد 304 بدون
// إعادة إرسال القيمة كاملة (ممكن تكون مئات الكيلوبايتات لمفاتيح زي قوائم العملاء
// أو حركات الخزنة)، فنوفر نقل البيانات في كل مرة يفتح فيها المستخدم البرنامج
// ولم يتغيّر شيء منذ آخر زيارة.
// GET /api/clients?page=&pageSize=&search=&nationality=&courseType=&dateFrom=&dateTo=&sort=&order=
// ترقيم/بحث/فلترة حقيقية من قاعدة البيانات (بدون تحميل كل العملاء للمتصفح)، تُستخدم فقط من
// شاشة "جدول العملاء" نفسها للحالات الشائعة (تصفح + بحث بالاسم/الهوية + فلترة بالجنسية/الدورة/التاريخ).
// فلاتر المبالغ (مدين/مسدد) والفرز بالمبالغ غير مدعومة هنا عمداً لأنها تعتمد على حسابات معقّدة
// (خصومات، دفعات جزئية...) موجودة فقط بمنطق الواجهة الأمامية — تلك الحالات تستمر تُحسب من
// المصفوفة الكاملة المحمّلة أصلاً بالمتصفح كما كانت قبل هذا التحديث، بلا أي تغيير في نتيجتها.
app.get('/api/clients', requireAuth, async (req, res) => {
  // هذه النقطة تقرأ من clients_rows (نسخة مفهرسة غير مقيَّدة بعزل origin/status)، فتُمنع
  // تماماً عن دور 'reception' حتى لا تُسرّب عملاء خارج تخزينه الخاص. الواجهة أصلاً لا تستدعيها
  // لهذا الدور (راجع canSeeAllData/clientsQueryIsSimple فى module-clients.js)، وهذا خط دفاع
  // إضافي على مستوى السيرفر نفسه.
  if (req.user.role === 'reception') return res.status(403).json({ error: 'غير متاح لهذا الدور' });
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const where = [];
    const params = [];
    let i = 1;
    if (req.query.search) {
      where.push(`(name ILIKE $${i} OR client_id ILIKE $${i} OR refer_num ILIKE $${i} OR invoice_no ILIKE $${i})`);
      params.push('%' + req.query.search + '%'); i++;
    }
    if (req.query.nationality) { where.push(`nationality = $${i}`); params.push(req.query.nationality); i++; }
    if (req.query.courseType) { where.push(`course_type = $${i}`); params.push(req.query.courseType); i++; }
    if (req.query.dateFrom) { where.push(`reg_date >= $${i}`); params.push(req.query.dateFrom); i++; }
    if (req.query.dateTo) { where.push(`reg_date <= $${i}`); params.push(req.query.dateTo); i++; }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sortCols = { name: 'name', date: 'reg_date', clientId: 'client_id', courseType: 'course_type', nationality: 'nationality' };
    const sortCol = sortCols[req.query.sort] || 'name';
    const order = req.query.order === 'desc' ? 'DESC' : 'ASC';
    const totalR = await pool.query(`SELECT COUNT(*) FROM clients_rows ${whereSql}`, params);
    const rowsR = await pool.query(
      `SELECT data FROM clients_rows ${whereSql} ORDER BY ${sortCol} ${order} NULLS LAST LIMIT $${i} OFFSET $${i + 1}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({
      rows: rowsR.rows.map(r => r.data),
      total: Number(totalR.rows[0].count),
      page, pageSize,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب بيانات العملاء' });
  }
});

app.get('/api/storage/:key', requireAuth, restrictKeyToAdmin, async (req, res) => {
  try {
    // meta=1: نحتاج فقط رقم النسخة (version) الحالي بدون نقل القيمة الكاملة — مهم خصوصاً
    // لمفتاح 'clients' القديم الذي قد يكون عدة ميجابايت لعملاء كثيرين تمت مزامنتهم بالفعل عبر
    // نظام client_records الأحدث، ولا داعي إطلاقاً لتنزيله فقط لمعرفة رقم نسخته الحالي.
    if (req.query.meta === '1') {
      const rMeta = await pool.query('SELECT version FROM kv_store WHERE key = $1', [req.params.key]);
      return res.json({ key: req.params.key, version: rMeta.rows[0] ? rMeta.rows[0].version : 0 });
    }
    const r = await pool.query('SELECT value, version FROM kv_store WHERE key = $1', [req.params.key]);
    if (!r.rows[0]) return res.json({ key: req.params.key, value: null, version: 0 });
    const { value, version } = r.rows[0];
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && Number(ifNoneMatch) === version) {
      return res.status(304).end();
    }
    res.setHeader('ETag', String(version));
    res.json({ key: req.params.key, value, version });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّرت قراءة البيانات' });
  }
});

// PUT /api/storage/:key  body: { value, version } -> { key, value, version }
// يستخدم Optimistic Concurrency: يرفض الحفظ (409) إن كان شخص آخر قد عدّل نفس
// المفتاح بعد آخر قراءة معروفة لهذا الجهاز، بدل الكتابة فوق تعديله بصمت.
// (تحسين أداء: استعلام SQL واحد فقط بدل استعلامين متتاليين — يقلّل زمن كل
// عملية حفظ تقريباً للنصف، خصوصاً مع اتصال قاعدة بيانات بعيد/بطيء الشبكة).
// يُستدعى فقط بعد نجاح حفظ مفتاح 'clients' في kv_store (نفس مسار الحفظ القديم بدون
// أي تغيير فيه)، لمزامنة النسخة "المفهرسة" clients_rows المستخدمة حصراً بواسطة
// GET /api/clients أدناه. عدم استخدام Transaction هنا مقصود: فشل المزامنة (نادر جداً)
// لا يجب أن يُفشل عملية الحفظ الأساسية نفسها التي نجحت بالفعل في kv_store.
// ملاحظة مهمة (إصلاح): النسخة السابقة كانت تحذف الجدول بالكامل ثم تُدرج كل الصفوف
// داخل معاملة (transaction) واحدة تفشل بالكامل (ROLLBACK) لو صف واحد فقط فيه خطأ —
// أخطرها تكرار نفس المعرّف (id) مرتين في المصفوفة (بيانات قديمة/استيراد قديم)، مما
// كان يجعل clients_rows يبقى فارغاً تماماً وبشكل دائم (كل عملية حفظ لاحقة تفشل بنفس
// السبب)، فيظهر شيت العملاء فارغاً رغم أن العدد الإجمالي صحيح. الحل: UPSERT لكل صف
// على حدة (يتجاوز تكرار id بدل أن يوقف كل شيء)، مع تجاهل الصف السيّئ فقط إن وُجد
// (بدل إلغاء المزامنة كلها)، ثم حذف الصفوف القديمة غير الموجودة في المصفوفة الحالية.
// تحسين أداء مهم (كان سبب تأخير ظهور البيانات بعد أي استيراد/تعديل دفعة عملاء):
// النسخة السابقة كانت تنفّذ استعلام INSERT منفصل لكل عميل بالتتابع (await داخل for)،
// أي أن حفظ 5000 عميل مثلاً يعني 5000 رحلة ذهاب/إياب منفصلة لقاعدة البيانات، قد تستغرق
// دقائق فعلياً على استضافة بها زمن استجابة شبكة ولو بسيط لكل استعلام — وطوال هذه المدة
// يبقى GET /api/clients (شاشة جدول العملاء المرقّمة) يعرض بيانات قديمة/غير مكتملة، وهو
// ما يظهر للمستخدم كأن "المشتريات/العملاء المستوردة لا تظهر" أو تتأخر كثيراً بعد أي رفع
// بيانات من السحابة. الحل: تجميع الصفوف في دفعات (كل دفعة = استعلام INSERT واحد متعدد
// الصفوف)، فيهبط عدد الرحلات لقاعدة البيانات من N إلى ~N/300 فقط، مع الحفاظ تماماً على
// نفس صلابة السلوك القديم (تجاوز أي صف سيّئ بدل إلغاء العملية كلها): لو فشلت دفعة كاملة
// (نادر جداً)، نعيد محاولتها صفاً صفاً لتلك الدفعة فقط بدل فقدها بالكامل.
const CLIENTS_ROWS_CHUNK_SIZE = 300;
async function upsertClientsRowsChunk(chunk) {
  const values = [];
  const placeholders = chunk.map((c, idx) => {
    const base = idx * 10;
    values.push(c.id, JSON.stringify(c), c.name || '', c.clientId || '', c.referNum || '',
      c.nationality || '', c.courseType || '', c.courseNumber || '', c.invoice || '', c.date || '');
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
  }).join(',');
  await pool.query(
    `INSERT INTO clients_rows (id, data, name, client_id, refer_num, nationality, course_type, course_number, invoice_no, reg_date)
     VALUES ${placeholders}
     ON CONFLICT (id) DO UPDATE SET
       data = EXCLUDED.data, name = EXCLUDED.name, client_id = EXCLUDED.client_id,
       refer_num = EXCLUDED.refer_num, nationality = EXCLUDED.nationality,
       course_type = EXCLUDED.course_type, course_number = EXCLUDED.course_number,
       invoice_no = EXCLUDED.invoice_no, reg_date = EXCLUDED.reg_date, updated_at = now()`,
    values
  );
}
async function syncClientsRows(value) {
  let arr;
  try { arr = JSON.parse(value || '[]'); } catch (e) { return; }
  if (!Array.isArray(arr)) return;
  const valid = arr.filter(c => c && c.id);
  const ids = [];
  let failedRows = 0;
  for (let start = 0; start < valid.length; start += CLIENTS_ROWS_CHUNK_SIZE) {
    const chunk = valid.slice(start, start + CLIENTS_ROWS_CHUNK_SIZE);
    try {
      await upsertClientsRowsChunk(chunk);
      chunk.forEach(c => ids.push(c.id));
    } catch (e) {
      // فشلت الدفعة كاملة (مثلاً id مكرر داخلها) — نعيد المحاولة صفاً صفاً لهذه الدفعة
      // فقط، حتى نتجاوز الصف السيّئ تحديداً دون فقد باقي الدفعة.
      for (const c of chunk) {
        try {
          await upsertClientsRowsChunk([c]);
          ids.push(c.id);
        } catch (e2) {
          failedRows++;
          console.error(`تعذّرت مزامنة صف عميل واحد (id=${c.id}):`, e2.message);
        }
      }
    }
  }
  if (failedRows) console.error(`مزامنة clients_rows: تم تجاوز ${failedRows} صف بسبب خطأ (غالباً id مكرر)، وتمت مزامنة الباقي بنجاح`);
  try {
    if (ids.length) {
      await pool.query(`DELETE FROM clients_rows WHERE id != ALL($1)`, [ids]);
    } else if (arr.length === 0) {
      // المصفوفة فارغة فعلاً (لا يوجد أي عميل) — نفرّغ الجدول المفهرس ليطابق ذلك.
      await pool.query('DELETE FROM clients_rows');
    }
    // لو arr غير فارغة لكن ids فارغة (كل الصفوف فشلت)، لا نحذف شيئاً تحسباً لخطأ عابر
    // (مثل انقطاع اتصال) حتى لا نفقد البيانات المفهرسة السابقة بلا داعٍ.
  } catch (e) {
    console.error('تعذّر حذف الصفوف القديمة من clients_rows:', e.message);
  }
}

// طابور يمنع تداخل عمليتي مزامنة متزامنتين (Race Condition):
// لو حفظ مستخدمان بيانات clients في نفس اللحظة، بدون طابور تبدأ عمليتا
// مزامنة بالتوازي — العملية الأولى قد تحذف صفوفاً أضافتها الثانية عبر
// DELETE...WHERE id != ALL($1)، فيختفي جزء من بيانات العملاء الفهرسة.
// الطابور يضمن أن كل عملية تنتهي قبل أن تبدأ التالية.
let _syncQueue = Promise.resolve();
function queueSyncClientsRows(value) {
  _syncQueue = _syncQueue
    .then(() => syncClientsRows(value))
    .catch(e => console.error('تعذّرت مزامنة clients_rows في الطابور:', e.message));
}

// حماية من "انحدار التشفير" (encryption downgrade): لو كانت القيمة الحالية المخزَّنة لهذا
// المفتاح مشفّرة فعلاً (تبدأ بـ 'ENC1:' أو 'ENC2:') والقيمة الجديدة المُرسَلة من هذا الحفظ غير مشفّرة،
// هذا نمط يطابق تحديداً جهازاً يعمل بدون مفتاح تشفير صالح (مثال: فُتح البرنامج عبر رابط غير
// HTTPS فلا يتوفر Web Crypto، أو تعطّل تفعيل الترخيص) بينما توجد بيانات حقيقية مشفّرة بالفعل.
// هذا الجهاز يفشل في فك تشفير تلك البيانات فيتعامل معها كأنها فارغة، ثم يحفظ نسخته الناقصة/الفارغة
// فوقها — فيمحو بيانات كل المستخدمين الآخرين من السيرفر. لا يحتاج هذا الفحص فك أي تشفير: مجرد
// مقارنة نصية للبادئة كافية لرصد هذا النمط تحديداً ومنعه قبل وقوع أي ضرر.
async function wouldDowngradeEncryption(key, newValue) {
  // القيمة الجديدة مشفّرة بأي من الصيغتين المعتمدتين (ENC1 = قديمة، ENC2 = مضغوطة+مشفّرة)
  if (typeof newValue !== 'string' || newValue.startsWith('ENC1:') || newValue.startsWith('ENC2:')) return false;
  // نجلب أول 5 حروف فقط (بادئة التشفير) بدل جلب كامل القيمة التي قد تكون عدة ميجابايت —
  // هذا يُقلّل الحمل على قاعدة البيانات بشكل كبير في كل عملية حفظ.
  const cur = await pool.query('SELECT LEFT(value, 5) AS prefix FROM kv_store WHERE key = $1', [key]);
  const prefix = cur.rows[0] && cur.rows[0].prefix;
  return (prefix === 'ENC1:' || prefix === 'ENC2:');
}

app.put('/api/storage/:key', requireAuth, storageLimiter, restrictKeyToAdmin, async (req, res) => {
  const { value } = req.body || {};
  const knownVersion = Number.isInteger(req.body?.version) ? req.body.version : 0;
  try {
    if (await wouldDowngradeEncryption(req.params.key, value)) {
      console.error(`رُفض حفظ خطير: ${req.user.username} حاول استبدال بيانات مشفّرة بأخرى غير مشفّرة للمفتاح "${req.params.key}"`);
      return res.status(422).json({
        error: 'تم رفض هذا الحفظ وقائياً: البيانات الحالية على السيرفر مشفّرة، لكن جهازك حاول حفظ بيانات غير مشفّرة — على الأرجح لأن مفتاح التشفير غير جاهز على هذا المتصفح/الجهاز (تأكد أنك تفتح البرنامج عبر رابط HTTPS صحيح). أعد تحميل الصفحة وسجّل الدخول من جديد قبل إعادة المحاولة، حتى لا تُفقد بيانات باقي المستخدمين.',
      });
    }
    const upsert = await pool.query(
      `INSERT INTO kv_store (key, value, version, updated_by)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         version = kv_store.version + 1,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by
       WHERE kv_store.version = $4
       RETURNING version`,
      [req.params.key, value, req.user.username, knownVersion]
    );
    if (upsert.rows[0]) {
      // نستخدم "value" (نفس القيمة اللي بعتها الواجهة للتو، موجودة أصلاً فى الذاكرة) بدل طلب
      // "RETURNING value" من قاعدة البيانات — لا داعي لأي رحلة إضافية لنقل نفس البيانات الضخمة
      // (قد تصل لعدة ميجابايت مع آلاف العملاء) من قاعدة البيانات ثم تخزينها فى المتغيّر مرة أخرى.
      if (req.params.key === 'clients') queueSyncClientsRows(value);
      // لا نُعيد "value" فى الرد: المتصفح أصلاً يملك نفس البيانات التي أرسلها للتو ولا يستخدم
      // القيمة الراجعة من هذا الرد إطلاقاً (انظر window.storage.set فى storage-sync.js) — فإعادة
      // إرسالها كانت تضاعف حجم البيانات المنقولة فى كل عملية حفظ (رفع + تنزيل لنفس البيانات)، وهو ما
      // كان يُشعر المستخدم ببطء واضح فى وقت انتظار الرد بعد كل تسجيل/حذف كل ما تكبر البيانات.
      return res.json({ key: req.params.key, version: upsert.rows[0].version });
    }
    // لم يتحدّث أي صف: إما أن المفتاح موجود بنسخة مختلفة عن knownVersion (تعارض حقيقي)،
    // أو حالة نادرة (سباق بين عملية INSERT أولى من جهازين معاً على نفس المفتاح الجديد).
    // في الحالتين نرجع للمستخدم الحالة الحقيقية الحالية بدل افتراض تعارض دائماً.
    const current = await pool.query('SELECT version FROM kv_store WHERE key = $1', [req.params.key]);
    return res.status(409).json({
      error: 'تعارض: تم تعديل هذه البيانات من جهاز آخر بعد آخر تحديث لديك. يرجى تحديث الصفحة وإعادة تنفيذ العملية.',
      currentVersion: current.rows[0] ? current.rows[0].version : 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حفظ البيانات' });
  }
});

// حذف مفتاح من kv_store — نقصره على admin فقط لأنه إجراء لا رجعة فيه (فقدان بيانات نهائي)،
// بينما القراءة/الكتابة تبقى متاحة لأي مستخدم مسجّل دخول كما كانت (يحتاجها كل الأدوار
// لعملهم اليومي: تسجيل عملاء، دفعات، إلخ).
app.delete('/api/storage/:key', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM kv_store WHERE key = $1', [req.params.key]);
    if (req.params.key === 'clients') await pool.query('DELETE FROM clients_rows').catch(()=>{});
    res.json({ key: req.params.key, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر الحذف' });
  }
});

app.get('/api/storage', requireAuth, async (req, res) => {
  const prefix = req.query.prefix || '';
  try {
    const r = await pool.query('SELECT key FROM kv_store WHERE key LIKE $1', [prefix + '%']);
    res.json({ keys: r.rows.map(x => x.key) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب القائمة' });
  }
});

/* ============================================================================
   عملاء كسجلات مستقلة (client_records)
   ==============================================================================
   بديل عن حفظ كل العملاء ككتلة واحدة مشفّرة (راجع تعليق CREATE TABLE client_records
   فى schema.sql). السيرفر هنا أيضاً لا يفك أي تشفير إطلاقاً؛ "enc" نص معتم تماماً
   كما كان الحال دائماً فى kv_store('clients')، والفرق الوحيد أن كل عميل مُشفَّر
   بمفرده بدل تشفير المصفوفة كاملة — فتسجيل/تعديل/حذف عميل واحد ينقل بيانات هذا
   العميل فقط، بغض النظر عن إجمالي عدد العملاء. صلاحيات من يقدر يعدّل/يحذف عميلاً
   بعينه مطبَّقة فى الواجهة كما كانت دائماً (canDeleteClientRecord وغيرها)؛ هذه
   النقاط تحتاج requireAuth فقط، تماماً كحفظ مفتاح kv_store('clients') سابقاً. */

// عزل بيانات الاستقبال (origin/status/created_by، راجع تعليق CREATE TABLE client_records فى
// schema.sql): الأدمن فقط يرى كل شيء (عام + مسودات/معتمدات كل الاستقبال). كل مستخدم استقبال
// يرى فقط سجلاته هو شخصياً (origin='reception' AND created_by = اسم المستخدم الحالي) — معزول
// تماماً عن بقية مستخدمي الاستقبال، وليس مساحة مشتركة بينهم. أي دور آخر (staff/accountant) يرى
// فقط السجلات المعتمدة status='confirmed' (نفس السلوك القديم تماماً بالنسبة له).
function clientRecordsVisibilitySql(role, username) {
  if (role === 'admin') return { where: '', params: [] };
  if (role === 'reception') return { where: 'WHERE origin = $1 AND created_by = $2', params: ['reception', username] };
  return { where: 'WHERE status = $1', params: ['confirmed'] };
}

app.get('/api/client-records', requireAuth, async (req, res) => {
  try {
    const { where, params } = clientRecordsVisibilitySql(req.user.role, req.user.username);
    const r = await pool.query(`SELECT id, enc, version, origin, status FROM client_records ${where}`, params);
    res.json({ records: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب سجلات العملاء' });
  }
});

// رقم إصدار خفيف جداً (مجموع أرقام النسخ لكل الصفوف) يتغيّر مع أي إضافة/تعديل/حذف — تستخدمه
// الأجهزة الأخرى للتحقّق الدوري السريع (طلب واحد صغير، بدون نقل أي بيانات فعلية) من وجود
// تعديلات جديدة على العملاء من مستخدم آخر، بنفس فكرة GET /api/storage-versions لبقية المفاتيح.
// نفس فلترة الرؤية أعلاه بالضبط، وإلا يظهر للمستخدم إشعار "يوجد تحديث" عن سجلات لا يحق له رؤيتها أصلاً.
app.get('/api/client-records/version', requireAuth, async (req, res) => {
  try {
    const { where, params } = clientRecordsVisibilitySql(req.user.role, req.user.username);
    const r = await pool.query(`SELECT COALESCE(SUM(version),0)::bigint AS v, COUNT(*)::int AS c FROM client_records ${where}`, params);
    res.json({ version: Number(r.rows[0].v), count: r.rows[0].c });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب رقم إصدار العملاء' });
  }
});

// كشف تكرار رقم الهوية عبر كل مستخدمي النظام (بمن فيهم كل مستخدمي الاستقبال المعزولين عن بعضهم
// وعن باقي البيانات): ترجع فقط معرّف السجل + بصمة (SHA-256) لرقم الهوية — لا النص الصريح إطلاقاً،
// ولا اسم/هاتف/مبالغ/أي حقل آخر — فلا تكسر عزل خصوصية بيانات الاستقبال المطبَّق فى كل مكان آخر،
// وفي نفس الوقت تمنع (على مستوى السيرفر نفسه) أي مستخدم مصادق — حتى الاستقبال الأقل صلاحية — من
// نسخ أرقام الهوية الكاملة لكل عملاء الشركة دفعةً واحدة (إصلاح تسريب البيانات الشخصية). العميل
// يحسب البصمة لنفس المدخل بنفس الخوارزمية (SHA-256، hex) فبقى فحص التكرار يعمل كما هو عمداً.
// لا فلترة origin/status هنا عمداً: حتى السجلات المعلَّقة (pending) لاستقبال آخر تحسب كـ"مستخدَمة
// بالفعل" لمنع تكرارها.
app.get('/api/client-records/ids', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, client_id FROM client_records WHERE client_id IS NOT NULL AND client_id <> ''`);
    res.json({ ids: r.rows.map(row => ({ id: row.id, clientIdHash: crypto.createHash('sha256').update(row.client_id).digest('hex') })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة أرقام الهوية' });
  }
});

app.put('/api/client-records/:id', requireAuth, storageLimiter, async (req, res) => {
  const { enc } = req.body || {};
  if (typeof enc !== 'string' || !enc) return res.status(400).json({ error: 'بيانات العميل المرسلة غير صحيحة' });
  const knownVersion = Number.isInteger(req.body?.version) ? req.body.version : 0;
  // clientId اختياري نصاً صريحاً (غير مشفّر) بغرض فحص التكرار فقط عبر /api/client-records/ids —
  // لا يُستخدم فى أي مكان آخر ولا يُعرَض عبر أي نقطة وصول أخرى غير هذه.
  const plainClientId = (typeof req.body?.clientId === 'string' && req.body.clientId.trim()) ? req.body.clientId.trim() : null;
  try {
    // حماية عزل بيانات الاستقبال: يمنع نهائياً (حتى عبر طلب مباشر بمعرّف يعرفه) لمس أي سجل ليس
    // origin='reception' AND created_by = هو نفسه — سواء كان تعديلاً لسجل قائم لمستخدم استقبال
    // آخر، أو حتى إعادة استخدام نفس المعرّف لسجل عام محذوف مسبقاً. كل مستخدم استقبال معزول عن
    // البقية تماماً، وليس فقط عن باقي الأدوار. والأدمن بلا قيود (كما كان دائماً). أي دور آخر
    // (staff/accountant) يُعدِّل فقط السجلات المعتمدة status='confirmed' — نفس شرط الرؤية تماماً
    // فى clientRecordsVisibilitySql — فلا يمكنه عبر طلب مباشر لمس مسودات/سجلات استقبال معلّقة
    // لا يملك رؤيتها أصلاً (إصلاح ثغرة تجاوز العزل بالمعرّف).
    if (req.user.role === 'reception') {
      const existing = await pool.query('SELECT origin, created_by FROM client_records WHERE id = $1', [req.params.id]);
      if (existing.rows[0] && (existing.rows[0].origin !== 'reception' || existing.rows[0].created_by !== req.user.username)) {
        return res.status(403).json({ error: 'ليست لديك صلاحية تعديل بيانات هذا العميل' });
      }
    } else if (req.user.role !== 'admin') {
      const existing = await pool.query('SELECT status FROM client_records WHERE id = $1', [req.params.id]);
      if (existing.rows[0] && existing.rows[0].status !== 'confirmed') {
        return res.status(403).json({ error: 'ليست لديك صلاحية تعديل بيانات هذا العميل' });
      }
    }
    const newOrigin = req.user.role === 'reception' ? 'reception' : 'general';
    const newStatus = req.user.role === 'reception' ? 'pending' : 'confirmed';
    const upsert = await pool.query(
      `INSERT INTO client_records (id, enc, version, updated_by, origin, status, created_by, client_id)
       VALUES ($1, $2, 1, $3, $5, $6, $3, $7)
       ON CONFLICT (id) DO UPDATE SET
         enc = EXCLUDED.enc, version = client_records.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by, client_id = EXCLUDED.client_id
       WHERE client_records.version = $4
       RETURNING version, origin, status`,
      [req.params.id, enc, req.user.username, knownVersion, newOrigin, newStatus, plainClientId]
    );
    if (upsert.rows[0]) return res.json({ id: req.params.id, version: upsert.rows[0].version, origin: upsert.rows[0].origin, status: upsert.rows[0].status });
    const current = await pool.query('SELECT version FROM client_records WHERE id = $1', [req.params.id]);
    return res.status(409).json({
      error: 'تعارض: تم تعديل بيانات هذا العميل من جهاز آخر بعد آخر تحديث لديك. يرجى تحديث الصفحة وإعادة تنفيذ العملية.',
      currentVersion: current.rows[0] ? current.rows[0].version : 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حفظ بيانات العميل' });
  }
});

// اعتماد سجل عميل سجّله الاستقبال (pending -> confirmed): للأدمن فقط. لا يحتاج فك أي تشفير —
// enc يبقى كما هو تماماً (السيرفر لا يعرف محتواه أصلاً)، فقط عمود status يتغيّر، فيصبح العميل
// ظاهراً فوراً لكل الأدوار الأخرى (staff/accountant) وداخلاً في الحسابات/الداشبورد/الـVAT كأي
// عميل عادي، مع بقاء origin='reception' كسجل تاريخي فقط لمن سجّله أصلاً.
app.post('/api/client-records/:id/approve', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE client_records SET status = 'confirmed', version = version + 1, updated_at = now()
       WHERE id = $1 AND origin = 'reception' AND status = 'pending'
       RETURNING id, version`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'لا يوجد سجل معلّق بهذا المعرّف بانتظار الاعتماد' });
    res.json({ id: r.rows[0].id, version: r.rows[0].version, status: 'confirmed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر اعتماد بيانات العميل' });
  }
});

app.delete('/api/client-records/:id', requireAuth, storageLimiter, async (req, res) => {
  try {
    // نفس حماية العزل: مستخدم الاستقبال يقدر يحذف فقط سجلاته هو شخصياً، وليس سجلات مستخدم استقبال آخر.
    // أي دور آخر (staff/accountant) يحذف فقط السجلات المعتمدة status='confirmed' (نفس شرط الرؤية)،
    // فلا يمس عبر طلب مباشر مسودات/سجلات الاستقبال المعلّقة التي لا يملك رؤيتها أصلاً.
    if (req.user.role === 'reception') {
      const existing = await pool.query('SELECT origin, created_by FROM client_records WHERE id = $1', [req.params.id]);
      if (existing.rows[0] && (existing.rows[0].origin !== 'reception' || existing.rows[0].created_by !== req.user.username)) {
        return res.status(403).json({ error: 'ليست لديك صلاحية حذف بيانات هذا العميل' });
      }
    } else if (req.user.role !== 'admin') {
      const existing = await pool.query('SELECT status FROM client_records WHERE id = $1', [req.params.id]);
      if (existing.rows[0] && existing.rows[0].status !== 'confirmed') {
        return res.status(403).json({ error: 'ليست لديك صلاحية حذف بيانات هذا العميل' });
      }
    }
    await pool.query('DELETE FROM client_records WHERE id = $1', [req.params.id]);
    res.json({ id: req.params.id, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف بيانات العميل' });
  }
});

// حذف عدة عملاء دفعة واحدة (طلب واحد) — نفس فكرة /api/records/:collection/bulk-delete، لتفادي
// إرسال عشرات/مئات طلبات DELETE منفصلة عند حذف عدد كبير من العملاء دفعة واحدة.
app.post('/api/client-records/bulk-delete', requireAuth, storageLimiter, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length || ids.length > 1000) return res.status(400).json({ error: 'عدد السجلات غير صحيح (الحد الأقصى 1000 لكل طلب)' });
  try {
    if (req.user.role === 'reception') {
      // نفس عزل مستخدم الاستقبال فى مسار الحذف الفردي: يحذف فقط سجلاته هو شخصياً.
      await pool.query(
        `DELETE FROM client_records WHERE id = ANY($1::text[]) AND origin = 'reception' AND created_by = $2`,
        [ids, req.user.username]
      );
    } else if (req.user.role === 'admin') {
      await pool.query('DELETE FROM client_records WHERE id = ANY($1::text[])', [ids]);
    } else {
      // staff/accountant: نفس شرط الرؤية الفردي — يحذف فقط السجلات المعتمدة، ولا يمس
      // مسودات/سجلات استقبال معلّقة لا يملك رؤيتها أصلاً (إصلاح ثغرة تجاوز العزل دفعةً واحدة).
      await pool.query(`DELETE FROM client_records WHERE id = ANY($1::text[]) AND status = 'confirmed'`, [ids]);
    }
    res.json({ deleted: ids.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف بيانات العملاء' });
  }
});

// حذف كل سجلات العملاء دفعة واحدة — يُستخدم فقط فى "إعادة ضبط المصنع" (حذف كل بيانات البرنامج)، أدمن فقط.
app.delete('/api/client-records', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM client_records');
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف سجلات العملاء' });
  }
});

// نقطة رفع مُجمَّع تُستخدم فى: (أ) الترحيل لمرة واحدة من التخزين القديم (كل العملاء ككتلة واحدة)
// إلى التخزين الجديد، و(ب) عمليات ضخمة دفعة واحدة (استيراد/تحديث شامل) — تقبل حتى 1000 سجل فى
// الطلب الواحد بدل طلب منفصل لكل عميل (5888 عميل مثلاً كانت ستعني 5888 طلباً منفصلاً تصطدم فوراً
// بحد معدّل الطلبات).
// فحص تعارض لكل سجل على حدة (بنفس منطق /api/client-records/:id تماماً): كل سجل يحمل version
// المعروفة لدى المرسل قبل هذا الرفع (0 لسجل جديد لم يُرحَّل بعد). لو تغيّر السجل فعلياً على السيرفر
// من جهاز/مستخدم آخر فى نفس اللحظة (نادر لكن ممكن أثناء استيراد ضخم)، يُتجاهَل هذا السجل تحديداً
// بدل الكتابة فوقه صامتاً، ويُرجَع ضمن conflicts ليعيد المستدعي معالجته بمسار الحفظ الفردي المعتاد.
app.post('/api/client-records/bulk-migrate', requireAuth, storageLimiter, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 5000) return res.status(400).json({ error: 'عدد السجلات المرسلة غير صحيح (الحد الأقصى 5000 لكل طلب)' });
  const client = await pool.connect();
  try {
    const newOrigin = req.user.role === 'reception' ? 'reception' : 'general';
    const newStatus = req.user.role === 'reception' ? 'pending' : 'confirmed';
    // الرفع الجماعي يتم الآن ببيان SQL واحد لكل الدفعة كاملة بدل حلقة استعلامات متتالية لكل سجل
    // (كان ~100ms للسجل الواحد على معالج الاستضافة المجانية، فدفعة 4000 سجل تتجاوز مهلة 60
    // ثانية لدى الواجهة فيفشل رفع النسخ الاحتياطية الكبيرة دائماً في المنتصف). جدولان مؤقتان
    // (المدخلات + التعارضات) ثم INSERT..SELECT واحد يعالج كل الدفعة ببضعة استعلامات إجمالاً.
    const guard = req.user.role === 'reception'
      ? `($3 = 'reception' AND cr.origin = 'reception' AND cr.created_by = $2)`
      : req.user.role === 'admin'
      ? `$3 = 'admin'`
      : `cr.status = 'confirmed'`;
    const payload = JSON.stringify(records.map(r => ({
      id: String(r.id),
      enc: String(r.enc),
      version: Number.isInteger(r.version) ? r.version : 0,
      clientId: (typeof r.clientId === 'string' && r.clientId.trim()) ? r.clientId.trim() : null
    })));
    await client.query('BEGIN');
    const step = async (label, sql, params) => {
      try { return await client.query(sql, params); }
      catch (e) { e.message = `[${label}] ` + e.message; throw e; }
    };
    await step('inc',
      `CREATE TEMP TABLE _inc ON COMMIT DROP AS
       SELECT (t->>'id')::text AS id, (t->>'enc')::text AS enc, COALESCE((t->>'version')::int, 0) AS known_version,
              (t->>'clientId')::text AS client_id
       FROM jsonb_array_elements($1::jsonb) AS t`,
      [payload]
    );
    // التعارضات = صفوف موجودة فعلاً تختلف نسختها عن المعروفة، أو يرفضها حارس العزل حسب الدور
    await step('conf',
      `CREATE TEMP TABLE _conf ON COMMIT DROP AS
       SELECT cr.id, cr.version AS current_version
       FROM _inc i
       JOIN client_records cr ON cr.id = i.id
       WHERE cr.version <> i.known_version OR NOT (${guard})`,
      [req.user.username, req.user.username, req.user.role]
    );
    // إدراج/تحديث كل غير المتعارضين في بيان واحد — جديد: version 1، موجود ونسخته مطابقة: version+1
    await step('upsert',
      `INSERT INTO client_records (id, enc, version, updated_by, origin, status, created_by, client_id)
       SELECT i.id, i.enc, 1, $1, $2, $3, $1, i.client_id
       FROM _inc i
       WHERE NOT EXISTS (SELECT 1 FROM _conf c WHERE c.id = i.id)
       ORDER BY i.id
       ON CONFLICT (id) DO UPDATE SET
         enc = EXCLUDED.enc, version = client_records.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by, client_id = EXCLUDED.client_id`,
      [req.user.username, newOrigin, newStatus]
    );
    const confRows = await step('conf-read', 'SELECT id, current_version FROM _conf');
    const migrated = records.length - confRows.rows.length;
    await client.query('COMMIT');
    res.json({ migrated, conflicts: confRows.rows.map(r => ({ id: r.id, currentVersion: r.current_version })) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'تعذّر ترحيل السجلات', detail: e && e.message });
  } finally {
    client.release();
  }
});

// GET /api/storage-versions -> { versions: { key: version } } لكل المفاتيح دفعة واحدة، بدل طلب
// منفصل بالنسخة الحالية لكل مفتاح (كان يعني اتصالاً بالسيرفر لكل مفتاح في كل فتحة للبرنامج).
// تستخدمها الواجهة عند فتح البرنامج للمقارنة السريعة بين النسخة المخزّنة محلياً على الجهاز ونسخة
// السحابة: لو كل الأرقام متطابقة، لا يوجد أي نقل بيانات إضافي (البرنامج يعمل بالفعل من أحدث نسخة
// محفوظة محلياً). لو اختلف رقم مفتاح أو أكثر، الواجهة تجلب القيمة الكاملة لتلك المفاتيح فقط
// عبر GET /api/storage/:key كالمعتاد — بدل تحميل كل البيانات من جديد في كل مرة.
app.get('/api/storage-versions', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT key, version FROM kv_store');
    const versions = {};
    r.rows.forEach(row => {
      if (row.key in RESTRICTED_STORAGE_KEYS) {
        const view = RESTRICTED_STORAGE_KEYS[row.key];
        const allowed = view === null ? req.user.role === 'admin' : roleCanAccessView(req.user.role, view);
        if (!allowed) return; // لا نُظهر حتى رقم نسخة مفتاح لا يملك المستخدم صلاحية قراءته
      }
      versions[row.key] = row.version;
    });
    res.json({ versions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب نسخ البيانات' });
  }
});

/* ---------------- تخزين عام لأي تصنيف بيانات كسجلات مستقلة (Generic Collection Records) ----------------
   نفس فكرة /api/client-records بالضبط لكن قابلة لإعادة الاستخدام لأي شيت آخر — سجل واحد يتغيّر
   = صف واحد يُرفع، بدل رفع كل مصفوفة الشيت كاملة عند أي تعديل بسيط. */
const ALLOWED_COLLECTIONS = [
  'bagStock','vaultTx','deletedVaultTx','vaultDenomTx','bankStatementRows','deletedInvoices',
  'courseSessions','auditLog','companies','companyTransfers','journalEntries','chartOfAccounts',
  'journalDE','budgetEntries','suppliers','purchases','manualSalesInvoices','scheduledVaultTx',
];
function collectionRoleAllowed(role, collection) {
  if (collection in RESTRICTED_STORAGE_KEYS) {
    const view = RESTRICTED_STORAGE_KEYS[collection];
    return view === null ? role === 'admin' : roleCanAccessView(role, view);
  }
  return true; // غير مقيَّد: نفس سلوك المفاتيح غير المقيَّدة حالياً فى restrictKeyToAdmin
}
function requireValidCollection(req, res, next) {
  const { collection } = req.params;
  if (!ALLOWED_COLLECTIONS.includes(collection)) return res.status(400).json({ error: 'اسم تصنيف بيانات غير صحيح' });
  if (!collectionRoleAllowed(req.user.role, collection)) return res.status(403).json({ error: 'ليست لديك صلاحية كافية للوصول لهذه البيانات' });
  next();
}

app.get('/api/records/:collection', requireAuth, requireValidCollection, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, enc, version FROM collection_records WHERE collection = $1', [req.params.collection]);
    res.json({ records: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب البيانات' });
  }
});

// رقم إصدار مجمّع لكل التصنيفات دفعة واحدة (طلب واحد خفيف بدون نقل بيانات فعلية) — لنفس فكرة
// /api/storage-versions، تستخدمه المزامنة الدورية الخلفية للتحقق السريع من وجود تعديلات جديدة.
app.get('/api/records-versions', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT collection, COALESCE(SUM(version),0)::bigint AS v, COUNT(*)::int AS c FROM collection_records GROUP BY collection');
    const out = {};
    r.rows.forEach(row => {
      if (!collectionRoleAllowed(req.user.role, row.collection)) return;
      out[row.collection] = { version: Number(row.v), count: row.c };
    });
    res.json({ versions: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب أرقام الإصدارات' });
  }
});

app.put('/api/records/:collection/:id', requireAuth, storageLimiter, requireValidCollection, async (req, res) => {
  const { enc } = req.body || {};
  if (typeof enc !== 'string' || !enc) return res.status(400).json({ error: 'بيانات غير صحيحة' });
  const knownVersion = Number.isInteger(req.body?.version) ? req.body.version : 0;
  try {
    const upsert = await pool.query(
      `INSERT INTO collection_records (collection, id, enc, version, updated_by)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (collection, id) DO UPDATE SET
         enc = EXCLUDED.enc, version = collection_records.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       WHERE collection_records.version = $5
       RETURNING version`,
      [req.params.collection, req.params.id, enc, req.user.username, knownVersion]
    );
    if (upsert.rows[0]) return res.json({ id: req.params.id, version: upsert.rows[0].version });
    const current = await pool.query('SELECT version FROM collection_records WHERE collection = $1 AND id = $2', [req.params.collection, req.params.id]);
    return res.status(409).json({
      error: 'تعارض: تم تعديل هذه البيانات من جهاز آخر بعد آخر تحديث لديك. يرجى تحديث الصفحة وإعادة تنفيذ العملية.',
      currentVersion: current.rows[0] ? current.rows[0].version : 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر الحفظ' });
  }
});

app.delete('/api/records/:collection/:id', requireAuth, storageLimiter, requireValidCollection, async (req, res) => {
  try {
    await pool.query('DELETE FROM collection_records WHERE collection = $1 AND id = $2', [req.params.collection, req.params.id]);
    res.json({ id: req.params.id, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر الحذف' });
  }
});

// نقطة رفع مُجمَّع: تُستخدم للترحيل لمرة واحدة من التخزين القديم (كتلة واحدة) إلى النظام الجديد،
// وللعمليات الضخمة دفعة واحدة (استيراد شامل) — حتى 1000 سجل فى الطلب الواحد.
// فحص تعارض لكل سجل على حدة (بنفس منطق /api/records/:collection/:id تماماً): كل سجل يحمل version
// المعروفة لدى المرسل قبل هذا الرفع (0 لسجل جديد). لو تغيّر السجل فعلياً على السيرفر من جهاز/مستخدم
// آخر أثناء نفس العملية، يُتجاهَل هذا السجل تحديداً بدل الكتابة فوقه صامتاً، ويُرجَع ضمن conflicts.
app.post('/api/records/:collection/bulk-migrate', requireAuth, storageLimiter, requireValidCollection, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 5000) return res.status(400).json({ error: 'عدد السجلات المرسلة غير صحيح (الحد الأقصى 5000 لكل طلب)' });
  const client = await pool.connect();
  try {
    // الرفع الجماعي يتم الآن ببيان SQL واحد لكل الدفعة كاملة بدل حلقة استعلامات متتالية لكل سجل
    // (كان ~100ms للسجل الواحد على معالج الاستضافة المجانية، فدفعة 4000 سجل تتجاوز مهلة 60
    // ثانية لدى الواجهة فيفشل رفع النسخ الاحتياطية الكبيرة دائماً في المنتصف). جدولان مؤقتان
    // (المدخلات + التعارضات) ثم INSERT..SELECT واحد يعالج كل الدفعة ببضعة استعلامات إجمالاً.
    const payload = JSON.stringify(records.map(r => ({ id: String(r.id), enc: String(r.enc), version: Number.isInteger(r.version) ? r.version : 0 })));
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE _inc ON COMMIT DROP AS
       SELECT (t->>'id')::text AS id, (t->>'enc')::text AS enc, COALESCE((t->>'version')::int, 0) AS known_version
       FROM jsonb_array_elements($1::jsonb) AS t`,
      [payload]
    );
    // التعارضات = الصفوف الموجودة فعلاً التي تختلف نسختها عن المعروفة
    await client.query(
      `CREATE TEMP TABLE _conf ON COMMIT DROP AS
       SELECT cr.id, cr.version AS current_version
       FROM _inc i
       JOIN collection_records cr ON cr.collection = $1 AND cr.id = i.id
       WHERE cr.version <> i.known_version`,
      [req.params.collection]
    );
    // إدراج/تحديث كل غير المتعارضين في بيان واحد — جديد: version 1، موجود ونسخته مطابقة: version+1
    await client.query(
      `INSERT INTO collection_records (collection, id, enc, version, updated_by)
       SELECT $1, i.id, i.enc, 1, $2
       FROM _inc i
       WHERE NOT EXISTS (SELECT 1 FROM _conf c WHERE c.id = i.id)
       ORDER BY i.id
       ON CONFLICT (collection, id) DO UPDATE SET
         enc = EXCLUDED.enc, version = collection_records.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [req.params.collection, req.user.username]
    );
    const confRows = await client.query('SELECT id, current_version FROM _conf');
    const migrated = records.length - confRows.rows.length;
    await client.query('COMMIT');
    res.json({ migrated, conflicts: confRows.rows.map(r => ({ id: r.id, currentVersion: r.current_version })) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'تعذّر ترحيل السجلات' });
  } finally {
    client.release();
  }
});

// حذف عدة سجلات محدَّدة بالـ id دفعة واحدة (طلب واحد بدل طلب DELETE منفصل لكل سجل) — يُستخدم عند
// حذف عدد كبير من السجلات دفعة واحدة (مثال: تنظيف مخزون الشكاير) لتفادي ضرب سقف rate limiter
// (storageLimiter) بإرسال عشرات/مئات طلبات DELETE متتالية فى ثوانٍ.
app.post('/api/records/:collection/bulk-delete', requireAuth, storageLimiter, requireValidCollection, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length || ids.length > 1000) return res.status(400).json({ error: 'عدد السجلات غير صحيح (الحد الأقصى 1000 لكل طلب)' });
  try {
    await pool.query('DELETE FROM collection_records WHERE collection = $1 AND id = ANY($2::text[])', [req.params.collection, ids]);
    res.json({ deleted: ids.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف السجلات' });
  }
});

// حذف كل سجلات تصنيف معيّن دفعة واحدة — يُستخدم فقط فى "إعادة ضبط المصنع" (حذف كل بيانات البرنامج)، أدمن فقط.
app.delete('/api/records/:collection', requireAuth, requireRole('admin'), requireValidCollection, async (req, res) => {
  try {
    await pool.query('DELETE FROM collection_records WHERE collection = $1', [req.params.collection]);
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف البيانات' });
  }
});

// ---------------- النسخ الاحتياطية الكاملة المُجدوَلة (مشفّرة من طرف العميل، أدمن فقط) ----------------
// الحد الأقصى لعدد النسخ المحفوظة فى نفس الوقت — أي نسخة جديدة تتخطى الحد تحذف أقدم نسخة تلقائياً،
// بحيث لا يتضخم الجدول بلا نهاية (خصوصاً مع "auto" التي قد تتكرر كل أسبوع لسنوات).
const MAX_BACKUPS_RETAINED = 30;
app.post('/api/backups', requireAuth, storageLimiter, requireRole('admin'), async (req, res) => {
  const enc = req.body?.enc;
  const kind = req.body?.kind === 'manual' ? 'manual' : 'auto';
  if (typeof enc !== 'string' || !enc.length) return res.status(400).json({ error: 'بيانات النسخة الاحتياطية مفقودة' });
  try {
    const ins = await pool.query(
      `INSERT INTO app_backups (kind, enc, size_bytes, created_by) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [kind, enc, Buffer.byteLength(enc, 'utf8'), req.user.username]
    );
    // تنظيف: الاحتفاظ بآخر MAX_BACKUPS_RETAINED نسخة فقط
    await pool.query(
      `DELETE FROM app_backups WHERE id NOT IN (SELECT id FROM app_backups ORDER BY created_at DESC LIMIT $1)`,
      [MAX_BACKUPS_RETAINED]
    );
    res.json({ id: ins.rows[0].id, createdAt: ins.rows[0].created_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حفظ النسخة الاحتياطية' });
  }
});
// قائمة النسخ (بيانات وصفية فقط — بدون المحتوى المشفّر نفسه، تفادياً لردّ ثقيل)
app.get('/api/backups', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, kind, size_bytes, created_by, created_at FROM app_backups ORDER BY created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة النسخ الاحتياطية' });
  }
});
// محتوى نسخة واحدة كاملاً (للتنزيل/الاستعادة) — يفكّه المتصفح بمفتاحه محلياً، السيرفر يمرّره كما هو فقط
app.get('/api/backups/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, kind, enc, created_at FROM app_backups WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'النسخة غير موجودة' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب النسخة الاحتياطية' });
  }
});
app.delete('/api/backups/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM app_backups WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف النسخة الاحتياطية' });
  }
});

// auditLog وdeletedVaultTx وdeletedInvoices تتراكم بلا حد أقصى بمرور الوقت (سجل تاريخي، وليس بيانات
// تشغيلية حالية). لا يوجد حذف تلقائي مجدوَل عمداً — القرار يُترك للأدمن صراحةً فى كل مرة، خصوصاً أن
// deletedInvoices يخضع لالتزام الاحتفاظ بسجلات الفواتير 6 سنوات على الأقل بموجب لوائح ضريبة القيمة
// المضافة/ZATCA فى السعودية؛ لا يجوز حذفها تلقائياً بفترة قصيرة دون مراجعة الأدمن لهذا تحديداً.
const PRUNABLE_COLLECTIONS = ['auditLog', 'deletedVaultTx', 'deletedInvoices'];
app.post('/api/records/:collection/prune', requireAuth, storageLimiter, requireRole('admin'), async (req, res) => {
  const { collection } = req.params;
  if (!PRUNABLE_COLLECTIONS.includes(collection)) {
    return res.status(400).json({ error: 'هذا التصنيف غير مسموح بتنظيفه من هذه النقطة' });
  }
  const olderThanDays = Number(req.body?.olderThanDays);
  if (!Number.isFinite(olderThanDays) || olderThanDays < 90) {
    return res.status(400).json({ error: 'الحد الأدنى للاحتفاظ بالسجلات 90 يوماً على الأقل' });
  }
  try {
    const r = await pool.query(
      `DELETE FROM collection_records WHERE collection = $1 AND updated_at < now() - ($2 || ' days')::interval RETURNING id`,
      [collection, olderThanDays]
    );
    res.json({ deleted: r.rowCount, collection, olderThanDays });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تنظيف السجلات' });
  }
});
// معاينة فقط (بدون حذف): كم سجلاً سيُحذف لو طُبِّقت فترة احتفاظ معيّنة — يُستخدم فى شاشة الإعدادات
// ليرى الأدمن الأثر قبل تنفيذ الحذف الفعلي.
app.get('/api/records/:collection/prune-preview', requireAuth, requireRole('admin'), async (req, res) => {
  const { collection } = req.params;
  if (!PRUNABLE_COLLECTIONS.includes(collection)) {
    return res.status(400).json({ error: 'هذا التصنيف غير مسموح بمعاينته من هذه النقطة' });
  }
  const olderThanDays = Number(req.query?.olderThanDays);
  if (!Number.isFinite(olderThanDays) || olderThanDays < 90) {
    return res.status(400).json({ error: 'الحد الأدنى للاحتفاظ بالسجلات 90 يوماً على الأقل' });
  }
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM collection_records WHERE collection = $1 AND updated_at < now() - ($2 || ' days')::interval`,
      [collection, olderThanDays]
    );
    const total = await pool.query('SELECT COUNT(*)::int AS c FROM collection_records WHERE collection = $1', [collection]);
    res.json({ wouldDelete: r.rows[0].c, total: total.rows[0].c, collection, olderThanDays });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حساب المعاينة' });
  }
});

/* ---------------- قراءة فواتير الدورات من ملفات حقيقية (PDF/صور) بالذكاء الاصطناعي ----------------
   تستقبل مجموعة ملفات (Base64)، وترسل كل ملف لـ Claude API لاستخراج البيانات المطبوعة داخله فقط
   (رقم الهوية، رقم الفاتورة، تاريخ الفاتورة، القيمة الفعلية). لا شيء يُحفظ هنا في قاعدة البيانات —
   فقط استخراج وإرجاع النتائج للواجهة، التي تعرضها للمراجعة اليدوية قبل الحفظ النهائي (بنفس منطق
   ونموذج التحقق المستخدم أصلاً في "تحديث/استيراد فواتير الدورات دفعة واحدة"). */
const invoiceReadJsonParser = express.json({ limit: '40mb' });

const CI_EXTRACT_SYSTEM_PROMPT = `أنت مساعد استخراج بيانات من فواتير/إيصالات دورات تدريبية سعودية.
سيصلك ملف فاتورة أو إيصال واحد (صورة أو PDF). استخرج منه فقط ما هو مكتوب صراحةً داخل الملف:
- nationalId: رقم الهوية/الإقامة للمتدرب إن وُجد مكتوباً بوضوح (أرقام فقط بدون مسافات أو رموز)
- invoiceNo: رقم الفاتورة أو رقم الإيصال
- date: تاريخ إصدار الفاتورة بصيغة YYYY-MM-DD
- actualValue: القيمة الإجمالية الفعلية المدفوعة (رقم فقط بدون رمز عملة)
- clientNameOnInvoice: اسم العميل كما هو مكتوب في الفاتورة إن وُجد
لا تخترع أي قيمة غير موجودة فعلياً في الملف — إن لم يظهر حقل بوضوح اجعله null.
أجب بصيغة JSON فقط بدون أي نص أو علامات \`\`\`json، بالشكل التالي بالضبط:
{"nationalId": "...", "invoiceNo": "...", "date": "...", "actualValue": 0, "clientNameOnInvoice": "...", "confidence": "high|medium|low"}`;

async function extractInvoiceFile(f) {
  const mime = String(f.mimeType || '').toLowerCase();
  const isPdf = mime === 'application/pdf';
  const isImage = mime.startsWith('image/');
  const fileName = f.name || 'ملف';
  if (!f.dataBase64 || (!isPdf && !isImage)) {
    return { fileName, error: 'صيغة ملف غير مدعومة (يجب أن تكون صورة أو PDF)' };
  }
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.dataBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: f.dataBase64 } };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: CI_EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: 'استخرج البيانات من هذه الفاتورة.' }] }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return { fileName, error: `تعذّرت قراءة الملف (HTTP ${r.status})`, detail: errText.slice(0, 200) };
    }
    const data = await r.json();
    const rawText = (data.content || []).map(b => b.text || '').join('').trim();
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      fileName,
      nationalId: parsed.nationalId ? String(parsed.nationalId).trim() : null,
      invoiceNo: parsed.invoiceNo ? String(parsed.invoiceNo).trim() : null,
      date: parsed.date || null,
      actualValue: parsed.actualValue !== null && parsed.actualValue !== undefined && parsed.actualValue !== '' ? Number(parsed.actualValue) : null,
      clientNameOnInvoice: parsed.clientNameOnInvoice || null,
      confidence: parsed.confidence || 'unknown',
    };
  } catch (e) {
    return { fileName, error: 'تعذّر تحليل استجابة الذكاء الاصطناعي' };
  }
}

app.post('/api/ai/read-invoices', invoiceReadJsonParser, requireAuth, aiLimiter, async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: 'لم يتم إرسال أي ملفات' });
  if (files.length > 30) return res.status(400).json({ error: 'الحد الأقصى 30 ملفاً في المرة الواحدة' });
  // حد أقصى 8 ميجابايت لكل ملف على حدة (أكثر من كافٍ لأي فاتورة/إيصال ممسوح ضوئياً) — دفاع إضافي
  // بجانب حد الـ 40 ميجابايت الإجمالي لكل الطلب، بدل الاعتماد على الحد الكلي فقط.
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  for (const f of files) {
    const approxBytes = f?.dataBase64 ? Math.ceil(f.dataBase64.length * 0.75) : 0;
    if (approxBytes > MAX_FILE_BYTES) {
      return res.status(400).json({ error: `الملف "${f.name || 'بدون اسم'}" أكبر من الحد المسموح (8 ميجابايت للملف الواحد)` });
    }
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'مفتاح الذكاء الاصطناعي غير مُعدّ على الخادم (ANTHROPIC_API_KEY)' });
  }
  // معالجة بحد أقصى 3 ملفات بالتوازي في نفس الوقت لتفادي إغراق الـ API
  const results = [];
  const queue = [...files];
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      results.push(await extractInvoiceFile(f));
    }
  }
  try {
    await Promise.all([worker(), worker(), worker()]);
    res.json({ results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّرت معالجة الملفات' });
  }
});

/* ---------------- تصنيف المصروفات بالذكاء الاصطناعي (عبر الخادم) ----------------
   تستقبل اسم المستلم/الملاحظات/رقم المستند/المبلغ + قائمة التصنيفات المتاحة،
   وتطلب من Claude اقتراح أنسب تصنيف (موجود أو جديد) مع سبب الاختيار.
   المفتاح يبقى في process.env.ANTHROPIC_API_KEY فقط ولا يُكشف للواجهة. */
const AI_CLASSIFY_SYSTEM_PROMPT = 'أنت مساعد تصنيف مصروفات لمركز تدريب سعودي. سيصلك اسم مستلم مبلغ و/أو ملاحظة و/أو رقم مستند و/أو مبلغ مصروف. اختر أنسب تصنيف من قائمة "availableCategories" المُرسلة فقط إن وجد تصنيف مناسباً فعلياً. إن لم توجد أي تصنيف مناسب في القائمة، اقترح اسم تصنيف عربي جديد قصير (كلمة أو كلمتان) يصلح لتكرار هذا النوع من المصروفات مستقبلاً. أجب بصيغة JSON فقط بدون أي نص أو علامات ```json، بالشكل التالي بالضبط: {"category":"...", "isNew": true أو false, "reason":"جملة قصيرة توضح سبب الاختيار"}';

app.post('/api/ai/classify-expense', requireAuth, aiLimiter, async (req, res) => {
  const { recipientName, notes, documentRef, amount, availableCategories } = req.body || {};
  if (!recipientName && !notes && !documentRef) {
    return res.status(400).json({ error: 'أدخل اسم مستلم المبلغ أو ملاحظة أو رقم مستند أولاً' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'مفتاح الذكاء الاصطناعي غير مُعدّ على الخادم (ANTHROPIC_API_KEY)' });
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: AI_CLASSIFY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({ recipientName: recipientName || null, notes: notes || null, documentRef: documentRef || null, amount: amount || null, availableCategories: availableCategories || [] }) }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(502).json({ error: `تعذّر الاتصال بخدمة الذكاء الاصطناعي (HTTP ${r.status})`, detail: errText.slice(0, 200) });
    }
    const data = await r.json();
    const rawText = (data.content || []).map(b => b.text || '').join('').trim();
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(502).json({ error: 'استجابة الذكاء الاصطناعي غير صالحة (ليست JSON)' });
    }
    res.json({ category: String(parsed.category || '').trim(), isNew: !!parsed.isNew, reason: parsed.reason || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر الحصول على اقتراح التصنيف' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ================= ربط هيئة الزكاة والضريبة والجمارك (فاتورة) ================= */
const zatca = require('./zatca/lib');

// حالة التسجيل الحالية (بدون أي بيانات حسّاسة) — تُستخدم لعرض حالة الربط في الواجهة
app.get('/api/zatca/status', requireAuth, async (req, res) => {
  const environment = req.query.environment || 'sandbox';
  try {
    const row = await zatca.loadActiveEgsRow(environment);
    res.json(zatca.publicStatus(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب حالة الربط مع الهيئة' });
  }
});

// تسجيل/تحديث EGS والحصول على شهادة الامتثال (compliance CSID) — يتطلب OTP من بوابة فاتورة
app.post('/api/zatca/onboard', requireAuth, requireRole('admin'), async (req, res) => {
  const { environment = 'sandbox', otp, orgProfile } = req.body || {};
  if (!otp || !orgProfile) return res.status(400).json({ error: 'يلزم إرسال OTP وبيانات المنشأة (orgProfile)' });
  try {
    const result = await zatca.onboard({ environment, otp, orgProfile });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل التسجيل مع الهيئة', detail: e.message });
  }
});

// طلب شهادة الإنتاج (PCSID) بعد اجتياز فحوصات التوافق
app.post('/api/zatca/production-csid', requireAuth, requireRole('admin'), async (req, res) => {
  const { environment = 'sandbox', complianceRequestId } = req.body || {};
  if (!complianceRequestId) return res.status(400).json({ error: 'يلزم إرسال complianceRequestId' });
  try {
    const result = await zatca.issueProductionCsid({ environment, complianceRequestId });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل الحصول على شهادة الإنتاج', detail: e.message });
  }
});

// إرسال فاتورة مبيعات (تُبنى من الواجهة الأمامية بنفس أرقام الفاتورة المطبوعة)
// مقيَّدة على الأدوار التي تملك فعلياً شاشة الخزنة/العملاء التي تُرسل منها (admin/accountant/staff) —
// الاستقبال محروم لعدم امتلاكه أي من هذه الشاشات أصلاً، ويمنع إرسال فواتير/سجلات ضريبية مزوّرة
// عبر طلب مباشر بأقل صلاحية (إغلاق ثغرة غياب رقابة الدور على هذه النقطة).
app.post('/api/zatca/invoice', requireAuth, requireRole('admin', 'accountant', 'staff'), async (req, res) => {
  const { environment = 'sandbox', clientType, sourceRef, lineItems, issueDate, issueTime } = req.body || {};
  if (!sourceRef || !Array.isArray(lineItems) || !lineItems.length) {
    return res.status(400).json({ error: 'بيانات الفاتورة غير مكتملة' });
  }
  try {
    if (clientType === 'company') {
      await zatca.logUnsupportedStandardInvoice({ sourceRef, documentType: 'invoice', createdBy: req.user.username });
      return res.json({ status: 'not_supported_yet', message: 'الفواتير الضريبية القياسية (B2B) غير مفعّلة بعد في هذا الربط' });
    }
    const result = await zatca.submitSimplifiedInvoice({
      environment, sourceRef, documentType: 'invoice', lineItems, issueDate, issueTime,
      createdBy: req.user.username,
    });
    res.json(result);
  } catch (e) {
    if (e.isValidation) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'تعذّر إرسال الفاتورة للهيئة', detail: e.message });
  }
});

// إرسال إشعار دائن (مردود مبيعات) — نفس رقابة الدور أعلاه (ممنوع عن الاستقبال).
app.post('/api/zatca/return', requireAuth, requireRole('admin', 'accountant', 'staff'), async (req, res) => {
  const { environment = 'sandbox', clientType, sourceRef, lineItems, issueDate, issueTime, canceledInvoiceNumber, reason } = req.body || {};
  if (!sourceRef || !Array.isArray(lineItems) || !lineItems.length) {
    return res.status(400).json({ error: 'بيانات المردود غير مكتملة' });
  }
  try {
    if (clientType === 'company') {
      await zatca.logUnsupportedStandardInvoice({ sourceRef, documentType: 'credit_note', createdBy: req.user.username });
      return res.json({ status: 'not_supported_yet', message: 'إشعارات الدائن القياسية (B2B) غير مفعّلة بعد في هذا الربط' });
    }
    const result = await zatca.submitSimplifiedInvoice({
      environment, sourceRef, documentType: 'credit_note', lineItems, issueDate, issueTime,
      cancelation: {
        canceled_invoice_number: canceledInvoiceNumber || '',
        payment_method: zatca.ZATCAPaymentMethods.CASH,
        reason: reason || 'مردود مبيعات',
      },
      createdBy: req.user.username,
    });
    res.json(result);
  } catch (e) {
    if (e.isValidation) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'تعذّر إرسال المردود للهيئة', detail: e.message });
  }
});

/* ---------------- استضافة واجهة البرنامج (نفس ملف HTML) ---------------- */
// نمنع المتصفح من تخزين app.html في الكاش لفترة طويلة، حتى يصل أي تحديث جديد
// للمستخدمين فوراً بعد كل نشر (deploy) بدل ما يفضلوا شايفين نسخة قديمة مخزّنة.
// بدون maxAge، يعتمد express.static على ETag/Last-Modified: المتصفح يتأكد من السيرفر
// في كل مرة (رد سريع 304 لو الملف لم يتغيّر فعلياً)، فنحافظ على معظم فائدة الكاش
// (تفادي إعادة تحميل المحتوى نفسه) دون خطر تقديم نسخة قديمة بعد كل نشر جديد.
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'frontend', 'app.html'));
});

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(async () => {
    // مزامنة عند بدء التشغيل: لو عدد صفوف clients_rows لا يطابق عدد عملاء kv_store الفعلي
    // (يشمل الحالة القديمة: 0 صف رغم وجود آلاف العملاء — كانت تحدث بصمت لو صف واحد فقط
    // به id مكرر أوقف كل عملية المزامنة بالكامل قبل هذا الإصلاح)، نعيد المزامنة كاملة.
    // الآن آمنة ورخيصة التكلفة (UPSERT) فتُستدعى دائماً عند الإقلاع لضمان تطابق دائم.
    try {
      const existing = await pool.query(`SELECT value FROM kv_store WHERE key = 'clients'`);
      if (existing.rows[0] && existing.rows[0].value) {
        let expectedCount = 0;
        try { const parsed = JSON.parse(existing.rows[0].value); if (Array.isArray(parsed)) expectedCount = parsed.filter(c => c && c.id).length; } catch (e) { console.error('[Server] Failed to parse expectedCount from settings:', e); }
        const cnt = await pool.query('SELECT COUNT(*) FROM clients_rows');
        if (Number(cnt.rows[0].count) !== expectedCount) {
          await syncClientsRows(existing.rows[0].value);
          console.log(`✅ تمت مزامنة/ترحيل بيانات العملاء إلى clients_rows (${expectedCount} عميل متوقع)`);
        }
      }
    } catch (e) { console.error('تعذّر الترحيل الأولي لـ clients_rows:', e.message); }

    // تنظيف دوري لجدول login_history: نحتفظ بآخر 90 يوماً فقط حتى لا يكبر الجدول للأبد.
    async function cleanLoginHistory() {
      try {
        const r = await pool.query(`DELETE FROM login_history WHERE logged_in_at < now() - INTERVAL '90 days'`);
        if (r.rowCount > 0) console.log(`🧹 حُذف ${r.rowCount} سجل قديم من login_history`);
      } catch (e) { console.error('تعذّر تنظيف login_history:', e.message); }
    }
    cleanLoginHistory();
    setInterval(cleanLoginHistory, 24 * 60 * 60 * 1000); // كل 24 ساعة

    app.listen(PORT, () => console.log(`✅ الخادم يعمل على المنفذ ${PORT}`));
  })
  .catch(e => {
    console.error('❌ تعذّر تجهيز قاعدة البيانات:', e);
    process.exit(1);
  });
