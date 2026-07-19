const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('❌ متغيّر البيئة DATABASE_URL غير موجود. راجع ملف .env.example');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // معظم مزودي الاستضافة السحابية (Render/Railway) يتطلبون SSL؛ هذا الإعداد يقبل
  // شهاداتهم الموقّعة ذاتياً. إن كنت تشغّل Postgres محلياً بدون SSL، احذف هذا السطر.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, ensureSchema };
