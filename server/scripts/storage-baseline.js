#!/usr/bin/env node
// ============================================================
// storage-baseline.js — خط أساس لحجم التخزين (المرحلة 0)
// ------------------------------------------------------------
// قراءة فقط (transaction READ ONLY): لا يكتب ولا يغيّر أي شيء.
// الاستخدام:   DATABASE_URL=... node scripts/storage-baseline.js [--out baseline.json]
// الناتج: جدول مقروء في الطرفية + JSON اختياري لمقارنته بعد كل مرحلة.
// ============================================================
const fs = require('fs');

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

// يقارن لقطتين (قبل/بعد مرحلة) ويرجع نسبة التغيّر في الحجم الكلي لكل جدول.
function compareSnapshots(before, after) {
  const out = [];
  const b = new Map((before.tables || []).map(t => [t.table, t]));
  for (const t of after.tables || []) {
    const prev = b.get(t.table);
    if (!prev || !prev.total_bytes) continue;
    out.push({ table: t.table, before: prev.total_bytes, after: t.total_bytes, pct: ((t.total_bytes - prev.total_bytes) / prev.total_bytes) * 100 });
  }
  return out;
}

// ملخّص Markdown للأحجام فقط (بلا أعداد سجلات ولا محتوى) — يُكتب في ملخّص تشغيل GitHub.
// الريبو عام، فنكتفي بالأحجام المقرّبة ولا نكشف عدد العملاء/السجلات.
function toMarkdown(s) {
  const L = [];
  L.push(`## حجم التخزين — ${s.takenAt}`, '');
  L.push(`**الحجم الكلي لقاعدة البيانات:** ${fmtBytes(s.dbBytes)}`, '');
  L.push('| الجدول | الكلي | البيانات | الفهارس | TOAST | ميّت % |', '|---|---|---|---|---|---|');
  s.tables.forEach(t => L.push(`| ${t.table} | ${fmtBytes(t.total_bytes)} | ${fmtBytes(t.heap_bytes)} | ${fmtBytes(t.index_bytes)} | ${fmtBytes(t.toast_bytes)} | ${t.dead_pct == null ? '-' : t.dead_pct} |`));
  if (s.indexes && s.indexes.length) {
    L.push('', '| أكبر الفهارس | الجدول | الحجم |', '|---|---|---|');
    s.indexes.forEach(i => L.push(`| ${i.index} | ${i.table} | ${fmtBytes(i.bytes)} |`));
  }
  L.push('', '| collection_records | الحجم | أكبر سجل |', '|---|---|---|');
  s.collections.forEach(c => L.push(`| ${c.collection} | ${fmtBytes(c.enc_bytes)} | ${fmtBytes(c.max_record_bytes)} |`));
  L.push('', `**client_records:** ${fmtBytes(s.clientRecords.enc_bytes)} (متوسط السجل ${fmtBytes(s.clientRecords.avg_record_bytes)})`);
  L.push(`**app_backups:** ${fmtBytes(s.appBackups.bytes)}`, '');
  L.push('| أكبر مفاتيح kv_store | الحجم |', '|---|---|');
  s.kvTop.forEach(k => L.push(`| ${k.key} | ${fmtBytes(k.bytes)} |`));
  if (s.missingTables && s.missingTables.length) L.push('', `⚠️ جداول غير موجودة في هذه القاعدة: ${s.missingTables.join(', ')}`);
  return L.join('\n') + '\n';
}

