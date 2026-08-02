/* ===== نظام التراجع والتقدم العام (Undo / Redo) =====
   قبل أي عملية إضافة/تعديل/حذف في أي جزء من البرنامج، نأخذ نسخة كاملة من البيانات
   ونضعها في مكدس التراجع. زر "تراجع" يعيد آخر نسخة محفوظة، وزر "تقدم" يعيد تنفيذ
   العملية التي تم التراجع عنها إن لم يقم المستخدم بأي عملية جديدة بعدها. */
let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 20;
// نسخ عميق سريع: structuredClone (مدعوم فى كل المتصفحات الحديثة) أسرع بكتير من دورة
// JSON.stringify ثم JSON.parse على نفس البيانات، خصوصاً كل ما عدد العملاء/الحركات يكبر —
// وهي نفس البيانات بالضبط (مصفوفات/كائنات عادية بدون Function أو Date معقدة تمنع النسخ).
function _deepClone(x){
  try{ return structuredClone(x); }
  catch(e){ return JSON.parse(JSON.stringify(x)); } // احتياط لو المتصفح قديم جداً أو فى قيمة غير قابلة للنسخ
}
function currentStateSnapshot(label){
  return {
    label,
    ts: Date.now(),
    clients: _deepClone(clients),
    vaultTx: _deepClone(vaultTx),
    bagStock: _deepClone(bagStock),
    courseSessions: _deepClone(courseSessions),
    settings: _deepClone(settings),
    users: _deepClone(users),
    companies: _deepClone(companies),
    companyTransfers: _deepClone(companyTransfers)
  };
}
function snapshotState(label){
  try{
    undoStack.push(currentStateSnapshot(label));
    if(undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = []; // أي عملية جديدة تُلغي إمكانية "التقدم" السابقة
    updateUndoRedoButtons();
  }catch(e){ /* تجاهل أي خطأ في أخذ النسخة الاحتياطية حتى لا يوقف العملية الأصلية */ }
}
function updateUndoRedoButtons(){
  const ub = $('#btn-undo');
  if(ub){
    if(undoStack.length){
      ub.disabled = false; ub.style.opacity = '1';
      ub.title = `تراجع عن: ${undoStack[undoStack.length-1].label}`;
    }else{
      ub.disabled = true; ub.style.opacity = '.5';
      ub.title = 'لا توجد عملية للتراجع عنها';
    }
  }
  const rb = $('#btn-redo');
  if(rb){
    if(redoStack.length){
      rb.disabled = false; rb.style.opacity = '1';
      rb.title = `تقدم إلى: ${redoStack[redoStack.length-1].label}`;
    }else{
      rb.disabled = true; rb.style.opacity = '.5';
      rb.title = 'لا توجد عملية للتقدم إليها';
    }
  }
}
async function applyStateSnapshot(entry){
  clients = entry.clients;
  vaultTx = entry.vaultTx;
  bagStock = entry.bagStock;
  courseSessions = entry.courseSessions;
  settings = entry.settings;
  users = entry.users;
  companies = entry.companies || [];
  companyTransfers = entry.companyTransfers || [];
  // عمداً saveClients(false) وليس saveClients(true): اللقطة المخزَّنة في مكدس التراجع التُقطت من
  // ذاكرة هذا الجهاز في لحظة سابقة، وقد تكون قديمة عن أي عملاء أضافهم مستخدمون آخرون على أجهزتهم
  // منذ ذلك الحين. allowDrop=true كان يمرّر allowLargeDrop لخط الرجعة القديم فيتخطّى حماية السيرفر
  // من "الحذف المفاجئ الكبير" — فيمكن للتراجع أن يمسح عملاء لم يقم هذا المستخدم بحذفهم أبداً.
  await saveClients(false);
  await saveVaultTx();
  await saveBagStock();
  await saveCourseSessions();
  await saveSettings();
  await saveUsers();
  await saveCompanies();
  await saveCompanyTransfers();
  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof refreshAuditFilterOptions==='function') refreshAuditFilterOptions();
  if(typeof renderTable==='function') renderTable();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderSettings==='function') renderSettings();
  if(typeof renderUsersList==='function') renderUsersList();
  if(typeof renderAuditLog==='function') renderAuditLog();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderCompanies==='function') renderCompanies();
}
async function performUndo(){
  if(!undoStack.length){ showToast('لا توجد عملية للتراجع عنها'); return; }
  redoStack.push(currentStateSnapshot(undoStack[undoStack.length-1].label));
  const entry = undoStack.pop();
  await applyStateSnapshot(entry);
  await logAudit('edit','النظام', `تم التراجع عن العملية: ${entry.label}`);
  updateUndoRedoButtons();
  showToast(`تم التراجع عن: ${entry.label}`);
}
async function performRedo(){
  if(!redoStack.length){ showToast('لا توجد عملية للتقدم إليها'); return; }
  const label = redoStack[redoStack.length-1].label;
  undoStack.push(currentStateSnapshot(label));
  const entry = redoStack.pop();
  await applyStateSnapshot(entry);
  await logAudit('edit','النظام', `تم التقدم لإعادة العملية: ${entry.label}`);
  updateUndoRedoButtons();
  showToast(`تم التقدم إلى: ${entry.label}`);
}
function bindUndoRedoButtons(){
  const ub=$('#btn-undo'); if(ub) ub.addEventListener('click', performUndo);
  const rb=$('#btn-redo'); if(rb) rb.addEventListener('click', performRedo);
}
// يُربَط مرة واحدة فقط: لو بدأ التحميل (loading) ننتظر DOMContentLoaded، وإلا (interactive/complete)
// نربط مباشرة. النسخة السابقة كانت تستخدم addEventListener ثم فرع readyState معاً، فيُضاف المستمع
// مرتين حين يكون readyState='interactive' لحظة تنفيذ الكود (مرة من الحدث ومرة من الفرع) — فيتراجع
// أو يتقدم إجراءان مع كل نقرة واحدة.
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', bindUndoRedoButtons);
else bindUndoRedoButtons();

/* ---------------- اختصارات لوحة المفاتيح ---------------- */
/* خريطة كل نافذة منبثقة (overlay) بمعرّف زر الإلغاء/الإغلاق الخاص بها، لإعادة استخدام منطق الإغلاق
   الأصلي لكل نافذة (بما فيه تصفير أي متغيرات حالة مرتبطة) بدل التعامل معها كصندوق أسود واحد */
