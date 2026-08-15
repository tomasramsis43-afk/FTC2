const rateLimit = require('express-rate-limit');

/* حماية من محاولات التخمين المتكررة (Brute-force) على المسارات التي لا تتطلب
   تسجيل دخول مسبق. نحدّد بالـ IP لأن هذين المسارين تحديداً هما هدف مباشر
   لأي محاولة تخمين آلية (كلمة مرور أو كود ترخيص). */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 20, // 20 محاولة كحد أقصى لكل IP خلال النافذة الزمنية
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة جداً، يرجى الانتظار قليلاً قبل إعادة المحاولة' },
});
const licenseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة جداً، يرجى الانتظار قليلاً قبل إعادة المحاولة' },
});

const storageLimiter = rateLimit({
  windowMs: 60 * 1000, // نافذة دقيقة واحدة
  max: 120,            // 120 عملية حفظ كحد أقصى لكل IP في الدقيقة — يكفي دفعات "مسح + رفع استعادة" كاملة
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'طلبات حفظ كثيرة جداً، يرجى الانتظار قليلاً قبل إعادة المحاولة' },
});
// نقاط الذكاء الاصطناعي (قراءة فواتير OCR / تصنيف مصروفات) هي الوحيدة فى كل السيرفر التي تستدعي
// Anthropic API خارجياً بتكلفة فعلية لكل طلب — بدون حد لمعدل الطلبات، حساب مُخترَق أو مسيء يقدر
// يستهلك رصيد الـ API بسرعة (خصوصاً read-invoices اللي بتقبل حتى 30 ملف فى الطلب الواحد).
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 طلب لكل IP خلال 15 دقيقة (كل طلب read-invoices قد يحتوي حتى 30 ملف بالفعل)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'طلبات ذكاء اصطناعي كثيرة جداً، يرجى الانتظار قليلاً قبل إعادة المحاولة' },
});

module.exports = { authLimiter, licenseLimiter, storageLimiter, aiLimiter };
