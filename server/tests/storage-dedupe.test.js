// اختبار حارس "حفظ واحد قيد التنفيذ" (in-flight dedupe) في storage-sync.js — يمنع أنه لو
// ضغط المستخدم زر الحفظ مرتين متتاليتين لنفس السجل، يُرسل طلبا PUT متوازيان بنفس رقم
// النسخة (فينتج الثاني تعارض 409 كاذب، وإن بدا للمستخدم وكأن تحريره لم يُحفظ). الفرضية:
// الضغطتان تذهبان داخل استدعاءين متزامنين لـ saveOneClientRecord؛ الأول يبدأ الطلب فعلياً
// كـ PUT في الطرفية، والثاني يجب أن ينتظر نهاية الأول ويعيد نتيجته بدل إرسال طلب جديد.
'use strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
process.env.LICENSE_SECRET = process.env.LICENSE_SECRET || 'test-license-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontendFiles } = require('./frontend-env.js');

// يحمّل الملفات الفعلية وينصّب الأدوات الخادعة الدنيا اللازمة لمسار الحفظ (serverFetch مطبّقاً
// على Promise متأخر، و IndexedDB خادع يعيد null أي "غير متاح" فلا يُدخل التشفير/الطابور).
function setup() {
  const c = loadFrontendFiles(['core-utils.js', 'storage-sync.js']);
  c.serverFetch = async () => ({ status: 200, ok: true, json: async () => ({ version: 5, origin: 'client', status: 'confirmed' }) });
  c._openKvIdb = async () => null;
  c.encryptValue = async (j) => 'ENC:' + j;
  c._clientsSyncBaseline = new Map();
  c._collectionSyncBaseline = {};
  c._pendingRecordAwaitResolved = () => {};
  c._refreshPendingQueueSyncCount = () => {};
  return c;
}

test('saveOneClientRecord: ضغطتان سريعتان لنفس العميل -> PUT واحد فقط والنتيجة واحدة (dedupe)', async () => {
  const c = setup();
  let putCount = 0;
  c.serverFetch = async () => { putCount++; await new Promise(r => setTimeout(r, 5)); return { status: 200, ok: true, json: async () => ({ version: 5, origin: 'client', status: 'confirmed' }) }; };
  const client = { id: 'c1', name: 'اختبار' };
  const [a, b] = await Promise.all([
    c.saveOneClientRecord(client, '{"a":1}'),
    c.saveOneClientRecord(client, '{"a":1}'),
  ]);
  assert.equal(putCount, 1, 'لازم يُرسل طلب PUT واحد فقط رغم ضغطتين');
  assert.equal(a, true);
  assert.equal(b, true, 'الثانية يجب أن ترث نتيجة الأولى (نجاح) بدل 409 كاذب');
});

test('saveOneClientRecord: حفظان متعاقبان (بعد انتهاء الأول) -> PUT لكل منهما (لا dedupe خاطئ)', async () => {
  const c = setup();
  let putCount = 0;
  c.serverFetch = async () => { putCount++; await new Promise(r => setTimeout(r, 5)); return { status: 200, ok: true, json: async () => ({ version: putCount, origin: 'client', status: 'confirmed' }) }; };
  const client = { id: 'c2', name: 'تعديلان' };
  // الأول ينتظر اكتماله، ثم الثاني يُرسل من جديد لأن الخريطة تُفرّغ بعد النهاية
  const a = await c.saveOneClientRecord(client, '{"v":1}');
  const b = await c.saveOneClientRecord(client, '{"v":2}');
  assert.equal(putCount, 2, 'الطلبان متعاقبان فيجب أن يُرسل كل منهما');
  assert.equal(a, true);
  assert.equal(b, true);
});

test('saveOneRecordGeneric: ضغطتان مزدوجتان على سجل تصنيف -> PUT واحد فقط', async () => {
  const c = setup();
  let putCount = 0;
  c.serverFetch = async () => { putCount++; await new Promise(r => setTimeout(r, 5)); return { status: 200, ok: true, json: async () => ({ version: 9, origin: 'admin', status: 'confirmed' }) }; };
  const [a, b] = await Promise.all([
    c.saveOneRecordGeneric('journalDE', 'r1', '{"x":1}'),
    c.saveOneRecordGeneric('journalDE', 'r1', '{"x":1}'),
  ]);
  assert.equal(putCount, 1);
  assert.equal(a, true);
  assert.equal(b, true);
});

