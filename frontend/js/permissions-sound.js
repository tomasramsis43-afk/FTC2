/* ================= نظام المؤثرات الصوتية ================= */
const SoundFX = (()=>{
  let ctx = null;
  function getCtx(){
    if(!ctx){
      try{ ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ return null; }
    }
    if(ctx.state==='suspended') ctx.resume();
    return ctx;
  }
  function enabled(){ return !!(typeof settings!=='undefined' && settings.soundEnabled); }
  // نغمة/سلسلة نغمات بسيطة بموجة جيبية ناعمة مع envelope قصير حتى لا تكون مزعجة
  function tone(freq, start, dur, type='sine', peak=.11){
    const c = getCtx(); if(!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime+start);
    gain.gain.setValueAtTime(0, c.currentTime+start);
    gain.gain.linearRampToValueAtTime(peak, c.currentTime+start+.012);
    gain.gain.exponentialRampToValueAtTime(.0001, c.currentTime+start+dur);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(c.currentTime+start);
    osc.stop(c.currentTime+start+dur+.02);
  }
  return {
    click(){ if(!enabled()) return; tone(720,0,.055,'sine',.06); },
    nav(){ if(!enabled()) return; tone(560,0,.07,'sine',.07); tone(760,.05,.09,'sine',.05); },
    success(){ if(!enabled()) return; tone(587,0,.09,'sine',.09); tone(880,.09,.16,'sine',.09); },
    error(){ if(!enabled()) return; tone(220,0,.12,'sawtooth',.05); tone(180,.1,.16,'sawtooth',.045); },
    delete(){ if(!enabled()) return; tone(400,0,.06,'triangle',.07); tone(260,.05,.13,'triangle',.06); },
    open(){ if(!enabled()) return; tone(660,0,.06,'sine',.05); },
    login(){ if(!enabled()) return; tone(523,0,.09,'sine',.08); tone(659,.08,.09,'sine',.08); tone(880,.16,.18,'sine',.08); }
  };
})();
function applySoundIcon(){
  const btn = $('#btn-sound-toggle');
  if(!btn) return;
  btn.classList.toggle('muted', !settings.soundEnabled);
  btn.title = settings.soundEnabled ? 'كتم المؤثرات الصوتية' : 'تشغيل المؤثرات الصوتية';
}
let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let companies = [];
let companyTransfers = [];
let ctraineeTargetTransferId = null;
let ctEditingTraineeId = null;
let ctImportTargetTransferId = null;
let ctImportTextTargetTransferId = null;
let ctImportCompanyTargetId = null;
let editingId = null;
let bagPurchaseTargetId = null;
let editingTransferId = null;
let editingVaultId = null;
let editingPaymentTxId = null;
let addingClientPayment = false;
let editingBagStockId = null;
let editingSessionId = null;
let editingCompanyId = null;
let users = [];
let auditLog = [];
let currentUser = null;
let currentUserRole = 'admin'; // 'admin' (صلاحيات كاملة) أو 'staff' (صلاحيات محدودة — بدون الإعدادات وسجل المراجعة)

/* ================= عزل البيانات حسب المستخدم (كل مستخدم يشوف بياناته هو فقط) =================
   المدير العام والمحاسب فقط يشوفون كل البيانات بدون استثناء. أي دور آخر (استقبال/موظف عام)
   يشوف فقط السجلات التي أنشأها هو بنفسه (createdBy === اسم مستخدمه)، في كل شاشة تسجّل بيانات
   (عملاء، شركات، دورات، مشتريات، موردين، حركات مخزون الحقائب). السجلات القديمة التي أُنشئت قبل
   هذه الميزة (بدون حقل createdBy) لا تُعتبر مملوكة لأي مستخدم مقيَّد تحديداً، فتظهر فقط للمدير/المحاسب
   حتى لا يُخمَّن مالكها خطأً. الخزنة والتقارير المالية والمحاسبة تبقى مقفولة بالكامل عن الاستقبال/الموظف
   العام أصلاً (راجع settings.rolePermissions)، فلا داعي لعزلها هنا لأنها غير ظاهرة لهم من الأساس.
*/
function canSeeAllData(){ return currentUserRole==='admin' || currentUserRole==='accountant'; }
// ملحوظة أمان: هذه الدالة تُستخدم فقط لتصفية العرض (أي شاشة تعرض قائمة)، ولا يجوز أبداً استخدامها
// لإعادة تعيين المصفوفة الأصلية (مثال: `clients = filterOwnRecords(clients)`) لأن نفس تلك المصفوفة
// تُستخدم لاحقاً عند أي عملية حفظ — وقد حدث بسبب هذا بالضبط حادث فقدان بيانات سابق (راجع تعليق
// loadData أعلاه). استخدامها الصحيح الوحيد هو داخل `.filter()` عند بناء قائمة عرض جديدة كل مرة.
function isOwnRecord(r){ return canSeeAllData() || (r && r.createdBy===currentUser); }
function filterOwnRecords(arr){
  if(canSeeAllData() || !Array.isArray(arr)) return arr;
  return arr.filter(r=> r && r.createdBy && r.createdBy===currentUser);
}

/* ================= قيود خاصة بدور "الاستقبال" على شيت العملاء (قابلة للتعديل من الإعدادات) =================
   settings.receptionEditDeleteWindowHours: عدد الساعات المسموح بها للتعديل/الحذف بعد وقت تسجيل
   العميل (createdAt). settings.receptionAllowEdit / receptionAllowDelete: تفعيل/تعطيل كل ميزة
   على حدة. بعد انتهاء المهلة (أو لو الميزة معطَّلة أصلاً) يتحول السجل لعرض فقط لهذا الدور حتى
   يتدخل الأدمن، الذي يبقى غير متأثر بهذه القيود مطلقاً في كل الأحوال. */
function receptionWindowMs(){
  const h = (settings && typeof settings.receptionEditDeleteWindowHours==='number') ? settings.receptionEditDeleteWindowHours : 5;
  return Math.max(0, h) * 60 * 60 * 1000;
}
function withinReceptionWindow(client){
  if(!client || !client.createdAt) return false; // بدون تاريخ تسجيل معروف: يُمنع احترازياً
  return (Date.now() - client.createdAt) <= receptionWindowMs();
}
function canReceptionEditClient(client){
  if(currentUserRole!=='reception') return true; // القيد خاص بدور الاستقبال فقط
  if(settings && settings.receptionAllowEdit===false) return false;
  return withinReceptionWindow(client);
}
function canDeleteClientRecord(client){
  if(currentUserRole!=='reception') return true; // القيد خاص بدور الاستقبال فقط
  if(settings && settings.receptionAllowDelete===false) return false;
  return withinReceptionWindow(client);
}

/* دالة تأخير التنفيذ (debounce) — تُستخدم مع حقول البحث النصي حتى لا يُعاد رسم الجداول الكبيرة
   مع كل ضغطة حرف (وهذا هو السبب الرئيسي لبطء البرنامج مع كثرة البيانات)، بل بعد توقف الكتابة فقط */
function debounce(fn, wait=280){
  let t;
  return function(...args){
    clearTimeout(t);
    t = setTimeout(()=> fn.apply(this,args), wait);
  };
}
/* ربط حدث input بنسخة مؤخّرة من الدالة (يبقى تفاعل باقي الحقول مثل select/date فورياً كما هو) */
function onSearchInput(selector, fn){
  const el = typeof selector==='string' ? $(selector) : selector;
  if(el) el.addEventListener('input', debounce(fn));
}

