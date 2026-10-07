// ============================================================
// metrics.js — قياس تعارضات المزامنة (HTTP 409) كخط أساس للمرحلة 4
// ------------------------------------------------------------
// لا يغيّر أي استجابة ولا يمسّ أي مسار: يستمع لانتهاء كل استجابة، ولو كانت 409
// يطبع سطراً منظّماً واحداً في اللوج (يمكن عدّه من لوج Render بـ grep) ويزيد عدّاداً
// في الذاكرة (يتصفّر مع إعادة تشغيل العملية — للاستدلال لا للمحاسبة).
// ============================================================
const counters = { conflict409: 0, byRoute: Object.create(null) };

function conflictLogger(logger = console) {
  return function conflictMetrics(req, res, next) {
    res.on('finish', () => {
      if (res.statusCode !== 409) return;
      // المسار بلا معرّفات: /api/client-records/abc123 → /api/client-records/:id
      const route = String((req.route && req.baseUrl != null ? req.baseUrl + req.route.path : req.originalUrl || req.url || '')
        .split('?')[0]).replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/:id');
      const key = `${req.method} ${route}`;
      counters.conflict409++;
      counters.byRoute[key] = (counters.byRoute[key] || 0) + 1;
      logger.log(`[metric] conflict409 route="${key}" total=${counters.conflict409}`);
    });
    next();
  };
}

function snapshot() {
  return { conflict409: counters.conflict409, byRoute: { ...counters.byRoute } };
}

function reset() {
  counters.conflict409 = 0;
  counters.byRoute = Object.create(null);
}

module.exports = { conflictLogger, snapshot, reset };
