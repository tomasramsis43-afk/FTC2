/* ---------------- Vault (الخزنة) ---------------- */
$('#btn-template-bag-invoices').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_فواتير_الحقائب.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890', 'رقم فاتورة الحقيبة':'INV-0001', 'تاريخ شراء الحقيبة':'2026-01-15'}
  ]);
});
$('#btn-import-bag-invoices').addEventListener('click', ()=> $('#import-baginv-input').click());
$('#import-baginv-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    snapshotState('استيراد فواتير الحقائب من Excel');
    let updated=0, skipped=0, bagStockChanged=false;
    const changedRows = [];
    for(const row of json){
      const clientId = String(row['رقم الهوية']||'').trim();
      const bagInvoice = String(row['رقم فاتورة الحقيبة']||'').trim();
      const bagDate = normalizeExcelDate(row['تاريخ شراء الحقيبة']);
      if(!clientId || (!bagInvoice && !bagDate)){ skipped++; continue; }
      const c = clients.find(x=>x.clientId===clientId);
      if(!c){ skipped++; continue; }
      const oldInvoice = c.bagInvoice||'', oldDate = c.bagPurchaseDate||'', oldSource = c.bagSource;
      if(bagInvoice) c.bagInvoice = bagInvoice;
      if(bagDate) c.bagPurchaseDate = bagDate;
      // تم إلغاء "الشراء المباشر" نهائياً: استيراد فاتورة/تاريخ شراء لعميل يعني أن حقيبته تُسلَّم من
      // المخزون، لذلك يُحدَّث "مصدر الحقيبة" في شيت العميل تلقائياً إلى "من المخزون" مهما كان مصدرها
      // السابق، ويُضاف سطر "تسليم" مقابل في سجل مخزون الحقائب حتى يبقى الرصيد متسقاً (إن لم يكن مسجَّلاً له بالفعل).
      if(!c.bagPurchaseDate) c.bagPurchaseDate = todayISO();
      c.bagSource = 'stock';
      c.bagStatus = 'purchased';
      if(oldSource!=='stock' || !bagStock.some(b=>b.type==='issue' && b.issuedClientId===c.id)){
        bagStock.push({
          id: uid(), createdBy: currentUser, type:'issue', qty:-1, unitPrice:0,
          date: c.bagPurchaseDate, createdAt: Date.now(),
          issuedClientId: c.id, issuedClientName: c.name,
          notes: `تسليم من المخزون للعميل: ${c.name} (استيراد فواتير/تواريخ الحقائب)`
        });
        bagStockChanged = true;
      }
      updated++;
      changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name, 'مصدر الحقيبة (قديم)':bagSourceLabel({...c, bagSource:oldSource}), 'مصدر الحقيبة (جديد)':bagSourceLabel(c), 'رقم فاتورة الحقيبة (قديم)':oldInvoice, 'رقم فاتورة الحقيبة (جديد)':c.bagInvoice||'', 'تاريخ الشراء (قديم)':oldDate, 'تاريخ الشراء (جديد)':c.bagPurchaseDate||''});
    }
    if(bagStockChanged) recalcBagFundLedger();
    await saveClients();
    if(bagStockChanged) await saveBagStock();
    await saveSettings();
    await logAudit('edit','مخزون الحقائب', `استيراد أرقام فواتير/تواريخ شراء الحقائب من Excel: تحديث ${updated} عميل (تم تسليم حقائبهم من المخزون تلقائياً)${skipped?`، وتخطي ${skipped} صف`:''}`);
    renderTable(); renderBags();
    showToast(`تم تحديث ${updated} عميل${skipped?`، ${skipped} تم تخطيه`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد من أعمدة "رقم الهوية" و"رقم فاتورة الحقيبة" / "تاريخ شراء الحقيبة"');
  }finally{
    e.target.value = '';
  }
});

/* ---------------- حذف حقائب مجموعة عملاء دفعة واحدة عبر استيراد ملف Excel (بعمود "رقم الهوية") ---------------- */
$('#btn-template-bag-delete-list').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_قائمة_حذف_حقائب.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890'}, {'رقم الهوية':'0987654321'}
  ]);
});
$('#btn-import-bag-delete-list').addEventListener('click', ()=> $('#import-bagdelete-input').click());
$('#import-bagdelete-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    const idsInFile = [...new Set(json.map(r=>String(r['رقم الهوية']||'').trim()).filter(Boolean))];
    if(!idsInFile.length){ showToast('لم يتم العثور على عمود "رقم الهوية" في الملف أو أنه فارغ'); return; }
    const notFoundCount = idsInFile.filter(id=>!clients.some(c=>c.clientId===id)).length;
    const alreadyPendingCount = idsInFile.filter(id=>{ const c=clients.find(x=>x.clientId===id); return c && clientBagIsClean(c); }).length;
    const matched = clients.filter(c=>idsInFile.includes(c.clientId) && !clientBagIsClean(c));
    if(!matched.length){ showToast('كل العملاء المطابقين بأرقام الهوية في الملف بحالة "مطلوب شراء" أصلاً — لا يوجد شيء لحذفه'); return; }
    const namesPreview = matched.slice(0,5).map(c=>c.name).join('، ');
    const extra = matched.length>5 ? ` وآخرين (${matched.length-5})` : '';
    const ignoredNotes = [
      notFoundCount ? `${notFoundCount} رقم هوية غير موجود أصلاً في النظام` : '',
      alreadyPendingCount ? `${alreadyPendingCount} عميل بحالة "مطلوب شراء" أصلاً` : ''
    ].filter(Boolean).join(' — ');
    const ignoredMsg = ignoredNotes ? `\n(تنبيه: سيتم تجاهل ${ignoredNotes})` : '';
    if(!await customConfirm(`تم العثور على ${matched.length} عميل مطابق لأرقام الهوية في الملف. تأكيد حذف حقائبهم دفعة واحدة؟ سيتم مسحها بالكامل من سجل شراء الحقائب المكتملة ومن سجل "اشتروا حقائبهم الخاصة"، وتعود حالتهم إلى "مطلوب شراء" بقيمة الحقيبة الافتراضية، وتُعاد أي حقيبة من المخزون تلقائياً لرصيد التمويل. (${namesPreview}${extra})${ignoredMsg}\nهذا الإجراء لا يمكن التراجع عنه إلا من نسخة احتياطية.`)){ e.target.value=''; return; }
    snapshotState(`حذف حقائب عبر استيراد Excel (${matched.length} عميل)`);
    const removedNames = matched.map(c=>c.name);
    matched.forEach(c=> resetClientBagToPending(c));
    await saveClients(); await saveVaultTx(); await saveBagStock(); await saveSettings();
    await logAudit('delete','مخزون الحقائب', `تم حذف حقائب ${matched.length} عميل عبر استيراد ملف Excel (عادت حالتهم إلى "مطلوب شراء"): ${removedNames.slice(0,20).join('، ')}${removedNames.length>20?` وآخرين (${removedNames.length-20})`:''}${ignoredNotes?` — تم تجاهل: ${ignoredNotes}`:''}`);
    renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderBags();
    if(typeof renderVault==='function') renderVault();
    showToast(`تم حذف حقائب ${matched.length} عميل${(notFoundCount+alreadyPendingCount)?`، وتجاهل ${notFoundCount+alreadyPendingCount} صف`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد أنه بصيغة Excel صحيحة وبه عمود "رقم الهوية"');
  }finally{
    e.target.value = '';
  }
});

