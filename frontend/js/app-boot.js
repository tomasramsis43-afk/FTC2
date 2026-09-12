/* ============================================================
   app-boot.js — منطق إقلاع البرنامج الأساسي: التحقق من الترخيص،
   تسجيل الدخول (عادي/بصمة/QR/رابط بريدي)، وتحميل/مزامنة البيانات
   عند بدء التشغيل.
   ------------------------------------------------------------
   نُقل هذا القسم بالكامل من module-purchases.js (كان تاريخياً
   مُدمجاً هناك رغم عدم علاقته بشاشة المشتريات إطلاقاً). عند تفعيل
   التحميل الكسول لموديول المشتريات (راجع lazy-modules.js)، كان
   بقاء هذا المنطق داخل ذلك الملف يمنع تحميله إلا بعد فتح المستخدم
   لشاشة المشتريات يدوياً — أي بعد بدء تشغيل البرنامج فعلياً — وهو
   ما كان يكسر الإقلاع بالكامل (showLicenseScreen/activateAndStart/
   ensureServerLoginThenStart غير معرّفة وقت استدعاء boot.js لها،
   وكذلك renderAllViewsAfterLoad/backgroundSyncCheck/startApp التي
   تعتمد عليها ملفات أخرى محمّلة مبكراً مثل storage-sync.js وsse-
   client.js وpermissions-sound.js وbackup-restore.js). لا تغيير
   فى أي منطق أعمال هنا — نقل فقط، مع الإبقاء على نفس ترتيب
   الملفات الذي كان مفترضاً (يجب أن يبقى هذا الملف محمّلاً قبل
   js/boot.js في app.html).
   ============================================================ */

// كل شاشات العرض التي كانت تُرسم مرة واحدة عند فتح البرنامج — تم فصلها في دالة مستقلة حتى
// تُستدعى أيضاً بعد أي مزامنة خلفية تجلب تغييرات فعلية من السحابة (راجع backgroundSyncCheck).
// تُنفَّذ كل خطوة بمعزل عن الأخرى (try/catch مستقل لكل واحدة): لو فشلت خطوة واحدة (استثناء غير
// متوقع)، كل الخطوات التالية لها كانت تتوقف تماماً ولا تُنفَّذ إطلاقاً — وهو ما كان يجعل فلتر
// السنة (وأي شاشة أخرى) يبدو "معطَّلاً" بلا أي سبب ظاهر لمجرد فشل صامت في خطوة سابقة له.
function safeStep(fn, label){
  try{
    const r = fn();
    if(r && typeof r.then==='function') r.catch(e => console.error(`renderAllViewsAfterLoad: فشلت خطوة "${label}"`, e));
    return r;
  }
  catch(e){ console.error(`renderAllViewsAfterLoad: فشلت خطوة "${label}"`, e); }
}
async function renderAllViewsAfterLoad(){
  // فلتر السنة يُهيَّأ أولاً قبل أي شيء آخر (حتى قبل عمليات التنظيف)، حتى يبقى شغالاً بالتأكيد
  // مهما فشلت خطوة لاحقة له.
  safeStep(()=>initYearFilter(), 'initYearFilter');
  try{ await cleanupDuplicateCourseTypes(); }catch(e){ console.error('renderAllViewsAfterLoad: فشلت خطوة "cleanupDuplicateCourseTypes"', e); }
  try{ await cleanupDuplicateNationalities(); }catch(e){ console.error('renderAllViewsAfterLoad: فشلت خطوة "cleanupDuplicateNationalities"', e); }
  try{ await cleanupDuplicatePaymentMethods(); }catch(e){ console.error('renderAllViewsAfterLoad: فشلت خطوة "cleanupDuplicatePaymentMethods"', e); }
  safeStep(()=>refreshFilterOptions(), 'refreshFilterOptions');
  safeStep(()=>renderTable(), 'renderTable');
  safeStep(()=>{ if(typeof renderApprovalNoticesBanner==='function') renderApprovalNoticesBanner(); }, 'renderApprovalNoticesBanner');
  safeStep(()=>renderDashboard(), 'renderDashboard');
  safeStep(()=>renderSettings(), 'renderSettings');
  safeStep(()=>renderBags(), 'renderBags');
  safeStep(()=>renderCourses(), 'renderCourses');
  safeStep(()=>renderCourseInvoices(), 'renderCourseInvoices');
  safeStep(()=>renderVault(), 'renderVault');
  safeStep(()=>renderAuditLog(), 'renderAuditLog');
  safeStep(()=>renderReports(), 'renderReports');
  safeStep(()=>renderCompanies(), 'renderCompanies');
  safeStep(()=>renderAccounting(), 'renderAccounting');
  safeStep(()=>renderPurchases(), 'renderPurchases');
  safeStep(()=>applyLanguage(currentLang), 'applyLanguage');
  safeStep(()=>{ applyTheme(!!settings.darkMode); applyColorScheme(settings.colorScheme||'terminal'); applySoundIcon(); applyThemeColors(); }, 'applyTheme');
}

// هل يوجد على هذا الجهاز نسخة محفوظة محلياً يمكن الانطلاق منها فوراً بدون انتظار الشبكة؟
// نتحقق من مفتاح 'settings' تحديداً لأنه أول مفتاح يُحفظ دائماً بعد أي استخدام فعلي للبرنامج،
// فوجوده يعني أن هذا الجهاز فتح البرنامج بنجاح من قبل ولديه نسخة كاملة من البيانات محلياً.
async function hasLocalCache(){
  try{ return !!(await _kvCacheRead('settings')); }catch(e){ return false; }
}

