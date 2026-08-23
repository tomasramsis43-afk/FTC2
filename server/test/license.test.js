// اختبار وحدة (unit test) حقيقي لمنطق التحقق من كود الترخيص فى license.js.
// يستخدم node:test المدمج فى Node.js (لا يضيف أي تبعية جديدة للمشروع).
// تشغيل: من داخل مجلد server/  ->  node --test test/
'use strict';
process.env.LICENSE_SECRET = process.env.LICENSE_SECRET || 'test-license-secret-do-not-use-in-prod';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { validateLicenseKey } = require('../license.js');

// نفس أبجدية Base32 المستخدمة فى license.js (لازم نطابقها بالضبط لبناء أكواد اختبار صحيحة)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// يبني كود ترخيص صحيح التوقيع لعميل وتاريخ انتهاء مُعطى، بنفس منطق التوليد
// (payload 16 بايت: 8 بايت clientId + 8 بايت YYYYMMDD، ثم توقيع HMAC-SHA256 مقصوص لـ10 بايت)
function buildLicenseKey(clientId, expiry /* Date */, secret = process.env.LICENSE_SECRET) {
  const clientIdPadded = clientId.padEnd(8, ' ').slice(0, 8);
  const y = expiry.getFullYear();
  const m = String(expiry.getMonth() + 1).padStart(2, '0');
  const d = String(expiry.getDate()).padStart(2, '0');
  const expiryStr = `${y}${m}${d}`;
  const payload = Buffer.from(clientIdPadded + expiryStr, 'utf8'); // 8 + 8 = 16 بايت بالضبط
  const sig = crypto.createHmac('sha256', secret).update(payload).digest().subarray(0, 10);
  return b32Encode(Buffer.concat([payload, sig]));
}

test('كود ترخيص صحيح وغير منتهي -> valid:true مع نفس clientId', () => {
  const future = new Date();
  future.setFullYear(future.getFullYear() + 1);
  const key = buildLicenseKey('CLIENT01', future);
  const result = validateLicenseKey(key);
  assert.equal(result.valid, true);
  assert.equal(result.clientId, 'CLIENT01');
  assert.ok(result.encKey, 'لازم يرجع encKey عند النجاح');
  assert.ok(result.expiryDate, 'لازم يرجع expiryDate عند النجاح');
});

test('كود ترخيص منتهي الصلاحية -> valid:false و expired:true', () => {
  const past = new Date('2020-01-01');
  const key = buildLicenseKey('CLIENT01', past);
  const result = validateLicenseKey(key);
  assert.equal(result.valid, false);
  assert.equal(result.expired, true);
  assert.match(result.reason, /انتهت صلاحية/);
});

test('توقيع مزوَّر (سر خاطئ) -> يُرفض دائماً مهما كان التاريخ صحيحاً', () => {
  const future = new Date();
  future.setFullYear(future.getFullYear() + 1);
  const forgedKey = buildLicenseKey('CLIENT01', future, 'wrong-secret-attacker-guess');
  const result = validateLicenseKey(forgedKey);
  assert.equal(result.valid, false);
  assert.match(result.reason, /غير صحيح/);
});

test('تغيير حرف فى منتصف الكود (يؤثر فعلياً على بايتات البيانات) يُبطله', () => {
  const future = new Date();
  future.setFullYear(future.getFullYear() + 1);
  const key = buildLicenseKey('CLIENT01', future);
  // نغيّر حرفاً فى منتصف الكود تحديداً (وليس آخر حرف — فى Base32 لـ26 بايت/208-بت آخر حرف
  // يحمل فقط 3 bits حقيقية من أصل 5، والباقي padding زيرو لا يؤثر على البايتات المفكوكة؛
  // منتصف الكود دائماً يقع داخل بايتات بيانات فعلية "payload" أو "sig")
  const midIdx = Math.floor(key.length / 2);
  const midChar = key[midIdx];
  const altChar = ALPHABET[(ALPHABET.indexOf(midChar) + 1) % ALPHABET.length];
  const tampered = key.slice(0, midIdx) + altChar + key.slice(midIdx + 1);
  const result = validateLicenseKey(tampered);
  assert.equal(result.valid, false);
});

test('مدخل فارغ -> رسالة "أدخل كود الترخيص" بدون استثناء', () => {
  const result = validateLicenseKey('');
  assert.equal(result.valid, false);
  assert.match(result.reason, /أدخل كود الترخيص/);
});

test('مدخل null/undefined -> لا يرمي استثناء (يتعامل معه بأمان)', () => {
  assert.doesNotThrow(() => validateLicenseKey(null));
  assert.doesNotThrow(() => validateLicenseKey(undefined));
  assert.equal(validateLicenseKey(null).valid, false);
});

test('نص عشوائي قصير جداً -> "صيغة كود الترخيص غير صحيحة" بدون استثناء', () => {
  const result = validateLicenseKey('ABC123');
  assert.equal(result.valid, false);
});

test('حروف صغيرة وشرطات ومسافات فى الكود تُقبل (نفس المدخل بعد التطبيع)', () => {
  const future = new Date();
  future.setFullYear(future.getFullYear() + 1);
  const key = buildLicenseKey('CLIENT01', future);
  // نحط شرطات بين كل 4 حروف ونحوّل جزء منه لحروف صغيرة، زي ما مستخدم حقيقي ممكن يلصقه
  const withDashesLower = key.match(/.{1,4}/g).join('-').toLowerCase();
  const result = validateLicenseKey(withDashesLower);
  assert.equal(result.valid, true);
  assert.equal(result.clientId, 'CLIENT01');
});
