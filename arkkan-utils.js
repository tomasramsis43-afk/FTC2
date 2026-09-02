/**
 * arkkan-utils.js — أدوات مشتركة لتكامل Arkkan
 * ══════════════════════════════════════════════════════════════
 * ├── Sequential Job Queue (لعمليات آمنة ضد Arkkan)
 * ├── Retry Logic with Exponential Backoff
 * ├── Frame Snapshot / Detection
 * ├── State Isolation Helpers
 * └── Date Normalization
 * ══════════════════════════════════════════════════════════════ */

const { log, ArkkanError, TimeoutError, isRetryableError, isProtectionError } = require('./arkkan-logger');
const cfg = require('./arkkan-config');

const wait = ms => new Promise(r => setTimeout(r, ms));

/* اختيار توقيت عشوائي بين MIN و MAX (لمنع نمط متكرر متوقع بين العملاء) */
function randomDelay(min, max) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  return Math.floor(lo + Math.random() * (hi - lo));
}

/* ══════════════════════════════════════════════
   Sequential Job Queue
   ══════════════════════════════════════════════ */
class SequentialQueue {
  constructor(concurrency = 1) {
    this._queue = [];
    this._running = 0;
    this._concurrency = concurrency;
    this._paused = false;
    this._currentJob = null;
  }

  /**
   * إضافة مهمة للطابور
   * @param {Object} job - { id, clientId, action, fn, priority }
   * @returns {Promise} - نتيجة المهمة
   */
  enqueue(job) {
    return new Promise((resolve, reject) => {
      this._queue.push({ ...job, resolve, reject, enqueuedAt: Date.now() });
      this._process();
    });
  }

  async _process() {
    while (this._running < this._concurrency && this._queue.length > 0 && !this._paused) {
      const job = this._queue.shift();
      this._running++;
      this._currentJob = job;
      try {
        const result = await job.fn();
        job.resolve(result);
      } catch (err) {
        job.reject(err);
      } finally {
        this._running--;
        this._currentJob = null;
      }
    }
  }

  pause() { this._paused = true; }
  resume() { this._paused = false; this._process(); }

  get pending() { return this._queue.length; }
  get active() { return this._running; }
  get current() { return this._currentJob; }
  get isIdle() { return this._running === 0 && this._queue.length === 0; }
}

/* ══════════════════════════════════════════════
   Job States
   ══════════════════════════════════════════════ */
const JOB_STATUS = {
  PENDING:           'pending',
  PROCESSING:        'processing',
  SUCCESS:           'success',
  NO_DATA:           'no_data',
  VALIDATION_FAILED: 'validation_failed',
  TIMEOUT:           'timeout',
  BLOCKED:           'blocked',
  ERROR:             'error',
  RETRY_PENDING:     'retry_pending',
};

/* ══════════════════════════════════════════════
   Retry with Exponential Backoff
   ══════════════════════════════════════════════ */
async function withRetry(fn, options = {}) {
  const {
    maxAttempts = cfg.RETRY.MAX_ATTEMPTS,
    initialBackoff = cfg.RETRY.INITIAL_BACKOFF_MS,
    maxBackoff = cfg.RETRY.MAX_BACKOFF_MS,
    multiplier = cfg.RETRY.BACKOFF_MULTIPLIER,
    label = 'operation',
    clientId = null,
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // لا نعيد المحاولة على أخطاء الحماية أبداً
      if (isProtectionError(err)) {
        log.protection(err.message, 'لا يمكن تجاوز الحماية — إيقاف فوري');
        throw err;
      }

      // لا نعيد المحاولة على أخطاء التحقق
      if (err.code === 'VALIDATION_FAILED') throw err;

      // محاولة أخيرة؟ لا ننتظر
      if (attempt >= maxAttempts) break;

      // خطأ مؤقت فقط؟ نعيد المحاولة مع انتظار متزايد
      if (!isRetryableError(err)) break;

      const backoff = Math.min(initialBackoff * Math.pow(multiplier, attempt - 1), maxBackoff);
      log.warn(`${label}: محاولة ${attempt}/${maxAttempts} فشلت (${err.message}) — إعادة بعد ${backoff}ms`);
      await wait(backoff);
    }
  }
  throw lastError;
}

/* ══════════════════════════════════════════════
   Frame Snapshot / Detection
   ══════════════════════════════════════════════ */

/**
 * أخذ لقطة للإطارات الحالية قبل بدء عملية ما
 */
function snapshotFrames(page, urlPattern) {
  return page.frames().filter(f => {
    const u = f.url();
    return urlPattern instanceof RegExp ? urlPattern.test(u) : u.includes(urlPattern);
  });
}