const KB_OVERLAY_CANCEL = {
  'custom-dialog-overlay': 'custom-dialog-cancel',
  'overlay': 'btn-cancel',
  'bulk-add-overlay': 'btn-bulk-add-cancel',
  'bulk-update-overlay': 'btn-bulk-update-cancel',
  'bulk-message-overlay': 'btn-bulk-message-cancel',
  'bulk-delete-overlay': 'btn-bulk-delete-cancel',
  'cs-bulk-overlay': 'cs-bulk-cancel',
  'refnum-bulk-overlay': 'refnum-bulk-cancel',
  'ci-bulk-overlay': 'ci-bulk-cancel',
  'vault-overlay': 'vf-cancel',
  'ctrainee-overlay': 'ctr-cancel',
  'ctimporttext-overlay': 'ctit-cancel',
  'bag-overlay': 'bp-cancel',
  'session-overlay': 'sf-cancel',
  'voided-overlay': 'voided-close',
  'shortcuts-overlay': 'shortcuts-close'
};
const KB_TAB_KEYS = {'1':'dashboard','2':'clients','3':'companies','4':'courses','5':'courseinvoices','6':'vault','7':'bags','8':'reports','9':'accounting','0':'audit'};
function kbIsTypingTarget(el){
  if(!el) return false;
  const tag = (el.tagName||'').toLowerCase();
  return tag==='input' || tag==='textarea' || tag==='select' || el.isContentEditable;
}
function kbAnyOverlayOpen(){
  return Object.keys(KB_OVERLAY_CANCEL).some(id=>{ const ov=document.getElementById(id); return ov && ov.classList.contains('show'); }) || !!document.getElementById('print-preview-overlay');
}
function kbCloseTopOverlay(){
  // أولوية: نافذة التأكيد المخصصة (أعلى طبقة دوماً) ثم نافذة معاينة الطباعة إن كانت مفتوحة، ثم باقي النوافذ
  const cd = document.getElementById('custom-dialog-overlay');
  if(cd && cd.classList.contains('show')){ document.getElementById('custom-dialog-cancel')?.click(); return true; }
  const pp = document.getElementById('print-preview-overlay');
  if(pp){ pp.remove(); return true; }
  for(const [ovId, cancelId] of Object.entries(KB_OVERLAY_CANCEL)){
    if(ovId==='custom-dialog-overlay') continue;
    const ov = document.getElementById(ovId);
    if(ov && ov.classList.contains('show')){ document.getElementById(cancelId)?.click(); return true; }
  }
  return false;
}
function kbSaveOpenOverlay(){
  for(const ovId of Object.keys(KB_OVERLAY_CANCEL)){
    const ov = document.getElementById(ovId);
    if(ov && ov.classList.contains('show')){
      const form = ov.querySelector('form');
      if(form){ if(form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit',{cancelable:true})); return true; }
      const primaryBtn = ov.querySelector('.modal-actions .btn-primary');
      if(primaryBtn){ primaryBtn.click(); return true; }
    }
  }
  return false;
}
document.addEventListener('keydown', e=>{
  // لا تعمل الاختصارات قبل تفعيل الترخيص أو تسجيل الدخول
  const lic = document.getElementById('license-screen');
  const srvLog = document.getElementById('server-login-screen');
  if(lic && lic.style.display!=='none') return;
  if(srvLog && srvLog.style.display==='flex') return; // شاشة تسجيل الدخول على السيرفر لا تزال ظاهرة
  const typing = kbIsTypingTarget(document.activeElement);
  // Esc: إغلاق أي نافذة منبثقة مفتوحة
  if(e.key==='Escape'){
    if(kbCloseTopOverlay()) e.preventDefault();
    return;
  }
  // ؟ : عرض/إخفاء قائمة الاختصارات
  if(!typing && (e.key==='؟' || e.key==='?')){
    e.preventDefault();
    document.getElementById('shortcuts-overlay')?.classList.toggle('show');
    return;
  }
  // Ctrl/Cmd + S: حفظ النموذج المفتوح حالياً (بدل حفظ صفحة المتصفح)
  if((e.ctrlKey||e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase()==='s'){
    if(kbAnyOverlayOpen()){ e.preventDefault(); kbSaveOpenOverlay(); }
    return;
  }
  // Ctrl/Cmd + Z: تراجع عن آخر عملية (فقط خارج الكتابة النصية وخارج أي نافذة مفتوحة، حتى لا يتعارض مع تراجع الكتابة الافتراضي في المتصفح)
  if((e.ctrlKey||e.metaKey) && !e.shiftKey && e.key.toLowerCase()==='z'){
    if(!typing && !kbAnyOverlayOpen()){ e.preventDefault(); performUndo(); }
    return;
  }
  // Ctrl/Cmd + Shift + Z: إعادة (تقدّم) العملية
  if((e.ctrlKey||e.metaKey) && e.shiftKey && e.key.toLowerCase()==='z'){
    if(!typing && !kbAnyOverlayOpen()){ e.preventDefault(); performRedo(); }
    return;
  }
  // / : الانتقال لتبويب العملاء والتركيز على مربع البحث
  if(e.key==='/' && !typing && !kbAnyOverlayOpen()){
    e.preventDefault();
    const clientsBtn = document.querySelector('nav.tabs button[data-view="clients"]');
    if(clientsBtn && !clientsBtn.classList.contains('active')) clientsBtn.click();
    document.getElementById('search')?.focus();
    return;
  }
  // Alt + N: إضافة عميل جديد
  if(e.altKey && !e.ctrlKey && e.key.toLowerCase()==='n'){
    e.preventDefault();
    if(kbAnyOverlayOpen()) return;
    const clientsBtn = document.querySelector('nav.tabs button[data-view="clients"]');
    if(clientsBtn && !clientsBtn.classList.contains('active')) clientsBtn.click();
    document.getElementById('btn-add')?.click();
    return;
  }
  // Alt + S: تبويب الإعدادات
  if(e.altKey && !e.ctrlKey && e.key.toLowerCase()==='s'){
    e.preventDefault();
    document.querySelector('button[data-view="settings"]')?.click();
    return;
  }
  // Alt + 0..9: التنقل المباشر بين التبويبات
  if(e.altKey && !e.ctrlKey && KB_TAB_KEYS[e.key]){
    e.preventDefault();
    document.querySelector(`nav.tabs button[data-view="${KB_TAB_KEYS[e.key]}"]`)?.click();
    return;
  }
});
document.getElementById('btn-shortcuts-help')?.addEventListener('click', ()=> document.getElementById('shortcuts-overlay').classList.add('show'));
document.getElementById('shortcuts-close')?.addEventListener('click', ()=> document.getElementById('shortcuts-overlay').classList.remove('show'));
document.getElementById('shortcuts-overlay')?.addEventListener('click', e=>{ if(e.target.id==='shortcuts-overlay') document.getElementById('shortcuts-overlay').classList.remove('show'); });

function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function stampNow(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; }
function downloadXlsx(filename, sheetName, rows){
  const safeRows = (rows && rows.length) ? rows : [{'—':'لا توجد بيانات'}];
  const ws = XLSX.utils.json_to_sheet(safeRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0,31));
  XLSX.writeFile(wb, filename);
}
function num(v){
  if(typeof v==='number') return v;
  if(v===null || v===undefined || v==='') return 0;
  // يُقرأ الرقم بدقة مهما كان شكله الوارد: الأرقام العربية-الهندية (٠١٢٣٤٥٦٧٨٩ أو ۰۱۲۳)
  // تُحوَّل لإنجليزية، والفاصلة العشرية العربية (٫) تُحوَّل لنقطة، وفواصل الآلاف (٬ والفاصلة
  // الإنجليزية) تُحذف. كانت parseFloat("1,000") أو parseFloat("١٬٠٠٠") تُرجع 1 — أي قيمة
  // مُستوردة/مُلصقة بهذا الشكل كانت تُسجَّل بألف مرة أقل من حقيقتها في الخزنة والدفاتر.
  let s = String(v).trim();
  s = s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, ch => String(ch.charCodeAt(0) & 15));
  s = s.replace(/\u066B/g, '.');
  s = s.replace(/[,\u066C\u2019\u0027]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function fmt(n){ return n.toLocaleString('en-US',{maximumFractionDigits:2}); }
/* ---------------- تفقيط المبالغ (تحويل الرقم إلى كتابة بالحروف) ---------------- */
function numberToArabicWords(amount){
  amount = Math.round((num(amount) + Number.EPSILON) * 100) / 100;
  const negative = amount < 0;
  amount = Math.abs(amount);
  let riyals = Math.floor(amount);
  let halalas = Math.round((amount - riyals) * 100);
  if(halalas >= 100){ riyals += 1; halalas = 0; }

  const ones = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
  const onesF = ['', 'إحدى', 'اثنتان', 'ثلاث', 'أربع', 'خمس', 'ست', 'سبع', 'ثمان', 'تسع'];
  const teens = ['عشرة','أحد عشر','اثنا عشر','ثلاثة عشر','أربعة عشر','خمسة عشر','ستة عشر','سبعة عشر','ثمانية عشر','تسعة عشر'];
  const teensF = ['عشرة','إحدى عشرة','اثنتا عشرة','ثلاث عشرة','أربع عشرة','خمس عشرة','ست عشرة','سبع عشرة','ثمان عشرة','تسع عشرة'];
  const tensWords = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
  const hundreds = ['', 'مائة', 'مئتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
  const oneScale = ['', 'ألف', 'مليون', 'مليار'];
  const twoScale = ['', 'ألفان', 'مليونان', 'ملياران'];
  const pluralScale = ['', 'آلاف', 'ملايين', 'مليارات'];

  function threeDigitsToWords(n, feminine){
    if(n===0) return '';
    const o = feminine ? onesF : ones;
    const t = feminine ? teensF : teens;
    const h = Math.floor(n/100), r = n%100;
    const parts = [];
    if(h>0) parts.push(hundreds[h]);
    if(r>0){
      if(r<10) parts.push(o[r]);
      else if(r<20) parts.push(t[r-10]);
      else{
        const td = Math.floor(r/10), od = r%10;
        parts.push(od>0 ? (o[od] + ' و' + tensWords[td]) : tensWords[td]);
      }
    }
    return parts.join(' و');
  }
  function integerToWords(n){
    if(n===0) return 'صفر';
    const groups = [];
    let x = n;
    while(x>0){ groups.push(x%1000); x = Math.floor(x/1000); }
    const segments = [];
    for(let i=groups.length-1;i>=0;i--){
      const g = groups[i];
      if(g===0) continue;
      if(i===0){ segments.push(threeDigitsToWords(g, false)); }
      else if(g===1){ segments.push(oneScale[i]); }
      else if(g===2){ segments.push(twoScale[i]); }
      else if(g>=3 && g<=10){ segments.push(threeDigitsToWords(g, true) + ' ' + pluralScale[i]); }
      else{ segments.push(threeDigitsToWords(g, false) + ' ' + oneScale[i]); }
    }
    return segments.join(' و');
  }

  let words = integerToWords(riyals) + ' ريال سعودي';
  if(halalas>0) words += ' و' + integerToWords(halalas) + ' هللة';
  words = 'فقط ' + words + ' لا غير';
  if(negative) words = 'سالب ' + words;
  return words;
}
/* تاريخ اليوم بالتوقيت المحلي (وليس UTC)، لتجنّب رجوع التاريخ يوماً للخلف في الساعات الأولى من اليوم */
function todayISO(){
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth()+1).padStart(2,'0');
  const d = String(now.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
/* إضافة عدد أيام إلى تاريخ ISO (YYYY-MM-DD) وإرجاع الناتج بنفس الصيغة */
function addDaysISO(iso, days){
  const base = iso ? new Date(iso+'T00:00:00') : new Date();
  base.setDate(base.getDate() + days);
  const y = base.getFullYear();
  const m = String(base.getMonth()+1).padStart(2,'0');
  const d = String(base.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

/* فهرس مؤقت: حركات "وارد" في الخزنة مجمّعة حسب رقم هوية العميل، لتفادي مسح كامل vaultTx
   من جديد لكل عميل عند حساب المدفوعات (كان بطيئاً مع آلاف العملاء والحركات).
   يُبنى عند أول استخدام ثم يُفرَّغ تلقائياً بعد نهاية دورة التنفيذ الحالية (microtask)،
   فيبقى صحيحاً دائماً بغض النظر عن أي تعديل لاحق على vaultTx، دون حاجة لأي تحديث يدوي له. */
let _vaultInTxIndexCache = null;
function vaultInTxIndex(){
  if(_vaultInTxIndexCache) return _vaultInTxIndexCache;
  const map = new Map();
  for(const t of vaultTx){
    if(t.type==='in' && t.clientId){
      let arr = map.get(t.clientId);
      if(!arr){ arr = []; map.set(t.clientId, arr); }
      arr.push(t);
    }
  }
  _vaultInTxIndexCache = map;
  Promise.resolve().then(()=>{ _vaultInTxIndexCache = null; });
  return map;
}
/* نفس فكرة الفهرس أعلاه، لكن لحركات "مردودات المبيعات" (isReturn) المرتبطة برقم هوية العميل،
   حتى تُخصم قيمتها من إجمالي المدفوع لهذا العميل. */
let _vaultReturnTxIndexCache = null;
function vaultReturnTxIndex(){
  if(_vaultReturnTxIndexCache) return _vaultReturnTxIndexCache;
  const map = new Map();
  for(const t of vaultTx){
    if(t.isReturn && t.clientId){
      let arr = map.get(t.clientId);
      if(!arr){ arr = []; map.set(t.clientId, arr); }
      arr.push(t);
    }
  }
  _vaultReturnTxIndexCache = map;
  Promise.resolve().then(()=>{ _vaultReturnTxIndexCache = null; });
  return map;
}
function bagAmount(c){ return c.bagSource==='own' ? 0 : num(c.bagPrice); }
function centerIncome(c){ return num(c.coursePrice) - num(c.discount); }
function total(c){ return centerIncome(c) + bagAmount(c); }
function paidTotal(c){
  // إجمالي كل المبالغ الواردة المرتبطة برقم هوية هذا العميل في "الحركات المالية"
  // (الدفعة عند التسجيل + أي دفعات لاحقة تُسجَّل مباشرة في تبويب الحركات المالية بنفس رقم الهوية)
  // ناقصاً أي مردودات مبيعات سُجِّلت له، فتُخصم من إجمالي مدفوعاته فوراً.
  if(!c.clientId) return num(c.paid) + num(c.paid2);
  // عميل مُرحَّلة قيمته من حوالة شركة (companyTransferAllocated): مبلغه لا يظهر أبداً كقيد فردي مستقل
  // في "الحركات المالية" بنفس رقم هويته — لأنه مُرحَّل عمداً ضمن القيد الموحّد الواحد لكامل الحوالة
  // (companyTransferId)، لتفادي تكرار المبلغ في شيت الحركات المالية. لذلك فهرسة vaultInTxIndex لن
  // تجده أبداً، وستُرجع 0 دائماً، فيظهر العميل "متبقي عليه" كامل المبلغ رغم أنه مسدَّد بالفعل.
  // الحل: نثق مباشرة بقيمة "المدفوع" المسجَّلة في سجله (والمُزامَنة من تخصيصه في الحوالة عبر
  // syncClientValueFromTraineeAllocation) بدلاً من البحث عنها في الحركات المالية.
  if(c.companyTransferAllocated) return num(c.paid) + num(c.paid2);
  const txs = vaultInTxIndex().get(c.clientId);
  const inSum = txs ? txs.reduce((s,t)=>s+num(t.amount),0) : 0;
  const returnTxs = vaultReturnTxIndex().get(c.clientId);
  const returnSum = returnTxs ? returnTxs.reduce((s,t)=>s+num(t.amount),0) : 0;
  return Math.max(0, inSum - returnSum);
}
function remaining(c){ return Math.max(0, total(c) - paidTotal(c)); }
function paymentChannelsLabel(c){
  // نبني طريقة الدفع من كل الحركات الواردة المرتبطة برقم هوية هذا العميل في "الحركات المالية"
  // (تشمل دفعتَي التسجيل المُرحَّلتين تلقائياً، وأي دفعة إضافية أُضيفت لاحقاً يدوياً من تبويب "الحركات المالية" بنفس رقم الهوية)
  // بهذا يظهر أي تعديل أو دفعة جديدة تُسجَّل من الحركات المالية مباشرة في شيت العملاء دون الحاجة لتعديل العميل يدوياً.
  if(c.clientId){
    const txs = (vaultInTxIndex().get(c.clientId) || []).filter(t=>num(t.amount)>0);
    if(txs.length){
      const byMethod = {};
      const order = [];
      txs.forEach(t=>{
        const m = t.method || '—';
        if(!(m in byMethod)) order.push(m);
        byMethod[m] = (byMethod[m]||0) + num(t.amount);
      });
      return order.map(m=> `${m} (${fmt(byMethod[m])})`).join(' + ');
    }
  }
  const parts = [];
  if(num(c.paid)>0 && c.channel) parts.push(`${c.channel} (${fmt(num(c.paid))})`);
  if(num(c.paid2)>0 && c.channel2) parts.push(`${c.channel2} (${fmt(num(c.paid2))})`);
  return parts.length ? parts.join(' + ') : (c.channel || '—');
}
function bagSourceLabel(c){
  if(c.bagSource==='own') return 'خاصته';
  if(c.bagSource==='stock') return 'من المخزون';
  return c.bagStatus==='purchased' ? 'تم الشراء' : 'مطلوب شراء';
}
/* هل حقيبة هذا العميل بحالة "مطلوب شراء" نظيفة أصلاً (بدون فاتورة أو تاريخ شراء)؟ أي لا يوجد شيء لإلغائه */
function clientBagIsClean(c){
  return c.bagSource==='buy' && c.bagStatus==='pending' && !c.bagInvoice && !c.bagPurchaseDate;
}
/* إلغاء حقيبة عميل واحد: تُحذف تماماً من سجل عمليات الشراء المكتملة ومن سجل "اشتروا حقيبتهم الخاصة"،
   وتعود حالته إلى "مطلوب شراء" بقيمة الحقيبة الافتراضية من الإعدادات (كما لو لم تُحدَّد له حقيبة من قبل) */
function resetClientBagToPending(c){
  // إن كانت الحقيبة مُسلَّمة من المخزون، نحذف عملية "التسليم" المرتبطة بها من سجل عمليات مخزون الحقائب أولاً
  // حتى تُضاف الحقيبة تلقائياً للمخزون المتاح مجدداً (المخزون الحالي يُحسب بالكامل من هذا السجل)
  if(c.bagSource==='stock'){
    const idx = bagStock.findIndex(b=>b.type==='issue' && b.issuedClientId===c.id);
    if(idx>-1){ bagStock.splice(idx,1); recalcBagFundLedger(); }
  }
  c.bagSource = 'buy';
  c.bagPrice = num(settings.bagPrice) || DEFAULT_SETTINGS.bagPrice;
  c.bagInvoice = '';
  c.bagStatus = 'pending';
  delete c.bagPurchaseDate;
  delete c.bagPaymentMethod;
  syncClientLedgerEntry(c);
}
/* تحديد أن هذا العميل اشترى حقيبته الخاصة: تُصفَّر قيمة الحقيبة فوراً وتختفي من كل سجلات الحقائب (يُستخدم من نموذج الاستيراد الجماعي) */
function markClientBagOwn(c){
  c.bagSource = 'own';
  c.bagPrice = 0;
  c.bagInvoice = '';
  c.bagStatus = 'n/a';
  delete c.bagPurchaseDate;
  delete c.bagPaymentMethod;
  syncClientLedgerEntry(c);
}
/* زر سريع لإلغاء الحقيبة يظهر بجانب حالة الحقيبة في شيت العملاء — يظهر فقط إن كان هناك فعلاً حقيبة/بيانات لإلغائها */
function bagCancelBtnHtml(c){
  if(clientBagIsClean(c)) return '';
  return ` <button class="btn btn-ghost btn-sm" data-cancelbag="${c.id}" title="إلغاء الحقيبة المسجّلة لهذا العميل وإعادته لحالة مطلوب شراء" style="padding:2px 6px; font-size:11px; margin-inline-start:4px;">إلغاء الحقيبة</button>`;
}
/* خانة سريعة لشراء الحقيبة تظهر بجانب حالة "مطلوب شراء" — تُتيح الشراء مباشرة من مكانها */
function bagBuyCheckboxHtml(c){
  if(c.bagSource!=='buy' || c.bagStatus==='purchased') return '';
  return ` <label style="display:inline-flex; align-items:center; gap:3px; cursor:pointer; margin-inline-start:6px; font-size:11.5px; color:var(--text-muted);" title="اضغط لتسليم الحقيبة الآن من المخزون">
    <input type="checkbox" data-bagbuy="${c.id}"> شراء
  </label>`;
}
function courseDurationDays(courseType){
  const n = String(courseType||'').toLowerCase();
  return n.includes('food') || n.includes('غذائي') || n.includes('سلامة') ? 2 : 1;
}

/* ---------------- توحيد أسماء أنواع الدورات (منع التكرار بسبب اختلاف حالة الأحرف أو المسافات الزائدة) ---------------- */
/* تعيد الاسم "المعتمد" لنوع الدورة كما هو مسجّل في قائمة أنواع الدورات بالإعدادات (settings.courses)،
   بمطابقة غير حساسة لحالة الأحرف وتجاهل المسافات الزائدة — حتى لا يُحسب "Food safety" و"food safety" كنوعين مختلفين */
function normalizeCourseTypeValue(raw){
  const v = String(raw||'').trim().replace(/\s+/g,' ');
  if(!v) return v;
  const match = settings.courses.find(c=> String(c.name||'').trim().toLowerCase() === v.toLowerCase());
  return match ? match.name : v;
}
/* يوحّد قائمة أنواع الدورات نفسها في الإعدادات (يدمج أي اسمين مكررين يختلفان فقط بحالة الأحرف/مسافات زائدة في واحد فقط)،
   ثم يصحح نوع الدورة المسجّل على كل عميل ودورة في الشيت بالكامل ليطابق الاسم المعتمد — يعمل مرة تلقائياً عند كل فتح للبرنامج
   ولا يكرر أي تصحيح تم بالفعل (آمن التكرار). */
async function cleanupDuplicateCourseTypes(){
  let changed = false;
  // 1) نحسب عدد مرات استخدام كل صياغة (حالة أحرف) فعلياً في شيت العملاء وشيت الدورات،
  //    لاختيار الصياغة الأكثر استخدامًا كصياغة معتمدة لكل نوع دورة (بدل الاعتماد على ترتيب الإدخال فقط)
  const usageCount = new Map(); // lowercase key -> Map(variant -> count)
  const bump = (raw)=>{
    const v = String(raw||'').trim().replace(/\s+/g,' ');
    if(!v) return;
    const key = v.toLowerCase();
    if(!usageCount.has(key)) usageCount.set(key, new Map());
    const variants = usageCount.get(key);
    variants.set(v, (variants.get(v)||0)+1);
  };
  clients.forEach(c=> bump(c.courseType));
  courseSessions.forEach(s=> bump(s.courseType));
  (settings.courses||[]).forEach(c=> bump(c.name));
  const canonicalOf = new Map(); // lowercase key -> chosen variant name
  usageCount.forEach((variants, key)=>{
    let best = null, bestCount = -1;
    variants.forEach((count, variant)=>{ if(count>bestCount){ best = variant; bestCount = count; } });
    canonicalOf.set(key, best);
  });
  // 2) دمج التكرار داخل قائمة أنواع الدورات نفسها (الإعدادات) حسب الصياغة المعتمدة لكل اسم
  const seenSettings = new Map();
  const dedupedCourses = [];
  (settings.courses||[]).forEach(c=>{
    const key = String(c.name||'').trim().toLowerCase();
    if(!key) return;
    const canonicalName = canonicalOf.get(key) || c.name.trim();
    if(seenSettings.has(key)){
      const original = seenSettings.get(key);
      if(!original.price && c.price) original.price = c.price;
      changed = true;
    }else{
      const entry = {name:canonicalName, price:c.price};
      if(entry.name !== c.name) changed = true;
      seenSettings.set(key, entry);
      dedupedCourses.push(entry);
    }
  });
  if(changed) settings.courses = dedupedCourses;
  // 3) تصحيح نوع الدورة المسجّل على كل عميل ليطابق الصياغة المعتمدة
  let clientsChanged = false;
  clients.forEach(c=>{
    if(!c.courseType) return;
    const key = String(c.courseType).trim().toLowerCase().replace(/\s+/g,' ');
    const fixed = canonicalOf.get(key) || normalizeCourseTypeValue(c.courseType);
    if(fixed !== c.courseType){ c.courseType = fixed; clientsChanged = true; }
  });
  // 4) تصحيح نوع الدورة المسجّل على كل دورة في شيت الدورات
  let sessionsChanged = false;
  courseSessions.forEach(s=>{
    if(!s.courseType) return;
    const key = String(s.courseType).trim().toLowerCase().replace(/\s+/g,' ');
    const fixed = canonicalOf.get(key) || normalizeCourseTypeValue(s.courseType);
    if(fixed !== s.courseType){ s.courseType = fixed; sessionsChanged = true; }
  });
  if(changed || clientsChanged || sessionsChanged){
    if(changed) await saveSettings();
    if(clientsChanged) await saveClients();
    if(sessionsChanged) await saveCourseSessions();
    await logAudit('edit','الإعدادات', 'تصحيح تلقائي: توحيد أسماء أنواع الدورات المكررة (بسبب اختلاف حالة الأحرف أو مسافات زائدة) في شيت العملاء وشيت الدورات وقائمة الإعدادات');
  }
}

/* ---------------- توحيد أسماء الجنسيات (منع التكرار بسبب اختلاف حالة الأحرف أو مسافات زائدة) ---------------- */
/* تعيد الاسم "المعتمد" للجنسية كما هو مسجّل في قائمة الجنسيات بالإعدادات (settings.nationalities)،
   بمطابقة غير حساسة لحالة الأحرف وتجاهل المسافات الزائدة — حتى لا تُحسب "Yemeni" و"yemeni" كجنسيتين مختلفتين */
function normalizeNationalityValue(raw){
  const v = String(raw||'').trim().replace(/\s+/g,' ');
  if(!v) return v;
  const match = (settings.nationalities||[]).find(n=> String(n||'').trim().toLowerCase() === v.toLowerCase());
  return match ? match : v;
}
/* يوحّد قائمة الجنسيات نفسها في الإعدادات (يدمج أي اسمين مكررين يختلفان فقط بحالة الأحرف/مسافات زائدة في واحد فقط)،
   ثم يصحح الجنسية المسجّلة على كل عميل في الشيت بالكامل لتطابق الاسم المعتمد — يعمل مرة تلقائياً عند كل فتح للبرنامج
   ولا يكرر أي تصحيح تم بالفعل (آمن التكرار). */
async function cleanupDuplicateNationalities(){
  let changed = false;
  // 1) نحسب عدد مرات استخدام كل صياغة (حالة أحرف) فعلياً في شيت العملاء وقائمة الجنسيات بالإعدادات،
  //    لاختيار الصياغة الأكثر استخداماً كصياغة معتمدة لكل جنسية
  const usageCount = new Map(); // lowercase key -> Map(variant -> count)
  const bump = (raw)=>{
    const v = String(raw||'').trim().replace(/\s+/g,' ');
    if(!v) return;
    const key = v.toLowerCase();
    if(!usageCount.has(key)) usageCount.set(key, new Map());
    const variants = usageCount.get(key);
    variants.set(v, (variants.get(v)||0)+1);
  };
  clients.forEach(c=> bump(c.nationality));
  (settings.nationalities||[]).forEach(n=> bump(n));
  const canonicalOf = new Map(); // lowercase key -> chosen variant name
  usageCount.forEach((variants, key)=>{
    let best = null, bestCount = -1;
    variants.forEach((count, variant)=>{ if(count>bestCount){ best = variant; bestCount = count; } });
    canonicalOf.set(key, best);
  });
  // 2) دمج التكرار داخل قائمة الجنسيات نفسها (الإعدادات) حسب الصياغة المعتمدة لكل اسم
  const seenSettings = new Set();
  const dedupedNats = [];
  (settings.nationalities||[]).forEach(n=>{
    const key = String(n||'').trim().toLowerCase();
    if(!key) return;
    const canonicalName = canonicalOf.get(key) || String(n).trim();
    if(seenSettings.has(key)){
      changed = true;
    }else{
      if(canonicalName !== n) changed = true;
      seenSettings.add(key);
      dedupedNats.push(canonicalName);
    }
  });
  if(changed) settings.nationalities = dedupedNats;
  // 3) تصحيح الجنسية المسجّلة على كل عميل لتطابق الصياغة المعتمدة
  let clientsChanged = false;
  clients.forEach(c=>{
    if(!c.nationality) return;
    const key = String(c.nationality).trim().toLowerCase().replace(/\s+/g,' ');
    const fixed = canonicalOf.get(key) || normalizeNationalityValue(c.nationality);
    if(fixed !== c.nationality){ c.nationality = fixed; clientsChanged = true; }
  });
  if(changed || clientsChanged){
    if(changed) await saveSettings();
    if(clientsChanged) await saveClients();
    await logAudit('edit','الإعدادات', 'تصحيح تلقائي: توحيد أسماء الجنسيات المكررة (بسبب اختلاف حالة الأحرف أو مسافات زائدة) في شيت العملاء وقائمة الإعدادات');
  }
}

/* ---------------- توحيد أسماء طرق الدفع (منع تعدد المسميات لنفس الطريقة عبر كل الشيتات) ---------------- */
/* طرق الدفع المعتمدة الوحيدة في كامل البرنامج هي settings.channels (نفس القائمة الظاهرة في شيت "الحركات المالية" والإعدادات).
   هذه الدالة تحوّل أي اسم بديل/قديم لطريقة الدفع (مثل "تحويل" أو "بطاقة" أو "كاش مباشر" أو "إيداع كاش في الحساب البنكي"...)
   إلى الاسم المعتمد المطابق في settings.channels، بمطابقة حسب الوجهة الفعلية للحساب (خزنة كاش / بنك / شبكة). */
function canonicalizeChannelName(raw){
  const v = String(raw||'').trim().replace(/\s+/g,' ');
  if(!v) return '';
  const direct = (settings.channels||[]).find(c=> String(c.name||'').trim().toLowerCase()===v.toLowerCase());
  if(direct) return direct.name;
  const aliasToDest = {
    'تحويل':'bank', 'حوالة':'bank', 'حوالة بنكية':'bank', 'حواله بنكيه':'bank',
    'إيداع بنكي':'bank', 'ايداع بنكي':'bank', 'إيداع / تحويل بنكي':'bank', 'ايداع / تحويل بنكي':'bank',
    'إيداع كاش في الحساب البنكي':'bank', 'ايداع كاش في الحساب البنكي':'bank',
    'تحويل بنكي من صاحب المركز (دعم شركاء)':'bank', 'سحب من الحساب البنكي':'bank', 'سحب بنكي':'bank',
    'بطاقة':'network', 'شبكة':'network', 'مدى':'network', 'بطاقة مدى':'network', 'بطاقة/شبكة':'network', 'بطاقة/مدى':'network',
    'كاش':'vault', 'كاش مباشر':'vault', 'نقداً':'vault', 'نقدا':'vault', 'سحب نقدي':'vault', 'إيداع نقدي':'vault', 'ايداع نقدي':'vault'
  };
  const dest = aliasToDest[v.toLowerCase()];
  if(dest){ const ch = (settings.channels||[]).find(c=>c.dest===dest); if(ch) return ch.name; }
  return v; // اسم غير معروف: يُترك كما هو حتى لا تُفقد أي معلومة، ويمكن مراجعته يدوياً من الإعدادات
}
/* توحيد بأثر رجعي: يمر على شيت "الحركات المالية" وسجل تمويل الحقائب وبيانات العملاء (طريقة دفع الحقيبة/الحوالة)
   ويوحّد أي مسمى مكرر لنفس طريقة الدفع وفق القائمة المعتمدة أعلاه. كما يحاول استنتاج طريقة الدفع لأي حركة مالية
   غير محددة (بدون طريقة دفع) بالاعتماد على "الحساب/الوجهة" الفعلي المسجّل لها (خزنة كاش → نقدي، بنك → تحويل بنكي،
   شبكة → بطاقة/شبكة مدى) — أما حركات وجهتها "أخرى" (طبي/المركز) فتبقى دون تخمين لعدم وجود طريقة واحدة مؤكدة لها.
   تعمل تلقائياً وبأمان عند كل فتح للبرنامج (آمنة التكرار — لا تُعيد تغيير ما تم توحيده مسبقاً). */
async function cleanupDuplicatePaymentMethods(){
  let vaultChanged = false, bagStockChanged = false, clientsChanged = false;
  let fixedCount = 0, inferredCount = 0;
  vaultTx.forEach(t=>{
    if(t.method){
      const fixed = canonicalizeChannelName(t.method);
      if(fixed && fixed!==t.method){ t.method = fixed; vaultChanged = true; fixedCount++; }
    }else if(t.destination && t.destination!=='other'){
      const ch = (settings.channels||[]).find(c=>c.dest===t.destination);
      if(ch){ t.method = ch.name; vaultChanged = true; inferredCount++; }
    }
    // ترحيل بأثر رجعي: أي حركة خزنة قديمة (موجودة قبل ميزة "صندوق تسويات الاستقبال") لا
    // تحمل حقل settled إطلاقاً تُعتبر مُسوّاة تلقائياً — فقط الحركات الجديدة بعد تفعيل
    // الميزة تبدأ فعلياً كـ"معلّقة" (settled:false) حتى تظهر في صندوق التسويات
    if(t.settled === undefined){ t.settled = true; vaultChanged = true; }
    // تصحيح بأثر رجعي: حركات معلّقة سُجّلت أصلاً من الأدمن/المحاسب/الموظف العام (وليس
    // من الاستقبال) — هذه لا تحتاج "تسوية" أصلاً وتُعتبر مؤكدة تلقائياً، حتى لا تظهر بالخطأ
    // في صندوق تسويات الاستقبال (المخصص فقط لعمليات الاستقبال).
    // إصلاح مهم: لا نُصحّح إطلاقاً بمجرد عدم العثور على العميل (linkedClient غير موجود) —
    // هذه الحالة تحدث بشكل طبيعي وغير متعلق بحذف العميل فعلياً فى حالتين شائعتين جداً: (أ) جلسة
    // محاسب/موظف عام لا ترى أصلاً عملاء الاستقبال المعلّقين (status='pending') قبل اعتماد الأدمن
    // لهم، و(ب) التحميل السريع الأول من الكاش المحلي (loadData(cacheOnly=true)) الذي يبدأ الشاشة
    // فوراً بنسخة قديمة/غير مكتملة من العملاء قبل اكتمال المزامنة الحقيقية مع السحابة. الاعتماد على
    // "لم أجده" كدليل على عدم حاجته للتسوية كان يُسوّي معاملات استقبال حقيقية معلّقة بالخطأ فى أول
    // ثانية من فتح البرنامج (خصوصاً بجلسة الأدمن نفسها)، ويُحفَظ هذا التصحيح الخاطئ فوراً على
    // السيرفر (saveVaultTx أسفل) قبل أن تُحمَّل البيانات الصحيحة — فتختفي المعاملة نهائياً من صندوق
    // تسويات الاستقبال رغم أنها لم تُسوَّ فعلياً. الآن نُصحّح فقط لو وَجدنا العميل فعلاً وتأكّدنا
    // إيجابياً أنه ليس من تسجيل الاستقبال.
    if(t.settled === false && t.autoClientId){
      const linkedClient = clients.find(c=>c.id===t.autoClientId);
      if(linkedClient && !isReceptionUsername(linkedClient.createdBy)){
        t.settled = true;
        vaultChanged = true;
      }
    }
  });
  bagStock.forEach(b=>{
    if(!b.method) return;
    const fixed = canonicalizeChannelName(b.method);
    if(fixed && fixed!==b.method){ b.method = fixed; bagStockChanged = true; }
  });
  clients.forEach(c=>{
    if(c.channel){ const fixed = canonicalizeChannelName(c.channel); if(fixed && fixed!==c.channel){ c.channel = fixed; clientsChanged = true; } }
    if(c.channel2){ const fixed = canonicalizeChannelName(c.channel2); if(fixed && fixed!==c.channel2){ c.channel2 = fixed; clientsChanged = true; } }
    if(c.bagPaymentMethod){ const fixed = canonicalizeChannelName(c.bagPaymentMethod); if(fixed && fixed!==c.bagPaymentMethod){ c.bagPaymentMethod = fixed; clientsChanged = true; } }
  });
  if(vaultChanged || bagStockChanged || clientsChanged){
    if(vaultChanged) await saveVaultTx();
    if(bagStockChanged) await saveBagStock();
    if(clientsChanged) await saveClients();
    const parts = [];
    if(fixedCount) parts.push(`توحيد ${fixedCount} حركة كانت مسجّلة بمسمى بديل لطريقة الدفع (مثل "تحويل" أو "بطاقة") إلى الاسم المعتمد في الإعدادات`);
    if(inferredCount) parts.push(`استنتاج طريقة الدفع تلقائياً لـ ${inferredCount} حركة كانت "غير محددة"، بالاعتماد على الحساب/الوجهة الفعلي لكل حركة`);
    await logAudit('edit','الحركات المالية', `تصحيح تلقائي: ${parts.join(' — ') || 'توحيد مسميات طرق الدفع المكررة عبر شيت الحركات المالية ومخزون الحقائب وبيانات العملاء'}`);
  }
}

/* ---------------- تحديث كامل الشيت ---------------- */
/* يعيد رسم كل الشاشات (حتى غير الظاهرة حالياً) من البيانات الحالية في الذاكرة،
   لضمان أن أي معادلة أو قيمة محسوبة تغيّرت تنعكس فوراً على الشاشة دون الحاجة لإعادة تحميل الصفحة */
// ملاحظة أداء: هذه الدالة كانت تعيد رسم/حساب كل شاشات البرنامج (حتى المقفولة وغير الظاهرة أصلاً)
// فى كل مرة تُستدعى فيها — وهي تُستدعى بعد عمليات عادية جداً (حذف فاتورة، إيقاف عميل، إلغاء حقيبة...)
// مش بس من زرار "تحديث الشيت بالكامل". بما أن كل تبويب أصلاً يُعاد رسمه من جديد لحظة فتحه (معالج نقر
// button[data-view] تحت)، فلا داعي لحساب نفس الشاشة مرتين: مرة دلوقتي وهي مقفولة، ومرة تانية لما
// المستخدم يفتحها فعلاً. فبنحسب هنا بس الشاشة المفتوحة حالياً؛ الباقي هيتحدّث تلقائياً عند فتحه.
function refreshEverything(){
  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof renderDashboard==='function') renderDashboard(); // بيحدّث شريط quickstats الدايم الظهور دايماً، وباقيه بيتحدد داخلياً حسب isViewActive
  if(isViewActive('clients') && typeof renderTable==='function') renderTable();
  if(isViewActive('vault') && typeof renderVault==='function') renderVault();
  if(isViewActive('bags')){
    if(typeof renderBags==='function') renderBags();
    if(typeof renderOwnBagClients==='function') renderOwnBagClients();
    if(typeof renderClientBagPurchases==='function') renderClientBagPurchases();
  }
  if(isViewActive('courses') && typeof renderCourses==='function') renderCourses();
  if(isViewActive('courseinvoices')){
    if(typeof renderCourseInvoices==='function') renderCourseInvoices();
    if(typeof renderMissingCourse==='function') renderMissingCourse();
  }
  if(isViewActive('companies')){
    if(typeof renderCompanies==='function') renderCompanies();
    if(typeof renderCtGroups==='function') renderCtGroups();
    if(typeof renderCmCats==='function') renderCmCats();
  }
  if(isViewActive('purchases') && typeof renderPurchases==='function') renderPurchases();
  if(isViewActive('reports') && typeof renderReports==='function') renderReports();
  if(isViewActive('budget') && typeof renderBudget==='function') renderBudget();
  if(isViewActive('accounting') && typeof renderAccounting==='function') renderAccounting();
  if(isViewActive('audit') && typeof renderAuditLog==='function') renderAuditLog();
  if(isViewActive('settings') && typeof renderSettings==='function') renderSettings();
  if(isViewActive('settings') && typeof renderUsersList==='function') renderUsersList();
  if(typeof updateUndoRedoButtons==='function') updateUndoRedoButtons();
}
$('#btn-refresh-all').addEventListener('click', ()=>{
  // زرار "تحديث الشيت بالكامل" فقط هو من يحتاج فعلاً حساب كل الشاشات (حتى المقفولة)، لأن الغرض
  // منه صراحة هو إعادة مزامنة كل شيء دفعة واحدة — بخلاف باقي نداءات refreshEverything() المنتشرة
  // بعد عمليات عادية (حذف فاتورة، إيقاف عميل...) واللي محتاجة بس الشاشة المفتوحة حالياً.
  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderTable==='function') renderTable();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderOwnBagClients==='function') renderOwnBagClients();
  if(typeof renderClientBagPurchases==='function') renderClientBagPurchases();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderCourseInvoices==='function') renderCourseInvoices();
  if(typeof renderMissingCourse==='function') renderMissingCourse();
  if(typeof renderCompanies==='function') renderCompanies();
  if(typeof renderCtGroups==='function') renderCtGroups();
  if(typeof renderCmCats==='function') renderCmCats();
  if(typeof renderPurchases==='function') renderPurchases();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderBudget==='function') renderBudget();
  if(typeof renderAccounting==='function') renderAccounting();
  if(typeof renderAuditLog==='function') renderAuditLog();
  if(typeof renderSettings==='function') renderSettings();
  if(typeof renderUsersList==='function') renderUsersList();
  if(typeof updateUndoRedoButtons==='function') updateUndoRedoButtons();
  showToast('تم تحديث الشيت بالكامل');
});

/* ---------------- إلغاء كل الفلاتر وخانات البحث في كل الشيتات ---------------- */
function clearAllSheetFilters(){
  // ملاحظة: فلتر "السنة" العلوي (year-filter) مقصود إبقاؤه — هو إعداد عام للبرنامج
  // وليس فلتر بحث داخل شيت معيّن، فلا يُمس هنا.
  const textLikeIds = [
    'search','cl-date-from','cl-date-to','cl-paid-min','cl-paid-max',
    'ci-search','ci-date-from','ci-date-to',
    'v-search','v-from','v-to',
    'cbp-search','cbp-date-from','cbp-date-to',
    'ownbag-search',
    'pending-bags-search',
    'purchase-search','purchase-date-from','purchase-date-to',
    'supplier-search',
    'audit-search','audit-date-from','audit-date-to',
    'cs-filter-num','cs-filter-clientid','cs-filter-from','cs-filter-to',
    'cs-missing-from','cs-missing-to','cs-missing-exp-from','cs-missing-exp-to',
    'bst-date-from','bst-date-to',
    'ctf-date-from','ctf-date-to',
    'rp-from','rp-to',
  ];
  textLikeIds.forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });

  const selectIds = [
    'filter-course','filter-nat','filter-status','filter-company','filter-invoice','filter-coursenum','filter-refnum',
    'filter-bag-own','filter-bag-stock',
    'ci-filter-diff','v-filter-dest','v-filter-type','filter-reception','v-filter-reception',
    'cbp-year-filter','ownbag-year-filter',
    'purchase-supplier-filter','purchase-status-filter',
    'audit-filter-action','audit-filter-section',
  ];
  selectIds.forEach(id=>{ const el=document.getElementById(id); if(el) el.selectedIndex = 0; });

  ['v-filter-dup','v-filter-nomethod'].forEach(id=>{ const el=document.getElementById(id); if(el) el.checked=false; });

  showSuspendedOnly = false;
  $('#btn-filter-suspended')?.classList.remove('btn-gold');
  $('#btn-filter-suspended')?.classList.add('btn-ghost');
  showUnpurchasedBagsOnly = false;
  $('#btn-filter-unpurchased-bags')?.classList.remove('btn-gold');
  $('#btn-filter-unpurchased-bags')?.classList.add('btn-ghost');
  csUndefinedOnly = false;
  $('#btn-filter-undefined')?.classList.remove('btn-primary');
  $('#btn-filter-undefined')?.classList.add('btn-ghost');

  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderTable==='function') renderTable();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderOwnBagClients==='function') renderOwnBagClients();
  if(typeof renderClientBagPurchases==='function') renderClientBagPurchases();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderCourseInvoices==='function') renderCourseInvoices();
  if(typeof renderMissingCourse==='function') renderMissingCourse();
  if(typeof renderCompanies==='function') renderCompanies();
  if(typeof renderCtGroups==='function') renderCtGroups();
  if(typeof renderCmCats==='function') renderCmCats();
  if(typeof renderPurchases==='function') renderPurchases();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderBudget==='function') renderBudget();
  if(typeof renderAccounting==='function') renderAccounting();
  if(typeof renderAuditLog==='function') renderAuditLog();
  showToast('تم إلغاء كل الفلاتر وخانات البحث');
}
$('#btn-clear-all-filters').addEventListener('click', clearAllSheetFilters);

