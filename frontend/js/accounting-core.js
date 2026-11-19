// تنسيق رقم فاتورة مبيعات يدوية (MSI-000123) — تُستخدم في المحاسبة (الترحيل التلقائي) والتقارير،
// لذا بقيت هنا كدالة مشتركة بعد حذف تبويب "الفوترة الضريبية والزكاة" الذي كان يحتوي شاشة إدخالها.
function formatManualSalesInvoiceNo(n){ return 'MSI-' + String(n).padStart(6,'0'); }

/* ================= معايير محاسبية: ترقيم تسلسلي رسمي + قفل فترات + حذف منطقي ================= */
// رقم تسلسلي دائم لا يتكرر ولا يُعاد استخدامه — لكن منفصل تماماً لكل حساب/وجهة (الخزنة كاش /
// البنك / الشبكة / أخرى)، بحيث تبدأ كل وجهة بترقيمها المستقل من 1 ولا تتأثر بعدد حركات باقي
// الوجهات الأخرى إطلاقاً.
function allocVaultSeq(destination){
  const dest = (destination && ['vault','bank','network','network2','other'].includes(destination)) ? destination : 'vault';
  if(!settings.nextVaultSeqByDest || typeof settings.nextVaultSeqByDest!=='object') settings.nextVaultSeqByDest = { vault:1, bank:1, network:1, network2:1, other:1 };
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
  if(!settings.nextVaultSeqByDest || typeof settings.nextVaultSeqByDest!=='object') settings.nextVaultSeqByDest = { vault:1, bank:1, network:1, network2:1, other:1 };
  if(!all.length){ settings.vaultSeqRenumberedByDestV1 = true; return 0; }
  const byDest = { vault:[], bank:[], network:[], network2:[], other:[] };
  all.forEach(t=>{
    const d = ['vault','bank','network','network2','other'].includes(t.destination) ? t.destination : 'vault';
    byDest[d].push(t);
  });
  let totalRenumbered = 0;
  ['vault','bank','network','network2','other'].forEach(dest=>{
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
  try{ await _syncVersionsBeforeSave('courseSessions'); await saveCollectionGeneric('courseSessions', courseSessions); }catch(e){ showToast('تعذر حفظ بيانات الدورات'); }
}
/* دورة تلقائية: بمجرد ظهور رقم دورة (courseNumber) على عميل — سواء من التسجيل اليدوي أو من
   مزامنة أركان أو من الاستيراد الجماعي — ولا توجد له دورة معرّفة بعد بنفس الرقم فى شيت الدورات
   (courseSessions)، تُنشأ له دورة حقيقية محفوظة فعلاً (وليست جلسة وهمية مؤقتة تُحسب فقط وقت
   العرض كما كانت الحالة سابقاً فى getEffectiveSessions). أي عميل آخر لاحق بنفس رقم الدورة
   ينضم تلقائياً تحت نفس الدورة عبر التجميع الموجود أصلاً (groupClientsByCourseNumber) —
   المطابقة هنا دائماً برقم الدورة فقط، وليست باسم الدورة (courseType)، حتى لا تختلط دورتان
   مختلفتان فعلياً (بتواريخ مختلفة) لمجرد تطابق اسميهما.
   لا تُعدّل دورة موجودة بالفعل بنفس الرقم (حفاظاً على أي تعديل يدوي سابق: لغة/سعة/ملاحظات...).
   ترجع true لو أنشأت دورة جديدة فعلاً — على المستدعي عندها استدعاء saveCourseSessions(). */
function ensureCourseSessionForClient(c, preferredDate){
  const courseNumber = String(c && c.courseNumber || '').trim();
  if(!courseNumber) return false;
  if(courseSessions.some(s=>s.courseNumber===courseNumber)) return false; // موجودة بالفعل — لا نلمسها
  const date = preferredDate || c.startDate || c.expectedCourseDate || '';
  courseSessions.push({
    id: uid(), createdAt: Date.now(), createdBy: currentUser,
    courseNumber, courseType: c.courseType || '', date,
    language: '', capacity: null,
    notes: 'أُنشئت تلقائياً عند ظهور رقم هذه الدورة لأول مرة على أحد العملاء'
  });
  return true;
}
async function saveCompanies(){
  try{ await _syncVersionsBeforeSave('companies'); return await saveCollectionGeneric('companies', companies); }catch(e){ showToast('تعذر حفظ بيانات الشركات'); return 'rejected'; }
}
async function saveCompanyTransfers(){
  try{ await _syncVersionsBeforeSave('companyTransfers'); return await saveCollectionGeneric('companyTransfers', companyTransfers); }catch(e){ showToast('تعذر حفظ بيانات تحويلات الشركات'); return 'rejected'; }
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
/* ================= إصلاح مراجع الحسابات اليتيمة في القيود اليومية (V2) =================
   بعض القيود اليومية تشير لمعرّفات حسابات من جيل قديم لدليل الحسابات (أُعيد إنشاؤه
   بمعرّفات جديدة أكثر من مرة تاريخياً)، فتظهر بسطر «حساب غير موجود» وتختفي بصمت من
   كشف الحساب العام وميزان المراجعة. هذه الدالة تعيد ربط هذه السطور بالحساب الصحيح
   حسب ترتيب السطور الثابت في كل نوع ترحيل تلقائي، دون أي تغيير في المبالغ:
   - فاتورة دورة / مبيعات يدوية: 1100 ثم 4000 ثم 2100 (ضريبة إن وُجدت)
   - فاتورة شراء: 5000 ثم 2100 (إن وُجدت) ثم 1000 (مدفوعة) أو 2000 (آجلة)
   - قيد يدوي قديم: حسب نوعه عبر buildAutoDELinesForLegacy
   أي قيد لا يطابق نمطاً معروفاً (مثل قيد يدوي مباشر) يُترك كما هو ويظهر للمراجعة.
   تعمل عند كل تحميل (آمنة للتكرار) لأن أي إعادة إنشاء لدليل الحسابات مستقبلاً
   قد تُنتج مراجع يتيمة جديدة. */
function repairOrphanedJournalDEAccountRefs(){
  if(!chartOfAccounts.length || !journalDE.length) return { entries: 0, lines: 0 };
  const byCode = new Map();
  chartOfAccounts.forEach(a=>{ if(!byCode.has(String(a.code))) byCode.set(String(a.code), a.id); });
  const knownIds = new Set(chartOfAccounts.map(a=>a.id));
  const target = code => byCode.get(String(code)) || null;
  let fixedEntries = 0, fixedLines = 0;
  const fix = (lines, idx, code)=>{
    const line = lines[idx];
    const accId = target(code);
    if(!line || !accId) return false;
    if(line.accountId && knownIds.has(line.accountId)) return false;
    if(line.accountId === accId) return false;
    line.accountId = accId;
    return true;
  };
  journalDE.forEach(e=>{
    const lines = e.lines || [];
    if(!lines.some(l=> !l.accountId || !knownIds.has(l.accountId))) return;
    let changed = 0;
    if(e.sourceClientId || e.sourceManualSalesId){
      if(fix(lines, 0, '1100')) changed++;
      if(fix(lines, 1, '4000')) changed++;
      if(lines.length >= 3 && fix(lines, 2, '2100')) changed++;
    } else if(e.sourcePurchaseId){
      const p = purchases.find(x=>x.id===e.sourcePurchaseId);
      if(p){
        const expected = ['5000'];
        if(num(p.taxAmount) > 0) expected.push('2100');
        expected.push(p.status === 'paid' ? '1000' : '2000');
        if(expected.length === lines.length){
          expected.forEach((code, i)=>{ if(fix(lines, i, code)) changed++; });
        }
      }
    } else if(e.sourceJournalEntryId){
      const j = journalEntries.find(x=>x.id===e.sourceJournalEntryId);
      const built = (j && typeof buildAutoDELinesForLegacy==='function') ? buildAutoDELinesForLegacy(j) : null;
      if(built && built.length === lines.length){
        built.forEach((bl, i)=>{
          const acc = chartOfAccounts.find(a=>a.id===bl.accountId);
          if(acc && fix(lines, i, acc.code)) changed++;
        });
      }
    }
    if(changed){ fixedEntries++; fixedLines += changed; }
  });
  return { entries: fixedEntries, lines: fixedLines };
}
/* اسم قديم محفوظ للتوافق مع نداءات سابقة — يُرجع عدد القيود المُصلَحة */
function repairOrphanedCourseInvoiceAccountRefs(){
  return repairOrphanedJournalDEAccountRefs().entries;
}
async function saveJournalEntries(){
  try{ await _syncVersionsBeforeSave('journalEntries'); await saveCollectionGeneric('journalEntries', journalEntries); }catch(e){ showToast('تعذر حفظ القيود اليدوية'); }
}
async function saveChartOfAccounts(){
  try{ await _syncVersionsBeforeSave('chartOfAccounts'); await saveCollectionGeneric('chartOfAccounts', chartOfAccounts); }catch(e){ showToast('تعذر حفظ دليل الحسابات'); }
}
async function saveJournalDE(){
  try{ await _syncVersionsBeforeSave('journalDE'); await saveCollectionGeneric('journalDE', journalDE); }catch(e){ showToast('تعذر حفظ القيود اليومية'); }
}
async function saveBudgetEntries(){
  try{ await _syncVersionsBeforeSave('budgetEntries'); await saveCollectionGeneric('budgetEntries', budgetEntries); }catch(e){ showToast('تعذر حفظ بيانات الموازنة'); }
}
async function saveSuppliers(){
  try{ await _syncVersionsBeforeSave('suppliers'); await saveCollectionGeneric('suppliers', suppliers); }catch(e){ showToast('تعذر حفظ بيانات الموردين'); }
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
  try{ await _syncVersionsBeforeSave('purchases'); await saveCollectionGeneric('purchases', purchases); }catch(e){ showToast('تعذر حفظ بيانات المشتريات'); }
}
async function saveManualSalesInvoices(){
  try{ await _syncVersionsBeforeSave('manualSalesInvoices'); await saveCollectionGeneric('manualSalesInvoices', manualSalesInvoices); }catch(e){ showToast('تعذر حفظ فواتير المبيعات اليدوية'); }
}
async function saveZakatAdjustments(){
  try{ await window.storage.set('zakatAdjustments', JSON.stringify(zakatAdjustments), false); }catch(e){ showToast('تعذر حفظ تعديلات وعاء الزكاة'); }
}
