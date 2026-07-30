// ---------------- طابور "تعديلات بانتظار الرفع" (يعمل فقط أثناء انقطاع الاتصال بالسيرفر) ----------------
// كل مفتاح (clients, vaultTx, settings...) له قيد واحد فقط بالطابور (آخر نسخة غير مرفوعة له)، لأن
// المطلوب هو حفظ آخر تعديل محلياً وليس سجل تاريخي لكل تعديل بينما التطبيق نفسه لا يزال مفتوحاً بلا اتصال.
async function _pendingWrite(key, encryptedValue){
  try{
    const db = await _openKvIdb();
    if(!db) return;
    await new Promise((resolve)=>{
      try{
        const tx = db.transaction(KV_IDB_PENDING_STORE, 'readwrite');
        tx.objectStore(KV_IDB_PENDING_STORE).put({ key, value: encryptedValue, queuedAt: Date.now() });
        tx.oncomplete = ()=> resolve();
        tx.onerror = ()=> resolve();
      }catch(e){ resolve(); }
    });
  }catch(e){ console.error('[StorageSync] _pendingWrite failed:', e); }
}
async function _pendingDelete(key){
  try{
    const db = await _openKvIdb();
    if(!db) return;
    await new Promise((resolve)=>{
      try{
        const tx = db.transaction(KV_IDB_PENDING_STORE, 'readwrite');
        tx.objectStore(KV_IDB_PENDING_STORE).delete(key);
        tx.oncomplete = ()=> resolve();
        tx.onerror = ()=> resolve();
      }catch(e){ resolve(); }
    });
  }catch(e){ console.error('[StorageSync] _pendingDelete failed:', e); }
}
async function _pendingReadAll(){
  try{
    const db = await _openKvIdb();
    if(!db) return [];
    return await new Promise((resolve)=>{
      try{
        const tx = db.transaction(KV_IDB_PENDING_STORE, 'readonly');
        const req = tx.objectStore(KV_IDB_PENDING_STORE).getAll();
        req.onsuccess = ()=> resolve(req.result || []);
        req.onerror = ()=> resolve([]);
      }catch(e){ resolve([]); }
    });
  }catch(e){ return []; }
}
async function _pendingCount(){
  try{ return (await _pendingReadAll()).length; }catch(e){ return 0; }
}

