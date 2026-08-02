/* ========== نسخ احتياطي كامل / استعادة ========== */
function gatherFullBackupData(){
  // مصفوفة users القديمة (من قبل نظام المصادقة الحقيقي على السيرفر) لا تُستخدم فى أي تحقق هوية
  // فعلي الآن (المصادقة الحقيقية عبر جدول server_users المشفّر — راجع hashPassword/verifyPassword
  // فى server.js)؛ الاستخدام الوحيد المتبقي لها هو قراءة username/role فقط (راجع isReceptionUsername
  // فى module-finance.js). حقل password بداخلها لا يُقرأ فى أي مكان إطلاقاً، فلا داعي لتضمينه هنا —
  // تضمينه كان يعني تسريب كلمة مرور حقيقية (أو الافتراضية) نص صريح فى كل نسخة احتياطية.
  const usersWithoutPasswords = users.map(({ password, ...rest }) => rest);
  return {
    _backupType: 'مركز-فهد-نسخة-احتياطية-كاملة',
    _createdAt: new Date().toISOString(),
    clients, settings, bagStock, vaultTx, courseSessions,
    users: usersWithoutPasswords, auditLog, companies, companyTransfers, journalEntries, bankStatementRows,
    suppliers, purchases, vaultDenomTx, manualSalesInvoices, zakatAdjustments,
    chartOfAccounts, journalDE, budgetEntries, scheduledVaultTx
  };
}
function downloadFullBackup(auto){
  const data = gatherFullBackupData();
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `نسخة_احتياطية_كاملة_${stampNow()}${auto?'_تلقائية':''}.json`;
  a.click();
}
async function maybeRunAutoBackup(){
  if(!settings.autoBackupEnabled) return;
  const intervalMs = (Number(settings.autoBackupIntervalDays)||7) * 86400000;
  const last = settings.lastAutoBackupAt ? new Date(settings.lastAutoBackupAt).getTime() : 0;
  if(Date.now() - last < intervalMs) return;
  downloadFullBackup(true);
  await uploadBackupToServer('auto');
  settings.lastAutoBackupAt = new Date().toISOString();
  await saveSettings();
  showToast('تم إنشاء نسخة احتياطية تلقائية (محلياً + على السيرفر)');
}
// يرفع نسخة كاملة مشفّرة (بنفس مفتاح تشفير بيانات البرنامج) إلى السيرفر — أمان: السيرفر يخزّن
// الكتلة المشفّرة فقط، فلن يقدر أي شخص يطّلع على البيانات دون مفتاح التشفير المحلي نفسه (تماماً
// كباقي بيانات البرنامج المخزّنة فى collection_records/client_records).
async function uploadBackupToServer(kind){
  try{
    const data = gatherFullBackupData();
    const enc = await encryptValue(JSON.stringify(data));
    const res = await serverFetch('/api/backups', { method:'POST', body: JSON.stringify({ kind, enc }) });
    if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error || 'فشل الرفع');
    return true;
  }catch(e){ console.error('uploadBackupToServer', e); return false; }
}
async function listServerBackups(){
  try{
    const res = await serverFetch('/api/backups');
    if(!res.ok) throw new Error('تعذّر جلب القائمة');
    return await res.json();
  }catch(e){ return []; }
}
async function downloadServerBackup(id){
  const res = await serverFetch(`/api/backups/${encodeURIComponent(id)}`);
  if(!res.ok) throw new Error('تعذّر جلب النسخة');
  const row = await res.json();
  const plaintext = await decryptValue(row.enc);
  const blob = new Blob([plaintext], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `نسخة_احتياطية_سيرفر_${row.id}_${stampNow()}.json`;
  a.click();
}
async function deleteServerBackup(id){
  const res = await serverFetch(`/api/backups/${encodeURIComponent(id)}`, { method:'DELETE' });
  if(!res.ok) throw new Error('تعذّر حذف النسخة');
}
const RESTORE_RESYNC_FLAG_KEY = 'ftcPendingFullResyncAfterRestore';
const RESTORE_OLD_SNAPSHOT_KEY = 'ftcPreRestoreSnapshotEnc';

/* ============================================================================
   إصلاح خلل "تعارض عند الاستعادة": كانت الاستعادة تستبدل المصفوفات فى الذاكرة فقط، ثم تحفظها
   معتمدةً على آخر baseline/أرقام نسخ محلية معروفة من هذه الجلسة (والتي قد تكون قديمة تماماً —
   مثال شائع: استعادة نسخة احتياطية مباشرة بعد "ضبط المصنع"، أو بعد استعادة تمت بينما هذا الجهاز
   كان غير متصل). أي عدم تطابق بين ما يظنه الجهاز (النسخة/الـ baseline المحلية) وما هو موجود فعلياً
   على السيرفر كان يجعل السيرفر يرفض الحفظ ببعض السجلات بخطأ 409 "تعارض" رغم عدم وجود أي تعديل
   متزامن حقيقي من جهاز آخر. الحل: نمسح فعلياً كل البيانات على السيرفر أولاً (تماماً كنقطة بداية
   "ضبط المصنع")، ثم نُصفِّر كل حالة تتبّع المزامنة المحلية، وأيضاً نحدّث رقم النسخة الحقيقي لمفاتيح
   settings/users/zakatAdjustments (اللي لسه على الطريقة القديمة فى kv_store ولا تدخل ضمن مسح
   السجلات المستقلة أعلاه)، بحيث تُكتَب كل بيانات النسخة الاحتياطية كسجلات جديدة تماماً بلا أي
   تعارض ممكن — سواء تم هذا المسح فوراً وقت الاستعادة (متصل) أو لاحقاً عند عودة الاتصال (راجع
   resyncRestoredDataWithServer وcheckPendingRestoreResync أسفل).
   ============================================================================ */
async function wipeServerDataForFreshRestore(){
  try{
    await serverFetch('/api/client-records', { method: 'DELETE' });
    for(const c of ALLOWED_COLLECTIONS_LOCAL){
      await serverFetch(`/api/records/${encodeURIComponent(c)}`, { method: 'DELETE' });
    }
  }catch(e){ console.error('wipeServerDataForFreshRestore: تعذّر مسح بيانات السيرفر', e); throw e; }
  Object.keys(_clientRecordVersions).forEach(k=> delete _clientRecordVersions[k]);
  clientRecordMeta = {};
  _clientRecordsAggVersion = null;
  _clientsSyncBaseline = new Map();
  for(const c of ALLOWED_COLLECTIONS_LOCAL){
    _recordVersions[c] = new Map();
    _collectionSyncBaseline[c] = new Map();
  }
  try{
    await Promise.allSettled([
      window.storage.primeKeyVersion('settings'),
      window.storage.primeKeyVersion('users'),
      window.storage.primeKeyVersion('zakatAdjustments'),
    ]);
  }catch(e){ console.error('wipeServerDataForFreshRestore: تعذّر تحديث أرقام نسخ settings/users/zakatAdjustments', e); }
}
// يرفع كل بيانات البرنامج الحالية (الموجودة فعلاً فى متغيرات الذاكرة الآن) للسيرفر من جديد —
// تُستدعى بعد wipeServerDataForFreshRestore مباشرة، سواء وقت الاستعادة نفسها (متصل) أو لاحقاً
// عند عودة الاتصال لو تمت الاستعادة أصلاً بدون اتصال.
async function pushCurrentDataToServer(){
  await Promise.allSettled([
    saveClients(true), saveSettings(), saveBagStock(), saveVaultTx(),
    saveCourseSessions(), saveUsers(), saveAuditLog(), saveCompanies(), saveCompanyTransfers(), saveJournalEntries(), saveBankStatementRows(),
    saveSuppliers(), savePurchases(), saveVaultDenomTx(), saveManualSalesInvoices(), saveZakatAdjustments(),
    saveChartOfAccounts(), saveJournalDE(), saveBudgetEntries(), saveScheduledVaultTx()
  ]);
}
function isCurrentlyOffline(){ return manualOfflineMode || _ftcIsOffline; }

async function restoreFullBackup(file){
  let data;
  try{
    const text = await file.text();
    data = JSON.parse(text);
  }catch(e){ showToast('تعذّرت قراءة ملف النسخة الاحتياطية — تأكد أنه ملف JSON صحيح'); return; }
  if(!data || typeof data!=='object' || !('clients' in data) || !('settings' in data)){
    showToast('هذا الملف لا يبدو نسخة احتياطية صحيحة لهذا البرنامج'); return;
  }
  if(!await customConfirm('سيتم استبدال كل البيانات الحالية في البرنامج (العملاء، الدورات، الحقائب، الحركات المالية، الشركات، الإعدادات، المستخدمين، وسجل المراجعة) بمحتوى ملف النسخة الاحتياطية المختار.\n\nستُحفَظ نسخة من البيانات الحالية (قبل الاستبدال) محلياً وعلى السيرفر أيضاً، يمكن الرجوع إليها لاحقاً إذا احتجت التراجع. هل تريد المتابعة؟')){
    return;
  }
  // نسخة احتياطية محلية (ملف على الجهاز) من الوضع الحالي قبل الاستبدال، تحسّباً
  downloadFullBackup(false);

  const wasOffline = isCurrentlyOffline();
  if(!wasOffline){
    // نحتفظ بنسخة من البيانات "القديمة" (قبل الاستعادة) على السيرفر أيضاً — بجانب الملف المحلي
    // أعلاه — حتى يمكن الرجوع إليها لاحقاً من قائمة "النسخ المحفوظة على السيرفر" فى الإعدادات لو
    // احتاج المستخدم التراجع عن هذه الاستعادة.
    try{ await uploadBackupToServer('قبل استعادة نسخة أخرى'); }
    catch(e){ console.error('restoreFullBackup: تعذّر حفظ نسخة السيرفر القديمة قبل الاستعادة', e); }
  }else{
    // بدون اتصال: لا يمكن رفع نسخة البيانات القديمة للسيرفر الآن، فنحفظها مشفَّرة محلياً لحين
    // عودة الاتصال، حيث تُرفَع تلقائياً كنسخة احتياطية على السيرفر (راجع مستمع 'online' أسفل الملف).
    try{
      const oldSnapshotEnc = await encryptValue(JSON.stringify(gatherFullBackupData()));
      localStorage.setItem(RESTORE_OLD_SNAPSHOT_KEY, oldSnapshotEnc);
    }catch(e){ console.error('restoreFullBackup: تعذّر حفظ نسخة البيانات القديمة محلياً لرفعها لاحقاً', e); }
  }

  // مسح فعلي لبيانات السيرفر وتصفير تتبّع المزامنة يحدث الآن فقط لو متصلين فعلاً؛ لو غير متصلين
  // نؤجّله بالكامل حتى عودة الاتصال (راجع resyncRestoredDataWithServer وcheckPendingRestoreResync
  // أسفل) حتى لا نحاول التواصل مع سيرفر غير متاح الآن دون فائدة.
  if(!wasOffline){
    try{ await wipeServerDataForFreshRestore(); }
    catch(e){ /* فشل المسح مسجَّل بالفعل داخل الدالة؛ نكمل الاستعادة محلياً على أي حال */ }
  }

  clients = data.clients || [];
  settings = data.settings || JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  bagStock = data.bagStock || [];
  vaultTx = data.vaultTx || [];
  courseSessions = data.courseSessions || [];
  users = data.users && data.users.length ? data.users : users;
  auditLog = data.auditLog || [];
  companies = data.companies || [];
  companyTransfers = data.companyTransfers || [];
  journalEntries = data.journalEntries || [];
  bankStatementRows = data.bankStatementRows || [];
  suppliers = data.suppliers || [];
  purchases = data.purchases || [];
  vaultDenomTx = data.vaultDenomTx || [];
  scheduledVaultTx = data.scheduledVaultTx || [];
  manualSalesInvoices = data.manualSalesInvoices || [];
  zakatAdjustments = data.zakatAdjustments || {};
  chartOfAccounts = data.chartOfAccounts || [];
  seedChartOfAccountsIfEmpty();
  journalDE = data.journalDE || [];
  budgetEntries = data.budgetEntries || [];
  // يُطبَّق دائماً على الذاكرة والكاش المحلي فوراً بغضّ النظر عن الاتصال؛ كل دالة save* هنا تتعامل
  // بالفعل مع انقطاع الاتصال بحفظ محلي + طابور رفع تلقائي (راجع window.storage.set وsaveOneRecordGeneric)،
  // فتُطبَّق الاستعادة محلياً فوراً حتى بدون سيرفر، وتُرفَع لاحقاً تلقائياً عند توفر الاتصال.
  await pushCurrentDataToServer();

  if(wasOffline){
    // نسجّل أن هناك استعادة كاملة بانتظار مزامنتها الحقيقية مع السيرفر (مسح + رفع نظيف بلا تعارض)
    // بمجرد عودة الاتصال، بدل الاكتفاء بالمزامنة الجزئية العادية لطابور "التعديلات المعلَّقة".
    try{ localStorage.setItem(RESTORE_RESYNC_FLAG_KEY, '1'); }catch(e){ console.error(e); }
  }else{
    // متصلون والاستعادة رُفعت للسيرفر فعلاً — نمسح الكاش المحلي القديم (بيانات ما قبل الاستعادة)
    // ونعيد فتح البرنامج بالكامل من السيرفر. بدون هذا، لو بقي الكاش القديم، أي فتح تالٍ من الكاش
    // (hasLocalCache → loadData(cacheOnly)) كان يُظهر بيانات الاستعادة القديمة وكأنها ما زالت موجودة،
    // وأي تعديل لاحق يبني على تلك البيانات يُكتب فوق الجديد بشكل خاطئ — وهو نفس مسار فقدان البيانات
    // الذي تسبب به الكاش المتقادم. إعادة الفتح (location.reload) تضمن أن كل ما يعمل به البرنامج بعد
    // الاستعادة هو بالضبط ما وُضع على السيرفر، مع تحميل حقيقي كامل (لأن الكاش أصبح فارغاً).
    try{ await _kvCacheClearKv(); }catch(e){ console.error('restoreFullBackup: تعذّر مسح الكاش المحلي', e); }
    setTimeout(()=>{ try{ location.reload(); }catch(e){} }, 1500);
  }

  await logAudit('edit','الإعدادات', wasOffline
    ? 'تمت استعادة كل بيانات البرنامج محلياً من ملف نسخة احتياطية (بانتظار المزامنة الكاملة مع السيرفر عند عودة الاتصال)'
    : 'تمت استعادة كل بيانات البرنامج من ملف نسخة احتياطية، مع حفظ نسخة من البيانات القديمة على السيرفر');
  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderTable==='function') renderTable();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderCompanies==='function') renderCompanies();
  if(typeof renderPurchases==='function') renderPurchases();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderBudget==='function') renderBudget();
  if(typeof renderAccounting==='function') renderAccounting();
  if(typeof renderAuditLog==='function') renderAuditLog();
  if(typeof renderSettings==='function') renderSettings();
  if(typeof renderZatca==='function') renderZatca();
  applyTheme(!!settings.darkMode); applyColorScheme(settings.colorScheme||'original'); applySoundIcon(); applyThemeColors();
  showToast(wasOffline
    ? 'تمت استعادة البيانات محلياً بنجاح ✅ — سيتم رفعها ومزامنتها مع السيرفر تلقائياً عند عودة الاتصال'
    : 'تمت استعادة البيانات بنجاح، ورُفعت للسيرفر ✅ — سيُعاد فتح البرنامج الآن بالبيانات الجديدة (تم حفظ نسخة من البيانات القديمة على السيرفر يمكن الرجوع إليها من "النسخ المحفوظة على السيرفر")');
}