/* ---------------- تحديد مجموعة عملاء دفعة واحدة كـ"اشتروا حقيبتهم الخاصة" عبر استيراد ملف Excel (بعمود "رقم الهوية") ---------------- */
$('#btn-template-bag-own-list').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_عملاء_حقيبتهم_الخاصة.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890'}, {'رقم الهوية':'0987654321'}
  ]);
});
$('#btn-import-bag-own-list').addEventListener('click', ()=> $('#import-bagown-input').click());
$('#import-bagown-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    const idsInFile = [...new Set(json.map(r=>String(r['رقم الهوية']||'').trim()).filter(Boolean))];
    if(!idsInFile.length){ showToast('لم يتم العثور على عمود "رقم الهوية" في الملف أو أنه فارغ'); return; }
    const notFoundCount = idsInFile.filter(id=>!clients.some(c=>c.clientId===id)).length;
    const alreadyOwnCount = idsInFile.filter(id=>{ const c=clients.find(x=>x.clientId===id); return c && c.bagSource==='own'; }).length;
    const matched = clients.filter(c=>idsInFile.includes(c.clientId) && c.bagSource!=='own');
    if(!matched.length){ showToast('كل العملاء المطابقين بأرقام الهوية في الملف مسجَّلين أصلاً كـ"اشتروا حقيبتهم الخاصة" — لا يوجد شيء لتحديثه'); return; }
    const namesPreview = matched.slice(0,5).map(c=>c.name).join('، ');
    const extra = matched.length>5 ? ` وآخرين (${matched.length-5})` : '';
    const ignoredNotes = [
      notFoundCount ? `${notFoundCount} رقم هوية غير موجود أصلاً في النظام` : '',
      alreadyOwnCount ? `${alreadyOwnCount} عميل مسجَّل بالفعل كـ"اشترى حقيبته الخاصة"` : ''
    ].filter(Boolean).join(' — ');
    const ignoredMsg = ignoredNotes ? `\n(تنبيه: سيتم تجاهل ${ignoredNotes})` : '';
    if(!await customConfirm(`تم العثور على ${matched.length} عميل مطابق لأرقام الهوية في الملف. تأكيد اعتبار هؤلاء العملاء ممن اشتروا حقيبتهم الخاصة؟ ستُصبح قيمة الحقيبة صفراً لكل منهم فوراً في شيت العملاء، وسيختفون من "حقائب يجب شراؤها" ومن "سجل عمليات شراء الحقائب المكتملة" إن كانوا مسجّلين في أيّ منهما، ولن تُحتسب عليهم أي قيمة حقيبة ضمن حصيلة/تحصيل الحقائب بعد الآن. (${namesPreview}${extra})${ignoredMsg}\nهذا الإجراء لا يمكن التراجع عنه إلا من نسخة احتياطية.`)){ e.target.value=''; return; }
    snapshotState(`استيراد قائمة عملاء اشتروا حقيبتهم الخاصة (${matched.length} عميل)`);
    const namesAll = matched.map(c=>c.name);
    matched.forEach(c=> markClientBagOwn(c));
    await saveClients(); await saveVaultTx();
    await logAudit('edit','مخزون الحقائب', `تم تحديد ${matched.length} عميل كـ"اشتروا حقيبتهم الخاصة" عبر استيراد ملف Excel (أصبحت قيمة حقيبتهم صفراً ولم تعد تُحتسب ضمن تحصيل الحقائب): ${namesAll.slice(0,20).join('، ')}${namesAll.length>20?` وآخرين (${namesAll.length-20})`:''}${ignoredNotes?` — تم تجاهل: ${ignoredNotes}`:''}`);
    renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderBags();
    if(typeof renderVault==='function') renderVault();
    showToast(`تم تحديث ${matched.length} عميل${(notFoundCount+alreadyOwnCount)?`، وتجاهل ${notFoundCount+alreadyOwnCount} صف`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد أنه بصيغة Excel صحيحة وبه عمود "رقم الهوية"');
  }finally{
    e.target.value = '';
  }
});

function removeClientLedgerEntries(clientRecordId){
  vaultTx = vaultTx.filter(t=>t.autoClientId!==clientRecordId);
}
/* هل مستخدم (باسمه) هو صاحب دور "استقبال"؟ تُستخدم لتحديد هل دفعة العميل النقدية تحتاج
   "تسوية" (تأكيد استلام فعلي) أم لا — فقط عمليات التسجيل التي يقوم بها الاستقبال نفسه
   تحتاج تسوية، أما عمليات التسجيل التي يقوم بها الأدمن/المحاسب/الموظف العام فتُعتبر
   محسوبة ومؤكدة تلقائياً فور تسجيلها، لأنها ليست تسليم نقدية من طرف لآخر. */
function isReceptionUsername(username){
  if(!username) return false;
  // الحالة الأكثر شيوعاً بكثير: العميل يُسجَّل بمعرفة نفس الجلسة الحالية (createdBy === currentUser).
  // هنا نعرف دور المُسجِّل يقيناً من الجلسة الحالية (currentUserRole) دون أي حاجة لقائمة المستخدمين
  // الكاملة (users) — التي أصلاً لا تُحمَّل إطلاقاً لغير الأدمن (راجع loadData: wantUsers). كان هذا
  // الفحص القديم (الاعتماد على users فقط) يرجع false دائماً فى جلسة الاستقبال نفسها، فيُسجَّل أي
  // عميل يسجّله موظف استقبال كدفعة "مُسوّاة تلقائياً" من البداية، فلا تظهر إطلاقاً فى شاشة تسوية
  // الاستقبال رغم أنها بالضبط الحالة التي صُممت الشاشة من أجلها.
  if(username === currentUser) return currentUserRole === 'reception';
  // حالة أندر: تعديل سجل عميل أنشأه مستخدم آخر (createdBy مختلف عن الجلسة الحالية) — هنا فقط
  // نحتاج فعلاً قائمة المستخدمين الكاملة، المتاحة حصراً لجلسة الأدمن (الحالة الوحيدة التي يصح
  // فيها الاعتماد على users أصلاً بما أنها المصدر الوحيد المضمون تحميله).
  const u = users.find(x=>x.username===username);
  return !!(u && u.role==='reception');
}
function syncClientLedgerEntry(client){
  // عميل سجّله الاستقبال ولسه معلّق اعتماد الأدمن (status='pending'): لا تُنشأ له حركات مالية
  // تلقائية إطلاقاً قبل الاعتماد — تُنشأ لحظة اعتماد الأدمن له (راجع approveClientRecord في
  // clients-print-modals.js) فتدخل الحسابات والتقارير من يوم اعتماده وليس قبلها.
  const recMeta = (typeof clientRecordMeta==='object' && clientRecordMeta) ? clientRecordMeta[client.id] : null;
  // الحالة المعلّقة معروفة من السيرفر: status==='pending'. واحتياطاً، لو الحالة غير معروفة بعد
  // (حفظ فشل/أوفلاين) وجلسة الاستقبال هي من تحرّك العميل، فسجله سيُرفع حتماً كـ pending — نمنع
  // إنشاء القيود احترازاً حتى لا تظهر حركات مالية لعميل لم يُعتمد بعد.
  if(recMeta ? recMeta.status === 'pending' : currentUserRole === 'reception') return;
  // نحافظ على الرقم التسلسلي الرسمي القديم لهذين القيدين إن كانا موجودين مسبقاً (يُعاد توليدهما عند كل حفظ لبيانات العميل)
  const prevSeqs = {};
  // نحافظ أيضاً على حالة "تسوية الاستقبال" (settled) القديمة، حتى لا يفقد المسؤول عن الخزنة
  // تأكيده السابق لاستلام النقدية فعلياً لمجرد تعديل بسيط في بيانات العميل لاحقاً
  const prevSettle = {};
  vaultTx.filter(t=>t.autoClientId===client.id).forEach(t=>{
    prevSeqs[t.id] = t.seq;
    prevSettle[t.id] = { settled: !!t.settled, settledBy: t.settledBy||'', settledAt: t.settledAt||null };
  });
  removeClientLedgerEntries(client.id);
  // عميل مُرحَّلة قيمته من حوالة شركة (companyTransferAllocated): المبلغ مُرحَّل بالفعل مرة واحدة ضمن
  // القيد المالي الموحّد لكامل الحوالة (companyTransferId) — فلا نُنشئ له قيداً فردياً إضافياً هنا
  // تجنّباً لتكرار المبلغ في الحركات المالية.
  if(num(client.paid)>0 && !client.companyTransferAllocated){
    const chan = settings.channels.find(c=>c.name===client.channel);
    const dest = chan ? chan.dest : 'other';
    // ملاحظة: يتم ترحيل الدفعة دائماً (حتى لو كانت طريقة الدفع "أخرى" مثل طبي/المركز) حتى تُحتسب
    // ضمن "إجمالي المدفوع" لبيانات العميل — لكنها لا تدخل ضمن أرصدة الخزنة/البنك/الشبكة (balanceOf يتجاهل "أخرى").
    vaultTx.push({
      id:'auto_'+client.id,
      seq: prevSeqs['auto_'+client.id] || allocVaultSeq(dest),
      type:'in',
      date: client.date || todayISO(),
      amount: num(client.paid),
      destination: dest,
      clientId: client.clientId,
      clientName: client.name,
      method: client.channel,
      category:'',
      manual:'',
      networkInvoice: dest==='network' ? (client.networkInvoice||'') : '',
      notes: dest==='other' ? 'ترحيل تلقائي من سجل العميل (تسوية خارج حسابات الخزنة/البنك/الشبكة)' : 'ترحيل تلقائي من سجل العميل' + (num(client.paid2)>0 ? ' — الدفعة الأولى من دفعتين' : ''),
      autoClientId: client.id,
      createdAt: Date.now(),
      settled: dest==='vault' ? (prevSettle['auto_'+client.id] ? prevSettle['auto_'+client.id].settled : true) : true,
      settledBy: dest==='vault' ? (prevSettle['auto_'+client.id] ? prevSettle['auto_'+client.id].settledBy : '') : '',
      settledAt: dest==='vault' ? (prevSettle['auto_'+client.id] ? prevSettle['auto_'+client.id].settledAt : null) : null,
    });
  }
  // نفس استثناء عميل حوالة الشركة أعلاه، يُطبَّق أيضاً على الدفعة الثانية: بدونه كان يُنشأ قيد
  // auto2_ فردي حقيقي في الحركات المالية، ثم تأتي دالة التنظيف (cleanupDuplicateCompanyTraineeVaultEntries)
  // في التحميل التالي وتُلغيه تلقائياً باعتباره مكرراً — فتظهر "معاملة اختفت" رغم أنها كانت حقيقية.
  if(num(client.paid2)>0 && !client.companyTransferAllocated){
    const chan2 = settings.channels.find(c=>c.name===client.channel2);
    const dest2 = chan2 ? chan2.dest : 'other';
    vaultTx.push({
      id:'auto2_'+client.id,
      seq: prevSeqs['auto2_'+client.id] || allocVaultSeq(dest2),
      type:'in',
      date: client.date || todayISO(),
      amount: num(client.paid2),
      destination: dest2,
      clientId: client.clientId,
      clientName: client.name,
      method: client.channel2,
      category:'',
      manual:'',
      networkInvoice: dest2==='network' ? (client.networkInvoice2||'') : '',
      notes: dest2==='other' ? 'ترحيل تلقائي من سجل العميل (تسوية خارج حسابات الخزنة/البنك/الشبكة)' : 'ترحيل تلقائي من سجل العميل — الدفعة الثانية من دفعتين',
      autoClientId: client.id,
      createdAt: Date.now(),
      settled: dest2==='vault' ? (prevSettle['auto2_'+client.id] ? prevSettle['auto2_'+client.id].settled : true) : true,
      settledBy: dest2==='vault' ? (prevSettle['auto2_'+client.id] ? prevSettle['auto2_'+client.id].settledBy : '') : '',
      settledAt: dest2==='vault' ? (prevSettle['auto2_'+client.id] ? prevSettle['auto2_'+client.id].settledAt : null) : null,
    });
  }
}

/* شاشة "صندوق تسويات الاستقبال" أُزيلت نهائياً من البرنامج بناءً على طلب صريح (غير مطلوبة
   حالياً). الدفعات النقدية التي يسجّلها الاستقبال تُعتبر الآن مُسوّاة فوراً مثل باقي الأدوار —
   راجع تعديل "settled" أعلى فى pushAutoVaultEntriesForClient، وراجع الترحيل التلقائي
   settlementsAutoSettledV1 فى loadData (ui-framework.js) الذي يُسوّي أي سجلات قديمة معلّقة. */

function vaultFilteredDailyTrend(rows){
  const map = {};
  rows.forEach(t=>{
    const d = t.date || '—';
    if(!map[d]) map[d] = {in:0, out:0};
    if(t.type==='in') map[d].in += num(t.amount); else map[d].out += num(t.amount);
  });
  const labels = Object.keys(map).sort((a,b)=>a.localeCompare(b));
  const income = labels.map(d=>Math.round(map[d].in*100)/100);
  const expense = labels.map(d=>Math.round(map[d].out*100)/100);
  const net = labels.map((d,i)=>Math.round((income[i]-expense[i])*100)/100);
  return { labels, series:[
    {name:'وارد', color:'var(--teal)', values:income},
    {name:'صادر', color:'var(--red)', values:expense},
    {name:'الصافي', color:'var(--gold-dark)', values:net},
  ]};
}
/* توزيع نتائج الفلتر الحالي حسب طريقة الدفع */
function vaultFilteredMethodTotals(rows){
  const map = {};
  rows.forEach(t=>{ const k = t.method || 'غير محدد'; map[k] = (map[k]||0) + num(t.amount); });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]);
}
/* أرقام الهوية التي تتكرر أكثر من مرة ضمن كل حركات الخزنة/البنك/الشبكة (بغض النظر عن الفلتر الحالي) */
function vaultDuplicateClientIds(){
  const counts = {};
  vaultTx.forEach(t=>{ if(t.clientId) counts[t.clientId] = (counts[t.clientId]||0)+1; });
  const dup = new Set();
  Object.keys(counts).forEach(id=>{ if(counts[id]>1) dup.add(id); });
  return dup;
}
/* ---------------- كشف الحركات غير المعتادة إحصائياً (Anomaly Detection) ----------------
   مقارنة إحصائية بسيطة (وليست ذكاءً اصطناعياً): لكل تصنيف مصروف (category)، يُحسب المتوسط
   والانحراف المعياري لمبالغ كل الحركات الصادرة التاريخية بنفس التصنيف. أي حركة يتجاوز مبلغها
   المتوسط + 2.5 انحراف معياري تُعتبر "غير معتادة" وتحتاج مراجعة (قد تكون خطأ إدخال أو حالة
   استثنائية تستحق الانتباه). يتطلب 5 حركات على الأقل بنفس التصنيف حتى يُعتد بالمتوسط، وإلا
   يبقى التصنيف بلا حكم كافٍ (بيانات غير كافية). */
function vaultAnomalyIds(){
  const byCat = {};
  vaultTx.forEach(t=>{ if(t.type==='out' && t.category){ (byCat[t.category] = byCat[t.category]||[]).push(t); } });
  const anomalies = new Set();
  Object.values(byCat).forEach(list=>{
    if(list.length < 5) return;
    const amounts = list.map(t=>num(t.amount));
    const mean = amounts.reduce((a,b)=>a+b,0)/amounts.length;
    const variance = amounts.reduce((s,v)=>s+Math.pow(v-mean,2),0)/amounts.length;
    const stdev = Math.sqrt(variance);
    if(stdev===0) return;
    list.forEach(t=>{
      if((num(t.amount)-mean)/stdev > 2.5) anomalies.add(t.id);
    });
  });
  return anomalies;
}
function vaultFilteredRows(){
  const from = $('#v-from').value;
  const to = $('#v-to').value;
  const type = $('#v-filter-type').value;
  const dest = $('#v-filter-dest').value;
  const q = $('#v-search').value.trim().toLowerCase();
  const dupOnly = $('#v-filter-dup')?.checked;
  const dupIds = dupOnly ? vaultDuplicateClientIds() : null;
  const noMethodOnly = $('#v-filter-nomethod')?.checked;
  const anomalyOnly = $('#v-filter-anomaly')?.checked;
  const anomalyIds = anomalyOnly ? vaultAnomalyIds() : null;
  const frecepV = $('#v-filter-reception') ? $('#v-filter-reception').value : '';
  return vaultTx.filter(t=>{
    if(anomalyOnly && !anomalyIds.has(t.id)) return false;
    if(frecepV){
      const linkedClient = t.autoClientId ? clients.find(c=>c.id===t.autoClientId) : null;
      if(!linkedClient || linkedClient.createdBy!==frecepV) return false;
    }
    if(from && t.date < from) return false;
    if(to && t.date > to) return false;
    if(type && t.type!==type) return false;
    if(dest && (t.destination||'vault')!==dest) return false;
    if(dupOnly && !(t.clientId && dupIds.has(t.clientId))) return false;
    if(noMethodOnly && String(t.method||'').trim()) return false;
    if(q){
      // قيد الحوالة الموحّد (companyTransferId) لا يحمل clientId خاص به — لأنه يمثّل كامل مبلغ الحوالة
      // وليس متدرباً بعينه. فبدون هذه الإضافة، البحث برقم هوية متدرب مرتبط بحوالة شركة لا يُظهر شيئاً
      // رغم أن مبلغه فعلياً مُرحَّل ضمن هذا القيد. فنضيف أرقام هويات وأسماء كل متدربي الحوالة لمجال البحث.
      const companyTraineeInfo = t.companyTransferId ? (()=>{
        const tr = companyTransfers.find(ct=>ct.id===t.companyTransferId);
        if(!tr) return '';
        return (tr.trainees||[]).map(x=>{
          const cl = clients.find(c=>c.clientId===x.clientId);
          return [x.clientId, cl?cl.name:''].join(' ');
        }).join(' ');
      })() : '';
      const hay = [t.clientName,t.clientId,t.manual,t.category,t.notes,companyTraineeInfo].join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0));
}
/* ---------------- ترتيب بالنقر على رأس العمود (حركات الخزنة/البنك/الشبكة) ---------------- */
let vaultSortState = { key: null, dir: 1 };
const VAULT_SORT_GETTERS = {
  who: t => ((t.type==='in' || t.isReturn) ? (t.clientName || t.manual || '') : (t.category||'')).toLowerCase(),
  seq: t => num(t.seq),
  date: t => t.date || '',
  clientId: t => (t.clientId||'').toLowerCase(),
  amount: t => num(t.amount),
};
function applyVaultColumnSort(rows){
  const getter = vaultSortState.key && VAULT_SORT_GETTERS[vaultSortState.key];
  if(!getter) return rows;
  return [...rows].sort((a,b)=>{
    const va = getter(a), vb = getter(b);
    if(typeof va === 'number' && typeof vb === 'number') return (va-vb)*vaultSortState.dir;
    return String(va).localeCompare(String(vb),'ar') * vaultSortState.dir;
  });
}
document.querySelectorAll('#view-vault thead th.sortable').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.sort;
    if(vaultSortState.key === key){ vaultSortState.dir *= -1; }
    else{ vaultSortState.key = key; vaultSortState.dir = 1; }
    document.querySelectorAll('#view-vault thead th.sortable').forEach(t=>t.setAttribute('aria-sort','none'));
    th.setAttribute('aria-sort', vaultSortState.dir===1 ? 'ascending' : 'descending');
    renderVault();
  });
});
/* دفعة نقدية معلّقة (سُجّلت من الاستقبال ولم يؤكد المسؤول عن الخزنة استلامها فعلياً بعد)
   لا تُحتسب ضمن رصيد الخزنة الفعلي حتى تتم تسويتها من "صندوق تسويات الاستقبال" */
/* ---------------- تعديل مباشر سريع (Inline Edit) للمبلغ والملاحظات ----------------
   متاح فقط للحركات العادية (ليست دفعة تسجيل تلقائية autoClientId، وليست قيد حوالة شركة موحّد
   companyTransferId لأنه يمثّل مجموع عدة متدربين) وغير واقعة ضمن فترة مقفلة. الهدف تسريع تصحيح
   خطأ بسيط في مبلغ أو ملاحظة دون فتح المودال الكامل، مع الحفاظ الكامل على نفس قواعد القفل
   المحاسبي والتراجع (Undo) والتدقيق (Audit Log) المستخدمة في مسار التعديل العادي. */
function vaultInlineEditable(t){
  return !t.autoClientId && !t.companyTransferId && !isDateLocked(t.date);
}
let _vaultInlineEditingCell = null;
function startVaultInlineEdit(td){
  if(_vaultInlineEditingCell) return; // تعديل واحد فقط في نفس اللحظة
  const id = td.dataset.inlineId;
  const field = td.dataset.inlineField;
  const t = vaultTx.find(x=>x.id===id);
  if(!t) return;
  if(isDateLocked(t.date)){ vaultLockToast(); return; }
  _vaultInlineEditingCell = td;
  const originalHtml = td.innerHTML;
  const currentVal = field==='amount' ? num(t.amount) : (t.notes||'');
  const input = document.createElement('input');
  input.type = field==='amount' ? 'number' : 'text';
  if(field==='amount'){ input.step = '0.01'; input.min = '0'; }
  input.value = currentVal;
  input.className = 'inline-edit-input';
  input.style.cssText = 'width:100%; box-sizing:border-box; font:inherit; padding:2px 4px;';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  const commit = async ()=>{
    if(_vaultInlineEditingCell!==td) return;
    _vaultInlineEditingCell = null;
    const rawVal = input.value;
    if(field==='amount'){
      const newAmount = num(rawVal);
      if(newAmount<=0){ showToast('أدخل مبلغاً صحيحاً أكبر من صفر'); renderVault(); return; }
      if(newAmount===num(t.amount)){ renderVault(); return; }
      snapshotState('تعديل سريع لمبلغ حركة مالية');
      const { history: _h, ...before } = t;
      t.amount = newAmount;
      const { history: _h2, ...after } = t;
      pushVaultTxHistory(t, before, after);
      await saveVaultTx();
      await logAudit('edit','الحركات المالية', `تعديل سريع للمبلغ في حركة رقم تسلسلي #${t.seq||'—'} إلى ${fmt(newAmount)}`);
      showToast('تم تحديث المبلغ');
    }else{
      const newNotes = rawVal.trim();
      if(newNotes===(t.notes||'')){ renderVault(); return; }
      snapshotState('تعديل سريع لملاحظة حركة مالية');
      const { history: _h, ...before } = t;
      t.notes = newNotes;
      const { history: _h2, ...after } = t;
      pushVaultTxHistory(t, before, after);
      await saveVaultTx();
      await logAudit('edit','الحركات المالية', `تعديل سريع لملاحظة حركة رقم تسلسلي #${t.seq||'—'}`);
      showToast('تم تحديث الملاحظة');
    }
    renderVault();
    if(typeof renderDashboard==='function') renderDashboard();
  };
  const cancel = ()=>{
    if(_vaultInlineEditingCell!==td) return;
    _vaultInlineEditingCell = null;
    td.innerHTML = originalHtml;
  };
  input.addEventListener('keydown', e=>{
    if(e.key==='Enter'){ e.preventDefault(); input.blur(); }
    else if(e.key==='Escape'){ e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit, { once:true });
}
$('#vault-table-body').addEventListener('dblclick', e=>{
  const td = e.target.closest('td[data-inline-field]');
  if(td) startVaultInlineEdit(td);
});
function vaultTxCountsTowardBalance(t){
  return !(t.autoClientId && (t.destination||'vault')==='vault' && t.settled===false);
}
/* ---------------- الرصيد المتوقع نهاية اليوم / نهاية الأسبوع ----------------
   تقدير بسيط (ليس تنبؤاً بالذكاء الاصطناعي): يحسب متوسط صافي الحركة اليومي (وارد فعلي - صادر)
   خلال آخر 30 يوماً فعلياً (بغض النظر عن أي فلتر حالي، لأن التوقع خاص بالرصيد الحقيقي للحساب)،
   ثم يسقط هذا المتوسط على الأيام المتبقية حتى نهاية اليوم ونهاية الأسبوع (السبت أساس الأسبوع).
   كلما زاد عدد الأيام التي فيها بيانات فعلية كلما كان المتوسط أدق. */
function projectedBalance(dest){
  const today = todayISO();
  const fromISO = addDaysISO(today, -30);
  const recent = vaultTx.filter(t=>(t.destination||'vault')===dest && t.date>=fromISO && t.date<=today && vaultTxCountsTowardBalance(t));
  if(!recent.length) return { current: balanceOf(dest), endOfDay: balanceOf(dest), endOfWeek: balanceOf(dest), daysOfData: 0 };
  const daysSet = new Set(recent.map(t=>t.date));
  const netTotal = recent.reduce((s,t)=> s + (t.type==='in' ? num(t.amount) : -num(t.amount)), 0);
  const avgDailyNet = netTotal / Math.max(1, daysSet.size);
  const current = balanceOf(dest);
  // باقي أيام الأسبوع حتى السبت (بداية الأسبوع في السعودية) — لو اليوم نفسه سبت، الأسبوع القادم
  const dow = new Date(today+'T00:00:00').getDay(); // 0=أحد...6=سبت
  const daysToWeekEnd = dow===6 ? 7 : (6-dow);
  return {
    current,
    endOfDay: current, // نفس الرصيد الحالي هو رصيد نهاية اليوم لأنه يشمل كل حركات اليوم المسجّلة فعلياً
    endOfWeek: Math.round((current + avgDailyNet*daysToWeekEnd)*100)/100,
    avgDailyNet: Math.round(avgDailyNet*100)/100,
    daysOfData: daysSet.size
  };
}
function balanceOf(dest){
  return vaultTx.filter(t=>(t.destination||'vault')===dest && t.type==='in' && vaultTxCountsTowardBalance(t)).reduce((s,t)=>s+num(t.amount),0)
       - vaultTx.filter(t=>(t.destination||'vault')===dest && t.type==='out').reduce((s,t)=>s+num(t.amount),0);
}
/* بطاقة الرصيد المتوقع للخزنة (كاش) — تقدير تقريبي وليس ضماناً، مبني على متوسط أداء الأيام الماضية فقط */
function renderProjectedBalanceCard(){
  const p = projectedBalance('vault');
  if(p.daysOfData < 3){
    return `<div class="card"><div class="k">الرصيد المتوقع (الخزنة كاش)</div><div class="v" style="font-size:14px; color:var(--text-muted);">بيانات غير كافية للتقدير (أقل من 3 أيام حركة مؤخراً)</div></div>`;
  }
  const trendIcon = p.avgDailyNet>=0 ? '📈' : '📉';
  return `<div class="card">
    <div class="k">الرصيد المتوقع (الخزنة كاش)</div>
    <div class="v ${p.endOfWeek<0?'red':''}">${fmt(p.endOfWeek)} <span style="font-size:12px; font-weight:400;">نهاية الأسبوع</span></div>
    <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${trendIcon} متوسط صافي يومي: ${fmt(p.avgDailyNet)} (بناءً على ${p.daysOfData} يوم من آخر 30 يوماً) — تقدير تقريبي وليس ضماناً</div>
  </div>`;
}
/* بطاقة ملخص الحركات غير المعتادة إحصائياً ضمن النتائج المفلترة حالياً */
function renderAnomalyCard(filteredRows){
  const anomalyIds = vaultAnomalyIds();
  const countInView = filteredRows.filter(t=>anomalyIds.has(t.id)).length;
  if(anomalyIds.size===0){
    return `<div class="card"><div class="k">حركات غير معتادة إحصائياً</div><div class="v teal" style="font-size:16px;">لا يوجد</div></div>`;
  }
  return `<div class="card">
    <div class="k">حركات غير معتادة إحصائياً</div>
    <div class="v ${countInView>0?'red':''}">${countInView} <span style="font-size:12px; font-weight:400;">ضمن العرض الحالي</span></div>
    <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">إجمالي كل السجل: ${anomalyIds.size} حركة — استخدم مربع "عرض الحركات غير المعتادة فقط" أعلى الجدول لعرضها</div>
  </div>`;
}
/* ---------------- رسم بياني: توقع التدفق النقدي القادم ----------------
   يرسم الرصيد الفعلي لآخر 21 يوماً (خط متصل) ثم يمدّه بخط متقطع لأيام السبعة القادمة بناءً
   على متوسط صافي الحركة اليومي لآخر 30 يوماً (نفس منطق projectedBalance أعلاه). رسم مخصص
   (وليس عبر drawLineChart المشترك) حتى نتحكم بشكل الخط المتقطع للجزء المتوقع دون التأثير
   على أي استخدام آخر لدالة drawLineChart في باقي شاشات البرنامج. */
function renderCashFlowForecastChart(dest){
  const el = $('#chart-cashflow-forecast');
  if(!el) return;
  const HIST_DAYS = 21, FUT_DAYS = 7;
  const today = todayISO();
  const histDates = [];
  for(let i=HIST_DAYS-1;i>=0;i--){ histDates.push(addDaysISO(today, -i)); }
  const netByDay = {};
  histDates.forEach(d=>netByDay[d]=0);
  vaultTx.forEach(t=>{
    if((t.destination||'vault')!==dest) return;
    if(!vaultTxCountsTowardBalance(t)) return;
    if(!(t.date in netByDay)) return;
    netByDay[t.date] += (t.type==='in' ? num(t.amount) : -num(t.amount));
  });
  const currentBal = balanceOf(dest);
  const histBalances = new Array(histDates.length);
  histBalances[histDates.length-1] = currentBal;
  for(let i=histDates.length-2;i>=0;i--) histBalances[i] = histBalances[i+1] - netByDay[histDates[i+1]];

  const p = projectedBalance(dest);
  const futDates = [];
  const futBalances = [];
  let running = currentBal;
  for(let i=1;i<=FUT_DAYS;i++){
    futDates.push(addDaysISO(today, i));
    running += (p.avgDailyNet||0);
    futBalances.push(Math.round(running*100)/100);
  }
  if(p.daysOfData < 3){
    el.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">بيانات غير كافية لعرض توقع موثوق (أقل من 3 أيام حركة مؤخراً)</div>';
    return;
  }

  const allLabels = [...histDates, ...futDates];
  const allValues = [...histBalances, ...futBalances];
  const W = 900, H = 260, padL = 65, padR = 20, padT = 16, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  let max = Math.max(...allValues, 0), min = Math.min(...allValues, 0);
  if(max===min) max = min + 1;
  const n = allLabels.length;
  const xStep = n>1 ? innerW/(n-1) : 0;
  const yScale = v => padT + innerH - ((v-min)/(max-min))*innerH;
  const xScale = i => padL + i*xStep;
  const gridLines = 4;
  let gridsHtml = '';
  for(let g=0; g<=gridLines; g++){
    const v = min + (max-min)*g/gridLines;
    const y = yScale(v);
    gridsHtml += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W-padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`;
    gridsHtml += `<text x="${padL-8}" y="${(y+4).toFixed(1)}" font-size="10" fill="var(--text-muted)" text-anchor="end">${fmt(Math.round(v))}</text>`;
  }
  // خط الرصيد الفعلي (من 0 حتى نقطة اليوم الحالي، وهي نفس نقطة بداية الخط المتقطع)
  const histPts = histBalances.map((v,i)=>`${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
  // خط التوقع المتقطع (يبدأ من نقطة اليوم الحالي نفسها لضمان الاتصال البصري بين الخطين)
  const futPtsArr = [`${xScale(histDates.length-1).toFixed(1)},${yScale(currentBal).toFixed(1)}`, ...futBalances.map((v,i)=>`${xScale(histDates.length+i).toFixed(1)},${yScale(v).toFixed(1)}`)];
  const futPts = futPtsArr.join(' ');
  const showEvery = n>10 ? Math.ceil(n/10) : 1;
  const labelsHtml = allLabels.map((l,i)=> i%showEvery===0 ? `<text x="${xScale(i).toFixed(1)}" y="${H-6}" font-size="10" fill="var(--text-muted)" text-anchor="middle">${escapeHtml(l.slice(5))}</text>` : '').join('');
  el.innerHTML = `
    <div style="margin-bottom:10px;">
      <span style="display:inline-flex; align-items:center; gap:5px; margin-left:16px; font-size:12px; color:var(--text-muted);"><span style="width:16px; height:2.5px; background:var(--teal); display:inline-block;"></span>فعلي</span>
      <span style="display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--text-muted);"><span style="width:16px; height:2.5px; background:var(--gold-dark); display:inline-block; border-top:2px dashed var(--gold-dark);"></span>متوقع (تقريبي)</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; max-height:260px; display:block;">
      ${gridsHtml}
      <polyline points="${histPts}" fill="none" stroke="var(--teal)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <polyline points="${futPts}" fill="none" stroke="var(--gold-dark)" stroke-width="2.5" stroke-dasharray="6 4" stroke-linejoin="round" stroke-linecap="round"/>
      ${labelsHtml}
    </svg>`;
}
/* ---------------- لمحة سريعة: الفعلي مقابل الموازنة للشهر الحالي داخل شيت الحركات المالية ----------------
   يعتمد بالكامل على بيانات شاشة الموازنة التقديرية (EPM) الموجودة أصلاً في module-accounting.js
   (budgetEntries, actualForLineMonth) بدل تكرار المنطق، فيبقى الرقمان متطابقين دائماً بين الشاشتين. */
function renderVaultBudgetGlance(){
  const el = $('#vault-budget-glance-cards');
  if(!el) return;
  if(typeof budgetLineSources!=='function' || typeof actualForLineMonth!=='function'){
    el.innerHTML = `<div class="card"><div class="k">الموازنة التقديرية</div><div class="v" style="font-size:13px; color:var(--text-muted);">غير متاحة حالياً</div></div>`;
    return;
  }
  const now = new Date();
  const year = now.getFullYear(), monthIdx = now.getMonth();
  const sources = budgetLineSources();
  let budgetExp = 0, actualExp = 0, budgetRev = 0, actualRev = 0;
  sources.expense.forEach(key=>{
    const entry = getBudgetEntry(year, 'expense', key);
    budgetExp += entry ? num(entry.months[monthIdx]) : 0;
    actualExp += actualForLineMonth('expense', key, year, monthIdx);
  });
  sources.revenue.forEach(key=>{
    const entry = getBudgetEntry(year, 'revenue', key);
    budgetRev += entry ? num(entry.months[monthIdx]) : 0;
    actualRev += actualForLineMonth('revenue', key, year, monthIdx);
  });
  const expPct = budgetExp!==0 ? (actualExp/budgetExp*100) : (actualExp>0 ? null : 0);
  const revPct = budgetRev!==0 ? (actualRev/budgetRev*100) : (actualRev>0 ? null : 0);
  el.innerHTML = `
    <div class="card"><div class="k">نسبة تنفيذ المصروفات المخططة (هذا الشهر)</div><div class="v ${expPct!==null && expPct>100?'red':'gold'}">${expPct===null?'—':fmt(expPct)+'%'}</div><div style="font-size:11px; color:var(--text-muted); margin-top:4px;">فعلي ${fmt(actualExp)} / مخطط ${fmt(budgetExp)}</div></div>
    <div class="card"><div class="k">نسبة تحقيق الإيرادات المخططة (هذا الشهر)</div><div class="v teal">${revPct===null?'—':fmt(revPct)+'%'}</div><div style="font-size:11px; color:var(--text-muted); margin-top:4px;">فعلي ${fmt(actualRev)} / مخطط ${fmt(budgetRev)}</div></div>
  `;
}
/* ================= المرحلة 3: الحركات المتكررة والمجدولة تلقائياً ================= */
/* ---------------- اكتشاف الأنماط المتكررة تلقائياً ----------------
   يبحث في تاريخ الحركات "الصادرة" عن مجموعات بنفس التصنيف + نفس اسم المستلم، تكرّرت 3 مرات
   على الأقل بفارق زمني قريب من شهر (25-35 يوماً) بين كل حركة والتي تليها، وتذبذب المبلغ بينها
   محدود (لا يتجاوز 20% عن المتوسط). هذه مجرد اقتراحات للمستخدم ليقرر تحويلها لقالب مجدول أو
   تجاهلها — لا تُنشئ أي حركة أو تغيير تلقائي بحد ذاتها. */
function detectRecurringVaultPatterns(){
  const byKey = {};
  vaultTx.forEach(t=>{
    if(t.type!=='out' || !t.category || !t.recipientName) return;
    const key = t.category+'|||'+t.recipientName;
    (byKey[key] = byKey[key]||[]).push(t);
  });
  const suggestions = [];
  Object.entries(byKey).forEach(([key, list])=>{
    if(list.length < 3) return;
    const sorted = [...list].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    const gaps = [];
    for(let i=1;i<sorted.length;i++){
      const d1 = new Date(sorted[i-1].date), d2 = new Date(sorted[i].date);
      if(isNaN(d1)||isNaN(d2)) continue;
      gaps.push((d2-d1)/86400000);
    }
    const monthlyGaps = gaps.filter(g=>g>=25 && g<=35);
    if(monthlyGaps.length < Math.max(2, Math.ceil((sorted.length-1)*0.6))) return; // معظم الفجوات شهرية تقريباً
    const amounts = sorted.map(t=>num(t.amount));
    const avgAmount = amounts.reduce((a,b)=>a+b,0)/amounts.length;
    if(avgAmount<=0) return;
    const withinTolerance = amounts.every(a=> Math.abs(a-avgAmount)/avgAmount <= 0.2);
    if(!withinTolerance) return;
    const [category, recipientName] = key.split('|||');
    const last = sorted[sorted.length-1];
    suggestions.push({ category, recipientName, avgAmount: Math.round(avgAmount*100)/100, occurrences: sorted.length, lastDate: last.date, lastMethod: last.method, lastDestination: last.destination||'vault' });
  });
  return suggestions.sort((a,b)=>b.occurrences-a.occurrences);
}
function renderRecurringSuggestions(){
  const el = $('#vault-recurring-suggestions');
  if(!el) return;
  const suggestions = detectRecurringVaultPatterns();
  // لا تُقترَح الأنماط التي لها بالفعل قالب مجدول مطابق (نفس التصنيف والمستلم)
  const existingKeys = new Set(scheduledVaultTx.map(s=> s.category+'|||'+s.recipientName));
  const filtered = suggestions.filter(s=> !existingKeys.has(s.category+'|||'+s.recipientName));
  if(!filtered.length){
    el.innerHTML = `<div class="hint" style="color:var(--text-muted); font-size:13px;">لا توجد أنماط متكررة مكتشفة حالياً (يحتاج 3 حركات متتالية على الأقل بفارق شهري تقريباً ومبلغ متقارب)</div>`;
    return;
  }
  el.innerHTML = filtered.map(s=>`
    <div class="computed" style="margin-bottom:8px; display:flex; flex-wrap:wrap; align-items:center; gap:10px;">
      <span>🔁 <b>${escapeHtml(s.category)}</b> — ${escapeHtml(s.recipientName)}</span>
      <span class="mono">~${fmt(s.avgAmount)}</span>
      <span style="font-size:12px; color:var(--text-muted);">تكررت ${s.occurrences} مرات، آخرها ${escapeHtml(s.lastDate||'—')}</span>
      <button type="button" class="btn btn-gold btn-sm" data-scheduletemplate="${encodeURIComponent(JSON.stringify(s))}">تحويل لقالب مجدول</button>
    </div>`).join('');
}
document.addEventListener('click', e=>{
  const raw = e.target?.dataset?.scheduletemplate;
  if(!raw) return;
  const s = JSON.parse(decodeURIComponent(raw));
  openScheduleModal(null, s);
});

/* ---------------- قوالب الحركات المجدولة (CRUD) ---------------- */
let editingScheduleId = null;
function renderScheduledVaultTable(){
  const body = $('#scheduled-vault-body');
  if(!body) return;
  body.innerHTML = scheduledVaultTx.map(s=>`
    <tr>
      <td>${escapeHtml(s.recipientName||'—')}</td>
      <td>${escapeHtml(s.category||'—')}</td>
      <td class="mono">${fmt(num(s.amount))}</td>
      <td>${escapeHtml(destLabel(s.destination||'vault'))}</td>
      <td class="mono">${s.dayOfMonth}</td>
      <td><span class="stamp ${s.active!==false?'paid':'owe'}">${s.active!==false?'نشط':'متوقف'}</span></td>
      <td style="white-space:nowrap;">
        <button type="button" class="btn btn-ghost btn-sm" data-schedtoggle="${s.id}">${s.active!==false?'إيقاف':'تفعيل'}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-schededit="${s.id}">${tr('edit')}</button>
        <button type="button" class="btn btn-danger btn-sm" data-scheddel="${s.id}">${tr('delete')}</button>
      </td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد قوالب مجدولة بعد</td></tr>`;
}
function openScheduleModal(id, prefill){
  editingScheduleId = id || null;
  const s = id ? scheduledVaultTx.find(x=>x.id===id) : null;
  $('#sched-modal-title').textContent = id ? 'تعديل قالب مجدول' : 'قالب حركة مجدولة جديدة';
  populateSelect($('#sched-category'), settings.expenseCategories, false);
  $('#sched-recipient').value = s?.recipientName || prefill?.recipientName || '';
  $('#sched-category').value = s?.category || prefill?.category || '';
  $('#sched-amount').value = s?.amount ?? prefill?.avgAmount ?? '';
  populateSelect($('#sched-method'), settings.channels.map(c=>c.name), false);
  $('#sched-method').value = s?.method || prefill?.lastMethod || settings.channels[0]?.name || '';
  $('#sched-destination').value = s?.destination || prefill?.lastDestination || 'vault';
  $('#sched-day').value = s?.dayOfMonth || 1;
  $('#sched-notes').value = s?.notes || '';
  $('#sched-active').checked = s ? s.active!==false : true;
  $('#schedule-overlay').classList.add('show'); SoundFX.open();
}
$('#btn-add-schedule')?.addEventListener('click', ()=>openScheduleModal(null));
$('#sched-cancel')?.addEventListener('click', ()=>{ $('#schedule-overlay').classList.remove('show'); editingScheduleId=null; });
$('#schedule-overlay')?.addEventListener('click', e=>{ if(e.target.id==='schedule-overlay'){ $('#schedule-overlay').classList.remove('show'); editingScheduleId=null; } });
$('#schedule-form')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const recipientName = $('#sched-recipient').value.trim();
  const category = $('#sched-category').value;
  const amount = num($('#sched-amount').value);
  const dayOfMonth = Math.min(28, Math.max(1, parseInt($('#sched-day').value,10)||1));
  if(!recipientName){ showToast('أدخل اسم المستلم / البيان'); return; }
  if(!category){ showToast('اختر تصنيف المصروف'); return; }
  if(amount<=0){ showToast('أدخل مبلغاً صحيحاً'); return; }
  const data = {
    recipientName, category, amount, dayOfMonth,
    method: $('#sched-method').value,
    destination: $('#sched-destination').value,
    notes: $('#sched-notes').value.trim(),
    active: $('#sched-active').checked
  };
  if(editingScheduleId){
    const idx = scheduledVaultTx.findIndex(x=>x.id===editingScheduleId);
    scheduledVaultTx[idx] = {...scheduledVaultTx[idx], ...data};
    await logAudit('edit','الحركات المالية', `تعديل قالب حركة مجدولة: ${recipientName} (${fmt(amount)} شهرياً يوم ${dayOfMonth})`);
  }else{
    scheduledVaultTx.push({ id:uid(), createdAt:Date.now(), lastRunMonth:null, ...data });
    await logAudit('add','الحركات المالية', `إضافة قالب حركة مجدولة جديد: ${recipientName} (${fmt(amount)} شهرياً يوم ${dayOfMonth})`);
  }
  await saveScheduledVaultTx();
  $('#schedule-overlay').classList.remove('show'); editingScheduleId=null;
  renderScheduledVaultTable();
  renderRecurringSuggestions();
  showToast('تم حفظ القالب المجدول');
});
document.addEventListener('click', async e=>{
  const toggleId = e.target?.dataset?.schedtoggle;
  const editId = e.target?.dataset?.schededit;
  const delId = e.target?.dataset?.scheddel;
  if(toggleId){
    const s = scheduledVaultTx.find(x=>x.id===toggleId);
    if(s){ s.active = s.active===false; await saveScheduledVaultTx(); renderScheduledVaultTable(); }
  }
  if(editId) openScheduleModal(editId);
  if(delId){
    if(!await customConfirm('حذف هذا القالب المجدول نهائياً؟ لن يؤثر على أي حركات سابقة أُنشئت منه.')) return;
    scheduledVaultTx = scheduledVaultTx.filter(x=>x.id!==delId);
    await saveScheduledVaultTx();
    await logAudit('delete','الحركات المالية', `حذف قالب حركة مجدولة`);
    renderScheduledVaultTable();
  }
});
/* ---------------- تنفيذ الحركات المجدولة المستحقة ----------------
   تُفحص كل القوالب النشطة عند كل تحميل/عرض لشيت الحركات المالية: لو وصل يوم الشهر المحدد
   ولم تُنفَّذ هذه القالب بعد لهذا الشهر تحديداً (lastRunMonth)، تُنشأ حركة خزنة فعلية تلقائياً
   بنفس بيانات القالب مع تسجيلها في سجل التدقيق وسجل التراجع (Undo) تماماً كأي حركة يدوية،
   وتُحترَم فترة القفل المحاسبي (لو الشهر مقفل، لا تُنشأ الحركة وتبقى مستحقة لحين فتح القفل). */
let _dueScheduleRunPromise = null;
async function runDueScheduledVaultTx(){
  // single-flight: renderVault تُستدعى من عشرات الأماكن وكل استدعاء يشغّل هذه الدالة (وقائمة
  // renderAllViewsAfterLoad تستدعيها مع أنشطة أخرى متزامنة). بدون حارس، استدعاءان متزامنان
  // عند أول يوم من الشهر كانا يقرآن lastRunMonth قبل تحديثه ويُنشئان نفس الحركة المجدولة مرتين
  // (نسخة مكررة بمبلغ مضاعف في الخزنة ودفاتر المحاسبة). أي استدعاء أثناء تشغيل سابق ينتظر نفس
  // النتيجة بدل تكرار الفحص/الإنشاء.
  if(_dueScheduleRunPromise) return _dueScheduleRunPromise;
  _dueScheduleRunPromise = (async()=>{
    const today = todayISO();
    const [ny, nm] = today.split('-');
    const currentMonthKey = `${ny}-${nm}`;
    const todayDay = parseInt(today.split('-')[2],10);
    let anyRun = false;
    for(const s of scheduledVaultTx){
      if(s.active===false) continue;
      if(s.lastRunMonth===currentMonthKey) continue;
      if(todayDay < num(s.dayOfMonth)) continue;
      if(isDateLocked(today)) continue; // الشهر مقفل — تبقى مستحقة لحين فتح القفل، لا تُفقد
      snapshotState(`تنفيذ حركة مجدولة تلقائية: ${s.recipientName}`);
      const savedTx = {
        id: uid(), seq: allocVaultSeq(s.destination||'vault'), createdAt: Date.now(),
        type: 'out', isReturn: false, date: today, amount: num(s.amount),
        method: s.method, notes: (s.notes ? s.notes+' — ' : '') + 'حركة مجدولة تلقائية',
        clientId: '', clientName: '', manual: '', category: s.category,
        recipientName: s.recipientName, referenceNo: 'مجدولة تلقائياً',
        destination: s.destination||'vault', networkInvoice: ''
      };
      vaultTx.push(savedTx);
      await saveSettings();
      s.lastRunMonth = currentMonthKey;
      anyRun = true;
      await logAudit('add','الحركات المالية', `تنفيذ تلقائي لقالب مجدول رقم تسلسلي #${savedTx.seq||'—'}: ${s.recipientName} بمبلغ ${fmt(num(s.amount))}`);
    }
    if(anyRun){
      await saveVaultTx();
      await saveScheduledVaultTx();
      showToast('تم تنفيذ حركة/حركات مجدولة مستحقة تلقائياً — راجعها في الجدول أدناه');
    }
    return anyRun;
  })().finally(()=>{ _dueScheduleRunPromise = null; });
  return _dueScheduleRunPromise;
}
$('#btn-run-due-schedules')?.addEventListener('click', async ()=>{
  const ran = await runDueScheduledVaultTx();
  if(!ran) showToast('لا توجد حركات مجدولة مستحقة الآن');
  renderVault();
});

function seqNumbers(){
  const map = {};
  ['vault','bank','network'].forEach(dest=>{
    const list = vaultTx.filter(t=>(t.destination||'vault')===dest)
      .sort((a,b)=> (a.date||'').localeCompare(b.date||'') || (a.createdAt||0)-(b.createdAt||0));
    list.forEach((t,i)=>{ map[t.id] = i+1; });
  });
  return map;
}
let vaultCurrentPage = 1;
let vaultLastFilterSig = '';
let selectedVaultIds = new Set();
let currentPageVaultIds = [];
function currentVaultPageSize(){
  const v = $('#vault-page-size')?.value || '100';
  return v==='all' ? Infinity : Number(v);
}
function renderVault(){
  renderVaultLockStatus();
  if(typeof renderBankRecon==='function') renderBankRecon();
  if(typeof populateReceptionFilterSelects==='function') populateReceptionFilterSelects();
  populateSelect($('#vf-category'), settings.expenseCategories, false);
  runDueScheduledVaultTx().then(ran=>{ if(ran) renderVault(); });
  renderRecurringSuggestions();
  renderScheduledVaultTable();
  const dl = $('#dl-clients');
  dl.innerHTML = clients.filter(c=>c.clientId).map(c=>`<option value="${escapeHtml(c.clientId)}" label="${escapeHtml(c.name)}"></option>`).join('');

  const rows = applyVaultColumnSort(vaultFilteredRows());
  const periodIn = rows.filter(t=>t.type==='in' && vaultTxCountsTowardBalance(t)).reduce((s,t)=>s+num(t.amount),0);
  const periodOut = rows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const netOfDestFiltered = dest => rows.filter(t=>(t.destination||'vault')===dest)
    .reduce((s,t)=> s + (t.type==='in' ? (vaultTxCountsTowardBalance(t) ? num(t.amount) : 0) : -num(t.amount)), 0);

  $('#vault-cards').innerHTML = `
    <div class="card"><div class="k">الخزنة (كاش) — حسب الفلتر الحالي</div><div class="v ${netOfDestFiltered('vault')<0?'red':''}">${fmt(netOfDestFiltered('vault'))}</div><div style="font-size:11px; color:var(--text-muted); margin-top:4px;">الرصيد الفعلي الكلي (بدون فلتر): ${fmt(balanceOf('vault'))}</div></div>
    <div class="card"><div class="k">البنك — حسب الفلتر الحالي</div><div class="v ${netOfDestFiltered('bank')<0?'red':'teal'}">${fmt(netOfDestFiltered('bank'))}</div><div style="font-size:11px; color:var(--text-muted); margin-top:4px;">الرصيد الفعلي الكلي (بدون فلتر): ${fmt(balanceOf('bank'))}</div></div>
    <div class="card"><div class="k">الشبكة — حسب الفلتر الحالي</div><div class="v ${netOfDestFiltered('network')<0?'red':'gold'}">${fmt(netOfDestFiltered('network'))}</div><div style="font-size:11px; color:var(--text-muted); margin-top:4px;">الرصيد الفعلي الكلي (بدون فلتر): ${fmt(balanceOf('network'))}</div></div>
    <div class="card"><div class="k">صافي الفترة المحددة (كل الحسابات المفلترة)</div><div class="v">${fmt(periodIn-periodOut)}</div></div>
    ${renderProjectedBalanceCard()}
    ${renderAnomalyCard(rows)}
  `;

  $('#vault-empty').style.display = rows.length ? 'none' : 'block';

  // إعادة الصفحة إلى الأولى تلقائياً كلما تغيّر البحث أو أي فلتر (وليس عند التنقّل بين الصفحات فقط)
  const vaultFilterSig = JSON.stringify([
    $('#v-from')?.value, $('#v-to')?.value, $('#v-filter-type')?.value, $('#v-filter-dest')?.value,
    $('#v-search')?.value, $('#v-filter-dup')?.checked, $('#v-filter-nomethod')?.checked, $('#v-filter-anomaly')?.checked
  ]);
  if(vaultFilterSig !== vaultLastFilterSig){ vaultCurrentPage = 1; vaultLastFilterSig = vaultFilterSig; }

  const vPageSize = currentVaultPageSize();
  const vTotalPages = Number.isFinite(vPageSize) ? Math.max(1, Math.ceil(rows.length/vPageSize)) : 1;
  if(vaultCurrentPage > vTotalPages) vaultCurrentPage = vTotalPages;
  if(vaultCurrentPage < 1) vaultCurrentPage = 1;
  const pageRows = Number.isFinite(vPageSize) ? rows.slice((vaultCurrentPage-1)*vPageSize, vaultCurrentPage*vPageSize) : rows;
  currentPageVaultIds = pageRows.map(t=>t.id);
  // نحذف من التحديد أي حركة لم تعد موجودة أصلاً (أُلغيت من مكان آخر)، حتى لا يبقى تحديد "شبح"
  const allVaultTxIds = new Set(vaultTx.map(t=>t.id));
  [...selectedVaultIds].forEach(id=>{ if(!allVaultTxIds.has(id)) selectedVaultIds.delete(id); });
  renderVaultBulkBar(rows);

  const vPag = $('#vault-table-pagination');
  if(vPag){
    vPag.style.display = rows.length ? '' : 'none';
    const vStartN = rows.length ? (vaultCurrentPage-1)*(Number.isFinite(vPageSize)?vPageSize:rows.length)+1 : 0;
    const vEndN = Number.isFinite(vPageSize) ? Math.min(rows.length, vaultCurrentPage*vPageSize) : rows.length;
    $('#vault-page-info').textContent = rows.length ? `عرض ${vStartN} - ${vEndN} من ${rows.length}` : '';
    $('#vault-page-current').textContent = `صفحة ${vaultCurrentPage} / ${vTotalPages}`;
    $('#vault-page-first').disabled = vaultCurrentPage<=1;
    $('#vault-page-prev').disabled = vaultCurrentPage<=1;
    $('#vault-page-next').disabled = vaultCurrentPage>=vTotalPages;
    $('#vault-page-last').disabled = vaultCurrentPage>=vTotalPages;
  }

  const seq = seqNumbers();
  const dupIdsForHighlight = vaultDuplicateClientIds();
  const anomalyIdsForHighlight = vaultAnomalyIds();
  $('#vault-table-body').innerHTML = pageRows.map(t=>{
    const isDup = !!(t.clientId && dupIdsForHighlight.has(t.clientId));
    const isAnomaly = anomalyIdsForHighlight.has(t.id);
    const vMeta = (typeof recordMeta==='object' && recordMeta && recordMeta.vaultTx) ? recordMeta.vaultTx[t.id] : null;
    const isVPending = !!(vMeta && vMeta.status==='pending');
    const vApproveBtns = (isVPending && currentUserRole==='admin')
      ? ` <button class="btn btn-gold btn-sm" data-vapprove="${t.id}" title="اعتماد هذه العملية لتدخل في الرصيد والحسابات والتقارير كباقي الحركات">✅ اعتماد</button><button class="btn btn-danger btn-sm" data-vreject="${t.id}" title="رفض وحذف هذا التسجيل المعلّق نهائياً">✖ رفض</button>`
      : '';
    return `
    <tr>
      <td class="sticky-col sticky-col-1" data-label=""><input type="checkbox" class="row-select-vault" data-id="${t.id}" ${selectedVaultIds.has(t.id)?'checked':''}></td>
      <td class="sticky-col sticky-col-2" data-label="العميل / البيان">${escapeHtml((t.type==='in' || t.isReturn) ? (t.clientName || t.manual || '—') : (t.category||'—'))}</td>
      <td class="mono" style="font-weight:700;" data-label="الرقم التسلسلي">#${t.seq||'—'}</td>
      <td class="mono" data-label="الرقم">${destLabel(t.destination||'vault').split(' ')[0]}-${seq[t.id]||'—'}</td>
      <td class="mono" data-label="التاريخ">${t.date||'—'}</td>
      <td data-label="الحساب"><span class="stamp paid">${destLabel(t.destination||'vault')}</span></td>
      <td data-label="النوع"><span class="stamp ${t.type==='in'?'paid':'owe'}">${t.type==='in'?'وارد':(t.isReturn?'مردود مبيعات':'صادر')}</span></td>
      <td class="mono" data-label="رقم الهوية"${isDup?' style="color:var(--red); font-weight:700;" title="رقم هوية مكرر — ظهر أكثر من مرة في حركات الخزنة/البنك/الشبكة"':''}>${escapeHtml(t.clientId||'—')}${isDup?' ⚠️':''}</td>
      <td data-label="التصنيف">${escapeHtml(t.type==='out' ? (t.category||'—') : '—')}${(t.type==='out' && t.referenceNo) ? `<br><span style="font-size:11px; color:var(--text-muted);">مستند: ${escapeHtml(t.referenceNo)}</span>` : ''}</td>
      <td data-label="طريقة الدفع">${escapeHtml(t.method||'')}</td>
      <td class="mono" data-label="رقم فاتورة الشبكة">${escapeHtml(t.networkInvoice||'—')}</td>
      <td class="mono${vaultInlineEditable(t)?' editable-cell':''}" data-label="المبلغ"${vaultInlineEditable(t)?` data-inline-field="amount" data-inline-id="${t.id}" title="انقر مرتين للتعديل السريع"`:''}>${fmt(num(t.amount))}${!vaultTxCountsTowardBalance(t) ? ` <span class="stamp owe" title="لم تُسوَّ بعد — لا تُحتسب ضمن رصيد الخزنة حتى تُسوَّى من صندوق تسويات الاستقبال">معلّق</span>` : ''}${isVPending ? ` <span class="stamp owe" title="سجّلها الاستقبال — بانتظار اعتماد الأدمن، لا تدخل رصيد/حسابات/تقارير الأدوار الأخرى حتى الاعتماد">⏳ قيد الاعتماد</span>` : ''}${isAnomaly ? ` <span class="stamp owe" title="مبلغ غير معتاد إحصائياً مقارنة بمتوسط هذا التصنيف — يستحق المراجعة">⚠️ غير معتاد</span>` : ''}</td>
      <td class="${vaultInlineEditable(t)?'editable-cell':''}" data-label="ملاحظات"${vaultInlineEditable(t)?` data-inline-field="notes" data-inline-id="${t.id}" title="انقر مرتين للتعديل السريع"`:''}>${escapeHtml(t.notes||'')}</td>
      <td class="card-full" data-label="" style="white-space:nowrap;">
        ${(t.type==='in' && t.autoClientId) ? `<span class="hint" style="margin:0; display:inline-block; font-size:11px;">🔗 دفعة تسجيل — التعديل من شيت العملاء</span>${vApproveBtns}` : (t.type==='in' && t.companyTransferId) ? `
        <button type="button" class="btn btn-gold btn-sm" data-viewcompanytransfer="${t.companyTransferId}">👥 تفاصيل المتدربين</button>` : `
        <div class="row-menu">
          <button type="button" class="btn btn-ghost btn-sm row-menu-toggle" title="إجراءات" aria-haspopup="true" aria-expanded="false">⋮</button>
          <div class="row-menu-panel" role="menu">
            <button class="btn btn-ghost btn-sm" data-vedit="${t.id}">${tr('edit')}</button>
            ${t.isReturn ? `<button class="btn btn-gold btn-sm" data-vprintreturn="${t.id}">طباعة فاتورة الاسترجاع</button>` : ''}
            ${(t.type==='out' && !t.isReturn) ? `<button class="btn btn-gold btn-sm" data-vvoucher="${t.id}">طباعة سند صرف</button>` : ''}
            ${vApproveBtns}
            <button class="btn btn-danger btn-sm" data-vdel="${t.id}">${tr('delete')}</button>
          </div>
        </div>`}
      </td>
    </tr>`;
  }).join('');


  const catTotals = {};
  rows.filter(t=>t.type==='out').forEach(t=>{ const k=t.category||'أخرى'; catTotals[k]=(catTotals[k]||0)+num(t.amount); });
  drawBars('#chart-expense-cat', Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]));

  const dailyTrend = vaultFilteredDailyTrend(rows);
  drawLineChart('#chart-vault-daily', dailyTrend.labels, dailyTrend.series);
  drawBars('#chart-vault-method', vaultFilteredMethodTotals(rows));

  ensureDenomUiBuilt();
  recalcDenomTable();
  renderDenomHistory();
  renderCashFlowForecastChart('vault');
  renderVaultBudgetGlance();
}

