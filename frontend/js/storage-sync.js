// تنفيذ قائمة عناصر بالتوازي على دفعات (بدل طابور تسلسلي عنصر-عنصر) — كل عنصر ينتظر السيرفر
// بمفرده بمعزل عن الباقي، فتنفيذ N عنصر تسلسلياً يكلّف N × زمن الرحلة الكاملة (RTT) بينما تنفيذهم
// بالتوازي على دفعات يكلّف تقريباً (N/concurrency) × RTT فقط — فرق كبير فى أي حالة فيها أكتر من
// تعديل واحد معلّق (استيراد جماعي، عودة من انقطاع اتصال طويل...). concurrency=6 آمن تماماً مع حد
// معدل الطلبات على السيرفر (storageLimiter: 120 طلب/دقيقة لكل IP، راجع server.js). لو `worker`
// أرجعت stop=true (مثال: انقطاع اتصال حقيقي مكتشف)، نوقف عن بدء أي دفعات جديدة فوراً (العناصر التي
// بدأت بالفعل فى الدفعة الحالية تُكمَل حتى نهايتها بشكل طبيعي).
async function _runWithConcurrency(items, worker, concurrency = 6){
  let stopped = false;
  for(let i = 0; i < items.length && !stopped; i += concurrency){
    const chunk = items.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map(item => worker(item).catch(() => ({ stop: true }))));
    if(results.some(r => r && r.stop)) stopped = true;
  }
}
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
  _refreshPendingQueueSyncCount();
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
  _refreshPendingQueueSyncCount();
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
    el.style.display = 'flex';
    if(manualOfflineMode){
      const count = await _pendingCount();
      el.style.background = '#4a3b1f';
      el.title = 'وضع العمل من الجهاز فقط مفعَّل يدوياً من الإعدادات — لا يتصل البرنامج بالسيرفر إطلاقاً، وأي تعديل يُحفظ محلياً فقط حتى تُعيد تفعيل الاتصال';
      el.innerHTML = '🔒 وضع محلي فقط (يدوي)' + (count ? ` — ${count} تعديل بانتظار الرفع لاحقاً` : '');
      return;
    }
    if(_ftcIsOffline){
      const count = await _pendingCount();
      el.style.background = '#7a1f1f';
      el.title = 'لا يوجد اتصال بالسيرفر حالياً — البرنامج يعمل من آخر نسخة محفوظة على هذا الجهاز، وأي تعديل سيُحفظ محلياً ويُرفع تلقائياً عند عودة الاتصال';
      el.innerHTML = '⚠️ غير متصل' + (count ? ` (${count} بانتظار الرفع)` : '');
      return;
    }
    // فحص فوري (بدون انتظار IndexedDB): فيه طلب حفظ/حذف لسه طاير فى الشبكة الآن فعلياً؟
    if(_activeRecordSaves > 0 || _activeKvSaves > 0){
      el.style.background = '#1f4a6e';
      el.title = 'جارٍ رفع آخر تعديل إلى السيرفر الآن...';
      el.innerHTML = '🔄 جارٍ الرفع للسيرفر...';
      return;
    }
    const count = await _pendingCount();
    if(count > 0){
      el.style.background = '#7a5a1f';
      el.title = 'يوجد تعديلات محفوظة محلياً بانتظار رفعها للسيرفر — جارٍ المحاولة تلقائياً';
      el.innerHTML = `⏳ جارٍ رفع ${count} تعديل...`;
      return;
    }
    // لا اتصال معطّل، ولا رفع جارٍ الآن، ولا تعديلات معلّقة بالطابور — كل شيء محفوظ فعلياً على السيرفر
    el.style.background = '#1f5c3a';
    el.title = 'كل التعديلات محفوظة على السيرفر بنجاح — لا يوجد أي شيء معلّق حالياً';
    el.innerHTML = '✅ كل شيء محدث';
  }catch(e){ console.error('[StorageSync] updateOfflineIndicator error:', e); }
}
let _ftcSyncInFlight = false;
let _ftcSyncPromise = null; // وعد الفلاش الجاري (single-flight) — أي استدعاء متزامن ينتظره بدل التكرار
// عدّاد لعدد طلبات حفظ/حذف سجل فردي (عميل أو سطر شيت) الجارية الآن فعلياً (لسه منتظرة رد
// السيرفر ولم تفشل بعد، فلم تُسجَّل فى طابور "السجلات المعلّقة" أصلاً). دونه، لو المستخدم عمل
// ريفرش أو قفل الصفحة فى نفس اللحظة اللي طلب الحفظ لسه طاير فى الشبكة، مفيش أي وسيلة تمنعه أو
// حتى تنبّهه — راجع beforeunload أسفل.
let _activeRecordSaves = 0;
// نفس الفكرة تماماً لطلبات الحفظ الكامل (window.storage.set) الجارية الآن فعلياً على الشبكة ولم
// تُسجَّل بعد في طابور "التعديلات المعلّقة" (لأنها لم تفشل — نجاحها يُحسم فقط عند رد السيرفر).
// لو أُغلق البرنامج في هذه اللحظة الضيقة قبل اكتمال الرد، يُفقد التعديل نهائياً دون أي أثر —
// فنجعل beforeunload يحذّر أيضاً عند وجود أي منها.
let _activeKvSaves = 0;
window.addEventListener('beforeunload', (e)=>{
  // لا ننتظر أي Promise هنا (المتصفح لا يسمح بذلك فى beforeunload) — فقط نتحقق من عدّادات
  // متزامنة فى الذاكرة. _activeRecordSaves/_activeKvSaves تغطي طلبات لسه "فى الهواء" فعلياً على
  // الشبكة. _pendingQueueSyncCount تغطي حالة مختلفة ومهمة بنفس القدر: تعديل اتحفظ فى طابور
  // IndexedDB المحلي (نجح الحفظ محلياً) لكن لسه ما اتزامنش مع السيرفر إطلاقاً — لو المستخدم قفل
  // الصفحة دلوقتي وفتح نفس حسابه من جهاز تاني قبل ما يرجع يفتح البرنامج هنا تاني، التعديل ده
  // هيفضل غايب تماماً عن أي جهاز/تقرير تاني (وممكن يضيع نهائياً لو تعارض مع تعديل لاحق من جهاز
  // آخر لنفس السجل — راجع 409 فى flushPendingWrites/flushPendingRecordWrites). القيمة هنا مُحدَّثة
  // مسبقاً (فارق ملّي ثوانٍ فقط) وليست قراءة حيّة، لأن beforeunload لا يقدر ينتظر IndexedDB.
  if(_activeRecordSaves > 0 || _activeKvSaves > 0 || _pendingQueueSyncCount > 0){
    e.preventDefault();
    e.returnValue = 'فيه تعديلات لسه محفوظة على هذا الجهاز فقط ولم تُرفع للسيرفر بعد — لو غادرت الصفحة دلوقتي ممكن تفقد آخر تعديل، أو تختفي مؤقتاً عن باقي الأجهزة حتى تفتح البرنامج هنا تاني. متأكد إنك عايز تكمل؟';
    return e.returnValue;
  }
});
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
  // حارس single-flight يُضبط قبل أي await: حدث online والموقّت الدوري (20 ثانية) والاستدعاء من
  // backgroundSyncCheck قد يشغّلون هذه الدالة في نفس اللحظة. سابقاً كانت القيمة تُضبط فقط بعد
  // await _pendingReadAll، فكان الاستدعاء الثاني يرى الحارس فارغاً ويدخل أيضاً في نفس حلقة الرفع —
  // فيُرسل نفس التعديل المعلّق مرتين متوازيتين، والثانية ترسل نسخة قديمة فيُرفضها السيرفر بـ409
  // ويُسقط التعديل من الطابور مع إشعار خاطئ رغم أن الأولى كانت ستنفذه بنجاح. الآن أي استدعاء
  // متزامن ينتظر نفس الوعد بدل تكرار العمل.
  if(_ftcSyncInFlight) return _ftcSyncPromise;
  _ftcSyncInFlight = true;
  _ftcSyncPromise = (async () => {
    try{
      const pending = await _pendingReadAll();
      if(!pending.length){ markOnline(); return; }
      // تحضير أرقام النسخ الحقيقية للمفاتيح المعلَّقة التي لا تملك _kvVersions معروفة لهذه الجلسة
      // (مثال: انقطع الاتصال من أول لحظة فتح البرنامج قبل نجاح أي GET، فـ_kvVersions[key] بيفضل
      // undefined طول الوقت). بدون هذه الخطوة، كل هذه المفاتيح كانت ستُرسَل بـ version:0 دائماً
      // (افتراض "مفتاح جديد" وهو خاطئ)، فيرفضها السيرفر بـ409 "تعارض" كاذب رغم عدم وجود أي تعديل
      // فعلي من جهاز آخر — فقط لأن هذا الجهاز لم يكن يعرف رقم النسخة الحقيقي أصلاً. لا نلمس أي مفتاح
      // له _kvVersions معروفة بالفعل هذه الجلسة (تلك تمثل النسخة التي بُني عليها التعديل فعلياً،
      // وتترك لآلية 409 العادية لتكتشف أي تعارض حقيقي كما كانت).
      const unknownKeys = pending.map(p => p.key).filter(k => !(k in _kvVersions));
      if(unknownKeys.length){
        try{
          const versionsRes = await serverFetch('/api/storage-versions');
          if(versionsRes.ok){
            const versionsData = await versionsRes.json();
            const serverVersions = versionsData.versions || {};
            for(const k of unknownKeys){
              if(k in serverVersions) _kvVersions[k] = serverVersions[k];
            }
          }
        }catch(e){ /* تعذّر التحضير (لسه بدون اتصال فعلياً) — سيُكمل بالمنطق القديم أدناه كخط رجعة */ }
      }
      // معالجة كل عنصر (نفس المنطق بالضبط كما كان تسلسلياً، ملفوف الآن فى دالة تُنفَّذ بالتوازي على
      // دفعات عبر _runWithConcurrency بدل حلقة for...of تسلسلية — راجع تعليقها لشرح الفرق).
      await _runWithConcurrency(pending, async (item) => {
        try{
          const res = await serverFetch(`/api/storage/${encodeURIComponent(item.key)}`, {
            method: 'PUT',
            body: JSON.stringify({ value: item.value, version: _kvVersions[item.key] || 0 }),
          });
          if(res.status === 409){
            // تعارض حقيقي: عُدِّلت نفس البيانات من جهاز/جلسة أخرى أثناء انقطاعنا — لا نستطيع
            // حسم هذا تلقائياً بأمان، فنتخلى عن هذا التعديل المعلّق تحديداً وننبّه المستخدم.
            const conflict = await res.json().catch(()=>({}));
            _kvVersions[item.key] = conflict.currentVersion || _kvVersions[item.key];
            await _pendingDelete(item.key);
            showToast(`⚠️ تعذّرت مزامنة تعديل محفوظ محلياً (${item.key}) بسبب تعديل آخر لنفس البيانات — يرجى تحديث الصفحة لمراجعتها`);
            return;
          }
          if(!res.ok) return; // السيرفر لا يزال غير متجاوب — نتركه في الطابور ونعيد المحاولة لاحقاً
          const data = await res.json();
          _kvVersions[item.key] = data.version || 0;
          await _kvCacheWrite(item.key, data.version || 0, item.value);
          await _pendingDelete(item.key);
        }catch(e){
          // لا يزال بدون اتصال — نوقف بدء أي دفعات جديدة (باقي العناصر تفضل فى الطابور لمحاولة لاحقة)
          markOffline();
          return { stop: true };
        }
      });
    } finally {
      _ftcSyncInFlight = false;
      _ftcSyncPromise = null;
      const remaining = await _pendingCount();
      if(remaining === 0) markOnline(); else updateOfflineIndicator();
    }
  })();
  return _ftcSyncPromise;
}
// ضبط أولي لعدّاد الطابور المتزامن عند تحميل الملف مباشرة (وليس فقط بعد أول تعديل جديد فى هذه
// الجلسة): لو فيه تعديلات معلّقة متبقية من جلسة سابقة لم تُرفع بعد (مثال: الجهاز اتقفل فجأة قبلها)،
// لازم beforeunload يعرف بوجودها فوراً حتى لو المستخدم قفل الصفحة تاني قبل ما flushPendingWrites
// ينجح أو حتى يبدأ.
_refreshPendingQueueSyncCount();
window.addEventListener('online', ()=>{ flushPendingWrites(); flushPendingRecordWrites(); });
window.addEventListener('offline', ()=>{ markOffline(); });
// محاولة دورية احتياطية (كل 20 ثانية) بجانب حدث online، ولا تُكلّف شيئاً لو الطابور فارغ بالفعل
setInterval(()=>{ flushPendingWrites().catch(()=>{}); flushPendingRecordWrites().catch(()=>{}); }, 20000);
let _ftcRecordSyncInFlight = false;
let _ftcRecordSyncPromise = null; // وعد الفلاش الجاري (single-flight) — أي استدعاء متزامن ينتظره بدل التكرار
// نفس الفكرة والتصحيح بالضبط كما في flushPendingWrites: الحارس يُضبط قبل أي await حتى لا يتجاوزه
// استدعاء متزامن (حدث online + الموقّت الدوري + بداية loadData/loadCollectionGeneric كلها تستدعي
// هذه الدالة في نفس اللحظة)، فيُرسل نفس التعديلات المعلّقة مرتين متوازيتين — والثانية ترسل نسخة
// قديمة فيرفضها السيرفر بـ409 ويُسقط التعديل من الطابور مع إشعار خاطئ رغم أن الأولى كانت ستنفذه.
// ---- قرار آمن عند التعارض (بدل "إعادة الرفع القسري" التي كانت تكتب فوق تعديل الآخرين) ----
// عند 409/conflict نحتاج أن نعرف: هل محتوى السجل على السيرفر حالياً ما زال مطابقاً لما بُني عليه
// تعديلنا (الـ baseline) أم لا؟ لو مطابق → التعارض سببه انحراف في تتبع أرقام النسخ المحلية فقط
// (لقطة قديمة، استعادة/مسح جزئي صفّر النسخ المحلية) وليس تعديلاً فعلياً من جهاز آخر → من الآمن
// إعادة رفع تعديلنا بالنسخة الحالية. لو مختلف → شخص آخر غيّر السجل فعلاً → لا يجوز الكتابة فوقه
// إطلاقاً (هذا كان الخطر الحرج: الواجهة كانت تعيد رفع التعديل القديم فوق بيانات الآخرين بصمت).
// السيرفر لا يملك مفتاح التشفير فلا يستطيع مقارنة المحتوى — يُرجع القيمة الحالية (currentEnc)
// مشفَّرة، ونحن من نفك تشفيرها ونقارنها بأساسنا. لو تعذّر فك التشفير أو غابت أي معلومة → نتعامل
// مع التعارض كحقيقي (لا نكتب فوق أحد) — خط رجعة آمن دائماً.
async function _recordBasePlain(collection, isClient, id){
  try{
    if(isClient){
      if(_clientsSyncBaseline instanceof Map) return _clientsSyncBaseline.get(id) ?? null;
      return null;
    }
    const b = _collectionSyncBaseline[collection];
    if(b instanceof Map) return b.get(id) ?? null;
    return null;
  }catch(e){ return null; }
}
// يرجع true فقط لو أمكن إثبات أن محتوى السيرفر الحالي مطابق لأساس تعديلنا (بعد فك التشفير).
async function _safeToApplyOnConflict(conflict, collection, isClient, id){
  try{
    if(!conflict || typeof conflict.currentEnc !== 'string') return false;
    if(typeof conflict.currentVersion !== 'number') return false;
    let serverPlain = null;
    try{ serverPlain = await decryptValue(conflict.currentEnc); }catch(e){ serverPlain = null; }
    if(typeof serverPlain !== 'string') return false;
    const basePlain = await _recordBasePlain(collection, isClient, id);
    if(typeof basePlain !== 'string') return false;
    return serverPlain === basePlain;
  }catch(e){ return false; }
}
// عند تعارض حقيقي (لا نستطيع الكتابة فوق الآخرين): نُحدّث النسخة المحلية المعروفة ونُزيل أي تعديل
// معلّق لذلك السجل حتى لا يُعاد رفعه لاحقاً فوق بيانات أحدث — مع إشعار للمستخدم (رسالة الـ toast
// يضيفها المتصل). نفس معاملة تعارضات kv تماماً.
async function _dropRecordOnRealConflict(collection, isClient, id, conflict){
  try{
    if(isClient){
      _clientRecordVersions[id] = (conflict && typeof conflict.currentVersion === 'number') ? conflict.currentVersion : (_clientRecordVersions[id] || 0);
    }else if(_recordVersions[collection]){
      _recordVersions[collection].set(id, (conflict && typeof conflict.currentVersion === 'number') ? conflict.currentVersion : 0);
    }
  }catch(e){}
  await _pendingRecordDelete(collection, id);
}

