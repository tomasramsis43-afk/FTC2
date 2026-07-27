(async function bootWithLicense(){
  try{
    if(!(window.crypto && window.crypto.subtle)){
      // بيئة لا تدعم Web Crypto: نشغّل البرنامج بدون تشفير بدل تعطيله بالكامل
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
        }catch(e){}
      }
      showLicenseScreen(result.reason);
      return;
    }
    showLicenseScreen(null);
  }catch(e){
    showLicenseScreen('حدث خطأ غير متوقع أثناء التحقق من الترخيص');
  }
})();
