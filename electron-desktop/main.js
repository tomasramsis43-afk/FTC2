const { app, BrowserWindow, Menu, shell, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const express = require('express');

const PORT = 17532;
// عنوان السيرفر — يمكن تغييره بدون إعادة بناء التطبيق عبر ملف config.json
// بجانب main.js (في مجلد التثبيت). لو الملف غير موجود يُستخدم العنوان الافتراضي.
let REMOTE_BASE = 'https://ftc2-z4av.onrender.com';
try {
  const cfgPath = require('path').join(__dirname, 'config.json');
  if (require('fs').existsSync(cfgPath)) {
    const cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
    if (cfg.serverUrl && /^https:\/\//.test(cfg.serverUrl)) {
      REMOTE_BASE = cfg.serverUrl.replace(/\/$/, '');
    } else if (cfg.serverUrl) {
      console.warn('[Config] serverUrl must start with https:// — ignoring:', cfg.serverUrl);
    }
  }
} catch (e) { /* تجاهل أي خطأ في القراءة والاستمرار بالقيمة الافتراضية */ }
// عنوان الوكيل الحيّ في الريبو — من هنا يتحدّث arkkan-agent.js تلقائياً عند كل
// تشغيل (طالما فيه إنترنت)، فيصل لأي إصلاح أو تحسين جديد بدون إعادة بناء/تثبيت.
// وكيل أركان ليس ملفاً منفرداً — يعتمد على ملفات مرافقة companion في نفس المجلد
// (config/logger/utils/sync). كلها يجب أن تُنقل وتُحدَّث معاً من الريبو وإلا فشل
// تشغيل الوكيل بـ MODULE_NOT_FOUND (مثل require('./arkkan-config')). نعلنها هنا
// بقائمة مرتبة تُستخدم في المزامنة من الريبو وفي ضمّها مع الحزمة (extraResources).
const AGENT_FILES = [
  'arkkan-agent.js',
  'arkkan-config.js',
  'arkkan-logger.js',
  'arkkan-utils.js',
  'arkkan-sync.js'
];
const AGENT_REMOTE_BASE = 'https://raw.githubusercontent.com/tomasramsis43-afk/FTC2/main/';
// نفس ملفات الواجهة اللي تتحدّث فعلياً (بلا الأيقونات والـ manifest الثابتة اللي
// نادراً ما تتغيّر) — بنجيبها من السيرفر الحيّ في كل تشغيل عنده نت، ونكتبها فوق
// النسخة المحلية في مجلد بيانات المستخدم (مش داخل مجلد التثبيت نفسه، عشان الكتابة
// تكون مسموحة من غير صلاحيات Admin).
// ⚠️ هذه القائمة يجب أن تُطابق بالضبط: (أ) كل <script src="js/..."> ثابتة في
// app.html، (ب) الملفات المُحمَّلة ديناميكياً عبر boot.js (health-education-*،
// bag-workflow)، (ج) sw-register.js نفسه (مسؤول عن قرار تعطيل الـ Service Worker
// داخل Electron — لازم يوصل محدّثاً هو الآخر). أي ملف جديد يُضاف في app.html/boot.js
// ولا يُضاف هنا = نسخة سطح المكتب هتفضل شغالة بكود قديم لهذا الملف للأبد من غير
// أي رسالة خطأ (فشل صامت). آخر مرة اتفحصت القائمة بالكامل (٢٠٢٦-٠٨) كان ناقص منها:
// sse-client, shell, sidebar-collapse, module-courses, cockpit-pulse,
// notification-center, module-followups, client-workspace, vault-workspace,
// report-studio, grid-enhancements, onboarding, sw-register.js,
// health-education-validity.js, health-education-ui.js, bag-workflow.js —
// sidebar-collapse.js تحديداً هو سبب عطل زرار طي السايدبار (شغال في المتصفح لكن
// مش موجود أصلاً في نسخة Electron). كذلك أُزيل module-zatca.js من هنا لأنه لم يعد
// مُدرجاً في app.html (تبويب ZATCA اتشال من الواجهة).
const SYNCED_FILES = [
  'app.html', 'styles.css', 'sw.js', 'sw-register.js', 'js/arkkan-import.js',
  'js/arkkan-sync-ui.js',
  'js/core-utils.js', 'js/storage-sync.js', 'js/sse-client.js', 'js/auth-licensing.js',
  'js/shell.js', 'js/theme-settings.js', 'js/sidebar-collapse.js',
  'js/permissions-sound.js', 'js/accounting-core.js',
  'js/backup-restore.js', 'js/undo-redo.js', 'js/clients-alerts-overview.js',
  'js/clients-cfo-dashboard.js', 'js/clients-pagination-filters.js', 'js/clients-print-modals.js',
  'js/clients-bulk-ops.js', 'js/module-invoices.js', 'js/module-bags.js',
  'js/gsheet-workflow.js',
  'js/module-finance.js', 'js/module-reports.js', 'js/module-accounting.js',
  'js/module-courses.js', 'js/module-companies.js', 'js/module-purchases.js',
  'js/module-idsearch.js',
  'js/cockpit-pulse.js', 'js/notification-center.js', 'js/module-followups.js',
  'js/client-workspace.js', 'js/vault-workspace.js', 'js/report-studio.js',
  'js/grid-enhancements.js', 'js/onboarding.js',
  'js/health-education-validity.js', 'js/health-education-ui.js', 'js/bag-workflow.js',
  'js/boot.js'
];
let mainWindow;
let userAssetsDir;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function(){ this.destroy(new Error('timeout')); });
  });
}