/**
 * اكتشاف إطار جديد بعد عملية ما
 * يتجنب القراءة من إطار قديم عن طريق الخطأ
 */
function findNewFrame(page, urlPattern, beforeFrames, timeoutMs = cfg.DELAY.DOCUMENT_OPEN, pollMs = cfg.DELAY.FRAME_WAIT) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      const current = page.frames().filter(f => {
        const u = f.url();
        return urlPattern instanceof RegExp ? urlPattern.test(u) : u.includes(urlPattern);
      });
      const newFrame = current.find(f => !beforeFrames.includes(f));
      if (newFrame || Date.now() - t0 >= timeoutMs) {
        resolve(newFrame || null);
        return;
      }
      setTimeout(check, pollMs);
    };
    check();
  });
}

/**
 * انتظار اختبار Stable — يقرأ DOM بشكل متكرر حتى تستقر البيانات
 * مع Timeout واضح
 */
function waitForStable({ readFn, hasDataFn, stableCount = cfg.POLL.STABLE_COUNT, timeoutMs = cfg.DELAY.RESULT_TIMEOUT, pollMs = cfg.POLL.INTERVAL, label = '' }) {
  return new Promise((resolve) => {
    let last = null;
    let stable = 0;
    const t0 = Date.now();

    const tick = async () => {
      try {
        const current = await readFn();
        const hasData = hasDataFn ? hasDataFn(current) : !!current;
        const same = last && hasData && JSON.stringify(current) === JSON.stringify(last);
        stable = same ? stable + 1 : 0;
        last = current;

        if ((stable >= stableCount && hasData) || Date.now() - t0 >= timeoutMs) {
          resolve(last);
          return;
        }
      } catch {
        // خطأ أثناء القراءة — ننتظر ونكرر
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/* ══════════════════════════════════════════════
   State Isolation
   ══════════════════════════════════════════════ */

/**
 * مسح جميع حقول الإدخال في إطار معين
 */
async function clearInputFields(frame, selectors) {
  for (const sel of selectors) {
    try {
      await frame.fill(sel, '');
    } catch {
      // حقل غير موجود — لا مشكلة
    }
  }
}

/**
 * مسح 상태 العميل السابق بالكامل قبل بدء عميل جديد
 */
async function isolateClientState(frame, page) {
  // مسح حقول البحث
  await clearInputFields(frame, [
    '#ctl00_Student_id_fltr_txtIdentityNo',
    '#ctl00_Student_id_fltr_Txt_ref',
  ]);

  // إغلاق أي نوافذ منبثقة
  await page.evaluate(() => {
    document.querySelectorAll('.toastyDialog_closeBtn').forEach(btn => {
      try { btn.click(); } catch {}
    });
  }).catch(() => {});

  // انتظار قصير للتأكد من أن الصفحة استقرت
  await wait(300);
}

/* ══════════════════════════════════════════════
   Date Normalization
   ══════════════════════════════════════════════ */

function normalizeDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return s;
}

function dateKey(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return m[1] + String(m[2]).padStart(2, '0') + String(m[3]).padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return m[3] + String(m[2]).padStart(2, '0') + String(m[1]).padStart(2, '0');
  return s;
}

/* ══════════════════════════════════════════════
   Validation Helpers
   ══════════════════════════════════════════════ */

function validateClientId(clientId) {
  const s = String(clientId || '').trim();
  if (!s) return { valid: false, reason: 'رقم الهوية مطلوب' };
  if (!/^\d{6,20}$/.test(s)) return { valid: false, reason: 'رقم الهوية يجب أن يكون أرقام فقط (6-20 رقم)' };
  return { valid: true, value: s };
}

function validateReferNum(referNum) {
  const s = String(referNum || '').trim();
  if (!s) return { valid: true, value: '' }; // اختياري
  if (!/^\d{1,20}$/.test(s)) return { valid: false, reason: 'الرقم المرجعي يجب أن يكون أرقام فقط' };
  return { valid: true, value: s };
}

/* ══════════════════════════════════════════════
   HTTP Body Size Limit
   ══════════════════════════════════════════════ */

function readJsonBody(req, maxSize = cfg.TIMEOUT.HTTP_BODY) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('حجم الطلب يتجاوز الحد المسموح'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('جسم الطلب غير صالح (غير JSON)')); }
    });
    req.on('error', reject);
  });
}

module.exports = {
  wait,
  randomDelay,
  SequentialQueue,
  JOB_STATUS,
  withRetry,
  snapshotFrames,
  findNewFrame,
  waitForStable,
  clearInputFields,
  isolateClientState,
  normalizeDate,
  dateKey,
  validateClientId,
  validateReferNum,
  readJsonBody,
};
