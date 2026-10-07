'use strict';
// اختبارات «تعديلات لم تُحفظ»: أي تعديل يرفضه السيرفر أو يتعارض لا يُمسح بصمت، بل يُحفظ محلياً للمراجعة.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadFrontendFiles } = require('./frontend-env.js');

// IndexedDB وهمي مبسّط: open/onupgradeneeded + stores بسيطة (put/get/getAll/delete/clear) ومعاملات متزامنة.
function makeFakeIDB() {
  const stores = {};
  const makeStore = (name) => {
    const m = (stores[name] = stores[name] || new Map());
    return {
      put(v) { m.set(v.rkey || v.ckey || v.key, v); return {}; },
      get(k) { const r = {}; setTimeout(() => { r.result = m.get(k); r.onsuccess && r.onsuccess(); }, 0); return r; },
      getAll() { const r = {}; setTimeout(() => { r.result = [...m.values()]; r.onsuccess && r.onsuccess(); }, 0); return r; },
      delete(k) { m.delete(k); return {}; },
      clear() { m.clear(); return {}; },
    };
  };
  const db = {
    objectStoreNames: { contains: (n) => n in stores },
    createObjectStore(n) { stores[n] = stores[n] || new Map(); return makeStore(n); },
    transaction(name) {
      if (!(name in stores)) throw new Error('NotFoundError: ' + name);
      const tx = { objectStore: () => makeStore(name) };
      setTimeout(() => tx.oncomplete && tx.oncomplete(), 5);
      return tx;
    },
    close() {},
  };
  return {
    stores, db,
    open() {
      const req = { result: db };
      setTimeout(() => { req.onupgradeneeded && req.onupgradeneeded(); setTimeout(() => req.onsuccess && req.onsuccess(), 0); }, 0);
      return req;
    },
  };
}

function load(toasts = []) {
  const idb = makeFakeIDB();
  const c = loadFrontendFiles(['core-utils.js'], { indexedDB: idb, showToast: (m) => toasts.push(m) });
  return { c, idb, toasts };
}

test('archive → list → delete: التعديل المرفوض يُحفظ ويُرى ويُحذف بقرار المستخدم', async () => {
  const { c, toasts } = load();
  assert.equal(await c._rejectedEditArchive('vaultTx', 'tx1', { op: 'upsert', enc: 'ENC2:abc', ckey: 'x', queuedAt: 1 }, 'conflict'), true);
  assert.equal(await c._rejectedEditArchive('clients', 'c9', { op: 'upsert', enc: 'ENC2:def', clientId: '123', plain: '{"n":1}' }, 'rejected', { status: 403 }), true);
  const list = await c._rejectedEditList();
  assert.equal(list.length, 2);
  const byCol = Object.fromEntries(list.map((i) => [i.collection, i]));
  assert.equal(byCol.vaultTx.enc, 'ENC2:abc');
  assert.equal(byCol.vaultTx.reason, 'conflict');
  assert.equal(byCol.vaultTx.ckey, undefined, 'لا تتسرّب حقول الطابور الداخلية');
  assert.equal(byCol.clients.status, 403);
  assert.equal(byCol.clients.clientId, '123');
  assert.ok(toasts.some((t) => t.includes('تعديلات لم تُحفظ')), 'المستخدم يُبلَّغ بمكان النسخة');
  await c._rejectedEditDelete(byCol.vaultTx.rkey);
  assert.equal((await c._rejectedEditList()).length, 1);
});

test('الأرشفة لا ترمي أبداً حتى لو المخزن غير موجود (قاعدة قديمة)', async () => {
  const idb = makeFakeIDB();
  idb.open = function () { const req = { result: idb.db }; setTimeout(() => req.onsuccess && req.onsuccess(), 0); return req; }; // بدون onupgradeneeded
  const c = loadFrontendFiles(['core-utils.js'], { indexedDB: idb, showToast() {} });
  assert.equal(await c._rejectedEditArchive('vaultTx', 'a', { op: 'upsert', enc: 'x' }, 'conflict'), false);
});

test('_dropRecordOnRealConflict يحفظ نسخة التعديل قبل إسقاطه من الطابور (من الطابور أو من الحمولة)', async () => {
  const { c } = load();
  const calls = [];
  // محرّك المزامنة الحقيقي في نفس الـ context
  const code = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'storage-sync.js'), 'utf8');
  const m = code.match(/async function _dropRecordOnRealConflict[\s\S]*?\n}\n/);
  assert.ok(m, 'الدالة موجودة');
  const vm = require('vm');
  vm.runInContext(m[0].replace('async function _dropRecordOnRealConflict', 'globalThis._drop = async function'), c);
  c._clientRecordVersions = {}; c._recordVersions = {};
  // (1) من الطابور
  await c._pendingRecordPut('vaultTx', 't1', { op: 'upsert', enc: 'ENC2:queued' });
  await c._drop('vaultTx', false, 't1', { currentVersion: 5 });
  assert.equal((await c._pendingRecordGetOne('vaultTx', 't1')), null, 'اتشال من الطابور');
  // (2) من الحمولة المباشرة (حفظ مباشر لم يدخل الطابور)
  await c._drop('vaultTx', false, 't2', { currentVersion: 7 }, { op: 'upsert', enc: 'ENC2:direct' });
  const list = await c._rejectedEditList();
  assert.deepEqual(list.map((i) => i.enc).sort(), ['ENC2:direct', 'ENC2:queued']);
  void calls;
});

test('كل مواضع «تم تجاهل/تعارض» في storage-sync تحفظ نسخة قبل الإسقاط', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'storage-sync.js'), 'utf8');
  const lines = src.split('\n');
  const mustHave = (needle, window = 6) => {
    const idx = lines.findIndex((l) => l.includes(needle));
    assert.ok(idx > -1, 'غير موجود: ' + needle);
    const ctx = lines.slice(Math.max(0, idx - window), idx + 1).join('\n');
    assert.match(ctx, /_rejectedEditArchive|_dropRecordOnRealConflict\([^)]*\{ op/, 'لا أرشفة قبل: ' + needle);
  };
  mustHave('تم تجاهل هذا التعديل المعلّق');
  mustHave('رفض دائم من السيرفر (\' + retryRes.status');
  mustHave('رفض دائم من السيرفر (\' + res.status + \') — تم تجاهل هذا التعديل\'');
  mustHave("تعارض فى الحفظ: عدّل شخص آخر نفس البيانات");
  mustHave('تعارض فى حفظ بيانات العميل');
  // الدالة المركزية نفسها تؤرشف
  const drop = src.match(/async function _dropRecordOnRealConflict[\s\S]*?\n}\n/)[0];
  assert.match(drop, /_rejectedEditArchive/);
  // لا يُسمح بإعادة رفع تلقائي للمحفوظات (قد تكتب فوق بيانات أحدث)
  assert.doesNotMatch(src, /_rejectedEditList\(\)[\s\S]{0,200}serverFetch\(/);
});

test('IndexedDB بنسخة 5 وبه مخزن rejectedEdits', () => {
  const core = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'core-utils.js'), 'utf8');
  assert.match(core, /indexedDB\.open\(KV_IDB_NAME, 5\)/);
  assert.match(core, /createObjectStore\(REJECTED_EDITS_STORE, \{ keyPath: 'rkey' \}\)/);
});
