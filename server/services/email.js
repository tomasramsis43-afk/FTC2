// ============================================================
// خدمة إرسال الإيميلات المركزية — نقطة واحدة لكل أنواع الإيميلات فى النظام
// (روابط الدخول، الفواتير، التقارير، تنبيهات الأمان).
// ============================================================
// ملاحظة مهمة عن مزوّد الإرسال: خطط Render المجانية تمنع أي اتصال صادر على بورتات
// SMTP (25/465/587) بالكامل، فأي محاولة اتصال بـ smtp.gmail.com (أو أي SMTP تاني)
// من خدمة مجانية على Render هتتعلّق لحد ما تنتهي المهلة (timeout) بدون أي رد واضح.
// لذلك المزوّد الافتراضي هنا هو Resend عبر HTTPS API عادي (بورت 443 مش محجوب
// أبداً حتى على الخطط المجانية) — ولو حابب تستخدم SMTP بدلاً منه (بعد ترقية خطة
// Render لخطة مدفوعة مثلاً)، سيب RESEND_API_KEY فاضي وحط بيانات SMTP_* بدلاً منه.
const nodemailer = require('nodemailer');

function isConfigured() {
  return !!process.env.RESEND_API_KEY || !!getTransporter();
}

let cachedTransporter = null;
let cachedTransporterKey = null;
function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const key = `${host}|${user}|${process.env.SMTP_PORT || ''}`;
  if (cachedTransporter && cachedTransporterKey === key) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user, pass },
  });
  cachedTransporterKey = key;
  return cachedTransporter;
}

// إرسال عبر Resend (HTTPS API) — المسار الافتراضي والموصى به على Render.
async function sendViaResend({ recipients, cc, subject, html, text, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SMTP_FROM || process.env.RESEND_FROM;
  if (!from) {
    console.error('RESEND_FROM (أو SMTP_FROM) غير مضبوط — لازم عنوان "من" صالح لإرسال Resend');
    return { ok: false, reason: 'no_from_address' };
  }
  const payload = {
    from,
    to: recipients,
    subject,
    html,
    text,
  };
  if (cc && cc.length) payload.cc = cc;
  if (attachments && attachments.length) {
    payload.attachments = attachments.map(a => ({
      filename: a.filename,
      content: a.content, // base64 بالفعل من parseAttachment فى routes/email.js
    }));
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.error(`فشل إرسال إيميل "${subject}" عبر Resend (${resp.status}):`, errBody);
      return { ok: false, reason: 'send_failed', error: `Resend ${resp.status}: ${errBody}` };
    }
    return { ok: true };
  } catch (e) {
    clearTimeout(timeoutId);
    console.error(`فشل إرسال إيميل "${subject}" عبر Resend:`, e.message);
    return { ok: false, reason: 'send_failed', error: e.message };
  }
}

// إرسال عبر SMTP التقليدي (nodemailer) — يُستخدم فقط لو RESEND_API_KEY غير مضبوط.
async function sendViaSmtp({ recipients, cc, subject, html, text, attachments }) {
  const transport = getTransporter();
  if (!transport) {
    console.error(`تعذّر إرسال إيميل "${subject}": لا يوجد RESEND_API_KEY ولا إعدادات SMTP كاملة`);
    return { ok: false, reason: 'not_configured' };
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients.join(','),
      cc: cc && cc.length ? cc.join(',') : undefined,
      subject,
      html,
      text,
      attachments: attachments && attachments.length
        ? attachments.map(a => ({ filename: a.filename, content: a.content, encoding: 'base64', contentType: a.contentType }))
        : undefined,
    });
    return { ok: true };
  } catch (e) {
    console.error(`فشل إرسال إيميل "${subject}" إلى ${recipients.join(',')}:`, e.message);
    return { ok: false, reason: 'send_failed', error: e.message };
  }
}

// غلاف عام لإرسال أي إيميل. يرجّع { ok: true } أو { ok: false, reason } بدل ما يرمي
// استثناء دايماً — عشان المسارات اللي بتستخدمه (خصوصاً التنبيهات الخلفية) تقدر تكمل
// شغلها بأمان حتى لو فشل الإرسال، وتسجّل السبب فى اللوج فقط.
async function sendEmail({ to, cc, subject, html, text, attachments }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  const ccList = Array.isArray(cc) ? cc.filter(Boolean) : (cc ? [cc].filter(Boolean) : []);
  if (recipients.length === 0) return { ok: false, reason: 'no_recipient' };
  if (process.env.RESEND_API_KEY) {
    return sendViaResend({ recipients, cc: ccList, subject, html, text, attachments });
  }
  return sendViaSmtp({ recipients, cc: ccList, subject, html, text, attachments });
}

function wrapHtml(bodyHtml) {
  return `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif; line-height:1.8; color:#222;">${bodyHtml}</div>`;
}

// قائمة إيميلات الإدارة اللي بتستقبل تنبيهات النظام (دخول مشبوه، أخطاء حرجة، إلخ).
// تُقرأ من ADMIN_ALERT_EMAILS كقائمة مفصولة بفواصل، مثال: "a@x.com,b@x.com".
function getAdminAlertEmails() {
  return (process.env.ADMIN_ALERT_EMAILS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// تنبيه إدارة عام (أمان/نظام). best-effort دايماً — لا يُستخدم فى أي مسار حرج يعتمد
// عليه نجاح الطلب نفسه.
async function alertAdmins(subject, bodyHtml) {
  const recipients = getAdminAlertEmails();
  if (recipients.length === 0) return { ok: false, reason: 'no_admin_recipients' };
  return sendEmail({ to: recipients, subject: `[تنبيه نظام] ${subject}`, html: wrapHtml(bodyHtml) });
}

module.exports = { sendEmail, alertAdmins, getAdminAlertEmails, isConfigured, wrapHtml, getTransporter };
