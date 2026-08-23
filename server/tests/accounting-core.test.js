'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontendFiles } = require('./frontend-env');

function freshCtx(){
  return loadFrontendFiles(['core-utils.js', 'accounting-core.js', 'module-accounting.js']);
}

// ============================================================================
// assertBalancedLines — الحارس الإلزامي قبل أي ترحيل تلقائي لقيد يومية. أهم دالة
// في كامل المنطق المحاسبي: أي خلل هنا يعني احتمال دخول قيد غير متوازن للدفاتر الرسمية.
// ============================================================================
test('assertBalancedLines: يقبل قيداً متوازناً تماماً (مدين = دائن)', () => {
  const ctx = freshCtx();
  const lines = [ { debit: 500, credit: 0 }, { debit: 0, credit: 500 } ];
  assert.equal(ctx.assertBalancedLines(lines), true);
});

test('assertBalancedLines: يرفض قيداً غير متوازن', () => {
  const ctx = freshCtx();
  const lines = [ { debit: 500, credit: 0 }, { debit: 0, credit: 499 } ];
  assert.equal(ctx.assertBalancedLines(lines), false);
});

test('assertBalancedLines: يقبل فروقاً دون هللة واحدة (تقريب فاصلة عائمة) فقط', () => {
  const ctx = freshCtx();
  // 0.1 + 0.2 معروف بمشاكل الفاصلة العائمة (0.30000000000000004) — يجب ألا يُرفض
  const lines = [ { debit: 0.1, credit: 0 }, { debit: 0.2, credit: 0 }, { debit: 0, credit: 0.3 } ];
  assert.equal(ctx.assertBalancedLines(lines), true);
});

test('assertBalancedLines: يرفض فرقاً حقيقياً ولو كان صغيراً (>= هللة)', () => {
  const ctx = freshCtx();
  const lines = [ { debit: 100, credit: 0 }, { debit: 0, credit: 99.98 } ];
  assert.equal(ctx.assertBalancedLines(lines), false);
});

test('assertBalancedLines: يرفض مصفوفة فارغة أو غير معرَّفة', () => {
  const ctx = freshCtx();
  assert.equal(ctx.assertBalancedLines([]), false);
  assert.equal(ctx.assertBalancedLines(null), false);
  assert.equal(ctx.assertBalancedLines(undefined), false);
});

test('assertBalancedLines: يتعامل مع قيم debit/credit غير رقمية كصفر (لا يرمي خطأ)', () => {
  const ctx = freshCtx();
  const lines = [ { debit: 'abc', credit: 0 }, { debit: 0, credit: 0 } ];
  assert.doesNotThrow(() => ctx.assertBalancedLines(lines));
});

// ============================================================================
// accountNormalBalance / accountTypeLabel — تصنيف الحسابات (أصول/مصروفات مدينة
// بالطبيعة، خصوم/إيرادات/حقوق ملكية دائنة بالطبيعة) — أساس حساب ميزان المراجعة.
// ============================================================================
test('accountNormalBalance: الأصول والمصروفات طبيعتها مدين', () => {
  const ctx = freshCtx();
  assert.equal(ctx.accountNormalBalance('asset'), 'debit');
  assert.equal(ctx.accountNormalBalance('expense'), 'debit');
});

test('accountNormalBalance: الخصوم والإيرادات وحقوق الملكية طبيعتها دائن', () => {
  const ctx = freshCtx();
  assert.equal(ctx.accountNormalBalance('liability'), 'credit');
  assert.equal(ctx.accountNormalBalance('revenue'), 'credit');
  assert.equal(ctx.accountNormalBalance('equity'), 'credit');
});

// ============================================================================
// roundMoney / vatFromGross / netFromGross — التقريب المالي المركزي وحساب الضريبة
// من مبلغ شامل الضريبة (15% مضمَّنة في المبلغ المخزَّن، وليست مضافة فوقه).
// ============================================================================
test('roundMoney: يقرّب لأقرب هللة ويُزيل تسرّب الفاصلة العائمة', () => {
  const ctx = freshCtx();
  assert.equal(ctx.roundMoney(45.699999999999996), 45.7);
  assert.equal(ctx.roundMoney(10), 10);
});

test('vatFromGross + netFromGross: مجموعهما دائماً يساوي المبلغ الإجمالي شامل الضريبة', () => {
  const ctx = freshCtx();
  const gross = 1150; // 1000 صافي + 150 ضريبة 15%
  const vat = ctx.vatFromGross(gross);
  const net = ctx.netFromGross(gross);
  assert.equal(vat, 150);
  assert.equal(net, 1000);
  assert.equal(Math.round((vat + net) * 100) / 100, gross);
});