/* ---------------- Nav ---------------- */
const RESTRICTED_STAFF_VIEWS = ['settings','audit','accounting','zatca','budget'];
function canAccessView(view){
  if(currentUserRole==='admin') return true;
  const rp = (settings && settings.rolePermissions) || DEFAULT_SETTINGS.rolePermissions;
  const allow = rp[currentUserRole];
  if(Array.isArray(allow)) return allow.includes(view);
  return !RESTRICTED_STAFF_VIEWS.includes(view); // دور غير معروف: قائمة حظر احترازية قديمة كخط دفاع أخير
}
$all('button[data-view]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    if(!canAccessView(btn.dataset.view)){
      showToast('هذا القسم غير متاح لصلاحيتك الحالية');
      return;
    }
    SoundFX.nav();
    $all('button[data-view]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const newView = $('#view-'+btn.dataset.view);
    const oldView = $('section.view.active');
    if(oldView && newView && oldView !== newView){
      const mc = document.querySelector('.main-content');
      if(mc) mc.classList.add('nav-transitioning');
      oldView.classList.remove('active');
      oldView.classList.add('view-leaving');
      newView.classList.add('active','view-entering');
      setTimeout(()=>{
        oldView.classList.remove('view-leaving');
        newView.classList.remove('view-entering');
        if(mc) mc.classList.remove('nav-transitioning');
      }, 340);
    } else if(newView){
      $all('section.view').forEach(v=>v.classList.remove('active'));
      newView.classList.add('active');
    }
    if(btn.dataset.view==='clients') renderTable();
    if(btn.dataset.view==='dashboard') renderDashboard();
    if(btn.dataset.view==='settings') renderSettings();
    if(btn.dataset.view==='bags') renderBags();
    if(btn.dataset.view==='vault') renderVault();
    if(btn.dataset.view==='settlements' && typeof renderSettlementPanel==='function') renderSettlementPanel();
    if(btn.dataset.view==='courses') renderCourses();
    if(btn.dataset.view==='courseinvoices') renderCourseInvoices();
    if(btn.dataset.view==='audit') renderAuditLog();
    if(btn.dataset.view==='reports') renderReports();
    if(btn.dataset.view==='companies') renderCompanies();
    if(btn.dataset.view==='accounting') renderAccounting();
    if(btn.dataset.view==='budget') renderEpmBudget();
    if(btn.dataset.view==='purchases') renderPurchases();
    if(btn.dataset.view==='zatca') renderZatca();
  });
});
/* إظهار/إخفاء التبويبات حسب صلاحية الدور الحالي (settings.rolePermissions القابلة للتعديل من الإعدادات) */
function applyRolePermissions(){
  $all('button[data-view]').forEach(btn=>{
    btn.style.display = canAccessView(btn.dataset.view) ? '' : 'none';
  });
  // إن كان المستخدم على قسم غير مسموح له به (مثلاً بعد تسجيل دخول مستخدم آخر بنفس الجلسة) نعيده للوحة التحكم
  const activeBtn = $('button[data-view].active');
  if(activeBtn && !canAccessView(activeBtn.dataset.view)){
    $('[data-view="dashboard"]').click();
  }
  // إخفاء أزرار الاستيراد الجماعي (تحديث/استيراد العملاء، استيراد الرقم المرجعي، استيراد عمال الشركات)
  // وزر حذف العملاء الجماعي (جدول) عن يوزر الاستقبال — هذه أدوات جماعية حسّاسة لا تخص عمل موظف الاستقبال اليومي.
  const receptionHiddenBtnIds = ['btn-bulk-update','btn-refnum-bulk','btn-compworkers-bulk','btn-bulk-delete-table'];
  const isReception = currentUserRole === 'reception';
  receptionHiddenBtnIds.forEach(id=>{
    const btn = document.getElementById(id);
    if(btn) btn.style.display = isReception ? 'none' : '';
  });
  pinNavTabsToRightEdge();
}
/* يثبّت شريط التبويبات الأفقي (وضع الجوال) على أقصى اليمين افتراضياً، لأن بعض المتصفحات
   تبدأ من scrollLeft=0 وأخرى قد تحتاج قيمة موجبة/سالبة حسب دعمها لـ RTL — هذه الدالة
   تتأكد بأن أول تبويب ظاهر فعلياً هو "لوحة التحكم" أقصى اليمين دائماً دون أي انزياح. */
