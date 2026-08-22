// تنسيق رقم فاتورة مبيعات يدوية (MSI-000123) — تُستخدم في المحاسبة (الترحيل التلقائي) والتقارير،
// لذا بقيت هنا كدالة مشتركة بعد حذف تبويب "الفوترة الضريبية والزكاة" الذي كان يحتوي شاشة إدخالها.
function formatManualSalesInvoiceNo(n){ return 'MSI-' + String(n).padStart(6,'0'); }

/* ================= معايير محاسبية: ترقيم تسلسلي رسمي + قفل فترات + حذف منطقي ================= */
// رقم تسلسلي دائم لا يتكرر ولا يُعاد استخدامه — لكن منفصل تماماً لكل حساب/وجهة (الخزنة كاش /
// البنك / الشبكة / أخرى)، بحيث تبدأ كل وجهة بترقيمها المستقل من 1 ولا تتأثر بعدد حركات باقي
// الوجهات الأخرى إطلاقاً.
function allocVaultSeq(destination){
  const dest = (destination && ['vault','bank','network','other'].includes(destination)) ? destination : 'vault';
  if(!settings.nextVaultSeqByDest || typeof settings.nextVaultSeqByDest!=='object') settings.nextVaultSeqByDest = { vault:1, bank:1, network:1, other:1 };
  let s = settings.nextVaultSeqByDest[dest] || 1;
  // حماية من إعادة استخدام رقم تسلسلي رسمي قيد الاستخدام: العداد (nextVaultSeqByDest) كان قد
  // يصبح أقل من أعلى رقم موجود فعلاً لنفس الوجهة — بعد استعادة نسخة احتياطية قديمة، أو عند
  // تحميل حركات من جهاز/جلسة لم تُحفظ معها أحدث قيم settings، أو عند أي تآزر بين إعادة ترقيم
  // والعداد. دون ذلك كانت الحركة الجديدة تستخدم رقماً موجوداً أصلاً (في vaultTx أو الحركات
  // الملغاة deletedVaultTx التي تُبقي أرقامها دائماً بموجب مبدأ "لا يُعاد استخدام الرقم الرسمي")
  // فيُصبح رقمان متطابقان في سجل حركات واحد — تزوير مالي بصري في المستندات الرسمية. نبدأ من
  // أول رقم حرّ بعد كل الأرقام المستخدمة فعلياً، مع الإبقاء على العداد متقدماً كالمعتاد.
  const used = new Set();
  vaultTx.forEach(t=>{ if((t.destination||'vault')===dest && typeof t.seq==='number') used.add(t.seq); });
  deletedVaultTx.forEach(t=>{ if((t.destination||'vault')===dest && typeof t.seq==='number') used.add(t.seq); });
  while(used.has(s)) s++;
  settings.nextVaultSeqByDest[dest] = s + 1;
  return s;
}
// ترحيل تلقائي لمرة واحدة فقط: إعادة ترقيم كل الحركات المالية (الفعّالة والملغاة/المحذوفة منطقياً)
// بحيث يكون لكل حساب/وجهة (الخزنة كاش / البنك / الشبكة / أخرى) رقم تسلسلي مستقل خاص به بدءاً من 1،
// مرتّباً حسب تاريخ الحركة نفسها تصاعدياً ضمن كل وجهة على حدة (وعند تساوي التاريخ: حسب وقت الإنشاء
// الفعلي createdAt) — بدل رقم تسلسلي واحد موحّد لكل الحركات بغض النظر عن حسابها.
// تُنفَّذ مرة واحدة فقط بعلامة settings.vaultSeqRenumberedByDestV1 ولا تتكرر أبداً بعد ذلك، حتى لا
// تتغير الأرقام الرسمية بعد اعتمادها وطباعتها على المستندات.
function renumberVaultSeqChronologically(){
  if(settings.vaultSeqRenumberedByDestV1) return 0;
  const all = [...vaultTx, ...deletedVaultTx];
  if(!settings.nextVaultSeqByDest || typeof settings.nextVaultSeqByDest!=='object') settings.nextVaultSeqByDest = { vault:1, bank:1, network:1, other:1 };
  if(!all.length){ settings.vaultSeqRenumberedByDestV1 = true; return 0; }
  const byDest = { vault:[], bank:[], network:[], other:[] };
  all.forEach(t=>{
    const d = ['vault','bank','network','other'].includes(t.destination) ? t.destination : 'vault';
    byDest[d].push(t);
  });
  let totalRenumbered = 0;
  ['vault','bank','network','other'].forEach(dest=>{
    const group = byDest[dest];
    group.sort((a,b)=>{
      const da = a.date || '', db = b.date || '';
      if(da !== db) return da.localeCompare(db);
      const ca = a.createdAt || 0, cb = b.createdAt || 0;
      if(ca !== cb) return ca - cb;
      return String(a.id||'').localeCompare(String(b.id||''));
    });
    let n = 1;
    group.forEach(t=>{ t.seq = n++; });
    settings.nextVaultSeqByDest[dest] = n;
    totalRenumbered += group.length;
  });
  settings.vaultSeqRenumberedByDestV1 = true;
  return totalRenumbered;
}
// هل هذا التاريخ يقع ضمن فترة محاسبية مُقفلة (بعد اعتماد قوائمها)؟
function isDateLocked(dateStr){
  return !!(settings.vaultLockedThrough && dateStr && dateStr <= settings.vaultLockedThrough);
}
function vaultLockToast(){
  showToast(`هذه الحركة ضمن فترة محاسبية مُقفلة حتى ${settings.vaultLockedThrough} — لا يمكن إضافتها أو تعديلها أو حذفها. لتغيير ذلك راجع "قفل الفترة المحاسبية" أعلى شاشة الحركات المالية`);
}
// حذف منطقي (Soft Delete): تُنقل الحركة من السجل الفعّال إلى سجل الحركات الملغاة مع سبب موثّق، ولا تُحذف بياناتها نهائياً أبداً
function softDeleteVaultTx(id, reason){
  const idx = vaultTx.findIndex(t=>t.id===id);
  if(idx===-1) return null;
  const removed = vaultTx[idx];
  vaultTx.splice(idx,1);
  removed.deletedAt = Date.now();
  removed.deletedBy = currentUser || 'غير معروف';
  removed.deletedReason = reason || '';
  deletedVaultTx.push(removed);
  return removed;
}
// يسجّل نسخة "قبل/بعد" كاملة من الحركة ضمن سجل تعديلاتها الخاص (بدل الاكتفاء برسالة نصية في سجل المراجعة العام)
function pushVaultTxHistory(tx, beforeSnapshot, afterSnapshot){
  if(!tx.history) tx.history = [];
  tx.history.push({
    at: Date.now(),
    user: currentUser || 'غير معروف',
    before: beforeSnapshot,
    after: afterSnapshot
  });
}
async function saveCourseSessions(){
  try{ await saveCollectionGeneric('courseSessions', courseSessions); }catch(e){ showToast('تعذر حفظ بيانات الدورات'); }
}
async function saveCompanies(){
  try{ await saveCollectionGeneric('companies', companies); }catch(e){ showToast('تعذر حفظ بيانات الشركات'); }
}
async function saveCompanyTransfers(){
  try{ await saveCollectionGeneric('companyTransfers', companyTransfers); }catch(e){ showToast('تعذر حفظ بيانات تحويلات الشركات'); }
}
/* ================= ترحيل تلقائي: توحيد القيود المالية لكل حوالة شركة في قيد واحد =================
   سابقاً: كل متدرب مسجَّل تحت حوالة شركة كان يُنشئ قيد خزنة منفصل (مرتبط عبر companyTransferAllocId).
   حالياً: الحوالة كاملة يجب أن تُمثَّل بقيد خزنة واحد فقط (companyTransferId) بكامل مبلغ الحوالة —
   لأن المبلغ يُستلم دفعة واحدة من الشركة سواء وُزِّع على المتدربين بالكامل أو لا. هذه الدالة تُستدعى
   مرة واحدة تلقائياً عند كل تحميل للبرنامج: أي حوالة قديمة ما زال ليس لها قيد "companyTransferId" بعد
   يتم دمج كل قيودها الفردية القديمة (إن وُجدت) في قيد واحد جديد بقيمة "amount" المسجّلة على الحوالة نفسها،
   مع نقل القيود القديمة إلى سجل الحركات الملغاة (حذف منطقي) حفاظاً على أثرها التاريخي/المحاسبي.
   بيانات المتدربين داخل سجل الحوالة نفسها (الأسماء، القيم، الربط بشيت العملاء) لا تُمس إطلاقاً هنا. */
