// ============================================================
// backup.repo.js — طبقة الوصول لجدول app_backups (Data Access Layer)
// ------------------------------------------------------------
// كل استعلامات SQL الخاصة بالنسخ الاحتياطية مُجمَّعة هنا.
// سلوك مطابق لما كان داخل routes/backups.js — نقل ميكانيكي فقط.
// ============================================================
const { pool } = require('../db');

const MAX_BACKUPS_RETAINED = 30;

// حفظ نسخة جديدة + تنظيف تجاوز الحد (يبقي آخر MAX_BACKUPS_RETAINED فقط)
async function insertAndPrune({ kind, enc, createdBy }) {
  const ins = await pool.query(
    `INSERT INTO app_backups (kind, enc, size_bytes, created_by) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [kind, enc, Buffer.byteLength(enc, 'utf8'), createdBy]
  );
  await pool.query(
    `DELETE FROM app_backups WHERE id NOT IN (SELECT id FROM app_backups ORDER BY created_at DESC LIMIT $1)`,
    [MAX_BACKUPS_RETAINED]
  );
  return { id: ins.rows[0].id, createdAt: ins.rows[0].created_at };
}

// قائمة النسخ (بيانات وصفية فقط — بلا المحتوى المشفّر)
async function list() {
  const r = await pool.query('SELECT id, kind, size_bytes, created_by, created_at FROM app_backups ORDER BY created_at DESC LIMIT 100');
  return r.rows;
}

// نسخة واحدة كاملة (للتنزيل/الاستعادة)
async function get(id) {
  const r = await pool.query('SELECT id, kind, enc, created_at FROM app_backups WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// حذف نسخة
async function del(id) {
  await pool.query('DELETE FROM app_backups WHERE id = $1', [id]);
}

module.exports = { MAX_BACKUPS_RETAINED, insertAndPrune, list, get, del };
