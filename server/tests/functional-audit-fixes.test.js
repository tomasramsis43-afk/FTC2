'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadFrontendFiles } = require('./frontend-env');

// ═══════════════════════════════════════════════════════════════════════════════
// اختبارات إصلاحات مراجعة الوظائف الكاملة — الجولة 4
// ═══════════════════════════════════════════════════════════════════════════════

// ─── حمولة مشتركة لملف module-finance.js ────────────────────────────────────
const financeStubs = {
  onSearchInput(){},
  debounce(fn){ return fn; },
  tr(k){ return k; },
  customConfirm(){ return Promise.resolve(false); },
  escapeHtml(s){ return s; },
  escHtml(s){ return s; },
  notifyAdminAlert(){},
  canSaveVaultTx(){ return true; },
  isDateLocked(){ return false; },
  vaultLockToast(){},
  saveVaultTx: async ()=>{},
  saveSettings: async ()=>{},
  pushVaultTxHistory(){},
  clients: [],
  el(){ return null; },
  confirm(){ return true; },
  getOwnBagIdx(){ return null; },
  _ftcIsOffline: false,
  sessionLockdownActive: false,
  openClientWorkspace(){},
  closeClientWorkspace(){},
  openReceptionEditScreen(){},
  getDestLabel(d){ return d; },
  bindGenericPagination(){},
  applyGenericPagination(p, rows){ return rows; },
  renderAuditLog(){},
  renderVoidedLog(){},
  refreshPendingApprovals: async ()=>{},
  renderSmartAlerts(){},
  renderCloseOverview(){},
  renderCloseEntities(){},
  renderDashboard(){},
  renderReceivables(){},
  renderApproversPending(){},
  canDeleteVaultTx(){ return true; },
  canEditVaultTx(){ return true; },
  document: {
    querySelector(){ return { addEventListener(){}, style:{}, classList:{ add(){}, remove(){}, contains(){return false;} }, dataset:{}, value:'', textContent:'', innerHTML:'', disabled:false, children:[], querySelector(){return null;}, querySelectorAll(){return [];} }; },
    querySelectorAll(){ return []; },
    getElementById(){ return null; },
    createElement(){ return { style:{}, classList:{ add(){}, remove(){} }, dataset:{}, setAttribute(){}, appendChild(){}, textContent:'' }; },
    addEventListener(){},
    removeEventListener(){},
    body: { style:{}, classList:{ add(){}, remove(){} } },
    documentElement: { style:{ setProperty(){} } },
    readyState: 'complete',
  },
};
function loadFinance(extraOverrides){
  return loadFrontendFiles(['core-utils.js','accounting-core.js','module-finance.js'], { ...financeStubs, ...extraOverrides });
}

// ═══════════════════════════════════════════════════════════════════════════════
// B1: removeClientLedgerEntries تُرحّل السجلات التلقائية إلى deletedVaultTx
// بدلاً من حذفها مباشرة — preserves أرقام تسلسلية ويبقي على سجل المراجعة.
// ═══════════════════════════════════════════════════════════════════════════════
test('B1: removeClientLedgerEntries يُرحّل السجلات التلقائية إلى deletedVaultTx بدلاً من حذفها', () => {
  const ctx = loadFinance();
  ctx.vaultTx = [
    { id:'auto-1', autoClientId:'client-A', seq:10, destination:'vault', amount:500, date:'2026-01-10' },
    { id:'auto-2', autoClientId:'client-A', seq:11, destination:'bank', amount:300, date:'2026-01-11' },
    { id:'normal-1', autoClientId:'client-B', seq:12, destination:'vault', amount:100, date:'2026-01-12' },
  ];
  ctx.deletedVaultTx = [];
  ctx.removeClientLedgerEntries('client-A');

  assert.equal(ctx.vaultTx.length, 1, ' vaultTx يجب أن يحتوي سجل واحد فقط (normal-1)');
  assert.equal(ctx.vaultTx[0].id, 'normal-1');
  assert.equal(ctx.deletedVaultTx.length, 2, ' deletedVaultTx يجب أن يحتوي السجلات المنقولة');
  assert.equal(ctx.deletedVaultTx[0].id, 'auto-1');
  assert.equal(ctx.deletedVaultTx[1].id, 'auto-2');
});

