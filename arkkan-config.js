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

  /* ── بوابة الحقيبة التثقيفية (رفع "طلب متدرب") ── */
  ARKKAN_LOGIN_URL:    process.env.ARKKAN_LOGIN_URL || 'https://arkkanapp2.net/Municipal/educational-bags-login.aspx',
  ARKKAN_TRAINEE_URL:  process.env.ARKKAN_TRAINEE_URL || 'https://arkkanapp2.net/Municipal/Traniee_Request.aspx',
  /* الاعتمادات تُقرأ من البيئة/ملف .env أو تُرسل في جسم الطلب من البرنامج —
     لا تُكتب في الكود أبداً */
  ARKKAN_USER:         process.env.ARKKAN_USER || '',
  ARKKAN_PASS:         process.env.ARKKAN_PASS || '',

  /* إعدادات نموذج "اضافة طلب متدرب" — ثوابت وفق قرار المستخدم */
  TRAINEE: {
    /* البلدية/الأمانة: تُختار دائماً "أمانة منطقة الرياض -- بلدية الخرج" */
    CITY_VALUE: process.env.ARKKAN_CITY_VALUE || '9f1a287c-4da4-46bf-8ba6-cb7cfb797b18',
    CITY_LABEL: 'أمانة منطقة الرياض--بلدية الخرج',
    /* النوع: ذكر دائماً (1) */
    GENDER: '1',
    /* نوع الهوية حسب الجنسية: سعودي=هوية وطنية(1)، الأجنبي=هوية مقيم(3) */
    IDEN_SAUDI: '1',
    IDEN_RESIDENT: '3',
    /* الحقول الثلاثة الأخيرة للاسم: مسافة واحدة فقط */
    NAME_EMPTY_FILL: ' ',
    /* جنسية أركان للسعودي (113) */
    SAUDI_CODE: '113',
    /* خريطة جنسيات البرنامج (مفاتيح إنجليزية من إعدادات FTC2) → كود أركان
       — مطابقة غير حساسة لحالة الأحرف، مع بدائل عربية شائعة */
    NATIONALITIES: {
      saudi: '113', 'سعودي': '113', 'سعودى': '113', 'السعودية': '113',
      yemeni: '111', yemen: '111', 'يمني': '111', 'اليمن': '111',
      egyption: '207', egypt: '207', 'مصري': '207', 'مصر': '207',
      sudanese: '204', 'سوداني': '204', 'السودان': '204',
      türkiye: '309', turkiye: '309', turkey: '309', 'تركي': '309', 'تركيا': '309',
      syria: '104', syrian: '104', 'سوري': '104', 'سوريا': '104',
      tunisia: '201', 'تونسي': '201', 'تونس': '201',
      afghanistan: '301', 'أفغانستان': '301', 'افغانستان': '301',
      ethiopia: '401', 'اثيوبيا': '401', 'إثيوبيا': '401', 'أثيوبيا': '401',
      morocco: '208', 'مغربي': '208', 'المغرب': '208',
      palestine: '107', 'فلسطيني': '107', 'فلسطين': '107',
      jordan: '102', 'أردني': '102', 'الاردن': '102', 'الأردن': '102',
      bangladesh: '305', 'بنجلاديش': '305', 'بنغلاديش': '305',
      hindi: '321', india: '321', indian: '321', 'هندي': '321', 'الهند': '321',
      pakistani: '304', 'باكستاني': '304', 'باكستان': '304',
      nepali: '320', nepal: '320', 'نيبالي': '320', 'نيبال': '320',
      indonesia: '302', 'اندونيسي': '302', 'اندونيسيا': '302', 'إندونيسيا': '302',
      filipino: '315', 'فلبيني': '315', 'الفلبين': '315',
      srilanka: '313', 'سريلانكي': '313', 'سري لانكا': '313',
      tanzanian: '406', 'تنزاني': '406', 'تنزانيا': '406',
      ghanaian: '421', 'غاني': '421', 'غانا': '421',
      kenya: '427', kenyan: '427', 'كينيا': '427', 'كنيائي': '427',
      ugandan: '402', 'أوغندي': '402', 'اوغندة': '402', 'أوغندا': '402',
      lebanon: '110', 'لبناني': '110', 'لبنان': '110'
    }
  },

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
    WARM:         parseInt(process.env.ARKKAN_WARM_TIMEOUT || '60000', 10),
    FETCH:        parseInt(process.env.ARKKAN_FETCH_TIMEOUT || '90000', 10),
    RECEIPTS:     parseInt(process.env.ARKKAN_RECEIPTS_TIMEOUT || '150000', 10),
    SUBMIT:       parseInt(process.env.ARKKAN_SUBMIT_TIMEOUT || '120000', 10),
    LOGIN:        parseInt(process.env.ARKKAN_LOGIN_TIMEOUT || '45000', 10),
    INIT:         parseInt(process.env.ARKKAN_INIT_TIMEOUT || '60000', 10),
    HTTP_BODY:    parseInt(process.env.ARKKAN_HTTP_BODY_LIMIT || '1048576', 10), // 1MB
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