function guessDest(name){
  const n = (name||'').toLowerCase();
  if(n.includes('نقد')||n.includes('كاش')||n.includes('خزين')) return 'vault';
  if(n.includes('بنك')||n.includes('تحويل')) return 'bank';
  if(n.includes('بطاق')||n.includes('شبك')||n.includes('مدى')) return 'network';
  return 'other';
}
function destLabel(d){ return {vault:'الخزنة (كاش)', bank:'البنك', network:'الشبكة', other:'أخرى'}[d] || 'أخرى'; }
/* تصحيح/مزامنة تلقائي لسجل عمليات مخزون الحقائب: تُضيف عملية "تسليم" (issue) بأثر رجعي لأي عميل
   مصدر حقيبته "من المخزون" (bagSource==='stock') وليس له عملية مقابلة مسجّلة بعد في bagStock.
   تُستدعى عند تحميل البيانات وأيضاً فور انتهاء أي استيراد Excel قد يضبط مصدر حقيبة عميل على "من المخزون"،
   حتى يتحدّث رقم "المخزون الحالي" فوراً دون الحاجة لإعادة تحميل/فتح التطبيق من جديد.
   تُعيد true إن تم تسجيل أي تصحيح (وتتولى الحفظ بنفسها)، وfalse إن لم يكن هناك ما يحتاج تصحيحاً. */
