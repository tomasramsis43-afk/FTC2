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

// إصلاح أمني (آمن افتراضياً): لا نقبل أي شهادة غير موثوقة إلا صراحةً.
//   DATABASE_SSL=false        → بلا TLS إطلاقاً (للتطوير المحلي فقط — لا للاستضافة).
//   DATABASE_SSL=verify       → تحقق صارم من الشهادة (rejectUnauthorized:true).
//   DATABASE_SSL=verify + CA  → تحقق صارم بشهادة CA مخصصة (الاستضافة ذات الشهادة الذاتية).
//   غير مضبوط / أي قيمة أخرى  → تحقق صارم بحزمة الشهادات النظامية — يساوي verify تماماً.
// لا يوجد أي فرع "TLS بدون تحقق" (rejectUnauthorized:false) بعد الآن؛ من يحتاج ذلك
// عليه تعطيل التحقق على مستوى البيئة صراحةً (NODE_TLS_REJECT_UNAUTHORIZED=0) بوازن الخطر.
const databaseSslValue = (process.env.DATABASE_SSL || 'verify').toLowerCase();
let sslConfig;
if (databaseSslValue === 'false') {
  sslConfig = false;
  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️  تحذير: DATABASE_SSL=false مضبوط في بيئة إنتاج — الاتصال بقاعدة البيانات بدون TLS (غير آمن).');
  }
} else if (databaseSslValue === 'verify' && process.env.DATABASE_SSL_CA) {
  sslConfig = { rejectUnauthorized: true, ca: process.env.DATABASE_SSL_CA };
} else {
  sslConfig = { rejectUnauthorized: true };
}

const pool = new Pool({
  connectionString: stripSslModeFromConnectionString(process.env.DATABASE_URL),
  ssl: sslConfig,
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  query_timeout: 15000,
});

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
