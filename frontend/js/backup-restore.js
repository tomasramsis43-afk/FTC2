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
  const failures = [];
  try{
    const r = await serverFetch('/api/client-records', { method: 'DELETE' });
    if(!r.ok) failures.push('client-records');
  }catch(e){ failures.push('client-records'); }
  for(const c of ALLOWED_COLLECTIONS_LOCAL){
    try{
      const r = await serverFetch(`/api/records/${encodeURIComponent(c)}`, { method: 'DELETE' });
      if(!r.ok) failures.push(c);
    }catch(e){ failures.push(c); }
  }
  // تصفير تتبع المزامنة المحلي دائماً، مهما كانت نتيجة المسح: أي انحراف ناتج عن مسح جزئي
  // (بعض التصنيفات لم تُمسح فعلياً وبقيت بنسخها القديمة، أو مسحت فصارت 0) يُعالَج تلقائياً
  // أثناء إعادة الرفع بعدها — bulkUploadRecordsGeneric/bulkUploadClientRecords تعيد رفع أي
  // تعارض نسخ بالنسخة الحالية من السيرفر (currentVersion) فيلتئم كل شيء بدون تعارضات دائمة.
  Object.keys(_clientRecordVersions).forEach(k=> delete _clientRecordVersions[k]);
  clientRecordMeta = {};
  recordMeta = {};
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
  // مسح طابور التعديلات المعلّقة محلياً: أي تعديلات كانت معلّقة قبل الاستعادة لم تعد صالحة بعد
  // مسح السيرفر ورفع نسخة الاستعادة من جديد — إبقاؤها كان يعني إعادة رفعها لاحقاً (خلال أول
  // flush تلقائي) فوق البيانات المستعادة وفسادها ببيانات قديمة.
  try{ await _pendingRecordClearAll(); }catch(e){ console.error('wipeServerDataForFreshRestore: تعذّر مسح طابور المعلّقات', e); }
  if(failures.length){
    console.warn('wipeServerDataForFreshRestore: فشل مسح بعض التصنيفات على السيرفر — ستُعالج تلقائياً بإعادة محاولة التعارضات أثناء الرفع:', failures);
  }
}
// يرفع كل بيانات البرنامج الحالية (الموجودة فعلاً فى متغيرات الذاكرة الآن) للسيرفر من جديد —
// تُستدعى بعد wipeServerDataForFreshRestore مباشرة، سواء وقت الاستعادة نفسها (متصل) أو لاحقاً
// عند عودة الاتصال لو تمت الاستعادة أصلاً بدون اتصال.
// يرفع كل بيانات البرنامج الحالية (الموجودة فعلاً فى متغيرات الذاكرة الآن) للسيرفر من جديد —
// تُستدعى بعد wipeServerDataForFreshRestore مباشرة، سواء وقت الاستعادة نفسها (متصل) أو لاحقاً
// عند عودة الاتصال لو تمت الاستعادة أصلاً بدون اتصال.
// الطريقة الجديدة: رفع سريع بسيط بدل 19 دالة save* متوازية (كل واحدة برفع مُجمَّع خاص بها وطابور
// معلّقات وإعادة محاولة تعارضات). بعد المسح الكامل السيرفر فارغ، فكل سجل يُرسَل برقم نسخة 0
// فيُدرج فوراً بلا أي تعارض — بضع طلبات فقط بدل عشرات، وبلا أي آليات معقدة.
async function pushCurrentDataToServer(){
  if(isCurrentlyOffline()) return; // بدون اتصال تُؤجَّل كاملة (راجع RESTORE_RESYNC_FLAG_KEY)
  const collections = [
    ['bagStock', bagStock], ['vaultTx', vaultTx], ['vaultDenomTx', vaultDenomTx], ['bankStatementRows', bankStatementRows],
    ['courseSessions', courseSessions], ['auditLog', auditLog], ['companies', companies], ['companyTransfers', companyTransfers],
    ['journalEntries', journalEntries], ['chartOfAccounts', chartOfAccounts], ['journalDE', journalDE], ['budgetEntries', budgetEntries],
    ['suppliers', suppliers], ['purchases', purchases], ['manualSalesInvoices', manualSalesInvoices], ['scheduledVaultTx', scheduledVaultTx],
  ];
  const active = collections.filter(([, arr])=> (arr||[]).some(x=> x && x.id));
  showAppLoadingOverlay();
  try{
    let done = 0;
    for(const [name, arr] of active){
      setAppLoadingOverlayText(`جاري رفع البيانات إلى السيرفر... ${done+1} من ${active.length}`);
      await fastUploadCollection(name, arr.filter(x=> x && x.id));
      done++;
    }
    const cl = (clients||[]).filter(c=> c && c.id);
    if(cl.length){
      setAppLoadingOverlayText('جاري رفع البيانات إلى السيرفر... العملاء');
      await fastUploadClients(cl);
    }
    setAppLoadingOverlayText('جاري حفظ الإعدادات...');
    await Promise.allSettled([saveSettings(), saveUsers(), saveZakatAdjustments()]);
  }finally{
    hideAppLoadingOverlay();
  }
}
function isCurrentlyOffline(){ return manualOfflineMode || _ftcIsOffline; }

