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
async function restoreFullBackup(file){
  let data;
  try{
    const text = await file.text();
    data = JSON.parse(text);
  }catch(e){ showToast('تعذّرت قراءة ملف النسخة الاحتياطية — تأكد أنه ملف JSON صحيح'); return; }
  if(!data || typeof data!=='object' || !('clients' in data) || !('settings' in data)){
    showToast('هذا الملف لا يبدو نسخة احتياطية صحيحة لهذا البرنامج'); return;
  }
  if(!await customConfirm('سيتم استبدال كل البيانات الحالية في البرنامج (العملاء، الدورات، الحقائب، الحركات المالية، الشركات، الإعدادات، المستخدمين، وسجل المراجعة) بمحتوى ملف النسخة الاحتياطية المختار.\n\nيُنصَح بتنزيل نسخة احتياطية من الوضع الحالي أولاً قبل المتابعة. هل تريد المتابعة؟')){
    return;
  }
  // نسخة احتياطية من الوضع الحالي قبل الاستبدال، تحسّباً
  downloadFullBackup(false);
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
  await Promise.allSettled([
    saveClients(true), saveSettings(), saveBagStock(), saveVaultTx(),
    saveCourseSessions(), saveUsers(), saveAuditLog(), saveCompanies(), saveCompanyTransfers(), saveJournalEntries(), saveBankStatementRows(),
    saveSuppliers(), savePurchases(), saveVaultDenomTx(), saveManualSalesInvoices(), saveZakatAdjustments(),
    saveChartOfAccounts(), saveJournalDE(), saveBudgetEntries(), saveScheduledVaultTx()
  ]);
  await logAudit('edit','الإعدادات', 'تمت استعادة كل بيانات البرنامج من ملف نسخة احتياطية');
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
  applyTheme(!!settings.darkMode); applySoundIcon(); applyThemeColors();
  showToast('تمت استعادة البيانات بنجاح');
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
