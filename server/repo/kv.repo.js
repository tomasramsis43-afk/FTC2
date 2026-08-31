// ============================================================
// kv.repo.js — طبقة الوصول إلى بيانات kv_store (Data Access Layer)
// ------------------------------------------------------------
// كل استعلامات SQL الخاصة بمخزن المفاتيح/القيم مُجمَّعة هنا.
// السلوك مطابق 100% لما كان داخل routes/records.js — نقل ميكانيكي فقط.
// ============================================================
const { pool } = require('../db');

// جلب نسخة مفتاح فقط (خفيفة، بلا القيمة) — meta=1
async function getVersion(key) {
  const r = await pool.query('SELECT version FROM kv_store WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].version : 0;
}

// جلب كامل (value + version) لمفتاح واحد
async function get(key) {
  const r = await pool.query('SELECT value, version FROM kv_store WHERE key = $1', [key]);
  return r.rows[0] || null;
}

// البادئة المشفّرة فقط (أول 5 أحرف) لفحص انحدار التشفير دون نقل قيمة كبيرة
async function getPrefix(key) {
  const r = await pool.query('SELECT LEFT(value, 5) AS prefix FROM kv_store WHERE key = $1', [key]);
  return r.rows[0] && r.rows[0].prefix;
}

// حفظ Optimistic Concurrency: ينفّذ UPSERT مع شرط version
// يرجع { updated: boolean, version: number } — updated=false عند تعارض فعلي
async function upsert(key, value, knownVersion, username) {
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
    [key, value, username, knownVersion]
  );
  if (upsert.rows[0]) {
    return { updated: true, version: upsert.rows[0].version };
  }
  // تعارض حقيقي — نجلب النسخة الحالية
  const current = await pool.query('SELECT version FROM kv_store WHERE key = $1', [key]);
  return { updated: false, version: current.rows[0] ? current.rows[0].version : 0 };
}

// حذف مفتاح
async function del(key) {
  await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
}

// قائمة مفاتيح ببادئة
async function list(prefix) {
  const r = await pool.query(`SELECT key FROM kv_store WHERE key LIKE $1 ESCAPE '\\'`, [prefix + '%']);
  return r.rows.map(x => x.key);
}

// كل المفاتيح مع إصداراتها (لـ /api/storage-versions)
async function allVersions() {
  const r = await pool.query('SELECT key, version FROM kv_store');
  return r.rows;
}

// استيراد جماعي من أداة الترحيل القديمة (migrate-from-localstorage.js) — نسخة واحدة بلا تعارض
async function migrationUpsert(key, value) {
  await pool.query(
    `INSERT INTO kv_store (key, value, version, updated_by)
     VALUES ($1, $2, 1, 'migration')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = kv_store.version + 1, updated_at = now()`,
    [key, value]
  );
}

module.exports = { getVersion, get, getPrefix, upsert, del, list, allVersions, migrationUpsert };
