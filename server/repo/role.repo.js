// ============================================================
// role.repo.js — طبقة الوصول لجدول role_permissions (Data Access Layer)
// ------------------------------------------------------------
// كل استعلامات SQL الخاصة بصلاحيات الأدوار مُجمَّعة هنا.
// سلوك مطابق لما كان داخل permissions.js — نقل ميكانيكي فقط.
// ============================================================
const { pool } = require('../db');

async function allRows() {
  const r = await pool.query('SELECT role, views FROM role_permissions');
  return r.rows;
}

async function seedDefault(role, viewsJson) {
  await pool.query(
    `INSERT INTO role_permissions (role, views, updated_by) VALUES ($1, $2, 'system-seed')
     ON CONFLICT (role) DO NOTHING`,
    [role, viewsJson]
  );
}

// حفظ صلاحيات عدة أدوار في معاملة واحدة ذرّية
async function upsertMany(entries) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    for (const { role, viewsJson, username } of entries) {
      await tx.query(
        `INSERT INTO role_permissions (role, views, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (role) DO UPDATE SET views = EXCLUDED.views, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [role, viewsJson, username]
      );
    }
    await tx.query('COMMIT');
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

module.exports = { allRows, seedDefault, upsertMany };