let _bgSyncInFlight = false;
// لو وصل إشعار SSE (أو استدعاء آخر لـ backgroundSyncCheck) أثناء تنفيذ فحص سابق بالفعل، كان
// الاستدعاء الجديد يُتجاهل تماماً بلا أي إعادة محاولة لاحقة — فلو حصلت المصادفة السيئة إن فحصين
// اتصادموا فى نفس اللحظة، يفضل المستخدم (مثلاً الأدمن مستني اعتماد عميل جديد) على بيانات قديمة
// لغاية الفحص الدوري التالي (كل دقيقتين) بدل التحديث اللحظي. الحل: بدل التجاهل الكامل، نسجّل إن
// فيه طلب فحص "معلّق" وقت الازدحام، ونُنفّذ فحصاً واحداً إضافياً تلقائياً أول ما الفحص الحالي يخلص
// — فحص واحد مجمّع يكفي مهما كان عدد الإشعارات اللي وصلت فى نفس الفترة (بلا تراكم طلبات).
let _bgSyncRerunRequested = false;
// مزامنة خلفية: تقارن رقم نسخة كل مفتاح محلياً مع نسخته الحالية على السحابة عبر طلب واحد خفيف
// (/api/storage-versions) بدل طلب منفصل لكل مفتاح، وترفع أولاً أي تعديل محلي معلّق لم يصل
// للسحابة بعد (حتى لا نفقده أو نستبدله بغير قصد)، ثم تجلب فعلياً فقط المفاتيح التي تغيّرت
// نسختها على السحابة منذ آخر تحميل. لو كل النسخ متطابقة (الحالة الأشيع: لا يوجد أي تغيير
// منذ آخر فتح للبرنامج)، لا يحدث أي نقل بيانات إضافي ولا أي إعادة رسم للشاشة.
async function backgroundSyncCheck(){
  if(_bgSyncInFlight){ _bgSyncRerunRequested = true; return; }
  _bgSyncInFlight = true;
  try{
    // نرفع أي تعديل محلي معلّق أولاً (لأن إكمال استعادة النسخة الاحتياطية أدناه يمسح السيرفر ثم
    // يرفع بيانات الذاكرة الحالية كاملة — لو بقي تعديل معلّق لم يُرفع قبل ذلك، سيُرفع لاحقاً
    // بنسخة قديمة فيُرفض 409 خطأً رغم وجود بياناته ضمن الرفع الكامل).
    // نتحقق أولاً لو فيه فعلاً تعديلات معلّقة قبل استدعاء flush — لو الطابور فارغ نتجاوزها بصمت
    // بدون رفع أي طلب شبكة أو تحريك عدادات _activeKvSaves/_activeRecordSaves، وبالتالي بدون تغيير
    // status bar من "✅ كل شيء محدث" إلى "🔄 جارٍ الرفع" لجزء من ثانية (كان يحدث كل دقيقتين).
    const [_kvPendingNow, _recPendingNow] = await Promise.all([_pendingCount(), _pendingRecordCount()]);
    if(_kvPendingNow > 0) await flushPendingWrites();
    if(_recPendingNow > 0) await flushPendingRecordWrites();
    // لو كان هناك استعادة نسخة احتياطية كاملة تمت أصلاً بدون اتصال وما زالت بانتظار مزامنة كاملة
    // مع السيرفر (راجع restoreFullBackup فى backup-restore.js)، نُتِمّها الآن — هذه الدالة تُستدعى
    // بعد اكتمال تحميل بيانات البرنامج فعلياً فى الذاكرة، فالتوقيت آمن.
    if(typeof checkPendingRestoreResync==='function') await checkPendingRestoreResync();
    // لو فُتح البرنامج من النسخة المحلية فقط (cacheOnly) أو فشلت مزامنة سابقة، تكون كل baselines
    // الجلسة الحالية null أو بعضها — أي أنه لا يوجد أساس مؤكد للمقارنة مع السحابة. الفحوصات أدناه
    // كانت تتجاهل التصنيفات ذات baseline null (checkAllRecordsChanged) وتستبعدها checkClientRecordsChanged
    // لأنها "تخزّن" آخر مجموع نسخ عند أول فحص وترجع false — فيبقى المستخدم على بيانات محلية قديمة/
    // فارغة طوال الجلسة دون أي تحميل حقيقي من السحابة، وأي تعديل يُحفظ عبر خط الرجعة القديم (كتلة
    // كاملة) لا يصل لنظام السجلات الجديد ويُفقد عند أول تحميل حقيقي لاحقاً. الحل: ننفّذ فوراً
    // تحميلاً كاملاً من السحابة (loadData(false)) كلما وُجد أي baseline null — بعدها تتأكد كل
    // الـ baselines وتصبح المقارنات أدناه صحيحة (وتُعاد المحاولة تلقائياً كل دقيقتين لو كان الخلل
    // انقطاع اتصال مؤقتاً).
    const needsFullSync = _clientsSyncBaseline === null ||
      Object.keys(_collectionSyncBaseline).some(col => !_collectionSyncBaseline[col]);
    if(needsFullSync){
      await loadData(false);
      await renderAllViewsAfterLoad();
      return;
    }
    // نتحقق بالتوازي من: (أ) نسخ كل مفاتيح kv_store العادية، و(ب) رقم إصدار العملاء فى نظام
    // السجلات المستقلة الجديد (checkClientRecordsChanged)، و(ج) نفس الشيء لبقية الشيتات المحوَّلة
    // للسجلات المستقلة (checkAllRecordsChanged) — كل ذلك بطلبات صغيرة جداً بدون نقل بيانات فعلية
    // إلا لو تغيّر شيء فعلاً، بنفس فكرة storage-versions تماماً.
    const [res, clientsChanged, recordsChanged] = await Promise.all([
      serverFetch('/api/storage-versions'),
      checkClientRecordsChanged(),
      checkAllRecordsChanged(),
    ]);
    if(!res.ok){ markOffline(); return; }
    const data = await res.json();
    markOnline();
    // تحديث دوري لعداد "عمليات قيد الاعتماد" لدى الأدمن (كل دقيقتين) — لو ظهرت إضافات جديدة
    // من موظفي الاستقبال أثناء وجوده في أي شاشة، يظهر الإشعار في لوحة التحكم تلقائياً.
    if(currentUserRole==='admin' && typeof refreshPendingApprovals==='function') refreshPendingApprovals();
    const serverVersions = data.versions || {};
    // نتجاهل مفتاح 'clients' القديم هنا عمداً: أصبح غير مُحدَّث (لم يعد يُكتَب إليه فى المسار
    // السريع الجديد)، والمصدر الصحيح لمعرفة تغيّر العملاء الآن هو checkClientRecordsChanged أعلاه.
    const changedKeys = Object.keys(serverVersions).filter(k => k !== 'clients' && !ALLOWED_COLLECTIONS_LOCAL.includes(k) && (_kvVersions[k] || 0) !== serverVersions[k]);
    if(changedKeys.length || clientsChanged || recordsChanged){
      // تحميل عادي عبر الشبكة: المفاتيح غير المتغيّرة ترجع 304 فوراً (بدون نقل بيانات)،
      // والمفاتيح المتغيّرة فقط هي التي تُنقل فعلياً من السحابة — ثم نعيد رسم كل الشاشات
      // لأننا لا نعرف مسبقاً أي شاشات تعتمد على المفاتيح التي تغيّرت تحديداً.
      await loadData(false);
      await renderAllViewsAfterLoad();
    }
  }catch(e){
    if(e && e.isDecryptFailure){ showFatalDecryptErrorScreen(e); }
    else { markOffline(); }
  } finally {
    _bgSyncInFlight = false;
    if(_bgSyncRerunRequested){
      _bgSyncRerunRequested = false;
      backgroundSyncCheck().catch(()=>{});
    }
  }
}
// إعادة فحص دورية كل دقيقتين، حتى تنعكس تعديلات جهاز/مستخدم آخر تلقائياً بدون الحاجة لإغلاق
// البرنامج وإعادة فتحه — بتكلفة شبكة ضئيلة جداً (طلب واحد صغير) لو لم يتغيّر شيء.
setInterval(()=>{ backgroundSyncCheck().catch(()=>{}); }, 120000);