// ---------------- مؤشّر حالة الاتصال/المزامنة أعلى البرنامج ----------------
// isOffline: آخر حالة معروفة لاتصال السيرفر (وليس فقط navigator.onLine، لأنه قد يكون
// المتصفح متصل بشبكة محلية بينما السيرفر نفسه لا يستجيب — نعتمد نجاح/فشل الطلبات الفعلية).
let _ftcIsOffline = false;
// وضع "العمل من الجهاز فقط" — يُفعَّل يدوياً من المستخدم عبر زر في الإعدادات (بخلاف _ftcIsOffline
// أعلاه الذي يُكتشف تلقائياً من فشل الاتصال الفعلي). لما يكون مفعَّلاً، serverFetch يرفض الاتصال
// بالسيرفر عمداً من أول خطوة، فتعمل كل قراءة/كتابة عبر نفس مسار "بدون اتصال" الموجود أصلاً
// (قراءة من الكاش المحلي، وقائمة انتظار للتعديلات) دون أي تكرار للمنطق.
let manualOfflineMode = false;
try{ manualOfflineMode = localStorage.getItem('ftcManualOfflineMode') === '1'; }catch(e){ console.error('[StorageSync] Failed to read manualOfflineMode:', e); }
function setManualOfflineMode(on){
  manualOfflineMode = !!on;
  try{ localStorage.setItem('ftcManualOfflineMode', manualOfflineMode ? '1' : '0'); }catch(e){ console.error('[StorageSync] Failed to write manualOfflineMode:', e); }
  updateOfflineIndicator();
  if(!manualOfflineMode){
    // إعادة التفعيل: يبدأ فوراً برفع أي تعديلات تراكمت محلياً أثناء إيقاف الاتصال
    flushPendingWrites();
  }
}
function markOffline(){
  if(_ftcIsOffline) { updateOfflineIndicator(); return; }
  _ftcIsOffline = true;
  updateOfflineIndicator();
}
function markOnline(){
  if(!_ftcIsOffline){ updateOfflineIndicator(); return; }
  _ftcIsOffline = false;
  updateOfflineIndicator();
}
async function updateOfflineIndicator(){
  try{
    const el = document.getElementById('offline-status-indicator');
    if(!el) return;
    const count = await _pendingCount();
    if(manualOfflineMode){
      el.style.display = 'flex';
      el.style.background = '#4a3b1f';
      el.title = 'وضع العمل من الجهاز فقط مفعَّل يدوياً من الإعدادات — لا يتصل البرنامج بالسيرفر إطلاقاً، وأي تعديل يُحفظ محلياً فقط حتى تُعيد تفعيل الاتصال';
      el.innerHTML = '🔒 وضع محلي فقط (يدوي)' + (count ? ` — ${count} تعديل بانتظار الرفع لاحقاً` : '');
    } else if(_ftcIsOffline){
      el.style.display = 'flex';
      el.style.background = '#7a1f1f';
      el.title = 'لا يوجد اتصال بالسيرفر حالياً — البرنامج يعمل من آخر نسخة محفوظة على هذا الجهاز، وأي تعديل سيُحفظ محلياً ويُرفع تلقائياً عند عودة الاتصال';
      el.innerHTML = '⚠️ غير متصل' + (count ? ` (${count} بانتظار الرفع)` : '');
    } else if(count > 0){
      el.style.display = 'flex';
      el.style.background = '#7a5a1f';
      el.title = 'يوجد تعديلات محفوظة محلياً بانتظار رفعها للسيرفر — جارٍ المحاولة تلقائياً';
      el.innerHTML = `⏳ جارٍ رفع ${count} تعديل...`;
    } else {
      el.style.display = 'none';
    }
  }catch(e){ console.error('[StorageSync] updateOfflineIndicator error:', e); }
}
let _ftcSyncInFlight = false;
// ---------------- تثبيت البرنامج كتطبيق (PWA) على الجهاز ----------------
// يلتقط حدث beforeinstallprompt (مدعوم في Chrome/Edge/Android) ويُظهر زر "تثبيت البرنامج"
// في الشريط العلوي بدل الاعتماد على خيار مخفي داخل قائمة المتصفح قد لا ينتبه له المستخدم.
// على iOS/Safari (اللي مبيدعمش الحدث ده إطلاقاً) بيوضّح للمستخدم الطريقة اليدوية بدلاً من ذلك.
let _deferredInstallPrompt = null;
function isRunningAsInstalledApp(){
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}
window.addEventListener('beforeinstallprompt', e=>{
  e.preventDefault();
  _deferredInstallPrompt = e;
  if(!isRunningAsInstalledApp()){
    const btn = document.getElementById('btn-install-app');
    if(btn) btn.style.display = '';
  }
});
window.addEventListener('appinstalled', ()=>{
  _deferredInstallPrompt = null;
  const btn = document.getElementById('btn-install-app');
  if(btn) btn.style.display = 'none';
  showToast('تم تثبيت البرنامج على الجهاز بنجاح ✅ — هتلاقيه دلوقتي كأيقونة مستقلة زي أي برنامج تاني');
});
(function(){
  const btn = document.getElementById('btn-install-app');
  if(!btn) return;
  btn.addEventListener('click', async ()=>{
    if(_deferredInstallPrompt){
      _deferredInstallPrompt.prompt();
      const {outcome} = await _deferredInstallPrompt.userChoice;
      _deferredInstallPrompt = null;
      btn.style.display = 'none';
      if(outcome!=='accepted') showToast('تمام، تقدر تثبّته لاحقاً من نفس الزر لو غيّرت رأيك');
    }else{
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      showToast(isIOS
        ? 'لتثبيت البرنامج على آيفون/آيباد: من Safari اضغط زر المشاركة (⬆️) ثم "إضافة إلى الشاشة الرئيسية"'
        : 'المتصفح الحالي لسه بيجهّز خيار التثبيت — جرّب تاني بعد شوية، أو من قائمة المتصفح (⋮) اختر "تثبيت التطبيق"');
    }
  });
})();
// يحاول رفع كل التعديلات المعلّقة محلياً إلى السيرفر — يُستدعى عند استعادة الاتصال (حدث online)،
// وأيضاً بشكل دوري احتياطاً (بعض الأجهزة لا تُطلق حدث online بدقة، خصوصاً على الجوال).
async function flushPendingWrites(){
  if(_ftcSyncInFlight) return;
  const pending = await _pendingReadAll();
  if(!pending.length){ markOnline(); return; }
  _ftcSyncInFlight = true;
  try{
    for(const item of pending){
      try{
        const res = await serverFetch(`/api/storage/${encodeURIComponent(item.key)}`, {
          method: 'PUT',
          body: JSON.stringify({ value: item.value, version: _kvVersions[item.key] || 0 }),
        });
        if(res.status === 409){
          // تعارض حقيقي: عُدِّلت نفس البيانات من جهاز/جلسة أخرى أثناء انقطاعنا — لا نستطيع
          // حسم هذا تلقائياً بأمان، فنتخلى عن هذا التعديل المعلّق تحديداً وننبّه المستخدم
          // بدل تكرار محاولة فاشلة إلى ما لا نهاية، ونطلب منه مراجعة البيانات بعد تحديث الصفحة.
          const conflict = await res.json().catch(()=>({}));
          _kvVersions[item.key] = conflict.currentVersion || _kvVersions[item.key];
          await _pendingDelete(item.key);
          showToast(`⚠️ تعذّرت مزامنة تعديل محفوظ محلياً (${item.key}) بسبب تعديل آخر لنفس البيانات — يرجى تحديث الصفحة ومراجعتها`);
          continue;
        }
        if(!res.ok) continue; // السيرفر لا يزال غير متجاوب — نتركه في الطابور ونعيد المحاولة لاحقاً
        const data = await res.json();
        _kvVersions[item.key] = data.version || 0;
        await _kvCacheWrite(item.key, data.version || 0, item.value);
        await _pendingDelete(item.key);
      }catch(e){
        // لا يزال بدون اتصال — نوقف المحاولة لباقي العناصر هذه الجولة ونعيدها كلها لاحقاً
        markOffline();
        break;
      }
    }
  } finally {
    _ftcSyncInFlight = false;
    const remaining = await _pendingCount();
    if(remaining === 0) markOnline(); else updateOfflineIndicator();
  }
}
window.addEventListener('online', ()=>{ flushPendingWrites(); });
window.addEventListener('offline', ()=>{ markOffline(); });
// محاولة دورية احتياطية (كل 20 ثانية) بجانب حدث online، ولا تُكلّف شيئاً لو الطابور فارغ بالفعل
setInterval(()=>{ flushPendingWrites().catch(()=>{}); }, 20000);

