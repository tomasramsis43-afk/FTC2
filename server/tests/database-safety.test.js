// ═══════════════════════════════════════════════════════════════════════════════
// database-safety.test.js — حواجز الأمان لقاعدة البيانات
// ------------------------------------------------------------
// اختبارات ثابتة (static guards) على الكود المصدري تحرس ضد تكرار الأخطاء
// التالية بعد أي تعديل مستقبلي:
//   ١) DDL تدميري (DROP/TRUNCATE) يُنفَّذ في كل إقلاع عبر schema.sql
//   ٢) إعادة بناء/مسح clients_rows عند الإقلاع من الكتلة التراثية الجمودة
//   ٣) O(N²) في المزامنة الجماعية بسبب جداول مؤقتة بلا فهارس
//   ٤) اقتطاع غير معلن في تنظيف السجلات (prune) — يجب أن يحذف الكل
//   ٥) تغيّر شكل استجابة /api/records/pending (الواجهة تتوقع records مصفوفة)
// ═══════════════════════════════════════════════════════════════════════════════
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const serverDir = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(serverDir, rel), 'utf8');
// يقتطع تعليقات SQL (-- إلى نهاية السطر) و(/* */) حتى لا تُحسب الأمثلة
// الموثّقة داخل الكود كاستعلامات منفَّذة فعلاً.
const stripSqlComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
// يقتطع تعليقات JS السطرية/الكتلية (بما فيها أمثلة SQL داخل /* */ و //)
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
// يستخرج جسم دالة/معالِج حتى نهايته (بديل أدقّ من المطابقة الكسولة البسيطة التي
// كانت تتوقف عند أول "});" داخلي مثل res.json({...});).
// ثلاث نقاط كانت تكسر الاستخراج البسيط:
//   ١) نبدأ من قوس المعاملات (Paren) لا أول "{" — وإلا بدأ العدّ عند opts = {}
//   ٢) المسارات在她的 معاملات arrow مثل
//      router.get(p, mw, async (req,res) => { BODY })  ⇒ جسم الدالة قبل القوس
//      الأخير، لا بعده. لذلك نبحث عن "=> {" عند عمق قوس واحد.
//   ٣) نتجاهل الأقواس داخل نصوص SQL المدمجة (${...}) لأن عدّها يفسد التطابق.
const fnBody = (src, header) => {
  const i = src.indexOf(header);
  assert.ok(i >= 0, `لم يُعثر على: ${header}`);
  const open = src.indexOf('(', i);
  assert.ok(open >= 0, `لا توجد قائمة معاملات بعد: ${header}`);
  let p = 0, bodyStart = -1, close = -1;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if (ch === '(') { p++; continue; }
    if (ch === ')') { p--; if (p === 0) { close = k; break; } continue; }
    // "=> {" عند عمق واحد = جسم مُعالِج arrow داخل قائمة المعاملات
    if (p === 1 && ch === '=' && src[k + 1] === '>') {
      let j = k + 2;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '{') { bodyStart = j; break; }
    }
  }
  if (bodyStart < 0) {
    assert.ok(close > 0, `لم يُغلق قوس المعاملات في: ${header}`);
    bodyStart = close + 1;
    while (bodyStart < src.length && /\s/.test(src[bodyStart])) bodyStart++;
  }
  assert.ok(src[bodyStart] === '{', `لا يوجد جسم دالة بعد المعاملات في: ${header}`);
  let depth = 0, inTpl = false, inStr = false, esc = false;
  for (let k2 = bodyStart; k2 < src.length; k2++) {
    const ch = src[k2];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inStr) { if (ch === "'") inStr = false; continue; }
    if (inTpl) {
      if (ch === '`') { inTpl = false; continue; }
      if (ch === "'" ) { inStr = true; continue; }
      if (ch === '$' && src[k2 + 1] === '{') { k2++; depth++; continue; } // نقفز فوق ${...}
      if (ch === '}' && depth > 0) depth--;
      continue;
    }
    if (ch === '`') { inTpl = true; continue; }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(i, k2 + 1); }
  }
  return src.slice(i);
};

