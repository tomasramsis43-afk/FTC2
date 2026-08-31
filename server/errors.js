// server/errors.js
// أخطاء قياسية للـ API + middleware مركزي واحد.
// الهدف: أي خطأ غير متوقع يوصل هنا ويُسجَّل بوضوح بدل ما يتبلع فى catch محلي ناقص
// (زي مشكلة auto-settlement اللي حصلت لما تصحيح صامت اتنفذ من غير أي تسجيل).
//
// الاستخدام فى route جديد أو مُهاجَر:
//   const { ValidationError, ForbiddenError } = require('./errors');
//   app.post('/api/x', requireAuth, async (req, res) => {
//     if (!req.body.name) throw new ValidationError('الاسم مطلوب', { field: 'name' });
//     res.json(await doThing());
//   });
//
// ملاحظة: هذا الملف إضافي بالكامل ولا يغيّر سلوك أي route موجود حالياً — الـ routes
// القديمة كلها عندها try/catch خاص بيها وبترجع response بنفسها، فمفيش تعارض.
// الـ middleware المركزي هنا هو شبكة أمان لأي حاجة تفلت (throw من غير catch).

class AppError extends Error {
  constructor(message, statusCode, code, details) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    // isOperational=true يعني خطأ متوقع (تحقق فشل، صلاحية، تعارض...) — يظهر رسالته
    // للمستخدم مباشرة. false يعني باگ برمجي حقيقي — الرسالة الحقيقية تتسجل فى اللوگ
    // فقط، والمستخدم ياخد رسالة عامة.
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details) { super(message, 400, 'VALIDATION_ERROR', details); }
}

class AuthError extends AppError {
  constructor(message = 'غير مصرَّح — يرجى تسجيل الدخول') { super(message, 401, 'AUTH_ERROR'); }
}

class ForbiddenError extends AppError {
  constructor(message = 'غير متاح لهذا الدور') { super(message, 403, 'FORBIDDEN'); }
}

class NotFoundError extends AppError {
  constructor(resource = 'العنصر') { super(`${resource} غير موجود`, 404, 'NOT_FOUND'); }
}

class ConflictError extends AppError {
  // نسخة قديمة عند الكتابة (تعارض تزامن) — details لازم يحتوي النسخة الحالية على السيرفر
  // عشان الفرونت يسأل المستخدم يعمل reload أو overwrite (مش يقرر لوحده).
  constructor(message = 'تعارض فى النسخة — البيانات تغيّرت من جهاز آخر', details) {
    super(message, 409, 'CONFLICT', details);
  }
}

class DatabaseError extends AppError {
  constructor(message = 'خطأ فى قاعدة البيانات', cause) {
    super(message, 500, 'DB_ERROR');
    this.cause = cause;
    this.isOperational = false; // باگ حقيقي أو مشكلة اتصال — يتسجل الـ stack كامل
  }
}

// middleware مركزي — يُسجَّل مرة واحدة، آخر حاجة قبل app.listen، وبعد كل الـ routes.
function centralErrorHandler(err, req, res, next) {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : 'INTERNAL_ERROR';

  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    user: req.user?.username || null,
    role: req.user?.role || null,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    code,
    message: err.message,
  }));
  // الـ stack الكامل يتسجل منفصل (مش JSON) عشان يفضل قابل للقراءة فى Render logs
  if (!isAppError || !err.isOperational) {
    console.error(err.stack);
  }

  if (res.headersSent) return next(err);

  res.status(statusCode).json({
    error: isAppError ? err.message : 'حدث خطأ غير متوقع، يرجى المحاولة لاحقاً',
    code,
    details: isAppError ? err.details : undefined,
  });
}

module.exports = {
  AppError, ValidationError, AuthError, ForbiddenError, NotFoundError, ConflictError, DatabaseError,
  centralErrorHandler,
};