async function serverFetch(path, options = {}) {
  if(manualOfflineMode){
    // وضع العمل من الجهاز فقط مفعَّل يدوياً — نرفض الاتصال بالسيرفر من أول خطوة، فتتعامل كل
    // دالة قراءة/كتابة في window.storage مع هذا الرفض تماماً كما تتعامل مع انقطاع اتصال حقيقي
    // (القراءة من الكاش المحلي، والكتابة في طابور الانتظار لحين إعادة تفعيل الاتصال).
    throw new Error('وضع العمل من الجهاز فقط مفعَّل — لا يوجد اتصال بالسيرفر');
  }
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(SERVER_AUTH_TOKEN ? { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    // انتهت الجلسة أو لم يسجَّل الدخول بعد — أعد عرض شاشة الدخول على الخادم
    SERVER_AUTH_TOKEN = null;
    try { sessionStorage.removeItem('serverAuthToken'); } catch (e) { console.error('[StorageSync] Failed to clear serverAuthToken:', e); }
    showServerLoginScreen('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً');
    throw new Error('غير مصرَّح — يرجى تسجيل الدخول');
  }
  return res;
}

// فك تشفير "غير قابل للتجاهل": لو فشل فك التشفير (مثال: هذا الجهاز مفتاح تشفيره غير جاهز
// أو خاطئ، بينما القيمة المخزَّنة على السيرفر مشفَّرة فعلاً بمفتاح جهاز آخر)، لا يجوز أبداً
// معاملة النتيجة كأنها "لا توجد بيانات" (null/[])، لأن هذه القيمة الفارغة تُستخدم لاحقاً
// كأساس لأي عملية حفظ تالية (مثال: إضافة عميل واحد) فتُكتب فوق كل بيانات السيرفر الحقيقية
// وتمحوها بالكامل لكل المستخدمين. لذلك نُلبِّس الخطأ علامة صريحة (isDecryptFailure) ونتركه
// يخرج من get() دون أي "catch" صامت يحوّله لقيمة فارغة — يجب أن يتعامل معه المستدعي
// (loadData) كخطأ قاتل يوقف تحميل البيانات بدل إسكاته.
async function _decryptOrFail(stored){
  try{
    return await decryptValue(stored);
  }catch(e){
    const err = new Error('تعذّر فك تشفير البيانات المحفوظة على السيرفر بهذا الجهاز: ' + (e && e.message ? e.message : String(e)));
    err.isDecryptFailure = true;
    throw err;
  }
}
window.storage = {
    // يجلب رقم النسخة الحالي فقط (بدون القيمة) ويحدّث _kvVersions محلياً — يُستخدم تحديداً
    // لمفتاح 'clients' القديم فى النظام الجديد (عملاء كسجلات مستقلة): بعد نجاح تحميل العملاء
    // بالكامل عبر client_records، لا يُستدعى window.storage.get('clients',...) إطلاقاً، فيبقى
    // _kvVersions['clients'] بدون تحديث (يفترض 0 افتراضياً) بينما القيمة الفعلية على السيرفر
    // (المتبقية من قبل الترحيل، أو من عمليات حفظ احتياطية سابقة عند انقطاع الاتصال) قد تكون
    // أكبر من صفر فعلاً — فأي حفظ احتياطي لاحق (خط الرجعة عند فشل الشبكة فى saveClients) كان
    // سيُرفض دائماً بخطأ 409 لأنه يرسل نسخة قديمة/خاطئة (صفر) رغم عدم وجود أي تعارض حقيقي.
    async primeKeyVersion(key){
      try{
        const res = await serverFetch(`/api/storage/${encodeURIComponent(key)}?meta=1`);
        if(!res.ok) return;
        const data = await res.json();
        _kvVersions[key] = data.version || 0;
      }catch(e){ /* بدون اتصال — لا داعي لأي إجراء، ستُحدَّث لاحقاً عند أول محاولة حفظ فعلية */ }
    },
    async get(key, shared, cacheOnly){
      const cached = await _kvCacheRead(key);
      if(cacheOnly){
        // وضع "من الجهاز فقط" — بدون أي اتصال بالسيرفر، لعرض آخر نسخة محفوظة محلياً فوراً
        // عند فتح البرنامج دون انتظار الشبكة. المزامنة الفعلية مع السحابة تحدث بعد ذلك
        // في الخلفية عبر backgroundSyncCheck() دون تجميد الواجهة.
        if(!cached) return null;
        _kvVersions[key] = cached.version;
        if(cached.value === null || cached.value === undefined) return null;
        const value = await _decryptOrFail(cached.value);
        return { key, value, shared: !!shared };
      }
      let res;
      try{
        const headers = cached ? { 'If-None-Match': String(cached.version) } : {};
        res = await serverFetch(`/api/storage/${encodeURIComponent(key)}`, { headers });
      }catch(e){
        // فشل اتصال فعلي بالسيرفر تماماً (بدون إنترنت غالباً) — نعمل بآخر نسخة محفوظة محلياً
        // بدل تفريغ الشاشة، حتى يبقى البرنامج قابلاً للاستخدام (قراءة على الأقل) بدون نت.
        markOffline();
        if(cached){
          if(cached.value === null || cached.value === undefined) return null;
          const value = await _decryptOrFail(cached.value);
          return { key, value, shared: !!shared };
        }
        return null;
      }
      // من هنا: وصل رد فعلي من السيرفر (متصلين فعلاً) — أي خطأ فك تشفير بعد هذه النقطة
      // خطأ حقيقي بمفتاح التشفير نفسه، وليس مجرد انقطاع اتصال، فيجب أن يخرج كخطأ صريح.
      if(res.status === 304 && cached){
        _kvVersions[key] = cached.version;
        markOnline();
        if(cached.value === null || cached.value === undefined) return null;
        const value = await _decryptOrFail(cached.value);
        return { key, value, shared: !!shared };
      }
      if(!res.ok){
        // السيرفر استجاب لكن بخطأ (مش انقطاع شبكة) — نرجّع آخر نسخة محلية معروفة لو موجودة
        // بدل عرض شاشة فارغة، حتى لو الخطأ مؤقت (مثال: الخادم "نائم" على استضافة مجانية).
        if(cached){
          markOffline();
          if(cached.value === null || cached.value === undefined) return null;
          const value = await _decryptOrFail(cached.value);
          return { key, value, shared: !!shared };
        }
        return null;
      }
      const data = await res.json();
      _kvVersions[key] = data.version || 0;
      _kvCacheWrite(key, data.version || 0, data.value ?? null);
      markOnline();
      if(data.value === null || data.value === undefined) return null;
      const value = await _decryptOrFail(data.value);
      return { key, value, shared: !!shared };
    },
    async set(key, value, shared, meta){
      const toStore = await encryptValue(value);
      try{
        const res = await serverFetch(`/api/storage/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: JSON.stringify({ value: toStore, version: _kvVersions[key] || 0, ...(meta||{}) }),
        });
        if(res.status === 409){
          const conflict = await res.json();
          _kvVersions[key] = conflict.currentVersion || _kvVersions[key];
          showToast('⚠️ ' + (conflict.error || 'تعارض في الحفظ: عدّل شخص آخر نفس البيانات، يرجى تحديث الصفحة وإعادة المحاولة'));
          return null;
        }
        if(res.status === 422){
          // حماية من فقدان بيانات: السيرفر رفض حفظاً يمحو عدداً كبيراً من السجلات فجأة (غالباً
          // بسبب جهاز يعمل بنسخة قديمة من البيانات في الذاكرة). لا نطبّق التعديل محلياً ولا نضعه
          // في طابور الرفع، حتى لا نُصر على تكرار نفس الحفظ الخطير تلقائياً لاحقاً.
          const guard = await res.json().catch(()=>({}));
          showToast('⛔ ' + (guard.error || 'تم رفض هذا الحفظ وقائياً لأنه سيحذف عدداً كبيراً من السجلات دفعة واحدة — يرجى تحديث الصفحة (Ctrl+Shift+R) والتأكد من آخر بيانات قبل إعادة المحاولة'));
          return null;
        }
        if(!res.ok) throw new Error('save request failed');
        const data = await res.json();
        _kvVersions[key] = data.version || 0;
        _kvCacheWrite(key, data.version || 0, toStore);
        await _pendingDelete(key); // لو كان معلقاً من محاولة سابقة أثناء انقطاع سابق ونجح الآن
        markOnline();
        return { key, value, shared: !!shared };
      }catch(e){
        // تعذّر الوصول للسيرفر (غالباً بدون إنترنت) — لا نفقد التعديل: نحدّث الكاش المحلي فوراً
        // (حتى تبقى الشاشة الحالية والقراءات التالية متسقة مع آخر تعديل)، ونجدول رفعه تلقائياً
        // عند عودة الاتصال، بدل عرض رسالة "تعذر الحفظ" وضياع البيانات المُدخلة.
        await _kvCacheWrite(key, _kvVersions[key] || 0, toStore);
        await _pendingWrite(key, toStore);
        markOffline();
        return { key, value, shared: !!shared, offline: true };
      }
    },
    async delete(key, shared){
      try{
        await serverFetch(`/api/storage/${encodeURIComponent(key)}`, { method: 'DELETE' });
        delete _kvVersions[key];
        _kvCacheDelete(key).catch(()=>{});
        return { key, deleted: true, shared: !!shared };
      }catch(e){ return null; }
    },
    async list(prefix, shared){
      try{
        const res = await serverFetch(`/api/storage?prefix=${encodeURIComponent(prefix||'')}`);
        if(!res.ok) return null;
        const data = await res.json();
        return { keys: data.keys, prefix, shared: !!shared };
      }catch(e){ return null; }
    }
};

/* ============================================================================
   عملاء كسجلات مستقلة (client_records) — بديل عن حفظ كل العملاء ككتلة واحدة
   ==============================================================================
   بدل تشفير مصفوفة كل العملاء دفعة واحدة (ما كان يعني إعادة رفع كل الآلاف من
   العملاء عند أي إضافة/تعديل/حذف لعميل واحد)، كل عميل يُشفَّر لوحده ويُحفظ/يُحذف
   كصف مستقل. راجع تعليق CREATE TABLE client_records فى schema.sql للتفاصيل. */
const _clientRecordVersions = {}; // id -> آخر version معروف لهذا العميل تحديداً (وليس للمصفوفة كلها)
let _clientRecordsAggVersion = null; // آخر "مجموع نسخ" معروف — للتحقق الدوري السريع من وجود تعديل من جهاز آخر

// عزل بيانات الاستقبال: origin/status أعمدة صريحة فى قاعدة البيانات (غير مشفّرة، السيرفر
// نفسه يفلتر عليها) — لا تُدمَج أبداً داخل كائن العميل المشفَّر (JSON.stringify(client) عند كل
// حفظ)، حتى لا تتسرب لداخل enc أو تُغيّر بصمة المقارنة مع baseline. تُحفَظ هنا بمفتاح id فقط،
// وتُستخدم حصراً لعرض شارة "قيد اعتماد الأدمن" وزر الاعتماد فى شاشة العملاء.
let clientRecordMeta = {}; // id -> { origin: 'general'|'reception', status: 'confirmed'|'pending' }

// ============================================================
// نظام تخزين عام للسجلات المستقلة (Generic Collection Records) — نفس فكرة نظام العملاء
// (client_records) أعلاه لكن قابلة لإعادة الاستخدام لأي شيت آخر (الخزنة، المخزون، المحاسبة،
// الشركات، المشتريات...). كل مجموعة (collection) لها Map مستقلة لأرقام النسخ ولـ "baseline"
// المزامنة (آخر نسخة معروفة مؤكدة من كل سجل)، بحيث لا يختلط تتبع تغييرات شيت عن آخر.
// ============================================================
// قائمة كل التصنيفات المحوَّلة لنظام "السجلات المستقلة" (سجل واحد لكل عنصر) — مطابقة تماماً
// لنفس القائمة ALLOWED_COLLECTIONS فى server.js. تُستخدم هنا للمرور على كل تصنيف دفعة واحدة
// (مثال: إعادة ضبط المصنع).
const ALLOWED_COLLECTIONS_LOCAL = [
  'bagStock','vaultTx','deletedVaultTx','vaultDenomTx','bankStatementRows','deletedInvoices',
  'courseSessions','auditLog','companies','companyTransfers','journalEntries','chartOfAccounts',
  'journalDE','budgetEntries','suppliers','purchases','manualSalesInvoices',
];
const _recordVersions = {}; // collection -> Map(id -> version)
const _collectionSyncBaseline = {}; // collection -> Map(id -> json) | null (لسه غير مؤكدة هذه الجلسة)

async function fetchAllRecordsGeneric(collection){
  const res = await serverFetch(`/api/records/${encodeURIComponent(collection)}`);
  if(!res.ok) throw new Error('تعذّر جلب بيانات ' + collection);
  const data = await res.json();
  const list = [];
  const baseline = new Map();
  const versions = new Map();
  for(const r of (data.records||[])){
    versions.set(r.id, r.version);
    let plain;
    try{ plain = await _decryptOrFail(r.enc); }
    catch(e){ throw e; } // خطأ تشفير حقيقي يجب أن يوقف التحميل، وليس تجاهلاً صامتاً
    try{
      const obj = JSON.parse(plain);
      list.push(obj);
      baseline.set(r.id, plain);
    }catch(e){ /* سجل تالف (JSON غير صالح) — نتجاهله بدل تعطيل تحميل كل التصنيف */ }
  }
  _recordVersions[collection] = versions;
  return { list, baseline };
}

async function saveOneRecordGeneric(collection, id, plainJson){
  try{
    const enc = await encryptValue(plainJson);
    if(!_recordVersions[collection]) _recordVersions[collection] = new Map();
    const knownVersion = _recordVersions[collection].get(id) || 0;
    const res = await serverFetch(`/api/records/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ enc, version: knownVersion }),
    });
    if(res.status === 409){
      const conflict = await res.json().catch(()=>({}));
      _recordVersions[collection].set(id, conflict.currentVersion || knownVersion);
      showToast('⚠️ ' + (conflict.error || 'تعارض فى الحفظ: عدّل شخص آخر نفس البيانات — يرجى تحديث الصفحة'));
      return false;
    }
    if(!res.ok) return null;
    const data = await res.json();
    _recordVersions[collection].set(id, data.version || 0);
    return true;
  }catch(e){ return null; }
}