const schema = read('schema.sql');
const syncSvc = read(path.join('services', 'sync.js'));
const clientsRowsRepo = read(path.join('repo', 'clientsRows.repo.js'));
const recordsRepo = read(path.join('repo', 'records.repo.js'));
const recordsRoute = read(path.join('routes', 'records.js'));
const backupsRoute = read(path.join('routes', 'backups.js'));
const authRoute = read(path.join('routes', 'auth.js'));
const sse = read('sse.js');
const backupService = read(path.join('services', 'backup.js'));
const backupRepo = read(path.join('repo', 'backup.repo.js'));
const migrations = read(path.join('migrations', 'index.js'));
const serverJs = read('server.js');

// ═══════════════════════════════════════════════════════════════════════════════
// ١) لا DDL تدميري على الإقلاع
// ═══════════════════════════════════════════════════════════════════════════════
test('S1: schema.sql لا يحتوي أي DROP TABLE / DROP INDEX / TRUNCATE', () => {
  const destructive = stripSqlComments(schema).match(/^\s*(DROP\s+(TABLE|INDEX)|TRUNCATE)\b/gim);
  assert.strictEqual(destructive, null,
    `schema.sql يُنفّذ عند كل إقلاع — لا يجوز أن يحتوي DDL تدميري:\n${(destructive || []).join('\n')}`);
});

test('S2: لا UPDATE على جدول كامل يتكرر عند كل إقلاع في schema.sql', () => {
  // أي UPDATE داخل schema.sql = "مسح + إعادة كتابة كل الصفوف" يتكرر عند كل إقلاع
  // (مع توليد dead tuples في WAL). كل تعبئة بيانات (backfill) يجب أن تُنفَّذ عبر
  // Migration تُسجَّل في _schema_migrations وتعمل مرّة واحدة فقط.
  const updates = stripSqlComments(schema).match(/^\s*UPDATE\s+\w+/gim) || [];
  assert.strictEqual(updates.length, 0,
    `Backfill داخل schema.sql يتكرر عند كل إقلاع — انقله إلى migrations/index.js:\n${updates.join('\n')}`);
});

test('S3: الترحيلات التدميرية مُعلَّمة safe:false ولا تُشغَّل تلقائياً عند الإقلاع', () => {
  assert.ok(/safe:\s*false/.test(migrations), 'يوجد ترحيل تدميري مُعلَّم');
  // الإقلاع يشغّل الترحيلات WITHOUT allowDestructive
  assert.ok(/runMigrations\(\{\s*allowDestructive:\s*false\s*\}\)/.test(serverJs),
    'server.js يشغّل الترحيلات الآمنة فقط (allowDestructive:false)');
  // وDDL التدميري موجود داخل up() الخاص بالترحيل (لا في schema.sql)
  assert.ok(/DROP TABLE IF EXISTS zatca_invoice_log/.test(migrations));
  assert.ok(!/^\s*DROP TABLE IF EXISTS zatca_invoice_log/m.test(stripSqlComments(schema)),
    'لا يجوز بقاء DROP TABLE في schema.sql (كان يمرّ عند كل إقلاع)');
});

