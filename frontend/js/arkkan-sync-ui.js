/* ============================================================
   arkkan-sync-ui.js — واجهة مزامنة بيانات أركان داخل البرنامج
   ------------------------------------------------------------
   يتواصل مع "وكيل أركان المحلي" (arkkan-agent.js) الذي يعمل على
   جهاز المستخدم في http://localhost:9955 عبر Playwright —
   منفصل تماماً عن سيرفر Render (الذي لم يعد يشغّل متصفحاً مخفياً
   أصلاً، حفاظاً على ذاكرة الخادم). من هنا يُتحكم في تشغيل الوكيل
   وإضافته لبدء التشغيل مع ويندوز.
   ============================================================ */

/* عنوان الوكيل المحلي لمزامنة أركان — لا تغيّره إلا لو شغّلت الوكيل
   على منفذ مختلف عبر متغيّر ARKKAN_AGENT_PORT. */
const ARKKAN_API_BASE = 'http://localhost:9955';

/* ── الحقول التي نجلبها من أركان (حقول "كارت العميل") ──
   نعرض في مزامنة أركان فقط العملاء الناقص فيهم أي حقل من هذه السبعة. */
const ARKKAN_FIELDS = ['invoice','courseNumber','date','coursePrice','bagInvoice','bagPurchaseDate','startDate'];
const ARKKAN_FIELD_LABELS = {
  invoice:      'رقم الفاتورة',
  courseNumber: 'رقم الدورة',
  date:         'تاريخ الفاتورة',
  coursePrice:  'قيمة الفاتورة',
  bagInvoice:   'رقم إيصال الحقيبة',
  bagPurchaseDate: 'تاريخ الحقيبة',
  startDate:    'تاريخ الدورة',
  endDate:      'تاريخ انتهاء الدورة',
  validityEndDate: 'صلاحية التدريب / الحقيبة'
};

/* هل نعمل داخل تطبيق سطح المكتب (Electron يخدم الواجهة من 127.0.0.1)؟
   نستخدمه لتقرير إمكانية تشغيل الوكيل من داخل البرنامج مباشرة. */
const ARKKAN_IS_DESKTOP = /^127\.0\.0\.1$/.test(location.hostname) || /^localhost$/.test(location.hostname);

/* ── العميل «الحيّ» من مصفوفة clients ──
   مصفوفة clients تُستبدَل بالكامل عند أي مزامنة خلفية/إشعار SSE (loadData)، وهي
   تحدث كثيراً (كل حفظ من أي جهاز/تبويب يُطلق إشعاراً). فأي كائن عميل مأخوذ قبل
   انتظار شبكة طويل (جلب أركان قد يستغرق ثواني طويلة) يصبح نسخة منفصلة عن الشاشة:
   الكتابة عليه لا تظهر في الجدول ولا في الكرت ولا في اللقطة المحلية، فيبدو أن
   العملية «نجحت» بينما الحقل (مثل الرقم المرجعي) ما زال فارغاً — ويحتاج المستخدم
   لإعادة العملية أكثر من مرة. لذلك: بعد أي await نعيد جلب الكائن الحيّ بهذه
   الدالة قبل تعديل بيانات العميل، ولا نعدّل الكائن القديم أبداً. */
function arkkanLiveClient(id, clientId) {
  if (!Array.isArray(clients)) return null;
  if (id) {
    const byId = clients.find(x => x && x.id === id);
    if (byId) return byId;
  }
  if (clientId) {
    const cid = String(clientId);
    const byClientId = clients.find(x => x && String(x.clientId) === cid);
    if (byClientId) return byClientId;
  }
  return null;
}

/* يثبّت رقماً مرجعياً مؤكداً (نجح حفظه فعلاً على الخادم) على الكائن الحيّ —
   حتى لو استُبدلت مصفوفة clients أثناء الانتظار — ويحدّث نسخة baseline الخاصة
   به فقط لو كانت موجودة، بلا أي رفع إضافي. */
function arkkanPinRefNum(id, clientId, refNum) {
  const live = arkkanLiveClient(id, clientId);
  if (!live) return null;
  const val = String(refNum || '').trim();
  if (val && String(live.referNum || '').trim() !== val) live.referNum = val;
  if (val && typeof _clientsSyncBaseline === 'object' && _clientsSyncBaseline instanceof Map) {
    const bp = _clientsSyncBaseline.get(live.id);
    if (bp) {
      try {
        const obj = JSON.parse(bp);
        if (String(obj.referNum || '').trim() !== val) {
          obj.referNum = val;
          _clientsSyncBaseline.set(live.id, JSON.stringify(obj));
        }
      } catch (e) { /* baseline غير قابل للقراءة — لا نلمسه */ }
    }
  }
  return live;
}

/* تاريخ الدورة من تبويب الدورات: تاريخ الجلسة المسجّلة بنفس رقم الدورة،
   أو تاريخ الدورة المتوقعة المسجّل على العميل — حتى لا يظهر العميل
   ناقص "تاريخ الدورة" رغم أن جدول الدورات يعرفه. */
function arkkanCourseDate(c){
  if (Array.isArray(courseSessions)) {
    const s = courseSessions.find(x => x.courseNumber === c.courseNumber && x.date);
    if (s && s.date) return s.date; // بصيغة YYYY-MM-DD
  }
  return c.expectedCourseDate || '';
}

/* تاريخ صالح بصيغة ISO فقط (YYYY-MM-DD) — أي قيمة أخرى (فاضية أو نص تالف من استيراد
   قديم أو صيغة غير قياسية) تُعتبر غير صالحة، حتى لو كانت "موجودة" تقنياً كسلسلة نصية.
   بدونها: قيمة تالفة تُخفي العميل من صندوق المزامنة (لأنها "موجودة") بينما تظهر فاضية
   فعلياً في حقل <input type="date"> بشيت فواتير الدورات (المتصفح يرفض أي صيغة غير ISO). */
function isValidIsoDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()); }

function arkkanFieldMissing(c, f) {
  if (f === 'startDate') return !(c.startDate || arkkanCourseDate(c));
  if (f === 'date') return !isValidIsoDate(c.receiptIssueDate); // تاريخ الفاتورة يأتي حصراً من شيت فواتير الدورات (receiptIssueDate) لا من شيت العملاء
  if (f === 'coursePrice') return !(Number(c.receiptActualValue) > 0); // العمود "قيمة الفاتورة" يعرض القيمة الفعلية بالإيصال (شيت فواتير الدورات)، وليس سعر الدورة المسجَّل بالنظام — فالنقص يُقاس بها حصراً
  const v = c[f];
  if (v === undefined || v === null || v === '') return true;
  return false;
}
function arkkanMissingFields(c) {
  return ARKKAN_FIELDS.filter(f => arkkanFieldMissing(c, f));
}
function clientIsMissingArkkanData(c) {
  return arkkanMissingFields(c).length > 0;
}

/* العميل يُعالج في مزامنة أركان لو عنده رقم مرجعي — أما جلب الرقم المرجعي فيتم
   منفصلاً بزر مستقل في شريط التحديد الجماعي بشيت العملاء (بحث برقم الهوية). */
function clientEligibleForArkkan(c) {
  return !!(c.clientId && String(c.referNum || '').trim());
}

/* شرط جلب نتائج الاختبارات: زي شرط أركان العادي + لازم يكون عنده رقم دورة،
   لأن أركان بتربط نتيجة الاختبار برقم الدورة ولا يمكن جلبها بدونه */
function clientEligibleForArkkanExams(c) {
  return clientEligibleForArkkan(c) && !!String(c.courseNumber || '').trim();
}

/* تاريخ أركان (2026/07/21 أو 21/07/2026) → صيغة input type=date (2026-07-21).
   يحوّل أي صيغة واردة من أركان إلى YYYY-MM-DD القياسية — وبدونها يظهر حقل
   "تاريخ صدور الفاتورة" (input type=date) فارغاً رغم وجود قيمة. */
function arkkanToInputDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return ''; // صيغة غير معروفة — لا نُخزِّن نصاً مرفوضاً يظهر الحقل فارغاً
}