async function startApp(){
  // يجب ضبط هوية المستخدم الحالي (currentUser/currentUserRole) *قبل* تحميل البيانات مباشرة، حتى
  // تُطبَّق فلترة عزل البيانات لكل مستخدم (filterOwnRecords/canSeeAllData داخل loadData) بالدور
  // الصحيح من أول لحظة تحميل — بدل الاعتماد على القيم الافتراضية (currentUserRole='admin') التي
  // كانت تُضبَط سابقاً فقط بعد اكتمال التحميل والعرض بالكامل (autoSignInLocalUser في آخر السطر).
  currentUser = SERVER_AUTH_USERNAME || 'غير معروف';
  currentUserRole = normalizeRole(SERVER_AUTH_ROLE);
  // شاشة الدخول أُخفيت بالفعل — نعرض "جاري تحميل البيانات..." فوراً حتى لا يبقى المستخدم أمام
  // شاشة سوداء صامتة بينما اكتمال التحميل قد يستغرق وقتاً (سيرفر بطيء/أول فتح كامل بعد استعادة).
  showAppLoadingOverlay();
  // شبكة أمان أخيرة: لو أي خطوة علقت لأي سبب (كاش قديم للـ Service Worker يمنع وصول
  // ملفات JS المحدّثة، طلب شبكة عالق تجاوز مهلة serverFetch，إلخ)， نُجبر إخفاء شاشة التحميل
  // وإظهار الواجهة بعد مهلة بدل ترك المستخدم أمام "دائرة تحميل لا تنتهي" للأبد. المهلة (70ث)
  // أطول من مهلة serverFetch (60ث) فلا تتداخل مع سلوك الفشل الطبيعي لتحميل البيانات.
  const _loadWatchdog = setTimeout(()=>{
    console.warn('[startApp] انتهت مهلة التحميل الاحتياطية — إظهار الواجهة قسراً لتفادي دائرة تحميل لا تنتهي');
    hideAppLoadingOverlay();
    try{ $('#app-wrap').style.display = 'block'; }catch(e){}
  }, 70000);
  try{
    const localFirst = await hasLocalCache();
    if(localFirst){
      // البدء فوراً من آخر نسخة محفوظة على هذا الجهاز، بدون انتظار أي اتصال بالسيرفر — البرنامج
      // يظهر فوراً بنفس البيانات المحفوظة محلياً، ثم تتم المزامنة الفعلية مع السحابة في الخلفية.
      await loadData(true);
    } else {
      // أول تشغيل على هذا الجهاز (لا توجد نسخة محلية بعد) — تحميل كامل من السحابة كالمعتاد.
      await loadData(false);
    }
  }catch(e){
    hideAppLoadingOverlay();
    if(e && e.isDecryptFailure){ showFatalDecryptErrorScreen(e); return; }
    // أي خطأ آخر غير متوقع أثناء تحميل البيانات (وليس فك التشفير تحديداً) كان يُرمى للمتصل (نموذج
    // الدخول)، الذي يكون بالفعل قد أخفى شاشة الدخول قبل استدعاء startApp — فينتهي الأمر بشاشة سوداء
    // تماماً بلا أي رسالة ظاهرة للمستخدم، والخطأ الفعلي يظهر فقط في console. نعرض هنا رسالة واضحة
    // بدل ذلك، مع الاحتفاظ بتسجيل الخطأ الأصلي.
    console.error('startApp: فشل تحميل البيانات', e);
    showFatalDecryptErrorScreen(Object.assign(new Error((e && e.message) || 'خطأ غير متوقع أثناء تحميل بيانات البرنامج'), {}));
    return;
  }
  updateOfflineIndicator();
  clearTimeout(_loadWatchdog);
  // إخفاء شاشة التحميل وإظهار الواجهة الرئيسية (#app-wrap) فوراً — قبل أي عملية رسم
  // أو أي خطوة إضافية، حتى لو فشلت إحدى هذه الخطوات لاحقاً بخطأ غير متوقع لا يبقى المستخدم
  // أمام شاشة سوداء/محمل طوال الوقت. الـ safeStep داخل renderAllViewsAfterLoad تحمي كل خطوة
  // رسم بمعزل عن الأخرى، لكنها لا تحمي من رفع استثناء غير متوقع من itself (Promise مرفوض غير
  // مُعالَج) — لذا نغلفها try/catch إضافي هنا كطبقة أمان أخيرة.
  hideAppLoadingOverlay();
  $('#app-wrap').style.display = 'block';
  try{ await renderAllViewsAfterLoad(); }catch(e){ console.error('startApp: فشلت خطوة "renderAllViewsAfterLoad"', e); }
  autoSignInLocalUser();
  // تشغيل النسخ الاحتياطي التلقائي في الخلفية — لا ننتظره لأنه قد يستغرق وقتاً طويلاً
  // (تنزيل وتشفير ورفع كل بيانات البرنامج) ولا يجب أن يعرقل ظهور الواجهة أو تفاعلها.
  maybeRunAutoBackup().catch(e => console.error('startApp: فشلت خطوة "maybeRunAutoBackup"', e));
  try{ SoundFX.login(); }catch(e){ console.error('startApp: فشلت خطوة "SoundFX.login"', e); }
  backgroundSyncCheck().catch(()=>{}); // مزامنة خلفية فورية بعد ظهور الواجهة، دون تعطيل فتح البرنامج (الأخطاء القاتلة تُعالَج داخلها)
  // إعادة تشغيل جدولة الجلب التلقائي لشيتات جوجل هنا تحديداً — بعد اكتمال تحميل الإعدادات
  // الحقيقية من السيرفر فعلياً (settings أصبحت الآن هي القيمة المحفوظة الحقيقية وليست
  // الافتراضية الفارغة). gsheet-workflow.js يستدعي restartTimer() أيضاً بمؤقت تخميني (2.5
  // ثانية) عند فتح الصفحة، لكن لو تحميل الإعدادات الحقيقية استغرق أطول من ذلك (نت بطيء/تأخر
  // استيقاظ السيرفر)، تلك المحاولة المبكرة تجدوِل صفر شيتات (تراها فارغة وقتها) ولا تُعاد
  // أبداً تلقائياً بعدها — الشيت المفعّل يبقى معطّلاً فعلياً طوال الجلسة رغم ظهوره "مفعّل"
  // في الواجهة، حتى يفتح المستخدم إعدادات الشيتات ويضغط "حفظ" يدوياً (المكان الوحيد الآخر
  // الذي يستدعي restartTimer()). الاستدعاء هنا مضمون التوقيت الصحيح دائماً، وآمن للتكرار
  // (restartTimer يمسح المؤقتات القديمة أولاً قبل إعادة بنائها).
  try{ if(typeof restartTimer==='function') restartTimer(); }catch(e){}
  // اتصال البث اللحظي (SSE): لو متصل بالسيرفر فعلياً (SERVER_AUTH_TOKEN موجود)، أي تعديل لاحق
  // من مستخدم آخر يصل هنا فوراً بدل انتظار الفحص الدوري كل دقيقتين (راجع sse-client.js).
  try{ if(typeof connectRealtimeEvents==='function') connectRealtimeEvents(); }catch(e){ console.error('startApp: فشلت خطوة "connectRealtimeEvents"', e); }
}