// مجلد الواجهة المرفق فعلياً مع الـ setup (ثابت، جوه حزمة التطبيق).
// مجلد بيانات المستخدم يُستخدم فقط لتخزين أي ملفات مُحدَّثة تم تنزيلها من
// السيرفر لاحقاً — لا حاجة لنسخ أي شيء إليه عند أول تشغيل (تجنّباً لمشكلة
// معروفة: نسخ الملفات من داخل أرشيف asar بأدوات مثل fs.cpSync قد تفشل).
//
// مجلد بيانات المستخدم لا يُمسح تلقائياً عند تثبيت نسخة جديدة من الـ setup
// (وده مقصود بشكل عام — علشان لا تُفقد بيانات الكاش الأوفلاين). لكن لو كان
// فيه ملفات واجهة قديمة محفوظة فيه من نسخة سابقة فيها خلل، لازم نتخلّص منها
// أول ما نصدر نسخة جديدة من التطبيق، فنحفظ رقم إصدار التطبيق في هذا المجلد،
// ولو اختلف عن إصدار الـ setup الحالي نمسح كل ملفات الواجهة القديمة (فقط
// الملفات، مش بيانات IndexedDB الفعلية الخاصة بالعميل اللي هي منفصلة تماماً).
function clearStaleAssetsIfVersionChanged() {
  const versionFile = path.join(userAssetsDir, '.app-version');
  const currentVersion = app.getVersion();
  let storedVersion = null;
  try { storedVersion = fs.readFileSync(versionFile, 'utf8').trim(); } catch (e) {}

  if (storedVersion !== currentVersion) {
    for (const file of SYNCED_FILES) {
      try { fs.unlinkSync(path.join(userAssetsDir, file)); } catch (e) {}
    }
    try { fs.writeFileSync(versionFile, currentVersion, 'utf8'); } catch (e) {}
  }
}

async function prepareAssets() {
  userAssetsDir = path.join(app.getPath('userData'), 'app-assets');
  try { fs.mkdirSync(userAssetsDir, { recursive: true }); } catch (e) {}
  clearStaleAssetsIfVersionChanged();
}

// يتحقق من ملفات الواجهة على السيرفر الحي، ويحدّث المخزَّن محلياً فقط للملفات
// اللي اتغيّرت فعلاً (بمقارنة المحتوى)، ويرجّع true لو حصل أي تغيير حقيقي —
// عشان اللي بينادي الدالة يقرر هل يعمل reload للنافذة المفتوحة بالفعل أو لأ.
async function checkForFrontendUpdate() {
  let changed = false;
  const CONCURRENCY = 5;
  for (let i = 0; i < SYNCED_FILES.length; i += CONCURRENCY) {
    const batch = SYNCED_FILES.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (file) => {
      try {
        const remote = await fetchText(`${REMOTE_BASE}/${file}`);
        // نتأكد إن السيرفر رجّع فعلاً ملف مش صفحة خطأ فاضية قبل ما نكتب فوق النسخة المحلية.
        if (remote && remote.length > 20) {
          const destPath = path.join(userAssetsDir, file);
          let existing = null;
          try { existing = fs.readFileSync(destPath, 'utf8'); } catch (e) {}
          if (existing !== remote) {
            // نخلق المجلد الأب تلقائياً (مهم لملفات js/*)
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.writeFileSync(destPath, remote, 'utf8');
            changed = true;
          }
        }
      } catch (e) { /* بدون نت أو السيرفر نايم — نتجاهل ونكمل بالنسخة المحلية */ }
    }));
  }
  return changed;
}

