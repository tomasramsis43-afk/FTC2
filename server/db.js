const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('❌ متغيّر البيئة DATABASE_URL غير موجود. راجع ملف .env.example');
  process.exit(1);
}

// بعض روابط الاستضافة السحابية الجاهزة (Render/Railway/Neon...) تأتي بامتداد ?sslmode=require
// جوه الرابط نفسه. مكتبة pg (v8.12+) تُعطي الأولوية لهذا الجزء من الرابط على إعداد `ssl` الذي
// نمرّره صراحةً أدناه — فتفرض تحقق شهادة صارم (verify-full) بصمت، متجاهلةً rejectUnauthorized:false
// المقصود، وهو بالضبط تحذير "SECURITY WARNING" الذي تطبعه عند بدء التشغيل. نحذف sslmode من
// الرابط هنا حتى يبقى إعداد `ssl` أدناه هو المتحكم الوحيد والفعلي دائماً، بغض النظر عمّا يصل
// فى DATABASE_URL من لوحة تحكم الاستضافة.
function stripSslModeFromConnectionString(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch (e) {
    return url; // رابط غير قياسي (نادر) — نتركه كما هو بدل تعطيل الاتصال بالكامل
  }
}

const pool = new Pool({
  connectionString: stripSslModeFromConnectionString(process.env.DATABASE_URL),
  // معظم مزودي الاستضافة السحابية (Render/Railway) يتطلبون SSL؛ هذا الإعداد يقبل
  // شهاداتهم الموقّعة ذاتياً. إن كنت تشغّل Postgres محلياً بدون SSL، احذف هذا السطر.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, ensureSchema };