/* ---------------- تصنيف الفئات النقدية بالخزنة (سجل حركات دخول/خروج) ----------------
   رصيد كل فئة نقدية = مجموع كل حركات "دخول" ناقص مجموع كل حركات "خروج" لتلك الفئة
   من سجل vaultDenomTx (يشمل أيضاً حركات "تسوية جرد" التي تُنشأ تلقائياً عند تصحيح
   الرصيد من واقع عدّ فعلي). هذا سجل منفصل تماماً عن الحركات المالية ولا يدخل ضمن
   أي رصيد محاسبي — فقط لمتابعة تركيبة النقد الموجود فعلياً بالخزنة والمقارنة
   بإجمالي رصيد "الخزنة (كاش)" الفعلي (balanceOf('vault')). */
const CASH_DENOMINATIONS = [500,200,100,50,20,10,5,2,1,0.5];
function denomBalance(denom){
  return vaultDenomTx.filter(t=>Number(t.denom)===denom && t.type==='in').reduce((s,t)=>s+num(t.count),0)
       - vaultDenomTx.filter(t=>Number(t.denom)===denom && t.type==='out').reduce((s,t)=>s+num(t.count),0);
}
function ensureDenomUiBuilt(){
  const headerRow = $('#cash-count-header-row');
  if(!headerRow || headerRow.dataset.built) return;
  headerRow.dataset.built = '1';
  headerRow.insertAdjacentHTML('beforeend', CASH_DENOMINATIONS.map(d=>`<th class="mono">${fmt(d)} ﷼</th>`).join(''));
  const countRow = $('#cash-count-row-count');
  if(countRow) countRow.insertAdjacentHTML('beforeend', CASH_DENOMINATIONS.map(d=>`<td class="mono" data-denom-count="${d}">0</td>`).join(''));
  const valueRow = $('#cash-count-row-value');
  if(valueRow) valueRow.insertAdjacentHTML('beforeend', CASH_DENOMINATIONS.map(d=>`<td class="mono" data-denom-value="${d}">0</td>`).join(''));
  const grandTotalCell = $('#cash-count-grand-total');
  if(grandTotalCell) grandTotalCell.setAttribute('colspan', CASH_DENOMINATIONS.length);
  const batchHeaderRow = $('#denom-tx-batch-header');
  if(batchHeaderRow) batchHeaderRow.insertAdjacentHTML('beforeend', CASH_DENOMINATIONS.map(d=>`<th class="mono">${fmt(d)} ﷼</th>`).join(''));
  if($('#denom-tx-batch-body')) $('#denom-tx-batch-body').insertAdjacentHTML('beforeend', CASH_DENOMINATIONS.map(d=>`<td><input type="number" min="0" step="1" data-batch-denom-count="${d}" placeholder="0" style="max-width:80px;"></td>`).join(''));
  if($('#denom-tx-date') && !$('#denom-tx-date').value) $('#denom-tx-date').value = todayISO();
  $('#btn-denom-tx-save')?.addEventListener('click', saveDenomTx);
}
function recalcDenomTable(){
  let total = 0;
  CASH_DENOMINATIONS.forEach(d=>{
    const count = denomBalance(d);
    const value = count*d;
    total += value;
    const countEl = document.querySelector(`[data-denom-count="${d}"]`);
    const valueEl = document.querySelector(`[data-denom-value="${d}"]`);
    if(countEl) countEl.textContent = fmt(count);
    if(valueEl) valueEl.textContent = fmt(value);
  });
  if($('#cash-count-grand-total')) $('#cash-count-grand-total').textContent = fmt(total);
  const vaultBalance = balanceOf('vault');
  const diff = total - vaultBalance;
  const matched = Math.abs(diff) < 0.005;
  const diffColor = matched ? 'var(--teal)' : 'var(--red)';
  const compareEl = $('#cash-count-compare');
  if(compareEl){
    compareEl.innerHTML = `
      <span>رصيد الخزنة (كاش) الفعلي حسب الحركات المالية: <b class="mono">${fmt(vaultBalance)} ﷼</b></span>
      <span>إجمالي تصنيف الفئات الحالي: <b class="mono">${fmt(total)} ﷼</b></span>
      <span>الفرق: <b class="mono" style="color:${diffColor};">${fmt(diff)} ﷼</b> ${matched ? '✓ مطابق' : (diff>0?'(الفئات المسجّلة أكثر من رصيد الخزنة)':'(الفئات المسجّلة أقل من رصيد الخزنة)')}</span>
    `;
  }
  return total;
}
async function saveDenomTx(){
  const type = $('#denom-tx-type')?.value || 'in';
  const date = $('#denom-tx-date')?.value || todayISO();
  const notes = $('#denom-tx-notes')?.value.trim() || '';
  const lines = CASH_DENOMINATIONS.map(d=>{
    const el = document.querySelector(`[data-batch-denom-count="${d}"]`);
    const count = Math.floor(num(el?.value));
    return { denom: d, count };
  }).filter(l=>l.count>0);
  if(!lines.length){
    showToast('أدخل عدداً أكبر من صفر لفئة واحدة على الأقل');
    return;
  }
  const shortages = lines.filter(l=>type==='out' && denomBalance(l.denom) < l.count);
  if(shortages.length){
    const msg = shortages.map(l=>`فئة ${fmt(l.denom)} ﷼ (الرصيد الحالي ${fmt(denomBalance(l.denom))})`).join('، ');
    if(!await customConfirm(`الفئات التالية سيصبح رصيدها سالباً: ${msg}. هل تريد المتابعة؟`)) return;
  }
  const batchId = uid();
  const by = (typeof currentUser!=='undefined' && currentUser) ? currentUser : 'غير معروف';
  const createdAt = Date.now();
  const summary = lines.map(l=>`${fmt(l.denom)}×${l.count}`).join('، ');
  let totalValue = 0;
  lines.forEach(l=>{
    const entry = { id: uid(), batchId, date, denom: l.denom, type, count: l.count, isAdjustment:false, notes, by, createdAt };
    vaultDenomTx.unshift(entry);
    totalValue += l.count * l.denom;
  });
  await saveVaultDenomTx();
  await logAudit('add','الحركات المالية', `تصنيف الفئات: حركة ${type==='in'?'دخول':'خروج'} دفعة واحدة (${summary}) — إجمالي القيمة: ${fmt(totalValue)} ﷼${notes?` — ${notes}`:''}`);
  showToast('تم تنفيذ الحركة');
  CASH_DENOMINATIONS.forEach(d=>{
    const el = document.querySelector(`[data-batch-denom-count="${d}"]`);
    if(el) el.value = '';
  });
  if($('#denom-tx-notes')) $('#denom-tx-notes').value = '';
  recalcDenomTable();
  renderDenomHistory();
}
function renderDenomHistory(){
  const body = $('#cash-count-history-body');
  if(!body) return;
  // جمّع الحركات في صف واحد لكل عملية: الحركات ذات batchId (دُخلت دفعة واحدة عبر النموذج الجديد) تُجمع حسب batchId،
  // والحركات القديمة بدون batchId تُجمع تلقائياً حسب (نفس التاريخ + نفس نوع الحركة دخول/خروج + نفس كونها تسوية جرد أو لا)
  const groups = [];
  const seenBatches = new Set();
  const seenLegacyKeys = new Set();
  vaultDenomTx.forEach(e=>{
    if(e.batchId){
      if(seenBatches.has(e.batchId)) return;
      seenBatches.add(e.batchId);
      const members = vaultDenomTx.filter(x=>x.batchId===e.batchId);
      groups.push({ date:e.date, type:e.type, isAdjustment:e.isAdjustment, notes:e.notes, by:e.by, createdAt:e.createdAt, members, ids: members.map(m=>m.id) });
    } else {
      const key = `${e.date}|${e.type}|${e.isAdjustment?1:0}`;
      if(seenLegacyKeys.has(key)) return;
      seenLegacyKeys.add(key);
      const members = vaultDenomTx.filter(x=>!x.batchId && x.date===e.date && x.type===e.type && !!x.isAdjustment===!!e.isAdjustment);
      const notes = [...new Set(members.map(m=>m.notes).filter(Boolean))].join(' | ');
      const by = [...new Set(members.map(m=>m.by).filter(Boolean))].join('، ');
      groups.push({ date:e.date, type:e.type, isAdjustment:e.isAdjustment, notes, by, createdAt:e.createdAt, members, ids: members.map(m=>m.id) });
    }
  });
  groups.sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0));
  if($('#cash-count-history-empty')) $('#cash-count-history-empty').style.display = groups.length ? 'none' : 'block';
  body.innerHTML = groups.map(g=>{
    const label = g.isAdjustment ? 'تسوية جرد' : (g.type==='in' ? 'دخول' : 'خروج');
    const color = g.isAdjustment ? 'var(--gold-dark)' : (g.type==='in' ? 'var(--teal)' : 'var(--red)');
    const sign = g.type==='in' ? '+' : '-';
    const denomLabel = g.members.map(m=>`${fmt(num(m.denom))}×${fmt(num(m.count))}`).join('، ');
    const totalCount = g.members.reduce((s,m)=>s+num(m.count),0);
    const totalValue = g.members.reduce((s,m)=>s+num(m.count)*num(m.denom),0);
    return `
    <tr>
      <td class="mono">${escapeHtml(g.date||'')}</td>
      <td>${escapeHtml(denomLabel)}</td>
      <td><span class="stamp" style="background:${color}; color:#fff;">${label}</span></td>
      <td class="mono">${sign}${fmt(totalCount)}</td>
      <td class="mono">${sign}${fmt(totalValue)} ﷼</td>
      <td>${escapeHtml(g.notes||'—')}</td>
      <td>${escapeHtml(g.by||'—')}</td>
      <td><button class="btn btn-ghost btn-sm" data-del-denomtx="${g.ids.join(',')}">🗑</button></td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-del-denomtx]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const ids = btn.dataset.delDenomtx.split(',');
      const msg = ids.length>1 ? 'حذف كل حركات هذا الصف من سجل تصنيف الفئات؟ (لا يؤثر على أي رصيد محاسبي آخر)' : 'حذف هذه الحركة من سجل تصنيف الفئات؟ (لا يؤثر على أي رصيد محاسبي آخر)';
      if(!await customConfirm(msg)) return;
      vaultDenomTx = vaultDenomTx.filter(x=>!ids.includes(x.id));
      await saveVaultDenomTx();
      recalcDenomTable();
      renderDenomHistory();
    });
  });
}
// ربط فلاتر الخزنة: نربط input فقط لحقول النص/التاريخ، وchange فقط للقوائم/المقاييس — ربط
// الاثنين معاً لكل عنصر كان يستدعي renderVault مرتين لبعض العناصر (input ثم change) فيُعاد رسم
// الجدول الكبير مرتين لكل تفاعل، ويزيد بشكل ملحوظ مع كثرة البيانات.
['#v-from','#v-to'].forEach(sel=>{ const el=$(sel); el?.addEventListener('input', renderVault); });
['#v-filter-type','#v-filter-dest','#v-filter-dup','#v-filter-nomethod','#v-filter-anomaly','#v-filter-reception'].forEach(sel=>{ const el=$(sel); el?.addEventListener('change', renderVault); });
onSearchInput('#v-search', renderVault);
$('#vault-page-size')?.addEventListener('change', ()=>{ vaultCurrentPage = 1; renderVault(); });
$('#vault-page-first')?.addEventListener('click', ()=>{ vaultCurrentPage = 1; renderVault(); });
$('#vault-page-prev')?.addEventListener('click', ()=>{ vaultCurrentPage = Math.max(1, vaultCurrentPage-1); renderVault(); });
$('#vault-page-next')?.addEventListener('click', ()=>{ vaultCurrentPage = vaultCurrentPage+1; renderVault(); });
$('#vault-page-last')?.addEventListener('click', ()=>{ vaultCurrentPage = Infinity; renderVault(); });

function renderVaultBulkBar(filteredRows){
  const bar = $('#vault-bulk-actions-bar');
  if(!bar) return;
  const count = selectedVaultIds.size;
  bar.style.display = count>0 ? '' : 'none';
  $('#vault-bulk-selected-count').textContent = count;
  $('#vault-bulk-filtered-total').textContent = filteredRows.length;
  const selectAllBox = $('#select-all-vault');
  if(selectAllBox){
    const pageIds = currentPageVaultIds;
    const selectedOnPage = pageIds.filter(id=>selectedVaultIds.has(id)).length;
    selectAllBox.checked = pageIds.length>0 && selectedOnPage===pageIds.length;
    selectAllBox.indeterminate = selectedOnPage>0 && selectedOnPage<pageIds.length;
  }
}
$('#vault-table-body').addEventListener('change', e=>{
  if(e.target.classList.contains('row-select-vault')){
    const id = e.target.dataset.id;
    if(e.target.checked) selectedVaultIds.add(id); else selectedVaultIds.delete(id);
    renderVaultBulkBar(vaultFilteredRows());
  }
});
$('#select-all-vault')?.addEventListener('change', e=>{
  if(e.target.checked) currentPageVaultIds.forEach(id=>selectedVaultIds.add(id));
  else currentPageVaultIds.forEach(id=>selectedVaultIds.delete(id));
  renderVault();
});
$('#btn-vault-select-all-filtered')?.addEventListener('click', ()=>{
  vaultFilteredRows().forEach(t=>selectedVaultIds.add(t.id));
  renderVault();
});
$('#btn-vault-clear-selection')?.addEventListener('click', ()=>{
  selectedVaultIds.clear();
  renderVault();
});
$('#btn-vault-bulk-delete')?.addEventListener('click', async ()=>{
  const allIds = [...selectedVaultIds].filter(id=>vaultTx.some(t=>t.id===id));
  if(!allIds.length){ showToast('لا يوجد حركات محددة'); return; }
  const targets = allIds.map(id=>vaultTx.find(t=>t.id===id));
  const lockedTargets = targets.filter(t=>isDateLocked(t.date));
  const deletableTargets = targets.filter(t=>!isDateLocked(t.date));
  if(!deletableTargets.length){ showToast('كل الحركات المحددة ضمن فترة محاسبية مُقفلة — لا يمكن إلغاء أي منها'); return; }
  const linkedClients = new Map(); // clientId -> {name, hasFirst, hasSecond}
  deletableTargets.forEach(t=>{
    if(t.type==='in' && t.autoClientId){
      const c = clients.find(cl=>cl.id===t.autoClientId);
      if(c){
        const isSecond = String(t.id).startsWith('auto2_');
        const entry = linkedClients.get(c.id) || {name:c.name, first:false, second:false};
        if(isSecond) entry.second = true; else entry.first = true;
        linkedClients.set(c.id, entry);
      }
    }
  });
  const totalAmount = deletableTargets.reduce((s,t)=>s+num(t.amount),0);
  let msg = `سيتم إلغاء ${deletableTargets.length} حركة مالية بإجمالي مبلغ ${fmt(totalAmount)} (حذف منطقي — تُحفظ في سجل الحركات الملغاة، لا حذف نهائي).`;
  if(lockedTargets.length) msg += `\n\nتنبيه: سيتم تجاهل ${lockedTargets.length} حركة من ضمن المحدد لأنها ضمن فترة محاسبية مُقفلة.`;
  if(linkedClients.size) msg += `\n\nتنبيه: من ضمنها دفعات تسجيل مرتبطة بـ ${linkedClients.size} عميل — سيتم تلقائياً تصفير المبلغ المدفوع المقابل (الأول و/أو الثاني) في بيانات كل عميل منهم فور الإلغاء.`;
  const isAdminBulk = currentUserRole==='admin';
  msg += isAdminBulk ? '\n\nيرجى كتابة سبب الإلغاء (اختياري للمدير، وسيُسجَّل لكل الحركات المحددة):' : '\n\nيرجى كتابة سبب الإلغاء (إلزامي، وسيُسجَّل لكل الحركات المحددة):';
  const reason = await customPrompt(msg, {title:'سبب إلغاء المجموعة المحددة', required:!isAdminBulk, placeholder:'اكتب سبب الإلغاء هنا...'});
  if(reason===null) return;
  if(!isAdminBulk && !reason.trim()){ showToast('سبب الإلغاء إلزامي — لم يتم الإلغاء'); return; }
  const bulkReason = reason.trim() || (isAdminBulk ? 'بدون سبب (مدير)' : '');
  snapshotState(`إلغاء جماعي (حذف منطقي) لـ ${deletableTargets.length} حركة مالية بإجمالي ${fmt(totalAmount)}`);
  const affectedClientIds = new Set();
  let removedCount = 0;
  deletableTargets.forEach(t=>{
    const removed = softDeleteVaultTx(t.id, bulkReason);
    if(removed){
      removedCount++;
      if(removed.autoClientId){
        const c = clients.find(cl=>cl.id===removed.autoClientId);
        if(c){
          const isSecond = String(removed.id).startsWith('auto2_');
          if(isSecond){ c.paid2 = 0; } else { c.paid = 0; }
          affectedClientIds.add(c.id);
        }
      }
    }
  });
  await saveVaultTx();
  await saveDeletedVaultTx();
  await logAudit('delete','الحركات المالية', `إلغاء جماعي (حذف منطقي) لـ ${removedCount} حركة بإجمالي ${fmt(totalAmount)}${lockedTargets.length?` (تم تجاهل ${lockedTargets.length} حركة مُقفلة)`:''} — السبب: ${reason.trim()}`);
  if(affectedClientIds.size){
    await saveClients();
    const namesList = [...affectedClientIds].map(id=>clients.find(c=>c.id===id)?.name).filter(Boolean).join('، ');
    await logAudit('edit','العملاء', `تم تصفير دفعات التسجيل المرتبطة تلقائياً لـ ${affectedClientIds.size} عميل بعد إلغاء جماعي لحركاتهم المالية: ${namesList}`);
  }
  selectedVaultIds.clear();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports();
  renderVault();
  showToast(`تم إلغاء ${removedCount} حركة بنجاح${lockedTargets.length?`، وتجاهل ${lockedTargets.length} حركة مُقفلة`:''}`);
});

function toggleVaultFields(){
  const type = $('#vf-type').value;
  const isIn = type==='in';
  const isReturn = type==='return';
  const isOut = type==='out';
  const linked = $('#vf-linked').checked;
  $('#wrap-linked').style.display = isIn ? '' : 'none';
  $('#wrap-clientid').style.display = (isReturn || (isIn && linked)) ? '' : 'none';
  $('#wrap-clientname').style.display = (isReturn || (isIn && linked)) ? '' : 'none';
  $('#wrap-manual').style.display = (isIn && !linked) ? '' : 'none';
  $('#wrap-category').style.display = isOut ? '' : 'none';
  $('#wrap-recipient').style.display = isOut ? '' : 'none';
  $('#wrap-refno').style.display = isOut ? '' : 'none';
  $('#wrap-netinvoice').style.display = $('#vf-destination').value==='network' ? '' : 'none';
  $('#wrap-bagdeposit-toggle').style.display = isOut ? '' : 'none';
  $('#wrap-bagdeposit-qty').style.display = (isOut && $('#vf-bagdeposit').checked) ? '' : 'none';
  if(!isOut) $('#vf-bagdeposit').checked = false;
}
$('#vf-type').addEventListener('change', toggleVaultFields);
$('#vf-linked').addEventListener('change', toggleVaultFields);
$('#vf-destination').addEventListener('change', toggleVaultFields);
$('#vf-bagdeposit').addEventListener('change', toggleVaultFields);

/* ---------------- تصنيف تلقائي للمصروفات بالذكاء الاصطناعي ----------------
   يقرأ اسم مستلم المبلغ + الملاحظات + رقم المستند + المبلغ، ويقترح أنسب تصنيف
   من قائمة التصنيفات المعرَّفة في الإعدادات (أو تصنيف جديد مختصر إن لم يوجد مناسب). */
async function aiClassifyExpense(){
  const btn = $('#btn-ai-classify');
  const statusEl = $('#ai-classify-status');
  const recipient = $('#vf-recipient').value.trim();
  const notes = $('#vf-notes').value.trim();
  const refno = $('#vf-refno').value.trim();
  const amount = $('#vf-amount').value;
  if(!recipient && !notes){
    showToast('أدخل اسم مستلم المبلغ أو ملاحظة أولاً حتى يقدر الذكاء الاصطناعي يقترح تصنيفاً مناسباً');
    return;
  }
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = '⏳ جارِ التصنيف...';
  statusEl.style.display = 'none';
  try{
    const payload = {
      recipientName: recipient || null,
      notes: notes || null,
      documentRef: refno || null,
      amount: amount || null,
      availableCategories: settings.expenseCategories
    };
    const response = await serverFetch('/api/ai/classify-expense', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if(!response.ok){
      const errData = await response.json().catch(()=>({}));
      throw new Error(errData.error || `HTTP ${response.status}`);
    }
    const data = await response.json();
    const suggestedCategory = String(data.category||'').trim();
    if(!suggestedCategory) throw new Error('لم يصل تصنيف صالح');
    const isNew = !!data.isNew;
    const reason = data.reason || '';
    if(isNew && !settings.expenseCategories.includes(suggestedCategory)){
      settings.expenseCategories.push(suggestedCategory);
      await saveSettings();
      populateSelect($('#vf-category'), settings.expenseCategories, false);
    }
    if(!settings.expenseCategories.includes(suggestedCategory)){
      // احتياط: لو رجع تصنيف غير موجود ولم يُعلَّم isNew، أضفه بأمان حتى لا تُفقَد الاقتراح
      settings.expenseCategories.push(suggestedCategory);
      await saveSettings();
      populateSelect($('#vf-category'), settings.expenseCategories, false);
    }
    $('#vf-category').value = suggestedCategory;
    statusEl.textContent = `✅ التصنيف المقترح: "${suggestedCategory}"${reason ? ' — ' + reason : ''} (يمكنك تغييره تدوياً لو غير مناسب)`;
    statusEl.style.display = '';
  }catch(err){
    showToast('تعذر الحصول على اقتراح تصنيف — تأكد من اتصالك بالإنترنت، أو أضف تصنيفاً يدوياً');
  }finally{
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
$('#btn-ai-classify').addEventListener('click', aiClassifyExpense);

$('#vf-clientid').addEventListener('input', ()=>{
  const c = clients.find(x=>x.clientId===$('#vf-clientid').value.trim());
  $('#vf-clientname').value = c ? c.name : '';
  if(c){
    const chan = settings.channels.find(ch=>ch.name===c.channel);
    if(chan) $('#vf-destination').value = chan.dest==='other' ? 'vault' : chan.dest;
    toggleVaultFields();
  }
});

/* ================= المرحلة 4: إدخال سريع بالعربي الطبيعي ================= */
/* ---------------- تحليل جملة عربية بسيطة لاستخراج مبلغ وطريقة دفع ----------------
   استخراج بسيط بالكلمات المفتاحية (وليس ذكاءً اصطناعياً) — يلتقط أول رقم في الجملة كمبلغ،
   ويحاول تخمين طريقة الدفع من كلمات شائعة (نقدي/كاش، شبكة/مدى/بطاقة، بنك/تحويل)، والباقي من
   النص (بعد إزالة الرقم وكلمات الدفع والأفعال الشائعة) يُستخدم كاسم مستلم/بيان تُمرَّر بعدها
   لاقتراح التصنيف بالذكاء الاصطناعي الموجود أصلاً (aiClassifyExpense) — فلا يوجد تكرار منطق. */
function parseNaturalLanguageExpense(text){
  const t = String(text||'').trim();
  const amountMatch = t.match(/\d+(?:[.,]\d+)?/);
  const amount = amountMatch ? parseFloat(amountMatch[0].replace(',','.')) : 0;
  let method = null;
  if(/نقد|كاش/.test(t)){
    const ch = settings.channels.find(c=>c.dest==='vault');
    method = ch ? ch.name : null;
  }else if(/شبكة|مدى|بطاقة/.test(t)){
    const ch = settings.channels.find(c=>/شبكة|مدى|بطاقة/.test(c.name)) || settings.channels.find(c=>c.dest==='network');
    method = ch ? ch.name : null;
  }else if(/بنك|تحويل/.test(t)){
    const ch = settings.channels.find(c=>c.dest==='bank');
    method = ch ? ch.name : null;
  }
  let rest = t;
  if(amountMatch) rest = rest.replace(amountMatch[0], ' ');
  rest = rest
    .replace(/ريال|ر\.س|جنيه|دولار|﷼/g, ' ')
    .replace(/نقدي|كاش|شبكة|مدى|بطاقة|بنك|تحويل/g, ' ')
    .replace(/دفعت|صرفت|اشتريت|سددت|مصاريف|مصروف|فاتورة/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { amount, method, rest };
}
$('#btn-nl-expense')?.addEventListener('click', ()=>{
  const raw = $('#nl-expense-input')?.value || '';
  if(!raw.trim()){ showToast('اكتب وصف الحركة أولاً'); return; }
  const parsed = parseNaturalLanguageExpense(raw);
  if(!parsed.amount || parsed.amount<=0){ showToast('لم أستطع التعرّف على مبلغ رقمي في الجملة — أدخله يدوياً في النموذج'); }
  openVaultModal(null);
  $('#vf-type').value = 'out';
  toggleVaultFields();
  if(parsed.amount>0) $('#vf-amount').value = parsed.amount;
  if(parsed.method) $('#vf-method').value = parsed.method;
  $('#vf-recipient').value = parsed.rest || raw.trim();
  $('#vf-notes').value = raw.trim();
  showToast('راجع الحقول المعبّأة تلقائياً ثم اضغط "اقتراح تصنيف بالذكاء الاصطناعي" وتأكد قبل الحفظ');
  $('#nl-expense-input').value = '';
});
$('#btn-add-vault').addEventListener('click', ()=>openVaultModal(null));
// زرار عائم متاح من أي شاشة في البرنامج لفتح مودال "حركة خزنة جديدة" مباشرة بدون الحاجة للانتقال لشيت الحركات المالية أولاً
$('#btn-fab-quickadd')?.addEventListener('click', ()=>openVaultModal(null));
function openVaultModal(id){
  if(id){
    const lockedTx = vaultTx.find(x=>x.id===id);
    if(lockedTx && lockedTx.type==='in' && lockedTx.autoClientId){
      showToast('هذه دفعة تسجيل تلقائية — عدّلها من شيت العملاء (حقلا "المبلغ المدفوع"/"طريقة الدفع")');
      return;
    }
  }
  if(id && isDateLocked(vaultTx.find(x=>x.id===id)?.date)){ vaultLockToast(); return; }
  editingVaultId = id || null;
  $('#vault-modal-title').textContent = id ? 'تعديل حركة خزنة' : 'حركة خزنة جديدة';
  const t = id ? vaultTx.find(x=>x.id===id) : null;
  $('#vf-type').value = t ? (t.isReturn ? 'return' : t.type) : 'in';
  $('#vf-date').value = t?.date || todayISO();
  $('#vf-amount').value = t?.amount ?? '';
  $('#vf-linked').checked = t ? !!t.clientId : true;
  $('#vf-clientid').value = t?.clientId || '';
  $('#vf-clientname').value = t?.clientName || '';
  $('#vf-manual').value = t?.manual || '';
  populateSelect($('#vf-category'), settings.expenseCategories, false);
  $('#vf-category').value = t?.category || '';
  $('#vf-recipient').value = t?.recipientName || '';
  $('#vf-refno').value = t?.referenceNo || '';
  // طرق الدفع الموحدة (نفس طرق الدفع المُعرَّفة في الإعدادات — يطابق شيت "الحركات المالية")
  populateSelect($('#vf-method'), settings.channels.map(c=>c.name), false);
  {
    const vfMethodVal = t?.method || '';
    if(settings.channels.some(c=>c.name===vfMethodVal)) $('#vf-method').value = vfMethodVal;
    else { const vaultCh = settings.channels.find(c=>c.dest==='vault'); $('#vf-method').value = vaultCh ? vaultCh.name : settings.channels[0]?.name || ''; }
  }
  $('#vf-notes').value = t?.notes || '';
  $('#vf-destination').value = t?.destination || 'vault';
  $('#vf-netinvoice').value = t?.networkInvoice || '';
  $('#vf-bagdeposit').checked = false;
  toggleVaultFields();
  $('#vault-overlay').classList.add('show'); SoundFX.open();
}
$('#vf-cancel').addEventListener('click', ()=>{ $('#vault-overlay').classList.remove('show'); editingVaultId=null; });
$('#vault-overlay').addEventListener('click', e=>{ if(e.target.id==='vault-overlay'){ $('#vault-overlay').classList.remove('show'); editingVaultId=null; } });

$('#vault-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const rawType = $('#vf-type').value;
  const isIn = rawType==='in';
  const isReturn = rawType==='return';
  const isOut = rawType==='out';
  const linked = (isIn && $('#vf-linked').checked) || isReturn;
  const amount = num($('#vf-amount').value);
  const date = $('#vf-date').value || todayISO();
  if(amount<=0){ showToast('أدخل مبلغاً صحيحاً'); return; }
  if(isReturn && !$('#vf-clientid').value.trim()){ showToast('يجب تحديد العميل الذي سيُسترجع له المبلغ'); return; }
  // إلزام الحقول الأساسية حسب نوع الحركة — لا يُحفظ صادر بدون تصنيف، مستلم، ومستند مؤيّد
  if(isOut){
    if(!$('#vf-category').value.trim()){ showToast('يجب اختيار تصنيف المصروف'); return; }
    if(!$('#vf-recipient').value.trim()){ showToast('يجب إدخال اسم مستلم المبلغ'); return; }
    if(!$('#vf-refno').value.trim()){ showToast('يجب إدخال رقم المستند/المرفق المؤيّد لهذا الصادر'); return; }
  }
  if(isIn && !linked && !$('#vf-manual').value.trim()){ showToast('يجب إدخال البيان / الجهة لهذه الحركة الواردة'); return; }
  if(isIn && linked && !$('#vf-clientid').value.trim()){ showToast('يجب إدخال رقم الهوية للعميل المرتبط بالحركة'); return; }
  if(isIn && linked && !clients.find(x=>x.clientId===$('#vf-clientid').value.trim())){ showToast('لا يوجد عميل مسجّل بهذا الرقم — تحقق من رقم الهوية/الإقامة'); return; }
  // قفل الفترات المحاسبية: منع أي إضافة أو تعديل يقع تاريخها ضمن فترة أُقفلت بعد اعتماد قوائمها
  if(isDateLocked(date)){ vaultLockToast(); return; }
  if(editingVaultId){
    const existing = vaultTx.find(x=>x.id===editingVaultId);
    if(existing && isDateLocked(existing.date)){ vaultLockToast(); return; }
  }
  const data = {
    type: isReturn ? 'out' : rawType,
    isReturn,
    date,
    amount,
    method: $('#vf-method').value,
    notes: $('#vf-notes').value.trim(),
    clientId: linked ? $('#vf-clientid').value.trim() : '',
    clientName: linked ? $('#vf-clientname').value.trim() : '',
    manual: (isIn && !linked) ? $('#vf-manual').value.trim() : '',
    category: isReturn ? 'مردودات المبيعات' : (isOut ? $('#vf-category').value : ''),
    recipientName: isOut ? $('#vf-recipient').value.trim() : '',
    referenceNo: isOut ? $('#vf-refno').value.trim() : '',
    destination: $('#vf-destination').value,
    networkInvoice: $('#vf-destination').value==='network' ? $('#vf-netinvoice').value.trim() : ''
  };
  const wasVaultEdit = !!editingVaultId;
  let prevLinkedClientId = '';
  snapshotState(wasVaultEdit ? 'تعديل حركة مالية' : 'إضافة حركة مالية');
  let savedTx;
  if(editingVaultId){
    const idx = vaultTx.findIndex(x=>x.id===editingVaultId);
    // إصلاح: نسخة "قبل" يجب أن تُستثني منها history (وإلا يبقى إشارة لنفس مصفوفة السجل الأصلية،
    // فيتكوّن مرجع دائري عند أول عملية push لاحقة ويفشل JSON.stringify عند أي حفظ أو نسخة احتياطية لاحقاً)
    const { history: _prevHistory, ...before } = vaultTx[idx];
    prevLinkedClientId = before.clientId || '';
    vaultTx[idx] = {...vaultTx[idx], ...data};
    const { history: _afterHistory, ...afterSnap } = vaultTx[idx];
    pushVaultTxHistory(vaultTx[idx], before, afterSnap);
    savedTx = vaultTx[idx];
    showToast('تم تحديث الحركة');
  }else{
    savedTx = {id:uid(), seq: allocVaultSeq(data.destination), createdAt:Date.now(), ...data};
    vaultTx.push(savedTx);
    await saveSettings();
    showToast('تمت إضافة الحركة');
  }
  await saveVaultTx();
  const txLabel = isReturn ? 'مردود مبيعات' : (savedTx.type==='in'?'وارد':'صادر');
  const txDesc = `${txLabel} بمبلغ ${fmt(num(savedTx.amount))} (${destLabel(savedTx.destination||'vault')}) - ${savedTx.clientName||savedTx.manual||savedTx.category||''}`;
  await logAudit(wasVaultEdit ? 'edit' : 'add', 'الحركات المالية', `${wasVaultEdit ? 'تم تعديل حركة' : 'تمت إضافة حركة'} رقم تسلسلي #${savedTx.seq||'—'}: ${txDesc}`);
  // تنبيه إيميل فوري للإدارة عند تسجيل مصروف جديد (حركة صادر جديدة) مع تفاصيله.
  if(!wasVaultEdit && isOut){
    notifyAdminAlert(
      `مصروف جديد: ${fmt(num(savedTx.amount))} ﷼`,
      `<p>تم تسجيل مصروف جديد بواسطة <b>${escapeHtml(currentUser || 'غير معروف')}</b>:</p>
       <table style="border-collapse:collapse; width:100%; max-width:420px; font-size:13px;">
         <tr><td style="padding:4px 0; color:#66707E;">التصنيف</td><td style="padding:4px 0; text-align:left;"><b>${escapeHtml(savedTx.category || '—')}</b></td></tr>
         <tr><td style="padding:4px 0; color:#66707E;">المبلغ</td><td style="padding:4px 0; text-align:left;"><b>${fmt(num(savedTx.amount))} ﷼</b></td></tr>
         <tr><td style="padding:4px 0; color:#66707E;">مستلم المبلغ</td><td style="padding:4px 0; text-align:left;">${escapeHtml(savedTx.recipientName || '—')}</td></tr>
         <tr><td style="padding:4px 0; color:#66707E;">طريقة الدفع</td><td style="padding:4px 0; text-align:left;">${escapeHtml(savedTx.method || '—')}</td></tr>
         <tr><td style="padding:4px 0; color:#66707E;">رقم المستند/المرفق</td><td style="padding:4px 0; text-align:left;">${escapeHtml(savedTx.referenceNo || '—')}</td></tr>
         <tr><td style="padding:4px 0; color:#66707E;">البيان</td><td style="padding:4px 0; text-align:left;">${escapeHtml(savedTx.notes || '—')}</td></tr>
         <tr><td style="padding:4px 0; color:#66707E;">الوجهة</td><td style="padding:4px 0; text-align:left;">${escapeHtml(destLabel(savedTx.destination || 'vault'))}</td></tr>
       </table>`
    );
  }

  // عند تسجيل مرتجع (مردود مبيعات) لعميل، يُحوَّل تلقائياً إلى "ملغى" (بالإضافة إلى إيقافه كسابقاً)
  // فيختفي من شيت الدورات ومخزون الحقائب ولا يُحتسب ضمن إجمالي المتبقي على العملاء،
  // تماماً كما لو أُلغي وأُوقِف يدوياً من شيت العملاء
  if(!wasVaultEdit && isReturn){
    const returnedClient = clients.find(x=>x.clientId===data.clientId);
    if(returnedClient && (!returnedClient.cancelled || !returnedClient.suspended)){
      returnedClient.cancelled = true;
      returnedClient.suspended = true;
      await saveClients();
      await logAudit('edit','العملاء', `تم إلغاء تسجيل العميل ${returnedClient.name} تلقائياً بسبب تسجيل مردود مبيعات له — أصبح مخفياً من شيت الدورات ومخزون الحقائب`);
    }
  }

  // إذا فُعّلت خانة "إيداع في حساب/مخزون الحقائب" ضمن مصروف، يُضاف المبلغ لرصيد حساب الحقائب
  // ويُحتسب عدد الحقائب المضافة تلقائياً حسب السعر الثابت للحقيبة (نفس منطق تمويل المخزون).
  // يعمل عند الإضافة وعند التعديل على حد سواء: الخانة (#vf-bagdeposit) تُصفَّر دائماً عند فتح
  // نافذة التعديل (راجع أعلى الدالة)، فتفعيلها يدوياً أثناء التعديل يعني نية صريحة جديدة من
  // المستخدم بربط هذه الحركة بمخزون الحقائب الآن — ولا يوجد أي مرجع سابق محفوظ يربط حركة الخزنة
  // بإيداع سابق فى مخزون الحقائب أصلاً، فلا خطر تكرار من إتاحتها هنا أيضاً (كانت مُقيَّدة بالخطأ
  // بشرط !wasVaultEdit فلا تعمل إطلاقاً أثناء التعديل رغم ظهور الخانة نفسها فى النموذج).
  if(isOut && $('#vf-bagdeposit').checked){
    snapshotState(`إيداع في حساب الحقائب عبر حركة مصروف: ${fmt(amount)}`);
    bagStock.push({
      id: uid(), createdBy: currentUser,
      createdAt: Date.now(),
      type: 'deposit',
      date: data.date,
      amount,
      method: data.method,
      notes: `مرتبط تلقائياً بحركة مالية (${data.category||'مصروف'})${data.notes ? ' — '+data.notes : ''}`
    });
    recalcBagFundLedger();
    await saveBagStock();
    await saveSettings();
    const addedEntry = bagStock[bagStock.length-1];
    if(addedEntry.qty>0){
      await logAudit('add','مخزون الحقائب', `تمت إضافة ${addedEntry.qty} حقيبة للمخزون تلقائياً من حركة إيداع مالية بقيمة ${fmt(amount)} (الرصيد المتبقي: ${fmt(settings.bagFundBalance)})`);
    }else{
      await logAudit('add','مخزون الحقائب', `تم تسجيل إيداع ${fmt(amount)} ﷼ في حساب الحقائب من حركة مالية — لم يكتمل بعد لشراء حقيبة كاملة (الرصيد الحالي: ${fmt(settings.bagFundBalance)})`);
    }
    renderBags();
  }

  $('#vault-overlay').classList.remove('show'); editingVaultId=null;
  if(!wasVaultEdit && isReturn){
    refreshEverything();
  }else{
    renderVault();
    // المبلغ المدفوع والمتبقي في شيت العملاء يُحسبان مباشرة من الحركات المالية المرتبطة بالعميل،
    // لذا أي إضافة أو تعديل أو تغيير ربط عميل لحركة يجب أن ينعكس فوراً هناك (العميل الجديد والقديم إن اختلفا)
    if(savedTx.clientId || prevLinkedClientId){
      if(typeof renderTable==='function') renderTable();
      if(typeof renderDashboard==='function') renderDashboard();
      if(typeof renderReports==='function') renderReports();
    }
  }

  // طباعة تلقائية عند إضافة حركة جديدة: فاتورة استرجاع للعميل عند المردودات، أو سند صرف عند المصروفات
  if(!wasVaultEdit && isReturn){
    await printReturnInvoice(savedTx.id);
  }else if(!wasVaultEdit && isOut){
    await printExpenseVoucher(savedTx.id);
  }
});

