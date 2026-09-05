require('dotenv').config();
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const https = require('https'); // مطلوب لراوت /gsheet-csv (بروكسي جلب شيتات جوجل) — كان ناقصاً فيسبب ReferenceError عند كل محاولة جلب
const { pool, ensureSchema } = require('./db');
const recordsRepo = require('./repo/records.repo');
const authRepo = require('./repo/auth.repo');
const syncService = require('./services/sync');
const { centralErrorHandler } = require('./errors');
const { loadRolePermissionsCache } = require('./permissions');
const backupsRouter = require('./routes/backups');
const aiRouter = require('./routes/ai');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const webauthnRouter = require('./routes/webauthn');
const magicLinkRouter = require('./routes/magic-link');
const qrLoginRouter = require('./routes/qr-login');
const emailRouter = require('./routes/email');
const { router: permissionsRouter } = require('./permissions');
const { router: recordsRouter } = require('./routes/records');
const arkkanRouter = require('./routes/arkkan');

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
const bulkJsonParser = express.json({ limit: '10mb' });
app.use('/api/client-records/bulk-migrate', bulkJsonParser);
app.use('/api/records/:collection/bulk-migrate', bulkJsonParser);
app.use(express.json({ limit: '2mb' })); // إصلاح أمني/أداء: كان 25mb يسمح بهجوم OOM. ترتيب bulk قبل العام حتى لا يحجب 10mb

/* حماية من محاولات التخمين المتكررة (Brute-force) على المسارات التي لا تتطلب
   تسجيل دخول مسبق. نحدّد بالـ IP لأن هذين المسارين تحديداً هما هدف مباشر
   لأي محاولة تخمين آلية (كلمة مرور أو كود ترخيص) — الحدود الفعلية الآن فى rate-limiters.js */

/* ---------------- المصادقة الثنائية (TOTP) — أدمن فقط حالياً ---------------- */
app.use(authRouter);
app.use(webauthnRouter);
app.use(magicLinkRouter);
app.use(qrLoginRouter);
app.use(emailRouter);


/* ---------------- مخزن المفاتيح/القيم (يطابق واجهة window.storage) ---------------- */

app.use(permissionsRouter);

app.use(recordsRouter);


app.use(aiRouter);
app.use(backupsRouter);
app.use(healthRouter);

/* ---------------- بروكسي Google Sheets CSV (للعمل من المتصفح/السيرفر) ----------------
   الجلب المباشر من المتصفح إلى docs.google.com يُحجب بـ CORS، فنجلب server-to-server
   ونعيد النتيجة. نفس معايير الأمان (SSRF + allowlist) الموجودة في electron main.js. */
const GSHEET_ALLOWED_HOSTS = [
  'docs.google.com',
  'drive.google.com',
  'googleusercontent.com',
  'google.com'
];
function isGsheetAllowedHost(hostname) {
  hostname = String(hostname || '').toLowerCase();
  if (hostname === 'docs.googleusercontent.com') return true;
  return GSHEET_ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}
function isPrivateOrReservedIp(hostname) {
  if (hostname === 'localhost') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const parts = hostname.split('.').map(Number);
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0 || parts[0] === 100) return true;
    if (parts[0] >= 224) return true;
  }
  return false;
}
function isGsheetUrlSafe(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (e) { return { ok: false, reason: 'رابط غير صالح' }; }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'يجب أن يكون الرابط HTTPS' };
  if (!isGsheetAllowedHost(parsed.hostname)) return { ok: false, reason: 'النطاق غير مسموح' };
  if (isPrivateOrReservedIp(parsed.hostname)) return { ok: false, reason: 'لا يُسمح بالوصول إلى عناوين خاصة' };
  return { ok: true, reason: '', url: parsed.toString() };
}
app.get('/gsheet-csv', (req, res) => {
  const target0 = String(req.query.url || '');
  const urlCheck = isGsheetUrlSafe(target0);
  if (!urlCheck.ok) return res.status(400).json({ error: 'رابط غير صالح — ' + urlCheck.reason });
  if (!/^\/(spreadsheets|file)\//.test(new URL(target0).pathname)) {
    return res.status(400).json({ error: 'رابط غير صالح — يجب أن يكون رابط Google Docs Spreadsheet' });
  }
  let hops = 0;
  function fetchCsv(target) {
    const safeCheck = isGsheetUrlSafe(target);
    if (!safeCheck.ok) {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'اعادة توجيه لنطاق غير مسموح — ' + safeCheck.reason }));
    }
    const req2 = https.get(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 25000 }, remoteRes => {
      if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location && hops < 5) {
        hops++;
        let next;
        try { next = new URL(remoteRes.headers.location, target).toString(); }
        catch (e) {
          if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'رابط redirect غير صالح' }));
        }
        return fetchCsv(next);
      }
      try {
        const finalUrl = new URL(target);
        if (!isGsheetAllowedHost(finalUrl.hostname)) {
          if (!res.headersSent) res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'النطاق النهائي غير مسموح به' }));
        }
      } catch (e) {}
      res.writeHead(remoteRes.statusCode || 200, {
        'Content-Type': remoteRes.headers['content-type'] || 'text/csv; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      remoteRes.pipe(res);
    });
    req2.on('error', err => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'تعذّر جلب شيت جوجل: ' + err.message }));
    });
    req2.on('timeout', function () { this.destroy(new Error('timeout')); });
  }
  fetchCsv(target0);
});

