'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadFrontendFiles } = require('./frontend-env');

/* ============================================================================
   لوحة التحكم الجديدة (frontend/js/dashboard-v2.js): نختبر الدوال الحقيقية داخل sandbox —
   نطاقات الفترات والمقارنة، مفاتيح الاتجاه، أعمار الذمم، تجميع الأرقام، وإخفاء المحتوى المالي
   عن من لا يملك صلاحية الخزنة/المحاسبة.
   ============================================================================ */

function load(overrides){
  return loadFrontendFiles(['dashboard-v2.js'], {
    $: () => null, // في المتصفح تعرّفها core-utils.js — هنا لا عناصر DOM فعلية
    isApprovedClient: () => true,
    centerIncome: c => Number(c.coursePrice || 0) - Number(c.discount || 0),
    remaining: c => Number(c.rem || 0),
    daysSinceDate: d => Number(d),
    escapeHtml: s => String(s),
    ...overrides,
  });
}
const at = (y, m, d) => new Date(y, m - 1, d);

/* ---------------- d2Range ---------------- */
test('d2Range: اليوم/7 أيام/الشهر/السنة مع الفترة السابقة المقابلة', () => {
  const c = load();
  const now = at(2026, 10, 8);
  assert.deepStrictEqual({ ...c.d2Range('today', now) }, { from: '2026-10-08', to: '2026-10-08', pFrom: '2026-10-07', pTo: '2026-10-07' });
  assert.deepStrictEqual({ ...c.d2Range('week', now) }, { from: '2026-10-02', to: '2026-10-08', pFrom: '2026-09-25', pTo: '2026-10-01' });
  assert.deepStrictEqual({ ...c.d2Range('month', now) }, { from: '2026-10-01', to: '2026-10-08', pFrom: '2026-09-01', pTo: '2026-09-08' });
  assert.deepStrictEqual({ ...c.d2Range('year', now) }, { from: '2026-01-01', to: '2026-10-08', pFrom: '2025-01-01', pTo: '2025-10-08' });
});

test('d2Range: الشهر السابق الأقصر لا يتجاوز آخر يوم فيه (31 مارس ← 28 فبراير)', () => {
  const c = load();
  const r = c.d2Range('month', at(2026, 3, 31));
  assert.strictEqual(r.pTo, '2026-02-28');
  assert.strictEqual(r.pFrom, '2026-02-01');
});

test('d2Range: 29 فبراير في سنة كبيسة ← 28 فبراير في السنة السابقة', () => {
  const c = load();
  const r = c.d2Range('year', at(2024, 2, 29));
  assert.strictEqual(r.to, '2024-02-29');
  assert.strictEqual(r.pTo, '2023-02-28');
});

test('d2Range: بداية يناير — الفترة السابقة للشهر هي ديسمبر السنة الماضية', () => {
  const c = load();
  const r = c.d2Range('month', at(2026, 1, 5));
  assert.strictEqual(r.pFrom, '2025-12-01');
  assert.strictEqual(r.pTo, '2025-12-05');
});

/* ---------------- d2SparkKeys ---------------- */
test('d2SparkKeys: عدد المفاتيح وترتيبها (الأقدم أولاً وآخرها اليوم/الشهر الحالي)', () => {
  const c = load();
  const now = at(2026, 10, 8);
  const w = c.d2SparkKeys('week', now), m = c.d2SparkKeys('month', now), y = c.d2SparkKeys('year', now);
  assert.strictEqual(w.keys.length, 7);
  assert.strictEqual(m.keys.length, 30);
  assert.strictEqual(y.keys.length, 12);
  assert.strictEqual(w.keys[6], '2026-10-08');
  assert.strictEqual(m.keys[0], '2026-09-09');
  assert.strictEqual(y.keys[0], '2025-11');
  assert.strictEqual(y.keys[11], '2026-10');
  assert.strictEqual(y.keyOf('2026-10-08'), '2026-10');
});