document.addEventListener('click', async e=>{
  if(e.target.dataset.vedit) openVaultModal(e.target.dataset.vedit);
  if(e.target.dataset.vprintreturn) await printReturnInvoice(e.target.dataset.vprintreturn);
  if(e.target.dataset.vvoucher) await printExpenseVoucher(e.target.dataset.vvoucher);
  if(e.target.dataset.vapprove){
    const id = e.target.dataset.vapprove;
    const t = vaultTx.find(x=>x.id===id);
    const desc = t ? `${t.type==='in'?'وارد':'صادر'} ${fmt(num(t.amount))} ﷼ — ${t.clientName||t.manual||t.category||''}` : id;
    if(await customConfirm(`اعتماد عملية الاستقبال "${desc}"؟ ستدخل فوراً في الرصيد والحسابات والتقارير كباقي الحركات.`)){
      const ok = await approveRecordGeneric('vaultTx', id);
      if(ok){
        await logAudit('edit','الحركات المالية', `تم اعتماد عملية الاستقبال: ${desc}`);
        refreshEverything();
        showToast('✅ تم اعتماد العملية');
      }else{
        showToast('⚠️ تعذّر الاعتماد — تحقق من الاتصال وحاول مجدداً');
      }
    }
    return;
  }
  if(e.target.dataset.vreject){
    const id = e.target.dataset.vreject;
    const t = vaultTx.find(x=>x.id===id);
    const desc = t ? `${t.type==='in'?'وارد':'صادر'} ${fmt(num(t.amount))} ﷼ — ${t.clientName||t.manual||t.category||''}` : id;
    if(await customConfirm(`رفض وحذف تسجيل الاستقبال المعلّق "${desc}" نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`)){
      const ok = await deleteOneRecordGeneric('vaultTx', id);
      if(ok!==false){
        vaultTx = vaultTx.filter(x=>x.id!==id);
        await logAudit('delete','الحركات المالية', `تم رفض وحذف تسجيل الاستقبال المعلّق: ${desc}`);
        refreshEverything();
        showToast('تم رفض التسجيل وحذفه');
      }else{
        showToast('⚠️ تعذّر الحذف — تحقق من الاتصال وحاول مجدداً');
      }
    }
    return;
  }
  if(e.target.dataset.vdel){
    const id = e.target.dataset.vdel;
    const target = vaultTx.find(t=>t.id===id);
    if(target && isDateLocked(target.date)){ vaultLockToast(); return; }
    // إن كانت هذه دفعة تسجيل تلقائية مرتبطة بعميل، ننبّه المستخدم أن إلغاءها سيُصفّر الدفعة المقابلة في شيت العملاء تلقائياً
    let linkedClient = null, linkedIsSecond = false;
    if(target && target.type==='in' && target.autoClientId){
      linkedClient = clients.find(c=>c.id===target.autoClientId);
      linkedIsSecond = id.startsWith('auto2_');
    }
    const linkWarning = linkedClient ? `\n\nتنبيه: هذه دفعة تسجيل مرتبطة تلقائياً بالعميل "${linkedClient.name}" — بعد الإلغاء سيتم تلقائياً تصفير ${linkedIsSecond?'"المبلغ المدفوع الثاني"':'"المبلغ المدفوع الأول"'} في بيانات هذا العميل، وسينعكس ذلك فوراً على إجمالي مدفوعاته والمتبقي عليه.` : '';
    const isAdmin = currentUserRole==='admin';
    const reason = await customPrompt(`توثيقاً للمعايير المحاسبية، لا يمكن حذف حركة مالية نهائياً — سيتم إلغاؤها فقط مع الاحتفاظ بها في سجل الحركات الملغاة.${linkWarning}\n${isAdmin ? 'يرجى كتابة سبب الإلغاء (اختياري للمدير):' : 'يرجى كتابة سبب الإلغاء (إلزامي):'}`, {title:'سبب الإلغاء', required:!isAdmin, placeholder:'اكتب سبب الإلغاء هنا...'});
    if(reason===null) return; // المستخدم ألغى العملية
    if(!isAdmin && !reason.trim()){ showToast('سبب الإلغاء إلزامي — لم يتم الحذف'); return; }
    snapshotState(`إلغاء (حذف منطقي) حركة مالية بمبلغ ${target?fmt(num(target.amount)):''}`);
    const removed = softDeleteVaultTx(id, reason.trim() || (isAdmin ? 'بدون سبب (مدير)' : ''));
    await saveVaultTx();
    await saveDeletedVaultTx();
    if(removed){
      const removedLabel = removed.isReturn ? 'مردود مبيعات' : (removed.type==='in'?'وارد':'صادر');
      const txDesc = `${removedLabel} بمبلغ ${fmt(num(removed.amount))} (${destLabel(removed.destination||'vault')}) بتاريخ ${removed.date||'—'} رقم تسلسلي #${removed.seq||'—'} - ${removed.clientName||removed.manual||removed.category||''}`;
      await logAudit('delete','الحركات المالية', `تم إلغاء (حذف منطقي) حركة: ${txDesc} — السبب: ${removed.deletedReason}`);
      // مزامنة تلقائية مع شيت العملاء: إن كانت الحركة الملغاة دفعة تسجيل تلقائية، صفّر الدفعة المقابلة في بيانات العميل
      // حتى لا تُعاد إضافتها لاحقاً عند أي حفظ آخر لبيانات هذا العميل، ويتحدث إجمالي مدفوعاته ومتبقيه فوراً في شيت العملاء
      if(removed.autoClientId){
        const c = clients.find(cl=>cl.id===removed.autoClientId);
        if(c){
          const isSecond = String(removed.id).startsWith('auto2_');
          if(isSecond){ c.paid2 = 0; } else { c.paid = 0; }
          await saveClients();
          await logAudit('edit','العملاء', `تم تصفير ${isSecond?'المبلغ المدفوع الثاني':'المبلغ المدفوع الأول'} للعميل "${c.name}" تلقائياً بعد إلغاء حركته المالية المرتبطة (رقم تسلسلي #${removed.seq||'—'})`);
          renderTable(); renderDashboard(); refreshFilterOptions(); renderReports();
        }
      }
    }
    renderVault();
    // المبلغ المدفوع والمتبقي في شيت العملاء يُحسبان مباشرة من الحركات المالية المرتبطة بالعميل،
    // فأي إلغاء لحركة مرتبطة بعميل (حتى لو لم تكن دفعة تسجيل تلقائية) يجب أن ينعكس فوراً هناك
    if(removed && removed.clientId && !removed.autoClientId){
      renderTable(); renderDashboard(); renderReports();
    }
  }
});