async function collect(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const db = (await c.query('select pg_database_size(current_database())::bigint as bytes')).rows[0];
    const tables = (await c.query(`
      select c.relname as "table",
             pg_total_relation_size(c.oid)::bigint as total_bytes,
             pg_relation_size(c.oid)::bigint as heap_bytes,
             pg_indexes_size(c.oid)::bigint as index_bytes,
             coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)::bigint as toast_bytes,
             c.reltuples::bigint as est_rows,
             case when coalesce(s.n_live_tup,0) + coalesce(s.n_dead_tup,0) > 0
                  then round(100.0 * s.n_dead_tup / (s.n_live_tup + s.n_dead_tup), 1) else 0 end as dead_pct
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
      order by pg_total_relation_size(c.oid) desc`)).rows;
    const indexes = (await c.query(`
      select relname as "table", indexrelname as "index", pg_relation_size(indexrelid)::bigint as bytes
      from pg_stat_user_indexes where schemaname = 'public'
      order by pg_relation_size(indexrelid) desc limit 10`)).rows;
    // جداول قد لا تكون موجودة في كل قاعدة (قاعدة أقدم/مختلفة): نفحص الوجود بدل الانهيار.
    const has = async (t) => (await c.query('select to_regclass($1) is not null as ok', ['public.' + t])).rows[0].ok;
    const collections = (await has('collection_records')) ? (await c.query(`
      select collection, count(*)::int as records,
             coalesce(sum(octet_length(enc)),0)::bigint as enc_bytes,
             coalesce(max(octet_length(enc)),0)::bigint as max_record_bytes,
             coalesce(avg(octet_length(enc)),0)::bigint as avg_record_bytes
      from collection_records group by collection order by enc_bytes desc`)).rows : [];
    const clientRecords = (await has('client_records')) ? (await c.query(`
      select count(*)::int as records,
             coalesce(sum(octet_length(enc)),0)::bigint as enc_bytes,
             coalesce(avg(octet_length(enc)),0)::bigint as avg_record_bytes
      from client_records`)).rows[0] : { records: 0, enc_bytes: 0, avg_record_bytes: 0 };
    const kv = (await has('kv_store')) ? (await c.query(`
      select key, octet_length(value)::bigint as bytes, version
      from kv_store order by octet_length(value) desc nulls last limit 15`)).rows : [];
    const backups = (await has('app_backups')) ? (await c.query(`
      select count(*)::int as n, coalesce(sum(octet_length(enc)),0)::bigint as bytes from app_backups`)).rows[0] : { n: 0, bytes: 0 };
    const missing = [];
    for (const t of ['collection_records', 'client_records', 'kv_store', 'app_backups', 'clients_rows']) if (!(await has(t))) missing.push(t);
    await c.query('COMMIT');
    return { takenAt: new Date().toISOString(), dbBytes: Number(db.bytes), tables, collections, clientRecords, kvTop: kv, appBackups: backups, missingTables: missing, indexes };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

function print(s) {
  const line = (a, b, c) => console.log(`${String(a).padEnd(28)}${String(b).padStart(12)}${c !== undefined ? String(c).padStart(14) : ''}`);
  console.log(`\nحجم قاعدة البيانات الكلي: ${fmtBytes(s.dbBytes)}   (${s.takenAt})\n`);
  console.log('— الجداول (الحجم الكلي مع الفهارس) —');
  line('table', 'size', 'est. rows');
  s.tables.forEach(t => line(t.table, fmtBytes(t.total_bytes), t.est_rows));
  console.log('\n— collection_records (المشفّر) —');
  line('collection', 'size', 'records');
  s.collections.forEach(r => line(r.collection, fmtBytes(r.enc_bytes), r.records));
  console.log(`\nclient_records: ${s.clientRecords.records} سجل — ${fmtBytes(s.clientRecords.enc_bytes)} — متوسط ${fmtBytes(s.clientRecords.avg_record_bytes)}`);
  console.log(`app_backups: ${s.appBackups.n} نسخة — ${fmtBytes(s.appBackups.bytes)}`);
  console.log('\n— أكبر مفاتيح kv_store —');
  s.kvTop.forEach(k => line(k.key, fmtBytes(k.bytes), `v${k.version}`));
  console.log('');
}

module.exports = { fmtBytes, compareSnapshots, collect, toMarkdown };

if (require.main === module) {
  (async () => {
    const { pool } = require('../db');
    try {
      const snap = await collect(pool);
      if (process.argv.includes('--summary')) process.stdout.write(toMarkdown(snap));
      else print(snap);
      const i = process.argv.indexOf('--out');
      if (i > -1 && process.argv[i + 1]) {
        fs.writeFileSync(process.argv[i + 1], JSON.stringify(snap, null, 2));
        console.log(`تم حفظ اللقطة في ${process.argv[i + 1]}`);
      }
    } catch (e) {
      console.error('فشل القياس:', e.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
