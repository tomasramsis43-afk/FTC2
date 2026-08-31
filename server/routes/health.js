const express = require('express');
const { ping } = require('../repo/health.repo');
const router = express.Router();

// فحص صحة يعكس حالة النظام الفعلي: يتأكد أن الخادم حيّ (نعطي { ok: true } فوراً)
// وأن اتصال قاعدة البيانات لا يزال مستجيباً. لو كانت القاعدة غير متاحة نرد 503 بدلاً
// من 200 كاذب — فتلتقط خدمات المراقبة (Render Health Check / Uptime) انقطاع القاعدة
// كما يستحق بدل تجاهله. فشل الفحص لا يُسقط العملية: network خطأ يُعاد كـ 503 فقط.
router.get('/api/health', async (req, res) => {
  try {
    const dbOk = await ping();
    res.json({ ok: true, db: dbOk });
  } catch (e) {
    res.status(503).json({ ok: false, db: false, error: 'قاعدة البيانات غير متاحة' });
  }
});

module.exports = router;
