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
      // نتأكد إن السيرفر رجّع فعلاً ملف مش صفحة خطأ فاضية قبل ما نكتب فوق النسخة المحلية
      if (remote && remote.length > 20) {
        let content = remote;
        if (file === 'app-inline.js') {
          // نسخة السيرفر فيها API_BASE = '' (لأنها بتتقدَّم من نفس عنوان
          // الـ API على Render). هنا بنعيد ضبطها للعنوان الكامل، لأن الاتصال
          // بيتم مباشرة من نافذة Electron (وليس عبر وسيط) — أنظر webSecurity: false.
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
// (منفصل تماماً عن كروم)، فمسح كاش المتصفح لا يمسها أبداً. الاتصال بالـ API
// نفسه بيتم مباشرة من النافذة (مش عبر هذا الخادم) — أنظر webSecurity: false
// في createWindow لتفادي رفض المتصفح للطلب لاختلاف الأصل (CORS).
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const srv = express();
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
      // بيسمح بطلبات fetch من صفحة محلية (http://127.0.0.1) لسيرفر بعيد
      // بأصل مختلف (Render) بدون رفض من سياسة CORS في المتصفح المدمج —
      // آمن هنا لأن التطبيق ده مصمَّم يفتح صفحة واحدة ثابتة معروفة بس،
      // مش متصفح عام يتصفح فيه مواقع غير موثوقة.
      webSecurity: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/app.html`);
  mainWindow.webContents.openDevTools({ mode: 'right' }); // تشخيص مؤقت — هيتشال بعد حل المشكلة

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
