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

const LICENSE_SECRET = process.env.LICENSE_SECRET;
if (!LICENSE_SECRET) {
  console.error('❌ متغيّر البيئة LICENSE_SECRET غير موجود. راجع ملف .env.example');
  process.exit(1);
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

function validateLicenseKey(rawKey) {
  try {
    const cleaned = (rawKey || '').replace(/[\s-]/g, '').toUpperCase();
    if (!cleaned) return { valid: false, reason: 'أدخل كود الترخيص' };
    const bytes = b32Decode(cleaned);
    if (bytes.length < 26) return { valid: false, reason: 'صيغة كود الترخيص غير صحيحة' };
    const payload = bytes.subarray(0, 16);
    const sig = bytes.subarray(16, 26);
    const expectedSig = crypto.createHmac('sha256', LICENSE_SECRET).update(payload).digest().subarray(0, 10);
    // مقارنة بزمن ثابت (timingSafeEqual) بدل حلقة مقارنة عادية — تحسين إضافي
    // بسيط يمنع هجمات قياس التوقيت النظرية.
    const match = sig.length === expectedSig.length && crypto.timingSafeEqual(sig, expectedSig);
    if (!match) return { valid: false, reason: 'كود الترخيص غير صحيح' };
    const payloadStr = payload.toString('utf8');
    const clientId = payloadStr.slice(0, 8).trim();
    const expiryStr = payloadStr.slice(8, 16);
    const y = +expiryStr.slice(0, 4), m = +expiryStr.slice(4, 6), d = +expiryStr.slice(6, 8);
    const expiryDate = new Date(y, m - 1, d, 23, 59, 59);
    if (isNaN(expiryDate.getTime())) return { valid: false, reason: 'كود الترخيص غير صحيح' };
    if (new Date() > expiryDate) {
      const disp = String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y;
      return {
        valid: false, expired: true,
        reason: `انتهت صلاحية الترخيص بتاريخ ${disp}. يرجى تجديد الاشتراك.`,
        clientId,
      };
    }
    const encKey = deriveEncryptionKeyRaw(clientId).toString('base64');
    return { valid: true, clientId, expiryDate: expiryDate.toISOString(), encKey };
  } catch (e) {
    return { valid: false, reason: 'تعذر التحقق من كود الترخيص' };
  }
}

module.exports = { validateLicenseKey };
