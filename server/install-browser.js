/* تثبيت متصفح Chromium الخاص بـ Playwright داخل node_modules المحلي
   بحيث يعيش مع الكود عند النشر (مهم جداً على Render: كاش /opt/render
   خارج الصورة وممكن يتضح). يُشغَّل تلقائياً بعد أي npm install.
   لو فشل التنزيل على آلة البناء (شبكة/ذاكرة) لا نفشل التثبيت كاملاً —
   السيرفر يعيد التنزيل تلقائياً عند أول جلب (راجع arkkan-fetch.js). */
'use strict';
const { execSync } = require('child_process');
const path = require('path');

const browsersDir =
  process.env.ARKKAN_BROWSERS_PATH || path.join(__dirname, 'node_modules', '.local-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;

const run = cmd => execSync(cmd, { stdio: 'inherit', env: process.env });
const delayCmd = process.platform === 'win32' ? null : 'sleep 5';

/* إعادة محاولة التنزيل — التنزيلات على آلات البناء قد تفشل مرة عابرة (شبكة/وقت) */
function withRetries(fn, times) {
  for (let i = 1; i <= times; i++) {
    try { fn(); return true; }
    catch (e) {
      console.warn(`[install-browser] محاولة ${i}/${times} لتنزيل Chromium فشلت: ${(e.message || '').slice(0, 300)}`);
      if (i < times && delayCmd) execSync(delayCmd, { stdio: 'ignore' });
    }
  }
  return false;
}

const installed = withRetries(() => run('npx playwright install chromium'), 3);
if (process.platform === 'linux') {
  try {
    run('npx playwright install-deps chromium');
  } catch (e) {
    console.warn('[install-browser] تعذّر تثبيت تبعيات النظام الآن (سيُحاول عند التشغيل):', e.message);
  }
}
if (installed) {
  console.log(`[install-browser] Chromium جاهز في ${browsersDir}`);
} else {
  console.warn('[install-browser] فشل تنزيل Chromium — سيُعاد تنزيله تلقائياً عند أول جلب لأركان (لا نوقف النشر)');
}