/* ================= قفل الفترة المحاسبية + سجل الحركات الملغاة ================= */
function renderVaultLockStatus(){
  const el = $('#vault-lock-status');
  if(!el) return;
  el.textContent = settings.vaultLockedThrough
    ? `مُقفلة حتى ${settings.vaultLockedThrough} — لا يمكن إضافة/تعديل/حذف أي حركة بتاريخ يقع في هذه الفترة أو قبلها`
    : 'لا يوجد قفل حالياً — كل الفترات مفتوحة للتعديل';
}
$('#btn-vault-lock').addEventListener('click', async ()=>{
  const d = $('#vault-lock-date').value;
  if(!d){ showToast('اختر تاريخاً أولاً'); return; }
  if(settings.vaultLockedThrough && d<=settings.vaultLockedThrough){ showToast('يجب أن يكون تاريخ القفل الجديد بعد تاريخ القفل الحالي'); return; }
  if(!await customConfirm(`سيتم قفل كل الحركات المالية بتاريخ ${d} فأقل نهائياً بعد اعتماد قوائمها — لن يمكن إضافة أو تعديل أو حذف أي حركة ضمن هذه الفترة إلا بفتح القفل استثنائياً. متابعة؟`)) return;
  snapshotState(`قفل الفترة المحاسبية حتى ${d}`);
  settings.vaultLockedThrough = d;
  await saveSettings();
  await logAudit('edit','الحركات المالية', `تم قفل الفترة المحاسبية حتى تاريخ ${d} — لا يمكن تعديل/حذف حركات هذه الفترة`);
  renderVaultLockStatus();
  showToast('تم قفل الفترة');
});
$('#btn-vault-unlock').addEventListener('click', async ()=>{
  if(!settings.vaultLockedThrough){ showToast('لا يوجد قفل حالياً'); return; }
  if(!await customConfirm('فتح القفل صلاحية استثنائية تتيح تعديل/حذف حركات فترة سبق اعتماد قوائمها المالية — تُستخدم فقط لتصحيح خطأ موثّق. هل أنت متأكد؟')) return;
  const oldLock = settings.vaultLockedThrough;
  snapshotState(`فتح قفل الفترة المحاسبية (كانت مقفلة حتى ${oldLock})`);
  settings.vaultLockedThrough = '';
  await saveSettings();
  await logAudit('edit','الحركات المالية', `تم فتح قفل الفترة المحاسبية (كانت مقفلة حتى ${oldLock}) — صلاحية استثنائية`);
  renderVaultLockStatus();
  showToast('تم فتح القفل');
});
let voidedPageState = {page:1, sig:''};
function renderVoidedLog(){
  const rows = deletedVaultTx.slice().sort((a,b)=>(b.deletedAt||0)-(a.deletedAt||0));
  $('#voided-empty').style.display = rows.length ? 'none' : 'block';
  const pageRows = applyGenericPagination('voided', rows, voidedPageState, [rows.length]);
  $('#voided-table-body').innerHTML = pageRows.map(t=>`
    <tr>
      <td class="mono">#${t.seq||'—'}</td>
      <td class="mono">${t.date||'—'}</td>
      <td><span class="stamp ${t.type==='in'?'paid':'owe'}">${t.type==='in'?'وارد':(t.isReturn?'مردود مبيعات':'صادر')}</span></td>
      <td>${destLabel(t.destination||'vault')}</td>
      <td class="mono">${fmt(num(t.amount))}</td>
      <td>${escapeHtml(t.clientName||t.manual||t.category||'—')}</td>
      <td>${escapeHtml(t.deletedReason||'—')}</td>
      <td>${escapeHtml(t.deletedBy||'—')}</td>
      <td class="mono">${t.deletedAt ? new Date(t.deletedAt).toLocaleString('ar-SA-u-nu-latn') : '—'}</td>
    </tr>`).join('');
}
bindGenericPagination('voided', voidedPageState, renderVoidedLog);
$('#btn-show-voided').addEventListener('click', ()=>{ renderVoidedLog(); $('#voided-overlay').classList.add('show'); SoundFX.open(); });
$('#voided-close').addEventListener('click', ()=> $('#voided-overlay').classList.remove('show'));
$('#voided-overlay').addEventListener('click', e=>{ if(e.target.id==='voided-overlay') $('#voided-overlay').classList.remove('show'); });

