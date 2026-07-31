// تسجيل Service Worker: يتيح تثبيت البرنامج كتطبيق على الجهاز، ويخدم كطبقة إضافية
// للعمل بدون اتصال (بجانب التخزين المحلي لبيانات العملاء نفسها في IndexedDB).
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
  });
}
