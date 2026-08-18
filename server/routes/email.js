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

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// POST /api/email/audit-alert — تنبيه إيميل فوري للإدارة عند تنفيذ أي عملية إضافة/تعديل/حذف
// على شيت العملاء من أي مستخدم. يُستدعى من الواجهة فور حدوث العملية (نفس لحظة كتابة سجل
// logAudit). best-effort تماماً: فشل الإرسال لا يوقف تدفق العمل ولا يُظهر خطأً للمستخدم،
// والمستلمون هم نفس قائمة ADMIN_ALERT_EMAILS المستخدمة في تنبيهات الأمان. إن لم تُضبط
// القائمة على السيرفر يُتجاوز الإرسال بصمت (skipped).
router.post('/api/email/audit-alert', requireAuth, emailLimiter, async (req, res) => {
  try {
    const { action, section, description, user } = req.body || {};
    if (getAdminAlertEmails().length === 0) return res.json({ ok: true, skipped: true });
    const actionLabels = { add: 'إضافة', edit: 'تعديل', delete: 'حذف', other: 'عملية' };
    const html = `<p>تم تنفيذ عملية على شيت <b>${escapeHtml(section || '')}</b> بواسطة المستخدم <b>${escapeHtml(user || 'غير معروف')}</b>:</p>
      <p><b>${actionLabels[action] || escapeHtml(action || '')}</b></p>
      <p style="border:1px solid #D8DEE6; border-radius:8px; padding:12px 14px; background:#F7F9FB;">${escapeHtml(description || '')}</p>
      <p style="color:#888; font-size:12px;">الوقت: ${new Date().toLocaleString('ar-EG')}</p>`;
    await alertAdmins('سجل عمليات شيت العملاء', html);
    res.json({ ok: true });
  } catch (e) {
    console.error('فشل إرسال تنبيه عمليات شيت العملاء:', e);
    res.status(500).json({ error: 'تعذّر إتمام الإرسال' });
  }
});

module.exports = router;
