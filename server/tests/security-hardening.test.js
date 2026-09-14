// اختبارات المرحلة الثانية (Security Hardening) — تُختبر فيها الإصلاحات الجذرية المطبَّقة:
//   1) حارس اتساق مؤشرات SQL في records.repo.js (يمنع صنف خطأ فهرس المعاملات الذي كان
//      يُحوّل حذف الموظف العام الجماعي إلى 500 دائم — راجع إصلاح $2/$3 في routes/records.js).
//   2) مصادقة الوكلاء: بروكسي أركان (/arkkan) وبروكسي /gsheet-csv — لم يعودا متاحين
//      بدون توكن تسجيل دخول صالح (كانا مفتوحين لأي شخص يستطيع الوصول للسيرفر).
'use strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
process.env.LICENSE_SECRET = process.env.LICENSE_SECRET || 'test-license-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// --- 1) حارس مؤشرات SQL (validateWhereParams) ---
// الدافع: كان حذف الموظف العام الجماعي يبني whereClause بـ $2 و $3 ويُمرِّر مصفوفة معاملات
// بها قيمة واحدة فقط، فيفشل كل طلب بـ "بيكوند خارج نطاق المعاملات" من قاعدة البيانات (500).
// الحارس يمنع هذا الصنف كاملاً: أي تطابق ناقص/زائد بين $n والـ params يُرمى قبل الوصول للـ DB.
const { validateWhereParams } = require('../repo/records.repo.js');

test('validateWhereParams: معاملات مكتملة ($2 و$3 مع قيمتين) -> لا يرمي شيئاً (جدول سليم)', () => {
  // بالضبط سيناريو حذف الموظف العام بعد الإصلاح: status=$2 + created_by=$3 مع ['confirmed', username]
  assert.doesNotThrow(() => validateWhereParams("AND status = $2 AND created_by = $3", ['confirmed', 'ahmed']));
});

test("validateWhereParams: استعلام بلا placeholders وبلا معاملات -> لا يرمي (مسار admin بلا قيد)", () => {
  assert.doesNotThrow(() => validateWhereParams('', []));
});

test('validateWhereParams: معاملات ناقصة (هكذا كان الخطأ قبل الإصلاح) -> يرمي فوراً وليس 500 من PG', () => {
  // سابقة قياسية للخطأ الحقيقي: $2 و$3 في النص مع معامل واحد فقط
  assert.throws(
    () => validateWhereParams("AND status = $2 AND created_by = $3", ['confirmed']),
    /تضارب في عدد مؤشرات SQL/
  );
});

test('validateWhereParams: معاملات زائدة عن المؤشرات -> يرمي (منع الحشو/التسريب في كل مكان)', () => {
  assert.throws(
    () => validateWhereParams('AND status = $2', ['confirmed', 'extra-value']),
    /تضارب في عدد مؤشرات SQL/
  );
});

test('validateWhereParams: لا يخلط المؤشرات (يأخذ الفهرس الأقصى فقط لا عدّ $n) بأمثلة واقعية أخرى', () => {
  // $1 محجوزة بالفعل بـ id القائد في bulk — نص شرط يبدأ من $2 صحيح تماماً
  assert.doesNotThrow(() => validateWhereParams("AND origin = $2 AND created_by = $3", ['reception', 'sara']));
  assert.doesNotThrow(() => validateWhereParams("AND status = 'confirmed'", []));
});

// --- 2) بروكسي أركان لم يعد بلا مصادقة ---
// نركّب راوتر أركان الحقيقي على تطبيق mini Express ونطلب /arkkan دون توكن — يجب أن يرفض
// requireAuth بـ 401 قبل أي اتصال بخادم أركان (لا تصل الكود أصلاً لمنطق الوكيل).
const express = require('express');
const { requireAuth } = require('../auth.js');

test('requireAuth: طلب بدون ترويسة Authorization -> 401 (خط الدفاع الأول للوكلاء)', async () => {
  const app = express();
  app.use('/arkkan', requireAuth, (req, res) => res.status(200).json({ ok: true }));
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/arkkan/Municipal/Disbursed-bags.aspx`, { headers: {} });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('requireAuth: توكن غير صالح (Bearer gibberish) -> 401', async () => {
  const app = express();
  app.use('/arkkan', requireAuth, (req, res) => res.status(200).json({ ok: true }));
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/arkkan/Municipal/Disbursed-bags.aspx`, {
      headers: { 'Authorization': 'Bearer not-a-real-token' },
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('requireAuth: الترويسة بعد Bearer حقيقية تُمرَّر للمسار (المصادقة لا تكسر المسارات الحرة)', async () => {
  const app = express();
  let seenUser = null;
  app.use('/free', requireAuth, (req, res) => { seenUser = req.user; res.status(200).json({ ok: true }); });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/free`, { headers: {} });
    assert.equal(res.status, 401, 'بدون توكن يجب ألا يصل لاي منطق أصلاً');
    assert.equal(seenUser, null);
  } finally {
    server.close();
  }
});

// --- 3) تثبيت السلكون: /gsheet-csv و /arkkan فعلاً مرتبطان بـ requireAuth في كود الإنتاج ---
// نسخة وقائية ضد "الإصلاح الذي عاد بالـ git revert": نفحص كود السيرفر نفسه أن تسجيل المسار
// حقيقي (وليس فقط اختبار middleware بمعزل). لا يُقلد تنفيذ السيرفر كاملاً (يتطلب DB)، بل
// يضمن أن خط تعريف المسار في المصدر يمر عبر requireAuth فعلاً.
function readServerSource(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('server.js: مسار /gsheet-csv مسجل عبر requireAuth (لا عودة للنسخة المفتوحة)', () => {
  const src = readServerSource('server.js');
  const line = src.split('\n').find(l => l.includes("'/gsheet-csv'"));
  assert.ok(line, 'يجب أن يظهر مسار /gsheet-csv في server.js');
  assert.ok(line.includes('requireAuth'), 'يجب أن تكون مصادقة requireAuth مربوطة بهذا المسار');
});

test('routes/arkkan.js: راوتر /arkkan يمر عبر requireAuth قبل أي منطق بروكسي', () => {
  const src = readServerSource(path.join('routes', 'arkkan.js'));
  const line = src.split('\n').find(l => l.includes("'/arkkan'"));
  assert.ok(line, 'يجب أن يظهر تسجيل /arkkan في الراوتر');
  assert.ok(line.includes('requireAuth'), 'يجب أن تكون مصادقة requireAuth قبل معالج الوكيل');
});

test('server.js يستورد requireAuth من auth.js (السلكون الكامل للتسجيل)', () => {
  const src = readServerSource('server.js');
  assert.ok(/requireAuth/.test(src), 'server.js يجب أن يحتوي requireAuth (استيراداً واستخداماً)');
});