async function syncBagStockIssues(){
  let migrated = false;
  clients.forEach(c=>{
    if(c.bagSource==='stock' && !bagStock.some(b=>b.type==='issue' && b.issuedClientId===c.id)){
      bagStock.push({
        id: uid(), createdBy: currentUser, type:'issue', qty:-1, unitPrice:0,
        date: c.bagPurchaseDate || c.date || todayISO(),
        createdAt: c.createdAt || Date.now(),
        issuedClientId: c.id, issuedClientName: c.name,
        notes: 'ترحيل/تصحيح تلقائي لعملية تسليم من المخزون (تمت مزامنتها تلقائياً مع شيت العملاء)'
      });
      migrated = true;
    }
  });
  if(migrated){ recalcBagFundLedger(); await saveBagStock(); await saveSettings(); }
  return migrated;
}
// شاشة إيقاف كاملة عند فشل فك تشفير بيانات حقيقية (راجع window.storage.get/_decryptOrFail
// وloadData أعلاه لتفاصيل الخطر بالتحديد). الهدف: منع أي تفاعل مع البرنامج (وبالتالي منع أي
// عملية حفظ) على هذا الجهاز إلى أن يُحل السبب، بدل عرض شاشة فارغة كأنها بيانات حقيقية.
let _fatalDecryptScreenShown = false;
function showFatalDecryptErrorScreen(err){
  if(_fatalDecryptScreenShown) return;
  _fatalDecryptScreenShown = true;
  try{
    const div = document.createElement('div');
    div.id = 'fatal-decrypt-error-screen';
    div.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#1a0000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;direction:rtl;';
    div.innerHTML = `
      <div style="max-width:560px;">
        <div style="font-size:48px;margin-bottom:16px;">⛔</div>
        <h2 style="margin:0 0 12px;">تعذّر فتح البرنامج بأمان على هذا الجهاز</h2>
        <p style="line-height:1.8;">${escapeHtml(err && err.message ? err.message : 'خطأ غير معروف في فك تشفير البيانات')}</p>
        <p style="line-height:1.8;opacity:0.85;">
          هذا يعني عادةً أن هذا المتصفح/الجهاز لا يدعم التشفير المطلوب (Web Crypto)، أو أن رابط
          الدخول ليس عبر HTTPS صحيح. تم إيقاف البرنامج عمداً هنا لمنع أي عملية حفظ قد تمحو بيانات
          باقي المستخدمين. تأكد من الرابط المستخدم (يجب أن يبدأ بـ https://) ثم أعد تحميل الصفحة،
          أو تواصل مع المطوّر إن استمرت المشكلة.
        </p>
        <button id="fatal-decrypt-reload-btn" style="margin-top:12px;padding:10px 24px;border:none;border-radius:8px;background:#c62828;color:#fff;font-size:15px;cursor:pointer;">إعادة تحميل الصفحة</button>
        <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; justify-content:center;">
          <button id="fatal-decrypt-clear-btn" style="padding:8px 16px;border:1px solid #ff8a80;border-radius:8px;background:transparent;color:#ff8a80;font-size:13px;cursor:pointer;">مسح مفتاح التشفير المؤقت وإعادة المحاولة</button>
          <button id="fatal-decrypt-license-btn" style="padding:8px 16px;border:1px solid #ffcc80;border-radius:8px;background:transparent;color:#ffcc80;font-size:13px;cursor:pointer;">إدخال كود ترخيص قديم</button>
        </div>
        <p style="margin-top:12px;font-size:11.5px;opacity:0.7;">لو كنت تستخدم رابط https:// صحيح وما زال الخطأ يظهر، جرّب الزرين أعلاه.</p>
      </div>`;
    document.body.appendChild(div);
    document.getElementById('fatal-decrypt-reload-btn').addEventListener('click', ()=> location.reload());
    document.getElementById('fatal-decrypt-clear-btn').addEventListener('click', ()=>{
      try{ localStorage.removeItem('appLicenseCacheV1'); localStorage.removeItem('appFallbackEncKeyV1'); }catch(e){}
      location.reload();
    });
    document.getElementById('fatal-decrypt-license-btn').addEventListener('click', async ()=>{
      const code = prompt('أدخل كود الترخيص القديم كما كان مكتوباً (مع الشرطات إن وجدت):');
      if(!code || !code.trim()) return;
      try{
        const r = await fetch('/api/license/validate', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({licenseKey: code.trim()})});
        const data = await r.json();
        if(data && data.valid && data.encKey){
          try{
            localStorage.setItem('appLicenseKeyV1', code.trim().replace(/[\s-]/g,'').toUpperCase());
            localStorage.setItem('appLicenseCacheV1', JSON.stringify({encKeyRaw: data.encKey, expiryDate: data.expiryDate || null, clientId: data.clientId || null, cachedAt: new Date().toISOString()}));
          }catch(e){}
          alert('تم حفظ كود الترخيص — سيُعاد تحميل الصفحة الآن');
          location.reload();
        } else {
          alert('كود الترخيص غير صالح: ' + (data.reason || 'غير معروف'));
        }
      }catch(e){ alert('تعذّر التحقق من الكود — تأكد من الاتصال بالإنترنت'); }
    });
  }catch(e){ alert('تعذّر فتح البرنامج بأمان على هذا الجهاز — يرجى إعادة تحميل الصفحة'); }
}
async function loadData(cacheOnly){
  // نجلب كل مفاتيح kv_store بالتوازي (كل الطلبات تُرسل دفعة واحدة) بدل التتابع (طلب وراء طلب)
  // المستخدم سابقاً. زمن الانتظار الأكبر هو زمن الشبكة/استجابة الخادم — خصوصاً على استضافة مجانية
  // بطيئة قد تكون "نائمة" وتحتاج تستيقظ — وليس زمن معالجة البيانات نفسها، فتوازي الطلبات يقلّل
  // زمن فتح البرنامج بشكل ملموس دون أي تغيير في منطق المعالجة أو ترتيبه أدناه.
  const wantUsers = normalizeRole(SERVER_AUTH_ROLE) === 'admin';
  // 'clients' أُزيل من هذه القائمة: له مسار تحميل خاص أسفل (عملاء كسجلات مستقلة، أسرع بكثير مع
  // آلاف العملاء) بدل تحميله ككتلة واحدة ضخمة مع باقي المفاتيح — راجع قسم "تحميل العملاء" أدناه.
  // 'auditLog' أُزيل من هذه القائمة أيضاً: له مسار تحميل خاص أسفل (سجلات مستقلة عبر
  // loadCollectionGeneric، أول تصنيف يُوصَّل فعلياً بنظام collection_records الجاهز من قبل).
  // 'bagStock','vaultTx','deletedVaultTx','vaultDenomTx','bankStatementRows','deletedInvoices',
  // 'courseSessions','companies','companyTransfers','journalEntries','chartOfAccounts','journalDE',
  // 'budgetEntries','suppliers','purchases','manualSalesInvoices' أُزيلوا أيضاً: كل هذه التصنيفات
  // مُرحَّلة فعلياً لنظام السجلات المستقلة (ALLOWED_COLLECTIONS) ولها استدعاء loadGeneric() خاص
  // أسفل يكتب فوق أي قيمة هنا فوراً — نتيجة جلبها هنا من kv_store القديم لم تكن تُستخدم فى أي
  // مكان بالملف إطلاقاً (تحقّقنا: فقط kv.settings / kv.appLang / kv.users / kv.zakatAdjustments
  // تُستخدم فعلياً). إبقاؤها هنا كان يعني 16 طلب شبكة زيادة بلا أي فائدة تُرسَل بالتوازي مع كل
  // فتح للبرنامج، تضرب نفس الـ storageLimiter الذي تسبب سابقاً فى مشكلة تشبع الطلبات مع journalDE
  // (راجع storage-sync.js) — هنا فى جهة القراءة GET بدل الكتابة PUT، وقد يتسبب فى 429 عابر لبعض
  // طلبات loadGeneric الحقيقية عند فتح البرنامج تحت ضغط (نت بطيء / سيرفر صاحٍ لتوّه)، فتظهر
  // بيانات ناقصة مؤقتاً فى شاشات مثل سجل الحقائب حتى تُصلحها المزامنة الخلفية لاحقاً.
  const kvKeys = ['settings','appLang','zakatAdjustments'].concat(wantUsers ? ['users'] : []);
  const kv = {};
  const decryptFailedKeys = [];
  await Promise.all(kvKeys.map(async k=>{
    try{ kv[k] = await window.storage.get(k, false, cacheOnly); }
    catch(e){
      if(e && e.isDecryptFailure) decryptFailedKeys.push(k);
      kv[k] = null;
    }
  }));
  // مساعد مشترك لتحميل أي تصنيف مُوصَّل بنظام السجلات المستقلة (collection_records) — يحدّث
  // _collectionSyncBaseline[collection] تلقائياً. خطأ فك التشفير لا يُبتلع أبداً هنا (كان يُرجع
  // [] بصمت فيعرض التصنيف فارغاً وكأنه غير موجود، وأي حفظ لاحق من هذا الجهاز — إضافة/تعديل/
  // ترحيل تلقائي — كان يكتب فوق البيانات الحقيقية المشفَّرة ويمحوها، تماماً نفس خطر تحميل
  // العملاء الموثّق أعلى الملف): نرمي خطأ موسوماً isDecryptFailure فيوقفه المتصلون
  // (backgroundSyncCheck/startApp) بالشاشة القاتلة. أي خطأ آخر (انقطاع اتصال عابر) يبقى
  // خط رجعة آمناً بإرجاع مصفوفة فارغة.
  async function loadGeneric(collection){
    try{
      const { list, baseline } = await loadCollectionGeneric(collection, cacheOnly);
      _collectionSyncBaseline[collection] = baseline;
      return list;
    }catch(e){
      if(e && e.isDecryptFailure){
        decryptFailedKeys.push(collection);
        const err = new Error('تعذّر فك تشفير البيانات المحفوظة (' + collection + ') على هذا الجهاز');
        err.isDecryptFailure = true;
        err.failedKeys = [collection];
        throw err;
      }
      _collectionSyncBaseline[collection] = null;
      return [];
    }
  }

  // ---- تحميل العملاء: عملاء كسجلات مستقلة (client_records) بدل كتلة واحدة ----
  // فى وضع cacheOnly (عرض فوري من الجهاز بدون انتظار الشبكة عند فتح البرنامج) نستخدم آخر نسخة
  // محفوظة محلياً من النظام القديم فوراً؛ المزامنة الفعلية مع النظام الجديد تتم بعدها فى الخلفية
  // (loadData(false) عبر backgroundSyncCheck). _clientsSyncBaseline تبقى null هنا عمداً — يعني
  // "لسه ملهاش مزامنة مؤكدة مع النظام الجديد هذه الجلسة"، فيستخدم saveClients() خط الرجعة الآمن
  // (الحفظ الكامل القديم) حتى تتأكد المزامنة الحقيقية عند أول تحميل online.
  let clientsDecryptFailed = false;
  const isReceptionSession = normalizeRole(currentUserRole || SERVER_AUTH_ROLE) === 'reception';
  // مفتاح كاش محلي خاص بكل مستخدم استقبال بعينه (بخلاف مفتاح 'clients' القديم أدناه، المشترك بين
  // كل من يستخدم هذا الجهاز/المتصفح دون أي تمييز بين المستخدمين — التخزين المحلي IndexedDB على هذا
  // الجهاز غير مقسَّم بحساب المستخدم إطلاقاً، راجع _openKvIdb/_kvCacheRead فى core-utils.js). لو
  // نفس الجهاز استُخدم يوماً من حساب أدمن/موظف آخر (جهاز مشترك فى الاستقبال مثلاً)، أو حتى من مستخدم
  // استقبال آخر، قراءة 'clients' القديم مباشرة هنا كانت تُسرّب عملاء لا يملك مستخدم الاستقبال الحالي
  // حق رؤيتهم إطلاقاً — أثناء التحميل السريع الأول (cacheOnly) أو عند تعذّر الوصول لنظام السجلات
  // الجديد مؤقتاً — رغم أن السيرفر نفسه يمنعه تماماً من هذا المفتاح (403). لا يُكتب فى هذا الكاش
  // الخاص إلا نتيجة fetchAllClientRecords المفلترة أصلاً بحساب هذا المستخدم تحديداً (created_by
  // = اسمه)، ويُخزَّن مشفَّراً بنفس طريقة تشفير باقي بيانات العملاء.
  const receptionOwnCacheKey = 'clientRecordsCache::' + (currentUser || SERVER_AUTH_USERNAME || '');
  async function readReceptionOwnCache(){
    try{
      const cached = await _kvCacheRead(receptionOwnCacheKey);
      if(!cached || !cached.value) return [];
      const plain = await _decryptOrFail(cached.value);
      return JSON.parse(plain);
    }catch(e){ return []; } // كاش تالف/غير موجود — لا يجوز أبداً أن يتحوّل هذا لفشل قاتل، فقط نبدأ فارغاً وتُصحَّح الشاشة عند أول تحميل حقيقي من السيرفر
  }
  async function writeReceptionOwnCache(list){
    try{ const enc = await encryptValue(JSON.stringify(list)); await _kvCacheWrite(receptionOwnCacheKey, 0, enc); }catch(e){}
  }
  if(cacheOnly){
    // العرض الفوري يبدأ من آخر لقطة محلية مؤكدة (مشفّرة) خاصة بهذا المستخدم — تحمل القائمة +
    // الـ baseline + أرقام النسخ، فيُبنى أي تعديل في نافذة ما قبل المزامنة الخلفية على آخر حالة
    // حقيقية عبر نظام العملاء كسجلات مستقلة (لا على مصفوفة فارغة/قديمة تُكتب فوق الحقيقة).
    const snap = await _recordsSnapRead(_clientsSnapKey());
    if(snap && Array.isArray(snap.list)){
      clients = snap.list;
      _clientsSyncBaseline = new Map();
      for(const pair of (snap.baselinePairs||[])){ if(pair && pair.length === 2) _clientsSyncBaseline.set(pair[0], pair[1]); }
      for(const pair of (snap.versionPairs||[])){ if(pair && pair.length === 2) _clientRecordVersions[pair[0]] = pair[1]; }
      // استعادة حالات العملاء (origin/status) من اللقطة — حتى تبقى شارة "قيد الاعتماد" وأزرار
      // الاعتماد/الرفض لدى الأدمن ظاهرة بعد إعادة فتح البرنامج أيضاً (لا تُحفظ في enc ولا في
      // المصفوفة نفسها، وتضيع كانت أثناء الجلسة الحية فقط لو لم نستعدها هنا).
      if(snap.metaPairs && typeof clientRecordMeta==='object') clientRecordMeta = {};
      for(const pair of (snap.metaPairs||[])){ if(pair && pair.length === 2 && pair[0] && pair[1] && pair[1].status) clientRecordMeta[pair[0]] = { origin: pair[1].origin || 'general', status: pair[1].status }; }
      await _mergePendingRecordsIntoList('clients', clients);
    } else {
      // لا توجد لقطة مؤكدة بعد على هذا الجهاز/المستخدم (أول فتح) — نبدأ بآخر نسخة قديمة إن
      // وُجدت كبداية فورية، مع baseline غير مؤكد، وتُبنى اللقطة عند أول تحميل حقيقي ناجح.
      if(isReceptionSession){
        clients = await readReceptionOwnCache();
      } else {
        try{
          const r = await window.storage.get('clients', false, true);
          clients = r && r.value ? JSON.parse(r.value) : [];
        }catch(e){
          if(e && e.isDecryptFailure) clientsDecryptFailed = true;
          clients = [];
        }
      }
      _clientsSyncBaseline = null;
    }
  } else {
    try{
      const { list, baseline } = await fetchAllClientRecords();
      _clientsFirstRealSyncDone = true; // وصلنا فعلاً للسيرفر وحصلنا على إجابة حقيقية (سواء فارغة أو لا)
      if(list.length){
        clients = list;
        _clientsSyncBaseline = baseline;
        // مفتاح 'clients' القديم لم يعد يُكتب إطلاقاً في مسار الحفظ الجديد (عملاء كسجلات مستقلة —
        // راجع saveClients). يبقى قراءته فقط كآخر خيار عند أول فتح بلا لقطة محلية، فندعّمه برقم
        // النسخة الحقيقي احتياطاً حتى لا يُرفض بأي حفظ رجعة قديم بخطأ 409 وهمي.
        window.storage.primeKeyVersion('clients').catch(()=>{});
        if(isReceptionSession) await writeReceptionOwnCache(list);
      }else if(isReceptionSession){
        // قائمة فارغة فعلياً لهذا المستخدم تحديداً (وصلنا للسيرفر فعلاً) — لا يوجد أي "خط رجعة"
        // قديم يصح الرجوع إليه لهذا الدور: مفتاح 'clients' القديم مشترك بين كل مستخدمي الجهاز
        // وممنوع أصلاً عن دور الاستقبال على مستوى السيرفر (راجع restrictKeyToAdmin فى server.js).
        clients = [];
        _clientsSyncBaseline = new Map();
        await writeReceptionOwnCache([]);
      }else{
        // مفيش بيانات فى النظام الجديد بعد (وصلنا فعلاً للسيرفر وقائمة فارغة حقيقية) — نتحقق من
        // وجود بيانات قديمة (كتلة واحدة) تحتاج ترحيل لمرة واحدة فقط.
        let legacyClients = [];
        try{
          const r = await window.storage.get('clients', false, false);
          legacyClients = (r && r.value) ? JSON.parse(r.value) : [];
        }catch(e){
          if(e && e.isDecryptFailure) clientsDecryptFailed = true;
          legacyClients = [];
        }
        if(legacyClients.length && !clientsDecryptFailed){
          try{
            await bulkUploadClientRecords(legacyClients);
            clients = legacyClients;
            _clientsSyncBaseline = new Map(legacyClients.map(c=>[c.id, JSON.stringify(c)]));
            showToast('تم ترحيل بيانات العملاء لنظام تخزين أسرع (مرة واحدة فقط)');
          }catch(e){
            // فشل الترحيل (مثال: انقطع الاتصال أثناءه) — نكمل بالبيانات القديمة فى الذاكرة، ولا
            // خطر من إعادة محاولة الترحيل تلقائياً فى المرة القادمة online (نفس البيانات فقط تُرفع تاني).
            clients = legacyClients;
            _clientsSyncBaseline = null;
          }
        }else{
          clients = legacyClients; // فارغة فعلاً (تركيب جديد) أو تعذّر فك تشفيرها
          _clientsSyncBaseline = clientsDecryptFailed ? null : new Map();
        }
      }
    }catch(e){
      if(e && e.isDecryptFailure){ clientsDecryptFailed = true; clients = []; }
      else if(isReceptionSession){
        // تعذّر الوصول لنظام السجلات الجديد مؤقتاً (انقطاع اتصال) — نرجع لآخر نسخة خاصة بهذا
        // المستخدم تحديداً محفوظة محلياً، وليس أبداً لمفتاح 'clients' القديم المشترك.
        clients = await readReceptionOwnCache();
      }else{
        // تعذّر الوصول لنظام السجلات الجديد فعلياً (انقطاع اتصال) — نرجع لآخر نسخة محفوظة محلياً
        // من النظام القديم بدل تفريغ الشاشة، تماماً كخط الرجعة المعتاد فى باقي مفاتيح البرنامج.
        try{
          const r = await window.storage.get('clients', false, true);
          clients = r && r.value ? JSON.parse(r.value) : [];
        }catch(e2){ clients = []; }
      }
      _clientsSyncBaseline = null;
    }
  }
  if(clientsDecryptFailed) decryptFailedKeys.push('clients');

  if(decryptFailedKeys.length){
    // خطأ قاتل: نوقف هنا قبل أي عرض أو حفظ. الاستمرار كان سيعني التعامل مع بيانات مشفَّرة
    // حقيقية موجودة على السيرفر كأنها "غير موجودة" (فارغة)، وأي عملية حفظ لاحقة من هذا الجهاز
    // (مثال: إضافة عميل واحد) كانت ستكتب مصفوفة شبه فارغة فوق بيانات كل المستخدمين على
    // السيرفر وتمحوها بالكامل. راجع window.storage.get/_decryptOrFail أعلى الملف.
    const err = new Error('تعذّر فك تشفير البيانات المحفوظة (' + decryptFailedKeys.join('، ') + ') على هذا الجهاز');
    err.isDecryptFailure = true;
    err.failedKeys = decryptFailedKeys;
    throw err;
  }

  // عزل البيانات: كل مستخدم مقيَّد (غير أدمن/محاسب) يشوف فقط عملاءه الذين سجّلهم هو بنفسه
  // (createdBy). السجلات القديمة بدون createdBy (قبل هذه الميزة) لا تظهر له تحديداً لعدم إمكان
  // إثبات ملكيتها، وتبقى ظاهرة فقط للأدمن/المحاسب. راجع filterOwnRecords/canSeeAllData أعلى الملف.
  // ملحوظة أمان حرجة: أُزيل هنا فلتر "عزل البيانات" الذي كان يستبدل مصفوفة clients الكاملة
  // بنسخة مبتورة (بيانات المستخدم الحالي فقط) عند التحميل. لأن نفس هذه المصفوفة تُستخدم لاحقاً
  // عند أي حفظ (saveClients عبر أي عملية تعديل/ترحيل تلقائي)، كان أي حفظ من جهاز مستخدم مقيَّد
  // يكتب فوق قاعدة البيانات المشتركة بالنسخة المبتورة فقط — مما يمحو فعلياً بيانات كل المستخدمين
  // الآخرين (بما فيهم الأدمن) من السيرفر بمجرد أن تتم أي عملية حفظ من جهاز ذلك المستخدم. عزل
  // البيانات في العرض (الشاشة) يجب أن يتم لاحقاً بمصفوفة منفصلة للعرض فقط، ولا يجب إطلاقاً أن
  // يُستبدل بها المصدر الأساسي الذي يُحفظ للسيرفر.
  try{
    const r = kv.settings;
    settings = r && r.value ? JSON.parse(r.value) : JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    // إشارة مهمة لوحدات تعتمد على الإعدادات (مثل gsheet-workflow): تُضبط فور تحميل الإعدادات
    // الحقيقية (المحفوظة/المؤكدة) في الذاكرة، وليس نسخة DEFAULT_SETTINGS الفارغة في بداية السكربت.
    // قبل هذه اللحظة يكون settings.gsheetWorkflow (صندوق الاعتماد/الرفض) فارغاً افتراضياً — أي
    // حفظ تلقائي مبكر (مثل migrateAutoEnableSheets في gsheet-workflow) كان يكتب الصندوق الفارغ فوق
    // الصندوق المحفوظ فعلياً فيمسحه عند كل إعادة فتح. تُستخدم هذه الإشارة لتأجيل أي كتابة حتى
    // اكتمال تحميل الإعدادات.
    window.appSettingsLoaded = true;
    if(settings.bagPrice===undefined) settings.bagPrice = DEFAULT_SETTINGS.bagPrice;
    if(settings.priceSaudi===undefined) settings.priceSaudi = DEFAULT_SETTINGS.priceSaudi;
    if(settings.priceNonSaudi===undefined) settings.priceNonSaudi = DEFAULT_SETTINGS.priceNonSaudi;
    if(settings.bagFundBalance===undefined) settings.bagFundBalance = 0;
    if(!settings.expenseCategories) settings.expenseCategories = DEFAULT_SETTINGS.expenseCategories;
    if(settings.expenseCategories.includes('كهرباء وماء')){
      settings.expenseCategories = settings.expenseCategories.filter(c=>c!=='كهرباء وماء');
      ['كهرباء','مياه'].forEach(c=>{ if(!settings.expenseCategories.includes(c)) settings.expenseCategories.push(c); });
      await saveSettings();
    }
    if(!settings.expenseCategories.includes('مشتريات')){ settings.expenseCategories.push('مشتريات'); await saveSettings(); }
    if(!settings.nextVaultSeq) settings.nextVaultSeq = DEFAULT_SETTINGS.nextVaultSeq;
    if(!settings.nextVaultSeqByDest || typeof settings.nextVaultSeqByDest!=='object') settings.nextVaultSeqByDest = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.nextVaultSeqByDest));
    else ['vault','bank','network','other'].forEach(d=>{ if(!settings.nextVaultSeqByDest[d]) settings.nextVaultSeqByDest[d] = 1; });
    if(!settings.powerAutomate) settings.powerAutomate = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.powerAutomate));
    if(settings.vaultLockedThrough===undefined) settings.vaultLockedThrough = DEFAULT_SETTINGS.vaultLockedThrough;
    if(settings.channels && typeof settings.channels[0]==='string'){
      settings.channels = settings.channels.map(n=>({name:n, dest:guessDest(n)}));
      await saveSettings();
    }
    if(!settings.channels) settings.channels = DEFAULT_SETTINGS.channels;
    if(!settings.centerInfo) settings.centerInfo = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.centerInfo));
    if(!settings.nextInvoiceNo) settings.nextInvoiceNo = 1;
    if(!settings.nextReturnInvoiceNo) settings.nextReturnInvoiceNo = 1;
    if(!settings.nextVoucherNo) settings.nextVoucherNo = 1;
    if(!settings.nextReceiptNo) settings.nextReceiptNo = 1;
    if(!settings.nextManualSalesInvoiceNo) settings.nextManualSalesInvoiceNo = 1;
    if(settings.darkMode===undefined) settings.darkMode = false;
    if(settings.soundEnabled===undefined) settings.soundEnabled = true;
    if(settings.autoBackupEnabled===undefined) settings.autoBackupEnabled = true;
    if(settings.lowBalanceThreshold===undefined) settings.lowBalanceThreshold = 5000;
    if(settings.bagOverdueDays===undefined) settings.bagOverdueDays = 14;
    if(settings.monthlyReportWhatsapp===undefined) settings.monthlyReportWhatsapp = '';
    if(settings.monthlyPdfReportsWhatsappNumbers===undefined) settings.monthlyPdfReportsWhatsappNumbers = '';
    if(settings.vatPdfReportWhatsappNumbers===undefined) settings.vatPdfReportWhatsappNumbers = '';
    if(settings.reportEmailTo===undefined) settings.reportEmailTo = '';
    if(settings.reportEmailCC===undefined) settings.reportEmailCC = '';
    if(settings.lastMonthlyReportPromptMonth===undefined) settings.lastMonthlyReportPromptMonth = null;
    if(!settings.autoBackupIntervalDays) settings.autoBackupIntervalDays = 7;
    if(settings.lastAutoBackupAt===undefined) settings.lastAutoBackupAt = null;
    if(settings.bagFinanceLinkEnabled===undefined) settings.bagFinanceLinkEnabled = true;
    if(!settings.pinLock) settings.pinLock = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.pinLock));
    else{
      if(settings.pinLock.enabled===undefined) settings.pinLock.enabled = false;
      if(settings.pinLock.pin===undefined) settings.pinLock.pin = '';
      if(!settings.pinLock.autoLockMinutes) settings.pinLock.autoLockMinutes = 5;
    }
    if(!settings.rolePermissions) settings.rolePermissions = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rolePermissions));
    else{
      EDITABLE_ROLES.forEach(r=>{ if(!Array.isArray(settings.rolePermissions[r.id])) settings.rolePermissions[r.id] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rolePermissions[r.id])); });
    }
    // ترحيل تلقائي لمرة واحدة فقط: تقييد دور "الاستقبال" على شاشة العملاء (التسجيل) دون أي شاشة
    // أخرى إطلاقاً، حتى لو كان قد أُعطي صلاحيات أوسع سابقاً من الإعدادات. يمكن للأدمن توسيعها يدوياً
    // لاحقاً من الإعدادات إن احتاج، لكن الافتراضي الآن أضيق عمداً بناءً على طلب صريح.
    if(!settings.receptionLockedToClientsOnlyV1){
      if(settings.rolePermissions) settings.rolePermissions.reception = ['clients'];
      settings.receptionLockedToClientsOnlyV1 = true;
      await saveSettings();
    }
    // ترحيل تلقائي لمرة واحدة (V2): إضافة شاشة "تسوية الاستقبال" لصلاحيات دور الاستقبال، حتى
    // للحسابات التي نفّذت الترحيل V1 القديم أعلاه (الذي كان يحصر الاستقبال على "العملاء" فقط
    // دون علم بإضافة شاشة التسوية لاحقاً) — بدون هذا، تبقى شاشة التسوية محجوبة فعلياً عن
    // الاستقبال رغم ظهور تبويبها، لأن settings.rolePermissions.reception محفوظة مسبقاً كمصفوفة
    // فتتجاوز DEFAULT_SETTINGS تلقائياً (الشرط في الأعلى Array.isArray لا يستبدلها).
    if(!settings.receptionSettlementsAccessV2){
      if(settings.rolePermissions && Array.isArray(settings.rolePermissions.reception) && !settings.rolePermissions.reception.includes('settlements')){
        settings.rolePermissions.reception.push('settlements');
      }
      settings.receptionSettlementsAccessV2 = true;
      await saveSettings();
    }
    // ترحيل تلقائي لمرة واحدة (V3): عكس V2 أعلاه — إزالة شاشة "تسوية الاستقبال" من صلاحيات دور
    // الاستقبال نهائياً، بناءً على طلب صريح لاحق بأن التسوية لا علاقة للاستقبال بها إطلاقاً وتبقى
    // مسؤولية الأدمن (وباقي الأدوار الأخرى صاحبة الصلاحية أصلاً) فقط. يشمل هذا الحسابات التي
    // نفّذت V1/V2 القديمين ومحفوظ عندها settings.rolePermissions.reception بالفعل كمصفوفة تتضمن
    // 'settlements' (فلا يكفي مجرد تعديل DEFAULT_SETTINGS، لأن القيمة المحفوظة تتجاوزه تلقائياً).
    if(!settings.receptionSettlementsRemovedV3){
      if(settings.rolePermissions && Array.isArray(settings.rolePermissions.reception)){
        settings.rolePermissions.reception = settings.rolePermissions.reception.filter(v=> v!=='settlements');
      }
      settings.receptionSettlementsRemovedV3 = true;
      await saveSettings();
    }
    if(typeof settings.receptionEditDeleteWindowHours!=='number' || settings.receptionEditDeleteWindowHours<0) settings.receptionEditDeleteWindowHours = DEFAULT_SETTINGS.receptionEditDeleteWindowHours;
    if(typeof settings.receptionAllowEdit!=='boolean') settings.receptionAllowEdit = DEFAULT_SETTINGS.receptionAllowEdit;
    if(typeof settings.receptionAllowDelete!=='boolean') settings.receptionAllowDelete = DEFAULT_SETTINGS.receptionAllowDelete;
  }catch(e){ settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); await saveSettings(); }
  bagStock = await loadGeneric('bagStock');
  // ترحيل/تصحيح تلقائي: أي عميل مصدر حقيبته "من المخزون" (bagSource==='stock') ولم يكن له عملية "تسليم"
  // مقابلة في سجل عمليات مخزون الحقائب — تُضاف له عملية بأثر رجعي، حتى يبقى "المخزون الحالي" مبنياً دائماً
  // على سجل عمليات المخزون نفسه ومتزامناً مع شيت العملاء. الدالة نفسها تُستدعى أيضاً بعد أي استيراد Excel
  // قد يضبط مصدر حقيبة عميل على "من المخزون"، حتى يتحدّث رقم المخزون فوراً دون الحاجة لإعادة تحميل التطبيق.
  // تُستدعى هنا فقط عند cacheOnly===false (تحميل حقيقي مؤكد من السيرفر): فى وضع الفتح السريع من
  // الكاش المحلي (cacheOnly=true) تكون clients/bagStock نسخة محلية قد تكون قديمة/ناقصة (جهاز آخر
  // أضاف سجلاً لم يصل بعد)، فتشغيل المطابقة هنا كان يُنتج سجلات "تسليم" صناعية مكررة ويرفعها فوراً
  // على السيرفر بناءً على صورة غير مؤكدة — قبل أن تُتِمّ المزامنة الخلفية (backgroundSyncCheck)
  // الصورة الصحيحة. تأجيلها لِما بعد التحميل المؤكد يمنع هذا التكرار/التعارض الزائف.
  if(!cacheOnly) await syncBagStockIssues();
  vaultTx = await loadGeneric('vaultTx'); bumpVaultVersion();
  deletedVaultTx = await loadGeneric('deletedVaultTx');
  if(!cacheOnly){
    // نفس مبدأ syncBagStockIssues أعلاه: كل الترحيلات/الإصلاحات التلقائية هنا تكتب على السيرفر،
    // فلا تُنفَّذ في وضع الفتح السريع (cacheOnly) لأن الذاكرة فيها صورة محلية قديمة/ناقصة — أي
    // ترقيم/حذف/توحيد مبني عليها كان يرفع نتائج خاطئة للسيرفر قبل اكتمال المزامنة. تُنفَّذ فقط
    // عند التحميل الكامل المؤكد من السيرفر (cacheOnly===false)، فتلتئم كل التعديلات بلا تكرار.
    const renumberedCount = renumberVaultSeqChronologically();
    if(renumberedCount>0){
      await saveVaultTx();
      await saveDeletedVaultTx();
      await logAudit('edit','الحركات المالية', `ترحيل تلقائي لمرة واحدة: تم إعادة ترقيم الرقم التسلسلي لكل الحركات المالية (${renumberedCount} حركة) بشكل مستقل لكل حساب (الخزنة كاش / البنك / الشبكة / أخرى) حسب تاريخ كل حركة، بحيث تبدأ كل وجهة برقمها من 1`);
    }
  }
  vaultDenomTx = await loadGeneric('vaultDenomTx');
  bankStatementRows = await loadGeneric('bankStatementRows');
  scheduledVaultTx = await loadGeneric('scheduledVaultTx');
  followUpTasks = await loadGeneric('followUpTasks');
  deletedInvoices = await loadGeneric('deletedInvoices');
  courseSessions = await loadGeneric('courseSessions');
  try{
    const r = kv.appLang;
    currentLang = (r && r.value) ? r.value : 'ar';
  }catch(e){ currentLang = 'ar'; }
  // مفتاح users قديم/غير مستخدم فعلياً في أي قرار صلاحية حالياً (النظام الحقيقي
  // بالكامل عبر SERVER_AUTH_ROLE من الخادم منذ إزالة شاشة الدخول المحلي القديمة)،
  // فنحمّله فقط لو الدور الحالي admin — تمهيداً لتقييده على مستوى السيرفر بأمان
  // بدون أي طلب مرفوض أو رسالة خطأ مربكة لباقي الأدوار.
  if (wantUsers) {
    try{
      const r = kv.users;
      users = r && r.value ? JSON.parse(r.value) : [];
    }catch(e){ users = []; }
    if(!users.length){
      users = [{username:'admin', password:'admin123', role:'admin', createdAt:Date.now()}];
      await saveUsers();
    }
    let rolesBackfilled = false;
    users.forEach(u=>{ if(!u.role){ u.role = 'admin'; rolesBackfilled = true; } });
    if(rolesBackfilled) await saveUsers();
  } else {
    users = [];
  }
  // ---- تحميل سجل المراجعة: أول تصنيف يُوصَّل فعلياً بنظام السجلات المستقلة (collection_records)
  // بدل كتلة واحدة — سجل المراجعة يُضاف إليه سطر واحد مع كل إضافة/تعديل/حذف فى أي شاشة بالبرنامج،
  // فكان أكثر مفتاح يُعاد رفعه/تحميله كاملاً بلا داعٍ (راجع saveAuditLog/logAudit أسفل).
  try{
    const { list, baseline } = await loadCollectionGeneric('auditLog', cacheOnly);
    auditLog = list;
    _collectionSyncBaseline['auditLog'] = baseline;
  }catch(e){
    if(e && e.isDecryptFailure){
      decryptFailedKeys.push('auditLog');
      const err = new Error('تعذّر فك تشفير البيانات المحفوظة (auditLog) على هذا الجهاز');
      err.isDecryptFailure = true;
      err.failedKeys = ['auditLog'];
      throw err;
    }
    auditLog = []; _collectionSyncBaseline['auditLog'] = null;
  }
  companies = await loadGeneric('companies');
  companyTransfers = await loadGeneric('companyTransfers');
  if(!cacheOnly){
    // نفس المبدأ أعلاه: لا يُنفَّذ أي ترحيل/إصلاح تلقائي يكتب على السيرفر في وضع الفتح السريع من
    // الكاش المحلي (cacheOnly=true) — الذاكرة قد تكون صورة قديمة/ناقصة، فتنفيذها كان يرفع نتائج
    // خاطئة أو مكررة. كلها تُنفَّذ عند أول تحميل كامل مؤكد من السيرفر.
    const migratedCount = migrateCompanyTransfersToLumpSum();
    if(migratedCount>0){
      await saveVaultTx();
      await saveDeletedVaultTx();
      await logAudit('edit','تحويلات الشركات', `ترحيل تلقائي: تم توحيد القيود المالية لـ ${migratedCount} حوالة شركة قديمة في قيد واحد لكل حوالة`);
    }
    {
      const valuesMigratedCount = migrateCompanyTraineeValuesToClients();
      if(valuesMigratedCount>0){
        await saveClients();
        await saveVaultTx(); // syncClientValueFromTraineeAllocation قد تكون حذفت قيوداً فردية قديمة تخص هؤلاء العملاء
        await logAudit('edit','شيت العملاء', `مزامنة تلقائية: تم تحديث قيمة الدورة/الحقيبة/المدفوع لـ ${valuesMigratedCount} عميل من تخصيصهم في حوالات الشركات`);
      }
      const dupRemovedCount = cleanupDuplicateCompanyTraineeVaultEntries();
      if(dupRemovedCount>0){
        await saveVaultTx();
        await saveDeletedVaultTx();
        await logAudit('delete','الحركات المالية', `إصلاح تلقائي: تم حذف ${dupRemovedCount} قيد مالي مكرر لعملاء مُرحَّلة قيمتهم من حوالات الشركات (مبلغهم مُرحَّل بالفعل ضمن القيد الموحّد لكل حوالة)`);
      }
      const orphanFixedCount = await reconcileOrphanedCompanyTransferClients();
      if(orphanFixedCount>0){
        await saveClients();
        await logAudit('edit','شيت العملاء', `إصلاح تلقائي: تم تصفير تخصيص ${orphanFixedCount} عميل كانوا معلَّمين كمُرحَّلين من حوالة شركة رغم عدم ارتباطهم بأي حوالة حالية (بيانات قديمة قبل حذف متدرب/حوالة)`);
      }
    }
  }
  journalEntries = await loadGeneric('journalEntries');
  chartOfAccounts = await loadGeneric('chartOfAccounts');
  seedChartOfAccountsIfEmpty();
  journalDE = await loadGeneric('journalDE');
  budgetEntries = await loadGeneric('budgetEntries');
  suppliers = await loadGeneric('suppliers');
  purchases = await loadGeneric('purchases');
  // عزل البيانات: نفس مبدأ شيت العملاء أعلاه — كل مستخدم مقيَّد يشوف فقط عمليات الشراء التي
  // سجّلها هو بنفسه.
  // نفس السبب الحرج الموضّح أعلى مصفوفة clients — أُزيل نفس الفلتر المُبتِر هنا لمصفوفة purchases.
  await migratePurchaseAttachmentsOut();
  manualSalesInvoices = await loadGeneric('manualSalesInvoices');
  // تنظيف القيود اليومية اليتيمة (قيد مُرحَّل تلقائياً لمصدر حُذف لاحقاً — فاتورة/قيد/مبيعات
  // يدوية): يُنفَّذ قبل الترحيل التلقائي الشامل أدناه حتى يعيد الأخير ترحيل أي وثيقة حية
  // فُقد قيدها (راجع cleanupOrphanedJournalDE في module-accounting.js). آمن للتكرار — يعمل
  // على الحالة الحالية فقط، فيصلح أي بقايا قديمة مرة واحدة عند أول تحميل بعد هذا التحديث.
  // تنظيف القيود اليومية اليتيمة (قيد مُرحَّل تلقائياً لمصدر حُذف لاحقاً — فاتورة/قيد/مبيعات
  // يدوية): يُنفَّذ قبل الترحيل التلقائي الشامل أدناه حتى يعيد الأخير ترحيل أي وثيقة حية
  // فُقد قيدها (راجع cleanupOrphanedJournalDE في module-accounting.js). آمن للتكرار — يعمل
  // على الحالة الحالية فقط، فيصلح أي بقايا قديمة مرة واحدة عند أول تحميل بعد هذا التحديث.
  // لا يُنفَّذ في وضع الفتح السريع (cacheOnly) لأنه يكتب على السيرفر (نفس مبدأ بقية الترحيلات).
  if(!cacheOnly){
    try{
      const cleanup = typeof cleanupOrphanedJournalDE==='function' ? cleanupOrphanedJournalDE() : null;
      if(cleanup){
        await saveJournalDE();
        if(cleanup.pointersFixed>0){
          await saveJournalEntries();
          await saveClients();
        }
        await logAudit('delete','المحاسبة', `إصلاح تلقائي: تم حذف ${cleanup.removed} قيد يومية يتيم لوثائق محذوفة، وإعادة ربط ${cleanup.pointersFixed} وثيقة بقيدها المفقود`);
      }
    }catch(e){ console.error('فشل تنظيف القيود اليومية اليتيمة', e); }
    // إصلاح مراجع الحسابات اليتيمة في قيود فواتير الدورات (راجع الشرح الكامل أعلى الدالة في
    // accounting-core.js): يُنفَّذ مرة واحدة فقط، بعد seedChartOfAccountsIfEmpty وتحميل journalDE
    // مباشرة، وقبل الترحيل التلقائي الشامل أدناه حتى تُحتسب هذه القيود المُصلَحة بشكل صحيح في
    // أي تقرير يُبنى لاحقاً في نفس التحميل.
    try{
      const accFixedCount = typeof repairOrphanedCourseInvoiceAccountRefs==='function' ? repairOrphanedCourseInvoiceAccountRefs() : 0;
      if(accFixedCount>0){
        await saveJournalDE();
        await saveSettings();
        await logAudit('edit','المحاسبة', `إصلاح تلقائي: تم تصحيح مرجع الحساب في ${accFixedCount} قيد يومية لفواتير دورات كانت تشير لحسابات من جيل قديم لدليل الحسابات (لا تغيير في أي مبلغ، فقط إعادة ربط بالحساب الصحيح الحالي)`);
      }
    }catch(e){ console.error('فشل إصلاح مراجع الحسابات اليتيمة', e); }
  }
  try{
    const r = kv.zakatAdjustments;
    zakatAdjustments = r && r.value ? JSON.parse(r.value) : {};
  }catch(e){ zakatAdjustments = {}; }
  // ترحيل تلقائي شامل للقيد المزدوج: يشمل كل القيود اليدوية القديمة المعلّقة، وفواتير المشتريات
  // والمبيعات اليدوية وفواتير الدورات التي لم تُرحَّل بعد — بدل انتظار ضغط المستخدم على أزرار
  // الترحيل اليدوية. يعمل تلقائياً في كل تحميل كامل مؤكد للبيانات (بداية التشغيل والمزامنة الخلفية)،
  // وهو آمن للتكرار لأن كل دالة autoPost* تتحقق أولاً من عدم وجود ترحيل سابق لنفس السجل.
  // لا يُنفَّذ في وضع الفتح السريع (cacheOnly) — نفس مبدأ بقية الترحيلات أعلاه: الكتابة على
  // السيرفر بناءً على صورة محلية قديمة/ناقصة قد تولّد قيوداً مكررة أو خاطئة قبل اكتمال المزامنة.
  if(!cacheOnly){ try{ await autoPostAllPendingDoubleEntries(); }catch(e){ /* لا نوقف تحميل البيانات بسبب فشل الترحيل */ } }
  if(!cacheOnly && typeof _persistAllSnapshotsAfterLoad==='function'){
    // بعد اكتمال تحميل حقيقي كامل: تحديث كل اللقطات المحلية حتى يبدأ أي فتح تالٍ (cacheOnly)
    // من آخر حالة مؤكدة مع baseline/أرقام نسخ صحيحة بدل شاشة فارغة ونافذة فقدان محتملة.
    _persistAllSnapshotsAfterLoad().catch(()=>{});
  }
}
async function saveUsers(){
  try{ await window.storage.set('users', JSON.stringify(users), false); }catch(e){ showToast('تعذر حفظ بيانات المستخدمين'); }
}
async function saveAuditLog(){
  try{ await saveCollectionGeneric('auditLog', auditLog); }catch(e){ /* silent */ }
}
async function logAudit(action, section, description){
  auditLog.push({
    id: uid(),
    ts: Date.now(),
    user: currentUser || 'غير معروف',
    action, // add | edit | delete
    section, // اسم الشيت
    description
  });
  await saveAuditLog();
}