/* ---------------- License gate: يجب التحقق من كود الترخيص قبل تشغيل أي جزء من البرنامج ---------------- */
function showLicenseScreen(errorMsg){
  $('#license-screen').style.display = 'flex';
  if(errorMsg){
    $('#license-error').textContent = errorMsg;
    $('#license-error').style.display = 'block';
  }
}

async function ensureServerLoginThenStart(){
  // دخول تلقائي عبر رابط بالإيميل (Magic Link) لو الرابط الحالي يحتوي على معطيات الرابط
  // (?magicToken=...&u=...) — يُفحص هذا أولاً وقبل أي جلسة محفوظة، لأن ضغط رابط جديد من الإيميل
  // يجب أن يأخذ الأولوية دائماً. نُزيل المعطيات من شريط العنوان فوراً بغض النظر عن النتيجة، حتى
  // لا يُعاد استخدام نفس الرابط بالخطأ (تحديث الصفحة مثلاً) — الرابط أصلاً صالح لمرة واحدة فقط.
  try{
    const params = new URLSearchParams(window.location.search);
    const magicToken = params.get('magicToken');
    const magicUser = params.get('u');
    if(magicToken && magicUser){
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
      try{
        const loginData = await magicLinkVerify(magicUser, magicToken);
        $('#server-login-screen').style.display = 'none';
        await startApp();
        checkPendingQrLoginApproval();
        const displayName = (loginData && loginData.user && loginData.user.displayName) || magicUser;
        showToast(`${arabicTimeGreeting()} يا ${displayName} 👋`);
        return;
      }catch(e){
        console.error('[MagicLink] فشل الدخول عبر الرابط:', e);
        showServerLoginScreen('تعذّر الدخول عبر هذا الرابط: ' + (e.message || 'رابط غير صالح أو منتهي الصلاحية') + ' — جرّب الدخول العادي أو اطلب رابطاً جديداً');
        return;
      }
    }
  }catch(e){ console.error('[MagicLink] خطأ أثناء فحص رابط الدخول:', e); }

  const saved = (()=>{ try{ return sessionStorage.getItem('serverAuthToken'); }catch(e){ return null; } })();
  if(saved){
    SERVER_AUTH_TOKEN = saved;
    try{
      const res = await fetch(API_BASE + '/api/storage/settings', { headers: { Authorization: 'Bearer ' + saved } });
      if(res.ok){
        try{
          SERVER_AUTH_USERNAME = sessionStorage.getItem('serverAuthUsername') || null;
          SERVER_AUTH_ROLE = normalizeRole(sessionStorage.getItem('serverAuthRole'));
        }catch(e){ SERVER_AUTH_ROLE = 'staff'; }
        $('#server-login-screen').style.display = 'none';
        await startApp();
        checkPendingQrLoginApproval();
        return;
      }
      // رد صريح من السيرفر (401/403 غالباً) بأن الجلسة نفسها لم تعد صالحة — هنا فقط نطلب دخولاً
      // جديداً، لأن هذا رفض فعلي وليس مجرد تعذّر اتصال.
      SERVER_AUTH_TOKEN = null;
      try{
        sessionStorage.removeItem('serverAuthToken');
        sessionStorage.removeItem('serverAuthUsername');
        sessionStorage.removeItem('serverAuthRole');
      }catch(e){ console.error('[Purchases] Failed to clear session on 401:', e); }
      showServerLoginScreen(null);
      return;
    }catch(e){
      // تعذّر اتصال فعلي بالسيرفر (لا رد إطلاقاً، مثل انقطاع الإنترنت) — الجلسة نفسها قد تكون
      // لا تزال صالحة تماماً، فلا داعي لإجبار المستخدم على إعادة الدخول لمجرد انقطاع مؤقت. نكمل
      // بنفس بيانات الجلسة المحفوظة، وندخل تلقائياً في وضع "العمل من الجهاز فقط".
      try{
        SERVER_AUTH_USERNAME = sessionStorage.getItem('serverAuthUsername') || null;
        SERVER_AUTH_ROLE = normalizeRole(sessionStorage.getItem('serverAuthRole'));
      }catch(e2){ SERVER_AUTH_ROLE = 'staff'; }
      setManualOfflineMode(true);
      showToast('تعذّر الاتصال بالسيرفر — تم المتابعة تلقائياً بوضع العمل من الجهاز فقط');
      $('#server-login-screen').style.display = 'none';
      await startApp();
      checkPendingQrLoginApproval();
      return;
    }
  }
  // لا توجد جلسة محفوظة لهذا التشغيل (أول فتح، أو بعد إغلاق التطبيق بالكامل وإعادة فتحه). نتحقق
  // أولاً هل السيرفر قابل للوصول أصلاً (حتى بدون توكن) — أي رد فعلي منه (ولو 401) يعني أن الاتصال
  // سليم، فتظهر شاشة الدخول العادية كالمعتاد. الفشل الوحيد الذي يُفعِّل مسار "الدخول بلا إنترنت"
  // أسفل شاشة الدخول هو فشل اتصال حقيقي (راجع سجل نموذج الدخول، حيث تُجرَّب بيانات الدخول أولاً
  // ضد السيرفر ثم محلياً فقط إن تعذّر الوصول إليه إطلاقاً).
  showServerLoginScreen(null);
}
// الوضع الليلي/النهاري على شاشة الدخول نفسها، قبل تسجيل الدخول أصلاً — تفضيل خاص
// بهذا الجهاز فقط (مستقل عن تفضيل المستخدم المحفوظ على السيرفر، والذي يتفوّق عليه
// تلقائياً بمجرد نجاح الدخول عبر startApp -> applyTheme(settings.darkMode)).
const LOGIN_THEME_KEY = 'ftcLoginThemeDark';
(function(){
  try{
    if(localStorage.getItem(LOGIN_THEME_KEY) === '1') document.body.classList.add('dark-theme');
  }catch(e){ console.error('[Auth] Failed to load login theme preference:', e); }
  const themeBtn = $('#login-theme-toggle');
  if(themeBtn){
    const syncIcons = ()=>{
      const isDark = document.body.classList.contains('dark-theme');
      const moonIcon = themeBtn.querySelector('.icon-moon');
      const sunIcon = themeBtn.querySelector('.icon-sun');
      if(moonIcon) moonIcon.style.display = isDark ? 'none' : '';
      if(sunIcon) sunIcon.style.display = isDark ? '' : 'none';
    };
    syncIcons();
    themeBtn.addEventListener('click', ()=>{
      const isDark = document.body.classList.toggle('dark-theme');
      try{ localStorage.setItem(LOGIN_THEME_KEY, isDark ? '1' : '0'); }catch(e){ console.error('[Auth] Failed to save login theme preference:', e); }
      syncIcons();
    });
  }
})();

