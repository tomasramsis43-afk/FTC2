// اختبار وحدة لأهم منطق المصادقة فى auth.js — توقيع/تدوير JWT، تجزئة كلمات المرور،
// TOTP، وأكواد النسخ الاحتياطي أحادية الاستخدام (كلها منطق أمني حرج وقابل للعزل الفعلي).
'use strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
process.env.LICENSE_SECRET = process.env.LICENSE_SECRET || 'test-license-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const {
  signToken, signEmergencyToken, hashPassword, verifyPassword,
  generateTotpSecret, totpOtpauthUrl, verifyTotpToken,
  generateBackupCodes, hashBackupCodes, consumeBackupCode,
} = require('../auth.js');

// --- signToken / signEmergencyToken ---

test('signToken: يضمّن sub/username/role/tv الصحيحة، ويُوقَّع بـJWT_SECRET القابل للتحقق', () => {
  const token = signToken({ id: 42, username: 'nasser', role: 'accountant', token_version: 3 });
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decoded.sub, 42);
  assert.equal(decoded.username, 'nasser');
  assert.equal(decoded.role, 'accountant');
  assert.equal(decoded.tv, 3);
});

test('signToken: مستخدم بلا role/token_version -> يقع افتراضياً على staff / tv=0', () => {
  const token = signToken({ id: 1, username: 'x' });
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decoded.role, 'staff');
  assert.equal(decoded.tv, 0);
});

test('signEmergencyToken: يضمّن emergency:true وrole=admin دائماً', () => {
  const token = signEmergencyToken('breakglass');
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decoded.emergency, true);
  assert.equal(decoded.role, 'admin');
  assert.equal(decoded.username, 'breakglass');
});

test('توكن موقَّع بسر مختلف تماماً -> jwt.verify يرفضه (JsonWebTokenError)', () => {
  const token = signToken({ id: 1, username: 'x', role: 'staff' });
  assert.throws(() => jwt.verify(token, 'wrong-secret'), /invalid signature/);
});

// --- hashPassword / verifyPassword ---

test('hashPassword ثم verifyPassword بنفس كلمة المرور -> true', async () => {
  const hash = await hashPassword('MySecureP@ss123');
  const ok = await verifyPassword('MySecureP@ss123', hash);
  assert.equal(ok, true);
});

test('verifyPassword بكلمة مرور خاطئة -> false (بلا استثناء)', async () => {
  const hash = await hashPassword('correct-password');
  const ok = await verifyPassword('wrong-password', hash);
  assert.equal(ok, false);
});

test('hashPassword لا يرجع النص الصريح أبداً فى الناتج (bcrypt hash فعلي)', async () => {
  const plain = 'plaintext-should-never-appear';
  const hash = await hashPassword(plain);
  assert.ok(hash.startsWith('$2'), 'لازم يكون bcrypt hash قياسي');
  assert.equal(hash.includes(plain), false);
});

// --- TOTP ---

test('verifyTotpToken: كود خاطئ (6 أصفار) على سر عشوائي -> false بدون استثناء', () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotpToken('000000', secret), false);
});

test('verifyTotpToken: مدخل فارغ/undefined -> false بدون استثناء', () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotpToken('', secret), false);
  assert.equal(verifyTotpToken(undefined, secret), false);
});

test('totpOtpauthUrl: يحتوي اسم المُصدر FTC2 واسم المستخدم فى الرابط', () => {
  const secret = generateTotpSecret();
  const url = totpOtpauthUrl(secret, 'ahmed');
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, /FTC2/);
  assert.match(url, /ahmed/);
});

// --- أكواد النسخ الاحتياطي (Backup codes) ---

test('generateBackupCodes: يرجع العدد المطلوب، كل كود 8 أرقام، ولا تكرار بينها', () => {
  const codes = generateBackupCodes(10);
  assert.equal(codes.length, 10);
  for (const c of codes) assert.match(c, /^\d{8}$/);
  assert.equal(new Set(codes).size, 10, 'لازم كل الأكواد فريدة (احتمال التصادم شبه معدوم مع 10 من أصل 90 مليون احتمال)');
});

test('consumeBackupCode: كود صحيح -> ok:true ويُحذف من القائمة المتبقية', async () => {
  const codes = generateBackupCodes(3);
  const hashed = await hashBackupCodes(codes);
  const stored = JSON.stringify(hashed);
  const result = await consumeBackupCode(stored, codes[1]);
  assert.equal(result.ok, true);
  const remaining = JSON.parse(result.remaining);
  assert.equal(remaining.length, 2, 'كود واحد استُهلك من أصل 3');
});

test('consumeBackupCode: أهم خاصية أمنية — نفس الكود مرفوض عند إعادة استخدامه (single-use حقيقي)', async () => {
  const codes = generateBackupCodes(3);
  const hashed = await hashBackupCodes(codes);
  const stored = JSON.stringify(hashed);
  const first = await consumeBackupCode(stored, codes[0]);
  assert.equal(first.ok, true);
  // المحاولة الثانية بنفس الكود على القائمة المتبقية بعد الاستهلاك الأول
  const second = await consumeBackupCode(first.remaining, codes[0]);
  assert.equal(second.ok, false, 'الكود اتحذف من القائمة بعد أول استخدام، فمينفعش يتكرر');
});

test('consumeBackupCode: كود غير موجود أصلاً -> ok:false والقائمة تبقى كما هي', async () => {
  const codes = generateBackupCodes(3);
  const hashed = await hashBackupCodes(codes);
  const stored = JSON.stringify(hashed);
  const result = await consumeBackupCode(stored, '99999999');
  assert.equal(result.ok, false);
  assert.equal(result.remaining, stored);
});

test('consumeBackupCode: JSON فاسد/فارغ فى storedJson -> يتعامل بأمان (ok:false بلا استثناء)', async () => {
  const result1 = await consumeBackupCode('not-valid-json{{{', '12345678');
  assert.equal(result1.ok, false);
  const result2 = await consumeBackupCode(null, '12345678');
  assert.equal(result2.ok, false);
  const result3 = await consumeBackupCode('[]', '12345678');
  assert.equal(result3.ok, false);
});