// يرسل تنبيه إيميل فوري للإدارة (ADMIN_ALERT_EMAILS على السيرفر) للأحداث المهمة: إضافة عميل
// جديد، شراء حقيبة، فاتورة شراء، تسجيل مصروف. المستلمون مُعرَّفون على السيرفر وليس هنا — نفس
// قائمة تنبيهات الأمان. best-effort بالكامل: لا يوقف العمل ولا يُظهر أخطاءً لو فشل الإرسال.
async function notifyAdminAlert(subject, bodyHtml){
  try{
    const res = await serverFetch('/api/email/admin-alert', {
      method:'POST',
      body: JSON.stringify({ subject, bodyHtml }),
    });
    if(!res.ok) console.error('فشل تنبيه الإدارة بالإيميل:', await res.json().catch(()=>({})));
  }catch(e){ console.error('فشل تنبيه الإدارة بالإيميل:', e); }
}
// allowDrop=true تُستخدم فقط عند حذف عملاء دفعة واحدة عن قصد (بعد تأكيد المستخدم صراحة عبر
// customConfirm)، لتخطّي حماية "رفض الحذف المفاجئ الكبير" على السيرفر (راجع PUT /api/storage/:key)
// التي هدفها منع فقدان بيانات بسبب جهاز يحفظ نسخة قديمة من المصفوفة فوق نسخة السيرفر الحالية.
async function saveClients(allowDrop){
  try{
    // المسار السريع: لو المزامنة مع نظام "عملاء كسجلات مستقلة" متأكدة لهذه الجلسة (راجع loadData)،
    // نبعت بس العملاء اللي اتغيّروا فعلاً (سجل واحد لكل تغيير حقيقي، مقارنةً بآخر نسخة معروفة
    // متزامنة) بدل كل العملاء فى كل مرة — تسجيل/تعديل/حذف عميل واحد من آلاف العملاء يصبح نقل
    // بيانات هذا العميل فقط بدل نقل كل قاعدة العملاء عبر الشبكة.
    if(_clientsSyncBaseline){
      const currentIds = new Set();
      const changed = [];
      for(const c of clients){
        currentIds.add(c.id);
        const json = JSON.stringify(c);
        if(_clientsSyncBaseline.get(c.id) !== json) changed.push({ client: c, json });
      }
      const removedIds = [];
      for(const id of _clientsSyncBaseline.keys()) if(!currentIds.has(id)) removedIds.push(id);

      let anyNetworkFailure = false;
      if(changed.length > 20){
        // تغييرات كثيرة دفعة واحدة (استيراد/تحديث شامل) — رفع مُجمَّع أخف وأسرع على السيرفر بدل
        // طلب منفصل لكل عميل، وبدون فحص تعارض (نفس منطق العمليات الجماعية الكبيرة الأخرى بالبرنامج).
        try{
          const conflictIds = await bulkUploadClientRecords(changed.map(x=>x.client));
          // لازم نستثني العملاء اللي فشل رفعهم فعلياً بسبب تعارض حقيقي: تحديث الـ baseline لهم هنا
          // كان يخلّي البرنامج يظن إنهم اتزامنوا رغم رفض السيرفر لتعديلهم فعلياً — فلا يُعاد رفعهم
          // تاني أبداً رغم بقاء بياناتهم غير متطابقة مع السيرفر (أو، لو تغيّرت بياناتهم بعد ذلك مرة
          // أخرى، يدخلون ويخرجون من نفس حلقة "تعذّر الرفع" كل مرة تُحفظ فيها البيانات من جديد).
          const conflictSet = new Set(conflictIds);
          changed.forEach(x=> { if(!conflictSet.has(x.client.id)) _clientsSyncBaseline.set(x.client.id, x.json); });
        }catch(e){ anyNetworkFailure = true; }
      }else{
        for(const {client, json} of changed){
          const ok = await saveOneClientRecord(client, json);
          if(ok) _clientsSyncBaseline.set(client.id, json);
          else if(ok === null) anyNetworkFailure = true; // فشل اتصال فعلي (وليس تعارض — التعارض مُعالَج ومُبلَّغ بالفعل داخل saveOneClientRecord)
        }
      }
      if(removedIds.length > 20){
        const failedIds = await bulkDeleteClientRecords(removedIds);
        for(const id of removedIds) if(!failedIds.includes(id)) _clientsSyncBaseline.delete(id);
        if(failedIds.length) anyNetworkFailure = true;
      }else{
        for(const id of removedIds){
          const ok = await deleteOneClientRecord(id);
          if(ok) _clientsSyncBaseline.delete(id);
          else anyNetworkFailure = true;
        }
      }
      if(anyNetworkFailure){
        // فشل اتصال فعلي أثناء رفع بعض العملاء — كل دالة حفظ عميل (فردية/مجمّعة) سجّلت ما فشل
        // في طابور pendingRecords قبل إرجاع الفشل، فلا حاجة لأي "خط رجعة كتلة قديمة" في kv_store
        // (مخزن لا يُقرأ من جديد — السبب الجذري لفقدان البيانات عند إعادة الفتح). نُبطل الـ
        // baseline فقط لإعادة مزامنة كاملة آمنة عند أول اتصال ناجح.
        _clientsSyncBaseline = null;
      }
      _scheduleClientsSnapPersist();
      return;
    }
    // خط الرجعة: المزامنة مع نظام "عملاء كسجلات مستقلة" لم تتأكد بعد هذه الجلسة (أول تحميل، أو
    // انقطاع أثناء آخر محاولة). بدل "الكتلة القديمة" في kv_store (مخزن لا يُقرأ لاحقاً — سبب
    // فقدان البيانات)، نرفع كل العملاء عبر نظام السجلات نفسه ونُثبّت الـ baseline من النتيجة.
    const clientsToUpload = clients.filter(c=>c && c.id);
    try{
      const conflictIds = await bulkUploadClientRecords(clientsToUpload);
      const conflictSet = new Set(conflictIds);
      const newBaseline = new Map();
      for(const c of clientsToUpload){
        const json = JSON.stringify(c);
        if(!conflictSet.has(c.id)) newBaseline.set(c.id, json);
      }
      _clientsSyncBaseline = newBaseline;
    }catch(e){
      // فشل اتصال فعلي — سُجّل العملاء في طابور pendingRecords داخل bulkUploadClientRecords،
      // ويبقى الـ baseline null لتُعاد المزامنة الكاملة عند أول اتصال ناجح.
      _clientsSyncBaseline = null;
    }
    _scheduleClientsSnapPersist();
  }catch(e){ showToast('تعذر حفظ البيانات'); }
}
async function saveSettings(){
  try{ await window.storage.set('settings', JSON.stringify(settings), false); }catch(e){ showToast('تعذر حفظ الإعدادات'); }
}
/* مساعد مشترك: يجلب أرقام نسخ collection من السيرفر قبل الكتابة لتفادي تعارضات 409 */
async function _syncVersionsBeforeSave(collection){
  if(isCurrentlyOffline()) return;
  try{
    const vr = await serverFetch(`/api/records/${encodeURIComponent(collection)}/versions`);
    if(vr && vr.ok){
      const vd = await vr.json().catch(()=>null);
      if(vd && Array.isArray(vd.pairs)){
        if(!_recordVersions[collection]) _recordVersions[collection] = new Map();
        for(const [id, ver] of vd.pairs) _recordVersions[collection].set(id, ver);
      }
    }
  }catch(e){ /* نكمل حتى لو فشل الجلب */ }
}