$('#btn-extract-nomethod').addEventListener('click', ()=>{
  // تفعيل فلتر "بدون طريقة دفع" في الشاشة مع الإبقاء على بقية الفلاتر (التاريخ/الوجهة/النوع/البحث) كما هي
  $('#v-filter-nomethod').checked = true;
  renderVault();
  const rows = vaultFilteredRows();
  if(!rows.length){ showToast('لا توجد حركات بدون طريقة دفع ضمن الفلتر الحالي'); return; }
  const seq = seqNumbers();
  const reportRows = rows.map(t=>({
    'الرقم التسلسلي الرسمي': t.seq||'', 'الرقم': seq[t.id]||'', 'التاريخ': t.date||'',
    'الحساب': destLabel(t.destination||'vault'), 'النوع': t.isReturn?'مردود مبيعات':(t.type==='in'?'وارد':'صادر'),
    'رقم الهوية': t.clientId||'', 'العميل / البيان': (t.type==='in'||t.isReturn)?(t.clientName||t.manual||''):(t.category||''),
    'التصنيف': t.type==='out' ? (t.category||'') : '', 'المبلغ': num(t.amount), 'ملاحظات': t.notes||''
  }));
  downloadXlsx(`حركات_بدون_طريقة_دفع_${stampNow()}.xlsx`, 'بدون طريقة دفع', reportRows);
  showToast(`تم استخراج ${rows.length} حركة بدون طريقة دفع`);
});
$('#btn-export-vault').addEventListener('click', ()=>{
  const rows = vaultFilteredRows();
  const seq = seqNumbers();
  const headers = ['الرقم التسلسلي الرسمي','الرقم','التاريخ','الحساب','النوع','رقم الهوية','العميل/البيان','التصنيف','مستلم المبلغ (للمصروفات)','رقم المستند/المرفق','طريقة الدفع','رقم فاتورة الشبكة','المبلغ','ملاحظات'];
  const data = rows.map(t=>[t.seq||'', seq[t.id]||'', t.date, destLabel(t.destination||'vault'), t.isReturn?'مردود مبيعات':(t.type==='in'?'وارد':'صادر'), t.clientId, (t.type==='in'||t.isReturn)?(t.clientName||t.manual):(t.category), t.category, t.recipientName||'', t.referenceNo||'', t.method, t.networkInvoice||'', t.amount, t.notes]);
  const csv = '\uFEFF'+[headers, ...data].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'تقرير_الحركات_المالية.csv';
  a.click();
});

