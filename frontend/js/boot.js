// FTC2 — تحميل منطق صلاحية التثقيف الصحي وقواعد دورة الحقيبة.
(function loadBusinessRuleModules(){
  try{
    ['health-education-validity.js','health-education-ui.js','bag-workflow.js'].forEach(file=>{
      const s = document.createElement('script');
      s.src = 'js/' + file;
      s.defer = false;
      s.async = false;
      document.head.appendChild(s);
    });
  }catch(e){ console.error('[BusinessRules] Failed to load modules:', e); }
})();

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

(async function bootNoLicense(){
  try{
    if(!(window.crypto && window.crypto.subtle)){
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
      await ensureServerLoginThenStart();
      return;
    }
    let cachedIsDefault = false;
    let cachedRawTmp = null;
    try{
      cachedRawTmp = localStorage.getItem(LICENSE_CACHE_KEY);
      if(cachedRawTmp){
        const c = JSON.parse(cachedRawTmp);
        if(c.encKeyRaw){
          if(c.clientId === 'default'){
            cachedIsDefault = true;
          } else {
            const ce = c.expiryDate ? new Date(c.expiryDate) : null;
            await activateAndStart(c.encKeyRaw, ce, c.clientId);
            return;
          }
        }
      }
    }catch(e){}
    try{
      const storedKey = localStorage.getItem(LICENSE_STORAGE_KEY);
      if(storedKey){
        const result = await validateLicenseKey(storedKey);
        if(result.valid){
          await activateAndStart(result.encKeyRaw, result.expiryDate, result.clientId);
          return;
        }
      }
      if(cachedIsDefault && cachedRawTmp){
        const c2 = JSON.parse(cachedRawTmp);
        if(c2.encKeyRaw){
          const ce2 = c2.expiryDate ? new Date(c2.expiryDate) : null;
          await activateAndStart(c2.encKeyRaw, ce2, c2.clientId);
          return;
        }
      }
    }catch(e){}
    // لا يوجد ترخيص مخبأ — استخدم مفتاح افتراضي ثابت مشترك لكل الأجهزة
    // ملاحظة إصلاح حرِج (2026-08-24): القيمة السابقة هنا كانت تُفكّ Base64 إلى 48 بايت
    // (384 بت) — وهو طول غير صالح لمفتاح AES-GCM (يُقبَل فقط 128 أو 256 بت)، فكان
    // crypto.subtle.importKey يفشل دائماً بخطأ "AES key data must be 128 or 256 bits"
    // ويمنع أي مستخدم بلا ترخيص مخبّأ من فتح البرنامج إطلاقاً. القيمة الجديدة 32 بايت
    // بالضبط (256 بت) — ويجب أن تبقى مطابقة حرفياً لنفس القيمة في server/license.js.
    const DEFAULT_ENC_KEY_B64 = "4U4cwlyiJcdXGejnxpyOV+J+cJEyyUx3PTC2D8nIT2Q=";
    try{
      ENC_KEY = await crypto.subtle.importKey('raw', base64ToBytes(DEFAULT_ENC_KEY_B64), {name:'AES-GCM'}, false, ['encrypt','decrypt']);
    }catch(e){ console.error('[Boot] Failed to import default key:', e); ENC_KEY = null; }
    await ensureServerLoginThenStart();
  }catch(e){
    console.error('[Boot] fallback error:', e);
    try{ await ensureServerLoginThenStart(); }catch(e2){}
  }
})();

function autoSignInLocalUser(){
  $('#current-user-label').textContent = currentUser;
  applyRolePermissions();
}
$('#btn-lang-toggle').addEventListener('click', ()=>{
  applyLanguage(currentLang==='ar' ? 'en' : 'ar');
});
document.addEventListener('click', async (e)=>{
  const logoutBtn = e.target.closest('#btn-logout');
  if(!logoutBtn) return;
  e.preventDefault();
  const btn = logoutBtn;
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
document.addEventListener('click', async (e)=>{
  const tBtn = e.target.closest('#btn-theme-toggle');
  if(!tBtn) return;
  e.preventDefault();
  e.stopPropagation();
  try{
    if(typeof settings==='undefined' || typeof applyTheme==='undefined') return;
    settings.darkMode = !settings.darkMode;
    applyTheme(settings.darkMode);
    if(typeof saveSettings==='function') await saveSettings();
  }catch(err){ console.error('[Theme] toggle failed:', err); }
});
document.addEventListener('click', async (e)=>{
  const sBtn = e.target.closest('#btn-sound-toggle');
  if(!sBtn) return;
  e.preventDefault();
  e.stopPropagation();
  try{
    if(typeof settings==='undefined') return;
    settings.soundEnabled = !settings.soundEnabled;
    if(typeof applySoundIcon==='function') applySoundIcon();
    if(typeof saveSettings==='function') await saveSettings();
  }catch(err){ console.error('[Sound] toggle failed:', err); }
});
