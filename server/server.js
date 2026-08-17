require('dotenv').config();
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { pool, ensureSchema } = require('./db');
const { centralErrorHandler } = require('./errors');
const { loadRolePermissionsCache } = require('./permissions');
const backupsRouter = require('./routes/backups');
const aiRouter = require('./routes/ai');
const zatcaRouter = require('./routes/zatca');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const webauthnRouter = require('./routes/webauthn');
const { router: permissionsRouter } = require('./permissions');
const { router: recordsRouter, syncClientsRows } = require('./routes/records');

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
// ضغط كل الاستجابات (gzip) — يقلّل حجم app.html (~1.8MB) أثناء النقل عبر الشبكة.
// نستثني مسارات البيانات المشفّرة (ENC2) لأن النص المشفّر عشوائي لا يضغط إطلاقاً —
// محاولة gzip عليه تهدر CPU السيرفر وتطيل الاستجابة. استجابات /api/records-versions و
// /api/storage-versions (أرقام صغيرة جداً) تظل مضغوطة كالمعتاد.
app.use(compression({
  filter: (req, res) => {
    const p = req.path;
    // اتصال البث اللحظي (SSE) يجب أن يبقى دائماً بلا ضغط: gzip يعمل على تجميع (buffering) البيانات
    // داخل zlib حتى تتوفر كمية كافية لإنتاج كتلة مضغوطة، فتتأخر كل الأحداث حتى تصل هذه الكمية أو
    // يُغلَق الاتصال — بينما اتصال SSE مصمم أصلاً ليبقى مفتوحاً لفترة طويلة يبعث كل حدث فور وقوعه.
    // ضغطه هو تحديداً ما كان يسبب ظهور الاتصال "معلّقاً"/متأخراً، وتنافساً غريباً بين اتصالات
    // مستخدمين مختلفين على نفس الموارد (تبديل الاتصال بينهم بدل بقاء الاثنين مفتوحين معاً).
    if (p === '/api/events/stream') return false;
    if (p === '/api/storage-versions' || p === '/api/records-versions') return true;
    if (p.startsWith('/api/storage')) return false;               // قيم مشفّرة كبيرة
    if (p.startsWith('/api/records/') && !p.endsWith('/versions') && !p.endsWith('/pending')) return false;
    if (p.startsWith('/api/client-records') && !p.endsWith('/version') && !p.endsWith('/ids')) return false;
    return true;
  }
}));
app.use(express.json({ limit: '25mb' })); // بيانات مشفّرة كاملة (آلاف العملاء) قد تكون كبيرة نسبياً

/* حماية من محاولات التخمين المتكررة (Brute-force) على المسارات التي لا تتطلب
   تسجيل دخول مسبق. نحدّد بالـ IP لأن هذين المسارين تحديداً هما هدف مباشر
   لأي محاولة تخمين آلية (كلمة مرور أو كود ترخيص) — الحدود الفعلية الآن فى rate-limiters.js */

/* ---------------- المصادقة الثنائية (TOTP) — أدمن فقط حالياً ---------------- */
app.use(authRouter);
app.use(webauthnRouter);


/* ---------------- مخزن المفاتيح/القيم (يطابق واجهة window.storage) ---------------- */

app.use(permissionsRouter);


// GET /api/storage/:key  -> { key, value, version }
// يدعم If-None-Match: لو الجهاز عنده نفس النسخة (version) بالفعل، نرد 304 بدون
// إعادة إرسال القيمة كاملة (ممكن تكون مئات الكيلوبايتات لمفاتيح زي قوائم العملاء
// أو حركات الخزنة)، فنوفر نقل البيانات في كل مرة يفتح فيها المستخدم البرنامج
// ولم يتغيّر شيء منذ آخر زيارة.
// GET /api/clients?page=&pageSize=&search=&nationality=&courseType=&dateFrom=&dateTo=&sort=&order=
// ترقيم/بحث/فلترة حقيقية من قاعدة البيانات (بدون تحميل كل العملاء للمتصفح)، تُستخدم فقط من
// شاشة "جدول العملاء" نفسها للحالات الشائعة (تصفح + بحث بالاسم/الهوية + فلترة بالجنسية/الدورة/التاريخ).
// فلاتر المبالغ (مدين/مسدد) والفرز بالمبالغ غير مدعومة هنا عمداً لأنها تعتمد على حسابات معقّدة
app.use(recordsRouter);


app.use(aiRouter);
app.use(backupsRouter);
app.use(healthRouter);
app.use(zatcaRouter);

app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'المسار غير موجود' });
  }
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'frontend', 'app.html'));
});

// معالج أخطاء مركزي — شبكة أمان لأي خطأ يفلت من معالجات الـ routes (يُثبَّت بعد كل الـ routes)
app.use(centralErrorHandler);

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(async () => {
    try {
      await loadRolePermissionsCache();
      console.log('✅ تم تحميل صلاحيات الأدوار (role_permissions)');
    } catch (e) { console.error('❌ تعذّر تحميل صلاحيات الأدوار — سيُعتمد وضع الحظر الاحترازي حتى إعادة المحاولة التالية:', e.message); }

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

    // حذف نهائي تلقائي لسجلات العملاء المرفوضة من الأدمن بعد 15 يوماً من وقت الرفض (رفض تسلسلي
    // "لطيف": السجل يبقى ظاهراً لموظف الاستقبال صاحبه فقط خلال هذه المهلة — راجع تعليق
    // /api/client-records/:id/reject و clientRecordsVisibilitySql أعلاه فى نفس الملف).
    async function cleanRejectedClientRecords() {
      try {
        const r = await pool.query(`DELETE FROM client_records WHERE status = 'rejected' AND rejected_at < now() - INTERVAL '15 days'`);
        if (r.rowCount > 0) console.log(`🧹 حُذف ${r.rowCount} سجل عميل مرفوض تجاوز مهلة الـ15 يوماً`);
      } catch (e) { console.error('تعذّر تنظيف سجلات العملاء المرفوضة:', e.message); }
    }
    cleanRejectedClientRecords();
    setInterval(cleanRejectedClientRecords, 24 * 60 * 60 * 1000); // كل 24 ساعة

    app.listen(PORT, () => console.log(`✅ الخادم يعمل على المنفذ ${PORT}`));
  })
  .catch(e => {
    console.error('❌ تعذّر تجهيز قاعدة البيانات:', e);
    process.exit(1);
  });
