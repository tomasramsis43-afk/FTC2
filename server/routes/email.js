// ============================================================
// إرسال الإيميلات من داخل التطبيق: فواتير + تقارير.
// ============================================================
// ملاحظة معمارية مهمة: بيانات العملاء/الفواتير/التقارير المالية مشفّرة بالكامل من
// طرف المتصفح (راجع تعليق clients_rows و client_records فى schema.sql) — السيرفر
// لا يفك تشفيرها ولا يقدر يبني محتوى الفاتورة/التقرير بنفسه. لذلك هذه المسارات لا
// "تولّد" محتوى الإيميل، بل تستقبل محتوى جاهزاً (HTML + مرفق PDF/CSV اختياري بصيغة
// base64) من الواجهة الأمامية بعد ما تفكّ تشفير البيانات محلياً، وتتولى فقط مهمة
// الإرسال الفعلي عبر SMTP. الإرسال قد يكون "تلقائياً" من منظور المستخدم (الواجهة
// تستدعي هذا المسار فوراً بعد حفظ/دفع فاتورة بدون أي ضغطة زر) أو يدوياً (زرار
// "إرسال بالإيميل" فى شاشة الفاتورة/التقرير) — نفس المسار يخدم الحالتين.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { emailLimiter } = require('../rate-limiters');
const { sendEmail, wrapHtml, alertAdmins, getAdminAlertEmails } = require('../services/email');

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MAX_ATTACHMENT_BASE64_CHARS = 15 * 1024 * 1024; // ~15MB بعد الترميز، يكفي أي فاتورة/تقرير PDF بمساحة
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// عنوان الإيميل يأتي من بيانات واجهة غير موثوقة (رقم فاتورة/اسم) — نعقّمه من المحارف
// الضابطة وطول غير معقول (وقف أي Header Injection لو نُقل إلى SMTP لاحقاً، ومن HTML غير مقصود).
function sanitizeSubject(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t\x00-\x1f]/g, ' ').trim().slice(0, 200);
}