// يكمل مزامنة استعادة تمت أصلاً بدون اتصال (راجع علامة RESTORE_RESYNC_FLAG_KEY فى restoreFullBackup
// أعلاه): يرفع أولاً نسخة البيانات "القديمة" (المحفوظة محلياً مشفَّرة قبل الاستعادة) كنسخة احتياطية
// على السيرفر إن وُجدت، ثم يمسح أي بقايا قديمة على السيرفر ويرفع البيانات المستعادة الحالية من جديد
// بلا أي تعارض ممكن (بنفس منطق الاستعادة وقت الاتصال بالضبط).
async function resyncRestoredDataWithServer(){
  try{
    const oldSnapshotEnc = localStorage.getItem(RESTORE_OLD_SNAPSHOT_KEY);
    if(oldSnapshotEnc){
      const res = await serverFetch('/api/backups', {
        method: 'POST',
        body: JSON.stringify({ kind: 'قبل استعادة نسخة أخرى (تمت بدون اتصال)', enc: oldSnapshotEnc }),
      });
      if(res.ok) localStorage.removeItem(RESTORE_OLD_SNAPSHOT_KEY);
      // لو فشل الرفع، نترك المفتاح كما هو ليُعاد المحاولة فى المرة القادمة التي تنجح فيها هذه الدالة
    }
    await wipeServerDataForFreshRestore();
    await pushCurrentDataToServer();
    localStorage.removeItem(RESTORE_RESYNC_FLAG_KEY);
    showToast('تمت مزامنة نسخة الاستعادة المحلية مع السيرفر بنجاح ✅ مع الاحتفاظ بنسخة من البيانات القديمة');
  }catch(e){
    // تعذّر إتمام المزامنة رغم عودة الاتصال (خطأ عابر) — نترك العلامة موجودة ليُعاد المحاولة
    // تلقائياً عند محاولة الاتصال التالية، بدل فقد فرصة المزامنة الكاملة بصمت.
    console.error('resyncRestoredDataWithServer: تعذّرت المزامنة الكاملة بعد عودة الاتصال', e);
  }
}
window.addEventListener('online', async ()=>{
  let pending = null;
  try{ pending = localStorage.getItem(RESTORE_RESYNC_FLAG_KEY); }catch(e){ /* تجاهل */ }
  if(pending === '1') await resyncRestoredDataWithServer();
});
// يفحص وجود استعادة سابقة بانتظار المزامنة الكاملة (راجع RESTORE_RESYNC_FLAG_KEY) — يُستدعى من
// backgroundSyncCheck (بعد تحميل بيانات البرنامج فعلياً فى الذاكرة، عند بدء التشغيل وكل دقيقتين)
// بدل تشغيله مباشرة عند تحميل هذا الملف، حتى لا يحاول رفع بيانات فارغة/افتراضية قبل اكتمال
// تحميل البيانات الحقيقية من الكاش المحلي أو السحابة.
async function checkPendingRestoreResync(){
  try{
    if(isCurrentlyOffline()) return;
    if(localStorage.getItem(RESTORE_RESYNC_FLAG_KEY) === '1') await resyncRestoredDataWithServer();
  }catch(e){ console.error('checkPendingRestoreResync error:', e); }
}

