'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadFrontendFiles } = require('./frontend-env');

/* ============================================================================
   فيريفاي أزرار ترقيم شيت العملاء (الأولى/السابقة/التالية/الأخيرة + حجم الصفحة)
   من خلال تحميل ملفات الواجهة الفعلية (core-utils + clients-pagination-filters +
   clients-print-modals) داخل sandbox مع DOM وظيفي (عناصر ثابتة لكل selector تحفظ
   معالجات الأحداث)، ثم محاكاة ضغطة مستخدم حقيقية على الأزرار:
     نقر «التالية» => tableCurrentPage +1 والجدول يعرض صفحة 2 فعلاً (صفوفها).
   المساران مغطيان: المسار السريع (استجابة سيرفر ناجحة) والمسار المحلي الكامل
   (تعذّر السيرفر = الخروج/الرجوع المحلي فوراً).
   ============================================================================ */

function makeEl(id){
  const el = {
    id, value: '', disabled: false, checked: false, multiple: false, tagName: 'SPAN',
    options: [], selectedOptions: [], dataset: {}, textContent: '',
    handlers: {}, innerHTML_: '',
    set innerHTML(v){ this.innerHTML_ = v; },
    get innerHTML(){ return this.innerHTML_; },
    style: {},
    classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
    addEventListener(type, fn){ (this.handlers[type] = this.handlers[type] || []).push(fn); },
    removeEventListener(type, fn){ if(this.handlers[type]) this.handlers[type] = this.handlers[type].filter(f=>f!==fn); },
    setAttribute(){}, getAttribute(){ return null; },
    appendChild(){}, cloneNode(){ return makeEl(id); },
    querySelector(){ return null; }, querySelectorAll(){ return []; }, closest(){ return null; },
  };
  return el;
}

function buildCtx(serverFetch){
  const registry = new Map();
  const elFor = sel => {
    let key = sel;
    if(key.startsWith('#') || key.startsWith('.')) key = key.slice(1);
    if(!registry.has(key)) registry.set(key, makeEl(key));
    return registry.get(key);
  };
  const documentStub = {
    querySelector(sel){ return elFor(sel); },
    querySelectorAll(){ return []; },
    getElementById(id){ return registry.has(id) ? registry.get(id) : null; },
    createElement(){ return makeEl(''); },
    addEventListener(){}, removeEventListener(){},
    body: { appendChild(){}, classList: { add(){}, remove(){}, contains(){ return false; } } },
    documentElement: { style: { setProperty(){} } },
    readyState: 'complete',
  };

  const clients = [];
  for(let i=0;i<250;i++){
    clients.push({
      id: 'c'+i, name: 'عميل '+i, phone: '0500000'+String(i).padStart(3,'0'),
      clientId: 'ID'+i, referNum: 'R'+i, invoice: i%2 ? 'INV'+i : '', courseType: 'سباحة',
      courseNumber: i%3 ? 'C'+i : '', nationality: 'سعودي', date: '2026-01-01',
      total: 0, paid: 0, remaining: 0, bagSource: 'own', bagStatus: 'purchased',
      createdBy: 'admin', createdAt: i, cancelled: false, suspended: false, absent: false,
    });
  }

  const overrides = {
    URL, URLSearchParams,
    document: documentStub,
    tableCurrentPage: 1, tableLastFilterSig: '', onSearchInput: ()=> {},
    clients,
    currentUserRole: 'admin', currentUser: 'admin',
    canSeeAllData: () => true, isOwnRecord: () => true,
    clientsSortState: { key: null, dir: -1 },
    showSuspendedOnly: false, showUnpurchasedBagsOnly: false,
    filteredClients: () => clients,
    selectedClientIds: new Set(), clientRecordMeta: {},
    paidTotal: () => 0, remaining: () => 0, total: () => 0,
    fmt: v => String(v), tr: s => s, formatDateDisplay: () => '2026-01-01',
    bagSourceLabel: () => '', bagBuyCheckboxHtml: () => '', bagCancelBtnHtml: () => '',
    paymentChannelsLabel: () => '', canDeleteClientRecord: () => false, canReceptionEditClient: () => false,
    serverFetch,
  };
  const ctx = loadFrontendFiles(
    ['core-utils.js', 'clients-pagination-filters.js', 'clients-print-modals.js'],
    overrides
  );
  ctx.__get = id => documentStub.getElementById(id);
  return ctx;
}

const settle = () => new Promise(r => setTimeout(r, 20));
async function click(ctx, id){
  for(const fn of (ctx.__get(id).handlers['click'] || [])) await fn();
  await settle();
}
async function change(ctx, id){
  for(const fn of (ctx.__get(id).handlers['change'] || [])) await fn();
  await settle();
}

function makeSlowServer(){
  // سيرفر يستجيب (يبدأ بالاستجابة ثم يسقط) — يجب ألا يُنتظر؛ العرض يعود للبيانات المحلية
  // فوراً بدل تعليق الأزرار بانتظار مهلة serverFetch الطويلة (لم يكن: 60 ثانية).
  // (المهلة الفعلية 4 ثوانٍ تُفرض داخل serverFetch الحقيقي بـ AbortController — تُفحص ساكنياً أدناه.)
  return async () => { await new Promise(r => setTimeout(r, 50)); throw new Error('server too slow'); };
}