async function arkkanCheckReady() {
  try {
    const r = await fetch(ARKKAN_API_BASE + '/api/arkkan/status', {
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch { return { ready: false, playwrightInstalled: false }; }
}

async function arkkanFetchOne(clientId, referNum = '') {
  await arkkanEnsureAgentReady();
  const r = await fetch(ARKKAN_API_BASE + '/api/arkkan/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, referNum }),
    signal: AbortSignal.timeout(95000)
  });
  if (!r.ok) {
    let msg = 'فشل الوكيل المحلي (' + r.status + ')';
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/* ══════════════════════════════════════════════
   1) جلب بيانات العميل من أركان + حفظ تلقائي
   يُستدعى من زرار "جلب من أركان" في كرت العميل (ملف العميل)
   — بلا فتح نموذج التعديل: يجلب الناقص ويحفظه في البيانات فوراً.
   ══════════════════════════════════════════════ */

/* تحويل قيمة مالية قادمة من أركان إلى رقم نظيف */
function arkkanNumPrice(v){ return parseFloat(String(v).replace(/[^\d.,]/g, '').replace(',', '')) || v; }

/* يبني التصحيح من بيانات أركان إلى العميل — يملأ الحقول الناقصة فقط.
   لا يمس أياً من التواريخ (تاريخ التسجيل/الفاتورة/الدورة/الحقيبة) ولا
   المبالغ المسجّلة (المدفوع الفعلي في الكرت / قيمة الإيصال الفعلية).
   الحقول المُلئّة: رقم الفاتورة، رقم الدورة، قيمة الفاتورة، رقم إيصال الحقيبة. */
function arkkanPatchFromData(c, data){
  const patch = {};
  if (!c.invoice && data.invoice) patch.invoice = data.invoice;
  if (!c.courseNumber && data.courseNumber) patch.courseNumber = data.courseNumber;
  if (!c.bagInvoice && data.bagInvoice) patch.bagInvoice = data.bagInvoice;
  // تاريخ الحقيبة يُملأ فقط لو كان فاضياً — لا يمس أي تاريخ مسجّل مسبقاً
  if (!c.bagPurchaseDate && data.bagPurchaseDate) patch.bagPurchaseDate = arkkanToInputDate(data.bagPurchaseDate);
  // قيمة الفاتورة: تُسجَّل حصراً في receiptActualValue (شيت فواتير الدورات) — لأن هذا هو
  // الغرض منه أصلاً: مقارنته بـ centerIncome (coursePrice - discount) لاكتشاف أي فرق بين
  // المسجَّل بالنظام والمكتوب فعلياً بالإيصال (راجع فلتر "مطابق/مختلف" فى module-invoices.js).
  // coursePrice (سعر الدورة فى شيت العملاء، الذي يُحسب عليه "الإجمالي" و"المتبقي") لا يُكتب
  // من أركان إطلاقاً — لا فوق قيمة موجودة ولا عند كونها صفراً — حتى لا تتغيّر قيمة الدورة
  // أو إجمالي/متبقي العميل صامتاً عند مجرد الجلب.
  if (data.coursePrice) {
    patch.receiptActualValue = arkkanNumPrice(data.coursePrice);
  }
  // تاريخ إصدار الفاتورة (data.date = Invoice Date من أركان) — يُعبّي "تاريخ الفاتورة"
  // في شيت فواتير الدورات (receiptIssueDate) تحديداً، وهو مصدر عمود المزامنة الوحيد
  // (لا نقرأ من شيت العملاء c.date). كان يُملأ فقط لو كان الحقل فارغاً (شرط
  // !c.receiptIssueDate)، فكان أي تاريخ سابق محلّلاً/قديم/غير صحيح يمنع التحديث بعناد
  // فلا تُخزَّن القيمة الصحيحة القادمة من أركان أبداً — لكن باقي مسارات الكتابة
  // (الشيت اليدوي، استيراد ملف، مسار الدورات) تحدِّث هذا الحقل بحرية دون أي تمييز بين
  // "يدوي" و"آلي". لاتساق السلوك، يُحدَّث دائماً من أركان طالما جاء تاريخ صالح:
  // نُطيّع التاريخ (arkkanToInputDate) إلى YYYY-MM-DD وفقط لو خرج تاريخاً صالحاً
  // (isValidIsoDate) نُخزّنه — وإلا لا نمسه، فلا يُخزَّن نص مرفوض يظهر الحقل
  // فارغاً في شيت فواتير الدورات (input type=date). c.date (تاريخ التسجيل/الاستيراد)
  // يبقى كما هو دون تغيير.
  if (data.date) {
    const normDate = arkkanToInputDate(data.date);
    if (normDate && isValidIsoDate(normDate)) patch.receiptIssueDate = normDate;
  }
  // تاريخ الدورة: نستعمل تاريخ بداية الدورة من أركان (data.startDate) أولاً؛
  // ولو غير متاح نرجّع للتاريخ المحلي (جدول الدورات / expectedCourseDate).
  if (!c.startDate) {
    const sd = data.startDate || arkkanCourseDate(c);
    if (sd) patch.startDate = arkkanToInputDate(sd);
  }
  // تاريخ انتهاء الدورة: يُملأ فقط لو كان فاضياً — لا يمس أي قيمة مسجّلة مسبقاً.
  if (!c.endDate && data.endDate) {
    const ed = arkkanToInputDate(data.endDate);
    if (ed && isValidIsoDate(ed)) patch.endDate = ed;
  }
  // صلاحية التدريب / الحقيبة: تُحفظ فقط لو أعادها أركان صريحة وكانت خانتها فاضية.
  if (!c.validityEndDate && data.validityDate) {
    const vd = arkkanToInputDate(data.validityDate);
    if (vd && isValidIsoDate(vd)) patch.validityEndDate = vd;
  }
  return patch;
}

/* ══════════════════════════════════════════════
   1-ب) نسخة "المقارنة الكاملة" — خاصة بزر "جلب من أركان" فى كارت العميل فقط.
   بعكس arkkanPatchFromData (تملأ الحقول الناقصة فقط، وتُستخدم فى صندوق
   المزامنة الجماعي وزر الصف المفرد بالشيت)، هذه النسخة تقارن كل حقل حتى لو
   الكارت "مكتمل" ظاهرياً — وأي فرق حقيقي بين المسجَّل بالنظام وما هو مسجَّل
   فى أركان يُستبدل تلقائياً بقيمة أركان. النطاق مقصور على ضغطة واعية من
   المستخدم على كارت عميل واحد بالذات — صندوق المزامنة الجماعي التلقائي يبقى
   بسلوكه القديم (ملء الناقص فقط) تفادياً لإفساد إجمالي/متبقي العملاء صامتاً
   فى كل مزامنة جماعية (نفس السبب الموثَّق أعلى فى arkkanPatchFromData بخصوص
   coursePrice). */
function arkkanDiffFromData(c, data) {
  const patch = {};
  const changes = []; // {label, oldVal, newVal} — لعرضها للمستخدم فى التوست

  function compareAndSet(field, oldRaw, newRaw, label) {
    const newNorm = String(newRaw ?? '').trim();
    if (!newNorm) return; // مفيش قيمة قادمة من أركان لهذا الحقل — لا نمسح شيء موجود بالنظام
    const oldNorm = String(oldRaw ?? '').trim();
    if (oldNorm === newNorm) return; // مطابق فعلاً بين النظامين — لا تحديث
    patch[field] = newRaw;
    changes.push({ label, oldVal: oldNorm || '—', newVal: newNorm });
  }

  if (data.invoice) compareAndSet('invoice', c.invoice, String(data.invoice).trim(), ARKKAN_FIELD_LABELS.invoice);
  if (data.courseNumber) compareAndSet('courseNumber', c.courseNumber, String(data.courseNumber).trim(), ARKKAN_FIELD_LABELS.courseNumber);
  if (data.bagInvoice) compareAndSet('bagInvoice', c.bagInvoice, String(data.bagInvoice).trim(), ARKKAN_FIELD_LABELS.bagInvoice);

  // تاريخ الحقيبة: نوحّد الصيغة لـ ISO أولاً كي لا يظهر فرق وهمي بسبب اختلاف الصيغة فقط
  if (data.bagPurchaseDate) {
    const nd = arkkanToInputDate(data.bagPurchaseDate);
    if (nd && isValidIsoDate(nd)) compareAndSet('bagPurchaseDate', c.bagPurchaseDate, nd, ARKKAN_FIELD_LABELS.bagPurchaseDate);
  }

  // تاريخ الدورة: نقارن بالقيمة الفعلية المعروضة بالكارت (المسجّلة على العميل
  // أو تاريخ جدول الدورات إن لم تكن مسجّلة مباشرة عليه)
  if (data.startDate) {
    const nd = arkkanToInputDate(data.startDate);
    if (nd && isValidIsoDate(nd)) {
      const current = c.startDate || arkkanCourseDate(c);
      compareAndSet('startDate', current, nd, ARKKAN_FIELD_LABELS.startDate);
    }
  }

  // تاريخ انتهاء الدورة: يُقارن ويُحدَّث مثل تاريخ البداية (نفس الصيغة ISO)
  if (data.endDate) {
    const nd = arkkanToInputDate(data.endDate);
    if (nd && isValidIsoDate(nd)) compareAndSet('endDate', c.endDate, nd, ARKKAN_FIELD_LABELS.endDate);
  }

  // صلاحية التدريب / الحقيبة: تُحدَّث فقط لو أعادها أركان صريحة (لا نحسبها هنا
  // حتى لا نكتب قيمة مشتقة فوق أي قيمة مسجّلة يدوياً).
  if (data.validityDate) {
    const nd = arkkanToInputDate(data.validityDate);
    if (nd && isValidIsoDate(nd)) compareAndSet('validityEndDate', c.validityEndDate, nd, ARKKAN_FIELD_LABELS.validityEndDate);
  }

  // قيمة الفاتورة: تُسجَّل في receiptActualValue (شيت فواتير الدورات) فقط.
  // coursePrice (سعر الدورة بشيت العملاء) لا يُمس إطلاقاً — الجلب من أركان لا يغيّر
  // قيمة الدورة ولا إجمالي/متبقي العميل، ويظل الفرق ظاهراً في عمود "مطابق/مختلف"
  // بالشيت (لأن المقارنة هناك بين receiptActualValue و centerIncome).
  if (data.coursePrice) {
    const newPrice = arkkanNumPrice(data.coursePrice);
    const oldActual = String(c.receiptActualValue ?? '').trim();
    if (String(newPrice).trim() !== oldActual) {
      patch.receiptActualValue = newPrice;
      changes.push({ label: ARKKAN_FIELD_LABELS.coursePrice, oldVal: oldActual || '—', newVal: String(newPrice) });
    }
  }

  // تاريخ إصدار الفاتورة: كان يُحدَّث دائماً بلا شرط أصلاً — نفس السلوك محفوظ، مع إضافته
  // لقائمة التغييرات الظاهرة للمستخدم لو اختلف عن المسجَّل
  if (data.date) {
    const normDate = arkkanToInputDate(data.date);
    if (normDate && isValidIsoDate(normDate)) {
      if (String(normDate) !== String(c.receiptIssueDate ?? '')) patch.receiptIssueDate = normDate;
      compareAndSet('receiptIssueDate', c.receiptIssueDate, normDate, 'تاريخ الفاتورة');
    }
  }

  return { patch, changes };
}

/* يجلب بيانات العميل من أركان، يقارنها بالكامل بما هو مسجَّل بالنظام (حتى لو
   الكارت مكتمل ظاهرياً) عبر arkkanDiffFromData، ثم يحفظ أي فرق فى الخادم تلقائياً. */
async function arkkanFetchAndAutoUpdate(clientId, referNum = '') {
  const data = await arkkanFetchOne(clientId, referNum); // يرمي خطأ لو فشل
  const idx = clients.findIndex(x => String(x.clientId) === String(clientId));
  if (idx === -1) throw new Error('العميل غير موجود في القائمة');

  const c = clients[idx];
  const { patch, changes } = arkkanDiffFromData(c, data);

  if (Object.keys(patch).length > 0) {
    Object.assign(clients[idx], patch);
    // دورة تلقائية: لو رقم الدورة القادم من أركان جديد (مفيش دورة بنفس الرقم فى شيت الدورات)،
    // تُفتح دورة حقيقية محفوظة فوراً بنفس الاسم/التاريخ من هذا العميل تحديداً.
    const sessionCreated = typeof ensureCourseSessionForClient === 'function' && ensureCourseSessionForClient(clients[idx]);
    // لو استُبدلت مصفوفة clients بمزامنة خلفية أثناء الحفظ، نُطبّق التصحيح (المؤكد على
    // السيرفر) على الكائن الحيّ الجديد — وإلا يعرض الكرت/الجدول القيم القديمة رغم نجاح الجلب.
    const live = arkkanLiveClient(null, clientId) || c;
    if (live !== clients[idx]) Object.assign(live, patch);
    // مهم: الترحيل قبل الحفظ — autoPostCourseInvoice يضع courseInvoiceDEId على كائن العميل،
    // فلو حفظنا العملاء قبله يضيع المؤشر ويُعاد ترحيل نفس الفاتورة في كل جلب (قيود مكررة).
    const posted = (patch.receiptActualValue !== undefined && typeof autoPostCourseInvoice === 'function')
      ? autoPostCourseInvoice(live) : false;
    if (typeof saveClients === 'function') await saveClients();
    if (sessionCreated && typeof saveCourseSessions === 'function') await saveCourseSessions();
    if (posted && typeof saveJournalDE === 'function') { try { await saveJournalDE(); } catch {} }
    return { updated: Object.keys(patch).length, changes, client: live };
  }
  return { updated: Object.keys(patch).length, changes, client: arkkanLiveClient(null, clientId) || clients[idx] };
}

/* يجلب الرقم المرجعي لهوية العميل ويحفظه فعلياً في سجل العميل، مع كل حماية
   «الكائن الحيّ» (المصفوفة قد تُستبدل أثناء الطلب). يرجع { refNum, oldRef, saveOk, client }.
   saveOk: true = محفوظ على الخادم، false = تعارض، null = تعذّر الاتصال (سيبقى في طابور الرفع).
   يُستخدم من زر «🔖 الرقم المرجعي» ومن «⏬ جلب من أركان» تلقائياً لو كان الرقم ناقصاً. */
async function arkkanFetchAndStoreRefNum(id, clientId) {
  const identity = String(clientId || '').trim();
  if (!identity) throw new Error('لا يوجد رقم هوية لهذا العميل');
  const body = await arkkanRefNumFetchOne(identity);
  const refNum = String(body && body.refNum || '').trim();
  if (!refNum) {
    if (body && (body.confirmed === true || body.notFound === true))
      throw new Error('لا يوجد رقم مرجعي لهذه الهوية في منصة إدارة النظام (بحث مكتمل بلا نتيجة)');
    throw new Error('لم تصل نتيجة من منصة إدارة النظام لهذه الهوية — أعد المحاولة (قد يكون البحث لم يكتمل بعد)');
  }

  // نأخذ كائن العميل الحيّ بعد الانتظار: قد تكون مصفوفة clients استُبدلت
  // بمزامنة خلفية/SSE أثناء الاستعلام، وتعديل الكائن القديم لا يظهر على الشاشة.
  const c = arkkanLiveClient(id, identity);
  if (!c) throw new Error('العميل غير موجود في القائمة — حدّث الصفحة');
  const oldRef = String(c.referNum || '').trim();
  c.referNum = refNum;
  const cJson = JSON.stringify(c);
  let saveOk = null;
  // نحفظ هذا العميل مباشرة منفرداً لنقدر نتحقق من النتيجة الفعلية (نجاح/تعارض/فشل اتصال)
  // بدل saveClients() العام الذي يبتلع فشل الرفع بصمت ويعرض نجاحاً زائفاً.
  if (typeof saveOneClientRecord === 'function') {
    saveOk = await saveOneClientRecord(c, cJson);
  } else if (typeof saveClients === 'function') {
    try { await saveClients(); saveOk = true; } catch (e) { saveOk = false; }
  }
  if (saveOk === true) {
    if (typeof _clientsSyncBaseline === 'object' && _clientsSyncBaseline instanceof Map) _clientsSyncBaseline.set(c.id, cJson);
    // حفظ اللقطة المحلية فوراً — بدون هذا، saveOneClientRecord ينجح على السيرفر لكن يترك
    // اللقطة المحلية (المستخدمة عند أي تحديث/فتح لاحق للصفحة قبل اكتمال المزامنة الخلفية)
    // بالقيمة القديمة، فيظهر الرقم المرجعي فارغاً بعد تحديث الصفحة رغم نجاح الحفظ فعلياً.
    if (typeof _scheduleClientsSnapPersist === 'function') _scheduleClientsSnapPersist();
    // الحفظ قد يستغرق أطول من نافذة مزامنة خلفية فيكون الكائن الحيّ الآن نسخة
    // جديدة لم تحمل الرقم — نثبّته عليها من غير إعادة رفع (السيرفر استلمه بالفعل).
    arkkanPinRefNum(c.id, identity, refNum);
    // مزامنة خلفية بدأت قبل الحفظ قد تنتهي بعده فتعيد نسخة السيرفر الأقدم (بلا الرقم).
    // نعيد التثبيت مرة واحدة بعد لحظة — بلا أي رفع إضافي — حتى لا يختفي الرقم من الشاشة.
    setTimeout(() => {
      try {
        if (arkkanPinRefNum(c.id, identity, refNum) && typeof _scheduleClientsSnapPersist === 'function')
          _scheduleClientsSnapPersist();
      } catch (e) {}
    }, 1500);
  }
  return { refNum, oldRef, saveOk, client: arkkanLiveClient(c.id, identity) || c };
}

/* معالج زر "جلب من أركان" الموجود في كرت العميل */
async function arkkanFetchCardButton(id, btn) {
  const c = clients.find(x => x.id === id);
  if (!c) return;
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }
  const identity = String(c.clientId || '').trim();
  if (!identity) { showToast('لا يوجد رقم هوية لهذا العميل', 'error'); return; }

  btn.disabled = true;
  const oldLabel = btn.innerHTML;

  try {
    // بيانات أركان لا تُفتح إلا بالرقم المرجعي. لو كان ناقصاً نجلبه أولاً تلقائياً
    // ونحفظه — بدل إرسال جلب بلا رقم مرجعي يرجع فاضي ويظهر «مطابقة تماماً» بينما
    // الرقم المرجعي ما زال فارغاً (كان يضطر المستخدم لإعادة العملية أكثر من مرة).
    let referNum = String(c.referNum || '').trim();
    let fetchedRef = '';
    if (!referNum) {
      btn.textContent = '⏳ جاري جلب الرقم المرجعي...';
      const got = await arkkanFetchAndStoreRefNum(id, identity);
      referNum = got.refNum;
      fetchedRef = got.refNum;
      if (got.saveOk === true) {
        showToast(`🔖 تم جلب الرقم المرجعي وحفظه: ${referNum}`, 'success');
      } else if (got.saveOk === false) {
        showToast(`تعذّر حفظ الرقم المرجعي (${referNum}): تعارض — سيُعرض الجلب لكن راجع الحفظ`, 'error');
      } else {
        showToast(`جُلب الرقم المرجعي (${referNum}) — سيُرفع تلقائياً عند عودة الاتصال`, 'info');
      }
      if (typeof renderTable === 'function') { try { renderTable(); } catch (e) {} }
    }

    btn.textContent = '⏳ جاري الجلب والحفظ...';
    const res = await arkkanFetchAndAutoUpdate(identity, referNum);
    if (res.updated > 0) {
      const changeList = (res.changes || []).map(ch => `${ch.label}: ${ch.oldVal} ← ${ch.newVal}`);
      const summary = changeList.length ? ' (' + changeList.join('، ') + ')' : '';
      showToast((`✅ تم تحديث ${res.updated} حقل من أركان${summary}`).slice(0, 220), 'success');
      if (typeof renderTable === 'function') { try { renderTable(); } catch (e) {} }
      if (typeof openClientWorkspace === 'function') openClientWorkspace(id); // تحديث الكارت فوراً
    } else {
      if (fetchedRef) {
        showToast(`🔖 تم جلب الرقم المرجعي وحفظه: ${fetchedRef} — وبيانات أركان مطابقة`, 'success');
        if (typeof openClientWorkspace === 'function') openClientWorkspace(id);
      } else {
        showToast('البيانات مطابقة تماماً لأركان — لا فرق', 'info');
      }
    }
  } catch (err) {
    showToast('خطأ جلب بيانات أركان: ' + String(err.message).slice(0, 110), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldLabel;
  }
}

/* زر "🔖 الرقم المرجعي" في كرت العميل: يجلب الرقم المرجعي من منصة إدارة
   النظام بالهوية فقط ويحفظه في الحقل — ثم يحدّث الكرت فوراً. */
async function arkkanRefNumCardButton(id, btn) {
  const initial = clients.find(x => x.id === id);
  if (!initial) return;
  const identity = String(initial.clientId || '').trim();
  if (!identity) { showToast('لا يوجد رقم هوية لهذا العميل', 'error'); return; }
  const creds = arkkanBasesCreds();
  if (!creds.user || !creds.pass) {
    showToast('ضع بيانات حساب منصة إدارة النظام في تبويب «مزامنة أركان» أولاً', 'error');
    return;
  }

  btn.disabled = true;
  const oldLabel = btn.innerHTML;
  btn.textContent = '⏳ جاري الاستعلام...';

  try {
    const got = await arkkanFetchAndStoreRefNum(id, identity);
    if (got.saveOk === true) {
      showToast(`✅ الرقم المرجعي: ${got.refNum}${got.oldRef && got.oldRef !== got.refNum ? ` (كان ${got.oldRef})` : ''}`, 'success');
    } else if (got.saveOk === false) {
      showToast(`تعذّر حفظ الرقم المرجعي (${got.refNum}): تعارض مع تعديل آخر — حدّث الصفحة وأعد المحاولة`, 'error');
    } else {
      showToast(`جُلب الرقم (${got.refNum}) لكن تعذّر الاتصال بالخادم — سيتم الرفع تلقائياً عند عودة الاتصال`, 'error');
    }
    // تحديث شيت العملاء خلف الكرت ثم الكرت نفسه بالبيانات الحيّة
    if (typeof renderTable === 'function') { try { renderTable(); } catch (e) {} }
    if (typeof openClientWorkspace === 'function') openClientWorkspace(id);
  } catch (err) {
    showToast('خطأ جلب الرقم المرجعي: ' + String(err.message).slice(0, 120), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldLabel;
  }
}

/* زر "جلب" بجانب صف واحد في شيت المزامنة: يجلب بيانات هذا العميل فقط
   ويملأ الناقص ويحفظ — دون الحاجة للمزامنة الكاملة لكل العملاء. */
async function arkkanSyncOne(clientId, btn) {
  const c = clients.find(x => String(x.clientId) === String(clientId));
  if (!c) return;
  if (arkkanIsSkipped(c)) { showToast('هذا العميل مستبعد من الجلب — ألغِ تفشيكه من عمود «إيقاف»', 'info'); return; }
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }

  const statusEl = $(`#arkkan-status-${cssEscapeId(clientId)}`);
  const oldLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '⏳';
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--gold);">⏳ جاري الجلب...</span>';

  try {
    const data = await arkkanFetchOne(clientId, c.referNum || '');
    // مصفوفة clients قد تُستبدل بمزامنة خلفية أثناء الجلب — نعدّل الكائن الحيّ
    // (تعديل النسخة القديمة لا يظهر في الجدول ولا يُحفظ في اللقطة المحلية).
    const live = arkkanLiveClient(null, clientId) || c;
    const patch = arkkanPatchFromData(live, data);
    if (Object.keys(patch).length > 0) {
      Object.assign(live, patch); // live هو نفس الكائن داخل clients
      // دورة تلقائية: لو رقم الدورة القادم من أركان جديد، تُفتح دورة حقيقية محفوظة فوراً.
      const sessionCreated = typeof ensureCourseSessionForClient === 'function' && ensureCourseSessionForClient(live);
      // ترحيل فاتورة الدورة قبل حفظ العملاء حتى يُحفظ courseInvoiceDEId مع العميل
      // (الحفظ قبله كان يُسقط المؤشر فيُعاد الترحيل كل مرة وتتراكم قيود مكررة).
      const posted = typeof autoPostCourseInvoice === 'function' ? autoPostCourseInvoice(live) : false;
      if (typeof saveClients === 'function') await saveClients();
      if (sessionCreated && typeof saveCourseSessions === 'function') await saveCourseSessions();
      if (posted && typeof saveJournalDE === 'function') {
        try { await saveJournalDE(); } catch {}
      }
      // لو استُبدلت المصفوفة أثناء الحفظ، نُطبّق نفس التصحيح (المؤكد على السيرفر الآن)
      // على الكائن الحيّ حتى لا يعود الصف يعرض القديم بعد لحظة.
      const liveNow = arkkanLiveClient(null, clientId);
      if (liveNow && liveNow !== live) Object.assign(liveNow, patch);
      arkkanRefreshRowCells(liveNow || live);
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--success, green);">✅ تم (${Object.keys(patch).length} حقل)</span>`;
      showToast(`✅ تم جلب وحفظ ${Object.keys(patch).length} حقل من أركان`, 'success');
    } else {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">لا جديد</span>';
      showToast('لا توجد بيانات جديدة ناقصة لهذا العميل', 'info');
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">❌ فشل</span>`;
    showToast('خطأ جلب بيانات أركان: ' + String(err.message).slice(0, 90), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldLabel;
  }
}

/* ══════════════════════════════════════════════
   1.5) تحميل الإيصالات (دورة + حقيبة) PDF
   ── كل أزرار الإيصالات (صف/كرت/محددون) تمر عبر طابور واحد في
      receipts-auto-sync.js، ويُحفظ الإيصال في الأرشيف المحلي.
   ══════════════════════════════════════════════ */

/* ═══ سجل التحميلات (داخل البرنامج) ═══
   يُسجَّل في مفتاح تخزين خاص بالبرنامج (receiptDownloadsLog) — نفس نظام حفظ
   بيانات البرنامج (يُشفر ويُزامن مع السيرفر مثل بقية البيانات).
   أصبح السجل للعرض/العدّ فقط؛ منع التكرار الحقيقي يعتمد على فهرس الإيصالات
   المحلي (receipts-auto-sync.js) لأن الملف يُحفظ في أرشيف الإيصالات.
   حرج: كل التعديلات تُحفَظ عبر طابور وعود مسلسل (بدون ذلك تتصادم الطلبات السريعة
   المتتالية بنظرة الأسبق-DOM 409 فيفقد السجل تسجيلاته). */
const ARKKAN_RECEIPTS_LOG_KEY = 'receiptDownloadsLog';
const ARKKAN_RECEIPTS_CLIENT_PREFIX = '_c:';
let _receiptsLog = null;
let _receiptsLogQueue = Promise.resolve();
let _receiptsLogTimer = null;

async function arkkanReceiptsLogLoad() {
  if (_receiptsLog) return _receiptsLog;
  try {
    const r = await window.storage.get(ARKKAN_RECEIPTS_LOG_KEY, false, false);
    const raw = r && r.value ? r.value : '{}';
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    _receiptsLog = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) { _receiptsLog = {}; }
  return _receiptsLog;
}

/* ── تسجيل إيصال محفوظ في السجل (للعرض والعدّ في الإعدادات) ── */
function arkkanReceiptsLogMark(name) {
  if (!name) return;
  if (!_receiptsLog) _receiptsLog = {};
  _receiptsLog[String(name)] = { t: Date.now() };
  arkkanReceiptsLogScheduleSave();
}

/* ── مستوى العميل: «اكتمل تحميل إصالاته» — للعرض في السجل فقط ── */
function arkkanReceiptsClientKey(clientId) { return ARKKAN_RECEIPTS_CLIENT_PREFIX + clientId; }
function arkkanReceiptsMarkClientDone(clientId) {
  if (!clientId) return;
  if (!_receiptsLog) _receiptsLog = {};
  _receiptsLog[arkkanReceiptsClientKey(clientId)] = { t: Date.now() };
  arkkanReceiptsLogScheduleSave();
}

/* ── الحفظ: debounce (تجميع التسجيلات في عملية واحدة) + طابور مسلسل ── */
function arkkanReceiptsLogScheduleSave() {
  if (_receiptsLogTimer) clearTimeout(_receiptsLogTimer);
  _receiptsLogTimer = setTimeout(() => {
    _receiptsLogTimer = null;
    _arkkanReceiptsLogFlush();
  }, 400);
}
/* يرجع promise الطابور نفسه لاحظ أن المُستدعيين ينتظرون الاكتمال الفعلي */
function _arkkanReceiptsLogFlush() {
  if (!_receiptsLog) return _receiptsLogQueue;
  // حد أقصى: نحتفظ بأحدث 5000 إيصال فقط (باستثناء علامات العملاء المحمية دائماً)
  const keys = Object.keys(_receiptsLog);
  const clientKeys = new Set(keys.filter(k => k.startsWith(ARKKAN_RECEIPTS_CLIENT_PREFIX)));
  if (keys.length > 5000 + clientKeys.size) {
    const slim = {};
    keys.filter(k => !clientKeys.has(k))
      .sort((a, b) => (_receiptsLog[b].t || 0) - (_receiptsLog[a].t || 0))
      .slice(0, 5000)
      .forEach(k => { slim[k] = _receiptsLog[k]; });
    clientKeys.forEach(k => { slim[k] = _receiptsLog[k]; });
    _receiptsLog = slim;
  }
  const payload = JSON.stringify(_receiptsLog);
  _receiptsLogQueue = _receiptsLogQueue.then(() => {
    return window.storage.set(ARKKAN_RECEIPTS_LOG_KEY, payload, false);
  }).catch(() => {});
  return _receiptsLogQueue;
}
async function arkkanReceiptsLogFlushNow() {
  if (_receiptsLogTimer) { clearTimeout(_receiptsLogTimer); _receiptsLogTimer = null; }
  await _arkkanReceiptsLogFlush();
}

function arkkanReceiptsLogCount() {
  if (!_receiptsLog) return 0;
  return Object.keys(_receiptsLog).filter(k => !k.startsWith(ARKKAN_RECEIPTS_CLIENT_PREFIX)).length;
}
function arkkanReceiptsLogClear() {
  _receiptsLog = {};
  _arkkanReceiptsLogFlush(); // كتابة فورية (غير مؤجلة) لتفريغ السجل من السيرفر فوراً
}

/* زر «📥 الإيصالات» في كرت العميل: يمر عبر نفس الطابور الواحد ويُحفظ في الأرشيف المحلي */
async function arkkanReceiptsCardButton(id, btn) {
  const c = clients.find(x => x.id === id);
  if (!c) return;
  if (!c.clientId) { showToast('لا يوجد رقم هوية لهذا العميل', 'error'); return; }
  if (!c.invoice) { showToast('لا يوجد رقم فاتورة لهذا العميل — لا يمكن مطابقة الإيصال', 'info'); return; }
  if (!ARKKAN_IS_DESKTOP) { showToast('تحميل الإيصالات متاح فقط من تطبيق سطح المكتب', 'info'); return; }
  if (typeof receiptsEnqueue !== 'function') {
    showToast('طابور الإيصالات لم يكتمل تحميله بعد — أعد المحاولة بعد لحظة', 'error');
    return;
  }

  btn.disabled = true;
  const oldLabel = btn.innerHTML;
  btn.textContent = '⏳ جاري التحميل...';

  try {
    const entry = await receiptsEnqueue(c, { source: 'click', priority: true, ignorePause: true }).promise;
    if (!entry) throw new Error('تعذّر جلب الإيصال — تحقق من رقم الهوية والفاتورة');
    showToast('✅ تم حفظ الإيصال محلياً — اضغط رقم الفاتورة لعرضه وطباعته', 'success');
  } catch (err) {
    showToast('خطأ تحميل الإيصالات: ' + String(err.message).slice(0, 90), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldLabel;
  }
}

/* تحميل إيصالات (دورة + حقيبة) لعميل واحد — يستخدمه زر الإيصال في كل صف من
   جدول المزامنة وفي كرت العميل، وأزرار "إيصالات للمحدد" في شيت العملاء. */

/* ══════════════════════════════════════════════
   2) صفحة المزامنة الكاملة (Bulk Sync)
   ══════════════════════════════════════════════ */
let _arkkanBulkRunning = false;
let _arkkanBulkStop = false;

/* ══════════════════════════════════════════════
   قفل تشغيل واحد لكل عمليات أركان
   يمنع ازدواج الجلب (صف + جماعي، أو صندوقان معاً، أو المزامنة الكاملة)
   لأن الوكيل المحلي صفحة متصفح واحدة ولا يتحمل طلبين متوازيين.
   ══════════════════════════════════════════════ */
const _arkkanExamRunLock = {
  active: false, label: '', prefix: null, name: null,
  stoppable: false, total: 0, done: 0, startedAt: 0
};

/* ══════════════════════════════════════════════
   شريط الحالة الثابت + مؤشر التبويب الشغّال
   يظهر مهما بدّلت التبويبات، ويتيح الإيقاف من أي مكان.
   ══════════════════════════════════════════════ */
let _arkkanRunbarTimer = null;

function arkkanPrefixToTab(prefix) {
  if (!prefix) return '';
  if (prefix === 'arkkan-exams') return 'noresult';
  const m = /^arkkan-exams-(needing|passed|failed)$/.exec(prefix);
  return m ? m[1] : '';
}

function arkkanRunbarEls() {
  return {
    bar: document.getElementById('arkkan-runbar'),
    txt: document.getElementById('arkkan-runbar-text'),
    btn: document.getElementById('btn-arkkan-runbar-stop')
  };
}

function arkkanRunbarText() {
  const L = _arkkanExamRunLock;
  if (!L.active) return;
  const { txt, btn } = arkkanRunbarEls();
  const st = L.name ? _examBulkStates[L.name] : null;
  const stopping = L.name ? !!(st && st.stop) : !!_arkkanBulkStop;
  const secs = L.startedAt ? Math.max(0, Math.round((Date.now() - L.startedAt) / 1000)) : 0;
  const prog = L.total > 0 ? ` — ${L.done}/${L.total}` : '';
  if (txt) {
    txt.textContent = stopping
      ? `⏳ جارٍ الإيقاف بعد العميل الحالي — ${L.label}`
      : `⏳ ${L.label}${prog} · ${secs} ث`;
  }
  if (btn) {
    btn.style.display = L.stoppable ? '' : 'none';
    btn.disabled = stopping;
    btn.textContent = stopping ? '⏳ جارٍ الإيقاف…' : '⏹ إيقاف';
    btn.title = L.stoppable ? 'إيقاف العملية الجارية في أركان' : '';
  }
}

function arkkanRunbarUpdate() {
  const L = _arkkanExamRunLock;
  const { bar } = arkkanRunbarEls();
  if (bar) bar.style.display = L.active ? '' : 'none';
  const tabName = arkkanPrefixToTab(L.prefix);
  document.querySelectorAll('[data-arkkan-tab]').forEach(t => {
    t.classList.toggle(
      'is-running',
      !!L.active && tabName === t.getAttribute('data-arkkan-tab')
    );
  });
  if (!L.active) {
    if (_arkkanRunbarTimer) { clearInterval(_arkkanRunbarTimer); _arkkanRunbarTimer = null; }
    return;
  }
  if (!_arkkanRunbarTimer) {
    _arkkanRunbarTimer = setInterval(() => {
      if (_arkkanExamRunLock.active) arkkanRunbarText();
    }, 1000);
  }
  arkkanRunbarText();
}

function arkkanRunbarSetProgress(done, total) {
  const L = _arkkanExamRunLock;
  if (!L.active) return;
  L.done = done;
  L.total = total;
  arkkanRunbarText();
}

function arkkanRunbarStop() {
  const L = _arkkanExamRunLock;
  if (!L.active) return;
  if (L.name) { arkkanExamRequestStop(L.name, null); return; }
  if (_arkkanBulkRunning) { arkkanBulkRequestStop(null); return; }
  showToast('العملية الحالية جلب لعميل واحد — تكمّل خلال لحظات ولا تحتاج إيقافاً', 'info');
}
const ARKKAN_EXAM_RUN_BUTTON_IDS = [
  'btn-arkkan-exams-start', 'btn-arkkan-exams-compare',
  'btn-arkkan-exams-needing-start', 'btn-arkkan-exams-needing-compare',
  'btn-arkkan-exams-failed-start', 'btn-arkkan-exams-failed-compare',
  'btn-arkkan-exams-passed-compare'
];

function arkkanExamRunBusyMessage() {
  showToast('فيه ' + (_arkkanExamRunLock.label || 'عملية') + ' شغالة بالفعل — استنى لحد ما تخلص أو اضغط «إيقاف»', 'info');
}

function arkkanExamAcquireRunLock(label, meta) {
  meta = meta || {};
  _arkkanExamRunLock.active = true;
  _arkkanExamRunLock.label = label || 'جلب';
  _arkkanExamRunLock.prefix = meta.prefix || null;
  _arkkanExamRunLock.name = meta.name || null;
  _arkkanExamRunLock.stoppable = !!meta.stoppable;
  _arkkanExamRunLock.total = Number(meta.total) > 0 ? Number(meta.total) : 0;
  _arkkanExamRunLock.done = 0;
  _arkkanExamRunLock.startedAt = Date.now();
  arkkanExamSyncRunButtons();
  arkkanRunbarUpdate();
}

function arkkanExamReleaseRunLock() {
  _arkkanExamRunLock.active = false;
  _arkkanExamRunLock.label = '';
  _arkkanExamRunLock.prefix = null;
  _arkkanExamRunLock.name = null;
  _arkkanExamRunLock.stoppable = false;
  _arkkanExamRunLock.total = 0;
  _arkkanExamRunLock.done = 0;
  _arkkanExamRunLock.startedAt = 0;
  arkkanExamSyncRunButtons();
  arkkanRunbarUpdate();
}

/* تعطيل/تمكين أزرار البدء والمقارنة والتصدير وأزرار الصفوف أثناء أي عملية */
function arkkanExamSyncRunButtons() {
  const busy = _arkkanExamRunLock.active;
  const set = (btn) => {
    if (!btn) return;
    btn.disabled = busy;
    btn.style.opacity = busy ? '0.5' : '';
    btn.style.cursor = busy ? 'not-allowed' : '';
    if (busy) btn.title = 'عملية أخرى شغالة بالفعل';
    else btn.removeAttribute('title');
  };
  ARKKAN_EXAM_RUN_BUTTON_IDS.forEach(id => set(document.getElementById(id)));
  document.querySelectorAll('[data-arkkan-exam-one]').forEach(set);
  document.querySelectorAll('[id^="btn-arkkan-exams"][id$="-export"]').forEach(set);
}

/* طلب إيقاف مع تغذية راجعة فورية (الطلب الجاري يكمّل ثم يتوقف) */
function arkkanExamRequestStop(name, btn) {
  const st = examBulkState(name);
  if (!st.running) { showToast('لا توجد عملية شغالة في هذا الصندوق', 'info'); return; }
  st.stop = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ جارٍ الإيقاف…';
  }
  showToast('تم طلب الإيقاف — هيقف بعد ما يخلّص العميل الحالي', 'info');
  arkkanRunbarUpdate();
}

function arkkanBulkRequestStop(btn) {
  if (!_arkkanBulkRunning) { showToast('لا توجد مزامنة شغالة حالياً', 'info'); return; }
  _arkkanBulkStop = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ جارٍ الإيقاف…';
  }
  showToast('تم طلب الإيقاف — هتوقف بعد ما يخلّص العميل الحالي', 'info');
  arkkanRunbarUpdate();
}

/* عملاء ناقصي البيانات المؤهلون — مرتبين من الأحدث تسجيلاً (c.date) إلى الأقدم */
function arkkanMissingClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkan(c) && !c.noCourseNumber && clientIsMissingArkkanData(c))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* فلتر السنة لصندوق مزامنة بيانات أركان (الصندوق الخامس) */
function arkkanSyncFilterYear() {
  var el = document.getElementById('arkkan-sync-filter-year');
  return el ? el.value : '';
}
function arkkanSyncClientYear(c) {
  var d = c && (c.date || c.startDate || arkkanCourseDate(c));
  return String(d || '').slice(0, 4);
}
function arkkanSyncFilteredClients() {
  var base = arkkanMissingClients();
  var y = arkkanSyncFilterYear();
  if (!y) return base;
  return base.filter(function (c) { return arkkanSyncClientYear(c) === String(y); });
}
function arkkanSyncPopulateYearFilter() {
  var sel = document.getElementById('arkkan-sync-filter-year');
  if (!sel) return;
  var years = new Set();
  arkkanMissingClients().forEach(function (c) {
    var y = arkkanSyncClientYear(c);
    if (/^\d{4}$/.test(y)) years.add(y);
  });
  var sorted = Array.from(years).sort(function (a, b) { return b.localeCompare(a); });
  var cur = sel.value;
  sel.innerHTML = ['<option value="">كل السنوات</option>']
    .concat(sorted.map(function (y) { return '<option value="' + escapeHtml(y) + '">' + escapeHtml(y) + '</option>'; }))
    .join('');
  if (sorted.indexOf(cur) !== -1) sel.value = cur;
}

/* ── استبعاد عميل من الجلب (مربع التحديد) ──
   العميل المُفعّل لا يُسأل أركان عنه لا في المزامنة الكاملة ولا في جلب صف
   واحد — حتى يُلغى تفشيكه. مناسب لاستبعاد عملاء يتعطل عندهم الجلب باستمرار.
   العلامة تُحفظ على العميل نفسه فتبقى بعد تحديث الصفحة وإعادة تشغيل البرنامج. */
function arkkanIsSkipped(c) { return !!(c && c.arkkanSkipFetch); }

function arkkanToggleSkip(clientId) {
  const c = (clients || []).find(x => String(x.clientId) === String(clientId));
  if (!c) return false;
  c.arkkanSkipFetch = !c.arkkanSkipFetch;
  if (typeof saveClients === 'function') saveClients().catch(() => {});
  renderArkkanSyncTable();
  return c.arkkanSkipFetch;
}

function renderArkkanSyncTable() {
  const tbody = $('#arkkan-sync-tbody');
  if (!tbody) return;
  arkkanSyncPopulateYearFilter();
  const missing = arkkanSyncFilteredClients();
  const skipped = missing.filter(arkkanIsSkipped);
  const totalAll = arkkanMissingClients().length;
  const counter = $('#arkkan-bulk-counter');
  if (counter) counter.textContent = `عملاء ناقصي البيانات (بشرط وجود رقم مرجعي): ${missing.length} من ${totalAll}${skipped.length ? ` — ${skipped.length} مستبعدون ✓` : ''}`;

  tbody.innerHTML = missing.map(c => `
    <tr id="arkkan-row-${escapeHtml(c.clientId)}"${arkkanIsSkipped(c) ? ' style="opacity:.5;"' : ''}>
      <td style="text-align:center;" title="استبعاد من الجلب — المزامنة الكاملة وجلب الصف الواحد يتجاهلانه">
        <input type="checkbox" class="arkkan-skip-chk" data-arkkan-skip="${escapeHtml(c.clientId)}"${arkkanIsSkipped(c) ? ' checked' : ''}>
      </td>
      <td>${escapeHtml(c.clientId)}</td>
      <td>${escapeHtml(c.name || '—')}</td>
      <td class="col-invoice">${escapeHtml(c.invoice || '—')}</td>
      <td class="col-coursenum">${escapeHtml(c.courseNumber || '—')}</td>
      <td class="col-date">${escapeHtml(c.receiptIssueDate || '—')}</td>
      <td class="col-courseprice">${escapeHtml(String(c.receiptActualValue !== undefined && c.receiptActualValue !== null && c.receiptActualValue !== '' ? c.receiptActualValue : '—'))}</td>
      <td class="col-startdate">${escapeHtml(c.startDate || arkkanCourseDate(c) || '—')}</td>
      <td class="col-baginvoice">${escapeHtml(c.bagInvoice || '—')}</td>
      <td class="col-bagdate">${escapeHtml(c.bagPurchaseDate || '—')}</td>
      <td class="col-missing" style="color:#c26511;">${escapeHtml(arkkanMissingFields(c).map(f => ARKKAN_FIELD_LABELS[f]).join('، '))}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-arkkan-one="${escapeHtml(c.clientId)}" style="padding:2px 12px; font-size:12px;" title="${arkkanIsSkipped(c) ? 'هذا العميل مستبعد من الجلب (ألغِ تفشيكه من عمود «إيقاف»)' : 'جلب بيانات هذا العميل فقط من أركان (بدون المزامنة الكاملة)'}"${arkkanIsSkipped(c) ? ' disabled' : ''}>جلب</button></td>
      <td id="arkkan-status-${escapeHtml(c.clientId)}">${arkkanIsSkipped(c) ? '<span style="color:var(--text-muted);">⛔ مستبعد</span>' : '<span style="color:var(--text-muted);">في الانتظار</span>'}</td>
    </tr>`).join('');
}

async function arkkanUpdateStatus() {
  const el = $('#arkkan-agent-status');
  const btn = $('#btn-arkkan-bulk-start');
  const startBtn = $('#btn-arkkan-start-agent');
  const stopBtn = $('#btn-arkkan-stop-agent');
  if (!el) return;
  el.className = 'hint hint-info';
  el.innerHTML = '⏳ جاري التحقق من الوكيل المحلي...';

  const st = await arkkanCheckReady();
  if (startBtn) startBtn.style.display = st.ready ? 'none' : '';
  if (stopBtn) stopBtn.style.display = st.ready ? '' : 'none';
  if (st.ready) {
    el.className = 'hint hint-success';
    const mem = st.memory;
    let memTxt = '';
    if (mem) {
      const freePct = mem.totalMB ? Math.round((mem.freeMB / mem.totalMB) * 100) : 0;
      const low = freePct < 12;
      memTxt = ` · ذاكرة الجهاز: ${mem.freeMB}MB حر من ${mem.totalMB}MB (${freePct}%)${low ? ' <span style="color:#e84118;">— منخفضة، أغلق البرامج الثقيلة للحصول على أفضل أداء</span>' : ''}`;
    }
    el.innerHTML = `✅ الوكيل المحلي جاهز — يجلب البيانات من أركان مباشرة عبر ${escapeHtml(ARKKAN_API_BASE)}.` + memTxt;
    if (btn) btn.disabled = false;
  } else if (st.playwrightInstalled === false) {
    el.className = 'hint hint-error';
    el.innerHTML = '❌ وكيل أركان يعمل لكن مكتبة playwright غير مثبتة. شغّل في مجلد المشروع:<br>' +
      '<code style="font-size:11px; user-select:all;">npm install && npx playwright install chromium</code>' +
      ' ثم أعد تشغيل الوكيل (ابدأه من الزر أدناه).';
    if (btn) btn.disabled = true;
  } else {
    el.className = 'hint hint-info';
    el.innerHTML = '⏳ الوكيل المحلي غير متصل. اضغط <b>"▶ تشغيل الوكيل المحلي"</b> أدناه' +
      (ARKKAN_IS_DESKTOP ? ' — سيعمل فوراً من داخل البرنامج' : ' — يتوجب استخدام تطبيق سطح المكتب لتفعيل الوكيل') +
      ' — يفتح مزمن المتصفح للجلب. إن كان يعمل لكنه قيد التهيئة فانتظر لحظات ثم اضغط "فحص الاتصال".';
    if (btn) btn.disabled = false; // الجلب يهيّئ تلقائياً
  }
}

/* ══════════════════════════════════════════════
   إدارة الوكيل المحلي من داخل تبويب المزامنة
   ══════════════════════════════════════════════ */

/* إيقاف يدوي صريح: بمجرد أن يوقف المستخدم الوكيل، لا نشغّله تلقائياً لأي
   جلب/رفع حتى يضغط «تشغيل الوكيل المحلي» بنفسه — عكس السلوك التلقائي السابق. */
let _arkkanStopRequested = false;

/* تشغيل الوكيل المحلي — يُطلق مباشرة عبر خادم سطح المكتب المحلي
   (/arkkan-agent/start) من داخل تطبيق سطح المكتب، وليس من أي ملف منفصل. */
async function arkkanStartAgent() {
  _arkkanStopRequested = false;
  const btn = $('#btn-arkkan-start-agent');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري التشغيل...'; }
  try {
    if (ARKKAN_IS_DESKTOP) {
      const r = await fetch('/arkkan-agent/start', { method: 'POST', signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      showToast('✅ تم تشغيل الوكيل المحلي — يُهيّئ المتصفح الآن (ثوانٍ)', 'success');
    } else {
      showToast('لا يمكن تشغيل الوكيل من المتصفح — استخدم تطبيق سطح المكتب حيث يعمل الوكيل مدمجاً تلقائياً', 'info');
    }
    setTimeout(arkkanUpdateStatus, 2500);
  } catch (err) {
    if (err && /victor|redirect|load|ended|Failed|NetworkError/i.test(String(err.message || err))) {
      // خطأ شبكة عابر أثناء الاتصال بخادم سطح المكتب — نعيد الفحص ببساطة
      setTimeout(arkkanUpdateStatus, 2000);
    } else {
      showToast('تعذّر تشغيل الوكيل: ' + String((err && err.message) || err).slice(0, 90), 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ تشغيل الوكيل المحلي'; }
  }
}

/* إيقاف الوكيل المحلي يدوياً — يغلق الوكيل وأي متصفح مفتوح ولا يعمل بعدها
   تلقائياً لأي جلب/رفع حتى يضغط المستخدم «تشغيل الوكيل المحلي» بنفسه. */
async function arkkanStopAgent() {
  const btn = $('#btn-arkkan-stop-agent');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري الإيقاف...'; }
  try {
    _arkkanStopRequested = true;
    if (ARKKAN_IS_DESKTOP) {
      // يوقف الوكيل مباشرة عبر منفذه (9955) — لا يعتمد على نسخة سطح المكتب المثبتة
      const r = await fetch(ARKKAN_API_BASE + '/api/arkkan/stop', { method: 'POST', signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      // نسخة احتياطية: لو الوكيل المحدث لم يخرج تلقائياً، نخبر خادم سطح المكتب فيوقف العملية
      try { await fetch('/arkkan-agent/stop', { method: 'POST', signal: AbortSignal.timeout(5000) }); } catch {}
      showToast('⏹ تم إيقاف الوكيل المحلي — لن يعمل تلقائياً حتى تشغيله يدوياً', 'info');
    } else {
      showToast('إيقاف الوكيل متاح من تطبيق سطح المكتب فقط', 'info');
    }
    setTimeout(arkkanUpdateStatus, 800);
  } catch (err) {
    showToast('تعذّر إيقاف الوكيل: ' + String((err && err.message) || err).slice(0, 90), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⏹ إيقاف الوكيل'; }
  }
}

/* يضمن أن الوكيل المحلي يعمل قبل أي جلب/رفع — يشغّله تلقائياً من خادم سطح
   المكتب إن كان متوقفاً وينتظر اكتمال تجهيز المتصفح. لا يُستدعى عند فتح
   البرنامج أو التبويب — فقط من أزرار الجلب/التشغيل نفسها. بذاكرة فحص مؤقتة
   حتى لا يتكرر الفحص لكل عميل داخل الحلقات الجماعية.
   إلا إذا أوقفه المستخدم يدوياً (`_arkkanStopRequested`) — حينها لا يعاد
   تشغيله لأي عملية حتى يضغط «تشغيل الوكيل المحلي» بنفسه. */
let _arkkanAgentCheckAt = 0;
async function arkkanEnsureAgentReady() {
  if (typeof ARKKAN_IS_DESKTOP === 'undefined' || !ARKKAN_IS_DESKTOP) return;
  const now = Date.now();
  if (now - _arkkanAgentCheckAt < 3000) return;
  _arkkanAgentCheckAt = now;
  if (_arkkanStopRequested) throw new Error('الوكيل موقوف يدوياً — اضغط «▶ تشغيل الوكيل المحلي» أولاً');
  const st = await arkkanCheckReady().catch(() => ({ ready: false }));
  if (st && st.ready) return;
  const r = await fetch('/arkkan-agent/start', { method: 'POST', signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j && j.error) || ('HTTP ' + r.status));
  for (let i = 0; i < 25; i++) {
    await new Promise(res => setTimeout(res, 1000));
    const nowSt = await arkkanCheckReady().catch(() => ({ ready: false }));
    if (nowSt && nowSt.ready) return;
  }
  throw new Error('تعذّر اكتمال تجهيز الوكيل خلال المهلة — أعد الضغط بعد ثوانٍ');
}

async function arkkanBulkSync() {
  if (_arkkanBulkRunning) { showToast('المزامنة الكاملة شغالة بالفعل', 'info'); return; }
  if (_arkkanExamRunLock.active) { arkkanExamRunBusyMessage(); return; }
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }

  _arkkanBulkRunning = true;
  _arkkanBulkStop = false;
  arkkanExamAcquireRunLock('المزامنة الكاملة', { stoppable: true });

  const startBtn = $('#btn-arkkan-bulk-start');
  const stopBtn = $('#btn-arkkan-bulk-stop');
  const progress = $('#arkkan-progress-bar');
  const wrap = $('#arkkan-progress-bar-wrap');
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) { stopBtn.style.display = ''; stopBtn.disabled = false; stopBtn.textContent = '⏹ إيقاف'; }
  if (wrap) wrap.style.display = '';

const allEligible = arkkanSyncFilteredClients();
  /* المستبعدون (مربع «إيقاف») لا يُسأل أركان عنهم إطلاقاً — يُعرضون بس كتلميح */
  const userSkipped = allEligible.filter(arkkanIsSkipped);
  const all = allEligible.filter(c => !arkkanIsSkipped(c));
  /* استئناف: من فُحصوا حديثاً وبياناتهم لسه ناقصة لا نعيد سؤال أركان عنهم — يكمّل من حيث توقف */
  const missing = all.filter(c => {
    const m = c.arkkanDataCheck;
    return !(m && Date.now() - m < arkkanResumeMs());
  });
  const total = missing.length;
  const skipped0 = all.length - total;
  arkkanRunbarSetProgress(0, total);
  let done = 0, updated = 0, failed = 0;

  showToast(`بدأت المزامنة: ${total} عميل${skipped0 ? ` (تخطّي ${skipped0} فُحصوا حديثاً)` : ''}${userSkipped.length ? ` — ${userSkipped.length} مستبعد ✓` : ''} — سيستغرق وقتاً حسب عدد العملاء`, 'info');

  /* إظهار حالة المستبعدين والمتخطّين في جدولهم فوراً */
  for (const c of allEligible) {
    if (arkkanIsSkipped(c)) {
      const el = $(`#arkkan-status-${cssEscapeId(c.clientId)}`);
      if (el) el.innerHTML = '<span style="color:var(--text-muted);">⛔ مستبعد</span>';
      continue;
    }
    if (missing.includes(c)) continue;
    const el = $(`#arkkan-status-${cssEscapeId(c.clientId)}`);
    if (el) el.innerHTML = '<span style="color:var(--text-muted);">⏭️ فُفحص حديثاً — تخطٍّ</span>';
  }

  /* حفظ متسلسل دائماً (حتى مع توازي الجلب) حتى لا تتداخل كتابة العملاء
     بين عدة طلبات في نفس اللحظة (خاصة قبل تثبيت الـ baseline). */
  let saveChain = Promise.resolve();
  const queueSave = () => {
    const p = saveChain.then(() => (typeof saveClients === 'function' ? saveClients() : null));
    saveChain = p.then(() => {}, () => {});
    return p;
  };

  /* الوكل المحلي صفحة متصفح واحدة — أي توازي بين طلبين يتعارض على نفس الصفحة
     ويسبب أخطاء/إعادة، فالطلبات تجري واحداً وراء واحد دائماً. */
  const POOL = 1;
  let workerIdx = 0;
  let anySessionCreated = false; // دورة تلقائية: نحفظ courseSessions مرة واحدة فقط فى نهاية الدفعة كاملة

  const processOne = async () => {
    while (!_arkkanBulkStop) {
      const ci = workerIdx++;
      if (ci >= total) return;
      const c = missing[ci];

      const statusEl = $(`#arkkan-status-${cssEscapeId(c.clientId)}`);
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--gold);">⏳ جاري الجلب...</span>';

      try {
        if (!_arkkanBulkRunning) break;
        const data = await arkkanFetchOne(c.clientId, c.referNum || '');
        const patch = arkkanPatchFromData(c, data);

        if (Object.keys(patch).length > 0) {
          const idx = clients.findIndex(x => x.clientId === c.clientId);
          if (idx !== -1) {
            Object.assign(clients[idx], patch);
            clients[idx].arkkanDataCheck = Date.now();
            // دورة تلقائية: لو رقم الدورة القادم من أركان جديد، تُفتح دورة حقيقية محفوظة.
            if (typeof ensureCourseSessionForClient === 'function' && ensureCourseSessionForClient(clients[idx])) {
              anySessionCreated = true;
            }
            // ترحيل فاتورة الدورة للقيد المزدوج تلقائياً بعد اكتمال بيانات الإيصال
            if (typeof autoPostCourseInvoice === 'function') {
              try { autoPostCourseInvoice(clients[idx]); } catch {}
            }
          }
          await queueSave();
          if (typeof saveJournalDE === 'function') { try { await saveJournalDE(); } catch {} }
          updated++;
          arkkanRefreshRowCells(clients[clients.findIndex(x => x.clientId === c.clientId)] || c);
          if (statusEl) statusEl.innerHTML = `<span style="color:var(--success, green);">✅ تم (${Object.keys(patch).length} حقل)</span>`;
        } else {
          /* سجّل الفحص على العميل حتى لا يُعاد سؤاله في نفس الفترة
             (يُحفظ في الحفظة الختامية بعد انتهاء التشغيل) */
          const idx0 = clients.findIndex(x => x.clientId === c.clientId);
          if (idx0 !== -1) clients[idx0].arkkanDataCheck = Date.now();
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">لا جديد</span>';
        }
      } catch (err) {
        failed++;
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">❌ فشل</span>`;
      }

      done++;
      arkkanRunbarSetProgress(done, total);
      if (progress) progress.style.width = `${Math.round(done / Math.max(total, 1) * 100)}%`;
      const counter = $('#arkkan-bulk-counter');
      if (counter) counter.textContent = `✅ ${updated} محدّث · ❌ ${failed} فشل · ${done}/${total}`;
    }
  };

  await Promise.all(Array.from({ length: Math.min(POOL, total) }, () => processOne()));
  await queueSave(); // حفظ علامات الفحص المتبقية (لا جديد)
  if (anySessionCreated && typeof saveCourseSessions === 'function') await saveCourseSessions();

  _arkkanBulkRunning = false;
  if (startBtn) startBtn.style.display = '';
  if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.disabled = false; stopBtn.textContent = '⏹ إيقاف'; }
  if (wrap) wrap.style.display = 'none';
  arkkanExamReleaseRunLock();
  renderArkkanSyncTable();
  showToast(`اكتملت المزامنة: ${updated} محدّث، ${failed} فشل`, updated > 0 ? 'success' : 'info');
}

/* أداة تأمين لأي id في محدد CSS */
function cssEscapeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/* ══════════════════════════════════════════════
   3) نتائج الاختبارات (الرسوب والنجاح)
   صندوق مستقل أسفل صندوق المزامنة — يجلب من أركان آخر 4
   محاولات اختبار لكل عميل (بعدة إعادة) + تاريخ آخر اختبار.
   ══════════════════════════════════════════════ */

async function arkkanExamFetchOne(clientId, referNum = '') {
  await arkkanEnsureAgentReady();
  const r = await fetch(ARKKAN_API_BASE + '/api/arkkan/exams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, referNum }),
    signal: AbortSignal.timeout(95000)
  });
  if (!r.ok) {
    let msg = 'فشل الوكيل المحلي (' + r.status + ')';
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/* يبني التصحيح من بيانات نتائج الاختبار إلى العميل */
function arkkanPatchExamsFromData(c, data) {
  return {
    examAttempts: Array.isArray(data.attempts) ? data.attempts : [],
    examLastDate: data.lastDate || '',
    examResult: data.lastResult || '',
    examGrade: data.lastGrade || '',
    // موعد الاختبار كما ورد من أركان حرفياً (المركز + القاعة + اليوم + التاريخ + الساعة)
    examAppointment: String(data.examAppointment || '').trim(),
    examAppointmentDate: String(data.examAppointmentDate || '').trim()
  };
}

/* العميل ناجح = نتيجة آخر اختبار "ناجح" → اكتمل جلبه وينتقل إلى صندوق النجاح */
function arkkanExamPassed(c) {
  return String(c.examResult || '').includes('ناجح');
}

/* العميل راسب = آخر محاولة (examResult) أو أي محاولة مخزّنة "راسب" → ينتقل إلى صندوق الراسبين.
   بعض العملاء القدامى محفوظ عندهم "راسب" في المحاولات دون examResult — نكشفه من المحاولات أيضاً */
function arkkanExamFailed(c) {
  if (arkkanExamPassed(c)) return false;
  if (String(c.examResult || '').includes('راسب')) return true;
  return (Array.isArray(c.examAttempts) ? c.examAttempts : [])
    .some(a => String((a && a.r) || '').includes('راسب'));
}

/* هل للعميل أي دلالة تاريخ اختبار؟ تاريخ محفوظ أو موعد قادم من أركان. */
function arkkanExamHasDate(c) {
  if (String((c && c.examLastDate) || '').trim()) return true;
  return !!String((c && c.examAppointment) || '').trim() || !!String((c && c.examAppointmentDate) || '').trim();
}

/* صندوق النتائج الرئيسي: بلا نتيجة وبلا تاريخ اختبار (لم يُسجّل له أي اختبار بعد) */
function arkkanExamClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkanExams(c) && !arkkanExamPassed(c) && !arkkanExamFailed(c) && !arkkanExamHasDate(c))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* صندوق "يحتاج إلى اختبار": لديه تاريخ آخر اختبار لكن كل النتائج فاضية
   (لا نجاح ولا رسوب سابق) — يُعيد الاختبار حتى تظهر نتيجة */
function arkkanExamNeedingClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkanExams(c) && !arkkanExamPassed(c) && !arkkanExamFailed(c) && arkkanExamHasDate(c))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* عملاء صندوق النجاح: من أكملوا بالنجاح (لا يُعرض لهم جلب أصلاً) */
function arkkanExamPassedClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkanExams(c) && arkkanExamPassed(c))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* عملاء صندوق الراسبين: صندوق مستقل يجلب لنفسه، وإذا نجحوا ينتقلون للنجاح */
function arkkanExamFailedClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkanExams(c) && arkkanExamFailed(c))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* خلية نتيجة: ناجح أخضر / راسب أحمر + الدرجة */
function arkkanExamCell(attempt) {
  // attempt يمكن أن يكون نصاً قديماً (للتوافق) أو كائن {r, g, d}
  let r = '', g = '';
  if (typeof attempt === 'object' && attempt !== null) {
    r = String(attempt.r || '').trim();
    g = String(attempt.g || '').trim();
  } else {
    r = String(attempt || '').trim();
  }
  if (!r && !g) return '<span style="color:var(--text-muted);">—</span>';
  
  const color = r.includes('ناجح') ? 'var(--success, green)' : r.includes('راسب') ? 'var(--danger, red)' : 'inherit';
  const resultHtml = r ? `<span style="color:${color}; font-weight:600;">${escapeHtml(r)}</span>` : '';
  const gradeHtml = g ? `<span style="color:var(--text-muted); font-size:0.85em; margin-right:6px;">(${escapeHtml(g)})</span>` : '';
  
  return `${gradeHtml}${resultHtml}`;
}

/* آخر اختبار تم للعميل: يقرأ examResult (آخر نتيجة)، ولو فاضي يرجع لأول محاولة مخزّنة
   لها نتيجة ناجح/راسب — نفس معيار التصنيف المستخدم في صناديق نتائج الاختبارات
   يعيد { r: result, g: grade, d: date } */
/* خلية «تاريخ آخر اختبار» — عمود واحد ذكي:
   - نتيجة حقيقية موجودة  → التاريخ المخزَّن (+ منذ كام يوم)
   - لا نتيجة لكن فيه موعد → نص الموعد الكامل كما ورد من أركان:
     «مركز اختبار الخرج رجال - قاعة (2) - السبت 2026/11/07 - من 8:30 ص الي 10:00 ص»
   هكذا لا تُضاف أعمدة مكررة ولا يضيع الفرق بين محاولة حقيقية وموعد قادم. */
/* هل عند العميل نتيجة اختبار حقيقية (لا مجرد موعد)؟ */
function arkkanExamHasResult(c) {
  return !!(String((c && c.examResult) || '').trim()
    || (Array.isArray(c && c.examAttempts) && c.examAttempts.length));
}
/* الموعد القادم يُعرض سطراً مستقلاً فقط لو العميل عنده نتيجة حقيقية أيضاً
   — حتى لا يتكرر حين يكون الموعد هو النص الأساسي. */
/* لم يعد هناك سطر موعد مستقل — الموعد القادم هو النص الأساسي نفسه. */
function arkkanExamApptExtra(c) {
  return '';
}
/* النص الأساسي للعمود: تاريخ المحاولة إن وُجدت، وإلا نص الموعد كما ورد من أركان. */
/* (غير مستخدم) كان يقيّد العرض بالمواعيد القادمة فقط. */
function arkkanExamApptUpcoming(c) {
  const appt = String((c && c.examAppointment) || '').trim();
  if (!appt) return '';
  const ad = String((c && c.examAppointmentDate) || '').trim().replace(/-/g, '/');
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(ad)) return appt; // بلا تاريخ قابل للمقارنة
  const now = new Date();
  const today = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' + String(now.getDate()).padStart(2, '0');
  return ad >= today ? appt : '';
}
function arkkanExamDateText(c) {
  const appt = String((c && c.examAppointment) || '').trim();
  const d = String((c && c.examLastDate) || '').trim();
  // نص الموعد الكامل (اليوم + التاريخ + الساعة) يتقدّم دائماً عند وجوده،
  // والا نعرض تاريخ آخر محاولة. لا نستبدل الجملة بتاريخ مجرّد.
  return appt || d;
}
/* النص الكامل للتصدير: الأساسي + الموعد القادم لو الاثنان موجودان. */
function arkkanExamDateFullText(c) {
  const base = arkkanExamDateText(c);
  const extra = arkkanExamApptExtra(c);
  return extra ? (base ? base + ' — ' + extra : extra) : base;
}
function arkkanExamDateCellHtml(c) {
  const txt = arkkanExamDateText(c);
  const extra = arkkanExamApptExtra(c);
  let out = txt ? `<span class="arkkan-appt" title="${escapeHtml(txt)}">${escapeHtml(txt)}</span>`
    : '<span style="color:var(--text-muted);">—</span>';
  // نتيجة حقيقية + موعد قادم معاً → الموعد سطر صغير تحت التاريخ
  if (extra) {
    out += `<div class="arkkan-appt-sub" title="موعد قادم من أركان" style="margin-top:4px; font-size:0.78em; color:var(--text-muted);">${escapeHtml(extra)}</div>`;
  }
  return out;
}

function arkkanExamStatusOf(c) {
  const er = String(c.examResult || '').trim();
  const eg = String(c.examGrade || '').trim();
  if (er) return { r: er, g: eg, d: c.examLastDate || '' };
  const att = Array.isArray(c.examAttempts) ? c.examAttempts : [];
  const last = att.slice().reverse().find(a => a && String(a.r || '').trim() && (String(a.r).includes('ناجح') || String(a.r).includes('راسب')));
  if (last) return { r: last.r, g: last.g || '', d: last.d || '' };
  return null;
}

/* شارة حالة آخر اختبار (ناجح أخضر / راسب أحمر) تُعرض في شيت العملاء وفي كرت العميل */
function arkkanExamBadgeHtml(c) {
  const s = typeof arkkanExamStatusOf === 'function' ? arkkanExamStatusOf(c) : null;
  if (!s) return '';
  const r = String(s.r).trim();
  const g = String(s.g).trim();
  const tip = `آخر اختبار تم: ${r}${g ? ' (درجة: ' + g + ')' : ''}${s.d ? ' — بتاريخ ' + s.d : ''}`;
  if (r.includes('ناجح')) return `<span class="stamp paid" title="${escapeHtml(tip)}">ناجح ✓${g ? ' (' + escapeHtml(g) + ')' : ''}</span>`;
  if (r.includes('راسب')) return `<span class="stamp owe" title="${escapeHtml(tip)}">راسب${g ? ' (' + escapeHtml(g) + ')' : ''}</span>`;
  return '';
}

/* محتوى قسم "نتيجة الاختبار" داخل كرت العميل — آخر نتيجة + التاريخ + المحاولات الأخيرة */
function arkkanExamCardContent(c) {
  const s = typeof arkkanExamStatusOf === 'function' ? arkkanExamStatusOf(c) : null;
  const att = Array.isArray(c.examAttempts) ? c.examAttempts : [];
  const last = s ? String(s.r).trim() : '';
  const lastGrade = s ? String(s.g).trim() : '';
  const badge = last.includes('ناجح')
    ? `<span class="stamp paid">ناجح ✓${lastGrade ? ' (' + escapeHtml(lastGrade) + ')' : ''}</span>`
    : last.includes('راسب')
      ? `<span class="stamp owe">راسب${lastGrade ? ' (' + escapeHtml(lastGrade) + ')' : ''}</span>`
      : `<span class="stamp" style="color:var(--text-muted);">${escapeHtml(last || 'لم يُختبَر بعد')}</span>`;
  const d = (s && s.d) || c.examLastDate || '';
  // عمود واحد ذكي: الموعد الكامل إن لم توجد نتيجة حقيقية، وإلا تاريخ المحاولة
  const dateSrc = arkkanExamDateText(c);
  const dateTxt = dateSrc ? (typeof formatDateDisplay === 'function' ? formatDateDisplay(dateSrc) : escapeHtml(dateSrc)) : '—';
  const attempts = att.length
    ? `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;">` + att.slice(0, 4).map((a, i) => {
        const r = String((a && a.r) || '—').trim();
        const g = String((a && a.g) || '').trim();
        const cls = r.includes('ناجح') ? 'paid' : r.includes('راسب') ? 'owe' : '';
        const gradeHtml = g ? ` <span style="color:var(--text-muted); font-size:0.8em;">(${escapeHtml(g)})</span>` : '';
        return `<span class="stamp ${cls}" title="محاولة ${i + 1} — ${escapeHtml((a && a.d) || '')}">م${i + 1}: ${escapeHtml(r)}${gradeHtml}</span>`;
      }).join('') + `</div>`
    : '';
  return `<div class="cw-grid">
      <div class="cw-item"><small>آخر نتيجة</small><b>${badge}</b></div>
      <div class="cw-item"><small>تاريخ آخر اختبار</small><b>${dateTxt}</b></div>
    </div>${attempts}`;
}

/* ═══════════════════════════════════════════════════════
   فلاتر مستقلة لكل صندوق (اسم/رقم هوية/جنسية/دورة/شركة/فترة)
   + تصدير Excel لما هو ظاهر فعلياً بعد الفلترة في كل صندوق
   ═══════════════════════════════════════════════════════ */
var ARKKAN_EXAM_BOXES = [
  { prefix: 'arkkan-exams',         label: 'صندوق النتائج (بلا نتيجة)', listFn: function(){ return arkkanExamClients(); } },
  { prefix: 'arkkan-exams-needing', label: 'يحتاج إلى اختبار',          listFn: function(){ return arkkanExamNeedingClients(); } },
  { prefix: 'arkkan-exams-passed',  label: 'صندوق النجاح',              listFn: function(){ return arkkanExamPassedClients(); } },
  { prefix: 'arkkan-exams-failed',  label: 'صندوق الراسبين',            listFn: function(){ return arkkanExamFailedClients(); } }
];

function arkkanExamFilterState(prefix) {
  var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
  return {
    name: g(prefix + '-filter-name').trim().toLowerCase(),
    id: g(prefix + '-filter-id').trim(),
    nat: g(prefix + '-filter-nat'),
    course: g(prefix + '-filter-course'),
    company: g(prefix + '-filter-company'),
    dateFrom: g(prefix + '-filter-date-from'),
    dateTo: g(prefix + '-filter-date-to'),
    year: g(prefix + '-filter-year')
  };
}

function arkkanExamApplyFilters(list, prefix) {
  var f = arkkanExamFilterState(prefix);
  if (!f.name && !f.id && !f.nat && !f.course && !f.company && !f.dateFrom && !f.dateTo && !f.year) return list;
  return list.filter(function (c) {
    if (f.name && !String(c.name || '').toLowerCase().includes(f.name)) return false;
    if (f.id && !String(c.clientId || '').includes(f.id)) return false;
    if (f.nat && String(c.nationality || '').trim() !== f.nat) return false;
    if (f.course && String(c.courseType || '').trim() !== f.course) return false;
    if (f.company) {
      var comp = String(c.companyName || '').trim() || '(بدون شركة)';
      if (comp !== f.company) return false;
    }
    var cdate = c.startDate || arkkanCourseDate(c) || '';
    if (f.dateFrom && (!cdate || cdate < f.dateFrom)) return false;
    if (f.dateTo && (!cdate || cdate > f.dateTo)) return false;
    if (f.year) {
      var y = String(cdate || '').slice(0, 4);
      if (y !== String(f.year)) return false;
    }
    return true;
  });
}

/* تعبئة قوائم الجنسية/الدورة/الشركة من كل عملاء الصندوق (قبل الفلترة) حتى
   تبقى كل الخيارات متاحة للاختيار حتى لو الفلاتر التانية ضيّقت العرض حالياً */
function arkkanExamPopulateFilterOptions(prefix, fullList) {
  var fillSelect = function (sel, values, placeholder) {
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = ['<option value="">' + placeholder + '</option>']
      .concat(values.map(function (v) { return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>'; }))
      .join('');
    if (values.indexOf(current) !== -1) sel.value = current;
  };
  var uniq = function (fn) {
    var s = new Set();
    fullList.forEach(function (c) { var v = fn(c); if (v) s.add(v); });
    return Array.from(s).sort();
  };
  fillSelect(document.getElementById(prefix + '-filter-nat'), uniq(function (c) { return String(c.nationality || '').trim(); }), 'كل الجنسيات');
  fillSelect(document.getElementById(prefix + '-filter-course'), uniq(function (c) { return String(c.courseType || '').trim(); }), 'كل الدورات');
  fillSelect(document.getElementById(prefix + '-filter-company'), uniq(function (c) { return String(c.companyName || '').trim() || '(بدون شركة)'; }), 'كل الشركات');
  // فلتر السنة: يُستخرج من تاريخ الدورة (startDate أو arkkanCourseDate)
  var yearSel = document.getElementById(prefix + '-filter-year');
  if (yearSel) {
    var years = new Set();
    fullList.forEach(function (c) {
      var d = c.startDate || arkkanCourseDate(c) || '';
      var y = String(d).slice(0, 4);
      if (/^\d{4}$/.test(y)) years.add(y);
    });
    var sortedYears = Array.from(years).sort(function (a, b) { return b.localeCompare(a); });
    var curYear = yearSel.value;
    yearSel.innerHTML = ['<option value="">كل السنوات</option>']
      .concat(sortedYears.map(function (y) { return '<option value="' + escapeHtml(y) + '">' + escapeHtml(y) + '</option>'; }))
      .join('');
    if (sortedYears.indexOf(curYear) !== -1) yearSel.value = curYear;
  }
}

function arkkanExamExportBox(box, list) {
  var rows = list.map(function (c) {
    var s = (typeof arkkanExamStatusOf === 'function') ? arkkanExamStatusOf(c) : null;
    return {
      'الاسم': c.name || '',
      'رقم الهوية': c.clientId || '',
      'الجنسية': c.nationality || '',
      'الشركة': c.companyName || '',
      'الدورة': c.courseType || '',
      'تاريخ آخر اختبار': arkkanExamDateFullText(c),
      'النتيجة': (s && s.r) || c.examResult || '',
      'عدد المحاولات': Array.isArray(c.examAttempts) ? c.examAttempts.length : 0
    };
  });
  var fname = 'تقرير_' + box.label.replace(/\s+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  downloadXlsx(fname, box.label.slice(0, 31), rows);
  showToast('تم تصدير ' + rows.length + ' سجل — ' + box.label, rows.length ? 'success' : 'info');
}

/* عند تغيير أي حقل فلترة نعيد رسم الصناديق الأربعة فقط (بدون إعادة جلب) — مع تأخير حقول
   الكتابة (الاسم/الهوية/التاريخ) حتى توقف الكتابة بدل إعادة بناء 4 جداول مع كل حرف. */
const _debouncedArkkanExamsRender = debounce(renderArkkanExamsTable);
document.addEventListener('input', function (e) {
  if (e.target && e.target.id && /^arkkan-exams(-needing|-passed|-failed)?-filter-(name|id|date-from|date-to|year)$/.test(e.target.id)) {
    _debouncedArkkanExamsRender();
  }
});
document.addEventListener('change', function (e) {
  if (e.target && e.target.id && /^arkkan-exams(-needing|-passed|-failed)?-filter-(nat|course|company|year)$/.test(e.target.id)) {
    renderArkkanExamsTable();
  }
});
document.addEventListener('click', function (e) {
  var clearBtn = e.target.closest('[id^="btn-arkkan-exams"][id$="-filter-clear"]');
  if (clearBtn) {
    var prefix = clearBtn.id.replace(/^btn-/, '').replace(/-filter-clear$/, '');
    ['name', 'id', 'nat', 'course', 'company', 'date-from', 'date-to', 'year'].forEach(function (k) {
      var el = document.getElementById(prefix + '-filter-' + k);
      if (el) el.value = '';
    });
    renderArkkanExamsTable();
    return;
  }
  var expBtn = e.target.closest('[id^="btn-arkkan-exams"][id$="-export"]');
  if (expBtn) {
    var pfx = expBtn.id.replace(/^btn-/, '').replace(/-export$/, '');
    var box = ARKKAN_EXAM_BOXES.find(function (b) { return b.prefix === pfx; });
    if (box) arkkanExamExportBox(box, arkkanExamApplyFilters(box.listFn(), box.prefix));
  }
});

/* ══════════════════════════════════════════════
   تبديل لوحات الصناديق الأربعة (تبويبات + بطاقات مؤشرات)
   لا يغيّر أي منطق: يظهر لوحة واحدة ويخفي الباقي فقط،
   ويحفظ اختيار المستخدم ليبقى بعد إعادة التشغيل.
   ══════════════════════════════════════════════ */
const ARKKAN_EXAM_BOX_IDS = {
  noresult: 'arkkan-box-noresult',
  needing: 'arkkan-box-needing',
  passed: 'arkkan-box-passed',
  failed: 'arkkan-box-failed'
};
const ARKKAN_EXAM_BOX_STORE = 'arkkanExamActiveBox';

function arkkanExamShowBox(name) {
  if (!ARKKAN_EXAM_BOX_IDS[name]) name = 'noresult';
  try { localStorage.setItem(ARKKAN_EXAM_BOX_STORE, name); } catch (e) { /* تخزين غير متاح */ }

  Object.keys(ARKKAN_EXAM_BOX_IDS).forEach(k => {
    const box = document.getElementById(ARKKAN_EXAM_BOX_IDS[k]);
    if (box) box.classList.toggle('is-active', k === name);
  });

  document.querySelectorAll('[data-arkkan-tab]').forEach(el => {
    const on = el.getAttribute('data-arkkan-tab') === name;
    el.classList.toggle('is-active', on);
    if (el.getAttribute('role') === 'tab') el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function arkkanExamRestoreBox() {
  let name = 'noresult';
  try {
    const saved = localStorage.getItem(ARKKAN_EXAM_BOX_STORE);
    if (saved && ARKKAN_EXAM_BOX_IDS[saved]) name = saved;
  } catch (e) { /* تخزين غير متاح */ }
  arkkanExamShowBox(name);
}

document.addEventListener('click', function (e) {
  const tab = e.target.closest?.('[data-arkkan-tab]');
  if (!tab) return;
  arkkanExamShowBox(tab.getAttribute('data-arkkan-tab'));
});

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const tab = e.target.closest?.('[data-arkkan-tab]');
  if (!tab) return;
  e.preventDefault();
  arkkanExamShowBox(tab.getAttribute('data-arkkan-tab'));
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arkkanExamRestoreBox);
else arkkanExamRestoreBox();

function renderArkkanExamsTable() {
  const tbody = $('#arkkan-exams-tbody');
  const nbody = $('#arkkan-exams-needing-tbody');
  const pbody = $('#arkkan-exams-passed-tbody');
  const fbody = $('#arkkan-exams-failed-tbody');
  const noResultFull = arkkanExamClients();          // صندوق النتائج: بلا نتيجة وبلا تاريخ اختبار
  const needingFull = arkkanExamNeedingClients();    // يحتاج إلى اختبار: تاريخ اختبار وكل النتائج فاضية
  const passedFull = arkkanExamPassedClients();      // صندوق النجاح
  const failedFull = arkkanExamFailedClients();      // صندوق الراسبين (مستقل بجلبه)

  // تعبئة قوائم الفلاتر (جنسية/دورة/شركة) من كل صندوق قبل تضييقه بالفلترة
  arkkanExamPopulateFilterOptions('arkkan-exams', noResultFull);
  arkkanExamPopulateFilterOptions('arkkan-exams-needing', needingFull);
  arkkanExamPopulateFilterOptions('arkkan-exams-passed', passedFull);
  arkkanExamPopulateFilterOptions('arkkan-exams-failed', failedFull);

  const noResult = arkkanExamApplyFilters(noResultFull, 'arkkan-exams');
  const needing = arkkanExamApplyFilters(needingFull, 'arkkan-exams-needing');
  const passed = arkkanExamApplyFilters(passedFull, 'arkkan-exams-passed');
  const failed = arkkanExamApplyFilters(failedFull, 'arkkan-exams-failed');

  const cnt = (shown, total, label) => shown === total ? `${label}: ${total}` : `${label}: ${shown} من ${total}`;
  const counter = $('#arkkan-exams-counter');
  if (counter) counter.textContent = cnt(noResult.length, noResultFull.length, 'بلا نتيجة ولا تاريخ اختبار بعد');
  const ncounter = $('#arkkan-exams-needing-counter');
  if (ncounter) ncounter.textContent = cnt(needing.length, needingFull.length, 'بلا نتيجة (لديهم تاريخ اختبار فقط)');
  const pcounter = $('#arkkan-exams-passed-counter');
  if (pcounter) pcounter.textContent = cnt(passed.length, passedFull.length, 'الناجحون (اكتمل جلب نتائجهم)');
  const fcounter = $('#arkkan-exams-failed-counter');
  if (fcounter) fcounter.textContent = cnt(failed.length, failedFull.length, 'الراسبون (صندوق مستقل — يجلب لنفسه)');

  // أرقام بطاقات المؤشرات وعدّادات التبويبات (الإجمالي الكامل، لا المتصفَّى)
  const fmt = n => Number(n || 0).toLocaleString('en-US');
  const setNum = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = fmt(n); };
  setNum('arkkan-kpi-total',
    noResultFull.length + needingFull.length + passedFull.length + failedFull.length);
  setNum('arkkan-kpi-noresult', noResultFull.length);
  setNum('arkkan-kpi-needing', needingFull.length);
  setNum('arkkan-kpi-passed', passedFull.length);
  setNum('arkkan-kpi-failed', failedFull.length);
  setNum('arkkan-tab-count-noresult', noResultFull.length);
  setNum('arkkan-tab-count-needing', needingFull.length);
  setNum('arkkan-tab-count-passed', passedFull.length);
  setNum('arkkan-tab-count-failed', failedFull.length);

  const cells = c => {
    const att = Array.isArray(c.examAttempts) ? c.examAttempts : [];
    return [0, 1, 2, 3].map(i =>
      `<td class="col-exam-attempt">${att[i] ? arkkanExamCell(att[i]) : '<span style="color:var(--text-muted);">—</span>'}</td>`
    ).join('');
  };

  if (tbody) {
    tbody.innerHTML = noResult.map(c => `
    <tr id="arkkan-exam-row-${cssEscapeId(c.clientId)}">
      <td>${escapeHtml(c.name || '—')}</td>
      <td>${escapeHtml(c.clientId)}</td>
      <td class="col-examnat">${escapeHtml(c.nationality || '—')}</td>
      <td>${escapeHtml(c.courseNumber || '—')}</td>
      <td class="col-examstartdate">${escapeHtml(c.startDate || arkkanCourseDate(c) || '—')}</td>
      ${cells(c)}
      <td class="col-examdate">${arkkanExamDateCellHtml(c)}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-arkkan-exam-one="${escapeHtml(c.clientId)}" style="padding:2px 12px; font-size:12px;">جلب</button></td>
      <td id="arkkan-exam-status-${cssEscapeId(c.clientId)}"><span style="color:var(--text-muted);">في الانتظار</span></td>
    </tr>`).join('');
  }

  if (nbody) {
    nbody.innerHTML = needing.map(c => `
    <tr id="arkkan-exam-row-${cssEscapeId(c.clientId)}">
      <td>${escapeHtml(c.name || '—')}</td>
      <td>${escapeHtml(c.clientId)}</td>
      <td class="col-examnat">${escapeHtml(c.nationality || '—')}</td>
      <td>${escapeHtml(c.courseNumber || '—')}</td>
      <td class="col-examstartdate">${escapeHtml(c.startDate || arkkanCourseDate(c) || '—')}</td>
      ${cells(c)}
      <td class="col-examdate">${arkkanExamDateCellHtml(c)}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-arkkan-exam-one="${escapeHtml(c.clientId)}" style="padding:2px 12px; font-size:12px;">جلب</button></td>
      <td id="arkkan-exam-status-${cssEscapeId(c.clientId)}"><span style="color:var(--text-muted);">في الانتظار</span></td>
    </tr>`).join('');
  }

  if (pbody) {
    pbody.innerHTML = passed.map(c => `
    <tr id="arkkan-exam-row-${cssEscapeId(c.clientId)}">
      <td>${escapeHtml(c.name || '—')}</td>
      <td>${escapeHtml(c.clientId)}</td>
      <td class="col-examnat">${escapeHtml(c.nationality || '—')}</td>
      <td>${escapeHtml(c.courseNumber || '—')}</td>
      <td class="col-examstartdate">${escapeHtml(c.startDate || arkkanCourseDate(c) || '—')}</td>
      ${cells(c)}
      <td class="col-examdate">${arkkanExamDateCellHtml(c)}</td>
      <td id="arkkan-exam-status-${cssEscapeId(c.clientId)}"><span style="color:var(--success, green); font-weight:600;">ناجح ✓</span></td>
    </tr>`).join('');
  }

  if (fbody) {
    fbody.innerHTML = failed.map(c => `
    <tr id="arkkan-exam-row-${cssEscapeId(c.clientId)}">
      <td>${escapeHtml(c.name || '—')}</td>
      <td>${escapeHtml(c.clientId)}</td>
      <td class="col-examnat">${escapeHtml(c.nationality || '—')}</td>
      <td>${escapeHtml(c.courseNumber || '—')}</td>
      <td class="col-examstartdate">${escapeHtml(c.startDate || arkkanCourseDate(c) || '—')}</td>
      ${cells(c)}
      <td class="col-examdate">${arkkanExamDateCellHtml(c)}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-arkkan-exam-one="${escapeHtml(c.clientId)}" style="padding:2px 12px; font-size:12px;">جلب</button></td>
      <td id="arkkan-exam-status-${cssEscapeId(c.clientId)}"><span style="color:var(--text-muted);">في الانتظار</span></td>
    </tr>`).join('');
  }

  // أثناء أي عملية جارية: أزرار الصفوف الجديدة تبدأ معطّلة (منع ازدواج الجلب)
  arkkanExamSyncRunButtons();
  // أزرار «آخر التغييرات» بجانب التصدير — تظهر فقط للصناديق التي عندها تقرير محفوظ
  try { arkkanSyncLastChangesButtons(); } catch (e) { }
}

function arkkanRefreshExamCells(c) {
  const row = document.querySelector(`#arkkan-exam-row-${cssEscapeId(c.clientId)}`);
  if (!row) return;
  const att = Array.isArray(c.examAttempts) ? c.examAttempts : [];
  [...row.querySelectorAll('.col-exam-attempt')].forEach((el, i) => {
    el.innerHTML = att[i] ? arkkanExamCell(att[i]) : '<span style="color:var(--text-muted);">—</span>';
  });
  const de = row.querySelector('.col-examdate');
  if (de) de.innerHTML = arkkanExamDateCellHtml(c);
}

async function arkkanExamSyncOne(clientId, btn) {
  const c = (clients || []).find(x => String(x.clientId) === String(clientId));
  if (!c) return;
  if (arkkanExamPassed(c)) { showToast('العميل ناجح — نتائجه مكتملة في صندوق النجاح', 'info'); return; }
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }
  if (!ARKKAN_IS_DESKTOP) { showToast('لا يمكن الجلب من المتصفح — استخدم تطبيق سطح المكتب حيث يعمل الوكيل المحلي مدمجاً تلقائياً', 'info'); return; }
  // قفل واحد لكل العمليات: يمنع جلب صفين معاً أو صف أثناء جلب جماعي
  if (_arkkanExamRunLock.active) { arkkanExamRunBusyMessage(); return; }
  arkkanExamAcquireRunLock('جلب نتيجة عميل', { stoppable: false });

  const _safeId = cssEscapeId(clientId);
  // نبحث دائماً عن الزر/الحالة الحيّين في الصفحة (الجدول قد يُعاد رسمه)
  const _btnNow = () => (document.querySelector(`#arkkan-exam-row-${_safeId} [data-arkkan-exam-one]`)
    || (btn && btn.isConnected ? btn : null));
  const _stNow = () => document.getElementById('arkkan-exam-status-' + _safeId);

  // ── تغذية بصرية فورية ──
  const t0 = Date.now();
  const setBusy = (txt) => { const b = _btnNow(); if (b) { b.disabled = true; b.textContent = txt; } };
  const setStatus = (html) => { const st = _stNow(); if (st) st.innerHTML = html; };
  setBusy('⏳ جارٍ…');
  setStatus('<span style="color:var(--gold,#b8860b);">⏳ جارٍ الجلب من أركان… 0 ث</span>');
  // عدّاد ثواني: يثبت للمستخدم أن العملية شغالة حتى لو استغرق أركان دقيقة
  const timer = setInterval(() => {
    const s = Math.max(0, Math.round((Date.now() - t0) / 1000));
    setStatus(`<span style="color:var(--gold,#b8860b);">⏳ جارٍ الجلب من أركان… ${s} ث</span>`);
  }, 1000);

  try {
    const data = await arkkanExamFetchOne(c.clientId, c.referNum || '');
    const patch = arkkanPatchExamsFromData(c, data);
    // نلتقط الحالة قبل التعديل — لعرض تقرير «تغيّرت حالته إلى ناجح/راسب» بعد الجلب
    const beforeKind = arkkanExamKind(c);
    const beforeTxt = arkkanExamResultText(c);
    const boxLabel = arkkanExamBoxLabelOf(c.clientId);
    const idx = clients.findIndex(x => String(x.clientId) === String(clientId));
    if (idx !== -1) Object.assign(clients[idx], patch);
    if (typeof saveClients === 'function') await saveClients();
    // تسجيل الفحص حتى يتخطاه الجلب الجماعي التالي (لا يُعاد جلب نفس العميل بلا داعٍ)
    if (idx !== -1) clients[idx].arkkanExamCheck = { s: arkkanExamSig(clients[idx]), t: Date.now() };
    _examSession[String(clientId)] = arkkanExamSig(clients[idx] || c);
    const passed = idx !== -1 && arkkanExamPassed(clients[idx]);
    const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
    // إعادة الرسم: الناجح ينتقل إلى صندوق النجاح ويختفي من قائمة الجلب
    renderArkkanExamsTable();
    // تقرير التغيير: ناجح/راسب (فردي — نافذة صغيرة بنفس الشكل)
    const _chg = idx !== -1 ? arkkanExamChangeOf(clients[idx], beforeKind, beforeTxt, boxLabel) : null;
    if (_chg) arkkanShowExamChangesReport([_chg], 'تغيّرت حالة العميل بعد الجلب');
    setStatus(passed
      ? '<span style="color:var(--success, green);">✅ ناجح — انتقل إلى صندوق النجاح</span>'
      : `<span style="color:var(--success, green);">✅ تم — ${secs} ث</span>`);
    showToast(passed ? 'تم الجلب — العميل ناجح' : 'تم جلب نتيجة الاختبار ✅', 'success');
  } catch (err) {
    const msg = String((err && err.message) || err || 'خطأ غير معروف');
    setStatus(`<span style="color:var(--danger, red);" title="${escapeHtml(msg)}">❌ ${escapeHtml(msg.slice(0, 80))}</span>`);
    showToast('تعذّر الجلب: ' + msg.slice(0, 90), 'error');
  } finally {
    clearInterval(timer);
    const b = _btnNow(); if (b) { b.disabled = false; b.textContent = 'جلب'; }
    arkkanExamReleaseRunLock();
  }
}

/* مذكّرة الجلسة: آخر نتيجة جلب لكل عميل — عند إعادة الجلب لا يُعاد جلب من لم تتغير بياناته */
const _examSession = {};
function arkkanExamSig(c) {
  return JSON.stringify([
    Array.isArray(c.examAttempts) ? c.examAttempts : [],
    c.examLastDate || '',
    c.examResult || '',
    c.examAppointment || '',
    c.examAppointmentDate || ''
  ]);
}

/* نافذة الاستئناف: علامة فحص محفوظة على العميل نفسه (arkkanExamCheck / arkkanDataCheck)
   تجعل إعادة تشغيل الجلب/المزامنة تتخطى من فُحصوا حديثاً وبياناتهم ثابتة — حتى بعد
   تحديث الصفحة أو إغلاقها — فيكمل من حيث توقف بدل إعادة الجلب من الصفر.
   المدة قابلة للضبط من حقل "فترة تخطي الفحص المُعاد (ساعات)" في هذا التبويب
   وتُحفظ في settings.arkkanResumeHours — أو يدوياً عبر window.ARKKAN_RESUME_HOURS؛
   الافتراضي 24 ساعة. */
function arkkanResumeMs() {
  let h = settings && settings.arkkanResumeHours;
  if (!(Number(h) > 0)) h = parseInt(window.ARKKAN_RESUME_HOURS || '24', 10) || 24;
  return Number(h) * 3600 * 1000;
}

/* مزامنة حقل "فترة تخطي الفحص المُعاد" في التبويب مع الإعداد المحفوظ */
function arkkanResumeFieldSync() {
  const el = $('#set-arkkan-resume-hours');
  if (!el) return;
  const h = settings && settings.arkkanResumeHours;
  const v = Number(h) > 0 ? Number(h) : (parseInt(window.ARKKAN_RESUME_HOURS || '24', 10) || 24);
  if (String(el.value) !== String(v)) el.value = v;
}

/* نافذة استئناف المقارنة مع أركان — عدد ساعات مستقل تماماً عن نافذة الجلب:
   علامة arkkanCompareCheck تُحفظ على العميل بعد فحصه بالمقارنة وتجعله يُتخطى
   خلال هذه النافذة عند إعادة تشغيل مقارنة موقوفة (فيكمل من حيث توقف).
   تُضبط من حقل "فترة تخطي المقارنة المُعاد" في التبويب وتُحفظ في
   settings.arkkanCompareResumeHours — أو بـ window.ARKKAN_COMPARE_RESUME_HOURS؛
   الافتراضي 24 ساعة. */
function arkkanCompareResumeMs() {
  let h = settings && settings.arkkanCompareResumeHours;
  if (!(Number(h) > 0)) h = parseInt(window.ARKKAN_COMPARE_RESUME_HOURS || '24', 10) || 24;
  return Number(h) * 3600 * 1000;
}

/* مزامنة حقل "فترة تخطي المقارنة المُعاد" في التبويب مع الإعداد المحفوظ */
function arkkanCompareResumeFieldSync() {
  const el = $('#set-arkkan-compare-resume-hours');
  if (!el) return;
  const h = settings && settings.arkkanCompareResumeHours;
  const v = Number(h) > 0 ? Number(h) : (parseInt(window.ARKKAN_COMPARE_RESUME_HOURS || '24', 10) || 24);
  if (String(el.value) !== String(v)) el.value = v;
}

async function arkkanExamSyncCard(clientId, btn) {
  const c = (clients || []).find(x => String(x.clientId) === String(clientId));
  if (!c) return;
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }
  if (!ARKKAN_IS_DESKTOP) { showToast('لا يمكن الجلب من المتصفح — استخدم تطبيق سطح المكتب حيث يعمل الوكيل المحلي مدمجاً تلقائياً', 'info'); return; }
  if (!clientEligibleForArkkanExams(c)) { showToast('لا يمكن جلب نتيجة الاختبار — لازم يكون عند المتدرب رقم دورة أولاً', 'error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ المزامنة...'; }
  try {
    const data = await arkkanExamFetchOne(c.clientId, c.referNum || '');
    const patch = arkkanPatchExamsFromData(c, data);
    // الحالة قبل التعديل — لتقرير «تغيّرت حالته إلى ناجح/راسب»
    const beforeKind = arkkanExamKind(c);
    const beforeTxt = arkkanExamResultText(c);
    const boxLabel = arkkanExamBoxLabelOf(c.clientId);
    const idx = clients.findIndex(x => String(x.clientId) === String(clientId));
    if (idx !== -1) Object.assign(clients[idx], patch);
    if (typeof saveClients === 'function') await saveClients();
    _examSession[String(clientId)] = arkkanExamSig(clients[idx] || c);
    const exam = arkkanExamStatusOf(clients[idx] || c);
    const has = exam && String(exam.r).trim();
    const msg = has
      ? (String(exam.r).includes('ناجح')
        ? '✅ النتيجة محفّزة: ناجح'
        : String(exam.r).includes('راسب') ? 'النتيجة محدّثة: راسب' : 'تم تحديث النتيجة: ' + String(exam.r))
      : 'تمت المزامنة — لا توجد نتيجة اختبار مسجّلة بعد';
    // تحديث شارة الاسم في شيت العملاء وصناديق النتائج فوراً
    if (typeof renderTable === 'function') renderTable();
    if (typeof renderArkkanExamsTable === 'function') renderArkkanExamsTable();
    const cse = $('#cw-exam-section .cw-exam-content');
    if (cse && typeof arkkanExamCardContent === 'function') cse.innerHTML = arkkanExamCardContent(clients[idx] || c);
    const _chg = idx !== -1 ? arkkanExamChangeOf(clients[idx], beforeKind, beforeTxt, boxLabel) : null;
    if (_chg) arkkanShowExamChangesReport([_chg], 'تغيّرت حالة العميل بعد المزامنة');
    showToast(msg, has ? 'success' : 'info');
  } catch (err) {
    showToast('فشل جلب النتيجة: ' + (err.message || err), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 مزامنة النتيجة'; }
  }
}

/* حالة كل جلب جماعي منفصلة (صندوق النتائج / صندوق الراسبين) */
const _examBulkStates = {};
function examBulkState(name) {
  return _examBulkStates[name] || (_examBulkStates[name] = { running: false, stop: false });
}

/* ══════════════════════════════════════════════════════════════
   تقرير تغيّر الحالة بعد الجلب: من أصبح «ناجح» ومن أصبح «راسب»
   --------------------------------------------------------------
   قبل التعديل: المستخدم كان يرى في الصف لحظة الجلب فقط «تم» أو
   «ناجح — انتقل»، ثم يختفي الأثر بعد إعادة رسم الجدول، فلا يعرف
   مَن تغيّرت حالته فعلاً ضمن دفعة كبيرة.
   الآن:
   - نسجّل كل عميل انتقلت حالته (قبل → بعد) إلى ناجح أو راسب.
   - بعد انتهاء الجلب/المقارنة تظهر نافذة بالاسم والهوية والدورة
     والنتيجة قبل وبعد والدرجة، مع أزرار نسخ وتصدير Excel.
   - يُحفظ آخر تقرير لكل صندوق ويُعاد فتحه من زر «📋 آخر التغييرات»
     الموجود بجانب زر التصدير في نفس الصندوق.
   ══════════════════════════════════════════════════════════════ */
var ARKKAN_LAST_CHANGES_KEY = 'ftc2_arkkan_last_changes_v1';

/* تصنيف حالة العميل: passed / failed / '' */
function arkkanExamKind(c) {
  if (!c) return '';
  if (typeof arkkanExamPassed === 'function' && arkkanExamPassed(c)) return 'passed';
  if (typeof arkkanExamFailed === 'function' && arkkanExamFailed(c)) return 'failed';
  return '';
}

/* نص النتيجة المعروض (ناجح/راسب + الدرجة) أو «بدون نتيجة» */
function arkkanExamResultText(c) {
  var s = typeof arkkanExamStatusOf === 'function' ? arkkanExamStatusOf(c) : null;
  var r = s && String(s.r || '').trim();
  if (!r) return 'بدون نتيجة';
  var g = String(s.g || '').trim();
  return r + (g ? ' (' + g + ')' : '');
}

/* اسم الصندوق الذي كان فيه العميل قبل الجلب (يُقرأ من الصف الظاهر حالياً) */
function arkkanExamBoxLabelOf(clientId) {
  try {
    var row = document.getElementById('arkkan-exam-row-' + cssEscapeId(clientId));
    if (!row) return '';
    var box = row.closest ? row.closest('[id^="arkkan-box-"]') : null;
    var map = {
      'arkkan-box-noresult': 'صندوق النتائج (بلا نتيجة)',
      'arkkan-box-needing': 'يحتاج إلى اختبار',
      'arkkan-box-passed': 'صندوق النجاح',
      'arkkan-box-failed': 'صندوق الراسبين'
    };
    return (box && map[box.id]) || '';
  } catch (e) { return ''; }
}

/* سجل تغيير واحد — أو null لو لم تنتقل الحالة إلى ناجح/راسب */
function arkkanExamChangeOf(c, beforeKind, beforeText, boxLabel) {
  if (!c) return null;
  var afterKind = arkkanExamKind(c);
  if (!afterKind || afterKind === String(beforeKind || '')) return null;
  var s = typeof arkkanExamStatusOf === 'function' ? arkkanExamStatusOf(c) : null;
  return {
    clientId: String(c.clientId || ''),
    name: String(c.name || ''),
    nationality: String(c.nationality || ''),
    company: String(c.companyName || ''),
    course: String(c.courseType || ''),
    courseNumber: String(c.courseNumber || ''),
    referNum: String(c.referNum || ''),
    before: beforeText || 'بدون نتيجة',
    after: arkkanExamResultText(c),
    kind: afterKind,
    grade: String((s && s.g) || ''),
    date: String((s && s.d) || '') || String(c.examLastDate || ''),
    box: boxLabel || ''
  };
}

/* ── حفظ/قراءة آخر تقرير لكل صندوق (يبقى بعد إغلاق البرنامج) ── */
function arkkanReadLastChangesMap() {
  try {
    var raw = localStorage.getItem(ARKKAN_LAST_CHANGES_KEY);
    var o = raw ? JSON.parse(raw) : {};
    return (o && typeof o === 'object') ? o : {};
  } catch (e) { return {}; }
}
function arkkanLastChangesFor(prefix) {
  var m = arkkanReadLastChangesMap();
  return (prefix && m[prefix]) || null;
}
function arkkanStoreLastChanges(prefix, report) {
  if (!prefix) return;
  try {
    var m = arkkanReadLastChangesMap();
    var items = (report && Array.isArray(report.items)) ? report.items : [];
    var passed = items.filter(function (i) { return i && i.kind === 'passed'; }).length;
    m[prefix] = {
      title: (report && report.title) || 'تقرير تغيّر الحالة',
      ts: (report && report.ts) || new Date().toISOString(),
      total: items.length,
      passed: passed,
      failed: items.length - passed,
      items: items
    };
    localStorage.setItem(ARKKAN_LAST_CHANGES_KEY, JSON.stringify(m));
  } catch (e) { /* تخزين غير متاح */ }
  arkkanSyncLastChangesButtons();
}

/* زر «آخر التغييرات» بجانب زر التصدير في كل صندوق.
   يظهر دائماً — حتى قبل أول جلب — ليكون واضحاً أن الخاصية موجودة؛
   ويعرض عدد من تغيّرت حالته في آخر تشغيل، و(0) لو لم يتغيّر أحد. */
function arkkanSyncLastChangesButtons() {
  try {
    ((typeof ARKKAN_EXAM_BOXES !== 'undefined' && ARKKAN_EXAM_BOXES) || []).forEach(function (box) {
      var anchor = document.getElementById('btn-' + box.prefix + '-export');
      if (!anchor || !anchor.parentNode) return;
      var id = 'btn-' + box.prefix + '-lastchanges';
      var btn = document.getElementById(id);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = id;
        btn.className = 'btn btn-ghost btn-sm';
        btn.setAttribute('data-arkkan-lastchanges', box.prefix);
        anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      }
      var rep = arkkanLastChangesFor(box.prefix);
      var n = rep && Array.isArray(rep.items) ? rep.items.length : 0;
      var when = rep && rep.ts ? new Date(rep.ts).toLocaleString('ar-SA-u-nu-latn') : '';
      btn.style.display = '';
      btn.textContent = '📋 آخر التغييرات' + (rep ? ' (' + n + ')' : '');
      if (!rep) {
        btn.title = 'لسه مفيش جلب من أركان — بعد أول جلب تظهر هنا أسماء من تغيّرت حالته إلى ناجح أو راسب';
        btn.style.opacity = '0.65';
      } else if (n) {
        var p = rep.passed || 0;
        btn.title = 'آخر جلب: ' + when + ' — ناجح: ' + p + ' · راسب: ' + (n - p);
        btn.style.opacity = '';
      } else {
        btn.title = 'آخر جلب: ' + when + ' — لم تتغيّر حالة أي عميل إلى ناجح أو راسب';
        btn.style.opacity = '0.8';
      }
    });
  } catch (e) { /* ليست صفحة أركان */ }
}

document.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest ? e.target.closest('[data-arkkan-lastchanges]') : null;
  if (!btn) return;
  var rep = arkkanLastChangesFor(btn.getAttribute('data-arkkan-lastchanges'));
  if (rep && Array.isArray(rep.items) && rep.items.length) {
    arkkanRenderChangesModal(rep.items, rep.title || 'آخر تغييرات الحالة', rep.ts);
  } else if (rep) {
    showToast('آخر جلب (' + (rep.ts ? new Date(rep.ts).toLocaleString('ar-SA-u-nu-latn') : '') + '): لم تتغيّر حالة أي عميل إلى ناجح أو راسب', 'info');
  } else {
    showToast('لسه مفيش تقرير لهذا الصندوق — يعمل «جلب» أو «مقارنة» أولاً', 'info');
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { arkkanSyncLastChangesButtons(); });
} else {
  arkkanSyncLastChangesButtons();
}

/* ── نافذة التقرير ── */
function arkkanChangesCopyText(items, title, ts) {
  var head = ['الاسم', 'رقم الهوية', 'الجنسية', 'الشركة', 'الدورة', 'رقم الدورة', 'النتيجة قبل', 'النتيجة بعد', 'تاريخ آخر اختبار', 'الصندوق'];
  var lines = [String(title || 'تقرير تغيّر الحالة') + (ts ? ' — ' + new Date(ts).toLocaleString('ar-SA-u-nu-latn') : ''), head.join('\t')];
  items.forEach(function (i) {
    lines.push([i.name, i.clientId, i.nationality, i.company, i.course, i.courseNumber, i.before, i.after, i.date, i.box].join('\t'));
  });
  return lines.join('\n');
}

function arkkanChangesExportRows(items) {
  return items.map(function (i) {
    return {
      'الاسم': i.name,
      'رقم الهوية': i.clientId,
      'رقم المتابعة': i.referNum,
      'الجنسية': i.nationality,
      'الشركة': i.company,
      'الدورة': i.course,
      'رقم الدورة': i.courseNumber,
      'النتيجة قبل': i.before,
      'النتيجة بعد': i.after,
      'الحالة الجديدة': i.kind === 'passed' ? 'ناجح' : 'راسب',
      'الدرجة': i.grade,
      'تاريخ آخر اختبار': i.date,
      'الصندوق': i.box
    };
  });
}

function arkkanRenderChangesModal(items, title, ts) {
  var list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return;
  var prev = document.getElementById('arkkan-changes-overlay');
  if (prev) prev.remove();

  var passed = list.filter(function (i) { return i.kind === 'passed'; }).length;
  var failed = list.length - passed;
  var sorted = list.slice().sort(function (a, b) {
    if (a.kind !== b.kind) return a.kind === 'passed' ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ar');
  });
  var chip = function (txt, color, bg) {
    return '<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-weight:700;font-size:12px;color:' + color + ';background:' + bg + ';">' + txt + '</span>';
  };
  var td = 'padding:8px 10px;border-bottom:1px solid var(--border);';
  var rowsHtml = sorted.map(function (i) {
    var st = i.kind === 'passed'
      ? chip('ناجح ✓', 'var(--success)', 'rgba(4,120,87,.12)')
      : chip('راسب', 'var(--danger)', 'rgba(190,18,60,.12)');
    var afterCell = st + (i.grade ? ' <span style="color:var(--text-secondary);font-size:12px;">(' + escapeHtml(i.grade) + ')</span>' : '');
    return '<tr>' +
      '<td style="' + td + 'white-space:nowrap;">' + escapeHtml(i.name || '—') + '</td>' +
      '<td style="' + td + 'white-space:nowrap;">' + escapeHtml(i.clientId || '—') + '</td>' +
      '<td style="' + td + '">' + escapeHtml(i.course || '—') +
        (i.courseNumber ? ' <span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(i.courseNumber) + '</span>' : '') + '</td>' +
      '<td style="' + td + 'color:var(--text-secondary);white-space:nowrap;">' + escapeHtml(i.before) + '</td>' +
      '<td style="' + td + 'white-space:nowrap;">' + afterCell + '</td>' +
      '<td style="' + td + 'white-space:nowrap;color:var(--text-secondary);">' + escapeHtml(i.date || '—') + '</td>' +
      '<td style="' + td + 'color:var(--text-secondary);">' + escapeHtml(i.box || '—') + '</td>' +
      '</tr>';
  }).join('');

  var overlay = document.createElement('div');
  overlay.id = 'arkkan-changes-overlay';
  overlay.setAttribute('dir', 'rtl');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
  overlay.innerHTML =
    '<div role="dialog" aria-modal="true" aria-label="تقرير تغيّر الحالة" style="background:var(--surface-solid);border:1px solid var(--border);border-radius:20px;box-shadow:0 24px 64px rgba(15,23,42,.3);width:100%;max-width:1000px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;">' +
      '<div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:220px;">' +
          '<div style="font-weight:800;font-size:16px;">' + escapeHtml(title) + '</div>' +
          '<div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">' + (ts ? escapeHtml(new Date(ts).toLocaleString('ar-SA-u-nu-latn')) : '') + '</div>' +
        '</div>' +
        (passed ? chip('ناجح: ' + passed, 'var(--success)', 'rgba(4,120,87,.12)') : '') +
        (failed ? chip('راسب: ' + failed, 'var(--danger)', 'rgba(190,18,60,.12)') : '') +
        '<button type="button" id="arkkan-changes-close-x" style="border:none;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:var(--text-secondary);padding:2px 6px;" title="إغلاق">×</button>' +
      '</div>' +
      '<div style="overflow:auto;padding:0 6px 6px;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
          '<thead><tr style="position:sticky;top:0;background:var(--surface-alt);z-index:1;">' +
            ['الاسم', 'رقم الهوية', 'الدورة', 'النتيجة قبل', 'الحالة الجديدة', 'تاريخ آخر اختبار', 'الصندوق'].map(function (h) {
              return '<th style="padding:9px 10px;text-align:right;font-weight:700;color:var(--text-secondary);border-bottom:1px solid var(--border);white-space:nowrap;">' + h + '</th>';
            }).join('') +
          '</tr></thead><tbody>' + rowsHtml + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">' +
        '<button type="button" class="btn btn-ghost btn-sm" id="arkkan-changes-copy">📋 نسخ الجدول</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="arkkan-changes-xlsx">📤 تصدير Excel</button>' +
        '<button type="button" class="btn btn-gold btn-sm" id="arkkan-changes-close">إغلاق</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  var close = function () {
    var el = document.getElementById('arkkan-changes-overlay');
    if (el) el.remove();
    document.removeEventListener('keydown', onKey);
  };
  var onKey = function (e) { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
  var bx = document.getElementById('arkkan-changes-close-x');
  if (bx) bx.onclick = close;
  var bc = document.getElementById('arkkan-changes-close');
  if (bc) bc.onclick = close;

  var copyBtn = document.getElementById('arkkan-changes-copy');
  if (copyBtn) copyBtn.onclick = async function () {
    var txt = arkkanChangesCopyText(sorted, title, ts);
    try {
      await navigator.clipboard.writeText(txt);
      showToast('تم نسخ تقرير التغييرات', 'success');
    } catch (e) {
      try {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        showToast('تم نسخ تقرير التغييرات', 'success');
      } catch (e2) { showToast('تعذّر النسخ', 'error'); }
    }
  };

  var xlsBtn = document.getElementById('arkkan-changes-xlsx');
  if (xlsBtn) xlsBtn.onclick = function () {
    try {
      var stamp = new Date().toISOString().slice(0, 10);
      downloadXlsx('تقرير_تغير_الحالة_' + stamp + '.xlsx', 'تغير الحالة', arkkanChangesExportRows(sorted));
      showToast('تم تصدير تقرير التغييرات', 'success');
    } catch (e) { showToast('تعذّر التصدير: ' + (e.message || e), 'error'); }
  };
}

/* نقطة الدخول: عرض التقرير (ويعرض ملخصاً مختصراً فوقه) */
function arkkanShowExamChangesReport(items, title, opts) {
  opts = opts || {};
  var list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return;
  var ts = new Date().toISOString();
  if (opts.prefix) {
    arkkanStoreLastChanges(opts.prefix, { title: title || 'تقرير تغيّر الحالة', ts: ts, items: list });
  }
  var passed = list.filter(function (i) { return i.kind === 'passed'; }).length;
  var failed = list.length - passed;
  try {
    showToast('تغيّرت حالة ' + list.length + ' عميل — ناجح: ' + passed + ' · راسب: ' + failed, 'success');
  } catch (e) { /* لا شيء */ }
  arkkanRenderChangesModal(list, title || 'تقرير تغيّر الحالة', ts);
}

/* مشغّل صندوق عام — جلب (fetch) أو مقارنة (compare) — كل صندوق بعناصره وصفوفه.
   المقارنة: تراجع كل عميل من أركان، توازن المخزَّن بالمستخرج، وتحفظ أي اختلاف تلقائياً */
async function arkkanExamBoxRun({ name, prefix, getRows, startSel, stopSel, progressSel, counterSel, doneMsg, mode }) {
  const compare = mode === 'compare';
  const st = examBulkState(name);
  if (st.running) {
    showToast('العملية شغالة بالفعل في هذا الصندوق — اضغط «إيقاف» أولاً', 'info');
    return;
  }
  if (_arkkanExamRunLock.active) { arkkanExamRunBusyMessage(); return; }
  if (_arkkanBulkRunning) { showToast('المزامنة الكاملة شغالة بالفعل — استنى لحد ما تخلص', 'info'); return; }
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }
  // الجلب/المقارنة هنا يعتمدان على الوكيل المحلي (Playwright على localhost:9955) —
  // وده متاح فقط من تطبيق سطح المكتب. بدون هذا الفحص، نسخة الويب كانت تحاول الاتصال
  // بالوكيل لكل عميل على حدة وتفشل واحداً واحداً بدل ما توضّح السبب من البداية.
  if (!ARKKAN_IS_DESKTOP) {
    showToast('لا يمكن الجلب/المقارنة من المتصفح — استخدم تطبيق سطح المكتب حيث يعمل الوكيل المحلي مدمجاً تلقائياً', 'info');
    return;
  }

  st.running = true;
  st.stop = false;
  const _boxMeta = ARKKAN_EXAM_BOXES.find(b => b.prefix === prefix);
  arkkanExamAcquireRunLock((compare ? 'مقارنة ' : 'جلب ') + (_boxMeta ? _boxMeta.label : 'نتائج الاختبارات'), {
    prefix: prefix, name: name, stoppable: true
  });

  const startBtn = $(startSel);
  const stopBtn = $(stopSel);
  const progress = $(progressSel);
  const wrap = $(progressSel.replace('progress', 'progress-wrap'));
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) { stopBtn.style.display = ''; stopBtn.disabled = false; stopBtn.textContent = '⏹ إيقاف'; }
  if (wrap) wrap.style.display = '';

  /* استئناف حقيقي: نستبعد المفحوصين حديثاً *قبل* بدء اللوب (نفس نمط arkkanBulkSync) —
     فلو وقّفت الصندوق وشغّلته تاني، العدّاد وشريط التقدّم يعكسان المتبقي الفعلي فقط،
     بدل ما يعيدا عرض/عدّ كل الصفوف من الأول وهو بيتخطاها بسرعة من جوه اللوب. */
  const rowsAll = prefix ? arkkanExamApplyFilters(getRows(), prefix) : getRows();
  const ff = prefix ? arkkanExamFilterState(prefix) : null;
  const filterNote = ff && (ff.name || ff.id || ff.nat || ff.course || ff.company || ff.dateFrom || ff.dateTo || ff.year)
    ? '، على الصفوف المطابقة للفلتر الحالي'
    : '';
  const rows = rowsAll.filter(c => {
    const k = String(c.clientId);
    const cur = (clients || []).find(x => String(x.clientId) === k) || c;
    if (compare) {
      const cmpChk = cur && cur.arkkanCompareCheck;
      return !(cmpChk && Date.now() - cmpChk < arkkanCompareResumeMs());
    }
    const sigNow = arkkanExamSig(cur);
    const chk = cur && cur.arkkanExamCheck;
    const resumeSkip = chk && chk.s === sigNow && Date.now() - (chk.t || 0) < arkkanResumeMs();
    return !(resumeSkip || _examSession[k] === sigNow);
  });
  const rowsTotal = rows.length;
  const skipped0 = rowsAll.length - rowsTotal;
  let done = 0, updated = 0, same = 0, failed = 0, skipped = 0;
  /* تقرير التغييرات: كل من انتقلت حالته إلى ناجح/راسب خلال هذه العملية */
  const changes = [];
  const boxLabel = _boxMeta ? _boxMeta.label : '';

  /* صندوق فاضي: لا تشغيل ولا وميض لزر الإيقاف — رسالة واضحة فقط */
  if (rowsTotal === 0) {
    st.running = false;
    arkkanExamReleaseRunLock();
    if (startBtn) startBtn.style.display = '';
    if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.disabled = false; stopBtn.textContent = '⏹ إيقاف'; }
    if (wrap) wrap.style.display = 'none';
    showToast((compare ? 'لا يوجد عملاء يحتاجون مقارنة في هذا الصندوق' : 'لا يوجد عملاء يحتاجون جلباً في هذا الصندوق')
      + (skipped0 ? ` — ${skipped0} فُحصوا حديثاً` : ''), 'info');
    return;
  }
  arkkanRunbarSetProgress(0, rowsTotal);

  showToast((compare ? `بدأت المقارنة مع أركان: ${rowsTotal} عميل` : `بدأ الجلب: ${rowsTotal} عميل`)
    + (skipped0 ? ` (تخطّي ${skipped0} فُحصوا حديثاً)` : '') + filterNote, 'info');

  const diffText = (cur, srcResult) => {
    const os = arkkanExamStatusOf(cur);
    const oldTxt = os && String(os.r).trim() ? String(os.r) : 'بدون';
    const newTxt = String(srcResult || '').trim() ? String(srcResult) : 'بدون';
    return [oldTxt, newTxt];
  };

  /* حفظ متسلسل دائماً (حتى مع توازي الجلب): يمنع تنافس عاملين على كتابة نسخ
     كاملة من قائمة العملاء في نفس اللحظة (خاصة قبل تثبيت الـ baseline). */
  let saveChain = Promise.resolve();
  const queueSave = () => {
    const p = saveChain.then(() => (typeof saveClients === 'function' ? saveClients() : null));
    saveChain = p.then(() => {}, () => {});
    return p;
  };

  /* الوكيل المحلي صفحة متصفح واحدة — الجلب واحد وراء واحد (أي توازي يتعارض على نفس
     الصفحة ويسبب أخطاء). */
  const POOL = 1;
  let workerIdx = 0;

  const processOne = async () => {
    while (!st.stop) {
      const ci = workerIdx++;
      if (ci >= rowsTotal) return;
      const c = rows[ci];

      const k = String(c.clientId);
      const cur = (clients || []).find(x => String(x.clientId) === k) || c;
      const statusId = `#arkkan-exam-status-${cssEscapeId(k)}`;
      const stEl = $(statusId);

      /* الفلترة الأساسية (المفحوص حديثاً حسب arkkanExamCheck/arkkanCompareCheck) حدثت
         *قبل* بدء اللوب أعلاه. هذا الفحص هنا شبكة أمان فقط لحالة نادرة: عميل تغيّر
         توقيعه (sig) في نفس الجلسة بفعل معالجة صف آخر قبل ما يوصله الدور. */
      const sigNow = arkkanExamSig(cur);

      const skipEl =
        compare
          ? '<span style="color:var(--text-muted);">⏭️ فُحص حديثاً — تخطٍّ</span>'
          : '<span style="color:var(--text-muted);">⏭️ تم سابقاً — بلا تغيير</span>';
      const skipAndContinue = () => {
        skipped++;
        if (stEl) stEl.innerHTML = skipEl;
        done++;
        if (progress) progress.style.width = `${Math.round(done / Math.max(rowsTotal, 1) * 100)}%`;
        const counterEl = $(counterSel);
        if (counterEl) counterEl.textContent = compare
          ? `⏭️ ${skipped} · ⤭ ${same} · ✅ ${updated} · ❌ ${failed} · ${done}/${rowsTotal}`
          : `⤭ ${skipped} · ✅ ${updated} · ❌ ${failed} · ${done}/${rowsTotal}`;
      };
      if (!compare && _examSession[k] === sigNow) { skipAndContinue(); continue; }
      if (!compare && _examSession[k]) delete _examSession[k];

      if (stEl) stEl.innerHTML = '<span style="color:var(--gold);">⏳...</span>';

      const saveIfDiff = async (data, patch) => {
        const idx = clients.findIndex(x => String(x.clientId) === String(c.clientId));
        const sigNew = arkkanExamSig(Object.assign({}, cur, patch));
        if (arkkanExamSig(cur) === sigNew) {
          same++;
          /* مطابق بدون تغيير: نسجّل الفحص على المقارنة حتى لا يُعاد في نافذة
             التخطي الخاصة بها أثناء إعادة تشغيل مقارنة موقوفة (يُحفظ الختامي) */
          const idx0 = clients.findIndex(x => String(x.clientId) === String(c.clientId));
          if (idx0 !== -1) clients[idx0].arkkanCompareCheck = Date.now();
          _examSession[k] = sigNew;
          return null; // مطابق بدون تغيير
        }
        const beforeKind = arkkanExamKind(cur);
        const beforeTxt = arkkanExamResultText(cur);
        const [oldTxt, newTxt] = diffText(cur, data.lastResult);
        if (idx !== -1) {
          Object.assign(clients[idx], patch);
          clients[idx].arkkanCompareCheck = Date.now();
        }
        await queueSave();
        updated++;
        _examSession[k] = arkkanExamSig(clients[idx] || c);
        arkkanRefreshExamCells(clients[idx] || c);
        const chg = idx !== -1 ? arkkanExamChangeOf(clients[idx], beforeKind, beforeTxt, boxLabel) : null;
        if (chg) changes.push(chg);
        return [oldTxt, newTxt];
      };

      try {
        const data = await arkkanExamFetchOne(c.clientId, c.referNum || '');
        const patch = arkkanPatchExamsFromData(c, data);
        if (compare) {
          const diff = await saveIfDiff(data, patch);
          if (stEl) stEl.innerHTML = diff
            ? `<span style="color:#8e44ad;" title="قبل: ${escapeHtml(diff[0])} · بعد: ${escapeHtml(diff[1])}">✅ محدَّث: ${escapeHtml(diff[0])} → ${escapeHtml(diff[1])}</span>`
            : '<span style="color:var(--text-muted);">⏭️ مطابق للمخزَّن</span>';
        } else {
          const idx = clients.findIndex(x => String(x.clientId) === String(c.clientId));
          // الحالة قبل التعديل — لتقرير «تغيّرت حالته إلى ناجح/راسب»
          const beforeKind = arkkanExamKind(cur);
          const beforeTxt = arkkanExamResultText(cur);
          if (idx !== -1) {
            Object.assign(clients[idx], patch);
            clients[idx].arkkanExamCheck = { s: arkkanExamSig(clients[idx]), t: Date.now() };
          }
          await queueSave();
          updated++;
          _examSession[k] = arkkanExamSig(clients[idx] || c);
          arkkanRefreshExamCells(clients[clients.findIndex(x => String(x.clientId) === String(c.clientId))] || c);
          const chg = idx !== -1 ? arkkanExamChangeOf(clients[idx], beforeKind, beforeTxt, boxLabel) : null;
          if (chg) changes.push(chg);
          const passed = idx !== -1 && arkkanExamPassed(clients[idx]);
          if (stEl) stEl.innerHTML = passed
            ? '<span style="color:var(--success, green);">✅ ناجح — انتقل إلى صندوق النجاح</span>'
            : '<span style="color:var(--success, green);">✅ تم</span>';
        }
      } catch (err) {
        /* فشل عابر (بطء شبكة/تحميل) — محاولة واحدة تلقائية قبل اعتبار العميل فاشلاً */
        let ok = false;
        try {
          if (stEl) stEl.innerHTML = '<span style="color:var(--gold);">⏳ محاولة ثانية...</span>';
          const data2 = await arkkanExamFetchOne(c.clientId, c.referNum || '');
          const patch2 = arkkanPatchExamsFromData(c, data2);
          if (compare) {
            const diff2 = await saveIfDiff(data2, patch2);
            if (stEl) stEl.innerHTML = diff2
              ? `<span style="color:#8e44ad;">✅ محدَّث (من المحاولة الثانية)</span>`
              : '<span style="color:var(--text-muted);">⏭️ مطابق (من المحاولة الثانية)</span>';
          } else {
            const idx2 = clients.findIndex(x => String(x.clientId) === String(c.clientId));
            // الحالة قبل التعديل (المحاولة الأولى لم تُطبّق أي patch)
            const beforeKind2 = arkkanExamKind(cur);
            const beforeTxt2 = arkkanExamResultText(cur);
            if (idx2 !== -1) {
              Object.assign(clients[idx2], patch2);
              clients[idx2].arkkanExamCheck = { s: arkkanExamSig(clients[idx2]), t: Date.now() };
            }
            await queueSave();
            _examSession[k] = arkkanExamSig(clients[idx2] || c);
            updated++;
            arkkanRefreshExamCells(clients[clients.findIndex(x => String(x.clientId) === String(c.clientId))] || c);
            const chg2 = idx2 !== -1 ? arkkanExamChangeOf(clients[idx2], beforeKind2, beforeTxt2, boxLabel) : null;
            if (chg2) changes.push(chg2);
            const passed2 = idx2 !== -1 && arkkanExamPassed(clients[idx2]);
            if (stEl) stEl.innerHTML = passed2
              ? '<span style="color:var(--success, green);">✅ ناجح — انتقل إلى صندوق النجاح</span>'
              : '<span style="color:var(--success, green);">✅ (من المحاولة الثانية)</span>';
          }
          ok = true;
        } catch (err2) { /* يبقى الخطأ الأخير */ }
        if (!ok) {
          failed++;
          delete _examSession[k];
          if (stEl) stEl.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">❌ فشل</span>`;
        }
      }

      done++;
      arkkanRunbarSetProgress(done, rowsTotal);
      if (progress) progress.style.width = `${Math.round(done / Math.max(rowsTotal, 1) * 100)}%`;
      const counter = $(counterSel);
      if (counter) counter.textContent = compare
        ? `⤭ ${same} مطابق · ✅ ${updated} محدَّث · ❌ ${failed} فشل · ${done}/${rowsTotal}`
        : `⤭ ${skipped} · ✅ ${updated} · ❌ ${failed} · ${done}/${rowsTotal}`;
    }
  };

  await Promise.all(Array.from({ length: Math.min(POOL, rowsTotal) }, () => processOne()));
  await queueSave(); // حفظ علامات التخطي المتبقية (مطابق/فُحص حديثاً)

  st.running = false;
  if (startBtn) startBtn.style.display = '';
  if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.disabled = false; stopBtn.textContent = '⏹ إيقاف'; }
  if (wrap) wrap.style.display = 'none';
  arkkanExamReleaseRunLock();
  renderArkkanExamsTable();
  showToast(compare
    ? `${doneMsg}: ${updated} حُدِّثت تلقائياً، ${same} مطابق، ${failed} فشل${skipped ? `، ${skipped} تجاوز (فُحص حديثاً)` : ''}`
      + (changes.length ? ` · تغيّرت حالة ${changes.length}` : ' · لا تغيّر في النجاح/الرسوب')
    : `${doneMsg}: ${updated} محدّث، ${failed} فشل، ${skipped} تخطّي (بلا تغيير)`
      + (changes.length ? ` · تغيّرت حالة ${changes.length}` : ' · لا تغيّر في النجاح/الرسوب'),
    updated > 0 ? 'success' : 'info');
  /* تقرير من تغيّرت حالته إلى ناجح/راسب — يظهر بعد انتهاء الجلب/المقارنة.
     يُحفظ دائماً (حتى لو صفر) حتى يعرف المستخدم أن الخاصية اشتغلت وأنه لا تغييرات. */
  var _repTitle = (compare ? 'تغيّرت الحالة بعد المقارنة مع أركان' : 'تغيّرت الحالة بعد الجلب من أركان')
    + (boxLabel ? ' — ' + boxLabel : '');
  if (changes.length) {
    arkkanShowExamChangesReport(changes, _repTitle, { prefix: prefix });
  } else {
    arkkanStoreLastChanges(prefix, { title: _repTitle, ts: new Date().toISOString(), items: [] });
  }
}

/* الجلب الجماعي = تشغيل الصندوق بوضع الجلب */
function arkkanExamBulkRun(opts) { return arkkanExamBoxRun(Object.assign({ mode: 'fetch' }, opts)); }

/* جلب جماعي في صندوق النتائج الرئيسي: بلا نتيجة بعد */
function arkkanExamsBulk() {
  return arkkanExamBulkRun({
    name: 'exams',
    prefix: 'arkkan-exams',
    getRows: arkkanExamClients,
    startSel: '#btn-arkkan-exams-start',
    stopSel: '#btn-arkkan-exams-stop',
    progressSel: '#arkkan-exams-progress',
    counterSel: '#arkkan-exams-counter',
    doneMsg: 'اكتمل جلب نتائج الاختبارات'
  });
}

/* جلب جماعي في صندوق الراسبين: مستقل، لو نجح عميل ينتقل لصندوق النجاح */
function arkkanExamsFailedBulk() {
  return arkkanExamBulkRun({
    name: 'failed',
    prefix: 'arkkan-exams-failed',
    getRows: arkkanExamFailedClients,
    startSel: '#btn-arkkan-exams-failed-start',
    stopSel: '#btn-arkkan-exams-failed-stop',
    progressSel: '#arkkan-exams-failed-progress',
    counterSel: '#arkkan-exams-failed-counter',
    doneMsg: 'اكتمل جلب نتائج الراسبين'
  });
}

/* جلب جماعي في صندوق "يحتاج إلى اختبار": مستقل — بظهور نتيجة ينتقل للصندوق المناسب */
function arkkanExamsNeedingBulk() {
  return arkkanExamBulkRun({
    name: 'needing',
    prefix: 'arkkan-exams-needing',
    getRows: arkkanExamNeedingClients,
    startSel: '#btn-arkkan-exams-needing-start',
    stopSel: '#btn-arkkan-exams-needing-stop',
    progressSel: '#arkkan-exams-needing-progress',
    counterSel: '#arkkan-exams-needing-counter',
    doneMsg: 'اكتمل جلب نتائج المحتاجين للاختبار'
  });
}

/* ═══════ مقارنة كل صندوق مع أركان: يراجع البيانات ويحفظ الاختلافات تلقائياً ═══════ */
function arkkanExamCompareRun({ name, prefix, getRows, startSel, stopSel, progressSel, counterSel, doneMsg }) {
  return arkkanExamBoxRun({ name, prefix, getRows, startSel, stopSel, progressSel, counterSel, doneMsg, mode: 'compare' });
}
function arkkanExamsCompare() {
  return arkkanExamCompareRun({
    name: 'exams', prefix: 'arkkan-exams', getRows: arkkanExamClients,
    startSel: '#btn-arkkan-exams-compare', stopSel: '#btn-arkkan-exams-stop',
    progressSel: '#arkkan-exams-progress', counterSel: '#arkkan-exams-counter',
    doneMsg: 'اكتملت مقارنة نتائج الاختبارات مع أركان'
  });
}
function arkkanExamsNeedingCompare() {
  return arkkanExamCompareRun({
    name: 'needing', prefix: 'arkkan-exams-needing', getRows: arkkanExamNeedingClients,
    startSel: '#btn-arkkan-exams-needing-compare', stopSel: '#btn-arkkan-exams-needing-stop',
    progressSel: '#arkkan-exams-needing-progress', counterSel: '#arkkan-exams-needing-counter',
    doneMsg: 'اكتملت مقارنة المحتاجين للاختبار'
  });
}
function arkkanExamsPassedCompare() {
  return arkkanExamCompareRun({
    name: 'passed', prefix: 'arkkan-exams-passed', getRows: arkkanExamPassedClients,
    startSel: '#btn-arkkan-exams-passed-compare', stopSel: '#btn-arkkan-exams-passed-stop',
    progressSel: '#arkkan-exams-passed-progress', counterSel: '#arkkan-exams-passed-counter',
    doneMsg: 'اكتملت مقارنة الناجحين'
  });
}
function arkkanExamsFailedCompare() {
  return arkkanExamCompareRun({
    name: 'failed', prefix: 'arkkan-exams-failed', getRows: arkkanExamFailedClients,
    startSel: '#btn-arkkan-exams-failed-compare', stopSel: '#btn-arkkan-exams-failed-stop',
    progressSel: '#arkkan-exams-failed-progress', counterSel: '#arkkan-exams-failed-counter',
    doneMsg: 'اكتملت مقارنة الراسبين'
  });
}

/* تحديث خلايا صف العميل بالبيانات الحالية (بعد كل جلب ناجح) */
function arkkanRefreshRowCells(c) {
  const row = document.querySelector(`#arkkan-row-${cssEscapeId(c.clientId)}`);
  if (!row) return;
  const set = (sel, val) => { const el = row.querySelector(sel); if (el) el.textContent = val || '—'; };
  set('.col-invoice', c.invoice);
  set('.col-coursenum', c.courseNumber);
  set('.col-date', c.receiptIssueDate);
  set('.col-courseprice', c.receiptActualValue);
  set('.col-startdate', c.startDate || arkkanCourseDate(c));
  set('.col-baginvoice', c.bagInvoice);
  set('.col-bagdate', c.bagPurchaseDate);
  const missEl = row.querySelector('.col-missing');
  if (missEl) missEl.textContent = arkkanMissingFields(c).map(f => ARKKAN_FIELD_LABELS[f]).join('، ');
}

/* ══════════════════════════════════════════════
   7) مقارنة بيانات الاختبارات مع أركان — زرار في كل صندوق
   يراجع كل عميل: يجلب نتيجته من أركان ويقارنها بالمخزَّنة —
   أي اختلاف يُحفَظ تلقائياً ويُوضَّح أمام كل عميل (قبل ← بعد)
   ══════════════════════════════════════════════ */

/* عند فتح تبويب مزامنة أركان: نعرض الجدولين ونحدّث الحالة */
document.addEventListener('click', e => {
  // أي نقرة داخل تبويب أركان (أزرار الشريط/الصفوف/الفلاتر/العنوان) لا تعيد رسم
  // الجداول: إعادة الرسم كانت تمسح حالة الصفوف الحيّة وتُعيد بناء 4 جداول
  // مع كل نقرة (بطء شديد مع آلاف العملاء). نُبقي التحديث عند التنقل للتبويب.
  if (e.target.closest?.('#view-arkkan-sync')) return;
  if (document.querySelector('#view-arkkan-sync')?.classList?.contains('active')) {
    arkkanResumeFieldSync();
    arkkanCompareResumeFieldSync();
    renderArkkanSyncTable();
    renderArkkanExamsTable();
  }
});

/* تفشيك/إلغاء «إيقاف» لعميل — يحفظ العلامة ويُعيد رسم الجدول.
   نستمع لحدث click (بدل change) لأن handler عام في نطاق التبويب كان يعيد رسم
   الجدول فيأتي قبل change فيدمر الـ checkbox قبل تسجيل التغيير — فكان يبدو الزرار
   غير شغال. معالج الرسم العام الآن يتجاهل مربعات «إيقاف» ويتركها لهذا المعالج. */
document.addEventListener('click', e => {
  const chk = e.target.closest('.arkkan-skip-chk');
  if (!chk) return;
  arkkanToggleSkip(chk.dataset.arkkanSkip);
});

document.addEventListener('change', e => {
  if (e.target && e.target.id === 'arkkan-sync-filter-year') { renderArkkanSyncTable(); }
});
document.addEventListener('click', e => {
  if (e.target && e.target.id === 'btn-arkkan-sync-filter-clear') {
    var el = document.getElementById('arkkan-sync-filter-year');
    if (el) el.value = '';
    renderArkkanSyncTable();
    return;
  }
  if (e.target.closest('[data-arkkan-one]')) { arkkanSyncOne(e.target.closest('[data-arkkan-one]').dataset.arkkanOne, e.target.closest('[data-arkkan-one]')); return; }
  if (e.target.closest('[data-arkkan-exam-one]')) { arkkanExamSyncOne(e.target.closest('[data-arkkan-exam-one]').dataset.arkkanExamOne, e.target.closest('[data-arkkan-exam-one]')); return; }
  if (e.target.closest('#btn-arkkan-check-agent')) { arkkanUpdateStatus(); return; }
  if (e.target.closest('#btn-arkkan-sync-check-agent')) { arkkanUpdateStatus(); return; }
  if (e.target.closest('#btn-arkkan-start-agent')) { arkkanStartAgent(); return; }
  if (e.target.closest('#btn-arkkan-stop-agent')) { arkkanStopAgent(); return; }
  if (e.target.closest('#btn-arkkan-runbar-stop')) { arkkanRunbarStop(); return; }
  if (e.target.closest('#btn-arkkan-bulk-start')) { arkkanBulkSync(); return; }
  if (e.target.closest('#btn-arkkan-bulk-stop')) { arkkanBulkRequestStop(e.target.closest('#btn-arkkan-bulk-stop')); return; }
  if (e.target.closest('#btn-arkkan-exams-start')) { arkkanExamsBulk(); return; }
  if (e.target.closest('#btn-arkkan-exams-stop')) { arkkanExamRequestStop('exams', e.target.closest('#btn-arkkan-exams-stop')); return; }
  if (e.target.closest('#btn-arkkan-exams-failed-start')) { arkkanExamsFailedBulk(); return; }
  if (e.target.closest('#btn-arkkan-exams-failed-stop')) { arkkanExamRequestStop('failed', e.target.closest('#btn-arkkan-exams-failed-stop')); return; }
  if (e.target.closest('#btn-arkkan-exams-needing-start')) { arkkanExamsNeedingBulk(); return; }
  if (e.target.closest('#btn-arkkan-exams-needing-stop')) { arkkanExamRequestStop('needing', e.target.closest('#btn-arkkan-exams-needing-stop')); return; }
  if (e.target.closest('#btn-arkkan-exams-compare')) { arkkanExamsCompare(); return; }
  if (e.target.closest('#btn-arkkan-exams-needing-compare')) { arkkanExamsNeedingCompare(); return; }
  if (e.target.closest('#btn-arkkan-exams-passed-compare')) { arkkanExamsPassedCompare(); return; }
  if (e.target.closest('#btn-arkkan-exams-failed-compare')) { arkkanExamsFailedCompare(); return; }
  if (e.target.closest('#btn-arkkan-exams-passed-stop')) { arkkanExamRequestStop('passed', e.target.closest('#btn-arkkan-exams-passed-stop')); return; }
});

/* ربط زر التبويب بالرسم (نفس نمط بقية الشاشات) */
function initArkkanSyncView() {
  const navBtn = document.querySelector('nav.tabs button[data-view="arkkan-sync"]');
  if (navBtn) {
    navBtn.addEventListener('click', () => {
      arkkanResumeFieldSync();
      arkkanCompareResumeFieldSync();
      renderArkkanSyncTable();
      renderArkkanExamsTable();
      arkkanUpdateStatus();
    });
  }
  arkkanUpdateStatus();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initArkkanSyncView);
else initArkkanSyncView();

/* حفظ فترتي التخطي (جلب / مقارنة) من حقليهما عند تغيير أي منهما */
document.addEventListener('change', async e => {
  const id = e.target && e.target.id;
  if (id === 'set-arkkan-resume-hours' || id === 'set-arkkan-compare-resume-hours') {
    const isCompare = id === 'set-arkkan-compare-resume-hours';
    const key = isCompare ? 'arkkanCompareResumeHours' : 'arkkanResumeHours';
    const v = Math.max(1, Math.min(720, parseInt(e.target.value, 10) || 24));
    if (!settings || typeof DEFAULT_SETTINGS === 'undefined') settings = { arkkanResumeHours: 24 };
    settings[key] = v;
    try { await saveSettings(); } catch {}
    (isCompare ? arkkanCompareResumeFieldSync : arkkanResumeFieldSync)();
    showToast(`${isCompare ? 'فترة تخطي المقارنة المُعاد' : 'فترة تخطي الفحص المُعاد'} = ${v} ساعة — يُطبق من التشغيل القادم`, 'info');
  }
});

/* ══════════════════════════════════════════════
   8.5) جلب "الرقم المرجعي" من منصة إدارة النظام (Bases)
   ── حساب إدارة النظام يُحفظ في settings (arkkanBasesUser/arkkanBasesPass)
      عبر حقلي التبويب — اختياري: بدونها يُتخطى جلب الرقم المرجعي بصمت. ──
   ══════════════════════════════════════════════ */

function arkkanBasesCreds() {
  return {
    user: String((settings && settings.arkkanBasesUser) || '').trim(),
    pass: String((settings && settings.arkkanBasesPass) || '')
  };
}

/* ملء حقلي حساب إدارة النظام عند فتح التبويب — بلا مسح ما يكتبه المستخدم */
function arkkanBasesCredsFieldSync() {
  const u = document.querySelector('#fix-arkkan-bases-user');
  const p = document.querySelector('#fix-arkkan-bases-pass');
  if (!u || !p) return;
  const c = arkkanBasesCreds();
  if (u.value.trim() === '' && c.user) u.value = c.user;
  if (p.value === '' && c.pass) p.value = c.pass;
  const fb = document.querySelector('#arkkan-bases-creds-feedback');
  if (fb) fb.textContent = (c.user && c.pass) ? '✓ محفوظة على الجهاز' : '';
}

async function arkkanSaveBasesCreds(btn) {
  const fb = document.querySelector('#arkkan-bases-creds-feedback');
  const fail = m => { if (fb) { fb.textContent = m; fb.style.color = 'var(--danger,#c0392b)'; } };
  const ok = m => { if (fb) { fb.textContent = m; fb.style.color = 'var(--ok,#27ae60)'; } };
  const u = (document.querySelector('#fix-arkkan-bases-user') || {}).value;
  const p = (document.querySelector('#fix-arkkan-bases-pass') || {}).value;
  if (!u || !String(u).trim() || !p) return fail('⚠️ أدخل اسم المستخدم وكلمة المرور معاً');
  if (!settings || typeof DEFAULT_SETTINGS === 'undefined') settings = {};
  settings.arkkanBasesUser = String(u).trim();
  settings.arkkanBasesPass = String(p);
  try { await saveSettings(); } catch {}
  ok('✓ تم الحفظ — لن تُعرض كلمة المرور بعد الآن');
}

/* ربط الحفظ + ملء حقلي حساب إدارة النظام عند فتح التبويب */
document.addEventListener('click', e => {
  const btn = e.target.closest('#btn-arkkan-save-bases-creds');
  if (btn) { arkkanSaveBasesCreds(btn); return; }
});
document.addEventListener('click', e => {
  if (document.querySelector('#view-arkkan-sync')?.classList?.contains('active')) {
    arkkanBasesCredsFieldSync();
  }
});

/* ══════════════════════════════════════════════
   8) رفع "طلب متدرب" إلى بوابة الحقيبة التثقيفية
   ── زر في شاشة كل عميل: تعبئة النموذج عبر الوكيل المحلي
      من بيانات العميل (الاسم كاملاً في الخانة الأولى + نوع ذكر
      + رقم الهوية + البلدية الثابتة) وتصنيف النتيجة على العميل.
      بيانات الحساب تُخزن في settings (arkkanBagUser/arkkanBagPass)
      عبر حقلي التبويب، أو تُقرأ من env/ملف .env بالوكيل مباشرة.
   ══════════════════════════════════════════════ */

function arkkanBagCreds() {
  return {
    user: String((settings && settings.arkkanBagUser) || '').trim(),
    pass: String((settings && settings.arkkanBagPass) || '')
  };
}

/* ملء حقلي بيانات الحساب عند فتح التبويب — بلا مسح ما يكتبه المستخدم */
function arkkanCredsFieldSync() {
  const u = document.querySelector('#fix-arkkan-user');
  const p = document.querySelector('#fix-arkkan-pass');
  if (!u || !p) return;
  const c = arkkanBagCreds();
  if (u.value.trim() === '' && c.user) u.value = c.user;
  if (p.value === '' && c.pass) p.value = c.pass;
  const fb = document.querySelector('#arkkan-creds-feedback');
  if (fb) fb.textContent = (c.user && c.pass) ? '✓ محفوظة على الجهاز' : '';
}

async function arkkanSaveCreds(btn) {
  const fb = document.querySelector('#arkkan-creds-feedback');
  const fail = m => { if (fb) { fb.textContent = m; fb.style.color = 'var(--danger,#c0392b)'; } };
  const ok = m => { if (fb) { fb.textContent = m; fb.style.color = 'var(--ok,#27ae60)'; } };
  const u = (document.querySelector('#fix-arkkan-user') || {}).value;
  const p = (document.querySelector('#fix-arkkan-pass') || {}).value;
  if (!u || !String(u).trim() || !p) return fail('⚠️ أدخل اسم المستخدم وكلمة المرور معاً');
  if (!settings || typeof DEFAULT_SETTINGS === 'undefined') settings = {};
  settings.arkkanBagUser = String(u).trim();
  settings.arkkanBagPass = String(p);
  try { await saveSettings(); } catch {}
  ok('✓ تم الحفظ — لن تُعرض كلمة المرور بعد الآن');
}

/* بناء الحمولة المرسلة للوكيل من بيانات العميل */
function arkkanTraineePayload(c) {
  return {
    clientId: String(c.clientId || '').trim(),
    name: String(c.name || '').trim(),
    phone: String(c.phone || '').trim(),
    nationality: String(c.nationality || '').trim(),
    credentials: arkkanBagCreds(),
  };
}

/* الاتصال بالوكيل المحلي ورفع الطلب — يرمي رسالة فشل جاهزة للتوست */
async function arkkanSubmitTrainee(c) {
  await arkkanEnsureAgentReady();
  const payload = arkkanTraineePayload(c);
  let res;
  try {
    res = await fetch(ARKKAN_API_BASE + '/api/arkkan/submit-trainee', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    const isAbort = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Error(isAbort ? 'انتهت المهلة من البرنامج — راجع الوكيل' : 'لا يوجد اتصال بالوكيل المحلي (9955) — شغّله أولاً');
  }
  let body = {};
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error((body && body.error) || `فشل الوكيل (HTTP ${res.status})`);
  return body;
}

/* زرار "رفع لأركان" في شاشة العميل — نفس نمط arkkanFetchCardButton */
async function arkkanSubmitCardButton(id, btn) {
  const c = clients.find(x => x.id === id);
  if (!c) return;
  if (!String(c.clientId || '').trim()) { showToast('لا يوجد رقم هوية لهذا العميل — اضبطه أولاً', 'error'); return; }
  if (!String(c.name || '').trim()) { showToast('لا يوجد اسم لهذا العميل', 'error'); return; }
  const creds = arkkanBagCreds();
  if (!creds.user || !creds.pass) { showToast('ضع بيانات حساب بوابة الحقيبة في تبويب "مزامنة أركان" أولاً', 'error'); return; }
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.textContent = '⏳ جاري الرفع...';
  try {
    const res = await arkkanSubmitTrainee(c);
    const idx = clients.findIndex(x => String(x.clientId) === String(c.clientId));
    if (idx !== -1) {
      clients[idx].arkkanSubmission = {
        status: res.status,
        at: res.submittedAt,
        msg: String(res.message || res.toast || '').slice(0, 200),
      };
      try { await saveClients(); } catch {}
    }
    if (res.status === 'submitted') showToast('✅ تم رفع طلب المتدرب إلى بوابة الحقيبة', 'success');
    else if (res.status === 'duplicate') showToast('⚠️ المتدرب مسجّل مسبقاً في البوابة — لم يُرفع تكرار', 'info');
    else showToast('؟ ' + String(res.message || res.status || '').slice(0, 90), 'info');
  } catch (err) {
    showToast('فشل رفع طلب المتدرب: ' + String(err.message).slice(0, 95), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/* ربط الحفظ + ملء الحقلين عند فتح التبويب */
document.addEventListener('click', e => {
  const btn = e.target.closest('#btn-arkkan-save-creds');
  if (btn) { arkkanSaveCreds(btn); return; }
});
document.addEventListener('click', e => {
  if (document.querySelector('#view-arkkan-sync')?.classList?.contains('active')) {
    arkkanCredsFieldSync();
  }
});

/* ══════════════════════════════════════════════
   رفع لأركان — دفعة (كل المحددين، واحد وراء واحد)
   ══════════════════════════════════════════════ */
let _bulkSubmitRunning = false;
let _bulkSubmitStop = false;

/* من سبق رفعه بنجاح (dive وجهته للبوابة وكتبناها) — العمود المعتمد: arkkanSubmission.status */
function _arkkanWasSubmitted(c) {
  return !!(c && c.arkkanSubmission && c.arkkanSubmission.status === 'submitted');
}

async function arkkanBulkSubmitSelected() {
  const ids = [...selectedClientIds].filter(id => clients.some(c => c.id === id));
  if (!ids.length) { showToast('لا يوجد عملاء محددين', 'info'); return; }
  if (_bulkSubmitRunning) return;
  const creds = arkkanBagCreds();
  if (!creds.user || !creds.pass) { showToast('ضع بيانات حساب بوابة الحقيبة في تبويب "مزامنة أركان" أولاً', 'error'); return; }

  const skipSubmitted = !!(document.getElementById('chk-arkkan-skip-submitted') || {}).checked;

  /* إعادة أرقام الهوية قيمةً حال النقص؛ لو عميل بدون رقم هوية أو اسم نستثنيه
     تلقائياً ونحسبه في الملخص — لا نوقف الدفعة عليه. */
  const list = ids
    .map(id => clients.find(c => c.id === id))
    .filter(c => c && String(c.clientId || '').trim() && String(c.name || '').trim());
  const invalid = ids.length - list.length;

  let target = list.filter(c => !(skipSubmitted && _arkkanWasSubmitted(c)));
  const skippedDup = list.length - target.length;

  if (!target.length) {
    showToast(`لا يوجد عملاء للرفع${skippedDup ? ` — ${skippedDup} مرفوع مسبقاً تخطّوهم` : ''}${invalid ? ` — ${invalid} بدون رقم هوية/اسم` : ''}`, 'info');
    renderBulkSelectionBar(filteredClients());
    return;
  }

  _bulkSubmitRunning = true;
  _bulkSubmitStop = false;

  const submitBtn = document.getElementById('btn-bulk-arkkan-submit');
  const stopBtn = document.getElementById('btn-bulk-arkkan-stop');
  const statusEl = document.getElementById('bulk-arkkan-status');
  if (submitBtn) submitBtn.disabled = true;
  if (stopBtn) stopBtn.style.display = '';
  if (statusEl) statusEl.style.display = '';

  let idx = 0, submitted = 0, dup = 0, failed = 0;
  const failMsgs = [];
  const updateStatus = () => {
    if (statusEl) statusEl.textContent = `✅ ${submitted} · ⚠️ ${dup} · ❌ ${failed} — ${idx}/${target.length}`;
  };

  for (const c of target) {
    if (_bulkSubmitStop) break;
    updateStatus();
    const row = document.getElementById(`arkkan-status-${cssEscapeId(c.clientId)}`);
    if (row) row.innerHTML = '<span style="color:var(--gold);">⏳ رفع...</span>';
    try {
      const res = await arkkanSubmitTrainee(c);
      const fi = clients.findIndex(x => String(x.clientId) === String(c.clientId));
      if (fi !== -1) {
        clients[fi].arkkanSubmission = {
          status: res.status,
          at: res.submittedAt,
          msg: String(res.message || res.toast || '').slice(0, 200),
        };
        if (typeof saveClients === 'function') await saveClients();
      }
      if (res.status === 'submitted') { submitted++; if (row) row.innerHTML = '<span style="color:var(--success, green);">✅ رُفع</span>'; }
      else if (res.status === 'duplicate') { dup++; if (row) row.innerHTML = '<span style="color:#c26511;">⚠️ مسجّل مسبقاً</span>'; }
      else { failed++; if (row) row.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(res.message || '')}">❌ ؟</span>`; }
    } catch (err) {
      failed++;
      if (row) row.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">❌ فشل</span>`;
      failMsgs.push(`${c.name || c.clientId}: ${String(err.message).slice(0, 60)}`);
    }
    idx++;
  }

  _bulkSubmitRunning = false;
  if (submitBtn) submitBtn.disabled = false;
  if (stopBtn) stopBtn.style.display = 'none';
  updateStatus();

  let msg = `انتهى رفع ${target.length} عميل: ✅ ${submitted} · ⚠️ ${dup} · ❌ ${failed}`;
  if (skippedDup) msg += ` · ↩️ ${skippedDup} تخطّي (مرفوع مسبقاً)`;
  if (invalid) msg += ` · 🚫 ${invalid} بلا رقم/اسم`;
  showToast(msg, failed ? 'error' : 'success');
  if (failMsgs.length) console.warn('أركان رفع دفعة — أخطاء:', failMsgs);
}

document.addEventListener('click', e => {
  if (e.target.closest('#btn-bulk-arkkan-submit')) { arkkanBulkSubmitSelected(); return; }
  if (e.target.closest('#btn-bulk-arkkan-stop')) { _bulkSubmitStop = true; return; }
  if (e.target.closest('#btn-bulk-arkkan-refnum')) { arkkanBulkRefNumSelected(); return; }
  if (e.target.closest('#btn-bulk-arkkan-refnum-stop')) { _bulkRefNumStop = true; return; }
});

/* ══════════════════════════════════════════════
   8.6) جلب الرقم المرجعي فقط للمحددين في شيت العملاء
   ── زر مستقل في شريط التحديد الجماعي: يستعلم عن الرقم المرجعي لكل عميل
      محدد من منصة إدارة النظام (بحث برقم الهوية فقط) ويُحفظه في الحقل —
      بلا جلب أي بيانات أخرى. ──
   ══════════════════════════════════════════════ */
let _bulkRefNumRunning = false;
let _bulkRefNumStop = false;

async function arkkanRefNumFetchOne(clientId) {
  await arkkanEnsureAgentReady();
  const creds = arkkanBasesCreds();
  if (!creds.user || !creds.pass) {
    throw new Error('ضع بيانات حساب منصة إدارة النظام في تبويب «مزامنة أركان» أولاً');
  }
  // نتجاهل النتيجة الفارغة مرة واحدة: الوكيل أحياناً يعيد '' لو لم يكتمل تحميل
  // نتيجة البحث داخل المهلة (خصوصاً أول استعلام أو تحت ضغط)، فيبدو كأن الهوية
  // بلا رقم مرجعي، ويضطر المستخدم لإعادة العملية يدوياً. المحاولة الثانية سريعة
  // لأن الوكيل يعيد استخدام جلسة الدخول (reuseSession) — فلا نكرر تسجيل الدخول.
  let lastBody = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 800));
    const r = await fetch(ARKKAN_API_BASE + '/api/arkkan/refnum', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, basesCreds: creds, reuseSession: true }),
      signal: AbortSignal.timeout(70000)
    });
    let body = {};
    try { body = await r.json(); } catch {}
    if (!r.ok) {
      // أخطاء عابرة (الوكيل لسه بيجهّز المتصفح/إعادة تشغيل) — محاولة ثانية بدل فشل فوري
      if (attempt === 0 && (r.status === 502 || r.status === 503 || r.status === 429)) continue;
      throw new Error((body && body.error) || `فشل الوكيل المحلي (HTTP ${r.status})`);
    }
    lastBody = body || {};
    if (String(lastBody.refNum || '').trim()) return lastBody;
    // الوكيل أكّد «لا نتائج» (بحث مكتمل فعلاً) — إعادة المحاولة لن تغيّر شيئاً.
    if (lastBody.confirmed === true || lastBody.notFound === true) return lastBody;
  }
  return lastBody;
}

