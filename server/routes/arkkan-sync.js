/* ============================================================
   arkkan-sync.js — مسارات جلب بيانات أركان من داخل السيرفر
   ------------------------------------------------------------
   يستخدم arkkan-fetch (متصفح مخفي عبر Playwright) فيجلب بيانات
   العميل من منصة أركان ويعيدها للواجهة — من غير أي برنامج منفصل.
   ============================================================ */

const express = require('express');
const { requireAuth } = require('../auth');
const arkkan = require('../lib/arkkan-fetch');

const router = express.Router();

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`انتهت مهلة الجلب من أركان (أكثر من ${Math.round(ms / 1000)} ثانية)`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/* GET /api/arkkan/status — حالة جاهزية المتصفح المخفي.
   أول استدعاء يبدأ تجهيز أركان في الخلفية ليصبح زر الجلب حاضراً فوراً. */
router.get('/api/arkkan/status', requireAuth, async (req, res) => {
  res.json(arkkan.getStatus());
  // تجهيز في الخلفية (لا يحجب الاستجابة؛ الفحص التالي أو الجلب يكمل)
  arkkan.warm().catch(e => console.error('[arkkan] تجهيز الخلفية فشل:', e.message));
});

/* POST /api/arkkan/fetch — جلب بيانات عميل من أركان.
   body: { clientId, referNum? } */
router.post('/api/arkkan/fetch', requireAuth, async (req, res) => {
  const { clientId, referNum } = req.body || {};
  const id = String(clientId || '').trim();
  if (!id) return res.status(400).json({ error: 'رقم الهوية مطلوب' });

  try {
    const data = await withTimeout(
      arkkan.fetchOne({ clientId: id, referNum: String(referNum || '').trim() }),
      90000
    );
    res.json(data);
  } catch (e) {
    const status = /playwright|chromium|متصفح/.test(e.message) ? 503 : 502;
    res.status(status).json({ error: e.message });
  }
});

/* POST /api/arkkan/exams — جلب نتائج اختبارات عميل من أركان (الرسوب والنجاح).
   body: { clientId, referNum? } → يعيد آخر 4 محاولات + تاريخ آخر اختبار. */
router.post('/api/arkkan/exams', requireAuth, async (req, res) => {
  const { clientId, referNum } = req.body || {};
  const id = String(clientId || '').trim();
  if (!id) return res.status(400).json({ error: 'رقم الهوية مطلوب' });

  try {
    const data = await withTimeout(
      arkkan.fetchExamScores({ clientId: id, referNum: String(referNum || '').trim() }),
      90000
    );
    res.json(data);
  } catch (e) {
    const status = /playwright|chromium|متصفح/.test(e.message) ? 503 : 502;
    res.status(status).json({ error: e.message });
  }
});

module.exports = router;