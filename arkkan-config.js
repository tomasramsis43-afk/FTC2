/**
 * arkkan-config.js — إعدادات مركزة لتكامل Arkkan
 * ══════════════════════════════════════════════════════════════
 * جميع الإعدادات في مكان واحد — لا تُعدّل أي قيمة هنا مباشرة.
 * استخدم متغيرات البيئة (Environment Variables) أو ملف .env
 * ══════════════════════════════════════════════════════════════ */

module.exports = {
  /* ── الشبكة ── */
  AGENT_PORT:        parseInt(process.env.ARKKAN_AGENT_PORT || '9955', 10),
  ARKKAN_URL:        process.env.ARKKAN_URL || 'https://arkkanapp2.net/Bases/MainPage.aspx?url=98A7B2',
  ARKKAN_DOCBASE:    process.env.ARKKAN_DOCBASE || 'https://arkkanapp2.net/Documents/',

  /* ── FTC2 Server ── */
  FTC2_URL:          process.env.FTC2_URL || 'https://ftc2-z4av.onrender.com',
  FTC2_USER:         process.env.FTC2_USER || '',
  FTC2_PASS:         process.env.FTC2_PASS || '',

  /* ── المتصفح ── */
  HEADLESS:          process.env.ARKKAN_HEADLESS !== 'false',
  MAX_WORKERS:       Math.max(1, Math.min(4, parseInt(process.env.ARKKAN_AGENT_WORKERS || '1', 10) || 1)),

  /* ── التوقيتات (بالمللي ثانية) ──
     ARKKAN_MIN_DELAY / ARKKAN_MAX_DELAY (أو ARKKAN_DELAY_MIN/MAX) يفصلان النطاق
     بين العملاء — يُختار رقم عشوائي في هذا النطاق لمنع نمط متكرر متوقع.
     ARKKAN_DELAY_BETWEEN يضبط توقيتاً ثابتاً (يستخدمه سكربت المزامنة). */
  DELAY: {
    MIN:             parseInt(process.env.ARKKAN_MIN_DELAY || process.env.ARKKAN_DELAY_MIN || '3000', 10),
    MAX:             parseInt(process.env.ARKKAN_MAX_DELAY || process.env.ARKKAN_DELAY_MAX || '5000', 10),
    BETWEEN_CLIENTS: parseInt(process.env.ARKKAN_DELAY_BETWEEN || '3000', 10),
    PAGE_LOAD:       parseInt(process.env.ARKKAN_PAGE_LOAD_WAIT || '4000', 10),
    RESULT_STABLE:   parseInt(process.env.ARKKAN_RESULT_STABLE_WAIT || '180', 10),
    RESULT_TIMEOUT:  parseInt(process.env.ARKKAN_RESULT_TIMEOUT || '9000', 10),
    DOCUMENT_OPEN:   parseInt(process.env.ARKKAN_DOCUMENT_OPEN_TIMEOUT || '27000', 10),
    DIALOG_CLOSE:    parseInt(process.env.ARKKAN_DIALOG_CLOSE_WAIT || '4000', 10),
    SMART_REFRESH:   parseInt(process.env.ARKKAN_SMART_REFRESH_WAIT || '300', 10),
    FRAME_WAIT:      parseInt(process.env.ARKKAN_FRAME_WAIT || '90', 10),
    DETAILS_TIMEOUT: parseInt(process.env.ARKKAN_DETAILS_TIMEOUT || '8000', 10),
    RETRY_STABLE:    parseInt(process.env.ARKKAN_RETRY_STABLE_WAIT || '700', 10),
    DIALOG_POLL:     parseInt(process.env.ARKKAN_DIALOG_POLL || '120', 10),
  },

  /* ── إعادة المحاولة ── */
  RETRY: {
    MAX_ATTEMPTS:         parseInt(process.env.ARKKAN_MAX_RETRIES || '3', 10),
    INITIAL_BACKOFF_MS:   parseInt(process.env.ARKKAN_RETRY_BACKOFF || '2000', 10),
    MAX_BACKOFF_MS:       parseInt(process.env.ARKKAN_RETRY_MAX_BACKOFF || '30000', 10),
    BACKOFF_MULTIPLIER:   parseFloat(process.env.ARKKAN_RETRY_MULTIPLIER || '2'),
  },

  /* ── مهل الاستجابة ── */
  TIMEOUT: {
    WARM:       parseInt(process.env.ARKKAN_WARM_TIMEOUT || '60000', 10),
    FETCH:      parseInt(process.env.ARKKAN_FETCH_TIMEOUT || '90000', 10),
    INIT:       parseInt(process.env.ARKKAN_INIT_TIMEOUT || '60000', 10),
    HTTP_BODY:  parseInt(process.env.ARKKAN_HTTP_BODY_LIMIT || '1048576', 10), // 1MB
  },

  /* ── Polling / Smart Wait ── */
  POLL: {
    INTERVAL:       parseInt(process.env.ARKKAN_POLL_INTERVAL || '180', 10),
    STABLE_COUNT:   parseInt(process.env.ARKKAN_POLL_STABLE_COUNT || '2', 10),
    EXAM_INTERVAL:  parseInt(process.env.ARKKAN_EXAM_POLL_INTERVAL || '150', 10),
    EXAM_MAX_TICKS: parseInt(process.env.ARKKAN_EXAM_POLL_MAX || '60', 10),
  },

  /* ── حماية ── */
  PROTECTION: {
    BLOCK_STATUSES: [403, 429],
    CAPTCHA_SIGNALS: ['captcha', 'unusual security challenge', 'access denied', 'block'],
  },

  /* ── CORS (للوكيل المحلي) ── */
  CORS_ORIGIN: process.env.ARKKAN_CORS_ORIGIN || 'http://127.0.0.1:17532',
};
