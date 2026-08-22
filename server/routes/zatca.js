const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const zatca = require('../zatca/lib');
const { alertAdmins } = require('../services/email');

/* ================= ربط هيئة الزكاة والضريبة والجمارك (فاتورة) ================= */

// حالة التسجيل الحالية (بدون أي بيانات حسّاسة) — تُستخدم لعرض حالة الربط في الواجهة
router.get('/api/zatca/status', requireAuth, async (req, res) => {
  const environment = req.query.environment || 'sandbox';
  try {
    const row = await zatca.loadActiveEgsRow(environment);
    res.json(zatca.publicStatus(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب حالة الربط مع الهيئة' });
  }
});

// تسجيل/تحديث EGS والحصول على شهادة الامتثال (compliance CSID) — يتطلب OTP من بوابة فاتورة
router.post('/api/zatca/onboard', requireAuth, requireRole('admin'), async (req, res) => {
  const { environment = 'sandbox', otp, orgProfile } = req.body || {};
  if (!otp || !orgProfile) return res.status(400).json({ error: 'يلزم إرسال OTP وبيانات المنشأة (orgProfile)' });
  try {
    const result = await zatca.onboard({ environment, otp, orgProfile });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل التسجيل مع الهيئة', detail: e.message });
  }
});

// طلب شهادة الإنتاج (PCSID) بعد اجتياز فحوصات التوافق
router.post('/api/zatca/production-csid', requireAuth, requireRole('admin'), async (req, res) => {
  const { environment = 'sandbox', complianceRequestId } = req.body || {};
  if (!complianceRequestId) return res.status(400).json({ error: 'يلزم إرسال complianceRequestId' });
  try {
    const result = await zatca.issueProductionCsid({ environment, complianceRequestId });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل الحصول على شهادة الإنتاج', detail: e.message });
  }
});

// إرسال فاتورة مبيعات (تُبنى من الواجهة الأمامية بنفس أرقام الفاتورة المطبوعة)
// مقيَّدة على الأدوار التي تملك فعلياً شاشة الخزنة/العملاء التي تُرسل منها (admin/accountant/staff) —
// الاستقبال محروم لعدم امتلاكه أي من هذه الشاشات أصلاً، ويمنع إرسال فواتير/سجلات ضريبية مزوّرة
// عبر طلب مباشر بأقل صلاحية (إغلاق ثغرة غياب رقابة الدور على هذه النقطة).
router.post('/api/zatca/invoice', requireAuth, requireRole('admin', 'accountant', 'staff'), async (req, res) => {
  const { environment = 'sandbox', clientType, sourceRef, lineItems, issueDate, issueTime } = req.body || {};
  if (!sourceRef || !Array.isArray(lineItems) || !lineItems.length) {
    return res.status(400).json({ error: 'بيانات الفاتورة غير مكتملة' });
  }
  try {
    if (clientType === 'company') {
      await zatca.logUnsupportedStandardInvoice({ sourceRef, documentType: 'invoice', createdBy: req.user.username });
      return res.json({ status: 'not_supported_yet', message: 'الفواتير الضريبية القياسية (B2B) غير مفعّلة بعد في هذا الربط' });
    }
    const result = await zatca.submitSimplifiedInvoice({
      environment, sourceRef, documentType: 'invoice', lineItems, issueDate, issueTime,
      createdBy: req.user.username,
    });
    res.json(result);
  } catch (e) {
    if (e.isValidation) return res.status(400).json({ error: e.message });
    console.error(e);
    // فشل إرسال فاتورة للهيئة هو خلل امتثال حقيقي (وليس مجرد خطأ عابر) — بيانات الفاتورة هنا
    // (رقم مرجعي، بيئة) غير مشفّرة أصلاً (تُرسل صراحة فى هذا الطلب)، فيصح تنبيه الإدارة فورياً.
    alertAdmins(
      'فشل إرسال فاتورة لهيئة الزكاة والضريبة',
      `<p>تعذّر إرسال فاتورة (المرجع: ${sourceRef}) فى بيئة ${environment}.</p><p>الخطأ: ${e.message}</p>`
    ).catch(() => {});
    res.status(500).json({ error: 'تعذّر إرسال الفاتورة للهيئة', detail: e.message });
  }
});

// إرسال إشعار دائن (مردود مبيعات) — نفس رقابة الدور أعلاه (ممنوع عن الاستقبال).
router.post('/api/zatca/return', requireAuth, requireRole('admin', 'accountant', 'staff'), async (req, res) => {
  const { environment = 'sandbox', clientType, sourceRef, lineItems, issueDate, issueTime, canceledInvoiceNumber, reason } = req.body || {};
  if (!sourceRef || !Array.isArray(lineItems) || !lineItems.length) {
    return res.status(400).json({ error: 'بيانات المردود غير مكتملة' });
  }
  try {
    if (clientType === 'company') {
      await zatca.logUnsupportedStandardInvoice({ sourceRef, documentType: 'credit_note', createdBy: req.user.username });
      return res.json({ status: 'not_supported_yet', message: 'إشعارات الدائن القياسية (B2B) غير مفعّلة بعد في هذا الربط' });
    }
    const result = await zatca.submitSimplifiedInvoice({
      environment, sourceRef, documentType: 'credit_note', lineItems, issueDate, issueTime,
      cancelation: {
        canceled_invoice_number: canceledInvoiceNumber || '',
        payment_method: zatca.ZATCAPaymentMethods.CASH,
        reason: reason || 'مردود مبيعات',
      },
      createdBy: req.user.username,
    });
    res.json(result);
  } catch (e) {
    if (e.isValidation) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'تعذّر إرسال المردود للهيئة', detail: e.message });
  }
});

module.exports = router;