// الدخول بالبصمة/Face ID بدل كلمة المرور — بدون كتابة اسم مستخدم إطلاقاً، بضغطة واحدة. يظهر
// الزر فقط لو المتصفح/الجهاز يدعم WebAuthn أصلاً (window.PublicKeyCredential). المتصفح نفسه
// يعرض للمستخدم بصماته المسجَّلة لهذا الموقع فيختار منها مباشرة (discoverable credentials).
(function(){
  const waBtn = $('#btn-webauthn-login');
  if(!waBtn) return;
  if(typeof webauthnSupported === 'function' && webauthnSupported()) waBtn.style.display = '';
  waBtn.addEventListener('click', async ()=>{
    waBtn.disabled = true;
    $('#server-login-error').style.display = 'none';
    try{
      const loginData = await webauthnLogin();
      $('#server-login-screen').style.display = 'none';
      await startApp();
      checkPendingQrLoginApproval();
      const displayName = (loginData && loginData.user && loginData.user.displayName) || loginData.username;
      showToast(`${arabicTimeGreeting()} يا ${displayName} 👋`);
    }catch(e){
      console.error('[WebAuthn] فشل الدخول بالبصمة:', e);
      if(e.name !== 'NotAllowedError'){
        $('#server-login-error').textContent = e.message || 'تعذّر الدخول بالبصمة';
        $('#server-login-error').style.display = 'block';
      }
    }finally{
      waBtn.disabled = false;
    }
  });
})();

