const express = require('express');
const https = require('https');
const router = express.Router();

// بروكسي أركان (Arkkan) لمنصة الحقائب المصروفة — نسخة السيرفر (Render)
// بدون هذا المسار، أي طلب من المتصفح لـ /arkkan/... كان يسقط على الـ catch-all
// العام (app.get('*') في server.js) ويرجع app.html نفسه بدل بيانات أركان،
// فتفشل عملية الاستيراد بصمت تام (صفر سجلات، بدون أي خطأ ظاهر).
// قائمة المسارات المسموح بها — يُمنع أي مسار آخر لمنع استخدام البروكسي ك攻ابة SSRF
const ALLOWED_ARKKAN_PATHS = [
  '/Municipal/Disbursed-bags.aspx',
  '/Municipal/Disbursed-bags.aspx/',
  '/Municipal/',
  '/SitePages/',
  '/_layouts/',
];
function isAllowedArkkanPath(p) {
  return ALLOWED_ARKKAN_PATHS.some(allowed => p === allowed || p.startsWith(allowed + '?') || p.startsWith(allowed + '&'));
}
router.use('/arkkan', (req, res) => {
  const targetPath = req.url; // يحافظ على /Municipal/Disbursed-bags.aspx وما بعدها كما هو
  // حماية SSRF: رفض أي مسار غير معروف + رفض مسارات تحتوي على .. أو @ أو null bytes
  if (!isAllowedArkkanPath(targetPath) || /\.\.|%2e%2e|@|%00/i.test(targetPath)) {
    return res.status(403).json({ error: 'مسار غير مسموح به' });
  }
  const targetUrl = 'https://arkkanapp.net' + targetPath;
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = Object.assign({}, req.headers);
    delete headers.host;
    delete headers.connection;
    headers.host = 'arkkanapp.net';
    if (body.length) headers['content-length'] = String(body.length);

    const u = new URL(targetUrl);
    const proxyReq = https.request(
      { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: req.method, headers },
      proxyRes => {
        // إصلاح جوهري: كوكيز arkkanapp.net تصل بسمة Domain=arkkanapp.net، ولو
        // مررناها للمتصفح كما هي فسيرفضها المتصفح لأنها لا تطابق أصل السيرفر
        // المحلي (نفس دومين FTC2) — فتضيع الجلسة فوراً بعد تسجيل الدخول، وكل
        // طلب تالٍ يرجع صفحة الدخول من جديد بدل بيانات الحقائب (صفر نتائج بصمت).
        const respHeaders = Object.assign({}, proxyRes.headers);
        const rawSetCookie = proxyRes.headers['set-cookie'];
        if (rawSetCookie) {
          respHeaders['set-cookie'] = rawSetCookie.map(c =>
            c.replace(/;\s*domain=[^;]+/i, '')
          );
        }
        res.writeHead(proxyRes.statusCode, respHeaders);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', err => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Arkkan proxy error: ' + err.message);
    });
    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
});

module.exports = router;
