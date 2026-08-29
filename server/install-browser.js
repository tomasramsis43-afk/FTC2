/* تثبيت متصفح Chromium الخاص بـ Playwright داخل node_modules المحلي
   بحيث يعيش مع الكود عند النشر (مهم جداً على Render: كاش /opt/render
   خارج الصورة وممكن يتضح). يُشغَّل تلقائياً بعد أي npm install. */
'use strict';
const { execSync } = require('child_process');
const path = require('path');

const browsersDir =
  process.env.ARKKAN_BROWSERS_PATH || path.join(__dirname, 'node_modules', '.local-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;

const run = cmd => execSync(cmd, { stdio: 'inherit', env: process.env });

try {
  run('npx playwright install chromium');
  if (process.platform === 'linux') {
    try {
      run('npx playwright install-deps chromium');
    } catch (e) {
      console.warn('[install-browser] تعذّر تثبيت تبعيات النظام الآن (سيُحاول عند التشغيل):', e.message);
    }
  }
  console.log(`[install-browser] Chromium جاهز في ${browsersDir}`);
} catch (e) {
  console.error('[install-browser] فشل تثبيت Chromium:', e.message);
  process.exitCode = 1;
}