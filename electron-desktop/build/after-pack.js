// يُنفَّذ بعد تجميع التطبيق وقبل بناء المثبّت: يحقن لوجو المركز (build/icon.ico) داخل الـ exe نفسه.
// ضروري لأن "signAndEditExecutable": false في الإعدادات يمنع electron-builder من تعديل الـ exe،
// فكانت اختصارات سطح المكتب/شريط المهام تظهر بأيقونة Electron الافتراضية (الذرّة).
// نستخدم rcedit مباشرة (لا يحتاج winCodeSign ولا صلاحيات مسؤول). الحزمة ESM فنستوردها ديناميكياً.
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { rcedit } = await import('rcedit');
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icon = path.join(__dirname, 'icon.ico');
  await rcedit(exe, { icon });
  console.log('  • afterPack: تم تعيين أيقونة المركز على', path.basename(exe));
};
