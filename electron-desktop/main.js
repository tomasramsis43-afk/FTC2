// ═══════════════════════════════════════════════════════════════════════════════
//  FTC2 — Bootstrapper (المُقلع)
// ═══════════════════════════════════════════════════════════════════════════════
// هذا الملف هو نقطة الدخول الوحيدة الثابتة داخل التطبيق (باقي الحزمة). دوره
// الوحيد: جلب أحدث نسخة من «المتحكم» (app-main.js) من الريبو، وعند تغيّرها
// إعادة تشغيل التطبيق تلقائياً مرة واحدة ليعمل بها — ثم تشغيل المتحكم الأحدث.
//
// النتيجة: أي تعديل على منطق سطح المكتب (الخادم المحلي، إدارة وكيل أركان،
// النافذة...) يحصل عليه كل الأجهزة المثبَّتة تلقائياً عند فتح البرنامج، **بدون
// إعادة بناء/تنزيل نسخة exe جديدة** — تماماً مثل آلية SYNCED_FILES للواجهة، لكن
// على مستوى «كود البناء» نفسه. (في وضع التطوير نستخدم المتحكم المحلي بجانب
// main.js مباشرة حتى تنعكس تعديلات المطوّر فوراً.)
//
// لا تُضِف أي منطق أعمال هنا — يبقى هذا الملف نحيفاً وثابتاً في الحزمة،
// وكل التعديلات المستقبلية تذهب إلى app-main.js فقط.
// ═══════════════════════════════════════════════════════════════════════════════

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const BUNDLE_DIR = __dirname;

// مسار المتحكم الحيّ في الريبو — هنا تُجرى كل تعديلات منطق سطح المكتب، فيصل
// أي تحديث تلقائياً لأجهزة العملاء عند فتح التطبيق دون تثبيت نسخة جديدة.
const CONTROLLER_REMOTE_RAW = 'https://raw.githubusercontent.com/tomasramsis43-afk/FTC2/main/electron-desktop/app-main.js';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

// نسخ المتحكم المحلي المُحتملة بالترتيب: المحمَّل في مجلد بيانات المستخدم
// (المحدَّث تلقائياً) ثم المرفق مع الحزمة (احتياط لو مفيش إنترنت).
function findController() {
  const candidates = [
    path.join(app.getPath('userData'), 'app-main.js'),
    path.join(BUNDLE_DIR, 'app-main.js')
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return null;
}

// حقن مجلدات الحزمة/المشروع في المتحكم حتى يعرف مواضع الأصول الثابتة
// (app-assets، config.json...) حتى لو اشتغل من مجلد بيانات المستخدم بعد
// تحديثه تلقائياً من الريبو.
process.env.FTC2_BUNDLE_DIR = BUNDLE_DIR;
process.env.FTC2_PROJECT_DIR = path.join(BUNDLE_DIR, '..'); // جذر المشروع (وضع التطوير)

const userController = path.join(app.getPath('userData'), 'app-main.js');
let launched = false;

async function bootstrap() {
  // في وضع التطوير (electron . بدون حزمة) نستخدم مباشرة المتحكم المحلي بجانب
  // main.js حتى تنعكس تعديلات المطوّر فوراً — ونُفعّل التحديث التلقائي من الريبو
  // فقط في النسخ المثبَّتة (app.isPackaged) التي يحتاج مستخدموها الفعليون إليها.
  if (!app.isPackaged) {
    const devPath = path.join(BUNDLE_DIR, 'app-main.js');
    if (fs.existsSync(devPath)) {
      launched = true;
      require(devPath);
    } else {
      console.error('[FTC2] app-main.js غير موجود بجانب main.js (وضع التطوير)');
      app.quit();
    }
    return;
  }

  // 1) النسخ المثبتة: تحديث المتحكم من الريبو (لو فيه إنترنت) + نسخة احتياطية.
  try {
    const remote = await fetchText(CONTROLLER_REMOTE_RAW);
    if (remote && remote.length > 300 && remote.includes('startLocalServer')) {
      fs.mkdirSync(path.dirname(userController), { recursive: true });
      const existing = fs.existsSync(userController) ? fs.readFileSync(userController, 'utf8') : '';
      if (existing !== remote) {
        fs.writeFileSync(userController, remote, 'utf8');
        console.log('[FTC2] المتحكم حُدِّث — إعادة تشغيل تلقائي لتطبيقه');
        app.relaunch();
        app.exit(0);
        return;
      }
    }
  } catch (e) {
    // بدون إنترنت — نكمل بالنسخة المحلية الموجودة.
  }

  // 2) تشغيل المتحكم (المحدَّث من userData أو المرفق مع الحزمة).
  if (launched) return;
  const controllerPath = findController();
  if (!controllerPath) {
    console.error('[FTC2] app-main.js غير موجود مع البرنامج — أعد تثبيت البرنامج');
    app.quit();
    return;
  }
  launched = true;
  try {
    require(controllerPath);
  } catch (e) {
    console.error('[FTC2] فشل تشغيل المتحكم:', e);
    app.quit();
  }
}

app.whenReady().then(bootstrap);