async function saveBagStock(){
  try{ await _syncVersionsBeforeSave('bagStock'); await saveCollectionGeneric('bagStock', bagStock); }catch(e){ showToast('تعذر حفظ سجل المخزون'); }
}
async function saveVaultTx(){
  try{ await _syncVersionsBeforeSave('vaultTx'); await saveCollectionGeneric('vaultTx', vaultTx); }catch(e){ showToast('تعذر حفظ حركات الخزنة'); }
}
async function saveDeletedVaultTx(){
  try{ await _syncVersionsBeforeSave('deletedVaultTx'); await saveCollectionGeneric('deletedVaultTx', deletedVaultTx); }catch(e){ showToast('تعذر حفظ سجل الحركات الملغاة'); }
}
async function saveVaultDenomTx(){
  try{ await _syncVersionsBeforeSave('vaultDenomTx'); await saveCollectionGeneric('vaultDenomTx', vaultDenomTx); }catch(e){ showToast('تعذر حفظ سجل تصنيف الفئات النقدية'); }
}
async function saveBankStatementRows(){
  try{ await _syncVersionsBeforeSave('bankStatementRows'); await saveCollectionGeneric('bankStatementRows', bankStatementRows); }catch(e){ showToast('تعذر حفظ كشف الحساب البنكي'); }
}
async function saveScheduledVaultTx(){
  try{ await _syncVersionsBeforeSave('scheduledVaultTx'); await saveCollectionGeneric('scheduledVaultTx', scheduledVaultTx); }catch(e){ showToast('تعذر حفظ قوالب الحركات المجدولة'); }
}
async function saveFollowUpTasks(){
  try{ await _syncVersionsBeforeSave('followUpTasks'); await saveCollectionGeneric('followUpTasks', followUpTasks); }catch(e){ showToast('تعذر حفظ التذكيرات'); }
}
async function saveDeletedInvoices(){
  try{ await _syncVersionsBeforeSave('deletedInvoices'); await saveCollectionGeneric('deletedInvoices', deletedInvoices); }catch(e){ showToast('تعذر حفظ سجل الفواتير المحذوفة'); }
}
