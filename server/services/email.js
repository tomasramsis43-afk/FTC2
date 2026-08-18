// ============================================================
// خدمة إرسال الإيميلات المركزية — نقطة واحدة لكل أنواع الإيميلات فى النظام
// (روابط الدخول، الفواتير، التقارير، تنبيهات الأمان). تُبنى فوق نفس منطق
// الـ transporter القديم (كان محصوراً فى magic-link.js) بدون أي تغيير فى
// سلوكه، فقط انتقل هنا ليُعاد استخدامه من كل المسارات الأخرى.
// ============================================================
const nodemailer = require('nodemailer');

let cachedTransporter = null;
let cachedTransporterKey = null;
// نعيد بناء الـ transporter فقط لو تغيّرت متغيرات البيئة فعلياً (نادر جداً أثناء تشغيل
// السيرفر)، بدل إعادة الاتصال بـ SMTP فى كل طلب — أسرع وأقل حملاً على خادم البريد.
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

function isConfigured() {
  return !!getTransporter();
}

// غلاف عام لإرسال أي إيميل. يرجّع { ok: true } أو { ok: false, reason } بدل ما يرمي
// استثناء دايماً — عشان المسارات اللي بتستخدمه (خصوصاً التنبيهات الخلفية) تقدر تكمل
// شغلها بأمان حتى لو فشل الإرسال، وتسجّل السبب فى اللوج فقط.
async function sendEmail({ to, subject, html, text, attachments }) {
  const transport = getTransporter();
  if (!transport) {
    console.error(`تعذّر إرسال إيميل "${subject}": إعدادات SMTP غير مكتملة على السيرفر`);
    return { ok: false, reason: 'smtp_not_configured' };
  }
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (recipients.length === 0) return { ok: false, reason: 'no_recipient' };
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients.join(','),
      subject,
      html,
      text,
      attachments,
    });
    return { ok: true };
  } catch (e) {
    console.error(`فشل إرسال إيميل "${subject}" إلى ${recipients.join(',')}:`, e.message);
    return { ok: false, reason: 'send_failed', error: e.message };
  }
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
