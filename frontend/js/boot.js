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
              showToast('⚠️ تعذّر الاتصال بالسيرفر — تم تشغيل البرنامج بآخر ترخيص مُفعَّل محفوظ على هذا الجهاز (وضع عدم اتصال)');
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

/* ---------------- Login / Logout ----------------
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
$('#btn-theme-toggle').addEventListener('click', async ()=>{
  settings.darkMode = !settings.darkMode;
  // الثيمات المتعددة أُلغيت — هوية واحدة "نبض" فقط، فالزر يبدّل الوضع
  // الليلي/النهاري دائماً بلا أي شرط.
  applyTheme(settings.darkMode);
  await saveSettings();
});
$('#btn-sound-toggle').addEventListener('click', async ()=>{
  settings.soundEnabled = !settings.soundEnabled;
  applySoundIcon();
  if(settings.soundEnabled) SoundFX.click();
  await saveSettings();
});
$('#btn-logout').addEventListener('click', async ()=>{
  if(await customConfirm('تأكيد تسجيل الخروج؟')){
    // التأكد من رفع كل البيانات قبل تسجيل الخروج: ننتظر اكتمال الحفظ الجاري، ونرفع أي
    // تعديلات معلّقة، ونتحقق ألا يتبقى شيء غير مرفوع. لو بقي شيء (انقطاع اتصال مثلاً)
    // نُعلم المستخدم ونترك له القرار — البيانات محفوظة على الجهاز وستُرفع تلقائياً لاحقاً.
    showAppLoadingOverlay();
    setAppLoadingOverlayText('جاري التأكد من رفع كل البيانات إلى السيرفر...');
    let verdict = null;
    try{ verdict = await verifyAllDataUploadedBeforeLogout(); }catch(e){ console.error('[Finance] فشل فحص المزامنة قبل تسجيل الخروج', e); }
    hideAppLoadingOverlay();
    if(verdict && !verdict.allSynced){
      const count = (verdict.kvPending||0) + (verdict.recPending||0);
      const offlineMsg = verdict.offline ? ' (لا يوجد اتصال بالسيرفر حالياً)' : '';
      const inFlightMsg = verdict.stillInFlight ? ' (هناك حفظ جارٍ لم يكتمل)' : '';
      const warnMsg = 'لا تزال هناك بيانات لم تُرفع إلى السيرفر بعد' + offlineMsg + inFlightMsg +
        (count > 0 ? ' — عدد التعديلات المعلّقة: ' + count : '') + '.' +
        '\n\nهذه البيانات محفوظة على هذا الجهاز وستُرفع تلقائياً عند عودة الاتصال أو تسجيل الدخول من جديد — لكنها لن تكون متاحة من أجهزة أخرى حتى اكتمال الرفع.' +
        '\n\nهل تريد تسجيل الخروج الآن على أي حال؟';
      if(!await customConfirm(warnMsg, 'تعديلات لم تُرفع بعد')){
        return; // المستخدم اختار البقاء حتى اكتمال الرفع
      }
    }
    try{
      await fetch(API_BASE + '/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN },
      });
    }catch(e){ /* حتى لو فشل الاتصال، نكمّل تسجيل الخروج محلياً بالأسفل */ }
    try{ if(typeof disconnectRealtimeEvents==='function') disconnectRealtimeEvents(); }catch(e){ /* لا يمنع إكمال تسجيل الخروج */ }
    currentUser = null;
    currentUserRole = 'staff';
    SERVER_AUTH_TOKEN = null;
    SERVER_AUTH_USERNAME = null;
    SERVER_AUTH_ROLE = null;
    try{
      sessionStorage.removeItem('serverAuthToken');
      sessionStorage.removeItem('serverAuthUsername');
      sessionStorage.removeItem('serverAuthRole');
    }catch(e){ console.error('[Finance] Failed to clear session on logout:', e); }
    $('#app-wrap').style.display = 'none';
    showServerLoginScreen(null);
  }
});