test('vatFromGross: صفر يرجع صفر (لا قسمة على صفر ولا NaN)', () => {
  const ctx = freshCtx();
  assert.equal(ctx.vatFromGross(0), 0);
});

// ============================================================================
// allocVaultSeq — الترقيم التسلسلي الرسمي للحركات المالية لكل وجهة (خزنة/بنك/شبكة/
// أخرى) على حدة. لا يجوز أبداً تكرار رقم مستخدم فعلاً — حتى بعد اختلال العداد
// (استعادة نسخة احتياطية قديمة، تحميل جزئي...). هذا الاختبار يحاكي بالضبط ذلك
// السيناريو الحرج الموثّق في تعليق الدالة نفسها.
// ============================================================================
test('allocVaultSeq: يبدأ من 1 لكل وجهة جديدة ويتصاعد تسلسلياً', () => {
  const ctx = freshCtx();
  ctx.settings = { nextVaultSeqByDest: { vault: 1, bank: 1, network: 1, other: 1 } };
  ctx.vaultTx = []; ctx.deletedVaultTx = [];
  assert.equal(ctx.allocVaultSeq('vault'), 1);
  assert.equal(ctx.allocVaultSeq('vault'), 2);
  assert.equal(ctx.allocVaultSeq('vault'), 3);
});

test('allocVaultSeq: كل وجهة (destination) لها ترقيم مستقل تماماً عن الأخرى', () => {
  const ctx = freshCtx();
  ctx.settings = { nextVaultSeqByDest: { vault: 1, bank: 1, network: 1, other: 1 } };
  ctx.vaultTx = []; ctx.deletedVaultTx = [];
  assert.equal(ctx.allocVaultSeq('vault'), 1);
  assert.equal(ctx.allocVaultSeq('bank'), 1); // لا يتأثر برقم الخزنة إطلاقاً
  assert.equal(ctx.allocVaultSeq('vault'), 2);
  assert.equal(ctx.allocVaultSeq('bank'), 2);
});

test('allocVaultSeq: لا يعيد أبداً رقماً مستخدماً فعلاً حتى لو العداد المحلي متأخر (سيناريو استعادة نسخة قديمة)', () => {
  const ctx = freshCtx();
  // العداد يقول "التالي = 1" لكن فعلياً يوجد حركات مسجَّلة بالفعل بالأرقام 1 و2 و3 —
  // بالضبط السيناريو الموثّق في تعليق الدالة (استعادة نسخة احتياطية قديمة صفّرت العداد).
  ctx.settings = { nextVaultSeqByDest: { vault: 1, bank: 1, network: 1, other: 1 } };
  ctx.vaultTx = [
    { destination: 'vault', seq: 1 },
    { destination: 'vault', seq: 2 },
    { destination: 'vault', seq: 3 },
  ];
  ctx.deletedVaultTx = [];
  const next = ctx.allocVaultSeq('vault');
  assert.equal(next, 4, 'يجب أن يتخطى كل الأرقام المستخدمة فعلاً ويبدأ من أول رقم حرّ');
});

test('allocVaultSeq: يحترم أيضاً الأرقام المستخدمة في الحركات المحذوفة منطقياً (deletedVaultTx) — الرقم الرسمي لا يُعاد استخدامه أبداً', () => {
  const ctx = freshCtx();
  ctx.settings = { nextVaultSeqByDest: { vault: 1, bank: 1, network: 1, other: 1 } };
  ctx.vaultTx = [ { destination: 'vault', seq: 1 } ];
  ctx.deletedVaultTx = [ { destination: 'vault', seq: 2 } ]; // حركة اتحذفت لكن رقمها لازم يفضل محجوز
  const next = ctx.allocVaultSeq('vault');
  assert.equal(next, 3);
});

test('allocVaultSeq: وجهة غير معروفة (destination خاطئة) تُعامَل كـ "vault" افتراضياً', () => {
  const ctx = freshCtx();
  ctx.settings = { nextVaultSeqByDest: { vault: 1, bank: 1, network: 1, other: 1 } };
  ctx.vaultTx = []; ctx.deletedVaultTx = [];
  const seq = ctx.allocVaultSeq('not-a-real-destination');
  assert.equal(seq, 1);
  assert.equal(ctx.settings.nextVaultSeqByDest.vault, 2, 'كان لازم يستهلك عداد vault تحديداً');
});
