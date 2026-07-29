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
function vaultFilteredRows(){
  const from = $('#v-from').value;
  const to = $('#v-to').value;
  const type = $('#v-filter-type').value;
  const dest = $('#v-filter-dest').value;
  const q = $('#v-search').value.trim().toLowerCase();
  const dupOnly = $('#v-filter-dup')?.checked;
  const dupIds = dupOnly ? vaultDuplicateClientIds() : null;
  const noMethodOnly = $('#v-filter-nomethod')?.checked;
  const frecepV = $('#v-filter-reception') ? $('#v-filter-reception').value : '';
  return vaultTx.filter(t=>{
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
function vaultTxCountsTowardBalance(t){
  return !(t.autoClientId && (t.destination||'vault')==='vault' && t.settled===false);
}
function balanceOf(dest){
  return vaultTx.filter(t=>(t.destination||'vault')===dest && t.type==='in' && vaultTxCountsTowardBalance(t)).reduce((s,t)=>s+num(t.amount),0)
       - vaultTx.filter(t=>(t.destination||'vault')===dest && t.type==='out').reduce((s,t)=>s+num(t.amount),0);
}
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
  `;

  $('#vault-empty').style.display = rows.length ? 'none' : 'block';

  // إعادة الصفحة إلى الأولى تلقائياً كلما تغيّر البحث أو أي فلتر (وليس عند التنقّل بين الصفحات فقط)
  const vaultFilterSig = JSON.stringify([
    $('#v-from')?.value, $('#v-to')?.value, $('#v-filter-type')?.value, $('#v-filter-dest')?.value,
    $('#v-search')?.value, $('#v-filter-dup')?.checked, $('#v-filter-nomethod')?.checked
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
  $('#vault-table-body').innerHTML = pageRows.map(t=>{
    const isDup = !!(t.clientId && dupIdsForHighlight.has(t.clientId));
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
      <td class="mono" data-label="المبلغ">${fmt(num(t.amount))}${!vaultTxCountsTowardBalance(t) ? ` <span class="stamp owe" title="لم تُسوَّ بعد — لا تُحتسب ضمن رصيد الخزنة حتى تُسوَّى من صندوق تسويات الاستقبال">معلّق</span>` : ''}</td>
      <td data-label="ملاحظات">${escapeHtml(t.notes||'')}</td>
      <td class="card-full" data-label="" style="white-space:nowrap;">
        ${(t.type==='in' && t.autoClientId) ? `<span class="hint" style="margin:0; display:inline-block; font-size:11px;">🔗 دفعة تسجيل — التعديل من شيت العملاء</span>` : (t.type==='in' && t.companyTransferId) ? `
        <button type="button" class="btn btn-gold btn-sm" data-viewcompanytransfer="${t.companyTransferId}">👥 تفاصيل المتدربين</button>` : `
        <div class="row-menu">
          <button type="button" class="btn btn-ghost btn-sm row-menu-toggle" title="إجراءات" aria-haspopup="true" aria-expanded="false">⋮</button>
          <div class="row-menu-panel" role="menu">
            <button class="btn btn-ghost btn-sm" data-vedit="${t.id}">${tr('edit')}</button>
            ${t.isReturn ? `<button class="btn btn-gold btn-sm" data-vprintreturn="${t.id}">طباعة فاتورة الاسترجاع</button>` : ''}
            ${(t.type==='out' && !t.isReturn) ? `<button class="btn btn-gold btn-sm" data-vvoucher="${t.id}">طباعة سند صرف</button>` : ''}
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
['#v-from','#v-to','#v-filter-type','#v-filter-dest','#v-filter-dup','#v-filter-nomethod','#v-filter-reception'].forEach(sel=>{ const el=$(sel); el?.addEventListener('input', renderVault); el?.addEventListener('change', renderVault); });
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

$('#btn-add-vault').addEventListener('click', ()=>openVaultModal(null));
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
  // ويُحتسب عدد الحقائب المضافة تلقائياً حسب السعر الثابت للحقيبة (نفس منطق تمويل المخزون)
  if(isOut && !wasVaultEdit && $('#vf-bagdeposit').checked){
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
      <td class="mono">${t.deletedAt ? new Date(t.deletedAt).toLocaleString('ar-SA') : '—'}</td>
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
  return d.toLocaleString('ar-SA', {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
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

/* ---------------- Login / Logout ----------------
   تم حذف شاشة تسجيل الدخول المحلي داخل البرنامج بناءً على طلب المستخدم.
   الدخول الآن يتم فقط عبر شاشة السيرفر المركزي (server-login-screen)، وصلاحيات المستخدم
   (admin/staff) تُشتق مباشرة من هوية المستخدم الذي سجّل دخوله فعليًا على الخادم (SERVER_AUTH_USERNAME/
   SERVER_AUTH_ROLE)، وليس من أول مستخدم في قائمة "المستخدمين" الداخلية للبرنامج. */
function autoSignInLocalUser(){
  $('#app-wrap').style.display = 'block';
  $('#current-user-label').textContent = currentUser;
  applyRolePermissions();
}
$('#btn-lang-toggle').addEventListener('click', ()=>{
  applyLanguage(currentLang==='ar' ? 'en' : 'ar');
});
$('#btn-theme-toggle').addEventListener('click', async ()=>{
  settings.darkMode = !settings.darkMode;
  applyTheme(settings.darkMode);
  await saveSettings();
});
$('#btn-sound-toggle').addEventListener('click', async ()=>{
  settings.soundEnabled = !settings.soundEnabled;
  applySoundIcon();
  if(settings.soundEnabled) SoundFX.click();
  await saveSettings();
});
$('#btn-logout').addEventListener('click', async ()=>{
  if(await customConfirm('تأكيد تسجيل الخروج؟')){
    try{
      await fetch(API_BASE + '/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN },
      });
    }catch(e){ /* حتى لو فشل الاتصال، نكمّل تسجيل الخروج محلياً بالأسفل */ }
    currentUser = null;
    currentUserRole = 'staff';
    SERVER_AUTH_TOKEN = null;
    SERVER_AUTH_USERNAME = null;
    SERVER_AUTH_ROLE = null;
    try{
      sessionStorage.removeItem('serverAuthToken');
      sessionStorage.removeItem('serverAuthUsername');
      sessionStorage.removeItem('serverAuthRole');
    }catch(e){ console.error('[Finance] Failed to clear session on logout:', e); }
    $('#app-wrap').style.display = 'none';
    showServerLoginScreen(null);
  }
});