async function arkkanBulkRefNumSelected() {
  const ids = [...selectedClientIds].filter(id => clients.some(c => c.id === id));
  if (!ids.length) { showToast('لا يوجد عملاء محددين', 'info'); return; }
  if (_bulkRefNumRunning) return;
  const creds = arkkanBasesCreds();
  if (!creds.user || !creds.pass) {
    showToast('ضع بيانات حساب منصة إدارة النظام في تبويب «مزامنة أركان» أولاً', 'error');
    return;
  }

  _bulkRefNumRunning = true;
  _bulkRefNumStop = false;

  const btn = document.getElementById('btn-bulk-arkkan-refnum');
  const stopBtn = document.getElementById('btn-bulk-arkkan-refnum-stop');
  const statusEl = document.getElementById('bulk-arkkan-refnum-status');
  if (btn) btn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = '';
  if (statusEl) { statusEl.style.display = ''; statusEl.textContent = '⏳ جاري الاستعلام عن الأرقام المرجعية...'; }

  let okCount = 0, failCount = 0, savedCount = 0, done = 0;
  const failMsgs = [];

  for (const id of ids) {
    if (!_bulkRefNumRunning || _bulkRefNumStop) break;
    const c = clients.find(x => x.id === id);
    if (!c) continue;
    const identity = String(c.clientId || '').trim();
    if (!identity) {
      failCount++;
      failMsgs.push(`${c.name}: لا يوجد رقم هوية`);
      done++;
      continue;
    }
    try {
      const res = await arkkanRefNumFetchOne(identity);
      const refNum = String(res && res.refNum || '').trim();
      if (refNum) {
        // بعد الانتظار: نأخذ الكائن الحيّ — مصفوفة clients قد تُستبدل بأي مزامنة
        // خلفية/SSE أثناء الاستعلام، والكتابة على النسخة القديمة لا تظهر ولا تُحفظ.
        const live = arkkanLiveClient(id, identity) || c;
        const oldRef = String(live.referNum || '').trim();
        live.referNum = refNum;
        if (oldRef !== refNum) {
          try {
            // حفظ منفرد مباشر لكل عميل لنعرف النتيجة الفعلية بدل saveClients() الذي يبتلع الفشل بصمت
            const cJson = JSON.stringify(live);
            let saveOk = null;
            if (typeof saveOneClientRecord === 'function') {
              saveOk = await saveOneClientRecord(live, cJson);
            } else if (typeof saveClients === 'function') {
              await saveClients();
              saveOk = true;
            }
            if (saveOk === true) {
              if (typeof _clientsSyncBaseline === 'object' && _clientsSyncBaseline instanceof Map) _clientsSyncBaseline.set(live.id, cJson);
              // مؤجَّلة (debounced) أصلاً — استدعاؤها هنا لكل عميل ناجح آمن تماماً، وتُنفَّذ فعلياً
              // مرة واحدة فقط بعد توقف الحلقة (نفس سبب الإصلاح في arkkanRefNumCardButton أعلاه).
              if (typeof _scheduleClientsSnapPersist === 'function') _scheduleClientsSnapPersist();
              // الحفظ قد يستغرق أطول من نافذة مزامنة خلفية — نثبّت الرقم على الكائن الحيّ
              // الجديد (السيرفر استلمه بالفعل) حتى لا يختفي من الشاشة/اللقطة.
              arkkanPinRefNum(live.id, identity, refNum);
              savedCount++;
            } else if (saveOk === false) {
              failCount++;
              failMsgs.push(`${c.name}: تعارض في حفظ الرقم المرجعي — يرجى تحديث الصفحة`);
            } else {
              failCount++;
              failMsgs.push(`${c.name}: تعذّر اتصال الخادم عند حفظ الرقم المرجعي`);
            }
          } catch (e) {
            failCount++;
            failMsgs.push(`${c.name}: تم الجلب لكن تعذّر الحفظ (${String(e.message).slice(0, 50)})`);
          }
        } else {
          arkkanPinRefNum(live.id, identity, refNum);
          savedCount++;
        }
        okCount++;
      } else {
        failCount++;
        failMsgs.push(`${c.name}: ` + ((res && (res.confirmed === true || res.notFound === true))
          ? 'لا يوجد رقم مرجعي لهذه الهوية في المنصة'
          : 'لم تصل نتيجة من المنصة — أعد المحاولة (بحث لم يكتمل)'));
      }
    } catch (err) {
      failCount++;
      failMsgs.push(`${c.name}: ${String(err.message).slice(0, 80)}`);
    }
    done++;
    if (statusEl) statusEl.textContent = `⏳ ${done}/${ids.length} ... ✅ ${okCount} · ❌ ${failCount}`;
    if (typeof renderTable === 'function') renderTable();
  }

  if (statusEl) statusEl.style.display = 'none';
  if (btn) btn.style.display = '';
  if (stopBtn) stopBtn.style.display = 'none';

  _bulkRefNumRunning = false;
  if (failMsgs.length) console.warn('أركان أرقام مرجعية — تفاصيل:', failMsgs);
  if (statusEl && failMsgs.length) {
    statusEl.style.display = '';
    statusEl.innerHTML = `<span style="color:var(--danger,red);">❌ ${failCount} فشل</span>`;
    statusEl.title = failMsgs.join('\n');
    setTimeout(() => { statusEl.style.display = 'none'; }, 8000);
  }
  const detail = failCount ? ` — فشل: ${failMsgs.slice(0, 3).map(m => m.split(':')[0]).join(', ')}${failMsgs.length > 3 ? ` + ${failMsgs.length - 3}` : ''}` : '';
  showToast(`انتهى: ✅ ${okCount} جلب${savedCount ? ` (${savedCount} محفوظ)` : ''} · ❌ ${failCount} فشل${detail}`, failCount ? 'error' : 'success');
}

