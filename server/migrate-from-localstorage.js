/*
  ترحيل البيانات الحالية (المخزّنة محلياً في المتصفح) إلى قاعدة البيانات المركزية.

  الخطوة 1 — من داخل البرنامج القديم (قبل التحويل)، افتح "أدوات المطوّر" في
  المتصفح (F12) ثم تبويب Console، والصق الكود التالي واضغط Enter:

    (function(){
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('priv:')) out[k.slice(5)] = localStorage.getItem(k);
      }
      const blob = new Blob([JSON.stringify(out, null, 2)], {type:'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'exported-data.json';
      a.click();
    })();

  هذا يُنزّل ملف "exported-data.json" فيه كل بيانات البرنامج كما هي (لا يزال
  كل مفتاح مشفّراً كنص، الخادم لن يفكّ تشفيره أبداً — فقط ينقله كما هو).

  الخطوة 2 — انسخ الملف بجانب هذا السكربت وشغّل:
    node migrate-from-localstorage.js ./exported-data.json
*/
require('dotenv').config();
const fs = require('fs');
const { pool, ensureSchema } = require('./db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('الاستخدام: node migrate-from-localstorage.js <exported-data.json>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  await ensureSchema();
  const keys = Object.keys(data);
  console.log(`سيتم استيراد ${keys.length} مفتاح...`);
  for (const key of keys) {
    await pool.query(
      `INSERT INTO kv_store (key, value, version, updated_by)
       VALUES ($1, $2, 1, 'migration')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = kv_store.version + 1, updated_at = now()`,
      [key, data[key]]
    );
    console.log(`  ✔ ${key}`);
  }
  console.log('✅ اكتمل الترحيل.');
  await pool.end();
}

main().catch(e => { console.error('❌ فشل الترحيل:', e); process.exit(1); });
