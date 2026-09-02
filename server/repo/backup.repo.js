// ============================================================
// backup.repo.js — طبقة الوصول لجدول app_backups (Data Access Layer)
// ------------------------------------------------------------
// كل استعلامات SQL الخاصة بالنسخ الاحتياطية مُجمَّعة هنا.
// سلوك مطابق لما كان داخل routes/backups.js — نقل ميكانيكي فقط.
// ============================================================
const { pool } = require('../db');

const MAX_BACKUPS_RETAINED = 30;

// حفظ نسخة جديدة + تنظيف تجاوز الحد (يبقي آخر MAX_BACKUPS_RETAINED فقط)
// يتم كلاهما داخل معاملة واحدة (transaction) — حتى لا يتغيّر تقييد TTL/الحد الأقصى عدة مرات
// بشكل غير ذرّي، ولا تبقى النسخة الجديدة ظاهرة في نفس لحظة زيادة العدد ثم تنظيفه.
// قبل هذا التعديل كانت العملية تبدأ بـ INSERT ثم DELETE منفصلين (بلا transaction)، فلو حدث
// خطأ بينهما أو تنافست عمليتان متزامنتان، قد يتجاوز عدد النسخ المحفوظة حدّ MAX_BACKUPS_RETAINED
// مؤقتاً أو تُحذف نسخة لا يجوز (سباق غير محسوم). المعاملة تجعل العملية ذرّية تماماً.
// (انتباه: `pool.connect` وحده لا يُغلّف العبارات في معاملة على pg خام — يجب BEGIN/COMMIT
// صريحان، بنفس النمط المتّبع في user.repo.js / role.repo.js.)
async function insertAndPrune({ kind, enc, createdBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO app_backups (kind, enc, size_bytes, created_by) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [kind, enc, Buffer.byteLength(enc, 'utf8'), createdBy]
    );
    await client.query(
      `DELETE FROM app_backups WHERE id NOT IN (SELECT id FROM app_backups ORDER BY created_at DESC LIMIT $1)`,
      [MAX_BACKUPS_RETAINED]
    );
    await client.query('COMMIT');
    return { id: ins.rows[0].id, createdAt: ins.rows[0].created_at };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