function migrateCompanyTransfersToLumpSum(){
  let migratedCount = 0;
  companyTransfers.forEach(t=>{
    if(vaultTx.some(v=>v.companyTransferId===t.id)) return; // مُرحَّلة مسبقاً
    const traineeIds = new Set((t.trainees||[]).map(tr=>tr.id));
    const oldEntries = vaultTx.filter(v=>v.companyTransferAllocId && traineeIds.has(v.companyTransferAllocId));
    const refEntry = oldEntries[0];
    const date = t.date || (refEntry && refEntry.date) || todayISO();
    const channel = t.channel || (refEntry && refEntry.method) || (settings.channels[0] && settings.channels[0].name) || 'تحويل بنكي';
    const destCh = settings.channels.find(ch=>ch.name===channel);
    const destination = destCh ? destCh.dest : ((refEntry && refEntry.destination) || 'bank');
    oldEntries.forEach(e=>{
      const removed = softDeleteVaultTx(e.id, `دُمجت تلقائياً ضمن قيد واحد موحّد لحوالة الشركة "${t.companyName||''}"`);
      if(removed) removed.companyTransferAllocId = undefined;
    });
    vaultTx.push({
      id: uid(), seq: allocVaultSeq(destination), createdAt: Date.now(),
      type:'in', date, amount: num(t.amount), destination,
      clientName:'', method: channel, category:'', manual:'', networkInvoice:'',
      notes: `حوالة شركة "${t.companyName||''}"${t.refNum?` — مرجع: ${t.refNum}`:''}${oldEntries.length?` (تم دمج ${oldEntries.length} قيد فردي سابق تلقائياً)`:''}`,
      companyTransferId: t.id
    });
    migratedCount++;
  });
  return migratedCount;
}
/* ================= مزامنة تلقائية دائمة: نقل قيمة تخصيص كل متدرب في حوالات الشركات إلى قيمة
   الدورة/الحقيبة/المدفوع في سجله بشيت العملاء (لو كان مرتبطاً بعميل موجود). الحوالة هي المصدر
   الرسمي لهذه القيمة فتُستبدل بها دائماً. تعمل عند كل تحميل بيانات (وليس مرة واحدة فقط) — لأن أول
   تحميل قد يعتمد على نسخة كاش محلية ناقصة على بعض الأجهزة (قبل اكتمال المزامنة مع السيرفر)، فلازم
   تُعاد المحاولة عند كل تحميل حتى تلتقط أي حوالات/عملاء لم تُرحَّل بعد. آمنة للتكرار: لا تُحدِّث ولا
   تحسب أي شيء إلا لو القيمة فعلاً مختلفة عمّا هو مسجّل، ولا تُنشئ أي قيد مالي/خزنة جديد. */
