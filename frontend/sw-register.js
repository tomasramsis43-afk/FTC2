// تسجيل Service Worker: يتيح تثبيت البرنامج كتطبيق على الجهاز، ويخدم كطبقة إضافية
// للعمل بدون اتصال (بجانب التخزين المحلي لبيانات العملاء نفسها في IndexedDB).
//
// ⚠️ استثناء نسخة Electron عمداً: تطبيق سطح المكتب عنده أصلاً نظامه الخاص لتحديث
// ملفات الواجهة (SYNCED_FILES في main.js يسحب أحدث نسخة من كل ملف من السيرفر الحي
// عند كل تشغيل، ويكتبها في مجلد بيانات المستخدم قبل تشغيل الخادم المحلي). تسجيل
// Service Worker فوق هذا النظام يخلق طبقة كاش ثانية مستقلة تماماً (Cache Storage
// الخاص بالمتصفح) بمنطق تحديث مختلف (stale-while-revalidate + رقم إصدار CACHE_VERSION)،
// فيتسبب أحياناً في تقديم نسخة قديمة من JS/CSS حتى بعد نجاح main.js في تنزيل
// النسخة الجديدة فعلياً — وهذا التعارض الصامت بين النظامين هو الاشتباه الأقرب لأسباب
// أعطال متقطعة سابقة في نسخة سطح المكتب (اختفاء أيقونات، أزرار بلا وظيفة) رغم
// وصول الكود الصحيح فعلياً للجهاز. النسخة العادية (متصفح/PWA) تحتاج الـ Service
// Worker فعلاً (تثبيت كتطبيق + عمل بدون اتصال)، فيبقى مفعّلاً هناك بلا تغيير.
const isElectronApp = /Electron/i.test(navigator.userAgent || '');
if(!isElectronApp && 'serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
    // عند تفعيل نسخة جديدة من الـ Service Worker (بعد نشر تحديث للكود) تُعاد تحميل الصفحة
    // تلقائياً مرة واحدة، حتى يحصل المستخدم على أحدث إصدار فوراً بدل بقائه جالساً على نسخة
    // قديمة من الملفات المحمّلة مسبقاً حتى يغلق المتصفح ويعيد فتحه — خاصة أن استراتيجية
    // التخزين هنا Network-First للـ JS/CSS/HTML (تحديثاتها تصل فورياً). حارس refreshing يمنع
    // أي إعادة تحميل مزدوجة لو تكرر الحدث.
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', ()=>{
      if(refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
} else if(isElectronApp && 'serviceWorker' in navigator){
  // احتياط: لو أي نسخة سابقة من التطبيق كانت سجّلت Service Worker فعلاً على هذا
  // الجهاز قبل هذا الإصلاح، نلغي تسجيله الآن حتى لا يستمر في التعارض مع نظام
  // تحديث main.js في التشغيلات القادمة.
  navigator.serviceWorker.getRegistrations().then(regs=>{
    regs.forEach(r=> r.unregister().catch(()=>{}));
  }).catch(()=>{});
}