const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
function showToast(msg){
  const t = $('#toast');
  const isError = /تعذّر|تعذر|خطأ|فشل|غير صحيح/.test(msg);
  const isDelete = /حذف/.test(msg);
  t.innerHTML = `<span>${isError ? ICON_WARN : ICON_OK}</span><span>${escapeHtml(msg)}</span>`;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=>t.classList.remove('show'), 2400);
  if(isError) SoundFX.error();
  else if(isDelete) SoundFX.delete();
  else SoundFX.success();
}

/* ==========================================================================
   عرض أخطاء الجافاسكربت بصرياً داخل الصفحة نفسها (بدل الاعتماد على Console
   أدوات المطوّر، لأنها قد لا تكون متاحة في بعض بيئات التشغيل مثل تطبيقات
   سطح المكتب المغلقة). أي خطأ غير متوقع يظهر في صندوق أحمر أعلى الصفحة مع
   نص الخطأ الكامل، بدل أن يختفي بصمت ويبدو الزر وكأنه "لا يعمل".
   ========================================================================== */
function showFatalErrorBox(title, err){
  let box = document.getElementById('js-error-box');
  if(!box){
    box = document.createElement('div');
    box.id = 'js-error-box';
    box.style.cssText = 'position:fixed; top:10px; left:10px; right:10px; z-index:99999; background:#fff3f0; border:2px solid #c0392b; color:#7a1f14; padding:14px 18px; border-radius:10px; font-size:13px; font-family:monospace; direction:ltr; text-align:left; max-height:40vh; overflow:auto; box-shadow:0 6px 20px rgba(0,0,0,.25);';
    document.body.appendChild(box);
  }
  const msg = (err && (err.stack || err.message)) || String(err);
  box.innerHTML = `<div style="direction:rtl; font-family:'Cairo',sans-serif; font-weight:800; margin-bottom:8px; display:flex; justify-content:space-between;"><span>⚠️ خطأ برمجي: ${title}</span><button style="border:none;background:#c0392b;color:#fff;border-radius:6px;padding:2px 10px;cursor:pointer;" onclick="document.getElementById('js-error-box').remove()">إغلاق</button></div><pre style="white-space:pre-wrap; margin:0;">${String(msg).replace(/</g,'&lt;')}</pre>`;
}
window.addEventListener('error', e=>{
  showFatalErrorBox(e.message || 'خطأ غير معروف', e.error);
});
window.addEventListener('unhandledrejection', e=>{
  showFatalErrorBox('(Promise) '+((e.reason && e.reason.message) || 'خطأ غير معروف'), e.reason);
});