function migrateCompanyTraineeValuesToClients(){
  let changedCount = 0;
  companyTransfers.forEach(t=>{
    (t.trainees||[]).forEach(tr=>{
      const client = clients.find(x=>x.clientId===tr.clientId);
      if(!client) return;
      const newCourse = num(tr.courseValue), newBag = num(tr.bagValue), newPaid = newCourse+newBag;
      const resolvedChannel = (()=>{ const ch = settings.channels.find(c=>c.name===t.channel); return ch ? ch.name : (t.channel || 'تحويل بنكي (شركة)'); })();
      const typeMismatch = client.clientType!=='company' || client.companyName!==t.companyName;
      // نتحقق أيضاً من طريقة الدفع ونوع العميل/اسم الشركة (وليس فقط القيمة المالية) — عملاء كثيرون
      // مُزامَنون بالفعل بالمبلغ الصحيح لكن ظلّوا مُصنَّفين "عميل مركز" بدل "عميل شركات" (أو باسم شركة
      // قديم/فارغ)، أو بدون طريقة دفع مسجَّلة أصلاً، لأن هذه المزامنة التلقائية عند كل تحميل لم تكن
      // تضبط هذين الحقلين من قبل — رغم أن باقي مسارات الإضافة/التعديل اليدوية كانت تضبطهما بالفعل.
      if(client.companyTransferAllocated && num(client.coursePrice)===newCourse && num(client.bagPrice)===newBag && num(client.paid)===newPaid && client.channel===resolvedChannel && !typeMismatch) return; // مطابق بالفعل ومُعلَّم مسبقاً
      if(typeMismatch){
        client.clientType = 'company';
        client.companyName = t.companyName;
      }
      syncClientValueFromTraineeAllocation(client, tr.courseValue, tr.bagValue, t);
      changedCount++;
    });
  });
  return changedCount;
}
/* ================= إصلاح تلقائي لبيانات قديمة: عملاء بقوا معلَّمين companyTransferAllocated=true رغم
   أنهم لم يعودوا ضمن متدربي أي حوالة شركة (بسبب حذف متدرب أو حذف حوالة كاملة قبل توفّر هذا الإصلاح).
   نمرّ على كل عملاء شيت العملاء المعلَّمين بهذه العلامة، ونتحقق: هل ما زال رقم هويتهم موجوداً ضمن
   متدربي أي حوالة شركة حالية؟ إن لم يكن، تُصفَّر قيمهم المُزامَنة (نفس منطق unlinkClientFromCompanyTransferIfOrphaned). */