test('تنقُّل شيت العملاء: نقر «التالية/السابقة/الأولى/الأخيرة» يعمل عبر المسار السريع (سيرفر سريع)', async () => {
  const requested = [];
  const server = async (path) => {
    requested.push(path.split('?')[1]);
    const p = new URLSearchParams(path.split('?')[1]);
    const page = Number(p.get('page')) || 1;
    const size = Number(p.get('pageSize')) || 100;
    const rows = ctx.clients.slice((page-1)*size, page*size);
    return { ok: true, json: async () => ({ rows, total: ctx.clients.length }) };
  };
  const ctx = buildCtx(server);
  const body = () => ctx.__get('table-body').innerHTML;
  const cur = () => ctx.__get('table-page-current').textContent;

  await ctx.renderTable();
  await settle();
  assert.equal(cur(), 'صفحة 1 / 3');
  assert.equal(!!body().includes('data-id="c0"'), true, 'الصفحة الأولى تبدأ بعميل 0');

  await click(ctx, 'table-page-next');
  assert.equal(ctx.tableCurrentPage, 2);
  assert.equal(cur(), 'صفحة 2 / 3');
  assert.equal(!!body().includes('data-id="c100"'), true, 'الصفحة الثانية تبدأ بصف c100');
  assert.equal(ctx.__get('table-page-prev').disabled, false, 'السابقة مفعّلة في صفحة 2');
  assert.equal(ctx.__get('table-page-next').disabled, false, 'التالية مفعّلة في صفحة 2');

  await click(ctx, 'table-page-next');
  assert.equal(ctx.tableCurrentPage, 3);

  await click(ctx, 'table-page-last');
  assert.equal(ctx.tableCurrentPage, 3, 'الأخيرة = آخر صفحة (3)');
  assert.equal(!!body().includes('data-id="c249"'), true, 'الصفحة الأخيرة تنتهي بـ c249');
  assert.equal(ctx.__get('table-page-next').disabled, true, 'التالية معطّلة في الصفحة الأخيرة');
  assert.equal(ctx.__get('table-page-last').disabled, true);

  await click(ctx, 'table-page-prev');
  assert.equal(ctx.tableCurrentPage, 2, 'السابقة تعيد إلى الصفحة 2');
  await click(ctx, 'table-page-first');
  assert.equal(ctx.tableCurrentPage, 1, 'الأولى تعيد إلى الصفحة 1');
  assert.equal(ctx.__get('table-page-prev').disabled, true, 'السابقة معطّلة في الصفحة الأولى');
  assert.equal(!!body().includes('data-id="c0"'), true);
});

test('تنقُّل شيت العملاء: نفس السلوك عبر المسار المحلي الكامل فوراً عندما يتعذّر السيرفر', async () => {
  const ctx = buildCtx(async () => { throw new Error('offline'); });
  await ctx.renderTable();
  await settle();
  assert.equal(ctx.__get('table-page-current').textContent, 'صفحة 1 / 3');

  await click(ctx, 'table-page-next');
  assert.equal(ctx.tableCurrentPage, 2);
  assert.equal(ctx.__get('table-page-current').textContent, 'صفحة 2 / 3');
  assert.equal(!!ctx.__get('table-body').innerHTML.includes('data-id="c100"'), true);
});

test('سيرفر بطيء: التنقُّل يكمل محلياً فوراً ولا يعلق الأزرار', async () => {
  const ctx = buildCtx(makeSlowServer());
  const started = Date.now();
  await ctx.renderTable();
  await settle();
  for(const fn of (ctx.__get('table-page-next').handlers['click'] || [])) fn(); // نقر (بدون انتظار)
  await new Promise(r => setTimeout(r, 150)); // مهلة السيرفر (50ms) + الطرف المحلي
  // يجب أن يعود العرض من البيانات المحلية (لا ينتظر مهلة 60 ثانية الافتراضية)
  assert.equal(ctx.tableCurrentPage, 2);
  assert.equal(ctx.__get('table-page-current').textContent, 'صفحة 2 / 3');
  assert.equal(!!ctx.__get('table-body').innerHTML.includes('data-id="c100"'), true);
  assert.ok(Date.now() - started < 1500, 'العرض يكتمل محلياً فوراً — لا ينتظر مهلة السيرفر الطويلة');
});

test('تغيير حجم الصفحة يعيد الترقيم إلى الصفحة 1 بنفس الحجم الجديد', async () => {
  const ctx = buildCtx(async () => { throw new Error('offline'); });
  await ctx.renderTable();
  await settle();
  await click(ctx, 'table-page-next'); // صعدنا للصفحة 2
  assert.equal(ctx.tableCurrentPage, 2);

  ctx.__get('table-page-size').value = '50';
  await change(ctx, 'table-page-size');
  assert.equal(ctx.tableCurrentPage, 1, 'تغيير الحجم يعيد إلى الصفحة الأولى');
  assert.equal(ctx.__get('table-page-current').textContent, 'صفحة 1 / 5', '250 عميلاً ÷ 50 = 5 صفحات');
  assert.equal(ctx.__get('table-page-info').textContent, 'عرض 1 - 50 من 250');
});

test('ساكن: المسار السريع يحدّد مهلة قصيرة للطلب (timeout: 2000) بدل مهلة serverFetch الافتراضية', async () => {
  // يمنع العودة إلى مهلة 60 ثانية التي كانت تؤدي لشعور «الأزرار معطلة» على اتصال بطيء
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'clients-pagination-filters.js'), 'utf8');
  const seg = src.slice(src.indexOf('async function renderTable'), src.indexOf('async function renderTable') + 5000);
  assert.match(seg, /serverFetch\(['"]\/api\/clients\?['"]\s*\+\s*params\.toString\(\s*\)\s*,\s*\{\s*timeout:\s*2000\s*\}/);
});