async function flushPendingRecordWrites(){
  if(_ftcRecordSyncInFlight) return _ftcRecordSyncPromise;
  _ftcRecordSyncInFlight = true;
  _ftcRecordSyncPromise = (async () => {
    try{
      const pending = await _pendingRecordReadAll();
      if(!pending.length) return;
      // نفس تحويل الحلقة التسلسلية لتنفيذ متوازٍ على دفعات — راجع تعليق _runWithConcurrency أعلى
      // الملف. كل عنصر (سواء عميل أو سجل شيت عام) مستقل تماماً عن باقي العناصر (مفتاح مركّب مختلف
      // فى قاعدة البيانات)، فلا خطر من معالجتهم بالتوازي — منطق كل عنصر (بما فيه إعادة محاولة 409)
      // بقي بلا أي تغيير، فقط انتقل من for...of إلى دالة worker تُستدعى بالتوازي.
      await _runWithConcurrency(pending, async (item) => {
        try{
          const isClient = item.collection === 'clients';
          const url = isClient ? `/api/client-records/${encodeURIComponent(item.id)}` : `/api/records/${encodeURIComponent(item.collection)}/${encodeURIComponent(item.id)}`;
          let res;
          if(item.op === 'delete'){
            // الحذف المعلّق يحمل أيضاً رقم النسخة المعروف محلياً: لو تغيّر السجل على السيرفر بعد
            // آخر مشاهدة (تعديل من جهاز آخر)، يرفضه السيرفر بـ409 فيُسقط الطلب المعلّق دون حذف
            // بيانات أحدث بصمت — نفس منطق حذف deleteOneRecordGeneric/deleteOneClientRecord.
            const delVersion = isClient ? (_clientRecordVersions[item.id] || 0) : ((_recordVersions[item.collection] && _recordVersions[item.collection].get(item.id)) || 0);
            res = await serverFetch(url + `?version=${delVersion}`, { method: 'DELETE' });
          }else{
            const knownVersion = isClient ? (_clientRecordVersions[item.id] || 0) : ((_recordVersions[item.collection] && _recordVersions[item.collection].get(item.id)) || 0);
            const body = isClient ? { enc: item.enc, version: knownVersion, clientId: item.clientId || '' } : { enc: item.enc, version: knownVersion };
            res = await serverFetch(url, { method: 'PUT', body: JSON.stringify(body) });
          }
          if(res.status === 409){
            // تعارض: نحسم تلقائياً بأمان عبر مقارنة محتوى حقيقية بدل "إعادة الرفع القسري" القديمة
            // التي كانت تعيد رفع تعديلنا القديم (enc) بالنسخة الحالية من السيرفر فيكتب فوق تعديل
            // الشخص الآخر بصمت. الآن: لو محتوى السيرفر الحالي مطابق لأساس تعديلنا (انحراف تتبع
            // نسخ محلي فقط) → نعيد الرفع مرة واحدة بالنسخة الحالية. لو مختلف أو تعذّر التحقق
            // (تعديل فعلي من جهاز آخر) → لا نكتب فوقه إطلاقاً: نتخلى عن التعديل المعلّق وننبّه
            // المستخدم — نفس معاملة تعارضات kv (flushPendingWrites) تماماً.
            const conflict = await res.json().catch(()=>({}));
            const safeToRetry = item.op === 'upsert' && await _safeToApplyOnConflict(conflict, item.collection, isClient, item.id);
            if(safeToRetry){
              const retryBody = isClient ? { enc: item.enc, version: conflict.currentVersion, clientId: item.clientId || '' } : { enc: item.enc, version: conflict.currentVersion };
              const retryRes = await serverFetch(url, { method: 'PUT', body: JSON.stringify(retryBody) });
              if(retryRes.status === 409){
                // تغيّر حقيقي أثناء إعادة المحاولة — تعارض حقيقي (لا كتابة فوق)
                const c2 = await retryRes.json().catch(()=>({}));
                await _dropRecordOnRealConflict(item.collection, isClient, item.id, c2);
                showToast(`⚠️ تعذّرت مزامنة تعديل معلّق (${item.collection}) بسبب تعديل آخر لنفس البيانات — يرجى تحديث الصفحة لمراجعتها`);
                return;
              }
              if(!retryRes.ok) return; // السيرفر لسه غير متجاوب — يفضل فى الطابور لإعادة المحاولة لاحقاً
              const retryData = await retryRes.json().catch(()=>({}));
              if(isClient){
                _clientRecordVersions[item.id] = retryData.version || conflict.currentVersion;
                if(retryData.origin && retryData.status) clientRecordMeta[item.id] = { origin: retryData.origin, status: retryData.status };
              }else{
                if(!_recordVersions[item.collection]) _recordVersions[item.collection] = new Map();
                _recordVersions[item.collection].set(item.id, retryData.version || conflict.currentVersion);
              }
              await _pendingRecordDelete(item.collection, item.id);
              return;
            }
            await _dropRecordOnRealConflict(item.collection, isClient, item.id, conflict);
            showToast(`⚠️ تعذّرت مزامنة تعديل معلّق (${item.collection}) بسبب تعديل آخر لنفس البيانات — يرجى تحديث الصفحة لمراجعتها`);
            return;
          }
          if(!res.ok) return; // السيرفر لسه غير متجاوب — يفضل فى الطابور لإعادة المحاولة لاحقاً
          if(item.op === 'delete'){
            if(isClient){ delete _clientRecordVersions[item.id]; delete clientRecordMeta[item.id]; }
            else if(_recordVersions[item.collection]) _recordVersions[item.collection].delete(item.id);
          }else{
            const data = await res.json().catch(()=>({}));
            if(isClient){
              _clientRecordVersions[item.id] = data.version || 0;
              if(data.origin && data.status) clientRecordMeta[item.id] = { origin: data.origin, status: data.status };
            }else{
              if(!_recordVersions[item.collection]) _recordVersions[item.collection] = new Map();
              _recordVersions[item.collection].set(item.id, data.version || 0);
            }
          }
          await _pendingRecordDelete(item.collection, item.id);
        }catch(e){
          // لا يزال بدون اتصال فعلياً — نوقف بدء أي دفعات جديدة (باقي العناصر تفضل فى الطابور)
          return { stop: true };
        }
      });
    } finally {
      _ftcRecordSyncInFlight = false;
      _ftcRecordSyncPromise = null;
    }
  })();
  return _ftcRecordSyncPromise;
}

/* ============================================================================
   التحقق قبل تسجيل الخروج: يتأكد أن كل البيانات مرفوعة فعلاً للسيرفر ولا يوجد
   أي شيء معلّق. الخطوات: (1) ننتظر اكتمال أي طلبات حفظ جارية فعلياً الآن على
   الشبكة (لسه بانتظار رد السيرفر ولم تُسجَّل بعد في طابور المعلّقات)، (2) نحاول
   رفع كل التعديلات المعلّقة (kv + السجلات/العملاء)، (3) نعيد قراءة الطوابير
   ونحكم هل كل شيء متزامن أم لا. يُستدعى من زر تسجيل الخروج.
   ============================================================================ */
