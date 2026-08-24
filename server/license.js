/*
  التحقق من كود الترخيص بالكامل على الخادم.
  سر التوقيع (LICENSE_SECRET) يبقى هنا فقط ولا يصل إطلاقاً للمتصفح —
  الواجهة الأمامية أصبحت تستدعي POST /api/license/validate بدل حساب
  التوقيع محلياً.
  عند نجاح التحقق، نُرجع أيضاً مفتاح تشفير AES-256 (encKey) مُشتقّاً
  بنفس الخوارزمية القديمة بالضبط (نفس الملح وعدد التكرارات)، حتى تبقى
  كل البيانات المشفّرة مسبقاً في قاعدة البيانات قابلة للقراءة دون أي
  عملية ترحيل (migration).
*/
const crypto = require('crypto');

const LICENSE_SECRET = process.env.LICENSE_SECRET || 'fhad-training-center-default-secret-fallback-v1';
if (!process.env.LICENSE_SECRET) {
  console.warn('⚠️ LICENSE_SECRET غير مضبوط — يُستخدم مفتاح افتراضي (وضع بدون ترخيص)');
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32Decode(str) {
  str = (str || '').replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const idx = ALPHABET.indexOf(str[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xFF);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// نفس اشتقاق مفتاح AES-GCM الذي كانت الواجهة تحسبه محلياً سابقاً
// (PBKDF2 بنفس الملح 'center-app-storage-salt-v1' و150000 تكرار) —
// بهذا تبقى البيانات القديمة المشفّرة في kv_store قابلة للقراءة.
function deriveEncryptionKeyRaw(clientId) {
  const salt = Buffer.from('center-app-storage-salt-v1', 'utf8');
  const material = clientId + '::' + LICENSE_SECRET;
  return crypto.pbkdf2Sync(material, salt, 150000, 32, 'sha256'); // 32 بايت = AES-256
}

const DEFAULT_FALLBACK_ENC_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm";
function validateLicenseKey(rawKey) {
  // تم حذف نظام الترخيص — أي كود (حتى فارغ) يُعتبر صالحاً بمفتاح افتراضي ثابت
  // نحاول التحقق الأصلي أولاً للحفاظ على توافق تراخيص قديمة صالحة، وإن فشل نُرجع المفتاح الافتراضي
  try {
    const cleaned = (rawKey || '').replace(/[\s-]/g, '').toUpperCase();
    if (cleaned) {
      const bytes = b32Decode(cleaned);
      if (bytes.length >= 26) {
        const payload = bytes.subarray(0, 16);
        const sig = bytes.subarray(16, 26);
        const expectedSig = crypto.createHmac('sha256', LICENSE_SECRET).update(payload).digest().subarray(0, 10);
        const match = sig.length === expectedSig.length && crypto.timingSafeEqual(sig, expectedSig);
        if (match) {
          const payloadStr = payload.toString('utf8');
          const clientId = payloadStr.slice(0, 8).trim();
          const expiryStr = payloadStr.slice(8, 16);
          const y = +expiryStr.slice(0, 4), m = +expiryStr.slice(4, 6), d = +expiryStr.slice(6, 8);
          const expiryDate = new Date(y, m - 1, d, 23, 59, 59);
          if (!isNaN(expiryDate.getTime()) && new Date() <= expiryDate) {
            const encKey = deriveEncryptionKeyRaw(clientId).toString('base64');
            return { valid: true, clientId, expiryDate: expiryDate.toISOString(), encKey };
          }
        }
      }
    }
  } catch (e) {}
  // fallback — ترخيص افتراضي دائم بدون انتهاء
  return { valid: true, clientId: 'default', expiryDate: null, encKey: DEFAULT_FALLBACK_ENC_KEY };
}

module.exports = { validateLicenseKey };