async function reconcileOrphanedCompanyTransferClients(){
  let fixedCount = 0;
  for(const c of clients){
    if(!c.companyTransferAllocated || !c.clientId) continue;
    const linked = companyTransfers.some(tt=>(tt.trainees||[]).some(tr=>tr.clientId===c.clientId));
    if(linked) continue;
    if(await unlinkClientFromCompanyTransferIfOrphaned(c.clientId, null)) fixedCount++;
  }
  return fixedCount;
}
/* ================= إصلاح تلقائي: حذف القيود المالية المكرَّرة التي أُنشئت خطأً سابقاً =================
   لعملاء مُرحَّلة قيمتهم من حوالة شركة (companyTransferAllocated)، أي قيد تلقائي فردي (autoClientId) في
   الحركات المالية يُعتبر مكرراً — لأن مبلغهم مُرحَّل بالفعل ضمن القيد الموحّد لكامل الحوالة
   (companyTransferId). يُنقل القيد المكرر لسجل الحركات الملغاة (وليس حذفاً نهائياً) حفاظاً على أثره. */
function cleanupDuplicateCompanyTraineeVaultEntries(){
  let removedCount = 0;
  clients.forEach(c=>{
    if(!c.companyTransferAllocated) return;
    const dupEntries = vaultTx.filter(t=>t.autoClientId===c.id);
    dupEntries.forEach(t=>{
      softDeleteVaultTx(t.id, `قيد مكرر لعميل مُرحَّلة قيمته من حوالة شركة — المبلغ مُرحَّل بالفعل ضمن القيد الموحّد للحوالة`);
      removedCount++;
    });
  });
  return removedCount;
}
/* ================= إصلاح تلقائي لمرة واحدة: قيود يومية (journalDE) مُرحَّلة تلقائياً من فواتير
   الدورات كانت تشير لحسابات (accountId) من جيل قديم لدليل الحسابات (أُعيد إنشاؤه بمعرّفات جديدة
   أكثر من مرة تاريخياً — chartOfAccounts الحالي لا يحتوي هذه المعرّفات إطلاقاً). النتيجة: هذه
   القيود رغم كونها متزنة رياضياً بالكامل (مدين = دائن) كانت تختفي بصمت من كشف الحساب العام
   ومن ميزان المراجعة (لأن كليهما يبحث عن الحساب بمعرّفه الحالي فقط)، فتظهر إيرادات وذمم مدينة
   أقل من حقيقتها الفعلية بمقدار كل القيود المتأثرة. سطور هذا النوع من القيود تُبنى دائماً بترتيب
   ثابت لا يتغيّر (سطر1: ذمم مدينة 1100 / سطر2: إيراد 4000 / سطر3 إن وُجد: ضريبة 2100 — راجع
   buildDELinesForCourseInvoice)، فيُعاد ربط كل سطر بمعرّف الحساب الصحيح الحالي لنفس الرمز حسب
   ترتيبه، دون أي تغيير في المبالغ (debit/credit) نفسها إطلاقاً — إصلاح مرجع فقط، لا إصلاح مالي. */