async function verifyAllDataUploadedBeforeLogout(){
  // 1) انتظار اكتمال الطلبات الجارية (بحد أقصى 8 ثوانٍ) حتى تُحسم قبل أي فحص نهائي
  const settleDeadline = Date.now() + 8000;
  while(Date.now() < settleDeadline && (_activeRecordSaves > 0 || _activeKvSaves > 0 || _ftcSyncInFlight || _ftcRecordSyncInFlight)){
    await new Promise(r=>setTimeout(r, 150));
  }
  // 2) رفع كل المعلّقات (single-flight: أي محاولة دورية متزامنة تشارك نفس الوعد فلا يتكرر العمل).
  //    مهلة قصوى شاملة حتى لا يعلق تسجيل الخروج على سيرفر غير مستجيب.
  const FLUSH_CAP = 25000;
  await Promise.race([
    (async()=>{
      try{ await flushPendingWrites(); }catch(e){}
      try{ await flushPendingRecordWrites(); }catch(e){}
    })(),
    new Promise(r=>setTimeout(r, FLUSH_CAP)),
  ]);
  // 3) التقييم النهائي
  const kvPending = await _pendingCount();
  const recPending = await _pendingRecordCount();
  const stillInFlight = (_activeRecordSaves > 0) || (_activeKvSaves > 0) || _ftcSyncInFlight || _ftcRecordSyncInFlight;
  let restorePending = false;
  try{ restorePending = localStorage.getItem('ftcPendingFullResyncAfterRestore') === '1'; }catch(e){}
  const allSynced = !stillInFlight && kvPending === 0 && recPending === 0 && !restorePending;
  return { allSynced, kvPending, recPending, stillInFlight, offline: (_ftcIsOffline || manualOfflineMode), restorePending };
}