async function deleteOneRecordGeneric(collection, id){
  try{
    await serverFetch(`/api/records/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if(_recordVersions[collection]) _recordVersions[collection].delete(id);
    return true;
  }catch(e){ return null; }
}

async function bulkUploadRecordsGeneric(collection, list){
  const CHUNK = 300;
  for(let i=0;i<list.length;i+=CHUNK){
    const chunk = list.slice(i, i+CHUNK);
    const records = [];
    for(const item of chunk) records.push({ id: item.id, enc: await encryptValue(JSON.stringify(item)) });
    const res = await serverFetch(`/api/records/${encodeURIComponent(collection)}/bulk-migrate`, {
      method: 'POST',
      body: JSON.stringify({ records }),
    });
    if(!res.ok) throw new Error('تعذّر رفع دفعة من بيانات ' + collection);
  }
}

// تحميل تصنيف واحد كامل: يحاول النظام الجديد (سجل فردي لكل عنصر) أولاً؛ لو رجع فارغاً فعلياً
// يتحقق من وجود بيانات قديمة (كتلة واحدة تحت نفس الاسم فى kv_store) ويرحّلها لمرة واحدة فقط —
// تماماً بنفس منطق تحميل/ترحيل العملاء أعلاه (fetchAllClientRecords). فى وضع cacheOnly (فتح فورى
// من الجهاز بدون انتظار الشبكة) نستخدم آخر نسخة قديمة محفوظة محلياً إن وُجدت، والمزامنة الحقيقية
// تتم لاحقاً فى الخلفية (نفس فكرة تحميل العملاء بالضبط).
async function loadCollectionGeneric(collection, cacheOnly){
  if(cacheOnly){
    try{
      const r = await window.storage.get(collection, false, true);
      const list = (r && r.value) ? JSON.parse(r.value) : [];
      return { list: Array.isArray(list) ? list : [], baseline: null };
    }catch(e){ return { list: [], baseline: null }; }
  }
  try{
    const { list, baseline } = await fetchAllRecordsGeneric(collection);
    if(list.length) return { list, baseline };
    // فارغ فعلاً فى النظام الجديد — نتحقق من وجود بيانات قديمة (كتلة واحدة) تحتاج ترحيل لمرة واحدة
    let legacyList = [];
    try{
      const r = await window.storage.get(collection, false, false);
      legacyList = (r && r.value) ? JSON.parse(r.value) : [];
      if(!Array.isArray(legacyList)) legacyList = [];
    }catch(e){ legacyList = []; }
    if(legacyList.length){
      try{
        await bulkUploadRecordsGeneric(collection, legacyList);
        return { list: legacyList, baseline: new Map(legacyList.map(x=>[x.id, JSON.stringify(x)])) };
      }catch(e){
        // فشل الترحيل (انقطع الاتصال أثناءه) — نكمل بالبيانات القديمة فى الذاكرة، وتُعاد المحاولة
        // تلقائياً فى المرة القادمة online (نفس البيانات فقط تُرفع تاني، آمن للتكرار).
        return { list: legacyList, baseline: null };
      }
    }
    return { list: [], baseline: new Map() };
  }catch(e){
    // تعذّر الوصول لنظام السجلات الجديد فعلياً (انقطاع اتصال) — نرجع لآخر نسخة محفوظة محلياً.
    try{
      const r = await window.storage.get(collection, false, true);
      const list = (r && r.value) ? JSON.parse(r.value) : [];
      return { list: Array.isArray(list) ? list : [], baseline: null };
    }catch(e2){ return { list: [], baseline: null }; }
  }
}

// حفظ تصنيف كامل (مصفوفة فى الذاكرة) بنفس منطق saveClients بالضبط: لو المزامنة مع النظام الجديد
// مؤكدة هذه الجلسة (baseline موجودة)، نرفع فقط العناصر التي تغيّرت فعلياً (سجل واحد لكل عنصر تغيّر،
// أو رفع مُجمَّع لو أكثر من 20 عنصر دفعة واحدة)، بدل رفع المصفوفة الكاملة فى كل مرة. أي عنصر بلا
// `id` يُتجاهَل من هذا المسار السريع (لا يمكن تتبعه فردياً) ويعتمد فقط على خط الرجعة الكامل أدناه.
async function saveCollectionGeneric(collection, arr){
  try{
    const baseline = _collectionSyncBaseline[collection];
    if(baseline){
      const currentIds = new Set();
      const changed = [];
      for(const item of arr){
        if(!item || !item.id) continue;
        currentIds.add(item.id);
        const json = JSON.stringify(item);
        if(baseline.get(item.id) !== json) changed.push({ item, json });
      }
      const removedIds = [];
      for(const id of baseline.keys()) if(!currentIds.has(id)) removedIds.push(id);

      let anyNetworkFailure = false;
      if(changed.length > 20){
        try{
          await bulkUploadRecordsGeneric(collection, changed.map(x=>x.item));
          changed.forEach(x=> baseline.set(x.item.id, x.json));
        }catch(e){ anyNetworkFailure = true; }
      }else{
        for(const {item, json} of changed){
          const ok = await saveOneRecordGeneric(collection, item.id, json);
          if(ok) baseline.set(item.id, json);
          else if(ok === null) anyNetworkFailure = true;
        }
      }
      for(const id of removedIds){
        const ok = await deleteOneRecordGeneric(collection, id);
        if(ok) baseline.delete(id);
        else anyNetworkFailure = true;
      }
      if(anyNetworkFailure){
        _collectionSyncBaseline[collection] = null;
        await window.storage.set(collection, JSON.stringify(arr), false);
      }
      return;
    }
    // خط الرجعة: المزامنة مع النظام الجديد لم تتأكد بعد هذه الجلسة — نحفظ بالطريقة القديمة الكاملة.
    await window.storage.set(collection, JSON.stringify(arr), false);
  }catch(e){ showToast('تعذر حفظ البيانات'); }
}

async function checkAllRecordsChanged(){
  try{
    const res = await serverFetch('/api/records-versions');
    if(!res.ok) return false;
    const data = await res.json();
    const serverVersions = data.versions || {};
    let changed = false;
    Object.keys(serverVersions).forEach(col=>{
      const baseline = _collectionSyncBaseline[col];
      if(!baseline) return; // لسه غير مُزامَنة هذه الجلسة — تُعالَج فى loadData العادي
      const localVersions = _recordVersions[col];
      const localSum = localVersions ? Array.from(localVersions.values()).reduce((a,b)=>a+b,0) : 0;
      const localCount = localVersions ? localVersions.size : 0;
      if(localSum !== serverVersions[col].version || localCount !== serverVersions[col].count) changed = true;
    });
    return changed;
  }catch(e){ return false; }
}

// يجلب فقط أرقام هوية العملاء الموجودة بالفعل فى كل النظام (بلا أي بيانات أخرى)، لفحص التكرار قبل
// الحفظ — يعمل حتى لمستخدم الاستقبال المعزول عادةً عن رؤية باقي بيانات العملاء، لأن هذه النقطة
// تحديداً مصمَّمة لترجع الأرقام فقط بغض النظر عن origin/status/created_by (راجع تعليق الخادم).
// يرجع Map من رقم الهوية -> معرّف السجل (id) الداخلي، لتمييز "نفس العميل الذي أعدّله الآن" عن
// "عميل آخر يملك نفس الرقم فعلاً".
async function fetchAllClientIds(){
  try{
    const res = await serverFetch('/api/client-records/ids');
    if(!res.ok) return null; // تعذّر السؤال عن الخادم — المستدعي يقرر خط الرجعة (فحص محلي فقط)
    const data = await res.json();
    const map = new Map();
    (data.ids||[]).forEach(row=>{ if(row.clientId) map.set(row.clientId, row.id); });
    return map;
  }catch(e){ return null; }
}

async function fetchAllClientRecords(){
  const res = await serverFetch('/api/client-records');
  if(!res.ok) throw new Error('تعذّر جلب سجلات العملاء من السيرفر');
  const data = await res.json();
  const list = [];
  const baseline = new Map();
  clientRecordMeta = {};
  for(const r of (data.records||[])){
    _clientRecordVersions[r.id] = r.version;
    clientRecordMeta[r.id] = { origin: r.origin || 'general', status: r.status || 'confirmed' };
    let plain;
    try{ plain = await _decryptOrFail(r.enc); }
    catch(e){ throw e; } // خطأ تشفير حقيقي يجب أن يوقف التحميل كباقي البرنامج، وليس تجاهلاً صامتاً
    try{
      const obj = JSON.parse(plain);
      list.push(obj);
      baseline.set(r.id, plain);
    }catch(e){ /* سجل تالف (JSON غير صالح) — نتجاهله بدل تعطيل تحميل كل العملاء */ }
  }
  return { list, baseline };
}

// يحفظ عميلاً واحداً فقط (تسجيل/تعديل). يرجع true لو نجح، false لو رُفض بسبب تعارض حقيقي
// (عدّله شخص آخر بينما هذا الجهاز يعمل بنسخة أقدم)، أو null لو تعذّر الوصول للسيرفر أصلاً
// (بدون إنترنت) — المستدعي فى هذه الحالة يقرر خط الرجعة (راجع saveClients فى ui-framework.js).
async function saveOneClientRecord(client, plainJson){
  try{
    const enc = await encryptValue(plainJson);
    const res = await serverFetch(`/api/client-records/${encodeURIComponent(client.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ enc, version: _clientRecordVersions[client.id] || 0, clientId: client.clientId || '' }),
    });
    if(res.status === 409){
      const conflict = await res.json().catch(()=>({}));
      _clientRecordVersions[client.id] = conflict.currentVersion || _clientRecordVersions[client.id];
      showToast(`⚠️ تعارض فى حفظ بيانات العميل "${client.name||client.id}": عدّله شخص آخر من جهاز آخر — يرجى تحديث الصفحة`);
      return false;
    }
    if(!res.ok) return null;
    const data = await res.json();
    _clientRecordVersions[client.id] = data.version || 0;
    if(data.origin && data.status) clientRecordMeta[client.id] = { origin: data.origin, status: data.status };
    return true;
  }catch(e){ return null; }
}