// دخول بمسح الكود (QR، زي واتساب ويب) — يولّد الديسكتوب رمز QR يحتوي على رابط لهذا البرنامج
// نفسه بمعرّف جلسة مؤقت، يمسحه المستخدم بكاميرا موبايله العادية وهو مسجّل دخول بالفعل على
// موبايله، فيوافق هناك، فيدخل الديسكتوب تلقائياً — بدون الحاجة لأي ماسح QR داخل البرنامج نفسه.
let _qrLoginPollTimer = null;
function stopQrLoginPolling(){
  if(_qrLoginPollTimer){ clearInterval(_qrLoginPollTimer); _qrLoginPollTimer = null; }
}
async function openQrLoginModal(){
  const modal = $('#qr-login-modal');
  const statusEl = $('#qr-login-status');
  if(!modal) return;
  modal.style.display = 'flex';
  statusEl.textContent = 'جارٍ توليد الكود...';
  try{
    const res = await fetch(API_BASE + '/api/auth/qr-login/create', { method:'POST' });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر توليد الكود');
    const loginUrl = window.location.origin + window.location.pathname + '?qrLoginSession=' + encodeURIComponent(data.sessionId);
    if(typeof QRious !== 'undefined'){
      new QRious({ element: $('#qr-login-canvas'), value: loginUrl, size: 220, level: 'M' });
    }
    statusEl.textContent = 'فى انتظار المسح والموافقة من موبايلك...';
    stopQrLoginPolling();
    const expiresAtMs = data.expiresAt ? new Date(data.expiresAt).getTime() : (Date.now() + 3*60*1000);
    _qrLoginPollTimer = setInterval(async ()=>{
      if(Date.now() > expiresAtMs){
        stopQrLoginPolling();
        statusEl.textContent = 'انتهت صلاحية الكود — اضغط الزر تحت لتوليد كود جديد';
        return;
      }
      try{
        const pollRes = await fetch(API_BASE + '/api/auth/qr-login/status/' + encodeURIComponent(data.sessionId));
        const pollData = await pollRes.json();
        if(pollData.status === 'approved'){
          stopQrLoginPolling();
          SERVER_AUTH_TOKEN = pollData.token;
          SERVER_AUTH_USERNAME = pollData.username;
          SERVER_AUTH_ROLE = normalizeRole(pollData.role);
          try{
            sessionStorage.setItem('serverAuthToken', pollData.token);
            sessionStorage.setItem('serverAuthUsername', SERVER_AUTH_USERNAME);
            sessionStorage.setItem('serverAuthRole', SERVER_AUTH_ROLE);
          }catch(e){ console.error('[QR Login] Failed to store session token:', e); }
          modal.style.display = 'none';
          $('#server-login-screen').style.display = 'none';
          await startApp();
          const displayName = (pollData.user && pollData.user.displayName) || pollData.username;
          showToast(`${arabicTimeGreeting()} يا ${displayName} 👋`);
        }else if(pollData.status === 'rejected'){
          stopQrLoginPolling();
          statusEl.textContent = 'تم رفض طلب الدخول من الموبايل';
        }else if(pollData.status === 'expired'){
          stopQrLoginPolling();
          statusEl.textContent = 'انتهت صلاحية الكود — اضغط الزر تحت لتوليد كود جديد';
        }
      }catch(e){ console.error('[QR Login] فشل التحقق من حالة الكود:', e); }
    }, 2000);
  }catch(e){
    console.error('[QR Login] فشل توليد كود الدخول:', e);
    statusEl.textContent = '⚠️ تعذّر توليد الكود، حاول مرة أخرى';
  }
}
(function(){
  const openBtn = $('#btn-qr-login-open');
  const closeBtn = $('#btn-qr-login-close');
  if(openBtn) openBtn.addEventListener('click', openQrLoginModal);
  if(closeBtn) closeBtn.addEventListener('click', ()=>{
    stopQrLoginPolling();
    $('#qr-login-modal').style.display = 'none';
  });
})();