/* ============================================================================
   التحقق من اكتمال رفع الاستعادة إلى السيرفر قبل أي "مسح كاش + إعادة فتح".
   كان إعادة الفتح تتم بعد مهلة ثابتة بدون تحقق، فلو تعثّر جزء من الرفع (دفعة سقطت /
   rate limit) بقي السيرفر ناقصاً وأعاد البرنامج فتح نفسه على بيانات ناقصة كما لو كانت
   كاملة — وهو نفس مسار "الملف لا يُحمَّل بالكامل" الذي أبلغ عنه المستخدم.
   ============================================================================ */
// التصنيفات (سجلات مستقلة) التي تُستعاد فعلياً من ملف النسخة الاحتياطية في restoreFullBackup —
// تُستخدم حصراً للتحقق، وتستثني deletedVaultTx/deletedInvoices التي ليست جزءاً من ملف النسخة
// إطلاقاً (تختفي من السيرفر بعد المسح عمداً لأنها مجرد سجل حذف).
const RESTORED_RECORD_COLLECTIONS = [
  'bagStock','vaultTx','vaultDenomTx','bankStatementRows','courseSessions','auditLog',
  'companies','companyTransfers','journalEntries','chartOfAccounts','journalDE','budgetEntries',
  'suppliers','purchases','manualSalesInvoices','scheduledVaultTx',
];
function _currentCollectionArray(c){
  switch(c){
    case 'bagStock': return bagStock;
    case 'vaultTx': return vaultTx;
    case 'vaultDenomTx': return vaultDenomTx;
    case 'bankStatementRows': return bankStatementRows;
    case 'courseSessions': return courseSessions;
    case 'auditLog': return auditLog;
    case 'companies': return companies;
    case 'companyTransfers': return companyTransfers;
    case 'journalEntries': return journalEntries;
    case 'chartOfAccounts': return chartOfAccounts;
    case 'journalDE': return journalDE;
    case 'budgetEntries': return budgetEntries;
    case 'suppliers': return suppliers;
    case 'purchases': return purchases;
    case 'manualSalesInvoices': return manualSalesInvoices;
    case 'scheduledVaultTx': return scheduledVaultTx;
    default: return null;
  }
}
// يرجع true فقط لو كل البيانات المستعادة ظهرت فعلياً على السيرفر بأعدادها الكاملة.
async function verifyRestoredDataOnServer(){
  try{
    const wantUsers = normalizeRole(SERVER_AUTH_ROLE) === 'admin';
    // 1) السجلات المستقلة لكل تصنيف مستعاد — مقارنة العدد المرفوع (ذات id) بعدد السيرفر
    const recRes = await serverFetch('/api/records-versions');
    if(!recRes.ok) return false;
    const recData = await recRes.json();
    const serverRec = recData.versions || {};
    for(const c of RESTORED_RECORD_COLLECTIONS){
      const arr = _currentCollectionArray(c);
      const expected = arr ? arr.filter(x=>x && x.id).length : 0;
      if(expected === 0) continue;
      const sv = serverRec[c];
      if(!sv || sv.count !== expected) return false;
    }
    // 2) العملاء — عدد سجلات العملاء على السيرفر يساوي عدد العملاء المرفوعين (الأدمن يرى الكل)
    const clRes = await serverFetch('/api/client-records');
    if(!clRes.ok) return false;
    const clData = await clRes.json();
    const clientsExpected = clients.filter(c=>c && c.id).length;
    if(clientsExpected !== (clData.records||[]).length) return false;
    // 3) مفاتيح kv القديمة المتبقية (settings/zakatAdjustments/users) — تطابق أرقام النسخ بعد الحفظ
    const vRes = await serverFetch('/api/storage-versions');
    if(!vRes.ok) return false;
    const vData = await vRes.json();
    const versions = vData.versions || {};
    const kvKeys = ['settings','zakatAdjustments'].concat(wantUsers ? ['users'] : []);
    for(const k of kvKeys){
      if((_kvVersions[k] || 0) !== (versions[k] || 0)) return false;
    }
    return true;
  }catch(e){
    console.error('verifyRestoredDataOnServer:', e);
    return false;
  }
}

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

  // restoreVerified: هل اكتمل رفع كل البيانات المستعادة للسيرفر فعلاً؟ (أدمن متصل)
  // shouldReload: يُفعَّل فقط عند الاكتمال — إعادة فتح البرنامج من السيرفر بالبيانات الجديدة
  let restoreVerified = false;
  let shouldReload = false;

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
  // يُطبَّق دائماً على الذاكرة والكاش المحلي فوراً بغضّ النظر عن الاتصال؛ الرفع الجديد السريع
  // (pushCurrentDataToServer) يتحقق من الاتصال بنفسه، ولو تعذّر يُبلَّغ المستخدم ويُكتمل لاحقاً
  // تلقائياً عند عودة الاتصال (راجع RESTORE_RESYNC_FLAG_KEY وresyncRestoredDataWithServer أدناه).
  await pushCurrentDataToServer().catch(e=>{
    console.error('restoreFullBackup: تعذّر رفع البيانات للسيرفر', e);
    showToast('⚠️ تعذّر رفع البيانات إلى السيرفر حالياً — ستُحفَظ محلياً وتُرفع تلقائياً عند استقرار الاتصال');
  });

  if(wasOffline){
    // نسجّل أن هناك استعادة كاملة بانتظار مزامنتها الحقيقية مع السيرفر (مسح + رفع نظيف بلا تعارض)
    // بمجرد عودة الاتصال، بدل الاكتفاء بالمزامنة الجزئية العادية لطابور "التعديلات المعلَّقة".
    try{ localStorage.setItem(RESTORE_RESYNC_FLAG_KEY, '1'); }catch(e){ console.error(e); }
  }else{
    // متصلون: نُسجّل علامة إعادة المزامنة قبل الرفع — أي انقطاع أثناءه يُكمل تلقائياً لاحقاً
    // (راجع resyncRestoredDataWithServer)، ثم نتحقق من اكتمال رفع كل البيانات المستعادة إلى
    // السيرفر قبل أي "مسح كاش + إعادة فتح". فقط عند الاكتمال نمسح الكاش المحلي القديم (بيانات
    // ما قبل الاستعادة) ونعيد فتح البرنامج من السيرفر؛ لو بقيت بيانات الاستعادة القديمة في الكاش،
    // أي فتح تالٍ من الكاش (hasLocalCache → loadData(cacheOnly)) كان يُظهرها وكأنها ما زالت موجودة.
    try{ localStorage.setItem(RESTORE_RESYNC_FLAG_KEY, '1'); }catch(e){ console.error(e); }
    restoreVerified = await verifyRestoredDataOnServer();
    if(restoreVerified){
      try{ await _kvCacheClearKv(); }catch(e){ console.error('restoreFullBackup: تعذّر مسح الكاش المحلي', e); }
      try{ localStorage.removeItem(RESTORE_RESYNC_FLAG_KEY); }catch(e){ console.error(e); }
      shouldReload = true;
    }else{
      // الرفع لم يكتمل (اتصال غير مستقر): نُبقي الكاش والعلامة (تُكمل تلقائياً عند استقرار الاتصال)
      // ولا نعيد الفتح حتى لا يُعرض بيانات ناقصة. بيانات الذاكرة الحالية هي نسخة الاستعادة السليمة.
      showToast('⛔ لم يكتمل رفع النسخة المستعادة للسيرفر بالكامل (الاتصال غير مستقر) — البيانات محفوظة في البرنامج الآن وستُرفع تلقائياً عند استقرار الاتصال. لا تغلق البرنامج الآن.');
    }
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
  applyTheme(!!settings.darkMode); applyColorScheme(settings.colorScheme||'obsidian'); applySoundIcon(); applyThemeColors();
  showToast(wasOffline
    ? 'تمت استعادة البيانات محلياً بنجاح ✅ — سيتم رفعها ومزامنتها مع السيرفر تلقائياً عند عودة الاتصال'
    : (restoreVerified
        ? 'تمت استعادة البيانات بنجاح، ورُفعت للسيرفر ✅ — سيُعاد فتح البرنامج الآن بالبيانات الجديدة (تم حفظ نسخة من البيانات القديمة على السيرفر يمكن الرجوع إليها من "النسخ المحفوظة على السيرفر")'
        : 'تم استرجاع البيانات في ذاكرة البرنامج، وسيُكتمل رفعها للسيرفر تلقائياً عند استقرار الاتصال — لا تغلق البرنامج الآن'));
  if(shouldReload) setTimeout(()=>{ try{ location.reload(); }catch(e){} }, 1500);
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
  await pushCurrentDataToServer().catch(e=>{
    console.error('restoreFullBackup: تعذّر رفع البيانات للسيرفر', e);
    showToast('⚠️ تعذّر رفع البيانات إلى السيرفر حالياً — ستُحفَظ محلياً وتُرفع تلقائياً عند استقرار الاتصال');
  });
    // لا نعتبر المزامنة مكتملة إلا بعد التحقق من ظهور كل البيانات المستعادة على السيرفر بأعدادها
    // الكاملة — دون ذلك نُبقي العلامة ليُعاد المحاولة تلقائياً بدل فتح البرنامج على بيانات ناقصة.
    const verified = await verifyRestoredDataOnServer();
    if(!verified){
      showToast('⛔ لم يكتمل رفع نسخة الاستعادة للسيرفر بالكامل — ستُعاد المحاولة تلقائياً عند استقرار الاتصال');
      return;
    }
    localStorage.removeItem(RESTORE_RESYNC_FLAG_KEY);
    try{ await _kvCacheClearKv(); }catch(e){ console.error('resyncRestoredDataWithServer: تعذّر مسح الكاش المحلي', e); }
    showToast('تمت مزامنة نسخة الاستعادة المحلية مع السيرفر بنجاح ✅ — سيُعاد فتح البرنامج الآن بالبيانات الجديدة');
    setTimeout(()=>{ try{ location.reload(); }catch(e){} }, 1200);
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
  if(!t) return;
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