function pinNavTabsToRightEdge(){
  const nav = document.querySelector('nav.tabs');
  if(!nav) return;
  requestAnimationFrame(()=>{
    // نجرّب القيمة القياسية أولاً (0)، ثم نتحقق أن أول عنصر فعلاً ظاهر بالكامل عند الحافة اليمنى
    nav.scrollLeft = 0;
    const firstBtn = nav.querySelector('button[data-view]:not([style*="display: none"])');
    if(firstBtn){
      const navRect = nav.getBoundingClientRect();
      const btnRect = firstBtn.getBoundingClientRect();
      if(Math.abs(btnRect.right - navRect.right) > 2){
        // بعض المتصفحات تفسّر 0 كأقصى اليسار في RTL — نستخدم القيمة المعاكسة كحل احتياطي
        nav.scrollLeft = nav.scrollWidth - nav.clientWidth;
      }
    }
  });
}
window.addEventListener('resize', ()=>{ pinNavTabsToRightEdge(); });
/* خط Tajawal يتحمّل من جوجل فونتس بعد الرسم الأول (font-display:swap)، وده ممكن يغيّر عرض
   نص أزرار الشريط بعد ما التثبيت اتنفذ أول مرة على خط احتياطي — نعيد التثبيت لما الخط يخلص فعليًا. */
if(document.fonts && document.fonts.ready){
  document.fonts.ready.then(()=>{ pinNavTabsToRightEdge(); });
}