// دخول بمسح الكود (QR) — لو هذا الجهاز فتح رابط QR وُلِّد من جهاز آخر (بعد تسجيل الدخول هنا
// بأي طريقة)، نعرض تأكيداً بسيطاً قبل الموافقة على تسجيل دخول الجهاز الآخر بنفس هذا الحساب.
// يُستدعى بعد كل نجاح فى تسجيل الدخول على هذا الجهاز (راجع نداءات checkPendingQrLoginApproval
// المضافة بعد كل await startApp() فى هذا الملف).
async function checkPendingQrLoginApproval(){
  let sessionId = null;
  try{ sessionId = sessionStorage.getItem('pendingQrLoginSession'); }catch(e){ return; }
  if(!sessionId) return;
  try{ sessionStorage.removeItem('pendingQrLoginSession'); }catch(e){ console.error('[QR Login] Failed to clear pending session:', e); }
  const approve = await customConfirm('فيه جهاز تاني عايز يدخل بحسابك عن طريق مسح الكود — توافق؟');
  try{
    const res = await fetch(API_BASE + '/api/auth/qr-login/' + (approve ? 'approve' : 'reject') + '/' + encodeURIComponent(sessionId), {
      method: 'POST', headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN },
    });
    if(res.ok) showToast(approve ? 'تم تسجيل دخول الجهاز الآخر بحسابك ✅' : 'تم رفض طلب الدخول');
    else showToast('تعذّر الرد على طلب الدخول (انتهت صلاحية الكود على الأرجح)');
  }catch(e){ console.error('[QR Login] فشل الرد على طلب الدخول:', e); }
}

// طلب رابط دخول بالإيميل — يحتاج فقط اسم المستخدم المكتوب فى الحقل (نفس منطق زر البصمة أعلاه).
(function(){
  const magicBtn = $('#btn-magic-link-request');
  if(!magicBtn) return;
  magicBtn.addEventListener('click', async ()=>{
    const uname = $('#server-login-user').value.trim();
    if(!uname){ $('#server-login-user').focus(); showToast('اكتب اسم المستخدم أولاً'); return; }
    magicBtn.disabled = true;
    try{
      const result = await magicLinkRequest(uname);
      showToast(result.message || 'لو الحساب موجود وعنده إيميل مسجَّل، هيوصله رابط دخول خلال دقائق');
    }catch(e){
      console.error('[MagicLink] فشل طلب رابط الدخول:', e);
      showToast('تعذّر إرسال الرابط، حاول لاحقاً');
    }finally{
      magicBtn.disabled = false;
    }
  });
})();

// إظهار/إخفاء كلمة المرور في شاشة الدخول (لا تُخزَّن أي بيانات، مجرد تبديل نوع الحقل)
(function(){
  const toggleBtn = $('#server-login-pass-toggle');
  const passInput = $('#server-login-pass');
  if(toggleBtn && passInput){
    toggleBtn.addEventListener('click', ()=>{
      const showing = passInput.type === 'text';
      passInput.type = showing ? 'password' : 'text';
      const eyeIcon = toggleBtn.querySelector('.icon-eye');
      const eyeOffIcon = toggleBtn.querySelector('.icon-eye-off');
      if(eyeIcon) eyeIcon.style.display = showing ? '' : 'none';
      if(eyeOffIcon) eyeOffIcon.style.display = showing ? 'none' : '';
      toggleBtn.title = showing ? 'إظهار كلمة المرور' : 'إخفاء كلمة المرور';
      toggleBtn.setAttribute('aria-label', toggleBtn.title);
      passInput.focus();
    });
  }
})();

// تذكّر اسم المستخدم فقط (وليس كلمة المرور إطلاقاً) على هذا الجهاز، لتسريع الدخول لاحقاً
const REMEMBER_USERNAME_KEY = 'ftcRememberedUsername';
(function(){
  try{
    const remembered = localStorage.getItem(REMEMBER_USERNAME_KEY);
    if(remembered){
      const uField = $('#server-login-user');
      const rCheck = $('#server-login-remember');
      if(uField) uField.value = remembered;
      if(rCheck) rCheck.checked = true;
      const passEl = $('#server-login-pass');
      if(passEl) setTimeout(()=> passEl.focus(), 0);
    }
  }catch(e){ console.error('[Auth] Failed to load remembered username:', e); }
})();

