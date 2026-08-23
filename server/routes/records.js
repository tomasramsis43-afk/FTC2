const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { storageLimiter } = require('../rate-limiters');
const { restrictKeyToAdmin, roleCanAccessView, RESTRICTED_STORAGE_KEYS } = require('../permissions');
const { broadcastRecordChanged } = require('../sse');

// (خصومات، دفعات جزئية...) موجودة فقط بمنطق الواجهة الأمامية — تلك الحالات تستمر تُحسب من
// المصفوفة الكاملة المحمّلة أصلاً بالمتصفح كما كانت قبل هذا التحديث، بلا أي تغيير في نتيجتها.
router.get('/api/clients', requireAuth, async (req, res) => {
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
    // نسخة clients_rows مفهرسة من كتلة kv القديمة ولا تحمل عزل origin/status، فتُستبعد صراحةً
    // سجلات الاستقبال المعلّقة (origin='reception' AND status='pending') لكل الدور غير الأدمن —
    // وإلا كشفت هذه النقطة عملاء مسودات الاستقبال لأي دور آخر عبر طلب مباشر (نفس إصلاح
    // التسريب بالمعرّف في مسارات client-records). الأدمن يرى كل شيء كما كان دائماً.
    if (req.user.role !== 'admin') {
      where.push(`NOT EXISTS (SELECT 1 FROM client_records cr WHERE cr.id = clients_rows.id AND cr.origin = 'reception' AND cr.status = 'pending')`);
    }
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

router.get('/api/storage/:key', requireAuth, restrictKeyToAdmin, async (req, res) => {
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
  // كل المعرّفات الموجودة فعلاً في المصفوفة الجديدة — يستخدمها الـ DELETE النهائي لمعرفة
  // الصفوف التي "أُزيلت فعلاً" من القائمة. استخدام المعرّفات الناجحة فقط (كما كان) كان
  // يحذف صفوف عملاء ما زالوا موجودين في المصفوفة لو فشل رفعهم مؤقتاً (انقطاع شبكة لحظي
  // مثلاً) — أي فقدان بيانات مفهرسة مؤقت بحجة مزامنة ناجحة جزئياً.
  const allIds = valid.map(c => c.id);
  let failedRows = 0;
  for (let start = 0; start < valid.length; start += CLIENTS_ROWS_CHUNK_SIZE) {
    const chunk = valid.slice(start, start + CLIENTS_ROWS_CHUNK_SIZE);
    try {
      await upsertClientsRowsChunk(chunk);
    } catch (e) {
      // فشلت الدفعة كاملة (مثلاً id مكرر داخلها) — نعيد المحاولة صفاً صفاً لهذه الدفعة
      // فقط، حتى نتجاوز الصف السيّئ تحديداً دون فقد باقي الدفعة.
      for (const c of chunk) {
        try {
          await upsertClientsRowsChunk([c]);
        } catch (e2) {
          failedRows++;
          console.error(`تعذّرت مزامنة صف عميل واحد (id=${c.id}):`, e2.message);
        }
      }
    }
  }
  if (failedRows) console.error(`مزامنة clients_rows: تم تجاوز ${failedRows} صف بسبب خطأ (غالباً id مكرر)، وتمت مزامنة الباقي بنجاح`);
  try {
    if (allIds.length) {
      // يُحذف فقط ما ليس في المصفوفة الجديدة إطلاقاً — الصفوف التي فشلت للتو تبقى لأن
      // معرّفها ضمن allIds (على الأرجح موجودة أصلاصاً من مزامنة سابقة، والأفضل إبقاؤها
      // من حذفها وفقدان ظهورها مؤقتاً في شيت العملاء).
      await pool.query(`DELETE FROM clients_rows WHERE id != ALL($1)`, [allIds]);
    } else if (arr.length === 0) {
      // المصفوفة فارغة فعلاً (لا يوجد أي عميل) — نفرّغ الجدول المفهرس ليطابق ذلك.
      await pool.query('DELETE FROM clients_rows');
    }
    // لو arr غير فارغة لكن كل الصفوف فشلت (allIds فارغ فقط لو لا صف صالح أصلاً) لا نحذف
    // شيئاً تحسباً لخطأ عابر (مثل انقطاع اتصال) حتى لا نفقد البيانات المفهرسة السابقة بلا داعٍ.
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

router.put('/api/storage/:key', requireAuth, storageLimiter, restrictKeyToAdmin, async (req, res) => {
  const { value } = req.body || {};
  const knownVersion = Number.isInteger(req.body?.version) ? req.body.version : 0;
  // حارس سلامة حاسم: القيمة المخزَّنة لكل مفتاح يجب أن تكون نصاً (JSON مشفّر/غير مشفّر). لو وصلت
  // قيمة غير نصية (null/مفقودة/كائن) يتم رفض الطلب قبل لمس قاعدة البيانات — كانت القيمة `null`
  // تُكتب فعلياً في kv_store، وللمفتاح clients كانت تُشغّل مزامنة clients_rows التي تحذف جدول
  // العملاء المُفهرس بالكامل (فقدان بيانات صامت لأي طلب تالف أو خطأ في الواجهة).
  if (typeof value !== 'string' || !value) {
    return res.status(400).json({ error: 'القيمة المرسلة غير صحيحة (يجب أن تكون نصاً غير فارغ) — أُوقف الحفظ قبل المساس بالبيانات' });
  }
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
      broadcastRecordChanged({ collection: 'kv:' + req.params.key, actorUsername: req.user.username });
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
router.delete('/api/storage/:key', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM kv_store WHERE key = $1', [req.params.key]);
    if (req.params.key === 'clients') await pool.query('DELETE FROM clients_rows').catch(()=>{});
    res.json({ key: req.params.key, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر الحذف' });
  }
});

router.get('/api/storage', requireAuth, async (req, res) => {
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
  // مستخدم الاستقبال يرى سجلاته المعلّقة/المعتمدة دائماً، وسجلاته المرفوضة أيضاً لكن لمدة 15 يوماً
  // فقط من وقت الرفض (raised_at)، ليعرف أن الأدمن رفضها قبل أن تُحذف نهائياً تلقائياً بعد المهلة.
  if (role === 'reception') return { where: `WHERE origin = $1 AND created_by = $2 AND (status <> 'rejected' OR rejected_at > now() - INTERVAL '15 days')`, params: ['reception', username] };
  return { where: 'WHERE status = $1', params: ['confirmed'] };
}

// نفس عزل العملاء تماماً لكن للتصنيفات العامة (collection_records): الأدمن يرى كل شيء
// (عام + مسودات/معتمدات كل الاستقبال). كل مستخدم استقبال يرى سجلاته هو شخصياً فقط
// (origin='reception' AND created_by = اسم المستخدم الحالي) — معزول حتى عن بقية مستخدمي
// الاستقبال. وأي دور آخر (staff/accountant) يرى فقط السجلات المعتمدة status='confirmed'
// (نفس السلوك القديم تماماً بالنسبة له). الصيغة بصيغة AND عمداً (لا تبدأ بـ WHERE) لأن
// كل مسارات السجلات العامة تضيفها لشرط collection موجود أصلاً.
function recordsVisibilitySql(role, username) {
  if (role === 'admin') return { where: '', params: [] };
  if (role === 'reception') return { where: 'AND origin = $2 AND created_by = $3', params: ['reception', username] };
  return { where: 'AND status = $1', params: ['confirmed'] };
}
// التصنيفات التشغيلية التي تكتبها شاشات الاستقبال فعلاً (العملاء/الخزنة/المخزون/الدورات):
// سجلاتها المضافة من دور 'reception' تبدأ معلّقة (pending) بانتظار اعتماد الأدمن. بقية
// التصنيفات (سجلات تاريخية/إعدادات) لا تدخل نظام الاعتماد إطلاقاً حتى لا تُقيَّد عمليات
// نظامية جانبية (سجل التدقيق، سجل الإلغاءات...) بموافقات منفصلة بلا معنى.
const APPROVAL_GATED_COLLECTIONS = ['vaultTx', 'bagStock', 'courseSessions'];

router.get('/api/client-records', requireAuth, async (req, res) => {
  try {
    const { where, params } = clientRecordsVisibilitySql(req.user.role, req.user.username);
    // ترقيم اختياري (page/pageSize) لمنع القراءات غير المقيدة دون كسر المزامنة الحالية:
    // الافتراضي (بدون page) يعيد كل السجلات كما كان، لتبقى مزامنة الواجهة بدون اتصال تعمل.
    const page = parseInt(req.query.page, 10);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 200));
    let sql = `SELECT id, enc, version, origin, status FROM client_records ${where}`;
    const sqlParams = [...params];
    // هل يوجد شرط WHERE بالفعل؟ (فارغ فقط عندما role==='admin' — لا قيود على رؤيته). أي شرط
    // إضافي لاحق (ids=) يجب أن يبدأ بـ WHERE لو لم يوجد شرط سابق، أو AND لو وُجد — وإلا نحصل على
    // "... FROM client_records  AND id = ANY(...)" بلا WHERE قبلها، وهو خطأ syntax فى بوستجرس
    // كان يفشل دائماً تحديداً لحالة الأدمن (الدور الوحيد الذي يُرجع where فارغاً)، فيمنعه هذا
    // الخطأ من مزامنة أي سجل عميل جديد/معدَّل تزايدياً عبر _fetchDeltaClientRecords فى الواجهة —
    // العميل الجديد كان يظل غير مرئي للأدمن حتى لو نجحت كل خطوات المزامنة الأخرى.
    let hasWhere = /\bwhere\b/i.test(where);
    // جلب الفروق فقط (delta): نفس فكرة GET /api/records/:collection?ids= بالضبط — لو المُستدعي
    // أرسل ids= (قائمة ids مفصولة بفواصل) نرجع هذه السجلات فقط بدل جدول العملاء كامل. هذا هو
    // الأساس الذي بنيت عليه _fetchDeltaClientRecords فى الواجهة لتفادي إعادة تنزيل كل عميل فى
    // النظام (وقد يكونوا آلاف) بمجرد تعديل عميل واحد من أي جهاز — كان السبب الرئيسي لاستهلاك
    // ضخم غير ضروري من حصة نقل بيانات قاعدة البيانات الشهرية.
    const idsParam = req.query.ids;
    if (typeof idsParam === 'string' && idsParam.length) {
      const idList = idsParam.split(',').map(s => s && s.trim()).filter(Boolean);
      if (idList.length) {
        sql += ` ${hasWhere ? 'AND' : 'WHERE'} id = ANY($${sqlParams.length + 1}::text[])`;
        sqlParams.push(idList);
        hasWhere = true;
      }
    }
    if (Number.isInteger(page) && page >= 1) {
      sql += ` ORDER BY version ASC, id ASC LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}`;
      sqlParams.push(pageSize, (page - 1) * pageSize);
    }
    const r = await pool.query(sql, sqlParams);
    res.json({ records: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب سجلات العملاء' });
  }
});

// أرقام إصدارات كل عميل على حدة (طلب خفيف بدون بيانات فعلية) — تستخدمه المزامنة الجديدة (راجع
// _fetchDeltaClientRecords فى storage-sync.js) لجلب "الفروق فقط" بدل تنزيل جدول العملاء كاملاً:
// يُقارن بها الجهاز أرقامه المحلية فيطلب لاحقاً عبر GET /api/client-records?ids= العملاء الذين
// تغيّروا/أُضيفوا فقط. نفس فلترة الرؤية المطبَّقة على GET /api/client-records تماماً.
router.get('/api/client-records/versions', requireAuth, async (req, res) => {
  try {
    const { where, params } = clientRecordsVisibilitySql(req.user.role, req.user.username);
    const r = await pool.query(`SELECT id, version FROM client_records ${where}`, params);
    res.json({ pairs: r.rows.map(row => [row.id, Number(row.version)]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب أرقام إصدارات العملاء' });
  }
});

// رقم إصدار خفيف جداً (مجموع أرقام النسخ لكل الصفوف) يتغيّر مع أي إضافة/تعديل/حذف — تستخدمه
// الأجهزة الأخرى للتحقّق الدوري السريع (طلب واحد صغير، بدون نقل أي بيانات فعلية) من وجود
// تعديلات جديدة على العملاء من مستخدم آخر، بنفس فكرة GET /api/storage-versions لبقية المفاتيح.
// نفس فلترة الرؤية أعلاه بالضبط، وإلا يظهر للمستخدم إشعار "يوجد تحديث" عن سجلات لا يحق له رؤيتها أصلاً.
router.get('/api/client-records/version', requireAuth, async (req, res) => {
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
router.get('/api/client-records/ids', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, client_id FROM client_records WHERE client_id IS NOT NULL AND client_id <> ''`);
    res.json({ ids: r.rows.map(row => ({ id: row.id, clientIdHash: crypto.createHash('sha256').update(row.client_id).digest('hex') })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة أرقام الهوية' });
  }
});

router.put('/api/client-records/:id', requireAuth, storageLimiter, async (req, res) => {
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
    if (upsert.rows[0]) {
      broadcastRecordChanged({ collection: 'clients', actorUsername: req.user.username });
      return res.json({ id: req.params.id, version: upsert.rows[0].version, origin: upsert.rows[0].origin, status: upsert.rows[0].status });
    }
    const current = await pool.query('SELECT version, enc FROM client_records WHERE id = $1', [req.params.id]);
    return res.status(409).json({
      error: 'تعارض: تم تعديل بيانات هذا العميل من جهاز آخر بعد آخر تحديث لديك. يرجى تحديث الصفحة وإعادة تنفيذ العملية.',
      currentVersion: current.rows[0] ? current.rows[0].version : 0,
      currentEnc: current.rows[0] ? current.rows[0].enc : null,
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
router.post('/api/client-records/:id/approve', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE client_records SET status = 'confirmed', version = version + 1, updated_at = now()
       WHERE id = $1 AND origin = 'reception' AND status = 'pending'
       RETURNING id, version`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'لا يوجد سجل معلّق بهذا المعرّف بانتظار الاعتماد' });
    broadcastRecordChanged({ collection: 'clients', actorUsername: req.user.username });
    res.json({ id: r.rows[0].id, version: r.rows[0].version, status: 'confirmed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر اعتماد بيانات العميل' });
  }
});

// رفض الأدمن لسجل عميل معلّق سجّله الاستقبال (pending -> rejected): بدل الحذف الفوري النهائي،
// نُبقي السجل فى الجدول بحالة 'rejected' مع وقت الرفض، فيبقى ظاهراً لموظف الاستقبال صاحبه فقط
// (راجع clientRecordsVisibilitySql) لمدة 15 يوماً ليعرف أن الأدمن رفضه، ثم يُحذف تلقائياً نهائياً
// (راجع cleanRejectedClientRecords أسفل الملف). لا يدخل هذا السجل أي حساب/تقرير مطلقاً كحاله وقت
// كان pending تماماً — فقط status يتغيّر، enc يبقى كما هو (السيرفر لا يعرف محتواه أصلاً).
router.post('/api/client-records/:id/reject', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE client_records SET status = 'rejected', rejected_at = now(), version = version + 1, updated_at = now()
       WHERE id = $1 AND origin = 'reception' AND status = 'pending'
       RETURNING id, version`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'لا يوجد سجل معلّق بهذا المعرّف بانتظار الاعتماد' });
    broadcastRecordChanged({ collection: 'clients', actorUsername: req.user.username });
    res.json({ id: r.rows[0].id, version: r.rows[0].version, status: 'rejected' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر رفض بيانات العميل' });
  }
});

router.delete('/api/client-records/:id', requireAuth, storageLimiter, async (req, res) => {
  try {
    // حارس حذف بفحص النسخة (نفس منطق /api/records/:collection/:id): الواجهة ترسل رقم النسخة الذي
    // رآه الجهاز، ولو تغيّر السجل من جهاز آخر بعد آخر مشاهدة نرفض الحذف بـ409 بدل حذف بيانات أحدث.
    const wantVersionRaw = req.query.version;
    if (wantVersionRaw !== undefined && wantVersionRaw !== ''){
      const wantVersion = Number(wantVersionRaw);
      if (Number.isFinite(wantVersion)){
        const cur = await pool.query('SELECT version FROM client_records WHERE id = $1', [req.params.id]);
        if (cur.rows[0] && cur.rows[0].version !== wantVersion){
          return res.status(409).json({
            error: 'تعارض في الحذف: هذه البيانات عُدِّلت أو تغيّرت بعد آخر مشاهدة — يرجى تحديث الصفحة وإعادة الحذف',
            currentVersion: cur.rows[0].version,
          });
        }
      }
    }
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
    broadcastRecordChanged({ collection: 'clients', actorUsername: req.user.username });
    res.json({ id: req.params.id, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف بيانات العميل' });
  }
});

// حذف عدة عملاء دفعة واحدة (طلب واحد) — نفس فكرة /api/records/:collection/bulk-delete، لتفادي
// إرسال عشرات/مئات طلبات DELETE منفصلة عند حذف عدد كبير من العملاء دفعة واحدة.
router.post('/api/client-records/bulk-delete', requireAuth, storageLimiter, async (req, res) => {
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
    broadcastRecordChanged({ collection: 'clients', actorUsername: req.user.username });
    res.json({ deleted: ids.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف بيانات العملاء' });
  }
});

// حذف كل سجلات العملاء دفعة واحدة — يُستخدم فقط فى "إعادة ضبط المصنع" (حذف كل بيانات البرنامج)، أدمن فقط.
router.delete('/api/client-records', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM client_records');
    broadcastRecordChanged({ collection: 'clients', actorUsername: req.user.username });
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
router.post('/api/client-records/bulk-migrate', requireAuth, storageLimiter, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 5000) return res.status(400).json({ error: 'عدد السجلات المرسلة غير صحيح (الحد الأقصى 5000 لكل طلب)' });
  // حارس سلامة البيانات: أي سجل بلا enc (أو enc=undefined من خطأ منطقي بالواجهة) يُرفض الطلب
  // بالكامل قبل لمس أي صف — كان يُخزَّن نص 'undefined' حرفياً فيفشل فك تشفيره/تحليله عند أي
  // تحميل لاحق فتختفي كل القائمة (مشكلة "اختفاء العملاء" التي ظهرت بعد استعادة النسخة).
  for (const r of records) {
    if (typeof r?.enc !== 'string' || !r.enc || r.enc === 'undefined') {
      return res.status(400).json({ error: 'بيانات مرفوعة تالفة (enc مفقود) — أُوقفت العملية قبل حفظ أي شيء. حدّث الصفحة وأعد المحاولة' });
    }
    if (typeof r?.id !== 'string' || !r.id) {
      return res.status(400).json({ error: 'بيانات مرفوعة تالفة (id مفقود) — أُوقفت العملية قبل حفظ أي شيء' });
    }
  }
  let client = null;
  try {
    client = await pool.connect();
    const newOrigin = req.user.role === 'reception' ? 'reception' : 'general';
    const newStatus = req.user.role === 'reception' ? 'pending' : 'confirmed';
    // الرفع الجماعي يتم الآن ببيان SQL واحد لكل الدفعة كاملة بدل حلقة استعلامات متتالية لكل سجل
    // (كان ~100ms للسجل الواحد على معالج الاستضافة المجانية، فدفعة 4000 سجل تتجاوز مهلة 60
    // ثانية لدى الواجهة فيفشل رفع النسخ الاحتياطية الكبيرة دائماً في المنتصف). جدولان مؤقتان
    // (المدخلات + التعارضات) ثم INSERT..SELECT واحد يعالج كل الدفعة ببضعة استعلامات إجمالاً.
    // حماية العزل حسب الدور (نفس شروط الرؤية فى clientRecordsVisibilitySql): الاستقبال يلمس
    // سجلاته الشخصية فقط، staff/accountant يلمسون السجلات المعتمدة فقط، والأدمن بلا قيود.
    // القيم تُضمَّن نصياً آمنة (الدور/اسم المستخدم من الـ JWT مع تهريب علامات الاقتباس) لأن
    // معاملات pg داخل CREATE TEMP TABLE AS SELECT مع شرط OR لا تُحدَّد أنواعها فيفشل التحليل.
    const esc = s => String(s).replace(/'/g, "''");
    const guard = req.user.role === 'reception'
      ? `('${esc(req.user.role)}' = 'reception' AND cr.origin = 'reception' AND cr.created_by = '${esc(req.user.username)}')`
      : req.user.role === 'admin'
      ? `'${esc(req.user.role)}' = 'admin'`
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
       SELECT cr.id, cr.version AS current_version, cr.enc AS current_enc
       FROM _inc i
       JOIN client_records cr ON cr.id = i.id
       WHERE cr.version <> i.known_version OR NOT (${guard})`
    );
    // إدراج/تحديث كل غير المتعارضين في بيان واحد — جديد: version 1، موجود ونسخته مطابقة: version+1.
    // حارس النسخة داخل DO UPDATE (مقارنة النسخة الحالية بـ known_version عبر _inc) يُغلق سباق
    // التحديث المتزامن: طلبان متزامنان لنفس العميل قد يمرّان معاً من فحص _conf (كلاهما يرى النسخة
    // القديمة قبل أن يُثبّت الآخر تحديثه) — بدون الحارس الثاني كان يكتب فوق الأول صامتاً. الآن
    // الثاني يفشل شرط WHERE فلا يُحدَّث ويُحتسب ضمن conflicts بدل الكتابة فوق.
    const upsertRes = await step('upsert',
      `INSERT INTO client_records (id, enc, version, updated_by, origin, status, created_by, client_id)
       SELECT i.id, i.enc, 1, $1, $2, $3, $1, i.client_id
       FROM _inc i
       WHERE NOT EXISTS (SELECT 1 FROM _conf c WHERE c.id = i.id)
       ORDER BY i.id
       ON CONFLICT (id) DO UPDATE SET
         enc = EXCLUDED.enc, version = client_records.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by, client_id = EXCLUDED.client_id
       WHERE client_records.version = (SELECT i2.known_version FROM _inc i2 WHERE i2.id = EXCLUDED.id)
       RETURNING id`,
      [req.user.username, newOrigin, newStatus]
    );
    // التعارضات النهائية = كل معرّفات الدفعة التي لم تُدرج/تُحدَّث فعلياً (رفضها _conf أو فشل
    // حارس النسخة أثناء السباق) — نحسبها من RETURNING بدل الاعتماد على _conf فقط، ونقرأ نسختها
    // الحالية الحقيقية بعد الحفظ ليردّها السيرفر للواجهة.
    const succeededIds = new Set(upsertRes.rows.map(r => r.id));
    const allIds = (await step('ids', 'SELECT id FROM _inc')).rows.map(r => r.id);
    const conflictedIds = allIds.filter(id => !succeededIds.has(id));
    let conflictRows = [];
    if (conflictedIds.length) {
      const cr = await step('conf-final', 'SELECT id, version, enc FROM client_records WHERE id = ANY($1::text[])', [conflictedIds]);
      conflictRows = cr.rows.map(r => ({ id: r.id, current_version: r.version, current_enc: r.enc }));
    }
    const migrated = records.length - conflictRows.length;
    await client.query('COMMIT');
    res.json({ migrated, conflicts: conflictRows.map(r => ({ id: r.id, currentVersion: r.current_version, currentEnc: r.current_enc })) });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'تعذّر ترحيل السجلات' });
  } finally {
    if (client) client.release();
  }
});

// GET /api/storage-versions -> { versions: { key: version } } لكل المفاتيح دفعة واحدة، بدل طلب
// منفصل بالنسخة الحالية لكل مفتاح (كان يعني اتصالاً بالسيرفر لكل مفتاح في كل فتحة للبرنامج).
// تستخدمها الواجهة عند فتح البرنامج للمقارنة السريعة بين النسخة المخزّنة محلياً على الجهاز ونسخة
// السحابة: لو كل الأرقام متطابقة، لا يوجد أي نقل بيانات إضافي (البرنامج يعمل بالفعل من أحدث نسخة
// محفوظة محلياً). لو اختلف رقم مفتاح أو أكثر، الواجهة تجلب القيمة الكاملة لتلك المفاتيح فقط
// عبر GET /api/storage/:key كالمعتاد — بدل تحميل كل البيانات من جديد في كل مرة.
router.get('/api/storage-versions', requireAuth, async (req, res) => {
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
  'followUpTasks',
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

router.get('/api/records/pending', requireAuth, async (req, res) => {
  // كل سجلات الاستقبال المعلّقة (pending) من كل التصنيفات دفعة واحدة — للأدمن فقط، تُستخدم في
  // لوحة التحكم: شاشة "قيد الاعتماد" + عداد الإشعار. الـ enc يمر كما هو (السيرفر لا يملك المفتاح
  // ولا يفك تشفيراً أبداً) ويعرضه المتصفح.
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'غير متاح لهذا الدور' });
  try {
    const r = await pool.query(
      `SELECT collection, id, enc, version, origin, status, created_by, updated_by, updated_at
       FROM collection_records
       WHERE origin = 'reception' AND status = 'pending'
       ORDER BY updated_at DESC`
    );
    res.json({ records: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب العمليات المعلّقة' });
  }
});

router.get('/api/records/:collection', requireAuth, requireValidCollection, async (req, res) => {
  try {
    // فلترة عزل الاستقبال على مستوى السيرفر (نفس clientRecordsVisibilitySql): لا يمكن لأي دور
    // رؤية سجلات لا تخصه حتى عبر طلب مباشر، والسجلات المعلّقة لا تظهر لغير صاحبها/الأدمن.
    const vis = recordsVisibilitySql(req.user.role, req.user.username);
    // ترقيم اختياري (page/pageSize) لمنع القراءات غير المقيدة دون كسر المزامنة: الافتراضي
    // (بدون page) يعيد كل السجلات كما كان.
    const page = parseInt(req.query.page, 10);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 200));
    let sql = `SELECT id, enc, version, origin, status FROM collection_records WHERE collection = $1 ${vis.where}`;
    const sqlParams = [req.params.collection, ...vis.params];
    if (Number.isInteger(page) && page >= 1) {
      sql += ` ORDER BY version ASC, id ASC LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}`;
      sqlParams.push(pageSize, (page - 1) * pageSize);
    }
    // جلب الفروق فقط (delta): لو المُستدعي أرسل ids= (قائمة ids مفصولة بفواصل) نرجع هذه السجلات
    // فقط بدل الجدول كامل — تستخدمه المزامنة لجلب السجلات المتغيّرة/الجديدة. معاملة `id = ANY`
    // تحترم فلترة الرؤية أعلاه (أي id لا يحق للمستخدم رؤيته يُستبعد تلقائياً).
    const idsParam = req.query.ids;
    if (typeof idsParam === 'string' && idsParam.length) {
      const idList = idsParam.split(',').map(s => s && s.trim()).filter(Boolean);
      if (idList.length) {
        sql += ` AND id = ANY($${sqlParams.length + 1}::text[])`;
        sqlParams.push(idList);
      }
    }
    const r = await pool.query(sql, sqlParams);
    res.json({ records: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب البيانات' });
  }
});

// أرقام إصدارات كل سجل على حدة (طلب خفيف بدون بيانات فعلية) — تستخدمه المزامنة الجديدة لجلب
// "الفروق فقط" بدل تنزيل التصنيف كاملاً: يُقارن بها الكلاينت أرقامه المحلية فيطلب لاحقاً عبر
// GET /api/records/:collection?ids= السجلات المتغيّرة/الجديدة فقط. يحترم فلترة الرؤية نفسها.
router.get('/api/records/:collection/versions', requireAuth, requireValidCollection, async (req, res) => {
  try {
    const vis = recordsVisibilitySql(req.user.role, req.user.username);
    const sql = `SELECT id, version FROM collection_records WHERE collection = $1 ${vis.where}`;
    const params = [req.params.collection, ...vis.params];
    const r = await pool.query(sql, params);
    res.json({ pairs: r.rows.map(row => [row.id, Number(row.version)]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب أرقام الإصدارات' });
  }
});

// رقم إصدار مجمّع لكل التصنيفات دفعة واحدة (طلب واحد خفيف بدون نقل بيانات فعلية) — لنفس فكرة
// /api/storage-versions، تستخدمه المزامنة الدورية الخلفية للتحقق السريع من وجود تعديلات جديدة.
router.get('/api/records-versions', requireAuth, async (req, res) => {
  try {
    // نفس فلترة الرؤية الخاصة بـ GET /api/records/:collection بالضبط (راجع recordsVisibilitySql)،
    // وإلا يظهر للمستخدم إشعار "يوجد تحديث" عن سجلات لا يحق له رؤيتها أصلاً، وتدخل المزامنة
    // الدورية في حلقة إعادة جلب لا نهائية (عدد/مجموع السيرفر لا يطابقان ما يراه هذا المستخدم).
    let sql = 'SELECT collection, COALESCE(SUM(version),0)::bigint AS v, COUNT(*)::int AS c FROM collection_records';
    const params = [];
    if (req.user.role === 'reception') {
      sql += ' WHERE origin = $1 AND created_by = $2';
      params.push('reception', req.user.username);
    } else if (req.user.role !== 'admin') {
      sql += ' WHERE status = $1';
      params.push('confirmed');
    }
    sql += ' GROUP BY collection';
    const r = await pool.query(sql, params);
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

router.put('/api/records/:collection/:id', requireAuth, storageLimiter, requireValidCollection, async (req, res) => {
  const { enc } = req.body || {};
  if (typeof enc !== 'string' || !enc) return res.status(400).json({ error: 'بيانات غير صحيحة' });
  const knownVersion = Number.isInteger(req.body?.version) ? req.body.version : 0;
  try {
    // حماية عزل بيانات الاستقبال في السجلات العامة (نفس منطق /api/client-records/:id حرفياً):
    // كل مستخدم استقبال يلمس فقط سجلاته (origin='reception' AND created_by = هو نفسه) — معزول
    // حتى عن بقية مستخدمي الاستقبال، وأي دور آخر (staff/accountant) يعدّل السجلات المعتمدة
    // status='confirmed' فقط — فلا يمكن عبر طلب مباشر بمعرّف معروف لمس مسودات/سجلات استقبال
    // معلّقة لا يملك رؤيتها أصلاً. الأدمن بلا قيود كما كان دائماً.
    if (req.user.role === 'reception') {
      const existing = await pool.query(
        'SELECT origin, created_by FROM collection_records WHERE collection = $1 AND id = $2',
        [req.params.collection, req.params.id]
      );
      if (existing.rows[0] && (existing.rows[0].origin !== 'reception' || existing.rows[0].created_by !== req.user.username)) {
        return res.status(403).json({ error: 'ليست لديك صلاحية تعديل هذه البيانات' });
      }
    } else if (req.user.role !== 'admin') {
      const existing = await pool.query(
        'SELECT status FROM collection_records WHERE collection = $1 AND id = $2',
        [req.params.collection, req.params.id]
      );
      if (existing.rows[0] && existing.rows[0].status !== 'confirmed') {
        return res.status(403).json({ error: 'ليست لديك صلاحية تعديل هذه البيانات' });
      }
    }
    // السجلات التي يسجّلها الاستقبال في التصنيفات التشغيلية تبدأ معلّقة (pending) بانتظار
    // اعتماد الأدمن. origin/status يُثبَّتان عند الإنشاء فقط ولا يتغيّران عند التعديل (نفس نمط
    // client_records): تعديل الاستقبال لسجل معتمد خاص به يبقيه معتمداً — "عند تسجيل عملية جديدة
    // فقط" يحتاج اعتماداً كما طلب المستخدم.
    const gated = APPROVAL_GATED_COLLECTIONS.includes(req.params.collection);
    const newOrigin = req.user.role === 'reception' ? 'reception' : 'general';
    const newStatus = (req.user.role === 'reception' && gated) ? 'pending' : 'confirmed';
    const upsert = await pool.query(
      `INSERT INTO collection_records (collection, id, enc, version, updated_by, origin, status, created_by)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $4)
       ON CONFLICT (collection, id) DO UPDATE SET
         enc = EXCLUDED.enc, version = collection_records.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       WHERE collection_records.version = $7
       RETURNING version, origin, status`,
      [req.params.collection, req.params.id, enc, req.user.username, newOrigin, newStatus, knownVersion]
    );
    if (upsert.rows[0]) {
      broadcastRecordChanged({ collection: req.params.collection, actorUsername: req.user.username });
      return res.json({ id: req.params.id, version: upsert.rows[0].version, origin: upsert.rows[0].origin, status: upsert.rows[0].status });
    }
    const current = await pool.query('SELECT version, enc FROM collection_records WHERE collection = $1 AND id = $2', [req.params.collection, req.params.id]);
    return res.status(409).json({
      error: 'تعارض: تم تعديل هذه البيانات من جهاز آخر بعد آخر تحديث لديك. يرجى تحديث الصفحة وإعادة تنفيذ العملية.',
      currentVersion: current.rows[0] ? current.rows[0].version : 0,
      currentEnc: current.rows[0] ? current.rows[0].enc : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر الحفظ' });
  }
});

router.delete('/api/records/:collection/:id', requireAuth, storageLimiter, requireValidCollection, async (req, res) => {
  try {
    // حارس حذف بفحص النسخة: الواجهة ترسل رقم النسخة الذي رآه الجهاز (version في query). لو تغيّر
    // السجل على السيرفر من جهاز آخر بعد آخر مشاهدة لهذا الجهاز، نرفض الحذف بـ409 بدل حذف بيانات
    // أحدث بصمت (نفس منطق تعارضات PUT). غياب المعامل = طلبات قديمة تتصرف كما كانت من قبل.
    const wantVersionRaw = req.query.version;
    if (wantVersionRaw !== undefined && wantVersionRaw !== ''){
      const wantVersion = Number(wantVersionRaw);
      if (Number.isFinite(wantVersion)){
        const cur = await pool.query(
          'SELECT version FROM collection_records WHERE collection = $1 AND id = $2',
          [req.params.collection, req.params.id]
        );
        if (cur.rows[0] && cur.rows[0].version !== wantVersion){
          return res.status(409).json({
            error: 'تعارض في الحذف: هذه البيانات عُدِّلت أو تغيّرت بعد آخر مشاهدة — يرجى تحديث الصفحة وإعادة الحذف',
            currentVersion: cur.rows[0].version,
          });
        }
      }
    }
    // نفس حماية عزل الاستقبال في مسار الحذف (كان الحذف بلا أي فحص — أي مستخدم مصادق يقدر
    // يحذف أي سجل يعرف معرّفه): الاستقبال يحذف سجلاته هو فقط، staff/accountant يحذفون
    // المعتمد فقط، والأدمن بلا قيود.
    if (req.user.role === 'reception') {
      await pool.query(
        'DELETE FROM collection_records WHERE collection = $1 AND id = $2 AND origin = $3 AND created_by = $4',
        [req.params.collection, req.params.id, 'reception', req.user.username]
      );
    } else if (req.user.role === 'admin') {
      await pool.query('DELETE FROM collection_records WHERE collection = $1 AND id = $2', [req.params.collection, req.params.id]);
    } else {
      await pool.query(
        'DELETE FROM collection_records WHERE collection = $1 AND id = $2 AND status = $3',
        [req.params.collection, req.params.id, 'confirmed']
      );
    }
    broadcastRecordChanged({ collection: req.params.collection, actorUsername: req.user.username });
    res.json({ id: req.params.id, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر الحذف' });
  }
});

// اعتماد سجل عام سجّله الاستقبال (pending -> confirmed): للأدمن فقط. لا يحتاج فك أي تشفير —
// enc يبقى كما هو تماماً (السيرفر لا يملك المفتاح)، فقط عمود status يتغيّر، فيصبح السجل ظاهراً
// فوراً لكل الأدوار الأخرى (staff/accountant) وداخلاً في مزامناتهم وحساباتهم، مع بقاء
// origin='reception' كسجل تاريخي فقط لمن سجّله أصلاً.
router.post('/api/records/:collection/:id/approve', requireAuth, requireRole('admin'), requireValidCollection, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE collection_records SET status = 'confirmed', version = version + 1, updated_at = now()
       WHERE collection = $1 AND id = $2 AND origin = 'reception' AND status = 'pending'
       RETURNING id, version`,
      [req.params.collection, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'لا يوجد سجل معلّق بهذا المعرّف بانتظار الاعتماد' });
    broadcastRecordChanged({ collection: req.params.collection, actorUsername: req.user.username });
    res.json({ id: r.rows[0].id, version: r.rows[0].version, status: 'confirmed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر اعتماد السجل' });
  }
});

// نقطة رفع مُجمَّع: تُستخدم للترحيل لمرة واحدة من التخزين القديم (كتلة واحدة) إلى النظام الجديد،
// وللعمليات الضخمة دفعة واحدة (استيراد شامل) — حتى 1000 سجل فى الطلب الواحد.
// فحص تعارض لكل سجل على حدة (بنفس منطق /api/records/:collection/:id تماماً): كل سجل يحمل version
// المعروفة لدى المرسل قبل هذا الرفع (0 لسجل جديد). لو تغيّر السجل فعلياً على السيرفر من جهاز/مستخدم
// آخر أثناء نفس العملية، يُتجاهَل هذا السجل تحديداً بدل الكتابة فوقه صامتاً، ويُرجَع ضمن conflicts.
router.post('/api/records/:collection/bulk-migrate', requireAuth, storageLimiter, requireValidCollection, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 5000) return res.status(400).json({ error: 'عدد السجلات المرسلة غير صحيح (الحد الأقصى 5000 لكل طلب)' });
  // نفس حارس سلامة البيانات الخاص بـ client-records/bulk-migrate: رفض أي سجل بلا enc/id قبل
  // لمس أي صف، حتى لا يُخزَّن نص 'undefined' فيختفي التصنيف كله عند أي تحميل لاحق.
  for (const r of records) {
    if (typeof r?.enc !== 'string' || !r.enc || r.enc === 'undefined') {
      return res.status(400).json({ error: 'بيانات مرفوعة تالفة (enc مفقود) — أُوقفت العملية قبل حفظ أي شيء. حدّث الصفحة وأعد المحاولة' });
    }
    if (typeof r?.id !== 'string' || !r.id) {
      return res.status(400).json({ error: 'بيانات مرفوعة تالفة (id مفقود) — أُوقفت العملية قبل حفظ أي شيء' });
    }
  }
  let client = null;
  try {
    client = await pool.connect();
    // الرفع الجماعي يتم الآن ببيان SQL واحد لكل الدفعة كاملة بدل حلقة استعلامات متتالية لكل سجل
    // (كان ~100ms للسجل الواحد على معالج الاستضافة المجانية، فدفعة 4000 سجل تتجاوز مهلة 60
    // ثانية لدى الواجهة فيفشل رفع النسخ الاحتياطية الكبيرة دائماً في المنتصف). جدولان مؤقتان
    // (المدخلات + التعارضات) ثم INSERT..SELECT واحد يعالج كل الدفعة ببضعة استعلامات إجمالاً.
    // السجلات المرفوعة من الاستقبال في التصنيفات التشغيلية تبدأ معلّقة (نفس منطق PUT الفردي)،
    // مع حماية العزل حسب الدور في التعارضات (نفس guard الخاص بـ client-records/bulk-migrate):
    // الاستقبال يلمس سجلاته الشخصية فقط، staff/accountant يلمسون المعتمد فقط، والأدمن بلا قيود.
    const gated = APPROVAL_GATED_COLLECTIONS.includes(req.params.collection);
    const newOrigin = req.user.role === 'reception' ? 'reception' : 'general';
    const newStatus = (req.user.role === 'reception' && gated) ? 'pending' : 'confirmed';
    const esc = s => String(s).replace(/'/g, "''");
    const guard = req.user.role === 'reception'
      ? `('${esc(req.user.role)}' = 'reception' AND cr.origin = 'reception' AND cr.created_by = '${esc(req.user.username)}')`
      : req.user.role === 'admin'
      ? `'${esc(req.user.role)}' = 'admin'`
      : `cr.status = 'confirmed'`;
    const payload = JSON.stringify(records.map(r => ({ id: String(r.id), enc: String(r.enc), version: Number.isInteger(r.version) ? r.version : 0 })));
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE _inc ON COMMIT DROP AS
       SELECT (t->>'id')::text AS id, (t->>'enc')::text AS enc, COALESCE((t->>'version')::int, 0) AS known_version
       FROM jsonb_array_elements($1::jsonb) AS t`,
      [payload]
    );
    // التعارضات = الصفوف الموجودة فعلاً التي تختلف نسختها عن المعروفة، أو يرفضها حارس العزل حسب الدور
    await client.query(
      `CREATE TEMP TABLE _conf ON COMMIT DROP AS
       SELECT cr.id, cr.version AS current_version, cr.enc AS current_enc
       FROM _inc i
       JOIN collection_records cr ON cr.collection = $1 AND cr.id = i.id
       WHERE cr.version <> i.known_version OR NOT (${guard})`,
      [req.params.collection]
    );
    // إدراج/تحديث كل غير المتعارضين في بيان واحد — جديد: version 1، موجود ونسخته مطابقة: version+1.
    // حارس النسخة داخل DO UPDATE (مقارنة النسخة الحالية بـ known_version عبر _inc) يُغلق سباق
    // التحديث المتزامن: طلبان متزامنان لنفس السجل قد يمرّان معاً من فحص _conf (كلاهما يرى النسخة
    // القديمة قبل أن يُثبّت الآخر تحديثه) — بدون الحارس الثاني كان يكتب فوق الأول صامتاً. الآن
    // الثاني يفشل شرط WHERE فلا يُحدَّث ويُحتسب ضمن conflicts بدل الكتابة فوق.
    const upsertRes = await client.query(
      `INSERT INTO collection_records (collection, id, enc, version, updated_by, origin, status, created_by)
       SELECT $1, i.id, i.enc, 1, $2, $3, $4, $2
       FROM _inc i
       WHERE NOT EXISTS (SELECT 1 FROM _conf c WHERE c.id = i.id)
       ORDER BY i.id
       ON CONFLICT (collection, id) DO UPDATE SET
         enc = EXCLUDED.enc, version = collection_records.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       WHERE collection_records.version = (SELECT i2.known_version FROM _inc i2 WHERE i2.id = EXCLUDED.id)
       RETURNING id`,
      [req.params.collection, req.user.username, newOrigin, newStatus]
    );
    // التعارضات النهائية = كل معرّفات الدفعة التي لم تُدرج/تُحدَّث فعلياً (رفضها _conf أو فشل
    // حارس النسخة أثناء السباق) — نحسبها من RETURNING بدل الاعتماد على _conf فقط، ونقرأ نسختها
    // الحالية الحقيقية بعد الحفظ ليردّها السيرفر للواجهة.
    const succeededIds = new Set(upsertRes.rows.map(r => r.id));
    const allIds = (await client.query('SELECT id FROM _inc')).rows.map(r => r.id);
    const conflictedIds = allIds.filter(id => !succeededIds.has(id));
    let conflictRows = [];
    if (conflictedIds.length) {
      const cr = await client.query(
        'SELECT id, version, enc FROM collection_records WHERE collection = $1 AND id = ANY($2::text[])',
        [req.params.collection, conflictedIds]
      );
      conflictRows = cr.rows.map(r => ({ id: r.id, current_version: r.version, current_enc: r.enc }));
    }
    const migrated = records.length - conflictRows.length;
    await client.query('COMMIT');
    if (migrated > 0) broadcastRecordChanged({ collection: req.params.collection, actorUsername: req.user.username });
    res.json({ migrated, conflicts: conflictRows.map(r => ({ id: r.id, currentVersion: r.current_version, currentEnc: r.current_enc })) });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'تعذّر ترحيل السجلات' });
  } finally {
    if (client) client.release();
  }
});

// حذف عدة سجلات محدَّدة بالـ id دفعة واحدة (طلب واحد بدل طلب DELETE منفصل لكل سجل) — يُستخدم عند
// حذف عدد كبير من السجلات دفعة واحدة (مثال: تنظيف مخزون الشكاير) لتفادي ضرب سقف rate limiter
// (storageLimiter) بإرسال عشرات/مئات طلبات DELETE متتالية فى ثوانٍ.
router.post('/api/records/:collection/bulk-delete', requireAuth, storageLimiter, requireValidCollection, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length || ids.length > 1000) return res.status(400).json({ error: 'عدد السجلات غير صحيح (الحد الأقصى 1000 لكل طلب)' });
  try {
    // نفس حماية عزل الاستقبال في الحذف الفردي (كان الحذف المجمّع بلا أي فحص ملكية إطلاقاً):
    // الاستقبال يحذف سجلاته هو فقط، staff/accountant يحذفون المعتمد فقط، والأدمن بلا قيود.
    if (req.user.role === 'reception') {
      await pool.query(
        'DELETE FROM collection_records WHERE collection = $1 AND id = ANY($2::text[]) AND origin = $3 AND created_by = $4',
        [req.params.collection, ids, 'reception', req.user.username]
      );
    } else if (req.user.role === 'admin') {
      await pool.query('DELETE FROM collection_records WHERE collection = $1 AND id = ANY($2::text[])', [req.params.collection, ids]);
    } else {
      await pool.query(
        'DELETE FROM collection_records WHERE collection = $1 AND id = ANY($2::text[]) AND status = $3',
        [req.params.collection, ids, 'confirmed']
      );
    }
    broadcastRecordChanged({ collection: req.params.collection, actorUsername: req.user.username });
    res.json({ deleted: ids.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف السجلات' });
  }
});

// حذف كل سجلات تصنيف معيّن دفعة واحدة — يُستخدم فقط فى "إعادة ضبط المصنع" (حذف كل بيانات البرنامج)، أدمن فقط.
router.delete('/api/records/:collection', requireAuth, requireRole('admin'), requireValidCollection, async (req, res) => {
  try {
    await pool.query('DELETE FROM collection_records WHERE collection = $1', [req.params.collection]);
    broadcastRecordChanged({ collection: req.params.collection, actorUsername: req.user.username });
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف البيانات' });
  }
});

// auditLog وdeletedVaultTx وdeletedInvoices تتراكم بلا حد أقصى بمرور الوقت (سجل تاريخي، وليس بيانات
// تشغيلية حالية). لا يوجد حذف تلقائي مجدوَل عمداً — القرار يُترك للأدمن صراحةً فى كل مرة، خصوصاً أن
// deletedInvoices يخضع لالتزام الاحتفاظ بسجلات الفواتير 6 سنوات على الأقل بموجب لوائح ضريبة القيمة
// المضافة/ZATCA فى السعودية؛ لا يجوز حذفها تلقائياً بفترة قصيرة دون مراجعة الأدمن لهذا تحديداً.
const PRUNABLE_COLLECTIONS = ['auditLog', 'deletedVaultTx', 'deletedInvoices'];
router.post('/api/records/:collection/prune', requireAuth, storageLimiter, requireRole('admin'), async (req, res) => {
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
router.get('/api/records/:collection/prune-preview', requireAuth, requireRole('admin'), async (req, res) => {
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

module.exports = {
  router,
  syncClientsRows,
  queueSyncClientsRows,
};
