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

async function collect(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const db = (await c.query('select pg_database_size(current_database())::bigint as bytes')).rows[0];
    const tables = (await c.query(`
      select c.relname as "table",
             pg_total_relation_size(c.oid)::bigint as total_bytes,
             pg_relation_size(c.oid)::bigint as heap_bytes,
             c.reltuples::bigint as est_rows
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by pg_total_relation_size(c.oid) desc`)).rows;
    const collections = (await c.query(`
      select collection, count(*)::int as records,
             coalesce(sum(octet_length(enc)),0)::bigint as enc_bytes,
             coalesce(max(octet_length(enc)),0)::bigint as max_record_bytes,
             coalesce(avg(octet_length(enc)),0)::bigint as avg_record_bytes
      from collection_records group by collection order by enc_bytes desc`)).rows;
    const clientRecords = (await c.query(`
      select count(*)::int as records,
             coalesce(sum(octet_length(enc)),0)::bigint as enc_bytes,
             coalesce(avg(octet_length(enc)),0)::bigint as avg_record_bytes
      from client_records`)).rows[0];
    const kv = (await c.query(`
      select key, octet_length(value)::bigint as bytes, version
      from kv_store order by octet_length(value) desc nulls last limit 15`)).rows;
    const backups = (await c.query(`
      select count(*)::int as n, coalesce(sum(octet_length(enc)),0)::bigint as bytes from app_backups`)).rows[0];
    await c.query('COMMIT');
    return { takenAt: new Date().toISOString(), dbBytes: Number(db.bytes), tables, collections, clientRecords, kvTop: kv, appBackups: backups };
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

module.exports = { fmtBytes, compareSnapshots, collect };

if (require.main === module) {
  (async () => {
    const { pool } = require('../db');
    try {
      const snap = await collect(pool);
      print(snap);
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