async function deleteOneClientRecord(id){
  try{
    await serverFetch(`/api/client-records/${encodeURIComponent(id)}`, { method: 'DELETE' });
    delete _clientRecordVersions[id];
    delete clientRecordMeta[id];
    return true;
  }catch(e){ return null; }
}

// اعتماد الأدمن لعميل سجّله الاستقبال (pending -> confirmed). لا حاجة لفك/إعادة تشفير أي شيء —
// enc يبقى كما هو، فقط عمود status يتغيّر على السيرفر. يرجع true لو نجح.
async function approveClientRecord(id){
  try{
    const res = await serverFetch(`/api/client-records/${encodeURIComponent(id)}/approve`, { method: 'POST' });
    if(!res.ok) return false;
    const data = await res.json();
    _clientRecordVersions[id] = data.version || _clientRecordVersions[id];
    clientRecordMeta[id] = { origin: 'reception', status: 'confirmed' };
    return true;
  }catch(e){ return false; }
}

// رفع مُجمَّع (حتى 300 عميل فى الطلب الواحد) — يُستخدم فى الترحيل لمرة واحدة من التخزين القديم،
// وفى العمليات الضخمة دفعة واحدة (استيراد، تحديث شامل) بدل طلب منفصل لكل عميل.
async function bulkUploadClientRecords(clientsList){
  const CHUNK = 300;
  for(let i=0;i<clientsList.length;i+=CHUNK){
    const chunk = clientsList.slice(i, i+CHUNK);
    const records = [];
    for(const c of chunk) records.push({ id: c.id, enc: await encryptValue(JSON.stringify(c)), clientId: c.clientId || '' });
    const res = await serverFetch('/api/client-records/bulk-migrate', {
      method: 'POST',
      body: JSON.stringify({ records }),
    });
    if(!res.ok) throw new Error('تعذّر رفع دفعة من سجلات العملاء أثناء الترحيل');
  }
}

// تحقق دوري خفيف جداً: هل تغيّرت بيانات العملاء على السيرفر من جهاز آخر؟ (طلب صغير واحد، بدون
// نقل أي بيانات فعلية إلا لو تغيّر شيء فعلاً). يُستخدم من backgroundSyncCheck.
async function checkClientRecordsChanged(){
  try{
    const res = await serverFetch('/api/client-records/version');
    if(!res.ok) return false;
    const data = await res.json();
    if(_clientRecordsAggVersion === null){ _clientRecordsAggVersion = data.version; return false; }
    const changed = data.version !== _clientRecordsAggVersion;
    _clientRecordsAggVersion = data.version;
    return changed;
  }catch(e){ return false; }
}