/* ---------------- d2Compact ---------------- */
test('d2Compact: اختصار الأرقام في محاور الرسم', () => {
  const c = load();
  assert.strictEqual(c.d2Compact(950), '950');
  assert.strictEqual(c.d2Compact(15000), '15ألف');
  assert.strictEqual(c.d2Compact(2500000), '2.5م');
  assert.strictEqual(c.d2Compact(3000000), '3م');
});

/* ---------------- d2Receivables ---------------- */
test('d2Receivables: حدود الشرائح 30/60/90 واستبعاد الموقوف والملغي والمسدد', () => {
  const clients = [
    { id: 'a', date: 0,   rem: 100 },  // 0-30
    { id: 'b', date: 30,  rem: 50 },   // 0-30 (الحد)
    { id: 'c', date: 31,  rem: 200 },  // 31-60
    { id: 'd', date: 60,  rem: 10 },   // 31-60 (الحد)
    { id: 'e', date: 61,  rem: 300 },  // 61-90
    { id: 'f', date: 90,  rem: 5 },    // 61-90 (الحد)
    { id: 'g', date: 91,  rem: 1000 }, // +90
    { id: 'h', date: 5,   rem: 0 },    // مسدد
    { id: 'i', date: 5,   rem: 777, suspended: true },
    { id: 'j', date: 5,   rem: 888, cancelled: true },
  ];
  const c = load({ clients });
  const r = c.d2Receivables();
  assert.deepStrictEqual(Array.from(r.buckets, b => b.count), [2, 2, 2, 1]);
  assert.deepStrictEqual(Array.from(r.buckets, b => b.amount), [150, 210, 305, 1000]);
  assert.strictEqual(r.total, 1665);
  assert.strictEqual(r.count, 7);
});

test('d2Receivables: العميل المعلّق الاعتماد لا يدخل الذمم', () => {
  const clients = [{ id: 'p', date: 1, rem: 500 }, { id: 'q', date: 1, rem: 50 }];
  const c = load({ clients, isApprovedClient: x => x.id !== 'p' });
  const r = c.d2Receivables();
  assert.strictEqual(r.total, 50);
  assert.strictEqual(r.count, 1);
});

/* ---------------- d2Collect ---------------- */
test('d2Collect (اليوم): العد والدخل والمحصّل مقابل الأمس، مع استبعاد الملغي والمعلّق والمصروف', () => {
  const c0 = load();
  const t = new Date();
  const today = c0.d2Iso(t);
  const yest = c0.d2Iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1));
  const clients = [
    { id: '1', date: today, coursePrice: 500, discount: 50, courseType: 'Food safety' },
    { id: '2', date: today, coursePrice: 300, courseType: 'Food safety' },
    { id: '3', date: today, coursePrice: 400, courseType: 'barber' },
    { id: '4', date: today, coursePrice: 999, cancelled: true },
    { id: 'pend', date: today, coursePrice: 888 },
    { id: '5', date: yest, coursePrice: 200 },
  ];
  const vaultTx = [
    { type: 'in', date: today, amount: 100 },
    { type: 'in', date: today, amount: 40 },
    { type: 'out', date: today, amount: 70 },
    { type: 'in', date: yest, amount: 25 },
  ];
  const c = load({ clients, vaultTx, isApprovedClient: x => x.id !== 'pend' });
  c.localStorage.setItem('ftc2-dash2-period', 'today');
  const c2 = load({ clients, vaultTx, isApprovedClient: x => x.id !== 'pend', localStorage: c.localStorage });
  const D = c2.d2Collect();
  assert.strictEqual(D.reg.cur, 3);
  assert.strictEqual(D.reg.prev, 1);
  assert.strictEqual(D.income.cur, 450 + 300 + 400);
  assert.strictEqual(D.income.prev, 200);
  assert.strictEqual(D.collected.cur, 140);
  assert.strictEqual(D.collected.prev, 25);
  assert.deepStrictEqual({ ...D.typeMap['Food safety'] }, { count: 2, income: 750 });
  assert.deepStrictEqual({ ...D.typeMap['barber'] }, { count: 1, income: 400 });
  assert.strictEqual(D.reg.spark.length, 7);
  assert.strictEqual(D.reg.spark[6], 3); // آخر نقطة = اليوم
});

