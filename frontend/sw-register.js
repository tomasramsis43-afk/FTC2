// تسجيل Service Worker: يتيح تثبيت البرنامج كتطبيق على الجهاز، ويخدم كطبقة إضافية
// للعمل بدون اتصال (بجانب التخزين المحلي لبيانات العملاء نفسها في IndexedDB).
if('serviceWorker' in navigator){
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
}