test('saveOneRecordGeneric: سجلان مختلفان في نفس اللحظة -> طلبان مستقلان (لا تداخل بين المفاتيح)', async () => {
  const c = setup();
  let putCount = 0;
  c.serverFetch = async () => { putCount++; await new Promise(r => setTimeout(r, 5)); return { status: 200, ok: true, json: async () => ({ version: 1 }) }; };
  const [a, b] = await Promise.all([
    c.saveOneRecordGeneric('journalDE', 'ra', '{"a":1}'),
    c.saveOneRecordGeneric('journalDE', 'rb', '{"b":2}'),
  ]);
  assert.equal(putCount, 2, 'سجلات مختلفة = طلبات مختلفة');
  assert.equal(a, true);
  assert.equal(b, true);
});

// ---- مسار قرار الـ 409 الجديد في saveOneRecordGeneric ----
// البيئات الداخلية (_collectionSyncBaseline/_recordVersions) معرّفة كـ const على مستوى الملف
// (global lexical) فلا يمكن زرعها من الخارچ — لكن _safeToApplyOnConflict دالة عامة بحيث يمكن
// تجاوزها لتثبيت قرار "آمن/غير آمن" والتحقق من الأسلاك (كم PUT يُرسل وماذا يُرجع المتصل).

test('saveOneRecordGeneric: 409 مع قرار "مطابق آمن" -> إعادة رفع واحدة ناجحة → true', async () => {
  const c = setup();
  c._safeToApplyOnConflict = async () => true; // قررنا أن محتوى الخادوم مطابق لأساسنا
  let putCount = 0;
  c.serverFetch = async () => {
    putCount++;
    if(putCount === 1) return { status: 409, ok: false, json: async () => ({ currentVersion: 6, currentEnc: 'ENC:{"x":1}' }) };
    return { status: 200, ok: true, json: async () => ({ version: 7, origin: 'admin', status: 'confirmed' }) };
  };
  const ok = await c.saveOneRecordGeneric('journalDE', 'r1', '{"x":1}');
  assert.equal(putCount, 2, 'PUT أول + إعادة رفع فور حدوث 409');
  assert.equal(ok, true, 'مطابق = تعارض نسخ محلي فقط → يجب أن يُحل ويُرجع نجاحاً');
});

test('saveOneRecordGeneric: 409 مع قرار "تعارض حقيقي" -> لا إعادة رفع → false', async () => {
  const c = setup();
  c._safeToApplyOnConflict = async () => false;
  let putCount = 0;
  c.serverFetch = async () => {
    putCount++;
    return { status: 409, ok: false, json: async () => ({ currentVersion: 6, currentEnc: 'ENC:{"x":2}' }) };
  };
  const ok = await c.saveOneRecordGeneric('journalDE', 'r1', '{"x":1}');
  assert.equal(putCount, 1, 'تعديل فعلي من جهاز آخر = لا يجوز إعادة رفع أو كتابة فوق');
  assert.equal(ok, false, 'تعارض حقيقي = نتيجة false');
});

test('saveOneRecordGeneric: إعادة الرفع تواجه 409 ثانٍ -> إسقاط السجل المضطرب + false', async () => {
  const c = setup();
  c._safeToApplyOnConflict = async () => true; // أول الحسابات يقول آمن، لكن الخادوم ما زال 409
  let putCount = 0;
  c.serverFetch = async () => {
    putCount++;
    return { status: 409, ok: false, json: async () => ({ currentVersion: putCount + 5, currentEnc: 'ENC:{"x":' + putCount + '}' }) };
  };
  const ok = await c.saveOneRecordGeneric('journalDE', 'r1', '{"x":1}');
  assert.equal(putCount, 2, 'محاولتان فقط: الأصلية ثم إعادة رفع واحدة')
  assert.equal(ok, false, '409 متكرر = تعارض حقيقي يجب ألا يُعاد رفعه للأبد');
});