async function serverFetch(path, options = {}) {
  if(manualOfflineMode){
    // وضع العمل من الجهاز فقط مفعَّل يدوياً — نرفض الاتصال بالسيرفر من أول خطوة، فتتعامل كل
    // دالة قراءة/كتابة في window.storage مع هذا الرفض تماماً كما تتعامل مع انقطاع اتصال حقيقي
    // (القراءة من الكاش المحلي، والكتابة في طابور الانتظار لحين إعادة تفعيل الاتصال).
    throw new Error('وضع العمل من الجهاز فقط مفعَّل — لا يوجد اتصال بالسيرفر');
  }
  // مهلة زمنية لكل طلب (افتراضياً 60 ثانية): سيرفر مثقل/نائم كان يمكن أن يعلق الطلب إلى الأبد،
  // فتظل شاشة فتح البرنامج سوداء بلا أي محتوى (الواجهة تظهر فقط بعد اكتمال loadData). الآن أي
  // طلب عالق يُلغى بعد المهلة وتتعامل دوال القراءة معه كفشل اتصال (الرجوع لآخر نسخة محلية)،
  // وتُعاد المحاولة تلقائياً لاحقاً من المزامنة الخلفية. يمكن للمتصل تمديدها عبر options.timeout.
  const { timeout = 60000, ...fetchOptions } = options || {};
  const controller = new AbortController();
  const timer = setTimeout(()=> controller.abort(), timeout);
  try{
    const res = await fetch(API_BASE + path, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(SERVER_AUTH_TOKEN ? { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN } : {}),
        ...(fetchOptions.headers || {}),
      },
    });
    if (res.status === 401) {
      // انتهت الجلسة أو لم يسجَّل الدخول بعد — أعد عرض شاشة الدخول على الخادم
      SERVER_AUTH_TOKEN = null;
      try { sessionStorage.removeItem('serverAuthToken'); } catch (e) { console.error('[StorageSync] Failed to clear serverAuthToken:', e); }
      try{ if(typeof disconnectRealtimeEvents==='function') disconnectRealtimeEvents(); }catch(e){}
      showServerLoginScreen('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً');
      throw new Error('غير مصرَّح — يرجى تسجيل الدخول');
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// شاشة "جاري تحميل البيانات..." — تُعرض فور إخفاء شاشة الدخول حتى لا يبقى المستخدم أمام شاشة
// سوداء صامتة بينما loadData/renderAllViewsAfterLoad تعملان (قد تستغرق وقتاً على سيرفر بطيء
// أو مثقل، أو عند أول فتح كامل بعد استعادة نسخة احتياطية). تُخفى عند ظهور الواجهة الفعلية
// (autoSignInLocalUser) أو عند الشاشة القاتلة (showFatalDecryptErrorScreen).
let _appLoadingOverlay = null;
let _appLoadingOverlayLabel = null;
function setAppLoadingOverlayText(text){
  try{ if(_appLoadingOverlayLabel) _appLoadingOverlayLabel.textContent = text; }catch(e){}
}
function showAppLoadingOverlay(){
  try{
    if(_appLoadingOverlay) return;
    _appLoadingOverlay = document.createElement('div');
    _appLoadingOverlay.id = 'app-loading-overlay';
    _appLoadingOverlay.style.cssText = 'position:fixed;inset:0;z-index:999990;background:#060e1c;color:#eaf2ff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;direction:rtl;';
    const spinner = document.createElement('div');
    spinner.style.cssText = 'width:44px;height:44px;border:4px solid rgba(56,189,248,.25);border-top-color:#22d3ee;border-radius:50%;animation:appSpin .9s linear infinite;';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:15px;opacity:.9;';
    label.textContent = 'جاري تحميل البيانات...';
    _appLoadingOverlayLabel = label;
    _appLoadingOverlay.appendChild(spinner);
    _appLoadingOverlay.appendChild(label);
    if(!document.getElementById('appSpinKeyframes')){
      const st = document.createElement('style');
      st.id = 'appSpinKeyframes';
      st.textContent = '@keyframes appSpin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    document.body.appendChild(_appLoadingOverlay);
  }catch(e){ console.error('[StorageSync] showAppLoadingOverlay failed:', e); }
}
function hideAppLoadingOverlay(){
  try{ if(_appLoadingOverlay && _appLoadingOverlay.parentNode) _appLoadingOverlay.parentNode.removeChild(_appLoadingOverlay); }catch(e){}
  _appLoadingOverlay = null;
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
      // لا نكتب أبداً null فوق آخر نسخة محلية صحيحة: قيمة السيرفر null تعني أن هذا المفتاح غير
      // موجود على السحابة (مثال: حُذف، أو جهاز آخر استعاد بيانات قبل وجوده) — كتابتها في الكاش
      // كانت تدمر آخر نسخة محلية سليمة نهائياً، فيُفتح البرنامج لاحقاً من الكاش بشاشة فارغة لا
      // يمكن استردادها (والنسخة الصحيحة الوحيدة على السيرفر أيضاً). نكتفي بتحديث رقم النسخة فقط.
      if(data.value !== null && data.value !== undefined){
        _kvCacheWrite(key, data.version || 0, data.value);
      }
      markOnline();
      if(data.value === null || data.value === undefined) return null;
      const value = await _decryptOrFail(data.value);
      return { key, value, shared: !!shared };
    },
    async set(key, value, shared, meta){
      const toStore = await encryptValue(value);
      _activeKvSaves++; // يُخفض دائماً في finally أدناه — يحمي من فقدان تعديل يُحسم فقط عند رد السيرفر
      updateOfflineIndicator(); // إظهار "جارٍ الرفع" فوراً فى مؤشّر الهيدر
      try{
        const res = await serverFetch(`/api/storage/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: JSON.stringify({ value: toStore, version: _kvVersions[key] || 0, ...(meta||{}) }),
        });
        if(res.status === 409){
          const conflict = await res.json();
          _kvVersions[key] = conflict.currentVersion || _kvVersions[key];
          showToast('⚠️ ' + (conflict.error || 'تعارض في الحفظ: عدّل شخص آخر نفس البيانات — يرجى تحديث الصفحة لمراجعتها'));
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
      }finally{
        _activeKvSaves--;
        updateOfflineIndicator(); // تحديث مؤشّر الهيدر لحالة "محدث" أو "بانتظار رفع" حسب النتيجة
      }
    },
    async delete(key, shared){
      try{
        await serverFetch(`/api/storage/${encodeURIComponent(key)}`, { method: 'DELETE' });
        delete _kvVersions[key];
        _kvCacheDelete(key).catch(()=>{});
        // نُزيل أي تعديل معلّق لنفس المفتاح من طابور الرفع (لو كان الحذف لاحقاً لأحدها): بدون
        // هذا، لو كان المفتاح لديه تعديل محلي فشل رفعه أثناء انقطاع (طابور pending) ثم حُذف الآن،
        // كان الفلاش التالي يعيد رفع ذلك التعديل القديم فيُحيي البيانات المحذوفة من جديد كأن شيئاً
        // لم يكن — بيانات "مُحيا بعد حذفها" تصلح لإرباك المزامنة وإعادة بيانات حذفها المستخدم.
        await _pendingDelete(key);
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

// نفس فكرة clientRecordMeta لكن للسجلات العامة (collection_records): تتبع حالة كل سجل
// (origin/status) لكل تصنيف — تُستخدم لعرض شارة "⏳ قيد الاعتماد" وأزرار اعتماد/رفض الأدمن
// في شاشات الخزنة/المخزون/الدورات. تُعبَّأ من استجابات السيرفر (GET/PUT/bulk) ولا تدخل في enc.
let recordMeta = {}; // collection -> { id: { origin: 'general'|'reception', status: 'confirmed'|'pending' } }
// التصنيفات التشغيلية الخاضعة لاعتماد الأدمن (مطابقة APPROVAL_GATED_COLLECTIONS في server.js):
// سجل الاستقبال فيها يبدأ pending بانتظار اعتماد الأدمن.
const APPROVAL_GATED_COLLECTIONS_LOCAL = ['vaultTx', 'bagStock', 'courseSessions'];
// يعيّن حالة سجل محلياً حسب دور المستخدم الحالي — يُستخدم بعد نجاح الرفع المجمّع (استجابته
// لا تحمل origin/status لكل سجل، والاشتقاق هنا مطابق تماماً لمنطق السيرفر).
function _setRecordMetaLocal(collection, id){
  if(!recordMeta[collection]) recordMeta[collection] = {};
  recordMeta[collection][id] = {
    origin: SERVER_AUTH_ROLE === 'reception' ? 'reception' : 'general',
    status: (SERVER_AUTH_ROLE === 'reception' && APPROVAL_GATED_COLLECTIONS_LOCAL.includes(collection)) ? 'pending' : 'confirmed',
  };
}

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
  'journalDE','budgetEntries','suppliers','purchases','manualSalesInvoices','scheduledVaultTx',
];
const _recordVersions = {}; // collection -> Map(id -> version)
const _collectionSyncBaseline = {}; // collection -> Map(id -> json) | null (لسه غير مؤكدة هذه الجلسة)

// يدمج أي تعديلات سجلات لا تزال معلّقة محلياً (سُجّلت أثناء انقطاع اتصال ولم تُرفع بعد) في
// القائمة المعروضة — حتى تظل ظاهرة فوراً ولا تختفي من الشاشة بينما الاتصال غير مستقر. عمداً
// لا نلمس baseline ولا أرقام النسخ لهذه الـids (يبقى الحال كما على السيرفر أو غير موجود)، حتى
// يكتشف مسار الحفظ الفرق ويعيد محاولة الرفع لاحقاً.
async function _mergePendingRecordsIntoList(collection, list){
  const stillPending = (await _pendingRecordReadAll()).filter(p=>p.collection===collection);
  for(const p of stillPending){
    if(p.op === 'delete'){
      const idx = list.findIndex(x=>x.id===p.id);
      if(idx>=0) list.splice(idx,1);
      continue;
    }
    try{
      const plain = await _decryptOrFail(p.enc);
      const obj = JSON.parse(plain);
      const idx = list.findIndex(x=>x.id===p.id);
      if(idx>=0) list[idx] = obj; else list.push(obj);
    }catch(e){ /* تعذّر فك تشفير تعديل معلّق تالف محلياً */ }
  }
  return list;
}

// ---- لقطات محلية مشفّرة (راجع core-utils.js: RECORDS_SNAP_PREFIX/CLIENTS_SNAP_PREFIX) ----
// الهدف المزدوج: (أ) فتح سريع من آخر بيانات مؤكدة بدل شاشة فارغة، و(ب) إغلاق نافذة "التعديل
// قبل اكتمال المزامنة الخلفية" التي كانت تُبنى على مصفوفة فارغة فتُكتب فوق البيانات الحقيقية.
async function _persistRecordsSnap(collection, list, baseline, versions, meta){
  try{
    const items = Array.isArray(list) ? list.filter(x=>x && x.id) : [];
    const baselinePairs = [];
    if(baseline) for(const [id, json] of baseline) baselinePairs.push([id, json]);
    const versionPairs = [];
    if(versions) for(const [id, v] of versions) versionPairs.push([id, v]);
    const metaPairs = [];
    if(meta) for(const [id, m] of Object.entries(meta)) metaPairs.push([id, m]);
    await _recordsSnapWrite(RECORDS_SNAP_PREFIX + collection, items, baselinePairs, versionPairs, metaPairs);
  }catch(e){ console.error('[StorageSync] _persistRecordsSnap failed:', collection, e); }
}
// حفظ مؤجّل (debounce) للقطة — تُستدعى بعد الحفظ على السيرفر. تمرير الدوال بدل القيم المباشرة
// حتى تُقرأ أحدث حالة لحظة التنفيذ الفعلي (بعد أي تعديلات لاحقة)، مع تجنّب تشفير التصنيف كاملاً
// عند كل حفظ سطر واحد.
const _snapPersistTimers = {};
function _scheduleRecordsSnapPersist(collection, getList, getBaseline, getVersions){
  const timerKey = RECORDS_SNAP_PREFIX + collection;
  clearTimeout(_snapPersistTimers[timerKey]);
  _snapPersistTimers[timerKey] = setTimeout(()=>{
    _snapPersistTimers[timerKey] = null;
    try{ _persistRecordsSnap(collection, getList(), getBaseline(), getVersions(), recordMeta[collection]); }catch(e){ console.error('[StorageSync] scheduled records snap persist failed:', collection, e); }
  }, 1200);
}
function _clientsSnapKey(){
  return CLIENTS_SNAP_PREFIX + (currentUser || SERVER_AUTH_USERNAME || 'غير معروف');
}
async function _persistClientsSnap(list, baseline, versions, meta){
  try{
    const items = Array.isArray(list) ? list.filter(c=>c && c.id) : [];
    const baselinePairs = [];
    if(baseline) for(const [id, json] of baseline) baselinePairs.push([id, json]);
    const versionPairs = [];
    if(versions){ for(const id of Object.keys(versions)) versionPairs.push([id, versions[id]]); }
    const metaPairs = [];
    if(meta) for(const [id, m] of Object.entries(meta)) metaPairs.push([id, m]);
    await _recordsSnapWrite(_clientsSnapKey(), items, baselinePairs, versionPairs, metaPairs);
  }catch(e){ console.error('[StorageSync] _persistClientsSnap failed:', e); }
}
function _scheduleClientsSnapPersist(){
  const timerKey = CLIENTS_SNAP_PREFIX + 'clients';
  clearTimeout(_snapPersistTimers[timerKey]);
  _snapPersistTimers[timerKey] = setTimeout(()=>{
    _snapPersistTimers[timerKey] = null;
    try{ _persistClientsSnap(clients, _clientsSyncBaseline, _clientRecordVersions, clientRecordMeta); }catch(e){ console.error('[StorageSync] scheduled clients snap persist failed:', e); }
  }, 1200);
}
// بعد تحميل كامل ناجح من السحابة: تحديث كل اللقطات دفعة واحدة حتى يبدأ أي فتح تالٍ (cacheOnly)
// من آخر حالة مؤكدة. القائمة في اللقطة تُبنى من الـ baseline (آخر ما تأكّد على السيرفر) وليس من
// مصفوفة الذاكرة، حتى لا تُحفظ عناصر بلا id لا يمكن تتبّعها فعلياً.
async function _persistAllSnapshotsAfterLoad(){
  try{ await _persistClientsSnap(clients, _clientsSyncBaseline, _clientRecordVersions, clientRecordMeta); }catch(e){}
  for(const c of ALLOWED_COLLECTIONS_LOCAL){
    const baseline = _collectionSyncBaseline[c];
    if(!baseline) continue;
    const list = [];
    for(const json of baseline.values()){ try{ const obj = JSON.parse(json); if(obj && obj.id) list.push(obj); }catch(e){} }
    try{ await _persistRecordsSnap(c, list, baseline, _recordVersions[c], recordMeta[c]); }catch(e){}
  }
}

async function fetchAllRecordsGeneric(collection){
  await flushPendingRecordWrites().catch(()=>{});
  // المسار الجديد: جلب "الفروق فقط" (لا ننزّل الجدول كاملاً إطلاقاً إلا عند الضرورة) لتسريع
  // المزامنة وتقليل استهلاك البيانات. أي مشكلة هنا (لا لقطة محلية، خطأ شبكة، سيرفر قديم لا يدعم
  // endpoints الجديدة، أو عدد تغييرات كبير) → نَمِر تلقائياً للمسار الكامل الأصلي بالأسفل، أي أن
  // التحميل الكامل يظل خطّ الرجعة الدائم المضمون. لا يُمكن أن يُنتج هذا تعارضاً مع التخزين/النسخ.
  try{
    const delta = await _fetchDeltaRecords(collection);
    if(delta) return delta;
  }catch(e){ /* نكمل بالمسار الكامل */ }
  const res = await serverFetch(`/api/records/${encodeURIComponent(collection)}`);
  if(!res.ok) throw new Error('تعذّر جلب بيانات ' + collection);
  const data = await res.json();
  const list = [];
  const baseline = new Map();
  const versions = new Map();
  const metaMap = {};
  for(const r of (data.records||[])){
    versions.set(r.id, r.version);
    metaMap[r.id] = { origin: r.origin || 'general', status: r.status || 'confirmed' };
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
  recordMeta[collection] = metaMap;
  // نفس خط الأمان الموجود فى fetchAllClientRecords بالضبط: أي سطر لسه معلّق فعلياً (بدون اتصال
  // حقيقي حتى بعد محاولة الرفع أعلاه) يظل ظاهراً في الذاكرة بدل اختفائه فجأة من الشاشة.
  await _mergePendingRecordsIntoList(collection, list);
  // تحديث اللقطة المحلية حتى يبدأ أي فتح تالٍ (cacheOnly) من هذه الحالة المؤكدة + الـ baseline
  await _persistRecordsSnap(collection, list, baseline, versions, metaMap);
  return { list, baseline };
}

// ==== جلب الفروض فقط (delta) ====
// يعتمد على لقطة محلية مؤكدة + أرقام النسخ المحلية: يستعلم عن أرقام النسخ الخفيفة من السيرفر
// عبر /versions، ثم ينزّل فقط السجلات الجديدة/المتغيّرة عبر /records?ids=، ويحذف المحذوفة.
// يرجع كائناً بنفس شكل fetchAllRecordsGeneric { list, baseline } أو يُرمي خطأ ليتولى المسار
// الكامل. لا يمسّ baseline/أرقام النسخ للسجلات الثابتة، ولا يغيّر صيغة التخزين/النسخ أبداً.
async function _fetchDeltaRecords(collection){
  const known = _recordVersions[collection];
  if(!known || known.size === 0) throw new Error('لا توجد أرقام نسخ محلية — تحميل كامل');
  const snap = await _recordsSnapRead(RECORDS_SNAP_PREFIX + collection);
  if(!snap || !Array.isArray(snap.list) || snap.list.length === 0) throw new Error('لا توجد لقطة محلية — تحميل كامل');

  const vr = await serverFetch(`/api/records/${encodeURIComponent(collection)}/versions`);
  if(!vr.ok) throw new Error('تعذّر جلب أرقام الإصدارات');
  const vd = await vr.json().catch(()=>null);
  if(!vd || !Array.isArray(vd.pairs)) throw new Error('استجابة أرقام إصدارات غير صالحة');

  const serverVers = new Map(vd.pairs);
  const serverIds = new Set(vd.pairs.map(p=>p[0]));
  const removedIds = [];
  for(const id of known.keys()) if(!serverIds.has(id)) removedIds.push(id);

  const fetchIds = [];
  for(const id of serverIds){
    if(!known.has(id) || known.get(id) !== serverVers.get(id)) fetchIds.push(id);
  }
  // حد أمان لطول عنوان الـ URL: عدد تغييرات كبير جداً لا يستفيد من الـ delta على أي حال.
  if(fetchIds.length > 500) throw new Error('تغييرات كثيرة جداً — تحميل كامل');

  const nothingChanged = fetchIds.length === 0 && removedIds.length === 0;
  const oldItems = snap.list;
  const snapBaseline = new Map();
  for(const pair of (snap.baselinePairs||[])){ if(pair && pair.length===2) snapBaseline.set(pair[0], pair[1]); }

  const finalItems = [];
  const baseline = new Map();
  const versions = new Map();
  const metaMap = {};

  // جولة أساسية: كل عناصر اللقطة المحفوظة (غير المحذوفة على السيرفر) + أرقام نسخها/باس لاين
  for(const it of oldItems){
    if(!it || !it.id) continue;
    if(removedIds.includes(it.id)) continue;
    finalItems.push(it);
    const j = snapBaseline.get(it.id);
    if(j !== undefined) baseline.set(it.id, j);
    const v = known.get(it.id);
    if(v !== undefined) versions.set(it.id, v);
  }

  if(nothingChanged){
    // لا تغيير إطلاقًا — القائمة كاملة جاهزة من اللقطة.
    _recordVersions[collection] = versions;
    if(!recordMeta[collection]) recordMeta[collection] = {};
    for(const pair of (snap.metaPairs||[])){ if(pair && pair.length===2 && pair[0] && pair[1] && pair[1].status) recordMeta[collection][pair[0]] = { origin: pair[1].origin || 'general', status: pair[1].status }; }
    await _mergePendingRecordsIntoList(collection, finalItems);
    await _persistRecordsSnap(collection, finalItems, baseline, versions, recordMeta[collection]);
    return { list: finalItems, baseline };
  }

  // ننزل فقط السجلات المعبّرة/الجديدة.
  if(fetchIds.length){
    const res = await serverFetch(`/api/records/${encodeURIComponent(collection)}?ids=${encodeURIComponent(fetchIds.join(','))}`);
    if(!res.ok) throw new Error('تعذّر جلب السجلات المتعبّرة');
    const data = await res.json().catch(()=>null);
    if(!data || !Array.isArray(data.records)) throw new Error('استجابة سجلات غير صالحة');
    // أمان: لو السيرفر اعاد بكل السجلات (لا يعرف ids= / سيرفر قديم) بعدد أكبر بوضوح مما طلبنا،
    // نعود للتحميل الكامل بدل الاعتماد على تخمين.
    if(data.records.length > fetchIds.length * 2 + 5) throw new Error('السيرفر لا يدعم جلب الفروق — تحميل كامل');
    const byId = new Map();
    for(const r of data.records){
      byId.set(r.id, r);
      versions.set(r.id, Number.isInteger(r.version) ? r.version : 0);
      if(r.origin || r.status) metaMap[r.id] = { origin: r.origin || 'general', status: r.status || 'confirmed' };
    }
    for(const id of fetchIds){
      const r = byId.get(id);
      if(!r) continue;
      let plain;
      try{ plain = await _decryptOrFail(r.enc); }catch(e){ throw e; }
      try{
        const obj = JSON.parse(plain);
        // نتأكد أنها قائمة القائمة: لو كانت هي نفسها موجودة مسبقًا من اللقطة نستبدل بقبل النسخة.
        if(!removedIds.includes(id)){
          const idx = finalItems.findIndex(x=>x.id===id);
          if(idx>=0) finalItems[idx] = obj; else finalItems.push(obj);
        }
        baseline.set(id, plain);
      }catch(e){ /* سجل تالف — نتجاهله */ }
    }
  }

  _recordVersions[collection] = versions;
  if(!recordMeta[collection]) recordMeta[collection] = {};
  Object.assign(recordMeta[collection], metaMap);
  await _mergePendingRecordsIntoList(collection, finalItems);
  await _persistRecordsSnap(collection, finalItems, baseline, versions, recordMeta[collection]);
  return { list: finalItems, baseline };
}

async function saveOneRecordGeneric(collection, id, plainJson){
  _activeRecordSaves++;
  updateOfflineIndicator();
  try{
    const enc = await encryptValue(plainJson);
    if(!_recordVersions[collection]) _recordVersions[collection] = new Map();
    const knownVersion = _recordVersions[collection].get(id) || 0;
    let res;
    try{
      res = await serverFetch(`/api/records/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enc, version: knownVersion }),
      });
    }catch(e){
      // فشل اتصال فعلي — نسجّله معلّقاً بدل ما يضيع صامتاً (نفس منطق saveOneClientRecord بالضبط).
      await _pendingRecordPut(collection, id, { op:'upsert', enc });
      return null;
    }
    if(res.status === 409){
      const conflict = await res.json().catch(()=>({}));
      _recordVersions[collection].set(id, conflict.currentVersion || knownVersion);
      showToast('⚠️ ' + (conflict.error || 'تعارض فى الحفظ: عدّل شخص آخر نفس البيانات — يرجى تحديث الصفحة لمراجعتها'));
      return false;
    }
    if(!res.ok){
      await _pendingRecordPut(collection, id, { op:'upsert', enc });
      return null;
    }
    const data = await res.json();
    _recordVersions[collection].set(id, data.version || 0);
    if(data.origin && data.status){
      if(!recordMeta[collection]) recordMeta[collection] = {};
      recordMeta[collection][id] = { origin: data.origin, status: data.status };
    }
    await _pendingRecordDelete(collection, id);
    return true;
  }catch(e){ return null; }
  finally{ _activeRecordSaves--; updateOfflineIndicator(); }
}

