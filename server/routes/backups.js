const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { storageLimiter } = require('../rate-limiters');


// ---------------- النسخ الاحتياطية الكاملة المُجدوَلة (مشفّرة من طرف العميل، أدمن فقط) ----------------
// الحد الأقصى لعدد النسخ المحفوظة فى نفس الوقت — أي نسخة جديدة تتخطى الحد تحذف أقدم نسخة تلقائياً،
// بحيث لا يتضخم الجدول بلا نهاية (خصوصاً مع "auto" التي قد تتكرر كل أسبوع لسنوات).
const MAX_BACKUPS_RETAINED = 30;
router.post('/api/backups', requireAuth, storageLimiter, requireRole('admin'), async (req, res) => {
  const enc = req.body?.enc;
  const kind = req.body?.kind === 'manual' ? 'manual' : 'auto';
  if (typeof enc !== 'string' || !enc.length) return res.status(400).json({ error: 'بيانات النسخة الاحتياطية مفقودة' });
  try {
    const ins = await pool.query(
      `INSERT INTO app_backups (kind, enc, size_bytes, created_by) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [kind, enc, Buffer.byteLength(enc, 'utf8'), req.user.username]
    );
    // تنظيف: الاحتفاظ بآخر MAX_BACKUPS_RETAINED نسخة فقط
    await pool.query(
      `DELETE FROM app_backups WHERE id NOT IN (SELECT id FROM app_backups ORDER BY created_at DESC LIMIT $1)`,
      [MAX_BACKUPS_RETAINED]
    );
    res.json({ id: ins.rows[0].id, createdAt: ins.rows[0].created_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حفظ النسخة الاحتياطية' });
  }
});
// قائمة النسخ (بيانات وصفية فقط — بدون المحتوى المشفّر نفسه، تفادياً لردّ ثقيل)
router.get('/api/backups', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, kind, size_bytes, created_by, created_at FROM app_backups ORDER BY created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة النسخ الاحتياطية' });
  }
});
// محتوى نسخة واحدة كاملاً (للتنزيل/الاستعادة) — يفكّه المتصفح بمفتاحه محلياً، السيرفر يمرّره كما هو فقط
router.get('/api/backups/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, kind, enc, created_at FROM app_backups WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'النسخة غير موجودة' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب النسخة الاحتياطية' });
  }
});
router.delete('/api/backups/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM app_backups WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف النسخة الاحتياطية' });
  }
});

module.exports = router;