test('B1: السجلات المُرحّلة تحتفظ بأرقامها التسلسلية (seq) لمنع إعادة الاستخدام', () => {
  const ctx = loadFinance();
  ctx.vaultTx = [
    { id:'auto-1', autoClientId:'client-A', seq:10, destination:'vault', amount:500, date:'2026-01-10' },
  ];
  ctx.deletedVaultTx = [];
  ctx.removeClientLedgerEntries('client-A');

  assert.equal(ctx.deletedVaultTx[0].seq, 10, 'الرقم التسلسلي 10 محفوظ في deletedVaultTx');
  const usedSeqs = new Set();
  ctx.vaultTx.forEach(t => usedSeqs.add(t.seq));
  ctx.deletedVaultTx.forEach(t => usedSeqs.add(t.seq));
  assert.ok(usedSeqs.has(10), 'الرقم 10 لا يزال مستخدماً — allocVaultSeq لن يعيده');
});

test('B1: السجلات المُرحّلة تحمل deletedAt و deletedBy و deletedReason', () => {
  const ctx = loadFinance();
  ctx.vaultTx = [
    { id:'auto-1', autoClientId:'client-A', seq:1, destination:'vault', amount:100, date:'2026-01-01' },
  ];
  ctx.deletedVaultTx = [];
  ctx.removeClientLedgerEntries('client-A');

  const moved = ctx.deletedVaultTx[0];
  assert.ok(moved.deletedAt > 0, 'deletedAt يجب أن يكون timestamp صحيح');
  assert.equal(moved.deletedBy, 'tester', 'deletedBy يسجل المستخدم الحالي');
  assert.ok(moved.deletedReason.includes('حذف تلقائي مع حذف العميل client-A'), 'deletedReason يوضح السبب');
});

test('B1: removeClientLedgerEntries لا يُ beeّث تغييرات على سجلات عميل آخر', () => {
  const ctx = loadFinance();
  ctx.vaultTx = [
    { id:'auto-1', autoClientId:'client-A', seq:1, destination:'vault', amount:100, date:'2026-01-01' },
    { id:'auto-2', autoClientId:'client-B', seq:2, destination:'vault', amount:200, date:'2026-01-02' },
  ];
  ctx.deletedVaultTx = [];
  ctx.removeClientLedgerEntries('client-A');

  assert.equal(ctx.vaultTx.length, 1);
  assert.equal(ctx.vaultTx[0].id, 'auto-2', 'سجلات client-B تبقى في vaultTx');
  assert.equal(ctx.vaultTx[0].autoClientId, 'client-B');
});

