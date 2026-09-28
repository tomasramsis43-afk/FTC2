// ============================================================
// backup.service.js — خدمة النسخ الاحتياطي المركزية
// ------------------------------------------------------------
// تُجمّع منطق حفظ/استرجاع/حذف النسخ الاحتياطية في واجهة واحدة.
// السيرفر لا يفكّ تشفير البيانات أبداً — كل المحتوى مشفّر من العميل.
// ============================================================
const repo = require('../repo/backup.repo');

const MAX_BACKUPS_RETAINED = 30;
// حدّ الحجم للنسخة الواحدة ومجموع النسخ المحتفظ بها. التقليم بالعدد وحده غير كافٍ:
// 30 نسخة × 10MB = 300MB من جدول واحد، وهو نصيب كبير جداً من قاعدة بيانات مجانية
// صغيرة — خصوصاً مع TOAST/WAL. فيبقى الحدّان معاً: عدد + ميزانية بايت، والأقدم
// يُحذف أولاً عند تجاوز أي منهما.
const MAX_ENC_SIZE_BYTES = 10 * 1024 * 1024; // 10MB حد أقصى للمحتوى المشفّر
const MAX_TOTAL_BYTES = Number(process.env.BACKUP_MAX_TOTAL_MB || 150) * 1024 * 1024;

/**
 * حفظ نسخة احتياطية جديدة + حذف القديمة التلقائي (أكبر من MAX_BACKUPS_RETAINED).
 */
async function create({ kind, enc, createdBy }) {
  if (!enc || typeof enc !== 'string') {
    return { ok: false, reason: 'missing_enc' };
  }
  // القياس بالبايت فعلياً (Buffer.byteLength) لا بطول نص JS: الفارق كبير مع أي نص
  // غير ASCII، و enc يُخزَّن في UTF-8 داخل عمود TEXT. الفحص كان بـ enc.length وهو
  // عدد وحدات UTF-16 ⇒ قيمة قد تُقبل هنا ثم تتجاوز ما يتّسعه التخزين/العمود.
  const encBytes = Buffer.byteLength(enc, 'utf8');
  if (encBytes > MAX_ENC_SIZE_BYTES) {
    return { ok: false, reason: 'enc_too_large' };
  }
  const validKind = kind === 'manual' ? 'manual' : 'auto';
  const saved = await repo.insertAndPrune({
    kind: validKind, enc, createdBy,
    maxCount: MAX_BACKUPS_RETAINED, maxTotalBytes: MAX_TOTAL_BYTES,
  });
  return { ok: true, id: saved.id, createdAt: saved.created_at };
}

/**
 * قائمة النسخ الاحتياطية (بيانات وصفية فقط، بدون المحتوى المشفّر).
 */
async function list() {
  return repo.list();
}

/**
 * جلب نسخة احتياطية واحدة (مع المحتوى المشفّر).
 */
async function get(id) {
  if (!id) return null;
  return repo.get(id);
}

/**
 * حذف نسخة احتياطية. يُرجع true/false حسب وجودها فعلاً (بدل 항상 true).
 */
async function remove(id) {
  if (!id) return false;
  return repo.del(id);
}

module.exports = { create, list, get, remove, MAX_BACKUPS_RETAINED, MAX_ENC_SIZE_BYTES, MAX_TOTAL_BYTES };