$('#server-login-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const uname = $('#server-login-user').value.trim();
  const upass = $('#server-login-pass').value;
  const totpCode = $('#server-login-2fa').value.trim();
  $('#server-login-error').style.display = 'none';
  if(btn) btn.disabled = true;
  try{
    const loginData = await serverLogin(uname, upass, totpCode || undefined);
    try{
      const rCheck = $('#server-login-remember');
      if(rCheck && rCheck.checked) localStorage.setItem(REMEMBER_USERNAME_KEY, uname);
      else localStorage.removeItem(REMEMBER_USERNAME_KEY);
    }catch(e){ console.error('[Auth] Failed to persist remembered username:', e); }
    $('#server-login-screen').style.display = 'none';
    await startApp();
    checkPendingQrLoginApproval();
    // رسالة ترحيب حسب توقيت اليوم، باسم المستخدم الظاهر إن وُجد
    const displayName = (loginData && loginData.user && loginData.user.displayName) || uname;
    showToast(`${arabicTimeGreeting()} يا ${displayName} 👋`);
    // آخر دخول ناجح سابق لهذا الحساب + تنبيه لو هذا أول دخول من هذا الجهاز تحديداً (لرصد أي
    // دخول غريب) — تُعرض كرسالة تالية بعد رسالة الترحيب (showToast تعرض رسالة واحدة فقط فى
    // كل مرة وتستبدل أي رسالة سابقة لسه ظاهرة، فنؤجلها قليلاً بدل استبدال الترحيب فوراً).
    const lastLoginNote = (loginData && loginData.lastLogin && loginData.lastLogin.at)
      ? `آخر دخول سابق: ${new Date(loginData.lastLogin.at).toLocaleString('ar-SA-u-nu-latn', {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'})}${loginData.lastLogin.ip ? ' من ' + loginData.lastLogin.ip : ''}`
      : null;
    const newDeviceNote = (loginData && loginData.newDeviceAlert) ? '⚠️ أول دخول من هذا الجهاز لهذا الحساب' : null;
    // تنبيه دولة غير معتادة (geoAlert لا يُرسَل من السيرفر إلا لو اختلفت دولة الدخول الحالي عن
    // الدولة الأكثر تكراراً لدخولات هذا الحساب السابقة — راجع geolocateIp فى server/auth.js).
    const geoNote = (loginData && loginData.geoAlert && loginData.geoAlert.country)
      ? `⚠️ دخول من دولة غير معتادة: ${loginData.geoAlert.country}${loginData.geoAlert.city ? ' - ' + loginData.geoAlert.city : ''} (المعتاد: ${loginData.geoAlert.usualCountry})`
      : null;
    if(lastLoginNote || newDeviceNote || geoNote){
      setTimeout(()=> showToast([newDeviceNote, geoNote, lastLoginNote].filter(Boolean).join(' — ')), 2700);
    }
    // ملاحظة: كان يُظهر تنبيه الأنشطة المشتبكة هنا مباشرة بعد تسجيل الدخول، لكنه
    // أُزيل لتجنب تأخيل استجابة تسجيل الدخول على الخادم — الآن يُفحص في الخلفية
    // على الخادم، ويمكن للمدير مراجعته من شاشة "سجل الدخول" في الإعدادات.
  }catch(err){
    if(err && err.requires2FA){
      $('#server-login-2fa-field').style.display = 'block';
      $('#server-login-2fa').focus();
      $('#server-login-error').textContent = 'أدخل كود المصادقة الثنائية من تطبيق المصادقة';
      $('#server-login-error').style.display = 'block';
      if(btn) btn.disabled = false;
      return;
    }
    if(err && err.networkError){
      // تعذّر الوصول للسيرفر إطلاقاً (لا إنترنت) — نجرّب التحقق من بيانات الدخول نفسها محلياً
      // مقابل التجزئة المحفوظة من آخر تسجيل دخول ناجح لهذا المستخدم بالذات على هذا الجهاز، بدل
      // حجب البرنامج بالكامل لمجرد انقطاع الإنترنت.
      const offline = await tryOfflineLogin(uname, upass);
      if(offline){
        SERVER_AUTH_TOKEN = null;
        SERVER_AUTH_USERNAME = offline.username;
        SERVER_AUTH_ROLE = normalizeRole(offline.role);
        setManualOfflineMode(true);
        showToast('تعذّر الاتصال بالسيرفر — تم الدخول بوضع العمل من الجهاز فقط ببيانات هذا المستخدم المحفوظة محلياً');
        $('#server-login-screen').style.display = 'none';
        await startApp();
        checkPendingQrLoginApproval();
        return;
      }
      $('#server-login-error').textContent = 'تعذّر الاتصال بالسيرفر، ولا يوجد تسجيل دخول محفوظ بهذا الاسم/كلمة المرور على هذا الجهاز';
      $('#server-login-error').style.display = 'block';
    }else{
      $('#server-login-error').textContent = err.message || 'تعذّر تسجيل الدخول، تحقق من اسم المستخدم وكلمة المرور';
      $('#server-login-error').style.display = 'block';
    }
  }finally{
    if(btn) btn.disabled = false;
  }
});

let LICENSE_EXPIRY_DATE = null; // تُستخدم في تنبيهات الداشبورد لتذكير المستخدم قبل انتهاء الترخيص
async function activateAndStart(encKeyRaw, expiryDate, clientId){
  ENC_KEY = await crypto.subtle.importKey('raw', base64ToBytes(encKeyRaw), {name:'AES-GCM'}, false, ['encrypt','decrypt']);
  if(expiryDate) LICENSE_EXPIRY_DATE = expiryDate;
  try{
    localStorage.setItem(LICENSE_CACHE_KEY, JSON.stringify({
      encKeyRaw,
      expiryDate: expiryDate ? new Date(expiryDate).toISOString() : null,
      clientId: clientId || null,
      cachedAt: new Date().toISOString(),
    }));
  }catch(e){ console.error('[Purchases] Failed to cache license:', e); }
  $('#license-screen').style.display = 'none';
  await ensureServerLoginThenStart();
}

$('#license-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const input = $('#license-key-input').value.trim();
  $('#license-error').style.display = 'none';
  if(btn) btn.disabled = true;
  try{
    const result = await validateLicenseKey(input);
    if(result.valid){
      const cleaned = input.replace(/[\s-]/g,'').toUpperCase();
      localStorage.setItem(LICENSE_STORAGE_KEY, cleaned);
      await activateAndStart(result.encKeyRaw, result.expiryDate, result.clientId);
    }else{
      $('#license-error').textContent = result.reason || 'كود الترخيص غير صالح';
      $('#license-error').style.display = 'block';
    }
  }finally{
    if(btn) btn.disabled = false;
  }
});