app.use(arkkanRouter);
// arkkanSyncRouter (جلب أركان عبر Playwright جوّه السيرفر) اتشال نهائياً —
// الجلب بقى بيتم عبر arkkan-agent.js محلياً على جهاز المستخدم (localhost:9955)
// عشان نمنع استهلاك RAM Chromium على استضافة Render.

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
    syncService.startupCheckAndSync();

    // تنظيف دوري لجدول login_history: نحتفظ بآخر 90 يوماً فقط حتى لا يكبر الجدول للأبد.
    async function cleanLoginHistory() {
      try {
        const n = await authRepo.cleanLoginHistory();
        if (n > 0) console.log(`🧹 حُذف ${n} سجل قديم من login_history`);
      } catch (e) { console.error('تعذّر تنظيف login_history:', e.message); }
    }
    cleanLoginHistory();
    setInterval(cleanLoginHistory, 24 * 60 * 60 * 1000); // كل 24 ساعة

    // تنظيف دوري لجدول magic_link_tokens: روابط الدخول المستهلكة أو المنتهية لا قيمة لها
    // بعد أسبوع — بدون هذا التنظيف كان الجدول ينمو للأبد (كل رابط مطلوب = صف دائم).
    async function cleanMagicLinkTokens() {
      try {
        const n = await authRepo.cleanMagicLinkTokens();
        if (n > 0) console.log(`🧹 حُذف ${n} رابط دخول قديم من magic_link_tokens`);
      } catch (e) { console.error('تعذّر تنظيف magic_link_tokens:', e.message); }
    }
    cleanMagicLinkTokens();
    setInterval(cleanMagicLinkTokens, 24 * 60 * 60 * 1000); // كل 24 ساعة

    // حذف نهائي تلقائي لسجلات العملاء المرفوضة من الأدمن بعد 15 يوماً من وقت الرفض (رفض تسلسلي
    // "لطيف": السجل يبقى ظاهراً لموظف الاستقبال صاحبه فقط خلال هذه المهلة — راجع تعليق
    // /api/client-records/:id/reject و clientRecordsVisibilitySql أعلاه فى نفس الملف).
    async function cleanRejectedClientRecords() {
      try {
        const n = await recordsRepo.cleanRejectedClientRecords();
        if (n > 0) console.log(`🧹 حُذف ${n} سجل عميل مرفوض تجاوز مهلة الـ15 يوماً`);
      } catch (e) { console.error('تعذّر تنظيف سجلات العملاء المرفوضة:', e.message); }
    }
    cleanRejectedClientRecords();
    setInterval(cleanRejectedClientRecords, 24 * 60 * 60 * 1000); // كل 24 ساعة

    const server = app.listen(PORT, () => console.log(`✅ الخادم يعمل على المنفذ ${PORT}`));

    // إغلاق سلس (Graceful shutdown): عند استقبال إشارة إيقاف من المنصة (SIGTERM يرسله Render
    // عند re-deploy/قيام، و SIGINT عند Ctrl+C محلياً) نتوقف عن قبول طلبات جديدة ونُنهي الطلبات
    // الجارية ثم نغلق pool قاعدة البيانات ونخرج — بدل أن يُقتل الخادم فوراً فتقطع استعلامات
    // قاعدة بيانات كانت قيد التنفيذ (كان يمكن أن يترك بيانات في حالة وسط/ناقصة).
    function shutdown(signal) {
      console.log(`⏳ استلام ${signal} — بدء الإغلاق السلس...`);
      server.close(async () => {
        try { await pool.end(); } catch (e) { console.error('تعذّر إغلاق pool قاعدة البيانات:', e); }
        console.log('✅ أُغلقت الاتصالات بنجاح.');
        process.exit(0);
      });
      // شبكة أمان: لو علّقت طلبات جارية، نُجبر الخروج بعد 10 ثوانٍ (بدل البقاء معلّقاً للأبد).
      setTimeout(() => { console.error('⏰ مهلة الإغلاق انتهت — إيقاف إجباري.'); process.exit(1); }, 10000).unref();
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // شبكة أمان أخيرة: أي خطأ يفلت خارج دورة الطلب/الاستجابة تماماً (centralErrorHandler
    // يغطي فقط ما يحدث داخل route handlers) — مثلاً throw متزامن داخل callback مؤقّت،
    // أو Promise مرفوض بدون .catch فى أي مكان بالكود. بدون هذا، Node يوقف العملية فوراً
    // (سلوكه الافتراضي) فيسقط السيرفر بالكامل بصمت، ولا يظهر إلا "توقف الخدمة" فى Render
    // من غير أي تفصيل فى نفس اللحظة. هنا نسجّل بوضوح أولاً، ثم نحاول إغلاقاً سلساً كالمعتاد
    // بدل الخروج المفاجئ — وبنفس مهلة الأمان (10 ثوانٍ إجبارية) لو تعلّق الإغلاق نفسه.
    process.on('uncaughtException', (err) => {
      console.error('🔴 uncaughtException — خطأ غير متوقع أوقف تدفق الكود الطبيعي:', err);
      shutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      console.error('🔴 unhandledRejection — Promise مرفوض بدون معالجة فى أي مكان بالكود:', reason);
      shutdown('unhandledRejection');
    });
  })
  .catch(e => {
    console.error('❌ تعذّر تجهيز قاعدة البيانات:', e);
    process.exit(1);
  });
