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

const MAX_ATTACHMENT_BASE64_CHARS = 15 * 1024 * 1024; // ~15MB بعد الترميز، يكفي أي فاتورة/تقرير PDF بمساحة
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const html = bodyHtml || wrapHtml(`
      <p>مرحباً ${clientName || ''}،</p>
      <p>مرفق فاتورتكم${invoiceNo ? ` رقم <b>${invoiceNo}</b>` : ''}${amount ? ` بمبلغ <b>${amount}</b>` : ''}.</p>
      <p style="color:#888; font-size:13px;">شكراً لتعاملكم معنا.</p>
    `);
    const result = await sendEmail({
      to,
      subject: `فاتورة${invoiceNo ? ` رقم ${invoiceNo}` : ''}`,
      html,
      attachments: attachment ? [attachment] : undefined,
    });
    if (!result.ok) return res.status(502).json({ error: 'تعذّر إرسال الإيميل، تأكد من إعدادات SMTP على السيرفر' });
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
    const { to, subject, bodyHtml } = req.body || {};
    const recipients = Array.isArray(to) ? to : [to];
    if (recipients.some(r => !r || !EMAIL_RE.test(r))) {
      return res.status(400).json({ error: 'إيميل غير صالح ضمن قائمة المستلمين' });
    }
    let attachment;
    try {
      attachment = parseAttachment(req.body);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    const html = bodyHtml || wrapHtml(`<p>مرفق التقرير المطلوب.</p>`);
    const result = await sendEmail({
      to: recipients,
      subject: subject || 'تقرير من نظام إدارة المركز',
      html,
      attachments: attachment ? [attachment] : undefined,
    });
    if (!result.ok) return res.status(502).json({ error: 'تعذّر إرسال الإيميل، تأكد من إعدادات SMTP على السيرفر' });
    res.json({ ok: true });
  } catch (e) {
    console.error('فشل إرسال إيميل التقرير:', e);
    res.status(500).json({ error: 'تعذّر إتمام الإرسال' });
  }
});

// POST /api/email/admin-alert — تنبيه إيميل فوري للإدارة للأحداث المهمة في الواجهة: إضافة عميل
// جديد، شراء حقيبة، فاتورة شراء، تسجيل مصروف. يُستدعى من الواجهة لحظة حدوث الحدث مع محتوى
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