/* ─────────── سجل تحميل الإيصالات المخفي — داخل بيانات البرنامج (كل البيئات) ───────────
   لا يعتمد على سطح المكتب: يُظهر عدد المسجَّلات وزر المسح أينما كان البرنامج مفتوحاً. */
function initArkkanReceiptsLogUI() {
  function init() {
    const panel = document.getElementById('panel-arkkan-receipts-log');
    const btnClear = document.getElementById('btn-clear-receipts-log');
    const status = document.getElementById('receipts-log-status');
    if (!panel || !btnClear || !status) return;
    if (!window.storage || typeof window.storage.get !== 'function') return;

    panel.style.display = '';

    async function refresh() {
      try {
        await arkkanReceiptsLogLoad();
        const n = arkkanReceiptsLogCount();
        status.textContent = n ? `الإيصالات المسجَّلة: ${n}` : 'لا توجد إيصالات مسجَّلة بعد';
      } catch (e) { status.textContent = ''; }
    }

    btnClear.addEventListener('click', async () => {
      const n = arkkanReceiptsLogCount();
      if (!n) { showToast('سجل التحميلات فارغ أصلاً', 'info'); return; }
      const ok = await customConfirm(`سيتم مسح سجل التحميلات المخفي بالكامل (${n} إيصال مسجَّل).\n\nلن يُمسح أي ملف من مجلداتك، لكن الإيصالات ستُعاد قابلية تنزيلها من جديد في المرات القادمة. متابعة؟`);
      if (!ok) return;
      arkkanReceiptsLogClear();
      showToast('تم مسح سجل التحميلات — هذه الإيصالات يمكن تنزيلها مجدداً', 'success');
      refresh();
    });

    // مسح الكاش المحلي للإيصالات — يعمل فقط عندما يكون الوكيل المحلي على هذا الجهاز (سطح المكتب)
    const btnCache = document.getElementById('btn-clear-receipts-cache');
    if (btnCache && ARKKAN_IS_DESKTOP) {
      btnCache.style.display = '';
      btnCache.addEventListener('click', async () => {
        const ok = await customConfirm('سيتم مسح الكاش المحلي للإيصالات بالكامل.\n\nلا يُمسح أي ملف أو سجل بأي مكان، لكن بعد ذلك سيُفتح موقع أركان من جديد عند طلب أي عميل (ولن يُقرأ من الكاش). متابعة؟');
        if (!ok) return;
        try {
          const r = await fetch(ARKKAN_API_BASE + '/api/arkkan/receipts/cache/clear', { method: 'POST' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          showToast('تم مسح كاش الإيصالات المحلي 🧹', 'success');
        } catch (err) {
          showToast('تعذّر مسح الكاش: ' + String(err.message).slice(0, 80), 'error');
        }
      });
    }

    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
initArkkanReceiptsLogUI();

/* ─────────── لوحة «مجلد حفظ إيصالات أركان» في شاشة الإعدادات (سطح المكتب فقط) ───────────
   تعتمد على desktopAPI الذي يحقنه electron-desktop/preload.js عبر contextBridge.
   في المتصفح العادي لا يوجد desktopAPI فتظل اللوحة مخفية (display:none). */
(function initArkkanReceiptsFolderUI() {
  function init() {
    const panel = document.getElementById('panel-arkkan-receipts-folder');
    const btnChoose = document.getElementById('btn-choose-receipts-folder');
    const btnReset = document.getElementById('btn-reset-receipts-folder');
    const status = document.getElementById('receipts-folder-status');
    if (!panel || !btnChoose || !btnReset || !status) return;
    const api = window.desktopAPI;
    if (!api || typeof api.getReceiptsFolder !== 'function') return; // متصفح عادي — اللوحة تبقى مخفية

    panel.style.display = '';

    async function refresh() {
      try {
        const r = await api.getReceiptsFolder();
        const folder = r && r.folder ? String(r.folder) : '';
        if (folder) {
          status.innerHTML = `📂 <b dir="ltr">${folder}</b> <span style="color:var(--gold, #FFB84C);">← مجلد الإيصالات المخصص</span>`;
          btnReset.style.display = '';
        } else {
          status.textContent = 'بدون مجلد مخصص حالياً — تُحفظ الإيصالات داخل مجلد بيانات البرنامج على هذا الجهاز';
          btnReset.style.display = 'none';
        }
      } catch (e) {
        status.textContent = '';
      }
    }

    btnChoose.addEventListener('click', async () => {
      try {
        const r = await api.selectReceiptsFolder();
        if (r && r.ok && r.folder) {
          showToast('تم حفظ مجلد إيصالات أركان بنجاح 📁', 'success');
          refresh();
        } else {
          showToast('لم يتم اختيار مجلد', 'error');
        }
      } catch (err) {
        showToast('تعذّر فتح نافذة اختيار المجلد: ' + String(err.message).slice(0, 80), 'error');
      }
    });

    btnReset.addEventListener('click', async () => {
      try {
        const r = await api.clearReceiptsFolder();
        if (r && r.ok) {
          showToast('تمت العودة للمجلد الافتراضي', 'success');
          refresh();
        }
      } catch (err) {
        showToast('تعذّر إلغاء المجلد: ' + String(err.message).slice(0, 80), 'error');
      }
    });

    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