test('S4: كل ترحيل له معرّف فريد (وإلا اختلف إقراره بين النسخ)', () => {
  const ids = [...migrations.matchAll(/id:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(ids.length >= 5, `عدد الترحيلات: ${ids.length}`);
  assert.strictEqual(new Set(ids).size, ids.length, 'يوجد معرّف migration مكرر');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ٢) لا إعادة بناء/مسح clients_rows عند الإقلاع
// ═══════════════════════════════════════════════════════════════════════════════
test('S5: الإقلاع لا يستدعي syncAll/queueSync (إعادة بناء كاملة) — فحص قراءة فقط', () => {
  const body = fnBody(syncSvc, 'async function startupCheckAndSync()');
  assert.ok(!/queueSync\(/.test(body), 'الإقلاع لا يمرّر عملاً إلى طابور المزامنة');
  // الاستدعاء الوحيد لـ syncDirect داخل الإقلاع مسموح فقط في شرط "الفهرس فارغ"
  assert.ok(/indexRows\s*===\s*0/.test(body), 'التهيئة من الكتلة التراثية تحدث فقط عند فراغ الفهرس');
  assert.ok(/syncDirect\(value,\s*\{\s*prune:\s*false\s*\}\)/.test(body),
    'التهيئة الأولى تمرّ بـ prune:false (دمج بلا حذف)');
  // النتيجة مُنتظَرة (لا ملقاة) ⇒ لا تتكرر المزامنة على كل إعادة محاولة
  assert.ok(/await syncService\.startupCheckAndSync\(\)/.test(serverJs),
    'server.js ينتظر نتيجة الفحص عند الإقلاع');
});

test('S6: الحذف داخل syncAll مشروط بـ prune=true صراحة (لا حذف افتراضي)', () => {
  assert.ok(/const\s*\{\s*prune\s*=\s*false\s*\}\s*=\s*opts/.test(clientsRowsRepo),
    'syncAll يجب أن يكون prune=false افتراضياً');
  assert.ok(/if\s*\(prune\)\s*\{[\s\S]*?DELETE FROM clients_rows/.test(clientsRowsRepo),
    'الـ DELETE داخل كتلة if (prune)');
});

test('S7: حذف orphan يعتمد client_records كمصدر حقيقة (لا يمكنه حذف صف حيّ)', () => {
  const body = fnBody(clientsRowsRepo, 'async function deleteOrphans()');
  assert.ok(/NOT EXISTS\s*\(\s*SELECT 1 FROM client_records/.test(body),
    'deleteOrphans يحذف فقط ما لا وجود له في client_records');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ٣) لا O(N²) في المزامنة الجماعية
// ═══════════════════════════════════════════════════════════════════════════════
test('S8: الجداول المؤقتة في bulkMigrate مفهرسة (المفتاح الأساسي) ⇒ لا O(N²)', () => {
  const body = fnBody(recordsRepo, 'async function bulkMigrate');
  for (const t of ['_inc', '_conf']) {
    assert.ok(new RegExp(`CREATE TEMP TABLE ${t}[\\s\\S]{0,400}?id[^;]*?PRIMARY KEY`, 'i').test(body),
      `${t} بلا PRIMARY KEY على id ⇒ كل صف يعمل مسحاً كاملاً على الجدول المؤقت = O(N²)`);
  }
});

test('S9: bulkMigrate لم يعد يبني مصفوفة معرّفات من _inc (استعلام زائد)', () => {
  const body = fnBody(recordsRepo, 'async function bulkMigrate');
  assert.ok(!/SELECT\s+id\s+FROM\s+_inc/.test(stripJsComments(body)),
    'الاستعلام الزائد SELECT id FROM _inc ما زال موجوداً (UDPATE يسترجع البيانات أصلاً)');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ٤) لا اقتطاع في prune
// ═══════════════════════════════════════════════════════════════════════════════
test('S10: recordPrune يحذف كل الصفوف المؤهلة (دفعات حتى الاكتمال، لا LIMIT نهائي)', () => {
  const body = fnBody(recordsRepo, 'async function recordPrune(');
  assert.ok(/for\s*\(\s*;;\s*\)|for\s*\(\s*;\s*;\s*\)/.test(body), 'recordPrune ليست في حلقة دفعات');
  assert.ok(/if\s*\(r\.rowCount\s*<\s*PRUNE_BATCH\)\s*break/.test(body),
    'الحلقة لا تتوقف إلا عندما يقل عدد المحذوف عن حجم الدفعة (أي اكتمال)');
  assert.ok(/total\s*\+=\s*r\.rowCount/.test(body), 'يُرجع الإجمالي المحذوف لا دفعة واحدة فقط');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ٥) عقد الاستجابة
// ═══════════════════════════════════════════════════════════════════════════════
test('S11: /api/records/pending يُبقي records مصفوفة كما تستهلكها الواجهة', () => {
  const body = fnBody(recordsRoute, "router.get('/api/records/pending'");
  assert.ok(/const\s*\{\s*rows,\s*total\s*\}\s*=\s*await recordsRepo\.pendingRecordsAll\(\)/.test(body),
    'المسار يفكّ Pack نتيجة pendingRecordsAll (rows/total) بدل تمريرها كـ array');
  assert.ok(/res\.json\(\{\s*records:\s*rows\s*,\s*total\s*,\s*truncated:/.test(body),
    'الاستجابة تحافظ على records مصفوفة وتضيف total/truncated كحقول إضافية فقط');
  assert.ok(!/res\.json\(\{\s*records:\s*rows\s*\}\s*\)/.test(body),
    'لا يجوز لفّ الكائن {rows,total} داخل records — الواجهة تعمل على for(const r of data.records)');
  // الواجهة نفسها لا يجوز أن تتغيّر
  const feSync = fs.readFileSync(path.join(serverDir, '..', 'frontend', 'js', 'clients-alerts-overview.js'), 'utf8');
  assert.ok(/for\s*\(\s*const\s+r\s+of\s*\(\s*data\.records\s*\|\|\s*\[\s*\]\s*\)\s*\)/.test(feSync),
    'الواجهة ما زالت تتوقّع records مصفوفة');
});

test('S12: pendingRecordsAll محدود بسقف مع COUNT (استجابة غير محدودة لا تعود)', () => {
  const body = fnBody(recordsRepo, 'async function pendingRecordsAll(');
  assert.ok(/limit\s+\$1/i.test(body), 'السقف مطبَّق داخل الاستعلام (لا قصّ في JS بعد جلب الكل)');
  assert.ok(/count\(\*\)/i.test(body), 'يوجد عدّ الإجمالي (total) للاعلام عن الاقتطاع');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ٦) استعلام الفهرس لا يكتب على pool منفصل داخل معاملة مقفلة
// ═══════════════════════════════════════════════════════════════════════════════
test('S13: عمليات الكتابة على clients_rows كلها تمرّ بقفل تزامن واحد', () => {
  // upsertChunkOn هي التنفيذ الفعلي، وهي سليمة فقط إن نفّذت على الاتصال الممرَّر
  // (حامل القفل داخل معاملة واحدة) ولم تفتح اتصالاً مستقلاً من الـ pool.
  const on = fnBody(clientsRowsRepo, 'async function upsertChunkOn(');
  assert.ok(/execOn\(client/.test(on), 'upsertChunkOn ينفّذ على الاتصال الممرَّر (execOn)');
  assert.ok(!/pool\.query\(/.test(on), 'upsertChunkOn لا يستخدم pool.query مباشرة (يكسر معاملة القفل)');
  // execOn نفسه: يستخدم pool.query فقط عند عدم تمرير عميل
  const execOn = fnBody(clientsRowsRepo, 'async function execOn(');
  assert.ok(/return\s+client\s*\?\s*client\.query/.test(execOn), 'execOn يفضّل الاتصال الممرَّر');

  for (const fn of ['upsertChunk', 'syncAll', 'deleteOrphans', 'deleteIds', 'deleteAll']) {
    const body = fnBody(clientsRowsRepo, `async function ${fn}(`);
    assert.ok(/pool\.connect\(\)/.test(body), `${fn} يستخدم اتصالاً مخصّصاً (يحمل القفل حتى COMMIT)`);
    assert.ok(/pg_advisory_xact_lock/.test(body), `${fn} لا يكتسب قفل التزامن ⇒ سباق بين مثيلين`);
    assert.ok(/COMMIT/.test(body) && /ROLLBACK/.test(body),
      `${fn} لا يضمن تحرير القفل (COMMIT/ROLLBACK) عند الخطأ`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ٧) تقليم النسخ الاحتياطية: عدد + بايت فعلي، ولا يحذف أبداً أحدث نسخة
// ═══════════════════════════════════════════════════════════════════════════════
test('S14: فحص حجم النسخة بالبايت الفعلي لا بطول نص JS', () => {
  const body = fnBody(backupService, 'async function create(');
  assert.ok(/Buffer\.byteLength\(enc,\s*'utf8'\)/.test(body),
    'الفحص يجب أن يستخدم Buffer.byteLength (enc.length = وحدات UTF-16 ≠ حجم التخزين)');
  assert.ok(!/enc\.length\s*>/.test(body), 'enc.length ما زال مستخدماً في فحص الحجم');
});

test('S15: التقليم يحترم ميزانية البايت بمجموع تراكمي (وليس طرح المجموع من الحدّ)', () => {
  const body = fnBody(backupRepo, 'async function insertAndPrune(');
  assert.ok(/SUM\(size_bytes\)\s*OVER\s*\(/i.test(body),
    'المجموع التراكمي مطلوب: عدد الصفوف ضمن الميزانية لا يُعرف بطرح المجموع');
  assert.ok(!/GREATEST\(\s*0,\s*\$\d+\s*::?\s*bigint\s*-\s*COALESCE\(SUM/i.test(body),
    'طرح المجموع من الحدّ يعطي الفائض بالبايت لا عدد الصفوف');
  assert.ok(/ROW_NUMBER\(\)\s*OVER/i.test(body) && /t\.rn\s*=\s*1/.test(body),
    'شرط أمان: أحدث نسخة (rn=1) لا تُحذف حتى لو تجاوزت الميزانية وحدها');
  assert.ok(/COMMIT/.test(body) && /ROLLBACK/.test(body), 'الحفظ والتقليم داخل معاملة واحدة');
});

test('S16: تقليم النسخ حتمي (يكسر التعادل بـ id) ومفهرس', () => {
  const body = fnBody(backupRepo, 'async function insertAndPrune(');
  const orders = body.match(/ORDER BY created_at DESC, id DESC/g) || [];
  assert.ok(orders.length >= 3, `الترتيب الحتمي مطلوب في كل مسارات الترتيب (وجد ${orders.length})`);
  assert.ok(/idx_app_backups_created_at ON app_backups\(created_at DESC, id DESC\)/.test(schema),
    'فهرس الترتيب/التقليم ناقص أو غير حتمي');
});

test('S17: حذف نسخة يُرجع حقيقة الحذف بدل true دائماً', () => {
  const repo = fnBody(backupRepo, 'async function del(');
  assert.ok(/rowCount\s*>\s*0/.test(repo), 'del يجب أن يعتمد rowCount لا الحذف الصامت');
  const route = stripJsComments(fnBody(backupsRoute, "router.delete('/api/backups/:id'"));
  assert.ok(/res\.json\(\{\s*deleted\s*\}\)/.test(route), 'المسار يرسل deleted مباشرة');
  assert.ok(!/deleted:\s*true/.test(route), '"deleted: true" ثابتة تُبلّغ حذفاً لم يحدث');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ٨) قناة SSE: سقف ذاكرة + معالجة الضغط + تنظيف الوصلات الميتة
// ═══════════════════════════════════════════════════════════════════════════════
test('S18: قناة SSE لها سقف صريح لاتصالات مفتوحة', () => {
  assert.ok(/MAX_CLIENTS\s*=\s*Number\(process\.env\.SSE_MAX_CLIENTS\s*\|\|\s*\d+\)/.test(sse),
    'سقف الاتصالات غير معرَّف/غير قابل للضبط');
  assert.ok(/function canAcceptClient\(\)[\s\S]*?clients\.size\s*<\s*MAX_CLIENTS/.test(sse),
    'لا فحص متاح قبل القبول');
  // الفحص قبل writeHead (وإلا بقي اتصال نصفي مفتوح بلا تسجيل)
  const route = stripJsComments(fnBody(authRoute, "router.get('/api/events/stream'"));
  assert.ok(/canAcceptClient/.test(authRoute) && /canAcceptClient:\s*sseCanAcceptClient/.test(authRoute),
    'المسار لا يستورد canAcceptClient من sse.js');
  const capAt = route.indexOf('sseCanAcceptClient');
  assert.ok(capAt > 0, 'المسار لا يفحص السقف');
  assert.ok(capAt < route.indexOf('writeHead'), 'فحص السقف يجب أن يسبق writeHead');
  assert.ok(/503/.test(route) && /Retry-After/.test(route), 'الرفض يجب أن يكون 503 مع Retry-After');
  // addSseClient قد يرجع null ⇒ يغلق الاتصال بدل تركه مفتوحاً بلا تسجيل
  assert.ok(/clientId\s*===\s*null[\s\S]{0,120}?res\.end\(\)/.test(route),
    'المسار لا يتعامل مع رفض addSseClient (اتصال نصف مفتوح يتسرّب)');
});

test('S19: كل كتابة SSE تراقب backpressure وتطرد المستهلك البطيء', () => {
  const w = fnBody(sse, 'function writeTo(');
  assert.ok(/c\.res\.write\(chunk\)/.test(w), 'writeTo لا يكتب عبر res.write');
  assert.ok(/writableEnded\s*\|\|\s*c\.res\.destroyed|res\.writableEnded\s*\|\|\s*res\.destroyed/.test(w),
    'writeTo لا يكشف الوصلات الميتة (تنظيف الذاكرة)');
  assert.ok(/slowHits/.test(w) && /destroy\(\)/.test(w), 'لا طرد للمستهلك البطيء (نمو ذاكرة بلا سقف)');
  // البث والنبضةboth يمران عبر writeTo (لا كتابة مباشرة متجاهلة للضغط)
  const b = fnBody(sse, 'function broadcastRecordChanged(');
  assert.ok(/writeTo\(/.test(b) && !/c\.res\.write\(/.test(b), 'البث يتجاوز writeTo');
  const ping = sse.slice(sse.indexOf('setInterval'));
  assert.ok(/writeTo\(/.test(ping) && !/c\.res\.write\(/.test(ping), 'نبضة الحياة تتجاوز writeTo');
});

test('S20: الطرد من القائمة يبقى متناسقاً مع قائمة الاتصال', () => {
  // writeTo يحذف من clients عند كل مخرج فاشل (.write رجّع false أو استثناء)، وإلا بقي
  // الاتصال في الخريطة بلا مستخدم ⇒ ذاكرة مسرّبة + كتابة إلى مقبس ميت للأبد.
  const w = fnBody(sse, 'function writeTo(');
  const deletes = (w.match(/clients\.delete\(id\)/g) || []).length;
  assert.ok(deletes >= 3, `المسارات الفاشلة يجب أن تحذف من القائمة (وجد ${deletes})`);
  assert.ok(/return false/.test(w), 'writeTo لا يبلّغ بالفشل للطلب');
  // addClient يرفض فوق السقف ولا يزيد الخريطة
  const add = fnBody(sse, 'function addClient(');
  assert.ok(/clients\.size\s*>=\s*MAX_CLIENTS[\s\S]{0,80}return null/.test(add),
    'addClient يجب أن يرفض فوق السقف ويرجع null');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ٩) كل فهرس أُعيد تعريفه في schema.sql له Migration تعيد بناءه صراحةً
//    (فخّ IF NOT EXISTS: لا يغيّر تعريف فهرس موجود بنفس الاسم)
// ═══════════════════════════════════════════════════════════════════════════════
test('S21: الفهارس المعاد تعريفها تُعاد بناؤها في Migration لا في schema.sql وحده', () => {
  // (أ) فهارس جديدة تماماً: CREATE وحده كافٍ (لا اسم سابق يُصدم).
  for (const idx of ['idx_clients_rows_name_id']) {
    assert.ok(migrations.includes(`CREATE INDEX IF NOT EXISTS ${idx}`),
      `${idx}: فهرس جديد بلا CREATE داخل migration`);
  }
  // (ب) فهارس أُعيد تعريفها تحت الاسم نفسه ⇒ تحتاج DROP ثم CREATE صراحةً، لأن
  //     CREATE INDEX IF NOT EXISTS لا يغيّر تعريف فهرس موجود (يبقى القديم على الإنتاج).
  for (const idx of ['idx_login_history_user_device', 'idx_login_history_user_ip', 'idx_app_backups_created_at']) {
    assert.ok(migrations.includes(`DROP INDEX IF EXISTS ${idx}`) && migrations.includes(`CREATE INDEX IF NOT EXISTS ${idx}`),
      `${idx}: تعريفه تغيّر، فيلزم DROP + CREATE داخل migration`);
  }
  // الحذف يجب أن يسبق الإنشاء في نفس الترحيل (وإلا أُعيد استخدام التعريف القديم)
  const at = migrations.indexOf('2026-01-07-app-backups-deterministic-order');
  assert.ok(at > 0, 'ترحيل إعادة بناء فهرس النسخ الاحتياطية غير موجود');
  const appIdx = stripJsComments(migrations.slice(at, at + 700));
  assert.ok(appIdx.indexOf('DROP INDEX') < appIdx.indexOf('CREATE INDEX'),
    'لازم DROP يسبق CREATE في ترحيل إعادة بناء الفهرس');
  // الحذف الفعلي لـ idx_clients_rows_search_trgm و idx_clients_rows_name
  for (const gone of ['idx_clients_rows_search_trgm', 'idx_clients_rows_name',
    'idx_login_history_username', 'idx_magic_link_tokens_username', 'idx_collection_records_collection']) {
    assert.ok(migrations.includes(`DROP INDEX IF EXISTS ${gone}`),
      `${gone}: لم يُحذف عبر migration (كان DDL تدميري داخل schema.sql)`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ١٠) الجلب الكامل مُرقَّم: لا طلب واحد بلا حدود يعيد جدولاً كاملاً
// ═══════════════════════════════════════════════════════════════════════════════
test('S22: الجلب الكامل في الواجهة يمرّ عبر حلقة ترقيم لا بطلب واحد بلا حدود', () => {
  const sync = read('../frontend/js/storage-sync.js');
  //Helper الحلقة نفسها موجودة وتستخدم page/pageSize
  assert.ok(/async function _fetchAllRecordsPaginated\(/.test(sync), 'حلقة الترقيم مفقودة');
  const helper = fnBody(sync, 'async function _fetchAllRecordsPaginated(');
  assert.ok(/pathForPage\(page\)/.test(helper), 'الحلقة لا تمرّر رقم الصفحة');
  assert.ok(/records\.length\s*<\s*_FULL_PAGE_SIZE/.test(helper),
    'الحلقة لا تتوقف عند صفحة أقصر من pageSize (قد لا تنتهي أبداً)');
  //المساران الكاملان (لا delta) لازم يستعملا الحلقة
  const gen = fnBody(sync, 'async function fetchAllRecordsGeneric(');
  assert.ok(/_fetchAllRecordsPaginated\(/.test(gen), 'fetchAllRecordsGeneric لا يرقّم');
  const cl = fnBody(sync, 'async function fetchAllClientRecords(');
  assert.ok(/_fetchAllRecordsPaginated\(/.test(cl), 'fetchAllClientRecords لا يرقّم');
  // ممنوع: GET كامل بلا page لمساري الجدولين (كان يُعيد السجلات كلها في استجابة واحدة).
  // نتحقق من كل استدعاء إلى مسار التصنيف: إمّا مُرقَّم (?page=) أو محدود بقائمة ids
  // أو مسار فرعي محدود (?version / /versions / /bulk-* / /:id).
  const collBase = '/api/records/${encodeURIComponent(collection)}';
  let at = sync.indexOf(collBase);
  let seen = 0;
  while (at >= 0) {
    seen++;
    const after = sync.slice(at + collBase.length, at + collBase.length + 10);
    assert.ok(after.startsWith('?page=') || after.startsWith('?ids=') || after.startsWith('/'),
      `GET بلا ترقيم إلى تصنيف (يرجع الجدول كاملاً): ...${collBase}${after}`);
    at = sync.indexOf(collBase, at + 1);
  }
  assert.ok(seen >= 5, `عدد استدعاءات مسار التصنيف أقل من المتوقع (${seen})`);
  assert.ok(!/serverFetch\('\/api\/client-records'\)/.test(sync),
    'ما زال هناك GET كامل بلا ترقيم إلى جدول العملاء');
  assert.ok(/\/api\/client-records\?page=\$\{p\}&pageSize=\$\{_FULL_PAGE_SIZE\}/.test(sync),
    'جلب العملاء الكامل لا يمرّ بصفحة مُرقَّمة');
  //Page يمرّر page + pageSize صراحةً
  assert.ok(/page=\$\{p\}&pageSize=\$\{_FULL_PAGE_SIZE\}/.test(sync),
    'الاستعلام المُرقَّم لا يرسل page/pageSize');
});

test('S23: ترتيب الترقيم على id الثابت لا على version المتغيّر', () => {
  const repo = read('repo/records.repo.js');
  const code = stripSqlComments(repo);
  // version يتغيّر مع كل تعديل ⇒ حدود الصفحات "تنزلق" فيتكرر/يسقط سجل بين الصفحات.
  assert.ok(!/ORDER BY version/i.test(code),
    'ما زال هناك ORDER BY version — يجب الترتيب على id (المفتاح الأساسي) الثابت');
  // كلا الدالتين ترقّمان بنفس الترتيب
  const cr = fnBody(code, 'async function clientRecords(');
  const bc = fnBody(code, 'async function recordsByCollection(');
  for (const [name, body] of [['clientRecords', cr], ['recordsByCollection', bc]]) {
    const m = body.match(/ORDER BY[^`]*?LIMIT/);
    assert.ok(m, `${name}: مسار الترقيم بلا ORDER BY + LIMIT`);
    assert.ok(/ORDER BY id ASC/.test(m[0]), `${name}: ترتيب الترقيم ليس id ASC`);
  }
});

test('S24: حدود body الخاصة بمسارات AI/البريد مركّبة قبل المحوّل العام', () => {
  const srv = read('server.js');
  const code = stripJsComments(srv);
  const generalAt = code.indexOf("express.json({ limit: '2mb' })");
  assert.ok(generalAt > 0, 'المحوّل العام 2mb غير موجود');
  // body-parser يتخطّى أي محوّل JSON تالٍ بعد وضع req._body، فالمسارات الخاصة لازم
  // تسبق العام وإلا صارت حدودها (40mb/15mb) غير قابلة للوصول وSارياً هو 2mb.
  for (const p of ["'/api/ai/read-invoices'", "'/api/email/invoice'", "'/api/email/report'"]) {
    const at = code.indexOf(p);
    assert.ok(at > 0, `محوّل مخصّص غير موجود للمسار ${p}`);
    assert.ok(at < generalAt, `محوّل ${p} مركّب بعد المحوّل العام 2mb فحدّه لا يعمل`);
  }
  // والحد المخصّص يجب أن يكون أكبر من العام (وإلا فلا فائدة منه)
  const aiAt = code.indexOf("'/api/ai/read-invoices'");
  const lim = code.slice(aiAt, aiAt + 80).match(/limit:\s*'(\d+)mb'/);
  assert.ok(lim && Number(lim[1]) > 2, 'حد مسار AI ليس أكبر من الحد العام 2mb');
});

test('S25: ميزانية بايت مجمّعة وسقف تزامن على مسار الذكاء الاصطناعي', () => {
  const ai = read('routes/ai.js');
  const body = fnBody(ai, "router.post('/api/ai/read-invoices'");
  // حدّ لكل ملف وحده لا يمنع 30×8mb داخل الذاكرة ⇒ لازم ميزانية مجمّعة
  assert.ok(/MAX_BATCH_BYTES/.test(body), 'لا توجد ميزانية بايت مجمّعة للطلب');
  assert.ok(/approxTotal\s*\+=\s*approxBytes/.test(body),
    'الحجم المجمّع لا يُحتسب لكل الملفات');
  // سقف تزامن: حدّ rate limit يعدّ بدايات الطلبات ولا يحدّ ما هو قيد التشغيل فعلياً
  assert.ok(/AI_MAX_CONCURRENCY/.test(body), 'لا يوجد سقف تزامن على مستوى الطلب');
});

test('S26: حد المرفق بالبايتات المفكوكة لا بعدد محارف base64', () => {
  const email = read('routes/email.js');
  const code = stripJsComments(email);
  // base64 يضخّم 4/3: طول المحارف × 0.75 = البايتات الفعلية
  assert.ok(/attachmentBase64\.length\s*\*\s*0\.75/.test(code),
    'حد المرفق لا يحوّل base64 إلى بايتات فعلية (مقدّر بـ4/3)');
  assert.ok(!/MAX_ATTACHMENT_BASE64_CHARS/.test(code),
    'ما زال هناك حد معبّر بعدد محارف base64 موصوف كأنه ميجابايت');
});

test('S27: استطلاع إخفاء نافذة أركان يتوقف بعد التهيئة', () => {
  const agent = read('../arkkan-agent.js');
  // كان setInterval كل ثانيتين بلا توقف = 1800 عملية PowerShell/ساعة طوال عمر الوكيل
  assert.ok(/function stopWindowsWindowHider\(/.test(agent), 'دالة الإيقاف غير موجودة');
  const init = fnBody(agent, 'async function initBrowser(');
  assert.ok(/stopWindowsWindowHider\(\)/.test(init),
    'initBrowser لا يوقف الاستطلاع بعد ضبط _ready');
  const stopAt = agent.indexOf('function stopWindowsWindowHider(');
  const setAt = agent.indexOf('_winHideTimer = setInterval(');
  assert.ok(stopAt > 0 && setAt > 0, 'المؤقّت غير موجود');
  // يجب أن يمرّ الإيقاف عبر clearInterval فعلاً
  assert.ok(/clearInterval\(_winHideTimer\)/.test(agent.slice(stopAt, stopAt + 200)),
    'stopWindowsWindowHider لا تمسح المؤقّت');
});