async function deleteOneRecordGeneric(collection, id){
  _activeRecordSaves++;
  updateOfflineIndicator();
  try{
    const knownVersion = (_recordVersions[collection] && _recordVersions[collection].get(id)) || 0;
    let res;
    try{
      res = await serverFetch(`/api/records/${encodeURIComponent(collection)}/${encodeURIComponent(id)}?version=${knownVersion}`, { method: 'DELETE' });
    }catch(e){
      await _pendingRecordPut(collection, id, { op:'delete' });
      return null;
    }
    if(res.status === 409){
      // عُدِّل/تغيّر السجل على السيرفر من جهاز آخر بعد آخر مشاهدة — لا يجوز حذفه (حذف بيانات أحدث).
      // نُحدّث رقم النسخة المحلي ونترك السجل على السيرفر كما هو، وننبّه المستخدم (نفس معاملة تعارض PUT).
      const conflict = await res.json().catch(()=>({}));
      if(_recordVersions[collection]) _recordVersions[collection].set(id, conflict.currentVersion || knownVersion);
      showToast('⚠️ ' + (conflict.error || 'تعارض في الحذف: عُدِّلت هذه البيانات بعد آخر مشاهدة — يرجى تحديث الصفحة وإعادة الحذف'));
      return false;
    }
    // لازم نتحقق من res.ok: لو السيرفر رفض الحذف (مثال: 429 بسبب rate limiting، أو أي خطأ آخر)،
    // السجل لسه فعلياً موجود على السيرفر ولا يجوز اعتباره محذوفاً محلياً — وإلا سيرجع السجل
    // "المحذوف" فى المرة القادمة اللي يتحمّل فيها التصنيف من السيرفر، بينما البرنامج فاكر إنه اتمسح.
    if(!res.ok){
      await _pendingRecordPut(collection, id, { op:'delete' });
      return null;
    }
    if(_recordVersions[collection]) _recordVersions[collection].delete(id);
    if(recordMeta[collection]) delete recordMeta[collection][id];
    await _pendingRecordDelete(collection, id);
    return true;
  }catch(e){ return null; }
  finally{ _activeRecordSaves--; updateOfflineIndicator(); }
}

