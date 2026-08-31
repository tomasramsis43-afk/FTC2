const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const { storageLimiter } = require('../rate-limiters');
const backupService = require('../services/backup');


// ---------------- النسخ الاحتياطية الكاملة المُجدوَلة (مشفّرة من طرف العميل، أدمن فقط) ----------------
// الحد الأقصى لعدد النسخ المحفوظة فى نفس الوقت — أي نسخة جديدة تتخطى الحد تحذف أقدم نسخة تلقائياً.
router.post('/api/backups', requireAuth, storageLimiter, requireRole('admin'), async (req, res) => {
  try {
    const result = await backupService.create({
      kind: req.body?.kind,
      enc: req.body?.enc,
      createdBy: req.user.username,
    });
    if (!result.ok) return res.status(400).json({ error: result.reason === 'enc_too_large' ? 'حجم البيانات المشفّرة يتجاوز الحد الأقصى' : 'بيانات النسخة الاحتياطية مفقودة' });
    res.json({ id: result.id, createdAt: result.createdAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حفظ النسخة الاحتياطية' });
  }
});
// قائمة النسخ (بيانات وصفية فقط — بدون المحتوى المشفّر نفسه، تفادياً لردّ ثقيل)
router.get('/api/backups', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    res.json(await backupService.list());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة النسخ الاحتياطية' });
  }
});
// محتوى نسخة واحدة كاملاً (للتنزيل/الاستعادة) — يفكّه المتصفح بمفتاحه محلياً، السيرفر يمرّره كما هو فقط
router.get('/api/backups/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const row = await backupService.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'النسخة غير موجودة' });
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب النسخة الاحتياطية' });
  }
});
router.delete('/api/backups/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await backupService.remove(req.params.id);
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف النسخة الاحتياطية' });
  }
});

module.exports = router;
