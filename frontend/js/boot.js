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
