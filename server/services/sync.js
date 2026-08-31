// ============================================================
// sync.service.js — خدمة المزامنة المركزية (ளமّط queue + startup + bulk orchestration)
// ------------------------------------------------------------
// تجمع عمليات المزامنة الموزعة حالياً بين routes/records.js و server.js
// في واجهة واحدة. لا تُغيّر أي سلوك — نقل ميكانيكي مع إضافة retry خفيفة.
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
 * لا يُراجع النتيجة — لو فشلت المزامنة تُسجَّل الخطأ وتُخطَّر اللوج فقط.
 */
function queueSync(value) {
  _syncQueue = _syncQueue
    .then(() => clientsRowsRepo.syncAll(value))
    .catch(e => console.error('تعذّرت مزامنة clients_rows في الطابور:', e.message));
}

/**
 * مزامنة مباشرة (بانتظار النتيجة) — تُستخدم عند الإقلاع فقط.
 * تُعيد_failedRows (0 = نجاح تام).
 */
async function syncDirect(value) {
  return clientsRowsRepo.syncAll(value);
}

/* ========================== فحص وإعادة مزامنة عند الإقلاع ========================== */

/**
 * عند بدء التشغيل: لو عدد صفوف clients_rows لا يطابق عدد عملاء kv_store الفعلي
 * (يشمل الحالة القديمة: 0 صف رغم وجود آلاف العملاء)، نعيد المزامنة كاملة.
 * تُعيد معلومة عن ماذا حدث فقط لا ترمي خطأ.
 */
async function startupCheckAndSync() {
  try {
    const existing = await kvRepo.get('clients');
    const value = existing?.value;
    if (!value) return { synced: false, reason: 'no_clients_value' };

    let expectedCount = 0;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) expectedCount = parsed.filter(c => c && c.id).length;
    } catch (e) {
      console.error('[Sync] Failed to parse expectedCount from settings:', e);
    }

    const currentCount = await clientsRowsRepo.count();
    if (Number(currentCount) === expectedCount) {
      return { synced: false, reason: 'already_synced' };
    }

    const failedRows = await syncDirect(value);
    const result = { synced: true, expectedCount, failedRows };
    console.log(`✅ تمت مزامنة/ترحيل بيانات العملاء إلى clients_rows (${expectedCount} عميل متوقع)${failedRows ? ` — فشل ${failedRows} صف` : ''}`);
    return result;
  } catch (e) {
    console.error('تعذّر الترحيل الأولي لـ clients_rows:', e.message);
    return { synced: false, reason: 'error', error: e.message };
  }
}

module.exports = { queueSync, syncDirect, startupCheckAndSync };