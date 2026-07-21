require('dotenv').config();
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { pool, ensureSchema } = require('./db');
const { signToken, requireAuth, requireRole, hashPassword, verifyPassword } = require('./auth');

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
app.use(helmet({ contentSecurityPolicy: false }));
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

/* ---------------- تسجيل الدخول ---------------- */
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });
  }
  try {
    const r = await pool.query('SELECT * FROM server_users WHERE username = $1', [username.trim()]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    const token = signToken(user);
    // نُرجع username و role صراحة في جسم الاستجابة، لأن الواجهة أصبحت تعتمد عليهما
    // مباشرة لتحديد صلاحيات المستخدم (admin/staff)، بدل أي قائمة محلية داخل البرنامج.
    res.json({
      token,
      username: user.username,
      role: user.role || 'staff',
      user: { username: user.username, displayName: user.display_name, role: user.role || 'staff' },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
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
      'SELECT id, username, display_name, role, created_at FROM server_users ORDER BY created_at ASC'
    );
    res.json({ users: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة المستخدمين' });
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
         role = EXCLUDED.role
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

/* ---------------- التحقق من كود الترخيص (لا يتطلب تسجيل دخول) ---------------- */
const { validateLicenseKey } = require('./license');
app.post('/api/license/validate', licenseLimiter, (req, res) => {
  const { licenseKey } = req.body || {};
  const result = validateLicenseKey(licenseKey);
  res.json(result);
});

/* ---------------- مخزن المفاتيح/القيم (يطابق واجهة window.storage) ---------------- */
// GET /api/storage/:key  -> { key, value, version }
app.get('/api/storage/:key', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT value, version FROM kv_store WHERE key = $1', [req.params.key]);
    if (!r.rows[0]) return res.json({ key: req.params.key, value: null, version: 0 });
    res.json({ key: req.params.key, value: r.rows[0].value, version: r.rows[0].version });
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
app.put('/api/storage/:key', requireAuth, async (req, res) => {
  const { value } = req.body || {};
  const knownVersion = Number.isInteger(req.body?.version) ? req.body.version : 0;
  try {
    const upsert = await pool.query(
      `INSERT INTO kv_store (key, value, version, updated_by)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         version = kv_store.version + 1,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by
       WHERE kv_store.version = $4
       RETURNING value, version`,
      [req.params.key, value, req.user.username, knownVersion]
    );
    if (upsert.rows[0]) {
      return res.json({ key: req.params.key, value: upsert.rows[0].value, version: upsert.rows[0].version });
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
        model: 'claude-sonnet-4-6',
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

app.post('/api/ai/read-invoices', invoiceReadJsonParser, requireAuth, async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: 'لم يتم إرسال أي ملفات' });
  if (files.length > 30) return res.status(400).json({ error: 'الحد الأقصى 30 ملفاً في المرة الواحدة' });
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
app.post('/api/zatca/invoice', requireAuth, async (req, res) => {
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
    console.error(e);
    res.status(500).json({ error: 'تعذّر إرسال الفاتورة للهيئة', detail: e.message });
  }
});

// إرسال إشعار دائن (مردود مبيعات)
app.post('/api/zatca/return', requireAuth, async (req, res) => {
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
    console.error(e);
    res.status(500).json({ error: 'تعذّر إرسال المردود للهيئة', detail: e.message });
  }
});

/* ---------------- استضافة واجهة البرنامج (نفس ملف HTML) ---------------- */
// نمنع المتصفح من تخزين app.html في الكاش لفترة طويلة، حتى يصل أي تحديث جديد
// للمستخدمين فوراً بعد كل نشر (deploy) بدل ما يفضلوا شايفين نسخة قديمة مخزّنة.
// بالنسبة لبقية الملفات الثابتة (JS/CSS)، لا نستخدم مدة كاش ثابتة (كانت ساعة سابقاً)
// لأن ذلك يخلي المتصفح يشغّل نسخة قديمة من app-inline.js لمدة تصل لساعة كاملة بعد كل
// تحديث فعلي على السيرفر، وهذا يسبب ظهور البرنامج وكأنه "ما اتحدّث" رغم نجاح النشر.
// بدون maxAge، يعتمد express.static على ETag/Last-Modified: المتصفح يتأكد من السيرفر
// في كل مرة (رد سريع 304 لو الملف لم يتغيّر فعلياً)، فنحافظ على معظم فائدة الكاش
// (تفادي إعادة تحميل المحتوى نفسه) دون خطر تقديم نسخة قديمة بعد كل نشر جديد.
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'frontend', 'app.html'));
});

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ الخادم يعمل على المنفذ ${PORT}`));
  })
  .catch(e => {
    console.error('❌ تعذّر تجهيز قاعدة البيانات:', e);
    process.exit(1);
  });
