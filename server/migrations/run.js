// ============================================================
// migrations/run.js — تشغيل الترحيلات يدوياً (سطر الأوامر)
// ------------------------------------------------------------
// التشغيل التلقائي عند الإقلاع يشغّل الترحيلات الآمنة فقط (انظر server.js).
// الترحيلات التدميرية (حذف جداول ZATCA الباقيا) لا تُشغَّل إلا من هنا:
//   node server/migrations/run.js --allow-destructive
//   node server/migrations/run.js --only 2026-01-02-clients-rows-index-cleanup
// يُنصح دائماً بأخذ نسخة احتياطية (pg_dump) قبل --allow-destructive.
// ============================================================
require('dotenv').config();
const { runMigrations, MIGRATIONS } = require('./index');
const { pool } = require('../db');

const argv = process.argv.slice(2);
const allowDestructive = argv.includes('--allow-destructive');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const listOnly = argv.includes('--list');

(async () => {
  if (listOnly) {
    console.log('الترحيلات المتاحة:');
    MIGRATIONS.forEach(m => console.log(`  [${m.safe ? 'آمن  ' : 'تدميري'}] ${m.id} — ${m.title || ''}`));
    process.exit(0);
  }
  if (!process.env.DATABASE_URL) {
    console.error('❌ متغيّر البيئة DATABASE_URL غير موجود.');
    process.exit(1);
  }
  if (only && !MIGRATIONS.some(m => m.id === only)) {
    console.error('❌ لا يوجد migration بالمعرّف: ' + only);
    process.exit(1);
  }
  if (allowDestructive) {
    console.warn('⚠️  تم السماح بالترحيلات التدميرية — تأكّد من وجود نسخة احتياطية سليمة قبل المتابعة.');
  }
  try {
    const res = await runMigrations({ allowDestructive, only });
    console.log(`\nالنتيجة: ${res.applied.length} مطبَّقة، ${res.skipped.length} متخطّاة، ${res.failed.length} فاشلة.`);
    if (res.failed.length) process.exit(1);
  } catch (e) {
    console.error('❌ تعذّر تشغيل الترحيلات:', e.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
})();