// خادم محلي صغير يقدّم ملفات الواجهة من داخل التطبيق — بهذا الشكل تفتح
// الواجهة فوراً حتى بدون إنترنت إطلاقاً. يبحث أولاً عن نسخة مُحدَّثة في
// مجلد بيانات المستخدم، ولو مش موجودة يرجع للنسخة الأصلية المرفقة مع الـ setup.
// وبيانات IndexedDB/localStorage تُخزَّن في مجلد بيانات التطبيق الخاص بويندوز
// (منفصل تماماً عن كروم)، فمسح كاش المتصفح لا يمسها أبداً. طلبات /api كمان
// بتعدّي من نفس الخادم ده (بروكسي لـ Render) بدل ما تتوجّه مباشرة من النافذة —
// كده كل حاجة بتحصل من نفس الأصل (127.0.0.1) ومفيش مشكلة CORS من الأساس.
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const srv = express();
    srv.use((req, res, next) => {
      // تحصين إضافي: منع أي محاولة تجاوز للبروكسي
      if (req.path.includes('..')) return res.status(400).end();
      next();
    });

    // ---- بروكسي شفاف لكل طلبات /api/* إلى السيرفر الحقيقي على Render ----
    // قبل هذا التعديل كانت الواجهة بتعمل fetch مباشرة لعنوان Render (أصل http مختلف
    // تماماً عن أصل الصفحة المحلية http://127.0.0.1:17532)، فيصطدم بسياسة CORS في
    // Chromium فعلياً (زي ما ظهر في الاختبار: "blocked by CORS policy... No
    // 'Access-Control-Allow-Origin' header")، لأن سيرفر Render مضبوط عمداً (تشديد أمان
    // سابق) إنه يسمح فقط بالأصل الحقيقي للموقع، مش بأصل تطبيق سطح المكتب. الاعتماد على
    // webSecurity:false في نافذة Electron لتجاوز الفحص من طرف المتصفح غير كافٍ ولا آمن.
    // الحل الصحيح: كل طلبات الواجهة بقت بتروح لنفس أصل الصفحة (127.0.0.1) — وهذا الخادم
    // المحلي هو اللي بيعمل الاتصال الفعلي بـ Render نيابة عنها (اتصال سيرفر-لسيرفر، لا
    // يخضع لمفهوم CORS أصلاً). فمن وجهة نظر المتصفح، مفيش "أصل مختلف" نهائياً.
    srv.use('/api', (req, res) => {
      const targetPath = '/api' + req.url;
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = Object.assign({}, req.headers);
        delete headers.host;
        delete headers.connection;
        if (body.length) headers['content-length'] = String(body.length);
        const proxyReq = https.request(
          REMOTE_BASE + targetPath,
          { method: req.method, headers },
          proxyRes => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        proxyReq.on('error', err => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          }
          res.end(JSON.stringify({ error: 'تعذّر الاتصال بالسيرفر: ' + err.message }));
        });
        if (body.length) proxyReq.write(body);
        proxyReq.end();
      });
    });

    // ---- بروكسي شيتات جوجل (جلب CSV سيرفر-لسيرفر) ----
    // جوجل يعيد توجيه /pub?...&output=csv إلى قرص تخزين CDN خاص بـ
    // (*.googleusercontent.com). لذلك نسمح بالمتابعة إلى نطاقات جوجل المعروفة فقط
    // (docs.google.com / drive.google.com) وكذلك googleusercontent.com (CDN) لمنع أي
    // SSRF إلى نطاقات عشوائية مع إتمام الجلب فعلياً.
    //
    // قائمة النطاقات المسموحة (بشكل صارم — لا يُسمح بأي نطاق آخر)
    const GSHEET_ALLOWED_HOSTS = [
      'docs.google.com',
      'drive.google.com',
      'googleusercontent.com',
      'lh3.googleusercontent.com',
      'lh4.googleusercontent.com',
      'lh5.googleusercontent.com',
      'lh6.googleusercontent.com',
    ];
    function isGsheetAllowedHost(hostname) {
      const h = String(hostname || '').toLowerCase();
      for (const allowed of GSHEET_ALLOWED_HOSTS) {
        if (h === allowed || h.endsWith('.' + allowed)) return true;
      }
      return false;
    }
    // فحص URLs الخاصة بالشبكات الخاصة / internal / metadata endpoints
    function isPrivateOrReservedIp(hostname) {
      const h = String(hostname || '').toLowerCase();
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
      if (h === '0.0.0.0') return true;
      // RFC 1918 ranges
      if (/^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h)) return true;
      // AWS metadata, GCP metadata, Azure metadata
      if (h === '169.254.169.254') return true;
      // Link-local
      if (h.startsWith('169.254.') || h.startsWith('fe80:')) return true;
      return false;
    }
    // التحقق من صحة URL باستخدام new URL() وليس Regex
    function isGsheetUrlSafe(urlStr) {
      try {
        const u = new URL(urlStr);
        if (u.protocol !== 'https:') return { ok: false, reason: 'البروتوكول يجب أن يكون https' };
        if (!u.hostname) return { ok: false, reason: 'Hostname غير صالح' };
        if (isPrivateOrReservedIp(u.hostname)) return { ok: false, reason: 'نطاق محظور (شبكة خاصة)' };
        if (!isGsheetAllowedHost(u.hostname)) return { ok: false, reason: 'نطاق غير مسموح به: ' + u.hostname };
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'رابط غير صالح: ' + e.message };
      }
    }
    srv.get('/gsheet-csv', (req, res) => {
      const target0 = String(req.query.url || '');
      const urlCheck = isGsheetUrlSafe(target0);
      if (!urlCheck.ok) {
        res.status(400).json({ error: 'رابط غير صالح — ' + urlCheck.reason });
        return;
      }
      // التحقق من أن المسار يبدأ بـ spreadsheets
      const parsedUrl = new URL(target0);
      if (!parsedUrl.pathname.startsWith('/spreadsheets/') && !parsedUrl.pathname.startsWith('/file/')) {
        res.status(400).json({ error: 'رابط غير صالح — يجب أن يكون رابط Google Docs Spreadsheet' });
        return;
      }
      let hops = 0;
      function fetchCsv(target) {
        // فحص URL لكل redirect
        const safeCheck = isGsheetUrlSafe(target);
        if (!safeCheck.ok) {
          if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'اعادة توجيه لنطاق غير مسموح — ' + safeCheck.reason }));
          return;
        }
        const req2 = https.get(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 25000 }, remoteRes => {
          if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location && hops < 5) {
            hops++;
            let next;
            try {
              next = new URL(remoteRes.headers.location, target).toString();
            } catch (e) {
              if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'رابط redirect غير صالح' }));
              return;
            }
            fetchCsv(next);
            return;
          }
          // فحص hostname النهائي للرد (منع redirect صامت لنطاق غير موثوق)
          try {
            const finalUrl = new URL(target);
            if (!isGsheetAllowedHost(finalUrl.hostname)) {
              if (!res.headersSent) res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'النطاق النهائي غير مسموح به' }));
              return;
            }
          } catch (e) {}
          res.writeHead(remoteRes.statusCode || 200, {
            'Content-Type': remoteRes.headers['content-type'] || 'text/csv; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
          });
          remoteRes.pipe(res);
        });
        req2.on('error', err => {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'تعذّر جلب شيت جوجل: ' + err.message }));
        });
        req2.on('timeout', function () { this.destroy(new Error('timeout')); });
      }
      fetchCsv(target0);
    });

    // ---- استيراد أركان عبر نافذة مخفية (يتغلب على تحميل JavaScript) ----
    srv.post('/arkkan-scrape', (req, res) => {
      let rawBody = '';
      req.on('data', c => rawBody += c);
      req.on('end', async () => {
        let username, password;
        try { const j = JSON.parse(rawBody); username = j.username; password = j.password; } catch(e) {}
        if (!username || !password) { res.status(400).json({ error: 'يوزر وباسورد مطلوبين' }); return; }

        let hiddenWin = null;
        try {
          hiddenWin = new BrowserWindow({
            width: 1280, height: 900, show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
          });

          const targetUrl = 'https://arkkanapp2.net/Municipal/Disbursed-bags.aspx';
          await hiddenWin.loadURL(targetUrl);
          await new Promise(r => setTimeout(r, 2000));

          const loginResult = await hiddenWin.webContents.executeJavaScript(`
            (function(){
              const userField = document.querySelector('[id*="Username"], [name*="Username"], [id*="username"]');
              const passField = document.querySelector('[id*="Password"], [name*="Password"], [type="password"]');
              if(userField && passField){
                userField.value = ${JSON.stringify(username)};
                passField.value = ${JSON.stringify(password)};
                const btn = document.querySelector('[id*="btn_submit"], [id*="btnSubmit"], [type="submit"]');
                if(btn) btn.click();
                return 'login_submitted';
              }
              return 'no_fields_found: ' + document.title;
            })()
          `);
          console.log('[Arkkan Scrape] login:', loginResult);
          await new Promise(r => setTimeout(r, 5000));

          let allRows = [];
          let pageNum = 1;
          const MAX_PAGES = 50;

          while(pageNum <= MAX_PAGES){
            console.log('[Arkkan Scrape] سحب صفحة رقم', pageNum);
            const pageRows = await hiddenWin.webContents.executeJavaScript(`
              (function(){
                const tables = document.querySelectorAll('table');
                for(const t of tables){
                  if(t.querySelector('th')?.textContent?.includes('هوية')){
                    const rows = [...t.querySelectorAll('tr')].slice(1);
                    return rows.map(tr => {
                      const tds = [...tr.querySelectorAll('td')];
                      return tds.map(td => td.textContent.trim());
                    }).filter(r => r.length >= 3);
                  }
                }
                return [];
              })()
            `);
            console.log('[Arkkan Scrape] صفحة', pageNum, ':', pageRows.length, 'صف');
            if(!pageRows.length) break;
            allRows.push(...pageRows);

            const hasNext = await hiddenWin.webContents.executeJavaScript(`
              (function(){
                const links = [...document.querySelectorAll('a')];
                const nextLink = links.find(a => {
                  const txt = a.textContent.trim();
                  const href = a.getAttribute('href') || '';
                  return (txt === '>' || txt === '>>' || txt === 'التالي' || txt.includes('Next'))
                    && href.includes('__doPostBack');
                });
                if(nextLink){ nextLink.click(); return true; }
                return false;
              })()
            `);
            if(!hasNext) break;
            await new Promise(r => setTimeout(r, 3000));
            pageNum++;
          }

          console.log('[Arkkan Scrape] الإجمالي:', allRows.length, 'سجل من', pageNum, 'صفحة');
          res.json({ rows: allRows, pages: pageNum });
        } catch (e) {
          console.error('[Arkkan Scrape] error:', e);
          res.status(500).json({ error: e.message });
        } finally {
          if (hiddenWin && !hiddenWin.isDestroyed()) hiddenWin.destroy();
        }
      });
    });

    // ---- بروكسي أركان (Arkkan) لمنصة الحقائب المصروفة ----
    const ALLOWED_ARKKAN_PATHS = ['/Municipal/Disbursed-bags.aspx', '/Municipal/Disbursed-bags.aspx/', '/Municipal/', '/SitePages/', '/_layouts/'];
    function isAllowedArkkanPath(p) { return ALLOWED_ARKKAN_PATHS.some(a => p === a || p.startsWith(a + '?') || p.startsWith(a + '&')); }
    srv.use('/arkkan', (req, res) => {
      const targetPath = req.url;
      if (!isAllowedArkkanPath(targetPath) || /\.\.|%2e%2e|@|%00/i.test(targetPath)) {
        return res.status(403).json({ error: 'مسار غير مسموح به' });
      }
      const targetUrl = 'https://arkkanapp2.net' + targetPath;
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = Object.assign({}, req.headers);
        delete headers.host;
        delete headers.connection;
        headers['host'] = 'arkkanapp2.net';
        if (body.length) headers['content-length'] = String(body.length);
        const u = new URL(targetUrl);
        const proxyHeaders = Object.assign({}, headers);
    if (req.headers.cookie) proxyHeaders.cookie = req.headers.cookie;
    const proxyReq = https.request(
          { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: req.method, headers: proxyHeaders },
          proxyRes => {
            const respHeaders = Object.assign({}, proxyRes.headers);
            const rawSetCookie = proxyRes.headers['set-cookie'];
            if (rawSetCookie) {
              respHeaders['set-cookie'] = rawSetCookie.map(c => c.replace(/;\s*domain=[^;]+/i, ''));
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

    // ── إدارة وكيل أركان المحلي (arkkan-agent.js على localhost:9955) ──
    // الاندماج الكامل: البرنامج (بدل البات) يثبّت الاعتماديات لأول مرة، يشغّل
    // الوكيل، ويراقبه ويعيد تشغيله تلقائياً عند أي انهيار. كل شيء يعمل في وضع
    // التطوير (من مجلد المشروع) وفي النسخة المثبتة (من resources) على حد سواء.
    const ARKKAN_AGENT_PORT = 9955;
    let arkkanChild = null;
    let arkkanStopRequested = false;

    function arkkanEnvDir() {
      return path.join(app.getPath('userData'), 'arkkan-agent-env');
    }

    // مجلد بيانات المستخدم حيث يُحفظ كامل «حزمة» ملفات الوكيل (agent + مرافقاته).
    function arkkanUserDir() {
      return path.join(app.getPath('userData'), 'arkkan-agent-files');
    }

    // أماكن محتملة لملف الوكيل الرئيسي — كلها يجب أن تُصطحب معها ملفاتها المرافقة.
    async function arkkanAgentPath() {
      const userDir = arkkanUserDir();
      const devDir = path.join(__dirname, '..');
      const candidates = [
        path.join(userDir, 'arkkan-agent.js'),       // النسخة المُحدَّثة من الريبو (كامل الحزمة)
        path.join(devDir, 'arkkan-agent.js'),         // وضع التطوير (جذر المشروع — مرافقاته موجودة بجانبه)
        path.join(process.cwd(), 'arkkan-agent.js'),  // وضع التطوير من مجلد آخر
        path.join(process.resourcesPath, 'arkkan-agent.js') // النسخة المثبتة (resources)
      ];
      for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
      return null;
    }

    // يضمن وجود كل ملفات حزمة الوكيل في مجلد بيانات المستخدم (إما محدّثة من الريبو
    // أو منسوخة من موضع الحزمة/المشروع عند عدم وجود إنترنت)، ويعيد مجلدها.
    async function arkkanEnsureUserBundle() {
      const userDir = arkkanUserDir();
      fs.mkdirSync(userDir, { recursive: true });

      const sourceDirs = [process.resourcesPath, path.join(__dirname, '..'), process.cwd()];

      // 1) محاولة تحديث كل الملفات من الريبو (لو فيه إنترنت).
      let anyRemote = false;
      try {
        await Promise.all(AGENT_FILES.map(async (f) => {
          const remote = await fetchText(AGENT_REMOTE_BASE + f);
          // نحرس الوكيل الرئيسي بأن يحتوي المنفذ/playwright فعلاً (حماية من خطأ)
          // والملفات المرافقة بأن لا يكون الرد فارغاً/قصيراً جداً قبل الكتابة.
          const valid = f === 'arkkan-agent.js'
            ? (remote && remote.length > 500 && remote.includes('9955') && remote.includes('playwright'))
            : (remote && remote.length >= 50);
          if (!valid) return;
          const dest = path.join(userDir, f);
          const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
          if (existing !== remote) {
            fs.writeFileSync(dest, remote, 'utf8');
            anyRemote = true;
          }
        }));
        if (anyRemote) console.log('[Arkkan Agent] حزمة الوكيل حُدِّثت تلقائياً من الريبو');
      } catch (e) { /* دون نت — نكمل بالنسخة المحلية */ }

      // 2) ضمان اكتمال الحزمة: أي ملف مطلوب ناقص يُنسخ من موضع الحزمة/المشروع المتاح.
      for (const f of AGENT_FILES) {
        const dest = path.join(userDir, f);
        if (fs.existsSync(dest)) continue;
        for (const dir of sourceDirs) {
          const src = path.join(dir, f);
          try { if (fs.existsSync(src)) { fs.copyFileSync(src, dest); break; } } catch (e) {}
        }
      }

      return userDir;
    }

    // ينزّل أحدث نسخة من حزمة الوكيل إلى مجلد بيانات المستخدم ويعيد مسار الوكيل
    // الرئيسي فيها. لو مفيش إنترنت يرجع لأي نسخة محلية (المرفقة مع الـ setup/المشروع).
    async function arkkanSyncedAgentPath() {
      const userDir = await arkkanEnsureUserBundle();
      const userAgent = path.join(userDir, 'arkkan-agent.js');
      if (fs.existsSync(userAgent)) return userAgent;
      return arkkanAgentPath();
    }

    function arkkanPing(timeoutMs = 1500) {
      return new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port: ARKKAN_AGENT_PORT, path: '/ping', timeout: timeoutMs }, res => {
          res.on('data', () => {});
          res.on('end', () => resolve(true));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(false); });
      });
    }

    function arkkanPlaywrightInstalled(envDir) {
      return fs.existsSync(path.join(envDir, 'node_modules', 'playwright', 'package.json'));
    }

    function arkkanRunNpm(args) {
      return new Promise((resolve, reject) => {
        const shell = process.env.ComSpec || 'cmd.exe';
        const cmd = 'npm ' + args.join(' ');
        const p = spawn(shell, ['/d', '/s', '/c', cmd], { cwd: arkkanEnvDir(), windowsHide: true, stdio: 'ignore' });
        let done = false;
        p.on('error', e => { if (!done) { done = true; reject(new Error(e.message)); } });
        p.on('exit', code => { if (!done) { done = true; code === 0 ? resolve() : reject(new Error('تنفيذ npm انتهى بكود ' + code)); } });
      });
    }

    function arkkanChromiumInstalled() {
      try {
        const pw = require(path.join(arkkanEnvDir(), 'node_modules', 'playwright'));
        const exe = pw.chromium.executablePath();
        return !!(exe && fs.existsSync(exe));
      } catch (e) {
        return false;
      }
    }

    async function arkkanInstallDeps() {
      const envDir = arkkanEnvDir();
      fs.mkdirSync(envDir, { recursive: true });
      const pkgFile = path.join(envDir, 'package.json');
      if (!fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, '{}');
      if (!arkkanPlaywrightInstalled(envDir)) {
        console.log('[Arkkan Agent] تثبيت مكتبة الأتمتة لأول مرة…');
        await arkkanRunNpm(['install', '--no-save', '--no-audit', '--no-fund', 'playwright@^1.62.1']);
      }
      if (!arkkanChromiumInstalled()) {
        console.log('[Arkkan Agent] تنزيل متصفح Chromium لأول مرة… (قد يستغرق بضع دقائق)');
        await arkkanRunNpm(['exec', '--yes', 'playwright', 'install', 'chromium']);
      }
    }

    function arkkanSpawnAgent(agentPath) {
      try {
        const envDir = arkkanEnvDir();
        const logFile = path.join(app.getPath('userData'), 'arkkan-agent.log');
        // نفتح ملف السجل بعنوان fd عدد صحيح فعلي فوراً عبر fs.openSync. تمرير
        // createWriteStream مباشرة إلى stdio كان يفشل لأن fd ما زال null لحظة
        // الاستدعاء فيرفضه spawn ("The argument 'stdio' is invalid")، فيتوقف الوكيل
        // من الأساس. openSync يضمن fd جاهزاً يُمرَّر للعملية الابنة بأمان.
        const logFd = fs.openSync(logFile, 'a');
        const child = spawn('node', [agentPath], {
          cwd: envDir,
          env: Object.assign({}, process.env, {
            NODE_PATH: path.join(envDir, 'node_modules'),
            ARKKAN_BROWSERS_PATH: path.join(envDir, 'browsers')
          }),
          detached: true,
          stdio: ['ignore', logFd, logFd],
          windowsHide: true
        });
        // نغلق fd في عملية الأصل بعد التسليم — العملية الابنة تحتفظ بنسختها الخاصة
        // للكتابة، وعدم إغلاقه هنا يبقيه عالقاً (ذاكرة/مورد) في الأصل.
        try { fs.closeSync(logFd); } catch (e) {}
        child.unref();
        arkkanChild = child;
        arkkanStopRequested = false;
        const born = Date.now();
        child.on('exit', () => {
          arkkanChild = null;
          if (arkkanStopRequested) return;
          const wait = Date.now() - born < 8000 ? 5000 : 1500;
          console.log('[Arkkan Agent] توقف — إعادة تشغيل بعد ' + Math.round(wait / 1000) + ' ث');
          setTimeout(() => {
            arkkanStartAgent().then(r => { if (r.error) console.log('[Arkkan Agent] ' + r.error); }).catch(() => {});
          }, wait);
        });
        child.on('error', e => { arkkanChild = null; console.log('[Arkkan Agent] تعذّر الإقلاع: ' + e.message); });
        return { message: 'تم تشغيل الوكيل المحلي — يُهيّئ المتصفح الآن' };
      } catch (e) {
        return { error: e.message };
      }
    }

    async function arkkanStartAgent() {
      const running = await arkkanPing();
      if (running) return { message: 'الوكيل يعمل بالفعل على localhost:9955', alreadyRunning: true };
      const agentPath = await arkkanSyncedAgentPath();
      if (!agentPath) {
        return { error: 'arkkan-agent.js غير موجود مع البرنامج — أعد تثبيت البرنامج' };
      }
      try {
        await arkkanInstallDeps();
      } catch (e) {
        return { error: 'فشل تثبيت الاعتماديات لأول مرة: ' + e.message + ' — تأكد من اتصال الإنترنت' };
      }
      return arkkanSpawnAgent(agentPath);
    }

    // إيقاف الوكيل المحلي تلقائياً عند إغلاق التطبيق — حتى لا يبقى عالقاً
    // كعملية يتيمة (orphan) في الخلفية بعد خروج المستخدم من البرنامج.
    function arkkanStopAgent() {
      arkkanStopRequested = true;
      if (arkkanChild && typeof arkkanChild.kill === 'function') {
        try { arkkanChild.kill(); } catch (e) {}
      }
      arkkanChild = null;
    }

    srv.post('/arkkan-agent/start', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const result = await arkkanStartAgent();
      res.status(result.error ? 500 : 200).json(result);
    });

    srv.get('/arkkan-agent/status', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const running = await arkkanPing();
      const ap = await arkkanAgentPath();
      res.json({ running, agentPath: ap ? path.basename(ap) : null });
    });

    // ⚠️ إصلاح مهم: بدون هذا الميدل وير، Chromium (نافذة Electron نفسها) كانت
    // تعتمد على الكاش المتصفحي القياسي (HTTP disk cache) للردود القادمة من هذا
    // الخادم المحلي — ولأن express.static افتراضياً لا يرسل Cache-Control (فقط
    // Last-Modified/ETag)، كان المتصفح أحياناً "يفترض" حداثة النسخة المخزنة عنده
    // ويستخدمها مباشرة دون حتى إرسال طلب تحقق (revalidation) للخادم المحلي —
    // فتظهر المشكلة كأن main.js "لم يحدّث شيئاً" رغم أن الملف الجديد فعلاً موجود
    // على القرص ومُقدَّم بشكل صحيح من الخادم، والمشكلة الحقيقية غير مرئية إطلاقاً:
    // طبقة كاش HTTP فى نافذة Chromium نفسها، منفصلة تماماً عن نظام SYNCED_FILES.
    // الحل: نجبر كل رد من هذا الخادم (HTML/JS/CSS) على عدم التخزين مؤقتاً إطلاقاً،
    // فتُعاد قراءة الملف من القرص (المُحدَّث دوماً بواسطة checkForFrontendUpdate)
    // فى كل تحميل للصفحة، بلا أي احتمال لتقديم نسخة قديمة من كاش المتصفح.
    // (لاحظ: هذا الميدل وير كان بالفعل مضافاً بشكل شبه مطابق من جلسة/تعديل آخر —
    // تم توحيدهما هنا فى نسخة واحدة بدل تكرار middleware مرتين لنفس الغرض)
    srv.use((req, res, next) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });

    srv.use(express.static(userAssetsDir, { etag: false, lastModified: false, cacheControl: false }));
    srv.use(express.static(path.join(__dirname, 'app-assets'), { etag: false, lastModified: false, cacheControl: false }));
    const listener = srv.listen(PORT, '127.0.0.1', () => resolve());

    // تشغيل وكيل أركان المحلي تلقائياً فور فتح التطبيق (إن لم يكن يعمل على
    // localhost:9955) — فيكون تبويب "مزامنة أركان" جاهزاً دون أي تدخل يدوي.
    // يُجدول هنا جوّه scope الدالة حتى تكون arkkanStartAgent مرئية — الاستدعاء
    // القديم كان في app.whenReady على المستوى العام فيرمي ReferenceError.
    setTimeout(() => {
      arkkanStartAgent().then(r => {
        console.log(r.error ? '[Arkkan Agent] ' + r.error : '[Arkkan Agent] ' + r.message);
      }).catch(() => {});
    }, 800);

    // إيقاف الوكيل نهائياً عندما يُغلق المستخدم التطبيق (وليس عند مجرد التصغير/
    // الإخفاء) — يتجنب بقاء عملية وكيل يتيمة تشغّل متصفحاً خفياً بعد إنهاء البرنامج.
    const arkkanCleanup = () => arkkanStopAgent();
    app.on('before-quit', arkkanCleanup);
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') arkkanStopAgent();
    });

    listener.on('error', (err) => {
      const { dialog } = require('electron');
      dialog.showErrorBox(
        'تعذّر فتح البرنامج',
        err.code === 'EADDRINUSE'
          ? 'يبدو أن نسخة أخرى من البرنامج شغالة بالفعل. يرجى إغلاقها من مدير المهام (Task Manager) ثم إعادة المحاولة.'
          : ('حدث خطأ غير متوقع: ' + err.message)
      );
      app.quit();
      reject(err);
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'FTC2 - برنامج إدارة المركز',
    icon: path.join(__dirname, 'app-assets', 'icons', 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      enableRemoteModule: false,
      // مبقاش لازم webSecurity:false: كل طلبات /api بقت بتروح لنفس أصل الصفحة
      // (127.0.0.1) عبر البروكسي المحلي في startLocalServer، فمفيش أصل مختلف
      // يستدعي تعطيل فحص الأمان في المتصفح المدمج أصلاً.
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    // فتح النافذة ممتلئة الشاشة تلقائياً على أي جهاز/شاشة (يفضّل: معظم مستخدمي
    // سطح المكتب يريدون الاستفادة من كامل مساحة الشاشة). يظل قابلاً للتحجيم اليدوي بعدها.
    if (process.env.FTC2_NO_MAXIMIZE !== '1') mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/app.html`);
  // أدوات المطوّر تُفتح فقط عند التشغيل بمتغيّر البيئة FTC2_DEBUG=1 (لتشخيص مشكلة
  // لاحقاً)، مش تلقائياً مع كل تشغيل عادي للمستخدم النهائي.
  if (process.env.FTC2_DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'right' });
  }

  // أي رابط خارجي يفتح في المتصفح — إلا نوافذ الطباعة الداخلية (about:blank) فنسمح بها
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url.startsWith('about:blank')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  Menu.setApplicationMenu(null); // شريط قوائم نظيف بدون عناصر Electron الافتراضية
}

// لو المستخدم فتح البرنامج ونسخة تانية شغالة بالفعل في الخلفية (نسي يقفلها،
// أو النافذة مختفية في الـ System Tray)، النسخة الجديدة تاخد القفل وترفض
// الفتح، وبدل ما تحاول تفتح خادم تاني على نفس المنفذ (وده اللي كان بيسبب
// خطأ "address already in use")، بنركّز نافذة النسخة الأصلية الشغالة فعلاً.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await prepareAssets();
    await startLocalServer();

    // فحص وتحديث ملفات الواجهة يُنفَّذ هنا — قبل إنشاء النافذة وتحميلها لأول مرة —
    // وليس بعده. كان التنفيذ يتم بعد فتح النافذة (لكي يظهر البرنامج بسرعة دون انتظار
    // الشبكة)، ثم تتم إعادة تحميل النافذة (reload) لو وُجد تغيير، مما كان يجعل صفحة
    // الدخول (والتطبيق كله) تظهر مرتين في كل تشغيل طالما ملفات الحزمة المدمجة تختلف
    // عن الملفات المنشورة على السيرفر (وهي تختلف غالباً). الآن بالعكس: إن نزل تحديثٌ
    // جديد تفتح الصفحة مرة واحدة فقط بالملفات المحدّثة — وأي غياب للشبكة يُعالَج داخلياً
    // لكل ملف على حدة (يفشل بسرعة ولا يعطّل بدء التشغيل لأكثر من بضع ثوانٍ أقصاها).
    await checkForFrontendUpdate();

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