test('B1: removeClientLedgerEntries لا يرمي خطأ إذا لم توجد سجلات تلقائية', () => {
  const ctx = loadFinance();
  ctx.vaultTx = [
    { id:'normal-1', autoClientId:'client-B', seq:1, destination:'vault', amount:100, date:'2026-01-01' },
  ];
  ctx.deletedVaultTx = [];
  assert.doesNotThrow(() => ctx.removeClientLedgerEntries('nonexistent'));
  assert.equal(ctx.vaultTx.length, 1, 'لا تتغير vaultTx');
  assert.equal(ctx.deletedVaultTx.length, 0, 'لا تُضاف شيء لـ deletedVaultTx');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B2: DELETE 409 conflict لا يُعامل كخطأ اتصال — لا يُبطل الـ baseline.
// اختبار ثابت على الكود المصدري (static guard).
// ═══════════════════════════════════════════════════════════════════════════════
const frontendDir = path.join(__dirname, '..', '..', 'frontend', 'js');

test('B2: storage-sync.js يميّز بين DELETE 409 (conflict) و فشل اتصال في الحلقة الفردية', () => {
  const src = fs.readFileSync(path.join(frontendDir, 'storage-sync.js'), 'utf8');
  // الحلقة الفردية للحذف: for(const id of removedIds){ const ok = await deleteOneRecordGeneric(...)
  // يجب أن يتحقق فقط ok === null للاتصال: else if(ok === null) anyNetworkFailure = true;
  // لا يجب أن يheimer 'else anyNetworkFailure = true;' بدون فلتر null.
  const deleteLoopMatch = src.match(/for\(const id of removedIds\)\{\s*const ok = await deleteOneRecordGeneric\([^)]+\);\s*if\(ok\)[^;]+;\s*(\S[\s\S]{0,80}?)\n\s*\}/);
  assert.ok(deleteLoopMatch, 'يوجد حلقة حذف فردية في saveRecordsGeneric');
  assert.ok(/else\s+if\(ok\s*===\s*null\)\s+anyNetworkFailure\s*=\s*true/.test(deleteLoopMatch[1]),
    'الحلقة الفردية تتحقق من ok === null فقط (لا تheimer 409 كخطأ اتصال)');
});

test('B2: permissions-sound.js يميّز بين DELETE 409 و فشل اتصال لسجلات العملاء', () => {
  const src = fs.readFileSync(path.join(frontendDir, 'permissions-sound.js'), 'utf8');
  const deleteClientMatch = src.match(/for\(const id of removedIds\)\{\s*const ok = await deleteOneClientRecord\([^)]+\);[\s\S]{0,200}?\n\s*\}/);
  assert.ok(deleteClientMatch, 'يوجد حلقة حذف فردية لسجلات العملاء');
  assert.ok(/else\s+if\(ok\s*===\s*null\)\s+anyNetworkFailure\s*=\s*true/.test(deleteClientMatch[0]),
    'حلقة حذف العملاء تتحقق من ok === null فقط');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B3: تعديل حركة مالية يجب أن يستدعي bumpVaultVersion() لإبطال الكاش المذكّر.
// اختبار سلوكي + ثابت على الكود المصدري.
// ═══════════════════════════════════════════════════════════════════════════════
test('B3: bumpVaultVersion يصفرّ ذاكرة التخزين المؤقت للرصيد', () => {
  const ctx = loadFinance({ vaultTxVersion: 0 });
  ctx.settings = { nextVaultSeqByDest: { vault:1, bank:1, network:1, network2:1, other:1 } };
  ctx.vaultTx = [
    { id:'tx-1', seq:1, destination:'vault', amount:100, date:'2026-01-01' },
  ];
  const before = ctx.vaultTxVersion;
  ctx.bumpVaultVersion();
  assert.ok(ctx.vaultTxVersion > before, 'vaultTxVersion يجب أن يزداد بعد bumpVaultVersion');
});

test('B3: مسار تعديل الحركة المالية يستدعي bumpVaultVersion في module-finance.js', () => {
  const src = fs.readFileSync(path.join(frontendDir, 'module-finance.js'), 'utf8');
  // فرع التعديل: if(editingVaultId){ ... vaultTx[idx] = {...}; ... bumpVaultVersion();
  // يجب أن يكون bumpVaultVersion() موجوداً داخل فرع if(editingVaultId) وليس فقط في فرع الإضافة
  const editBranch = src.match(/if\(editingVaultId\)\{[\s\S]{0,2000}?bumpVaultVersion\(\)[\s\S]{0,200}?showToast\('تم تحديث الحركة'\)/);
  assert.ok(editBranch, 'فرع التعديل في submit handler يستدعي bumpVaultVersion() قبل showToast("تم تحديث الحركة")');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B4: genericPageSize ترجع Infinity بدلاً من 1000 عند اختيار "عرض الكل"
// ═══════════════════════════════════════════════════════════════════════════════
function loadPaginationWithMockDoc(valueForSelector){
  return loadFrontendFiles(['core-utils.js','clients-pagination-filters.js'], {
    tr: (k) => k,
    document: {
      querySelector(sel){
        if(sel && valueForSelector && sel.includes('page-size')){
          return { value: valueForSelector, addEventListener(){}, style:{} };
        }
        return { addEventListener(){}, style:{}, classList:{ add(){}, remove(){}, contains(){return false;} }, dataset:{}, value:'', textContent:'', innerHTML:'', disabled:false, children:[] };
      },
      querySelectorAll(){ return []; },
      getElementById(){ return null; },
      createElement(){ return { style:{}, classList:{ add(){}, remove(){} }, dataset:{}, setAttribute(){}, appendChild(){}, textContent:'' }; },
      addEventListener(){},
      removeEventListener(){},
      body: { style:{}, classList:{ add(){}, remove(){} } },
      documentElement: { style:{ setProperty(){} } },
      readyState: 'complete',
    }
  });
}

test('B4: genericPageSize ترجع Infinity عند اختيار "عرض الكل" (all)', () => {
  const ctx = loadPaginationWithMockDoc('all');
  assert.equal(ctx.genericPageSize('bag'), Infinity, 'genericPageSize("bag") = Infinity عند all');
});

test('B4: genericPageSize ترجع العدد الصحيح عند اختيار حجم صفحة محدد', () => {
  const ctx = loadPaginationWithMockDoc('25');
  assert.equal(ctx.genericPageSize('bag'), 25);
});

test('B4: genericPageSize ترجع 50 كقيمة افتراضية عند عدم وجود عنصر', () => {
  const ctx = loadPaginationWithMockDoc(undefined);
  assert.equal(ctx.genericPageSize('bag'), 50);
});

test('B4: applyGenericPagination مع pageSize Infinity لا تقطع الصفحات (تعرض الكل)', () => {
  const ctx = loadPaginationWithMockDoc('all');
  const rows = Array.from({length:150}, (_, i) => ({ id: String(i) }));
  const state = { page:1, sig:'' };
  const result = ctx.applyGenericPagination('bag', rows, state, ['*']);
  assert.equal(result.length, 150, 'يجب أن يعرض كل الصفوف بدون قطع');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B5: Cursor pagination يستخدم اتجاه صحيح حسب الترتيب (ASC > / DESC <)
// اختبار ثابت على الكود المصدري للسيرفر.
// ═══════════════════════════════════════════════════════════════════════════════
test('B5: records.js cursor يستخدم gtOp حسب order ASC/DESC (لا يheimer > دائماً)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'routes', 'records.js'), 'utf8');
  const cursorBlock = src.match(/if\(cursor\)\{[\s\S]{0,500}?cursorSql\s*=/);
  assert.ok(cursorBlock, 'يوجد cursorSql assignment داخل if(cursor)');
  assert.ok(/const gtOp\s*=\s*order\s*===\s*'DESC'\s*\?\s*'<'\s*:\s*'>'/.test(cursorBlock[0]),
    'gtOp يحدد '<' لـ DESC و '>' لـ ASC');
  assert.ok(/\$\{gtOp\}/.test(cursorBlock[0]) || /\$\{gtOp\}/.test(src.substring(cursorBlock.index)),
    'cursorSql يستخدم ${gtOp} المتغير بدل > ثابت');
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEAT: رقم إصدار Service Worker ظاهر في البار العلوي (شريحة SW)
// ═══════════════════════════════════════════════════════════════════════════════
const appHtmlPath = path.join(__dirname, '..', '..', 'frontend', 'app.html');

test('FEAT: app.html يحتوي شريحة إصدار SW في البار العلوي (id="sw-version-chip")', () => {
  const html = fs.readFileSync(appHtmlPath, 'utf8');
  assert.ok(html.includes('id="sw-version-chip"'), 'عنصر sw-version-chip موجود في الشريط العلوي');
  // يجب أن تكون داخل هيدر البار العلوي (قبل بداية المحتوى app) وبجوار شريحة الفترة المالية
  const headerBlock = html.match(/<header class="top">[\s\S]*?<\/header>/);
  assert.ok(headerBlock && headerBlock[0].includes('sw-version-chip'),
    'شريحة SW داخل header.top');
});

test('FEAT: boot.js يستدعي updateSwVersionChip ويقرأ CACHE_VERSION من sw.js بجلب مكسَّر', () => {
  const src = fs.readFileSync(path.join(frontendDir, 'boot.js'), 'utf8');
  assert.ok(/function updateSwVersionChip\(\)/.test(src), 'دالة updateSwVersionChip معرَّفة في boot.js');
  assert.ok(/fetch\('\/sw\.js\?v='\s*\+\s*Date\.now\(\)/.test(src),
    'يجب جلب sw.js باستعلام فريد (Date.now) لتجاوز أي نسخة مخزّنة من SW');
  assert.ok(/CACHE_VERSION\\s\*=\\s\*'\(\[\^'\]\+\)'/.test(src),
    'regex يقرأ ثابت CACHE_VERSION من نص sw.js');
  assert.ok(/updateSwVersionChip\(\);/.test(src), 'يُستدعى فور تحميل boot.js');
});

test('FEAT: sw.js يحمل ثوابت CACHE_VERSION و RUNTIME_CACHE بأعداد صحيحة متوازية', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'sw.js'), 'utf8');
  const mCache = src.match(/CACHE_VERSION\s*=\s*'ftc-cache-v(\d+)'/);
  const mRuntime = src.match(/RUNTIME_CACHE\s*=\s*'ftc-runtime-v(\d+)'/);
  assert.ok(mCache, 'CACHE_VERSION معرفة بصيغة ftc-cache-vN');
  assert.ok(mRuntime, 'RUNTIME_CACHE معرفة بصيغة ftc-runtime-vN');
  assert.equal(Number(mRuntime[1]) + 1, Number(mCache[1]),
    'RUNTIME_CACHE يجب أن يكون أقل بواحد من CACHE_VERSION (v30/v29)');
});
