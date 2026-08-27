/* ============================================================
   نبض — First Run Wizard (معالج الترحيب) — Phase 6
   ------------------------------------------------------------
   يظهر مرة واحدة فقط للتركيبات الجديدة (لا عملاء بعد). يكتب في
   كائن settings القائم ويحفظ عبر saveSettings() الرسمية — لا مسار
   حفظ جديد. المستخدم الحالي ببياناته لا يراه إطلاقاً.
   ============================================================ */
(function(){
  'use strict';
  const FLAG = 'nabd-onboarded';
  let step = 0;
  let shown = false;

  function alreadyDone(){
    try { return localStorage.getItem(FLAG) === '1'; } catch(e){ return false; }
  }
  function markDone(){
    try { localStorage.setItem(FLAG, '1'); } catch(e){}
  }

  function openWizard(){
    if(shown) return;
    shown = true;
    const ov = document.getElementById('onboarding-overlay');
    if(!ov) return;
    if(typeof settings === 'undefined' || settings === null) settings = {};
    if(!settings.centerInfo) settings.centerInfo = {};
    const ci = settings.centerInfo;
    document.getElementById('ob-name').value = ci.name || '';
    document.getElementById('ob-tax').value = ci.taxNumber || '';
    document.getElementById('ob-phone').value = ci.phone || '';
    document.getElementById('ob-bagprice').value = settings.bagPrice ?? '';
    document.getElementById('ob-threshold').value = settings.lowBalanceThreshold ?? 5000;
    goStep(0);
    ov.classList.add('show');
  }
  function closeWizard(){ document.getElementById('onboarding-overlay')?.classList.remove('show'); }

  function goStep(n){
    step = n;
    document.querySelectorAll('.ob-step').forEach((el, i) => el.style.display = i === n ? '' : 'none');
    document.querySelectorAll('.ob-dot').forEach((el, i) => el.classList.toggle('active', i === n));
    const back = document.getElementById('ob-back');
    if(back) back.style.display = n > 0 ? '' : 'none';
    const next = document.getElementById('ob-next');
    const save = document.getElementById('ob-save');
    if(next) next.style.display = n < 2 ? '' : 'none';
    if(save) save.style.display = n === 2 ? '' : 'none';
  }

  async function finish(){
    try {
      if(typeof settings === 'undefined' || settings === null) settings = {};
      if(!settings.centerInfo) settings.centerInfo = {};
      const name = document.getElementById('ob-name').value.trim();
      const tax = document.getElementById('ob-tax').value.trim();
      const phone = document.getElementById('ob-phone').value.trim();
      if(name) settings.centerInfo.name = name;
      if(tax) settings.centerInfo.taxNumber = tax;
      if(phone) settings.centerInfo.phone = phone;
      const bp = num(document.getElementById('ob-bagprice').value);
      if(bp > 0) settings.bagPrice = bp;
      const th = num(document.getElementById('ob-threshold').value);
      if(th >= 0) settings.lowBalanceThreshold = th;
      await saveSettings();
      await logAudit('edit', 'الإعدادات', 'تهيئة أولية للنظام عبر معالج الترحيب');
      if(typeof showToast === 'function') showToast('تمت تهيئة النظام — أهلاً بك في نبض!');
      if(typeof renderCfoDashboard === 'function' && typeof isViewActive === 'function' && isViewActive('dashboard')) renderCfoDashboard();
      if(typeof renderSmartAlerts === 'function') renderSmartAlerts();
    } catch(e) {}
    markDone();
    closeWizard();
  }

  function maybeShowOnce(){
    if(shown) return;
    if(!Array.isArray(clients)) { setTimeout(maybeShowOnce, 1500); return; }
    if(clients.length === 0){ openWizard(); return; }
    markDone(); // تركيب قائم ببيانات — لا معالج، ولا يظهر مستقبلاً
  }

  /* نرتكز على أول renderDashboard بعد تحميل البيانات (أو مهلة احتياطية) */
  if(typeof window.renderDashboard === 'function'){
    const orig = window.renderDashboard;
    window.renderDashboard = function(){
      const r = orig.apply(this, arguments);
      requestAnimationFrame(maybeShowOnce);
      window.renderDashboard = orig; /* مرة واحدة تكفي ثم نفك اللف */
      return r;
    };
  } else {
    setTimeout(maybeShowOnce, 3000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('ob-next')?.addEventListener('click', () => goStep(step + 1));
    document.getElementById('ob-back')?.addEventListener('click', () => goStep(Math.max(0, step - 1)));
    document.getElementById('ob-save')?.addEventListener('click', finish);
    document.getElementById('ob-skip')?.addEventListener('click', () => { markDone(); closeWizard(); });
    document.getElementById('onboarding-overlay')?.addEventListener('click', e => {
      if(e.target.id === 'onboarding-overlay'){ markDone(); closeWizard(); }
    });
  });
})();