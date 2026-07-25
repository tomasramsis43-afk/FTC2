const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');

const PORT = 17532;
const REMOTE_BASE = 'https://ftc-6d0s.onrender.com';
// نفس الملفات اللي بتتحدّث فعلياً من الواجهة (بدون الأيقونات والـ manifest
// الثابتة اللي نادراً ما تتغيّر) — بنجيبها من السيرفر الحيّ في كل تشغيل عنده
// نت، ونكتبها فوق النسخة المحلية في مجلد بيانات المستخدم (مش داخل مجلد
// التثبيت نفسه، عشان الكتابة تكون مسموحة من غير صلاحيات Admin).
const SYNCED_FILES = ['app.html', 'app-inline.js', 'styles.css', 'sw.js'];
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
async function prepareAssets() {
  userAssetsDir = path.join(app.getPath('userData'), 'app-assets');
  try { fs.mkdirSync(userAssetsDir, { recursive: true }); } catch (e) {}
  checkForFrontendUpdate().catch(() => {}); // في الخلفية، لا يوقف فتح البرنامج
}

async function checkForFrontendUpdate() {
  for (const file of SYNCED_FILES) {
    try {
      const remote = await fetchText(`${REMOTE_BASE}/${file}`);
      // نتأكد إن السيرفر رجّع فعلاً ملف مش صفحة خطأ فاضية قبل ما نكتب فوق النسخة المحلية
      if (remote && remote.length > 20) {
        let content = remote;
        if (file === 'app-inline.js') {
          // الملف القادم من السيرفر بيه API_BASE = '' (لأنه بيتقدَّم من نفس عنوان
          // الـ API على Render)، لكن هنا بيتقدَّم من خادم محلي، فلازم نعيد ضبط
          // العنوان الكامل بعد كل تحديث حتى لا تنقطع الاتصال بالسيرفر البعيد.
          content = content.replace(
            /const API_BASE = '[^']*';.*/,
            `const API_BASE = '${REMOTE_BASE}'; // تم ضبطه تلقائياً لتطبيق سطح المكتب`
          );
        }
        fs.writeFileSync(path.join(userAssetsDir, file), content, 'utf8');
      }
    } catch (e) { /* بدون نت أو السيرفر نايم — نتجاهل ونكمل بالنسخة المحلية */ }
  }
}

// خادم محلي صغير يقدّم ملفات الواجهة من داخل التطبيق — بهذا الشكل تفتح
// الواجهة فوراً حتى بدون إنترنت إطلاقاً. يبحث أولاً عن نسخة مُحدَّثة في
// مجلد بيانات المستخدم، ولو مش موجودة يرجع للنسخة الأصلية المرفقة مع الـ setup.
// وبيانات IndexedDB/localStorage تُخزَّن في مجلد بيانات التطبيق الخاص بويندوز
// (منفصل تماماً عن كروم)، فمسح كاش المتصفح لا يمسها أبداً.
function startLocalServer() {
  return new Promise((resolve) => {
    const srv = express();
    srv.use(express.static(userAssetsDir));
    srv.use(express.static(path.join(__dirname, 'app-assets')));
    srv.listen(PORT, '127.0.0.1', () => resolve());
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
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/app.html`);

  // أي رابط خارجي (لو موجود) يفتح في المتصفح الافتراضي بدل نافذة التطبيق
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  Menu.setApplicationMenu(null); // شريط قوائم نظيف بدون عناصر Electron الافتراضية
}

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
