// اختبار وحدة لمنطق الصلاحيات فى permissions.js — أهم جزء أمني فى السيرفر (هو الأساس
// الذي تُبنى عليه كل حماية GET/PUT /api/storage/:key و/api/records/:collection).
'use strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
process.env.LICENSE_SECRET = process.env.LICENSE_SECRET || 'test-license-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');
const { roleCanAccessView, restrictKeyToAdmin, RESTRICTED_STORAGE_KEYS } = require('../permissions.js');

// --- roleCanAccessView ---

test('admin يملك وصول لأي شاشة دائماً، حتى لو الكاش فارغ/غير مُحمَّل', () => {
  assert.equal(roleCanAccessView('admin', 'settings'), true);
  assert.equal(roleCanAccessView('admin', 'accounting'), true);
  assert.equal(roleCanAccessView('admin', 'اسم-شاشة-غير-موجود-أصلاً'), true);
});

test('دور غير معروف (لا يوجد فى الكاش) يُرفض من الشاشات المقيَّدة افتراضياً (خط دفاع أخير)', () => {
  // 'مجهول' مش موجود فى ROLE_PERMISSIONS_CACHE ولا حتى بمصفوفة فارغة، فيمر بمسار
  // "دور غير معروف" فى roleCanAccessView (راجع الكود: allow ليست Array فيرجع نفي RESTRICTED_STAFF_VIEWS)
  assert.equal(roleCanAccessView('مجهول', 'settings'), false);
  assert.equal(roleCanAccessView('مجهول', 'audit'), false);
  assert.equal(roleCanAccessView('مجهول', 'accounting'), false);
  assert.equal(roleCanAccessView('مجهول', 'budget'), false);
  // شاشات غير حساسة تُسمح احترازياً لدور غير معروف (سلوك خط الرجعة القديم قبل جدول role_permissions)
  assert.equal(roleCanAccessView('مجهول', 'dashboard'), true);
});

// --- restrictKeyToAdmin (middleware) ---
// دالة middleware صرفة (req, res, next) — نبنى req/res مزيَّفين بسيطين لاختبارها بمعزل عن Express فعلي.
function fakeReqRes(role, key) {
  const req = { user: { role }, params: { key } };
  let statusCode = null, jsonBody = null, nextCalled = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; return this; },
  };
  const next = () => { nextCalled = true; };
  restrictKeyToAdmin(req, res, next);
  return { statusCode, jsonBody, nextCalled };
}

test('مفتاح غير مقيَّد إطلاقاً (غير موجود فى RESTRICTED_STORAGE_KEYS) -> يمر next() لأي دور', () => {
  assert.equal(('someRandomUnrestrictedKey' in RESTRICTED_STORAGE_KEYS), false, 'شرط الاختبار: هذا المفتاح فعلاً غير مقيَّد');
  const r = fakeReqRes('reception', 'someRandomUnrestrictedKey');
  assert.equal(r.nextCalled, true);
  assert.equal(r.statusCode, null);
});

test('مفتاح "users" (مقصور على admin دائماً، view=null) -> reception يُرفض بـ403', () => {
  const r = fakeReqRes('reception', 'users');
  assert.equal(r.nextCalled, false);
  assert.equal(r.statusCode, 403);
});

test('مفتاح "users" -> admin يمر next() دائماً', () => {
  const r = fakeReqRes('admin', 'users');
  assert.equal(r.nextCalled, true);
});

test('مفتاح "clients" -> دور reception يُرفض بـ403 دائماً (خط رجعة قديم خطر — راجع تعليق الكود)', () => {
  const r = fakeReqRes('reception', 'clients');
  assert.equal(r.nextCalled, false);
  assert.equal(r.statusCode, 403);
});

test('مفتاح "clients" -> أدوار أخرى غير reception غير متأثرة بقيد reception الخاص (تمر عبر roleCanAccessView العادي، و"clients" أصلاً غير موجود فى RESTRICTED_STORAGE_KEYS فيمر next())', () => {
  const r = fakeReqRes('staff', 'clients');
  assert.equal(r.nextCalled, true);
});

test('مفتاح "journalDE" (مقيَّد بشاشة accounting) -> staff بدون صلاحية accounting يُرفض بـ403', () => {
  // الكاش الحقيقي (ROLE_PERMISSIONS_CACHE) فارغ فى بيئة الاختبار (لا اتصال DB)، فـstaff
  // يمر بمسار "دور غير معروف" احترازي فى roleCanAccessView، وaccounting ضمن RESTRICTED_STAFF_VIEWS
  // فيُرفض — وهو نفس السلوك الآمن الصحيح المطلوب (fail-closed لا fail-open) حتى لو الكاش لم يُحمَّل بعد.
  const r = fakeReqRes('staff', 'journalDE');
  assert.equal(r.nextCalled, false);
  assert.equal(r.statusCode, 403);
});

test('كل مفتاح فى RESTRICTED_STORAGE_KEYS قيمته إما null أو نص (اسم شاشة) — لا قيم فاسدة', () => {
  for (const [key, view] of Object.entries(RESTRICTED_STORAGE_KEYS)) {
    assert.ok(view === null || typeof view === 'string', `المفتاح ${key} له قيمة غير متوقعة: ${view}`);
  }
});