// تنظيف HTML المُرسَل من الواجهة — يزيل أي عناصر/سمات خطيرة قد تُستخدم في تصييد أو حقن محتوى
function sanitizeEmailHtml(html) {
  if (typeof html !== 'string') return html;
  // إزالة الوسوم القابلة للتنفيذ/الحقن أولاً (بما فيها وسوم الميتا/الرابط التي قد تحدّث
  // الصفحة أو تجلب محتوى خارجياً داخل عارض البريد — نافذة تصييد محتملة),
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?\/?>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<base[\s\S]*?\/?>/gi, '')
    .replace(/<meta[\s\S]*?>/gi, '')
    .replace(/<link[\s\S]*?\/?>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    // إسقاط معالجات الأحداث + البروتوكولات/الطرق القابلة للتنفيذ
    .replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/data\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '')
    .replace(/expression\s*\(/gi, '')
    // تحييد تعابير CSS المنفّذة للجلب الخارجي (تسريب شاشات داخل عارضات قديمة)
    .replace(/url\s*\(\s*['"]?(?:data|https?):/gi, 'url(none)');
}

function parseAttachment(body) {
  const { attachmentBase64, attachmentName, attachmentType } = body || {};
  if (!attachmentBase64) return null;
  if (attachmentBase64.length > MAX_ATTACHMENT_BASE64_CHARS) {
    const err = new Error('المرفق أكبر من الحجم المسموح به');
    err.status = 413;
    throw err;
  }
  return {
    filename: (attachmentName || 'attachment.pdf').toString().slice(0, 200),
    content: attachmentBase64,
    encoding: 'base64',
    contentType: attachmentType || 'application/pdf',
  };
}

// يحوّل نتيجة sendEmail() الفاشلة إلى رسالة عربية مفهومة تعكس السبب الحقيقي، بدل رسالة
// "تأكد من إعدادات SMTP" الثابتة القديمة التي كانت تظهر دائماً بغض النظر عن السبب الفعلي —
// مضلِّلة خصوصاً أن المزوّد الافتراضي في هذا المشروع هو Resend (HTTPS API) وليس SMTP إطلاقاً
// (راجع تعليق أعلى services/email.js). كل الأسباب الشائعة الموثَّقة فعلياً من لوجات الإنتاج:
// حصة الإرسال اليومية لخطة Resend المجانية، وقيد "الوضع التجريبي" الذي يمنع الإرسال لأي عنوان
// غير عنوان صاحب الحساب المُتحقَّق منه إلا بعد توثيق دومين مخصَّص.
function friendlyEmailError(result) {
  const raw = String(result.error || '');
  if (result.reason === 'not_configured') {
    return 'لم يتم إعداد أي وسيلة لإرسال الإيميلات على السيرفر بعد (لا Resend ولا SMTP) — راجع الإعدادات مع مدير النظام.';
  }
  if (result.reason === 'no_from_address') {
    return 'عنوان "من" (RESEND_FROM/SMTP_FROM) غير مضبوط على السيرفر.';
  }
  if (raw.includes('daily_quota_exceeded')) {
    return 'تم تجاوز الحد اليومي المجاني لإرسال الإيميلات (Resend) — حاول مرة أخرى غداً أو رقّي خطة الحساب.';
  }
  if (raw.includes('You can only send testing emails to your own email address')) {
    return 'حساب الإرسال (Resend) لا يزال في الوضع التجريبي: مسموح الإرسال فقط لعنوان صاحب الحساب حتى تُوثَّق دومين مخصَّص من resend.com/domains.';
  }
  return `تعذّر إرسال الإيميل: ${raw || 'خطأ غير معروف من مزوّد الإرسال'}`;
}

// POST /api/email/invoice — إرسال فاتورة (يدوي من شاشة الفاتورة، أو تلقائي فوراً بعد
// الحفظ/الدفع). body: { to, clientName, invoiceNo, amount, bodyHtml, attachmentBase64,
// attachmentName }. الواجهة تبني bodyHtml أو تكتفي بالحقول الأساسية وتترك القالب الافتراضي.
router.post('/api/email/invoice', requireAuth, emailLimiter, async (req, res) => {
  try {
    const { to, clientName, invoiceNo, amount, bodyHtml } = req.body || {};
    if (!to || !EMAIL_RE.test(to)) return res.status(400).json({ error: 'إيميل العميل غير صالح' });
    let attachment;
    try {
      attachment = parseAttachment(req.body);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    const html = sanitizeEmailHtml(bodyHtml) || wrapHtml(`
      <p>مرحباً ${escapeHtml(clientName || '')}،</p>
      <p>مرفق فاتورتكم${invoiceNo ? ` رقم <b>${escapeHtml(String(invoiceNo))}</b>` : ''}${amount ? ` بمبلغ <b>${escapeHtml(String(amount))}</b>` : ''}.</p>
      <p style="color:#888; font-size:13px;">شكراً لتعاملكم معنا.</p>
    `);
    const result = await sendEmail({
      to,
      subject: sanitizeSubject(`فاتورة${invoiceNo ? ` رقم ${invoiceNo}` : ''}`),
      html,
      attachments: attachment ? [attachment] : undefined,
    });
    if (!result.ok) return res.status(502).json({ error: friendlyEmailError(result) });
    res.json({ ok: true });
  } catch (e) {
    console.error('فشل إرسال إيميل الفاتورة:', e);
    res.status(500).json({ error: 'تعذّر إتمام الإرسال' });
  }
});

// POST /api/email/report — إرسال تقرير (يدوي من شاشة التقارير، أو تلقائي من جدولة
// جانب المتصفح — راجع reports-email-schedule.js فى الفرونت إند). body: { to, subject,
// bodyHtml, attachmentBase64, attachmentName, attachmentType }.
router.post('/api/email/report', requireAuth, emailLimiter, async (req, res) => {
  try {
    const { to, cc, subject, bodyHtml } = req.body || {};
    const recipients = Array.isArray(to) ? to : [to];
    if (recipients.some(r => !r || !EMAIL_RE.test(r))) {
      return res.status(400).json({ error: 'إيميل غير صالح ضمن قائمة المستلمين' });
    }
    const ccList = (Array.isArray(cc) ? cc : (cc ? [cc] : [])).filter(Boolean);
    if (ccList.some(r => !EMAIL_RE.test(r))) {
      return res.status(400).json({ error: 'إيميل غير صالح ضمن قائمة CC' });
    }
    let attachment;
    try {
      attachment = parseAttachment(req.body);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    const html = sanitizeEmailHtml(bodyHtml) || wrapHtml(`<p>مرفق التقرير المطلوب.</p>`);
    const result = await sendEmail({
      to: recipients,
      cc: ccList,
      subject: sanitizeSubject(subject || 'تقرير من نظام إدارة المركز'),
      html,
      attachments: attachment ? [attachment] : undefined,
    });
    if (!result.ok) return res.status(502).json({ error: friendlyEmailError(result) });
    res.json({ ok: true });
  } catch (e) {
    console.error('فشل إرسال إيميل التقرير:', e);
    res.status(500).json({ error: 'تعذّر إتمام الإرسال' });
  }
});

// POST /api/email/admin-alert — تنبيه إيميل فوري للإدارة، مقتصر على 3 أحداث فقط: إضافة عميل
// جديد، حذف عميل، تعديل قيمة مدفوعات عميل (راجع clients-print-modals.js). يُستدعى من الواجهة
// لحظة حدوث الحدث مع محتوى
// HTML جاهز (الواجهة تملك البيانات وتنسيقها). best-effort تماماً: فشل الإرسال لا يوقف العمل،
// والمستلمون هم نفس قائمة ADMIN_ALERT_EMAILS المستخدمة في تنبيهات الأمان. إن لم تُضبط القائمة
// على السيرفر يُتجاوز الإرسال بصمت (skipped).
router.post('/api/email/admin-alert', requireAuth, emailLimiter, async (req, res) => {
  try {
    const { subject, bodyHtml } = req.body || {};
    if (!subject || !bodyHtml) return res.status(400).json({ error: 'نقص في بيانات التنبيه' });
    if (getAdminAlertEmails().length === 0) return res.json({ ok: true, skipped: true });
    await alertAdmins(String(subject).slice(0, 200), bodyHtml);
    res.json({ ok: true });
  } catch (e) {
    console.error('فشل إرسال تنبيه الإدارة:', e);
    res.status(500).json({ error: 'تعذّر إتمام الإرسال' });
  }
});

module.exports = router;