function repairOrphanedCourseInvoiceAccountRefs(){
  if(settings.accountRefsRepairedV1) return 0;
  const arAcc = accountByCode('1100'), revAcc = accountByCode('4000'), vatAcc = accountByCode('2100');
  if(!arAcc || !revAcc || !vatAcc) return 0; // ننتظر دليل حسابات كامل قبل أي إصلاح
  const knownIds = new Set(chartOfAccounts.map(a=>a.id));
  const roleAccountIds = [arAcc.id, revAcc.id, vatAcc.id];
  let fixedCount = 0;
  journalDE.forEach(e=>{
    if(!e.sourceClientId) return; // فقط قيود فواتير الدورات المُرحَّلة تلقائياً
    const lines = e.lines||[];
    let changed = false;
    lines.forEach((l,idx)=>{
      if(l.accountId && !knownIds.has(l.accountId) && roleAccountIds[idx]){
        l.accountId = roleAccountIds[idx];
        changed = true;
      }
    });
    if(changed) fixedCount++;
  });
  settings.accountRefsRepairedV1 = true;
  return fixedCount;
}
async function saveJournalEntries(){
  try{ await saveCollectionGeneric('journalEntries', journalEntries); }catch(e){ showToast('تعذر حفظ القيود اليدوية'); }
}
async function saveChartOfAccounts(){
  try{ await saveCollectionGeneric('chartOfAccounts', chartOfAccounts); }catch(e){ showToast('تعذر حفظ دليل الحسابات'); }
}
async function saveJournalDE(){
  try{ await saveCollectionGeneric('journalDE', journalDE); }catch(e){ showToast('تعذر حفظ القيود اليومية'); }
}
async function saveBudgetEntries(){
  try{ await saveCollectionGeneric('budgetEntries', budgetEntries); }catch(e){ showToast('تعذر حفظ بيانات الموازنة'); }
}
async function saveSuppliers(){
  try{ await saveCollectionGeneric('suppliers', suppliers); }catch(e){ showToast('تعذر حفظ بيانات الموردين'); }
}
/* ---------------- ترحيل مرفقات فواتير المشتريات القديمة (مرة واحدة) ----------------
   قبل هذا التحديث كان مرفق كل فاتورة (dataUrl الصورة كاملة) مخزَّناً داخل نفس عنصر الفاتورة
   ضمن مصفوفة "purchases" الكبيرة — يعني كل صور كل الفواتير تتحمّل مع أي فتح لشيت المشتريات،
   حتى لو المستخدم لن يفتح ولا صورة واحدة. هذه الدالة تفحص عند كل بدء تشغيل هل يوجد مرفقات
   قديمة بهذا الشكل، ولو وُجدت تنقلها لمفاتيح kv منفصلة (purchase-attachment:ID) وتُبقي في سجل
   الفاتورة بيانات وصفية فقط (الاسم والنوع)، ثم تحفظ النتيجة. بعد أول مرة لن يبقى أي مرفق
   مضمَّن فتنتهي الدالة فوراً بدون أي عمل إضافي في المرات القادمة. */
async function migratePurchaseAttachmentsOut(){
  const legacy = purchases.filter(p=>p.attachment && p.attachment.dataUrl);
  if(!legacy.length) return;
  for(const p of legacy){
    try{
      await window.storage.set('purchase-attachment:'+p.id, JSON.stringify({
        name: p.attachment.name, type: p.attachment.type, dataUrl: p.attachment.dataUrl
      }), false);
      p.attachment = {name: p.attachment.name, type: p.attachment.type};
    }catch(e){ /* لو فشل نقل مرفق معيّن، نتركه كما هو ليُعاد المحاولة في المرة القادمة */ }
  }
  await savePurchases();
}
async function savePurchases(){
  try{ await saveCollectionGeneric('purchases', purchases); }catch(e){ showToast('تعذر حفظ بيانات المشتريات'); }
}
async function saveManualSalesInvoices(){
  try{ await saveCollectionGeneric('manualSalesInvoices', manualSalesInvoices); }catch(e){ showToast('تعذر حفظ فواتير المبيعات اليدوية'); }
}
async function saveZakatAdjustments(){
  try{ await window.storage.set('zakatAdjustments', JSON.stringify(zakatAdjustments), false); }catch(e){ showToast('تعذر حفظ تعديلات وعاء الزكاة'); }
}
