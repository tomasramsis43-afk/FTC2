// اختبارات المرحلة 0 (شبكة الأمان): قياس التخزين، عدّاد 409، وحواجز على workflow النسخ الاحتياطي.
'use strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { fmtBytes, compareSnapshots, toMarkdown } = require('../scripts/storage-baseline.js');
const metrics = require('../metrics.js');

test('fmtBytes: وحدات صحيحة', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
});

test('compareSnapshots: نسبة التغيّر لكل جدول وتجاهل الجداول الجديدة/الفارغة', () => {
  const before = { tables: [{ table: 'a', total_bytes: 1000 }, { table: 'z', total_bytes: 0 }] };
  const after = { tables: [{ table: 'a', total_bytes: 400 }, { table: 'z', total_bytes: 5 }, { table: 'new', total_bytes: 9 }] };
  const r = compareSnapshots(before, after);
  assert.equal(r.length, 1);
  assert.equal(r[0].table, 'a');
  assert.equal(Math.round(r[0].pct), -60);
});

function fakeRes(status) { const r = new EventEmitter(); r.statusCode = status; return r; }

test('conflictLogger: يعدّ 409 فقط ويطبع سطراً منظّماً ولا يغيّر الاستجابة', () => {
  metrics.reset();
  const lines = [];
  const mw = metrics.conflictLogger({ log: (l) => lines.push(l) });
  let nextCalled = 0;
  const mk = (status, url) => { const res = fakeRes(status); mw({ method: 'PUT', originalUrl: url }, res, () => nextCalled++); res.emit('finish'); };
  mk(200, '/api/client-records/abcdef123456');
  mk(409, '/api/client-records/abcdef123456?x=1');
  mk(409, '/api/client-records/0123456789ab');
  mk(404, '/api/x');
  assert.equal(nextCalled, 4, 'لازم يستدعي next دائماً');
  const s = metrics.snapshot();
  assert.equal(s.conflict409, 2);
  assert.equal(s.byRoute['PUT /api/client-records/:id'], 2, 'المعرّفات تُجمَّع تحت :id');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[metric\] conflict409 route="PUT \/api\/client-records\/:id"/);
});

test('db-backup.yml: حواجز الأمان موجودة (تشفير، استرجاع تجريبي، حذف النص الصريح، حد أدنى للاحتفاظ)', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'db-backup.yml'), 'utf8');
  assert.match(y, /age -r "\$AGE_PUBLIC_KEY"/, 'التشفير بمفتاح عام');
  assert.doesNotMatch(y, /AGE_PRIVATE|AGE_SECRET_KEY|AGE-SECRET-KEY/, 'المفتاح الخاص لا يدخل GitHub');
  assert.match(y, /pg_restore .*--exit-on-error/, 'استرجاع تجريبي يفشل عند أول خطأ');
  assert.match(y, /shred -u ftc2\.dump/, 'حذف الملف غير المشفّر');
  assert.match(y, /MIN_KEEP: '7'/, 'حد أدنى للنسخ المحتفظ بها');
  assert.doesNotMatch(y, /s3 (cp|sync) ftc2\.dump(?!\.age)/, 'لا يُرفع الملف غير المشفّر');
  assert.match(y, /actions\/upload-artifact@v4/, 'حفظ النسخة كـ artifact');
  assert.match(y, /path: \|\n\s+ftc2-\*\.dump\.age\n/, 'الـ artifact للملف المشفّر فقط');
  assert.doesNotMatch(y, /path:[^\n]*ftc2\.dump\s*$/m, 'لا يُرفع dump غير مشفّر كـ artifact');
});

test('toMarkdown: أحجام فقط — لا أعداد سجلات ولا بيانات حساسة (الريبو عام)', () => {
  const snap = {
    takenAt: '2026-10-07T00:00:00Z', dbBytes: 50 * 1024 * 1024,
    tables: [{ table: 'client_records', total_bytes: 10 * 1024 * 1024, est_rows: 4321 }],
    collections: [{ collection: 'vaultTx', records: 987, enc_bytes: 2 * 1024 * 1024, max_record_bytes: 4096, avg_record_bytes: 100 }],
    clientRecords: { records: 5555, enc_bytes: 9 * 1024 * 1024, avg_record_bytes: 1700 },
    kvTop: [{ key: 'settings', bytes: 2048, version: 3 }], appBackups: { n: 12, bytes: 1024 * 1024 },
  };
  const md = toMarkdown(snap);
  assert.match(md, /50\.0 MB/);
  assert.match(md, /\| client_records \| 10\.0 MB \|/);
  assert.match(md, /\| vaultTx \| 2\.0 MB \| 4\.0 KB \|/);
  for (const secret of ['4321', '987', '5555']) assert.ok(!md.includes(secret), 'لا يظهر عدد السجلات: ' + secret);
});
