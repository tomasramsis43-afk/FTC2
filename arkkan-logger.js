/**
 * arkkan-logger.js — تسجيل آمن مع حماية البيانات الحساسة
 * ══════════════════════════════════════════════════════════════
 * يخفي أرقام الهوية完整的部分内容ographically
 * لا يسجل كلمات المرور أو التوكنات أبداً
 * ══════════════════════════════════════════════════════════════ */

const TAG = '[arkkan]';

/* إخفاء أرقام الهوية: 1234567890 → 123****890 */
function maskId(id) {
  const s = String(id || '').trim();
  if (s.length <= 4) return '****';
  if (s.length <= 8) return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
  return s.slice(0, 3) + '*'.repeat(s.length - 6) + s.slice(-3);
}

/* إخفاء أي نص طويل */
function mask(text, visibleChars = 3) {
  const s = String(text || '');
  if (s.length <= visibleChars * 2 + 2) return '*'.repeat(s.length);
  return s.slice(0, visibleChars) + '*'.repeat(Math.max(1, s.length - visibleChars * 2)) + s.slice(-visibleChars);
}

/* تنظيف رسالة الخطأ من أي معلومات حساسة */
function sanitizeError(msg) {
  return String(msg || '')
    .replace(/password['":\s]*['"][^'"]+['"]/gi, 'password: "***"')
    .replace(/token['":\s]*['"][^'"]+['"]/gi, 'token: "***"')
    .replace(/api[_-]?key['":\s]*['"][^'"]+['"]/gi, 'api_key: "***"')
    .replace(/secret['":\s]*['"][^'"]+['"]/gi, 'secret: "***"');
}

/* أنواع الأخطاء */
class ArkkanError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ArkkanError';
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

class ProtectionError extends ArkkanError {
  constructor(message, details = {}) {
    super(message, 'PROTECTION_TRIGGERED', details);
    this.name = 'ProtectionError';
    this.isBlocked = true;
  }
}

class ValidationError extends ArkkanError {
  constructor(message, details = {}) {
    super(message, 'VALIDATION_FAILED', details);
    this.name = 'ValidationError';
  }
}

class TimeoutError extends ArkkanError {
  constructor(message, details = {}) {
    super(message, 'TIMEOUT', details);
    this.name = 'TimeoutError';
  }
}

class FrameError extends ArkkanError {
  constructor(message, details = {}) {
    super(message, 'FRAME_ERROR', details);
    this.name = 'FrameError';
  }
}

class NoDataError extends ArkkanError {
  constructor(message = 'لا توجد بيانات', details = {}) {
    super(message, 'NO_DATA', details);
    this.name = 'NoDataError';
  }
}

/* فئة التحقق مما إذا كان الخطأ مؤقتاً (يسمح بإعادة المحاولة) */
function isRetryableError(err) {
  if (!err) return false;
  const code = err.code || '';
  const msg = String(err.message || '').toLowerCase();
  // أخطاء مؤقتة: timeout، شبكة، خادم
  if (code === 'TIMEOUT' || code === 'NETWORK_ERROR') return true;
  if (msg.includes('timeout') || msg.includes('network') || msg.includes('econnreset')) return true;
  if (msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  return false;
}

/* فئة ما إذا كان الخطأ ي(HTTP 403/429/CAPTCHA) */
function isProtectionError(err) {
  if (!err) return false;
  const code = err.code || '';
  const msg = String(err.message || '').toLowerCase();
  if (code === 'PROTECTION_TRIGGERED' || err.isBlocked) return true;
  if (msg.includes('403') || msg.includes('429') || msg.includes('captcha')) return true;
  if (msg.includes('access denied') || msg.includes('unusual security')) return true;
  return false;
}

/* Logger */
const log = {
  info: (...args) => console.log(TAG, ...args),
  warn: (...args) => console.warn(TAG, ...args),
  error: (...args) => console.error(TAG, ...args),

  /* تسجيل جلب بيانات عميل — يخفي الهوية */
  clientFetch: (clientId, referNum, action) => {
    console.log(TAG, `${action}: client=${maskId(clientId)}${referNum ? ' ref=' + mask(referNum) : ''}`);
  },

  /* تسجيل نتيجة العملية */
  clientResult: (clientId, action, result) => {
    console.log(TAG, `${action}: client=${maskId(clientId)} result=${result}`);
  },

  /* تسجيل خطأ عميل */
  clientError: (clientId, action, err) => {
    console.error(TAG, `${action}: client=${maskId(clientId)} error=${sanitizeError(err.message || err)}`);
  },

  /* تسجيل حالة الحماية */
  protection: (status, details) => {
    console.error(TAG, `⚠️ PROTECTION: HTTP ${status} — ${sanitizeError(details || 'تم اكتشاف حماية خارجية')}`);
  },

  /* تسجيلоперации مع بيانات حساسة */
  sensitive: (action, data) => {
    const masked = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (k === 'clientId') masked[k] = maskId(v);
      else if (k === 'referNum') masked[k] = mask(v);
      else if (/password|token|secret|key/i.test(k)) masked[k] = '***';
      else masked[k] = v;
    }
    console.log(TAG, action, JSON.stringify(masked));
  },
};

module.exports = {
  log,
  maskId,
  mask,
  sanitizeError,
  ArkkanError,
  ProtectionError,
  ValidationError,
  TimeoutError,
  FrameError,
  NoDataError,
  isRetryableError,
  isProtectionError,
};
