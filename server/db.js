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
  // إصلاح أمني: لا نقبل أي شهادة افتراضياً. استخدم DATABASE_SSL=false للتطوير المحلي فقط.
  // للإنتاج مع شهادة موثوقة: اضبط DATABASE_SSL=verify و DATABASE_SSL_CA بمحتوى شهادة CA.
  ssl: process.env.DATABASE_SSL === 'false' ? false
    : process.env.DATABASE_SSL === 'verify' && process.env.DATABASE_SSL_CA
    ? { rejectUnauthorized: true, ca: process.env.DATABASE_SSL_CA }
    : process.env.DATABASE_SSL === 'verify'
    ? { rejectUnauthorized: true }
    : { rejectUnauthorized: false },
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  query_timeout: 15000,
});
if (process.env.DATABASE_SSL !== 'false' && process.env.DATABASE_SSL !== 'verify') {
  console.warn('⚠️  تحذير أمني: DATABASE_SSL غير مُفعّل للتحقق الكامل (rejectUnauthorized:false). فعّل DATABASE_SSL=verify في الإنتاج مع شهادة CA موثوقة لتجنب هجمات MITM.');
}

// إصلاح حرج: قواعد Neon (serverless) تُنهي الاتصالات الخاملة في الـ pool من جهتها بين الحين
// والآخر (connection reset / idle termination على مستوى الشبكة). مكتبة pg تُطلق حدث 'error' على
// كائن الـ Pool نفسه عند ذلك. بدون مستمع لهذا الحدث هنا، Node.js يعامله كـ uncaught exception
// ويُسقط العملية بالكامل فوراً — وهو بالضبط ما كان يحدث كل بضع دقائق (انظر سجلات Render:
// "Error: Connection terminated unexpectedly" / "Emitted 'error' event on BoundPool instance").
// إضافة هذا المستمع لا "تُصلح" فقد الاتصال (فهو طبيعي ومتوقّع)، بل تمنع تحوّله إلى كراش: الـ pool
// يتخلص من الاتصال المعطوب ويفتح واحداً جديداً تلقائياً عند الطلب التالي.
pool.on('error', (err) => {
  console.error('⚠️  خطأ غير متوقع في اتصال قاعدة البيانات (تمت معالجته دون إسقاط الخادم):', err.message);
});

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, ensureSchema };