/* ---------------- Audit Log ---------------- */
function refreshAuditFilterOptions(){
  const sections = [...new Set(auditLog.map(a=>a.section))];
  populateSelect($('#audit-filter-section'), sections, true);
}
function auditFilteredRows(){
  const q = $('#audit-search').value.trim().toLowerCase();
  const action = $('#audit-filter-action').value;
  const section = $('#audit-filter-section').value;
  const dfrom = $('#audit-date-from').value;
  const dto = $('#audit-date-to').value;
  return auditLog.filter(a=>{
    if(action && a.action!==action) return false;
    if(section && a.section!==section) return false;
    if(dfrom && a.ts < new Date(dfrom+'T00:00:00').getTime()) return false;
    if(dto && a.ts > new Date(dto+'T23:59:59').getTime()) return false;
    if(q){
      const hay = [a.user,a.section,a.description].join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=>b.ts-a.ts);
}
function actionLabel(a){ return {add:'إضافة', edit:'تعديل', delete:'حذف'}[a] || a; }
function fmtDateTime(ts){
  const d = new Date(ts);
  return d.toLocaleString('ar-SA-u-nu-latn', {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
}
let auditPageState = {page:1, sig:''};
function renderAuditLog(){
  refreshAuditFilterOptions();
  const rows = auditFilteredRows();
  $('#audit-empty').style.display = rows.length ? 'none' : 'block';
  const pageRows = applyGenericPagination('audit', rows, auditPageState, [
    $('#audit-search')?.value, $('#audit-filter-action')?.value, $('#audit-filter-section')?.value,
    $('#audit-date-from')?.value, $('#audit-date-to')?.value
  ]);
  $('#audit-table-body').innerHTML = pageRows.map(a=>`
    <tr>
      <td class="mono" data-label="التاريخ والوقت">${fmtDateTime(a.ts)}</td>
      <td data-label="المستخدم">${escapeHtml(a.user)}</td>
      <td data-label="الشيت">${escapeHtml(a.section)}</td>
      <td data-label="العملية"><span class="stamp ${a.action==='delete'?'owe':'paid'}">${actionLabel(a.action)}</span></td>
      <td data-label="التفاصيل" class="card-full">${escapeHtml(a.description)}</td>
    </tr>`).join('');
}
bindGenericPagination('audit', auditPageState, renderAuditLog);
['#audit-filter-action','#audit-filter-section','#audit-date-from','#audit-date-to'].forEach(sel=>{
  $(sel).addEventListener('input', renderAuditLog);
});
onSearchInput('#audit-search', renderAuditLog);
$('#btn-export-audit').addEventListener('click', ()=>{
  const rows = auditFilteredRows();
  const headers = ['التاريخ والوقت','المستخدم','الشيت','العملية','التفاصيل'];
  const data = rows.map(a=>[fmtDateTime(a.ts), a.user, a.section, actionLabel(a.action), a.description]);
  const csv = '\uFEFF'+[headers, ...data].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a2 = document.createElement('a');
  a2.href = URL.createObjectURL(blob);
  a2.download = 'سجل_المراجعة.csv';
  a2.click();
});

