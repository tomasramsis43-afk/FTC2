// ============================================================
// metrics.js — قياس تعارضات المزامنة (HTTP 409) كخط أساس للمرحلة 4
// ------------------------------------------------------------
// لا يغيّر أي استجابة ولا يمسّ أي مسار: يستمع لانتهاء كل استجابة، ولو كانت 409
// يطبع سطراً منظّماً واحداً في اللوج (يمكن عدّه من لوج Render بـ grep) ويزيد عدّاداً
// في الذاكرة (يتصفّر مع إعادة تشغيل العملية — للاستدلال لا للمحاسبة).
// ============================================================
const { AsyncLocalStorage } = require('async_hooks');
const counters = { conflict409: 0, byRoute: Object.create(null) };

// المسار بلا معرّفات: /api/client-records/abc123 → /api/client-records/:id
function routeKey(req) {
  const raw = (req.route && req.baseUrl != null) ? req.baseUrl + req.route.path : (req.originalUrl || req.url || '');
  const route = String(raw).split('?')[0].replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/:id');
  return `${req.method} ${route}`;
}

function conflictLogger(logger = console) {
  return function conflictMetrics(req, res, next) {
    res.on('finish', () => {
      if (res.statusCode !== 409) return;
      const key = routeKey(req);
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

// ------------------------------------------------------------
// قياس نقل البيانات من قاعدة البيانات (Neon يوقف الحساب المجاني عند 5GB/شهر "نقل خارج").
// الاستهلاك الذي يهم هو حجم نتائج الاستعلامات (DB → السيرفر) وليس حجم استجابات الـ API.
// نلفّ pool.query فنجمع تقدير حجم الصفوف العائدة لكل (مسار :: استعلام)، ونطبع كل 30 دقيقة أكبر
// المستهلكين بسطور [metric] dbegress قابلة للبحث في لوج Render. لا يغيّر أي نتيجة ولا خطأ.
// حدّ معروف: استعلامات الـ transactions عبر pool.connect() غير مشمولة (كتابات صغيرة غالباً).
// ------------------------------------------------------------
const routeCtx = new AsyncLocalStorage();
let win = { bytes: 0, queries: 0, byKey: new Map() };
const total = { bytes: 0, queries: 0 };

function routeContext() {
  return function routeContextMw(req, res, next) { routeCtx.run({ req }, next); };
}

function estimateRowsBytes(rows) {
  let n = 0;
  for (const r of rows || []) {
    for (const k in r) {
      const v = r[k];
      if (v == null) continue;
      const t = typeof v;
      if (t === 'string') n += v.length;
      else if (Buffer.isBuffer(v)) n += v.length;
      else if (t === 'object') { try { n += JSON.stringify(v).length; } catch (e) { /* تجاهل */ } }
      else n += 8;
    }
  }
  return n;
}

function sqlLabel(sql) {
  const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function recordDbBytes(sql, result) {
  const rows = result && result.rows;
  if (!rows || !rows.length) { win.queries++; total.queries++; return; }
  const bytes = estimateRowsBytes(rows);
  const ctx = routeCtx.getStore();
  const where = ctx && ctx.req ? routeKey(ctx.req) : 'background';
  const key = `${where} :: ${sqlLabel(sql)}`;
  const e = win.byKey.get(key) || { bytes: 0, calls: 0 };
  e.bytes += bytes; e.calls++;
  win.byKey.set(key, e);
  win.bytes += bytes; win.queries++;
  total.bytes += bytes; total.queries++;
}

function wrapPoolQuery(pool) {
  const orig = pool.query.bind(pool);
  pool.query = function meteredQuery(...args) {
    if (typeof args[args.length - 1] === 'function') return orig(...args); // نمط callback: بلا قياس
    const p = orig(...args);
    return p.then((r) => { try { recordDbBytes(args[0], r); } catch (e) { /* القياس لا يكسر الاستعلام */ } return r; });
  };
  return pool;
}

const fmtMB = (n) => (n / 1048576).toFixed(2) + 'MB';

function reportEgress(logger = console, top = 10) {
  const entries = [...win.byKey.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top);
  if (win.bytes > 0) {
    logger.log(`[metric] dbegress window_total=${fmtMB(win.bytes)} queries=${win.queries} since_boot=${fmtMB(total.bytes)}`);
    entries.forEach(([k, v], i) => logger.log(`[metric] dbegress top#${i + 1} ${fmtMB(v.bytes)} calls=${v.calls} ${k}`));
  }
  win = { bytes: 0, queries: 0, byKey: new Map() };
}

function startEgressReport({ intervalMs = 30 * 60 * 1000, logger = console } = {}) {
  const t = setInterval(() => reportEgress(logger), intervalMs);
  if (t.unref) t.unref();
  return t;
}

function egressSnapshot() {
  return { sinceBootBytes: total.bytes, windowBytes: win.bytes, windowEntries: win.byKey.size };
}

module.exports = { conflictLogger, snapshot, reset, routeContext, wrapPoolQuery, estimateRowsBytes, recordDbBytes, reportEgress, startEgressReport, egressSnapshot, routeKey };
