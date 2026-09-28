// ============================================================
// services/sync.js — خدمة المزامنة المركزية (طابور + startup + فحص السلامة)
// ------------------------------------------------------------
// تجمع عمليات مزامنة فهرس clients_rows في واجهة واحدة: طابور تسلسلي يمنع
// تداخل عمليتي مزامنة، وفحص سلامة للإقلاع، وفحص دوري خفيف.
// ============================================================
const kvRepo = require('../repo/kv.repo');
const clientsRowsRepo = require('../repo/clientsRows.repo');

/* ========================== طابور مزامنة clients_rows ========================== */
// طابور يمنع تداخل عمليتي مزامنة متزامنتين (Race Condition):
// لو حفظ مستخدمان بيانات clients في نفس اللحظة، بدون طابور تبدأ عمليتا
// مزامنة بالتوازي — العملية الأولى قد تحذف صفوفاً أضافتها الثانية عبر
// DELETE...WHERE id != ALL($1)، فيختفي جزء من بيانات العملاء الفهرسة.
// الطابور يضمن أن كل عملية تنتهي قبل أن تبدأ التالية.
let _syncQueue = Promise.resolve();

/**
 * إضافة مهمة مزامنة إلى الطابور (يتنفّذ بعد انتهاء كل المهام السابقة).
 * pruneforkey = true تُستخدم في المسار الوحيد الذي تكون فيه كتلة kv هي المصدر
 * الحاكم فعلاً: PUT /api/storage/clients (ترحيل/استعادة). في أي مسار آخر نستدعي
 * هذه الدالة بدون prune فلا يُحذف أي صف من الفهرس.
 */
function queueSync(value, opts = { prune: true }) {
  _syncQueue = _syncQueue
    .then(() => clientsRowsRepo.syncAll(value, opts))
    .catch(e => console.error('تعذّرت مزامنة clients_rows في الطابور:', e.message));
  return _syncQueue;
}

/**
 * مزامنة مباشرة (بانتظار النتيجة) — تُستخدم عند الإقلاع فقط (انظر startupCheckAndSync).
 */
async function syncDirect(value, opts = { prune: false }) {
  return clientsRowsRepo.syncAll(value, opts);
}

/* ========================== فحص الفهرس عند الإقلاع ========================== */

/**
 * عند الإقلاع: **لا نعيد كتابة الفهرس**.
 * السلوك القديم كان يعيد بناء clients_rows بالكامل عند كل إقلاع: يقرأ كتلة
 * kv_store('clients') كاملة (عدة ميجابايت، JSON.parse كامل في الذاكرة)، ثم
 * UPSERT لكل عميل (آلاف الصفوف) ثم DELETE لكل ما ليس في الكتلة.
 *有二 مشكلتين حقيقيتين في ذلك:
 *   ١) تكلفة: O(N) كتابة + WAL + DELETE عند كل إعادة تشغيل (وهي الحالة
 *      الأشيع على استضافة مجانية: إعادة تشغيل كل بضع دقائق بسبب عدم النشاط).
 *   ٢) سلامة: kv_store('clients') لم يعد يُكتب إطلاقاً منذ النظام الجديد، فهو
 *      **جمّد** عند الترحيل. أي عميل أُضيف/حُذف بعد ذلك غير موجود فيه ⇒ الـ DELETE
 *      كان يمسح من الفهرس كل عملاء ما بعد الترحيل عند كل إقلاع (يختفي العميل من
 *      شاشة جدول العملاء، ويضطر الجهاز لإعادة رفعه).
 * الآن: فحص **قراءة فقط** (استعلام واحد) + تصحيح الصفوف اليتيمة فقط (آمن تماماً
 * لأنها غير موجودة في المصدر)، + قراءة كتلة kv التراثية **مرة واحدة فقط** عند
 * الإقلاع الأول/الفارغ (bootstrap للترحيل القديم) بلا أي حذف.
 */
async function startupCheckAndSync() {
  try {
    const health = await clientsRowsRepo.integrityCheck();
    const { sourceRows, indexRows, orphans } = health;

    // ١) تصحيح اليتيم — الإجراء الوحيد الذي نكتب به في الفهرس، وهو آمن ١٠٠٪.
    let removedOrphans = 0;
    if (orphans > 0) {
      removedOrphans = await clientsRowsRepo.deleteOrphans();
      console.log(`🧹 حُذف ${removedOrphans} صف يتيم من فهرس clients_rows (لا وجود له في client_records)`);
    }

    // ٢) الفهرس فارغ تماماً والبناء فيه عملاء ⇒ ترحيل أولي من الكتلة التراثية
    //    (قراءة الكتلة كاملة هنا **فقط**، ودمج بلا حذف ⇒ لا يمكن أن يمسح أي صف).
    if (indexRows === 0) {
      const existing = await kvRepo.get('clients');
      const value = existing?.value;
      if (value) {
        const res = await syncDirect(value, { prune: false });
        await clientsRowsRepo.stampSrcVersions().catch(() => {});
        console.log(`✅ تهيئة أولية لفهرس clients_rows من الكتلة التراثية (${res.rows} عميل)${res.failedRows ? ` — فشل ${res.failedRows} صف` : ''}`);
        return { synced: true, reason: 'bootstrap_from_kv', expectedCount: res.rows, failedRows: res.failedRows };
      }
      return { synced: false, reason: 'empty_index_and_no_kv_blob', sourceRows, indexRows };
    }

    // ٣) الفهرس موجود: نُبقيه كما هو. الفارق sourceRows/indexRows متوقّع في حالتين
    //    مقصودتين: عملاء بترحيل لم يُبنَ صفهم بعد (يفحصهم الجهاز ويرفعهم)، وسجلات
    //    مرفوضة/محذوفة. نُبلّغ فقط بلا أي كتابة.
    if (sourceRows !== indexRows) {
      console.log(`ℹ️  فهرس clients_rows: ${indexRows} صف / المصدر ${sourceRows} سجل (فرق ${sourceRows - indexRows} — لن يُبنى هنا لأن الفهرس يحتاج النسخة الصريحة من المتصفح)`);
    } else {
      console.log(`✅ فهرس clients_rows سليم (${indexRows} صف مطابق للمصدر)`);
    }
    return { synced: false, reason: 'checked_ok', sourceRows, indexRows, removedOrphans };
  } catch (e) {
    console.error('تعذّر فحص فهرس clients_rows عند الإقلاع:', e.message);
    return { synced: false, reason: 'error', error: e.message };
  }
}

/**
 * فحص دوري رخيص (بلا أي قراءة للكتلة التراثية): يلتقط الصفوف اليتيمة فقط.
 * يُستدعى كل بضع ساعات من server.js — تكلفة استعلام واحد.
 */
async function periodicIntegrityCheck() {
  try {
    const { sourceRows, indexRows, orphans } = await clientsRowsRepo.integrityCheck();
    if (orphans > 0) {
      const n = await clientsRowsRepo.deleteOrphans();
      console.log(`🧹 فحص دوري: حُذف ${n} صف يتيم من فهرس clients_rows`);
    }
    return { sourceRows, indexRows, orphans };
  } catch (e) {
    console.error('تعذّر الفحص الدوري لفهرس clients_rows:', e.message);
    return { error: e.message };
  }
}

module.exports = { queueSync, syncDirect, startupCheckAndSync, periodicIntegrityCheck };
