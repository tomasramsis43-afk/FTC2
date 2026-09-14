const express = require('express');
const https = require('https');
const router = express.Router();
const { arkkanLimiter } = require('../rate-limiters');

// بروكسي أركان (Arkkan) لمنصة الحقائب المصروفة — نسخة السيرفر (Render)
// بدون هذا المسار، أي طلب من المتصفح لـ /arkkan/... كان يسقط على الـ catch-all
// العام (app.get('*') في server.js) ويرجع app.html نفسه بدل بيانات أركان،
// فتفشل عملية الاستيراد بصمت تام (صفر سجلات، بدون أي خطأ ظاهر).
// قائمة المسارات المسموح بها — يُمنع أي مسار آخر لمنع استخدام البروكسي كبوابة SSRF
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
// تحقق من سلامة المسار/الاستعلام: يمنع الـ path traversal ورمز @، وnull bytes، ومحارف
// تحكم عامة قد تُستخدم في حشو رؤوس (CR/LF/TAB) أو مسارات غير متوقعة (.. %2e%2e %5c %2f %3f).
function isCleanArkkanPath(p) {
  if (/[\x00-\x1f\x7f]|\.\.|%2e%2e|@|%00|%0d|%0a|%09|%5c/i.test(p)) return false;
  return true;
}
const ALLOWED_ARKKAN_METHODS = new Set(['GET', 'POST', 'HEAD']);
const MAX_ARKKAN_BODY = 2 * 1024 * 1024; // 2MB — صفحات أركان لا ترسل أجساماً كبيرة
const ARKKAN_PROXY_TIMEOUT = 20000;      // 20 ثانية للرد من خادم أركان — لا تعليق أبداً
// رؤوس مسموح بتمريرها للخلف فقط — كل ما عداها (host/connection/authorization/
// x-forwarded-*/referer/... يُسقَط لمنع تسريب بيانات أو احتيال. الاستثناء الوحيد:
// 'cookie' — هذه فقط كوكيز جلسة أركان نفسها (الواجهة لا تكتب document.cookie إطلاقاً)،
// وهي السبيل الوحيد لإبقاء الجلسة حيّة بعد تسجيل الدخول (بدونها يعود كل طلب لصفحة الدخول).
const FORWARD_HEADERS = ['accept', 'accept-language', 'content-type', 'cookie'];
function pickForwardHeaders(reqHeaders) {
  const out = {};
  for (const name of FORWARD_HEADERS) {
    const v = reqHeaders[name];
    if (v !== undefined) out[name] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

router.use('/arkkan', arkkanLimiter, (req, res) => {
  if (!ALLOWED_ARKKAN_METHODS.has(req.method)) {
    return res.status(405).json({ error: 'الطريقة غير مسموح بها' });
  }
  const targetPath = req.url; // يحافظ على /Municipal/Disbursed-bags.aspx وما بعدها كما هو
  // حماية SSRF: رفض أي مسار غير معروف + رفض أي مسار فيه محارف خطرة (أشخاص مسار/تحكم)
  if (!isAllowedArkkanPath(targetPath) || !isCleanArkkanPath(targetPath)) {
    return res.status(403).json({ error: 'مسار غير مسموح به' });
  }
  const targetUrl = 'https://arkkanapp2.net' + targetPath;
  const chunks = [];
  let bodySize = 0;
  let abortedOnSize = false;
  req.on('data', c => {
    bodySize += c.length;
    if (bodySize > MAX_ARKKAN_BODY) { abortedOnSize = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (abortedOnSize || req.destroyed) {
      if (!res.headersSent) res.status(413).json({ error: 'حجم الطلب أكبر من المسموح (2MB)' });
      return;
    }
    const body = Buffer.concat(chunks);
    const headers = pickForwardHeaders(req.headers);
    headers.host = 'arkkanapp2.net';
    if (body.length) headers['content-length'] = String(body.length);

    const u = new URL(targetUrl);
    const proxyReq = https.request(
      { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: req.method, headers, timeout: ARKKAN_PROXY_TIMEOUT },
      proxyRes => {
        // إصلاح جوهري: كوكيز arkkanapp2.net تصل بسمة Domain=arkkanapp2.net، ولو
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
    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error('Arkkan proxy timeout'));
    });
    proxyReq.on('error', err => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Arkkan proxy error: ' + err.message);
    });
    res.on('close', () => proxyReq.destroy()); // المتصفح انفصل — لا نترك اتصالاً معلّقاً
    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
});

module.exports = router;