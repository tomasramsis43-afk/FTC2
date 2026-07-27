const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');

const PORT = 17532;
// عنوان السيرفر — يمكن تغييره بدون إعادة بناء التطبيق عبر ملف config.json
// بجانب main.js (في مجلد التثبيت). لو الملف غير موجود يُستخدم العنوان الافتراضي.
let REMOTE_BASE = 'https://ftc-6d0s.onrender.com';
try {
  const cfgPath = require('path').join(__dirname, 'config.json');
  if (require('fs').existsSync(cfgPath)) {
    const cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
    if (cfg.serverUrl) REMOTE_BASE = cfg.serverUrl.replace(/\/$/, '');
  }
} catch (e) { /* تجاهل أي خطأ في القراءة والاستمرار بالقيمة الافتراضية */ }
// نفس الملفات اللي بتتحدّث فعلياً من الواجهة (بدون الأيقونات والـ manifest
// الثابتة اللي نادراً ما تتغيّر) — بنجيبها من السيرفر الحيّ في كل تشغيل عنده
// نت، ونكتبها فوق النسخة المحلية في مجلد بيانات المستخدم (مش داخل مجلد
// التثبيت نفسه، عشان الكتابة تكون مسموحة من غير صلاحيات Admin).
const SYNCED_FILES = [
  'app.html', 'styles.css', 'sw.js',
  'js/core-utils.js', 'js/storage-sync.js', 'js/auth-licensing.js',
  'js/ui-framework.js', 'js/module-clients.js', 'js/module-invoices.js',
  'js/module-bags.js', 'js/module-finance.js', 'js/module-reports.js',
  'js/module-accounting.js', 'js/module-companies.js', 'js/module-purchases.js',
  'js/module-zatca.js', 'js/boot.js'
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
  checkForFrontendUpdate().catch(() => {}); // في الخلفية، لا يوقف فتح البرنامج
}

async function checkForFrontendUpdate() {
  for (const file of SYNCED_FILES) {
    try {
      const remote = await fetchText(`${REMOTE_BASE}/${file}`);
      // نتأكد إن السيرفر رجّع فعلاً ملف مش صفحة خطأ فاضية قبل ما نكتب فوق النسخة المحلية.
      if (remote && remote.length > 20) {
        const destPath = path.join(userAssetsDir, file);
        // نخلق المجلد الأب تلقائياً (مهم لملفات js/*)
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, remote, 'utf8');
      }
    } catch (e) { /* بدون نت أو السيرفر نايم — نتجاهل ونكمل بالنسخة المحلية */ }
  }
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

    srv.use(express.static(userAssetsDir));
    srv.use(express.static(path.join(__dirname, 'app-assets')));
    const listener = srv.listen(PORT, '127.0.0.1', () => resolve());
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
      // مبقاش لازم webSecurity:false: كل طلبات /api بقت بتروح لنفس أصل الصفحة
      // (127.0.0.1) عبر البروكسي المحلي في startLocalServer، فمفيش أصل مختلف
      // يستدعي تعطيل فحص الأمان في المتصفح المدمج أصلاً.
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/app.html`);
  // أدوات المطوّر تُفتح فقط عند التشغيل بمتغيّر البيئة FTC2_DEBUG=1 (لتشخيص مشكلة
  // لاحقاً)، مش تلقائياً مع كل تشغيل عادي للمستخدم النهائي.
  if (process.env.FTC2_DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'right' });
  }

  // أي رابط خارجي (لو موجود) يفتح في المتصفح الافتراضي بدل نافذة التطبيق
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
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
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