// حذف عدة سجلات دفعة واحدة (طلب واحد) بدل طلب DELETE منفصل لكل id — يُستخدم لو عدد السجلات
// المطلوب حذفها كبير (نفس فكرة bulkUploadRecordsGeneric بالضبط لكن للحذف)، لتفادي ضرب سقف
// storageLimiter بإرسال عشرات/مئات الطلبات المتتالية فى ثوانٍ قليلة (كان بيرجع 429 لمعظمها).
async function bulkDeleteRecordsGeneric(collection, ids){
  const CHUNK = 1000;
  const failedIds = [];
  for(let i=0;i<ids.length;i+=CHUNK){
    const chunk = ids.slice(i, i+CHUNK);
    try{
      const res = await serverFetch(`/api/records/${encodeURIComponent(collection)}/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ ids: chunk }),
      });
      if(!res.ok){
        failedIds.push(...chunk);
        // نسجّل كل سطر فشل حذفه فى طابور المعلّقات أيضاً — خط رجعة إضافي حتى لو الاستدعاء لم
        // يُعِد محاولة الحذف بنفسه لاحقاً (بعض الاستدعاءات القديمة كانت تكتفي بترك الـid فى baseline).
        await Promise.all(chunk.map(id=> _pendingRecordPut(collection, id, { op:'delete' })));
        continue;
      }
      for(const id of chunk){
        if(_recordVersions[collection]) _recordVersions[collection].delete(id);
        if(recordMeta[collection]) delete recordMeta[collection][id];
        await _pendingRecordDelete(collection, id);
      }
    }catch(e){
      failedIds.push(...chunk);
      await Promise.all(chunk.map(id=> _pendingRecordPut(collection, id, { op:'delete' })));
    }
  }
  return failedIds; // القوائم التي فشل حذفها فعلياً (تبقى فى الـ baseline ليُعاد المحاولة لاحقاً)
}

async function bulkUploadRecordsGeneric(collection, list){
  const CHUNK = 1000;
  if(!_recordVersions[collection]) _recordVersions[collection] = new Map();
  const versions = _recordVersions[collection];
  const allConflictIds = [];
  for(let i=0;i<list.length;i+=CHUNK){
    const chunk = list.slice(i, i+CHUNK);
    const records = [];
    for(const item of chunk) records.push({ id: item.id, enc: await encryptValue(JSON.stringify(item)), version: versions.get(item.id) || 0 });
    for(const r of records){ if(typeof r.enc !== 'string' || !r.enc || r.enc === 'undefined') throw new Error('تعذّر تشفير سجل من "' + collection + '" — أُوقف الرفع حفاظاً على بياناتك (حدّث الصفحة وأعد المحاولة)'); }
    let res;
    try{
      res = await serverFetch(`/api/records/${encodeURIComponent(collection)}/bulk-migrate`, {
        method: 'POST',
        body: JSON.stringify({ records }),
      });
    }catch(e){
      // فشل اتصال فعلي أثناء رفع الدفعة — نسجّل كل سطر فيها فى طابور المعلّقات فردياً (بدل
      // الاعتماد فقط على نسخة احتياطية كاملة للتصنيف قد يتم تجاهلها لاحقاً لو رجع النظام
      // الجديد بأي بيانات ولو ناقصة عند أول تحميل قادم)، ثم نرفع نفس الاستثناء كالسابق تماماً
      // ليتعامل معه المستدعي (saveCollectionGeneric) بخط رجعته المعتاد.
      await Promise.all(records.map(r=> _pendingRecordPut(collection, r.id, { op:'upsert', enc: r.enc })));
      throw e;
    }
    if(!res.ok){
      await Promise.all(records.map(r=> _pendingRecordPut(collection, r.id, { op:'upsert', enc: r.enc })));
      throw new Error('تعذّر رفع دفعة من بيانات ' + collection);
    }
    const data = await res.json().catch(()=>({}));
    // تحديث النسخ المعروفة محلياً لكل سجل نجح. أما السجلات التي رفضها السيرفر بتعارض نسخ
    // (conflicts مع currentVersion) فتُحسم عبر مقارنة محتوى آمنة (انظر _safeToApplyOnConflict):
    // فقط إن أمكن إثبات أن محتوى السيرفر ما زال مطابقاً لأساس تعديلنا (انحراف تتبع نسخ محلي:
    // لقطة قديمة أو مسح/استعادة جزئية صفّر النسخ المحلية) نعيد الرفع مرة واحدة بالنسخة الحالية.
    // لو كان تعارضاً حقيقياً (شخص آخر غيّر السجل فعلاً، أو تعذّر التحقق) لا نكتب فوقه إطلاقاً —
    // نُسقطه ونُحدّث النسخة المحلية ونبلّغ المستخدم (نفس معاملة تعارضات kv).
    const conflictIdSet = new Set((data.conflicts||[]).map(c=>c.id));
    for(const item of chunk){
      if(!conflictIdSet.has(item.id)){
        versions.set(item.id, (versions.get(item.id)||0) + 1);
        _setRecordMetaLocal(collection, item.id);
        await _pendingRecordDelete(collection, item.id);
      }
    }
    const conflicted = data.conflicts || [];
    const stillConflictIds = [];
    if(conflicted.length){
      // نفصل المتعارضين: (1) من الآمن إعادة رفعه تلقائياً (محتوى السيرفر مطابق لأساس تعديلنا —
      // انحراف تتبع نسخ محلي فقط، مقارنة عبر _safeToApplyOnConflict)، و(2) تعارض حقيقي (غيّره شخص
      // آخر أو تعذّر التحقق) لا نكتب فوقه أبداً — نُسقطه ونحدّث النسخة المحلية ونبلّغ المستخدم.
      const safeRetryRecords = [];
      for(const c of conflicted){
        const item = chunk.find(x=>x.id===c.id);
        if(!item) continue;
        if(await _safeToApplyOnConflict(c, collection, false, c.id)){
          safeRetryRecords.push({ id: item.id, enc: item.enc, version: c.currentVersion || 0 });
        }else{
          stillConflictIds.push(c.id);
          versions.set(c.id, c.currentVersion || 0);
          await _pendingRecordDelete(collection, c.id);
        }
      }
      if(safeRetryRecords.length){
        let retryRes = null;
        try{
          retryRes = await serverFetch(`/api/records/${encodeURIComponent(collection)}/bulk-migrate`, {
            method: 'POST',
            body: JSON.stringify({ records: safeRetryRecords }),
          });
        }catch(e){ /* لسه بدون اتصال فعلياً — تُحسم لاحقاً عبر طابور المعلّقات */ }
        if(retryRes && retryRes.ok){
          const retryData = await retryRes.json().catch(()=>({}));
          const retryConflicted = retryData.conflicts || [];
          for(const rc of retryConflicted) versions.set(rc.id, rc.currentVersion || 0);
          for(const r of safeRetryRecords){
            if(retryConflicted.some(rc=>rc.id===r.id)){
              // تغيّر حقيقي أثناء إعادة المحاولة — نتركه متعارضاً (لا كتابة فوق)
              stillConflictIds.push(r.id);
            }else{
              versions.set(r.id, (r.version||0) + 1);
              _setRecordMetaLocal(collection, r.id);
              await _pendingRecordDelete(collection, r.id);
            }
          }
        }else{
          // فشل الاتصال أثناء إعادة المحاولة — نسجّل السجلات معلّقة ليُعاد رفعها لاحقاً تلقائياً
          await Promise.all(safeRetryRecords.map(r=> _pendingRecordPut(collection, r.id, { op:'upsert', enc: r.enc })));
        }
      }
    }
    if(stillConflictIds.length){
      allConflictIds.push(...stillConflictIds);
      showToast(`⚠️ تعذّر رفع ${stillConflictIds.length} سجل من "${collection}" بسبب تعديل آخر لنفس البيانات — يرجى تحديث الصفحة ومراجعتها`);
    }
  }
  return allConflictIds; // معرّفات السجلات التي فشل رفعها فعلياً — لا يجوز اعتبارها مُتزامنة
}

// تحميل تصنيف واحد كامل: يحاول النظام الجديد (سجل فردي لكل عنصر) أولاً؛ لو رجع فارغاً فعلياً
// يتحقق من وجود بيانات قديمة (كتلة واحدة تحت نفس الاسم فى kv_store) ويرحّلها لمرة واحدة فقط —
// تماماً بنفس منطق تحميل/ترحيل العملاء أعلاه (fetchAllClientRecords). فى وضع cacheOnly (فتح فورى
// من الجهاز بدون انتظار الشبكة) نستخدم آخر نسخة قديمة محفوظة محلياً إن وُجدت، والمزامنة الحقيقية
// تتم لاحقاً فى الخلفية (نفس فكرة تحميل العملاء بالضبط).
async function loadCollectionGeneric(collection, cacheOnly){
  if(cacheOnly){
    // عرض فوري من آخر لقطة محلية مؤكدة (نظام السجلات المستقلة) بدل شاشة فارغة. اللقطة تحمل
    // أيضاً الـ baseline وأرقام النسخ، فيُبنى أي تعديل لاحق (قبل اكتمال المزامنة الخلفية) على
    // آخر حالة حقيقية عبر نفس نظام السجلات المستقلة — لا على مصفوفة فارغة عبر خط رجعة "كتلة
    // قديمة" في kv_store (مخزن لا يُقرأ لاحقاً، وكان التعديل المبنى عليه يبدو وكأنه "فُقد" عند
    // أول تحميل حقيقي من السحابة بعد إعادة الفتح). لو لا توجد لقطة بعد (أول فتح على هذا الجهاز)
    // نبدأ فارغاً (baseline null) ونترك backgroundSyncCheck يملأ الشاشة بالبيانات الصحيحة فوراً.
    const snap = await _recordsSnapRead(RECORDS_SNAP_PREFIX + collection);
    if(snap){
      const list = Array.isArray(snap.list) ? snap.list : [];
      const baseline = new Map();
      for(const pair of (snap.baselinePairs||[])){ if(pair && pair.length === 2) baseline.set(pair[0], pair[1]); }
      if(!_recordVersions[collection]) _recordVersions[collection] = new Map();
      for(const pair of (snap.versionPairs||[])){ if(pair && pair.length === 2) _recordVersions[collection].set(pair[0], pair[1]); }
      // استعادة الحالات (origin/status) لكل سجل من اللقطة — حتى تبقى سجلات "قيد الاعتماد"
      // مستبعدة من إجماليات الشاشات (الخزنة/المخزون/الدورات) بعد إعادة فتح البرنامج أيضاً،
      // وليس فقط أثناء الجلسة الحية، فبدونها تُحسب كل سجلات الاستقبال المعلّقة كمعتمدة فيبدأ
      // المخزون/الرصيد يظهر أعلى من الحقيقي بعد إعادة التحميل.
      if(snap.metaPairs && !recordMeta[collection]) recordMeta[collection] = {};
      for(const pair of (snap.metaPairs||[])){ if(pair && pair.length === 2 && pair[0] && pair[1] && pair[1].status) recordMeta[collection][pair[0]] = { origin: pair[1].origin || 'general', status: pair[1].status }; }
      // أي تعديلات ما زالت معلّقة محلياً (لم تُرفع بعد) يجب أن تظهر أيضاً في هذه الشاشة
      await _mergePendingRecordsIntoList(collection, list);
      return { list, baseline };
    }
    return { list: [], baseline: null };
  }
  try{
    const { list, baseline } = await fetchAllRecordsGeneric(collection);
    if(list.length){
      // نفس تصحيح 'clients' بالضبط: نجهّز رقم نسخة المفتاح القديم (auditLog, bagStock, journalDE...)
      // فى الخلفية، وإلا أي حفظ احتياطي لاحق عبر window.storage.set (خط الرجعة فى saveCollectionGeneric
      // عند فشل الشبكة) سيرسل نسخة صفر دائماً ويُرفض بخطأ 409 رغم عدم وجود تعارض حقيقي.
      window.storage.primeKeyVersion(collection).catch(()=>{});
      return { list, baseline };
    }
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
    // لو الفشل فك تشفير حقيقي (السجلات على السيرفر مشفَّرة فعلاً بمفتاح لا يفكّه هذا الجهاز) —
    // لا يجوز معاملته كأنه "لا توجد بيانات": أي قيمة فارغة تُستخدم لاحقاً كأساس لأي عملية حفظ
    // فتُكتب فوق بيانات السيرفر الحقيقية وتمحوها لكل المستخدمين (نفس خطر _decryptOrFail أعلاه).
    // نرمي الخطأ (موسوماً isDecryptFailure) ليتعامل معه loadData/loadGeneric بالشاشة القاتلة.
    if(e && e.isDecryptFailure) throw e;
    // تعذّر الوصول لنظام السجلات الجديد فعلياً (انقطاع اتصال) — نرجع لآخر نسخة محفوظة محلياً.
    try{
      const r = await window.storage.get(collection, false, true);
      const list = (r && r.value) ? JSON.parse(r.value) : [];
      return { list: Array.isArray(list) ? list : [], baseline: null };
    }catch(e2){
      // خط الرجعة نفسه فشل بفك تشفير حقيقي أيضاً — لا يُبتلع لنفس السبب الحرج تماماً.
      if(e2 && e2.isDecryptFailure) throw e2;
      return { list: [], baseline: null };
    }
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
      // حدّ التجميع مُخفّض (5 بدل 20): التعديلات المتعددة تُرفع في طلب واحد مجمّع بدل طلب منفصل
      // لكل سجل — يقلّل عدد الـ round-trips وضغط الـ rate limiter، ويسرّع الحفظ الفعلي.
      if(changed.length > 5){
        try{
          const conflictIds = await bulkUploadRecordsGeneric(collection, changed.map(x=>x.item));
          const conflictSet = new Set(conflictIds);
          changed.forEach(x=> { if(!conflictSet.has(x.item.id)) baseline.set(x.item.id, x.json); });
        }catch(e){ anyNetworkFailure = true; }
      }else{
        for(const {item, json} of changed){
          const ok = await saveOneRecordGeneric(collection, item.id, json);
          if(ok) baseline.set(item.id, json);
          else if(ok === null) anyNetworkFailure = true;
        }
      }
      if(removedIds.length > 5){
        // حذف كثير دفعة واحدة (تنظيف/إعادة ضبط جزئي) — طلب واحد مُجمَّع بدل طلب DELETE منفصل
        // لكل سجل، لتفادي ضرب سقف الـ rate limiter بعشرات/مئات الطلبات المتتالية.
        const failedIds = await bulkDeleteRecordsGeneric(collection, removedIds);
        for(const id of removedIds) if(!failedIds.includes(id)) baseline.delete(id);
        if(failedIds.length) anyNetworkFailure = true;
      }else{
        for(const id of removedIds){
          const ok = await deleteOneRecordGeneric(collection, id);
          if(ok) baseline.delete(id);
          else anyNetworkFailure = true;
        }
      }
      if(anyNetworkFailure){
        // فشل اتصال فعلي أثناء رفع بعض السجلات. كل دالة حفظ سجل (فردية/مجمّعة) سجّلت ما فشل
        // في طابور pendingRecords قبل إرجاع الفشل، فلا حاجة لأي "خط رجعة كتلة قديمة" في kv_store
        // إطلاقاً — ذلك المسار كان يكتب في مخزن لا يُقرأ من جديد (أي سجلات تبقى على السيرفر في
        // نظام السجلات المستقلة تُحجب الكتلة القديمة)، وهو السبب الجذري لفقدان البيانات عند
        // إعادة الفتح. نُبطل الـ baseline لإعادة مزامنة كاملة آمنة عند أول اتصال ناجح.
        _collectionSyncBaseline[collection] = null;
      }
      _scheduleRecordsSnapPersist(collection, ()=> arr, ()=> _collectionSyncBaseline[collection], ()=> _recordVersions[collection]);
      return;
    }
    // خط الرجعة: المزامنة مع نظام السجلات المستقلة لم تتأكد بعد هذه الجلسة (أول تحميل فاشل، أو
    // انقطاع أثناء آخر محاولة). بدل "الكتلة القديمة" في kv_store (مخزن لا يُقرأ لاحقاً — سبب
    // فقدان البيانات)، نرفع كل العناصر عبر نظام السجلات نفسه ونُثبّت الـ baseline من النتيجة.
    const listToUpload = arr.filter(x=>x && x.id);
    try{
      const conflictIds = await bulkUploadRecordsGeneric(collection, listToUpload);
      const conflictSet = new Set(conflictIds);
      const newBaseline = new Map();
      for(const item of listToUpload){
        const json = JSON.stringify(item);
        if(!conflictSet.has(item.id)) newBaseline.set(item.id, json);
      }
      _collectionSyncBaseline[collection] = newBaseline;
    }catch(e){
      // فشل اتصال فعلي — سجّلت السجلات في طابور pendingRecords داخل bulkUploadRecordsGeneric،
      // ويبقى الـ baseline null لتُعاد المزامنة الكاملة عند أول اتصال ناجح.
      _collectionSyncBaseline[collection] = null;
    }
    _scheduleRecordsSnapPersist(collection, ()=> arr, ()=> _collectionSyncBaseline[collection], ()=> _recordVersions[collection]);
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

// بصمة SHA-256 (hex) لنص ما — تُستخدم لمطابقة أرقام الهوية المرسلة كبصمات فقط من الخادم (بدل
// استقبال النص الصريح لأرقام كل عملاء الشركة لكل مستخدم مصادق). نفس الخوارزمية المستخدمة على
// الخادم بالضبط. تعتمد على crypto.subtle المتاح في السياقات الآمنة (https أو file://) — لو غير
// متاح (http على شبكة محلية مثلاً) تُرمى لتسقط منطقيًا إلى الفحص المحلي فقط كخط رجعة آمن.
async function sha256Hex(str){
  if(!crypto?.subtle) throw new Error('crypto.subtle غير متاح');
  const buf = new TextEncoder().encode(str);
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// يجلب فقط بصمات أرقام هوية العملاء الموجودة بالفعل فى كل النظام (بدل الأرقام النصية الصريحة،
// لمُنع نسخ البيانات الشخصية) لفحص التكرار قبل الحفظ — يعمل حتى لمستخدم الاستقبال المعزول عادةً
// عن رؤية باقي بيانات العملاء، لأن هذه النقطة تحديداً مصمَّمة لترجع البصمات بغض النظر عن
// origin/status/created_by (راجع تعليق الخادم). يرجع Map من بصمة رقم الهوية -> معرّف السجل (id)
// الداخلي، لتمييز "نفس العميل الذي أعدّله الآن" عن "عميل آخر يملك نفس الرقم فعلاً".
async function fetchAllClientIds(timeoutMs){
  try{
    const res = await serverFetch('/api/client-records/ids', timeoutMs ? { timeout: timeoutMs } : {});
    if(!res.ok) return null; // تعذّر السؤال عن الخادم — المستدعي يقرر خط الرجعة (فحص محلي فقط)
    const data = await res.json();
    const map = new Map();
    (data.ids||[]).forEach(row=>{ if(row.clientIdHash) map.set(row.clientIdHash, row.id); });
    return map;
  }catch(e){ return null; }
}

// نفس فكرة _fetchDeltaRecords بالضبط (السطر أعلاه) لكن لنظام العملاء المستقل (_clientRecordVersions
// كائن عادي وليس Map، وclientRecordMeta/_persistClientsSnap بدل نظيراتهم العامة) — كان هذا تحديداً
// السبب الأكبر لاستهلاك حصة نقل بيانات نيون الشهرية: أي عميل واحد يتغيّر فى أي مكان كان يستوجب
// إعادة تنزيل جدول العملاء بالكامل (كل عميل مسجَّل، مهما كان عددهم) على كل جهاز مفتوح خلال أقرب
// دورة فحص (كل دقيقتين) — لا فرق بينه وبين المشكلة نفسها التي عولجت أصلاً فى _fetchDeltaRecords
// للتصنيفات العامة (الخزنة/المخزون/الدورات...)، فقط لم تكن العملاء موصولة بنفس الآلية من قبل.
async function _fetchDeltaClientRecords(){
  const knownIds = Object.keys(_clientRecordVersions || {});
  if(!knownIds.length) throw new Error('لا توجد أرقام نسخ محلية — تحميل كامل');
  const snap = await _recordsSnapRead(_clientsSnapKey());
  if(!snap || !Array.isArray(snap.list) || snap.list.length === 0) throw new Error('لا توجد لقطة محلية — تحميل كامل');

  const vr = await serverFetch('/api/client-records/versions');
  if(!vr.ok) throw new Error('تعذّر جلب أرقام إصدارات العملاء');
  const vd = await vr.json().catch(()=>null);
  if(!vd || !Array.isArray(vd.pairs)) throw new Error('استجابة أرقام إصدارات غير صالحة');

  const serverVers = new Map(vd.pairs);
  const serverIds = new Set(vd.pairs.map(p=>p[0]));
  const removedIds = [];
  for(const id of knownIds) if(!serverIds.has(id)) removedIds.push(id);

  const fetchIds = [];
  for(const id of serverIds){
    if(!(id in _clientRecordVersions) || _clientRecordVersions[id] !== serverVers.get(id)) fetchIds.push(id);
  }
  // حد أمان لطول عنوان الـ URL: عدد تغييرات كبير جداً لا يستفيد من الـ delta على أي حال.
  if(fetchIds.length > 500) throw new Error('تغييرات كثيرة جداً — تحميل كامل');

  const nothingChanged = fetchIds.length === 0 && removedIds.length === 0;
  const oldItems = snap.list;
  const snapBaseline = new Map();
  for(const pair of (snap.baselinePairs||[])){ if(pair && pair.length===2) snapBaseline.set(pair[0], pair[1]); }

  const finalItems = [];
  const baseline = new Map();
  clientRecordMeta = {};

  for(const it of oldItems){
    if(!it || !it.id) continue;
    if(removedIds.includes(it.id)) continue;
    finalItems.push(it);
    const j = snapBaseline.get(it.id);
    if(j !== undefined) baseline.set(it.id, j);
  }
  for(const pair of (snap.metaPairs||[])){ if(pair && pair.length===2 && pair[0] && pair[1] && pair[1].status && !removedIds.includes(pair[0])) clientRecordMeta[pair[0]] = { origin: pair[1].origin || 'general', status: pair[1].status }; }
  for(const id of removedIds) delete _clientRecordVersions[id];

  if(nothingChanged){
    // لا تغيير إطلاقًا — القائمة كاملة جاهزة من اللقطة، بلا أي نقل بيانات فعلي إضافي.
    await _mergePendingRecordsIntoList('clients', finalItems);
    await _persistClientsSnap(finalItems, baseline, _clientRecordVersions, clientRecordMeta);
    return { list: finalItems, baseline };
  }

  // ننزل فقط سجلات العملاء المتغيّرة/الجديدة.
  if(fetchIds.length){
    const res = await serverFetch(`/api/client-records?ids=${encodeURIComponent(fetchIds.join(','))}`);
    if(!res.ok) throw new Error('تعذّر جلب سجلات العملاء المتغيّرة');
    const data = await res.json().catch(()=>null);
    if(!data || !Array.isArray(data.records)) throw new Error('استجابة سجلات غير صالحة');
    // أمان: لو السيرفر أعاد كل العملاء (لا يعرف ids= / سيرفر قديم) بعدد أكبر بوضوح مما طلبنا،
    // نعود للتحميل الكامل بدل الاعتماد على تخمين.
    if(data.records.length > fetchIds.length * 2 + 5) throw new Error('السيرفر لا يدعم جلب الفروق — تحميل كامل');
    const byId = new Map();
    for(const r of data.records){
      byId.set(r.id, r);
      _clientRecordVersions[r.id] = r.version;
      if(r.origin || r.status) clientRecordMeta[r.id] = { origin: r.origin || 'general', status: r.status || 'confirmed' };
    }
    for(const id of fetchIds){
      const r = byId.get(id);
      if(!r) continue;
      let plain;
      try{ plain = await _decryptOrFail(r.enc); }catch(e){ throw e; }
      try{
        const obj = JSON.parse(plain);
        if(!removedIds.includes(id)){
          const idx = finalItems.findIndex(x=>x.id===id);
          if(idx>=0) finalItems[idx] = obj; else finalItems.push(obj);
        }
        baseline.set(id, plain);
      }catch(e){ /* سجل تالف — نتجاهله */ }
    }
  }

  await _mergePendingRecordsIntoList('clients', finalItems);
  await _persistClientsSnap(finalItems, baseline, _clientRecordVersions, clientRecordMeta);
  return { list: finalItems, baseline };
}

async function fetchAllClientRecords(){
  // نحاول رفع أي تعديلات عملاء معلّقة أولاً (لو النت رجع من تحته) قبل قراءة "الحقيقة" من السيرفر —
  // بدون هذه الخطوة، أي عميل نجح رفعه سابقاً جزئياً فقط كان سيظهر تاني بنسخته القديمة أو يختفي تماماً.
  await flushPendingRecordWrites().catch(()=>{});
  // المسار الجديد: جلب "الفروق فقط" (لا ننزّل جدول العملاء كاملاً إطلاقاً إلا عند الضرورة) بنفس
  // فكرة fetchAllRecordsGeneric تماماً — راجع تعليق _fetchDeltaClientRecords لشرح الأثر. أي مشكلة
  // هنا (لا لقطة محلية، خطأ شبكة، عدد تغييرات كبير...) → نمر تلقائياً للمسار الكامل الأصلي بالأسفل،
  // الذي يظل خطّ الرجعة الدائم المضمون.
  try{
    const delta = await _fetchDeltaClientRecords();
    if(delta) return delta;
  }catch(e){ /* نكمل بالمسار الكامل */ }
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
  // خط الأمان الأخير: أي تعديل عميل لسه معلّق فعلياً بعد محاولة الرفع أعلاه (يعني لسه بدون اتصال
  // حقيقي) لازم يظل ظاهراً فى الذاكرة رغم عدم تأكيده على السيرفر بعد — وإلا هيختفي من الشاشة فوراً
  // رغم إنه محفوظ بأمان محلياً وهيُرفع تلقائياً أول ما الاتصال يرجع. عمداً لا نلمس baseline لهذا الـid
  // (يظل كما جاء من السيرفر أو غير موجود)، حتى يكتشف saveClients الفرق ويعيد محاولة الحفظ لاحقاً.
  await _mergePendingRecordsIntoList('clients', list);
  // تحديث اللقطة المحلية الخاصة بهذا المستخدم (حتى يبدأ أي فتح تالٍ من آخر حالة مؤكدة له)
  await _persistClientsSnap(list, baseline, _clientRecordVersions, clientRecordMeta);
  return { list, baseline };
}

// يحفظ عميلاً واحداً فقط (تسجيل/تعديل). يرجع true لو نجح، false لو رُفض بسبب تعارض حقيقي
// (عدّله شخص آخر بينما هذا الجهاز يعمل بنسخة أقدم)، أو null لو تعذّر الوصول للسيرفر أصلاً
// (بدون إنترنت) — المستدعي فى هذه الحالة يقرر خط الرجعة (راجع saveClients فى ui-framework.js).
async function saveOneClientRecord(client, plainJson){
  _activeRecordSaves++;
  updateOfflineIndicator();
  try{
    const enc = await encryptValue(plainJson);
    let res;
    try{
      res = await serverFetch(`/api/client-records/${encodeURIComponent(client.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enc, version: _clientRecordVersions[client.id] || 0, clientId: client.clientId || '' }),
      });
    }catch(e){
      // فشل اتصال فعلي (مش رفض من السيرفر) — نسجّل هذا العميل فى طابور "سجلات معلّقة" محلياً
      // بدل ما يضيع نهائياً، ويُعاد رفعه تلقائياً لاحقاً (راجع flushPendingRecordWrites) حتى
      // لو المستخدم عمل ريفرش أو قفل الصفحة قبل ما الاتصال يرجع.
      await _pendingRecordPut('clients', client.id, { op:'upsert', enc, clientId: client.clientId || '' });
      return null;
    }
    if(res.status === 409){
      const conflict = await res.json().catch(()=>({}));
      _clientRecordVersions[client.id] = conflict.currentVersion || _clientRecordVersions[client.id];
      showToast(`⚠️ تعارض فى حفظ بيانات العميل "${client.name||client.id}": عدّله شخص آخر من جهاز آخر — يرجى تحديث الصفحة لمراجعتها`);
      return false;
    }
    if(!res.ok){
      // رفض من السيرفر بسبب غير تعارض (مثال: 429 rate limit، أو خطأ خادم مؤقت) — نفس معاملة
      // فشل الاتصال: نسجّله معلّقاً بدل تجاهله.
      await _pendingRecordPut('clients', client.id, { op:'upsert', enc, clientId: client.clientId || '' });
      return null;
    }
    const data = await res.json();
    _clientRecordVersions[client.id] = data.version || 0;
    if(data.origin && data.status) clientRecordMeta[client.id] = { origin: data.origin, status: data.status };
    await _pendingRecordDelete('clients', client.id); // نجح الحفظ فعلياً — أي تعديل معلّق أقدم لنفس العميل لم يعد له داعٍ
    return true;
  }catch(e){ return null; }
  finally{ _activeRecordSaves--; updateOfflineIndicator(); }
}