/* ---------------- d2Delta ---------------- */
test('d2Delta: اتجاه ونسبة التغيّر وحالة "جديد" عند غياب الفترة السابقة', () => {
  const c = load({ fmt: v => String(v) });
  assert.match(c.d2Delta(150, 100, 'أمس'), /up/);
  assert.match(c.d2Delta(150, 100, 'أمس'), /50%/);
  assert.match(c.d2Delta(50, 100, 'أمس'), /down/);
  assert.match(c.d2Delta(5, 0, 'أمس'), /جديد/);
  assert.match(c.d2Delta(0, 0, 'أمس'), /flat/);
});

/* ---------------- renderDashboardV2: صلاحيات + دخان ---------------- */
function makeEl(){
  return { innerHTML: '', textContent: '', style: {}, classList: { toggle(){}, add(){}, remove(){} }, addEventListener(){} };
}
function renderWith(canMoney){
  const els = {};
  const $ = sel => (els[sel] = els[sel] || makeEl());
  const sandbox = load({
    $,
    clients: [{ id: '1', date: '2026-01-01', coursePrice: 100, courseType: 'x', rem: 40 }],
    vaultTx: [{ type: 'in', date: '2026-01-01', amount: 10 }],
    settings: {},
    canAccessView: v => canMoney,
    balanceOf: () => 1000,
    balanceOfAsOf: () => 1000,
    todayISO: () => new Date().toISOString().slice(0, 10),
    getEffectiveSessions: () => [],
    groupClientsByCourseNumber: () => new Map(),
    lastNMonthKeys: n => Array.from({ length: n }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
    monthLabelAr: k => k,
    fmt: v => String(v),
  });
  sandbox.document.querySelectorAll = () => [];
  sandbox.renderDashboardV2();
  return els;
}

test('renderDashboardV2: صاحب صلاحية مالية يرى الدخل والتدفق وأعمار الذمم', () => {
  const els = renderWith(true);
  const k = els['#dash2-kpis'].innerHTML, g = els['#dash2-grid'].innerHTML;
  assert.ok(k.includes('صافي دخل الدورات'));
  assert.ok(k.includes('المحصّل فعلياً'));
  assert.ok(k.includes('السيولة المتاحة'));
  assert.ok(g.includes('التدفق النقدي'));
  assert.ok(g.includes('أعمار الذمم'));
  assert.ok(g.includes('الدورات القادمة'));
});

test('renderDashboardV2: بدون صلاحية مالية لا يظهر أي رقم مالي (دخل/محصّل/سيولة/ذمم/تدفق)', () => {
  const els = renderWith(false);
  const k = els['#dash2-kpis'].innerHTML, g = els['#dash2-grid'].innerHTML;
  assert.ok(k.includes('التسجيلات'));
  assert.ok(k.includes('الدورات القادمة'));
  for(const secret of ['صافي دخل الدورات', 'المحصّل فعلياً', 'السيولة المتاحة', 'المتبقي على العملاء']) assert.ok(!k.includes(secret), secret);
  for(const secret of ['التدفق النقدي', 'أعمار الذمم']) assert.ok(!g.includes(secret), secret);
});

test('renderDashboardV2: خطأ داخلي لا يرمي استثناء (يعرض رسالة بديلة)', () => {
  const els = {};
  const $ = sel => (els[sel] = els[sel] || makeEl());
  const c = load({ $, clients: null, canAccessView: () => true, settings: {} });
  c.document.querySelectorAll = () => [];
  const origError = console.error; console.error = () => {};
  try{ c.renderDashboardV2(); } finally { console.error = origError; }
  assert.ok(els['#dash2-grid'].innerHTML.includes('تعذّر رسم لوحة التحكم'));
});
