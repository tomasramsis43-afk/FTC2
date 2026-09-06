// FTC2 — تحميل منطق صلاحية التثقيف الصحي وقواعد دورة الحقيبة.
// يتم التحميل ديناميكياً حتى لا نغيّر ترتيب وحدات النظام الحالية أو نكسر الإقلاع.
(function loadBusinessRuleModules(){
  try{
    const ver = (window.CACHE_VERSION || '12');
    ['health-education-validity.js','health-education-ui.js','bag-workflow.js'].forEach(file=>{
      const s = document.createElement('script');
      s.src = 'js/' + file + '?v=' + ver;
      s.defer = false;
      s.async = false;
      s.onerror = ()=> console.error('[BusinessRules] Failed to load:', file);
      document.head.appendChild(s);
    });
    // إصلاح: زر مسح الفلاتر في empty-state كان inline onclick (يكسر CSP)
    setTimeout(()=>{
      const btn = document.getElementById('btn-clear-filters-empty');
      if(btn) btn.addEventListener('click', ()=>{
        const b=document.getElementById('btn-clear-all-filters');
        if(b) b.click();
      });
    }, 500);
  }catch(e){ console.error('[BusinessRules] Failed to load modules:', e); }
})();

// دخول بمسح الكود (QR، زي واتساب ويب): لو فُتح هذا الرابط من مسح كود QR ظاهر على جهاز آخر
// (شاشة الدخول تولّد رابطاً يحتوي على qrLoginSession=...)، نحفظ معرّف الجلسة فوراً قبل أي شيء
// آخر، ونزيله من شريط العنوان. لاحقاً — بعد أي تسجيل دخول ناجح على هذا الجهاز (بأي طريقة: كلمة
// مرور، بصمة، رابط إيميل، أو جلسة محفوظة بالفعل) — نعرض تأكيداً بسيطاً لربط الجهاز الآخر بنفس
// الحساب (راجع checkPendingQrLoginApproval فى module-purchases.js).
(function(){
  try{
    const params = new URLSearchParams(window.location.search);
    const qrSession = params.get('qrLoginSession');
    if(qrSession){
      sessionStorage.setItem('pendingQrLoginSession', qrSession);
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    }
  }catch(e){ console.error('[QR Login] Failed to capture qrLoginSession param:', e); }
})();

(async function bootWithLicense(){
  try{
    if(!(window.crypto && window.crypto.subtle)){
      // بيئة لا تدعم Web Crypto — غالباً لأن الرابط HTTP وليس HTTPS.
      // نعرض تحذيراً صريحاً وثابتاً في أعلى الشاشة حتى لا يخفى على المستخدم،
      // ونكمل التشغيل بدون تشفير (بيانات تُرسل/تُخزَّن كنص عادي).
      const warn = document.createElement('div');
      warn.id = 'http-warning-banner';
      warn.style.cssText = [
        'position:fixed','top:0','left:0','right:0','z-index:99999',
        'background:#b91c1c','color:#fff','padding:10px 20px',
        'text-align:center','font-size:13px','font-weight:700',
        'letter-spacing:.2px','box-shadow:0 2px 8px rgba(0,0,0,.4)',
        'font-family:inherit',
      ].join(';');
      warn.textContent = '⚠️ تحذير أمني: البرنامج يعمل عبر HTTP غير آمن — بياناتك لن تُشفَّر. استخدم رابط HTTPS دائماً لحماية البيانات.';
      document.body.prepend(warn);
      $('#license-screen').style.display = 'none';
      await ensureServerLoginThenStart();
      return;
    }
    const storedKey = localStorage.getItem(LICENSE_STORAGE_KEY);
    if(storedKey){
      const result = await validateLicenseKey(storedKey);
      if(result.valid){
        await activateAndStart(result.encKeyRaw, result.expiryDate, result.clientId);
        return;
      }
      // تعذّر الوصول للسيرفر (مش رفض صريح للكود): نحاول تشغيل البرنامج بآخر تفعيل
      // ناجح محفوظ محلياً على هذا الجهاز، بدل حجب البرنامج بالكامل لمجرد انقطاع
      // الإنترنت. لو الترخيص المحفوظ منتهي فعلياً حسب آخر تاريخ انتهاء معروف، أو
      // مفيش أي تفعيل سابق محفوظ، تظهر شاشة الترخيص كالمعتاد.
      if(result.networkError){
        try{
          const cachedRaw = localStorage.getItem(LICENSE_CACHE_KEY);
          if(cachedRaw){
            const cached = JSON.parse(cachedRaw);
            const cachedExpiry = cached.expiryDate ? new Date(cached.expiryDate) : null;
            if(cached.encKeyRaw && (!cachedExpiry || new Date() <= cachedExpiry)){
              await activateAndStart(cached.encKeyRaw, cachedExpiry, cached.clientId);
              showToast('تعذّر الاتصال بالسيرفر — تم تشغيل البرنامج بآخر ترخيص مُفعَّل محفوظ على هذا الجهاز (وضع عدم اتصال)');
              return;
            }
          }
        }catch(e){ console.error('[Boot] Failed to activate cached license:', e); }
      }
      showLicenseScreen(result.reason);
      return;
    }
    showLicenseScreen(null);
  }catch(e){
    showLicenseScreen('حدث خطأ غير متوقع أثناء التحقق من الترخيص');
  }
})();