// رفض "لطيف" للأدمن لعميل معلّق سجّله الاستقبال (pending -> rejected): بدل الحذف الفوري النهائي،
// السجل يبقى فى قاعدة البيانات بحالة rejected ويظهر لموظف الاستقبال صاحبه فقط لمدة 15 يوماً
// (يُحذف تلقائياً نهائياً بعدها من السيرفر — راجع cleanRejectedClientRecords فى server.js).
// يرجع true لو نجح.
async function rejectClientRecordSoft(id){
  try{
    const res = await serverFetch(`/api/client-records/${encodeURIComponent(id)}/reject`, { method: 'POST' });
    if(!res.ok) return false;
    const data = await res.json();
    _clientRecordVersions[id] = data.version || _clientRecordVersions[id];
    clientRecordMeta[id] = { origin: 'reception', status: 'rejected' };
    return true;
  }catch(e){ return false; }
}

async function deleteOneClientRecord(id){
  _activeRecordSaves++;
  updateOfflineIndicator();
  try{
    const knownVersion = _clientRecordVersions[id] || 0;
    let res;
    try{
      res = await serverFetch(`/api/client-records/${encodeURIComponent(id)}?version=${knownVersion}`, { method: 'DELETE' });
    }catch(e){
      await _pendingRecordPut('clients', id, { op:'delete' });
      return null;
    }
    if(res.status === 409){
      // عُدِّل/تغيّر العميل على السيرفر من جهاز آخر بعد آخر مشاهدة — لا يجوز حذفه (نفس معاملة PUT).
      const conflict = await res.json().catch(()=>({}));
      _clientRecordVersions[id] = conflict.currentVersion || knownVersion;
      showToast('⚠️ ' + (conflict.error || 'تعارض في الحذف: عُدِّلت بيانات هذا العميل بعد آخر مشاهدة — يرجى تحديث الصفحة وإعادة الحذف'));
      return false;
    }
    // نفس تصحيح deleteOneRecordGeneric: لازم نتحقق من res.ok قبل اعتبار الحذف ناجحاً محلياً،
    // وإلا عميل فشل حذفه فعلياً على السيرفر (429/خطأ) هيرجع يظهر تاني عند أي تحميل قادم.
    if(!res.ok){
      await _pendingRecordPut('clients', id, { op:'delete' });
      return null;
    }
    delete _clientRecordVersions[id];
    delete clientRecordMeta[id];
    await _pendingRecordDelete('clients', id);
    return true;
  }catch(e){ return null; }
  finally{ _activeRecordSaves--; updateOfflineIndicator(); }
}

