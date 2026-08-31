// ============================================================
// backup.service.js — خدمة النسخ الاحتياطي المركزية
// ------------------------------------------------------------
// تُجمّع منطق حفظ/استرجاع/حذف النسخ الاحتياطية في واجهة واحدة.
// السيرفر لا يفكّ تشفير البيانات أبداً — كل المحتوى مشفّر من العميل.
// ============================================================
const repo = require('../repo/backup.repo');

const MAX_BACKUPS_RETAINED = 30;
const MAX_ENC_SIZE_BYTES = 10 * 1024 * 1024; // 10MB حد أقصى للمحتوى المشفّر

/**
 * حفظ نسخة احتياطية جديدة + حذف القديمة التلقائي (أكبر من MAX_BACKUPS_RETAINED).
 */
async function create({ kind, enc, createdBy }) {
  if (!enc || typeof enc !== 'string') {
    return { ok: false, reason: 'missing_enc' };
  }
  if (enc.length > MAX_ENC_SIZE_BYTES) {
    return { ok: false, reason: 'enc_too_large' };
  }
  const validKind = kind === 'manual' ? 'manual' : 'auto';
  const saved = await repo.insertAndPrune({ kind: validKind, enc, createdBy });
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
 * حذف نسخة احتياطية.
 */
async function remove(id) {
  if (!id) return false;
  return repo.del(id);
}

module.exports = { create, list, get, remove, MAX_BACKUPS_RETAINED };