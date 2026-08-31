// ============================================================
// health.repo.js — فحص اتصال قاعدة البيانات (SELECT 1 فقط)
// ============================================================
const { pool } = require('../db');

// يرجع true إذا كانت القاعدة تستجيب (أي أنها متاحة)
async function ping() {
  const r = await pool.query('SELECT 1');
  return r.rows[0]?.['1'] === 1;
}

module.exports = { ping };