// حذف عدة عملاء دفعة واحدة (طلب واحد) بدل طلب DELETE منفصل لكل عميل — نفس فكرة
// bulkDeleteRecordsGeneric بالضبط لكن لسجلات العملاء، لتفادي ضرب سقف storageLimiter.
async function bulkDeleteClientRecords(ids){
  const CHUNK = 1000;
  const failedIds = [];
  for(let i=0;i<ids.length;i+=CHUNK){
    const chunk = ids.slice(i, i+CHUNK);
    try{
      const res = await serverFetch('/api/client-records/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids: chunk }),
      });
      if(!res.ok){
        failedIds.push(...chunk);
        await Promise.all(chunk.map(id=> _pendingRecordPut('clients', id, { op:'delete' })));
        continue;
      }
      for(const id of chunk){
        delete _clientRecordVersions[id]; delete clientRecordMeta[id];
        await _pendingRecordDelete('clients', id);
      }
    }catch(e){
      failedIds.push(...chunk);
      await Promise.all(chunk.map(id=> _pendingRecordPut('clients', id, { op:'delete' })));
    }
  }
  return failedIds;
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

// اعتماد الأدمن لسجل عام (vaultTx/bagStock/courseSessions...) سجّله الاستقبال (pending ->
// confirmed). لا حاجة لفك/إعادة تشفير — فقط عمود status يتغيّر على السيرفر (POST approve).
// يرجع true لو نجح.
async function approveRecordGeneric(collection, id){
  try{
    const res = await serverFetch(`/api/records/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/approve`, { method: 'POST' });
    if(!res.ok) return false;
    const data = await res.json();
    if(!_recordVersions[collection]) _recordVersions[collection] = new Map();
    _recordVersions[collection].set(id, data.version || (_recordVersions[collection].get(id) || 0));
    if(!recordMeta[collection]) recordMeta[collection] = {};
    recordMeta[collection][id] = { origin: 'reception', status: 'confirmed' };
    return true;
  }catch(e){ return false; }
}

// رفع مُجمَّع (حتى 300 عميل فى الطلب الواحد) — يُستخدم فى الترحيل لمرة واحدة من التخزين القديم،
// وفى العمليات الضخمة دفعة واحدة (استيراد، تحديث شامل) بدل طلب منفصل لكل عميل.
async function bulkUploadClientRecords(clientsList){
  const CHUNK = 1000;
  const allConflictIds = [];
  for(let i=0;i<clientsList.length;i+=CHUNK){
    const chunk = clientsList.slice(i, i+CHUNK);
    const records = [];
    for(const c of chunk) records.push({ id: c.id, enc: await encryptValue(JSON.stringify(c)), clientId: c.clientId || '', version: _clientRecordVersions[c.id] || 0 });
    for(const r of records){ if(typeof r.enc !== 'string' || !r.enc || r.enc === 'undefined') throw new Error('تعذّر تشفير بيانات عميل — أُوقف الرفع حفاظاً على بياناتك (حدّث الصفحة وأعد المحاولة)'); }
    let res;
    try{
      res = await serverFetch('/api/client-records/bulk-migrate', {
        method: 'POST',
        body: JSON.stringify({ records }),
      });
    }catch(e){
      // فشل اتصال فعلي أثناء رفع دفعة عملاء — نسجّل كل عميل فى الدفعة فى طابور المعلّقات فردياً
      // قبل رفع نفس الاستثناء، بدل الاعتماد فقط على نسخة احتياطية كاملة قد تُتجاهل لاحقاً.
      await Promise.all(records.map(r=> _pendingRecordPut('clients', r.id, { op:'upsert', enc: r.enc, clientId: r.clientId })));
      throw e;
    }
    if(!res.ok){
      await Promise.all(records.map(r=> _pendingRecordPut('clients', r.id, { op:'upsert', enc: r.enc, clientId: r.clientId })));
      throw new Error('تعذّر رفع دفعة من سجلات العملاء أثناء الترحيل');
    }
    const data = await res.json().catch(()=>({}));
    // نفس تصحيح bulkUploadRecordsGeneric بالضبط: أي عميل رفضه السيرفر بتعارض نسخ يُعاد رفعه
    // تلقائياً فقط لو أثبتت مقارنة المحتوى (انظر _safeToApplyOnConflict) أن السيرفر ما زال يحمل
    // أساس تعديلنا (انحراف تتبع نسخ محلي فقط: استعادة/مسح جزئي/لقطة قديمة). أي تعارض حقيقي
    // (شخص آخر غيّر العميل فعلاً، أو تعذّر التحقق) لا نكتب فوقه أبداً — نُسقطه ونُحدّث النسخة
    // المحلية ونبلّغ المستخدم.
    const conflictIdSet = new Set((data.conflicts||[]).map(x=>x.id));
    for(const c of chunk){
      if(!conflictIdSet.has(c.id)){
        _clientRecordVersions[c.id] = (_clientRecordVersions[c.id]||0) + 1;
        await _pendingRecordDelete('clients', c.id);
      }
    }
    const conflicted = data.conflicts || [];
    const stillConflictIds = [];
    if(conflicted.length){
      // نفس معاملة bulkUploadRecordsGeneric بالضبط: نعيد الرفع تلقائياً فقط لما تكون مقارنة
      // المحتوى (مقارنة أساس تعديلنا بما على السيرفر بعد فك التشفير) تُثبت أن لا أحد غيّر السجل
      // فعلاً — أي تعارض حقيقي أو تعذّر تحقق نُسقطه ولا نكتب فوق بيانات الشخص الآخر أبداً.
      const safeRetryRecords = [];
      for(const c of conflicted){
        const client = chunk.find(x=>x.id===c.id);
        if(!client) continue;
        if(await _safeToApplyOnConflict(c, 'clients', true, c.id)){
          safeRetryRecords.push({ id: client.id, enc: client.enc, clientId: client.clientId || '', version: c.currentVersion || 0 });
        }else{
          stillConflictIds.push(c.id);
          _clientRecordVersions[c.id] = c.currentVersion || 0;
          await _pendingRecordDelete('clients', c.id);
        }
      }
      if(safeRetryRecords.length){
        let retryRes = null;
        try{
          retryRes = await serverFetch('/api/client-records/bulk-migrate', {
            method: 'POST',
            body: JSON.stringify({ records: safeRetryRecords }),
          });
        }catch(e){ /* لسه بدون اتصال فعلياً — تُحسم لاحقاً عبر طابور المعلّقات */ }
        if(retryRes && retryRes.ok){
          const retryData = await retryRes.json().catch(()=>({}));
          const retryConflicted = retryData.conflicts || [];
          for(const rc of retryConflicted) _clientRecordVersions[rc.id] = rc.currentVersion || 0;
          for(const r of safeRetryRecords){
            if(retryConflicted.some(rc=>rc.id===r.id)){
              // تغيّر حقيقي أثناء إعادة المحاولة — نتركه متعارضاً (لا كتابة فوق)
              stillConflictIds.push(r.id);
            }else{
              _clientRecordVersions[r.id] = (r.version||0) + 1;
              await _pendingRecordDelete('clients', r.id);
            }
          }
        }else{
          await Promise.all(safeRetryRecords.map(r=> _pendingRecordPut('clients', r.id, { op:'upsert', enc: r.enc, clientId: r.clientId })));
        }
      }
    }
    if(stillConflictIds.length){
      allConflictIds.push(...stillConflictIds);
      showToast(`⚠️ تعذّر رفع ${stillConflictIds.length} عميل بسبب تعديل آخر لنفس البيانات أثناء الترحيل — يرجى تحديث الصفحة ومراجعتها`);
    }
  }
  return allConflictIds; // معرّفات العملاء التي فشل رفعها فعلياً بسبب تعارض حقيقي — لا يجوز اعتبارها مُتزامنة
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

// ================= رفع سريع بسيط بعد مسح كامل للسيرفر (استعادة نسخة احتياطية) =================
// يُستخدم فقط بعد wipeServerDataForFreshRestore حيث السيرفر فارغ فعلياً: كل سجل يُرسَل برقم
// نسخة 0 فيُدرجه السيرفر فوراً برقم 1 بلا أي تعارض ممكن، بدون طابور معلّقات، بدون إعادة محاولة
// تعارضات، وبدون لمس الـ baseline — طلبات أقل بكثير ورفع أسرع بمراحل من المسار المعتاد.
async function fastUploadCollection(collection, list){
  const CHUNK = 4000;
  if(!_recordVersions[collection]) _recordVersions[collection] = new Map();
  const versions = _recordVersions[collection];
  for(let i=0;i<list.length;i+=CHUNK){
    const chunk = list.slice(i, i+CHUNK);
    const records = [];
    for(const item of chunk) records.push({ id: item.id, enc: await encryptValue(JSON.stringify(item)), version: 0 });
    for(const r of records){ if(typeof r.enc !== 'string' || !r.enc || r.enc === 'undefined') throw new Error('تعذّر تشفير سجل من "' + collection + '" — أُوقف الرفع حفاظاً على بياناتك'); }
    let res = null;
    for(let attempt=0; attempt<4; attempt++){
      try{
        res = await serverFetch(`/api/records/${encodeURIComponent(collection)}/bulk-migrate`, {
          method: 'POST',
          body: JSON.stringify({ records }),
        });
      }catch(e){ res = null; }
      if(res && (res.ok || res.status === 409)) break;
      await new Promise(r=>setTimeout(r, 2500*(attempt+1)));
    }
    if(!res || !res.ok) throw new Error('تعذّر رفع بيانات ' + collection + ' — ستعاد المحاولة تلقائياً عند استقرار الاتصال');
    const data = await res.json().catch(()=>({}));
    for(const item of chunk) versions.set(item.id, 1);
    for(const c of (data.conflicts||[])) versions.set(c.id, c.currentVersion || 0);
  }
  // إعادة بناء baseline التصنيف كاملاً — أي تعديل لاحق يُبنى على البيانات المرفوعة للتو بدل
  // اعتبار كل شيء "تغيّر" وإعادة رفع كل الشيت عند أول حفظ لاحق.
  const baseline = _collectionSyncBaseline[collection] || (_collectionSyncBaseline[collection] = new Map());
  baseline.clear();
  for(const item of list) baseline.set(item.id, JSON.stringify(item));
}

async function fastUploadClients(clientsList){
  const CHUNK = 4000;
  for(let i=0;i<clientsList.length;i+=CHUNK){
    const chunk = clientsList.slice(i, i+CHUNK);
    const records = [];
    for(const c of chunk) records.push({ id: c.id, enc: await encryptValue(JSON.stringify(c)), clientId: c.clientId || '', version: 0 });
    for(const r of records){ if(typeof r.enc !== 'string' || !r.enc || r.enc === 'undefined') throw new Error('تعذّر تشفير بيانات عميل — أُوقف الرفع حفاظاً على بياناتك'); }
    let res = null;
    for(let attempt=0; attempt<4; attempt++){
      try{
        res = await serverFetch('/api/client-records/bulk-migrate', {
          method: 'POST',
          body: JSON.stringify({ records }),
        });
      }catch(e){ res = null; }
      if(res && (res.ok || res.status === 409)) break;
      await new Promise(r=>setTimeout(r, 2500*(attempt+1)));
    }
    if(!res || !res.ok) throw new Error('تعذّر رفع بيانات العملاء — ستعاد المحاولة تلقائياً عند استقرار الاتصال');
    const data = await res.json().catch(()=>({}));
    for(const c of chunk) _clientRecordVersions[c.id] = 1;
    for(const c of (data.conflicts||[])) _clientRecordVersions[c.id] = c.currentVersion || 0;
  }
  _clientsSyncBaseline = new Map();
  for(const c of clientsList) _clientsSyncBaseline.set(c.id, JSON.stringify(c));
}