/* ---------------- Login / Logout
   نُقل هذا القسم من module-finance.js — منطق تسجيل خروج/دخول عام على مستوى
   التطبيق كله (لا علاقة له بالخزنة/المحاسبة)، ومكانه الطبيعي هنا مع باقي
   منطق الإقلاع (boot). لا تغيير فى أي منطق، نقل فقط.
   تم حذف شاشة تسجيل الدخول المحلي داخل البرنامج بناءً على طلب المستخدم.
   الدخول الآن يتم فقط عبر شاشة السيرفر المركزي (server-login-screen)، وصلاحيات المستخدم
   (admin/staff) تُشتق مباشرة من هوية المستخدم الذي سجّل دخوله فعليًا على الخادم (SERVER_AUTH_USERNAME/
   SERVER_AUTH_ROLE)، وليس من أول مستخدم في قائمة "المستخدمين" الداخلية للبرنامج. */
function autoSignInLocalUser(){
  $('#current-user-label').textContent = currentUser;
  applyRolePermissions();
}
$('#btn-lang-toggle').addEventListener('click', ()=>{
  applyLanguage(currentLang==='ar' ? 'en' : 'ar');
});
$('#btn-logout').addEventListener('click', async ()=>{
  const btn = $('#btn-logout');
  if(btn) btn.disabled = true;
  try{
    var chk = {allSynced:true};
    try{ if(typeof verifyAllDataUploadedBeforeLogout==='function') chk = await verifyAllDataUploadedBeforeLogout(); }catch(e){ chk={allSynced:true}; }
    if(!chk.allSynced){
      var msg = 'لا تزال هناك بيانات غير مرفوعة للسيرفر';
      if(chk.offline) msg += ' (أنت في وضع عدم الاتصال)';
      else msg += ` (معلّق: kv=${chk.kvPending||0} / سجلات=${chk.recPending||0})`;
      msg += ' — هل تريد تسجيل الخروج الآن على مسؤوليتك؟ قد تُفقد البيانات غير المتزامنة.';
      if(!await customConfirm(msg)) return;
    }
    try{
      if(SERVER_AUTH_TOKEN){
        await fetch(API_BASE + '/api/auth/logout', {method:'POST', headers:{Authorization:'Bearer '+SERVER_AUTH_TOKEN}});
      }
    }catch(e){ console.error('[Logout] server logout failed:', e); }
    SERVER_AUTH_TOKEN = null;
    SERVER_AUTH_USERNAME = null;
    SERVER_AUTH_ROLE = null;
    try{ sessionStorage.removeItem('serverAuthToken'); }catch(e){}
    try{ sessionStorage.removeItem('serverAuthUsername'); }catch(e){}
    try{ sessionStorage.removeItem('serverAuthRole'); }catch(e){}
    try{ sessionStorage.removeItem('pendingQrLoginSession'); }catch(e){}
    try{ if(typeof disconnectRealtimeEvents==='function') disconnectRealtimeEvents(); }catch(e){}
    try{ if(typeof setManualOfflineMode==='function') setManualOfflineMode(false); }catch(e){}
    showServerLoginScreen(null);
    showToast('تم تسجيل الخروج');
  }finally{
    if(btn) btn.disabled = false;
  }
});