/* =====================================================================
   بديل مخصص لـ confirm()/prompt() الأصليتين في المتصفح.
   السبب: نوافذ confirm()/prompt() الأصلية قد تُحجب بصمت (بدون أي رسالة خطأ)
   داخل بيئات معاينة معينة (مثل معاينة الـ Artifacts)، فتبدو الأزرار وكأنها
   "لا تعمل" رغم أن الكود يعمل فعلياً. هذا الحل يستخدم نافذة منبثقة داخل
   الصفحة نفسها (Modal) بدلاً من نافذة المتصفح النظامية، فتعمل في كل بيئة.
   ===================================================================== */
let _customDialogResolve = null;
function _closeCustomDialog(result){
  $('#custom-dialog-overlay').classList.remove('show');
  const resolve = _customDialogResolve;
  _customDialogResolve = null;
  if(resolve) resolve(result);
}
$('#custom-dialog-cancel').addEventListener('click', ()=> _closeCustomDialog(null));
$('#custom-dialog-overlay').addEventListener('click', e=>{ if(e.target.id==='custom-dialog-overlay') _closeCustomDialog(null); });
$('#custom-dialog-input').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#custom-dialog-ok').click(); } });
$('#custom-dialog-ok').addEventListener('click', ()=>{
  const input = $('#custom-dialog-input');
  const errEl = $('#custom-dialog-error');
  if(input.style.display!=='none'){
    const val = input.value;
    if(input.dataset.required==='1' && !val.trim()){
      errEl.textContent = 'هذا الحقل إلزامي';
      errEl.style.display = 'block';
      input.focus();
      return;
    }
    _closeCustomDialog(val);
  }else{
    _closeCustomDialog(true);
  }
});
// بديل confirm(): يرجع Promise<boolean>
function customConfirm(message, title){
  return new Promise(resolve=>{
    _customDialogResolve = v=> resolve(!!v);
    $('#custom-dialog-title').textContent = title || 'تأكيد';
    $('#custom-dialog-message').textContent = message;
    const input = $('#custom-dialog-input');
    input.style.display = 'none';
    input.value = '';
    $('#custom-dialog-error').style.display = 'none';
    $('#custom-dialog-overlay').classList.add('show');
    $('#custom-dialog-ok').focus();
  });
}
// بديل prompt(): يرجع Promise<string|null>. إن كان required=true فالحقل إلزامي (لا يُغلق إلا بقيمة أو بالإلغاء)
function customPrompt(message, {title, required=false, placeholder=''}={}){
  return new Promise(resolve=>{
    _customDialogResolve = v=> resolve(v===null || v===undefined ? null : v);
    $('#custom-dialog-title').textContent = title || 'إدخال';
    $('#custom-dialog-message').textContent = message;
    const input = $('#custom-dialog-input');
    input.style.display = 'block';
    input.value = '';
    input.placeholder = placeholder;
    input.dataset.required = required ? '1' : '0';
    $('#custom-dialog-error').style.display = 'none';
    $('#custom-dialog-overlay').classList.add('show');
    setTimeout(()=> input.focus(), 30);
  });
}
