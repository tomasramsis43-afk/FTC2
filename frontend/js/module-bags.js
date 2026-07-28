/* ---------------- Bags / Inventory ---------------- */
/* إعادة احتساب دفتر تمويل مخزون الحقائب بالكامل من البداية، بحيث تبقى النتائج صحيحة
   حتى لو تم حذف عملية قديمة من المنتصف. السجلات القديمة (بدون type) تُعامل كإضافة
   كمية ثابتة يدوياً كما كانت سابقاً، دون التأثير على الرصيد. */
function recalcBagFundLedger(){
  const price = num(settings.bagPrice) || DEFAULT_SETTINGS.bagPrice;
  let bags = 0, balance = 0;
  const sorted = bagStock.slice().sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  sorted.forEach(entry=>{
    if(!entry.type){
      bags += num(entry.qty);
      entry.balanceBefore = balance;
      entry.balanceAfter = balance;
      return;
    }
    entry.balanceBefore = balance;
    if(entry.manualQty){
      // عدد الحقائب أُدخل يدوياً من المستخدم كرقم فعلي حقيقي (مثلاً من فاتورة شراء) — يُعتمد كما هو ولا يُعاد
      // اشتقاقه من المبلغ وسعر الحقيبة الحالي، حتى لا يتأثر "المخزون الحالي" بأي تغيير لاحق في السعر بالإعدادات.
      // "سعر الوحدة" هنا يُحسب من المبلغ الفعلي المدخل (إن وُجد) لتبقى "إجمالي المصروف على الحقائب" دقيقة أيضاً،
      // ولا نلمس الرصيد التراكمي (balance) لأن هذه العملية غير مرتبطة بآلية "تجميع مبالغ جزئية حتى تكتمل حقيبة".
      const qtySigned = entry.type==='withdraw' ? -Math.abs(entry.manualQty) : Math.abs(entry.manualQty);
      entry.qty = qtySigned;
      entry.unitPrice = entry.amount ? Math.round((num(entry.amount)/Math.abs(entry.manualQty))*10000)/10000 : price;
      bags += qtySigned;
      entry.balanceAfter = balance;
      return;
    }
    if(entry.type==='withdraw'){
      const totalValue = bags*price + balance - num(entry.amount);
      const newBags = Math.floor(totalValue/price);
      entry.qty = newBags - bags;
      entry.unitPrice = price;
      bags = newBags;
      balance = totalValue - newBags*price;
    }else if(entry.type==='issue'){
      // تسليم حقيبة لعميل من المخزون: ينقص عدد الحقائب المتاحة فقط بمقدار حقيبة واحدة، دون أي أثر على الرصيد المالي
      // أو على "إجمالي المصروف على الحقائب" (قيمتها محتسبة أصلاً ضمن مشتريات المخزون السابقة عبر عمليات الإيداع،
      // وتسليمها لعميل ليس عملية شراء أو صرف مالي جديد)
      entry.qty = -1;
      entry.unitPrice = 0;
      bags -= 1;
      entry.balanceAfter = balance;
      return;
    }else{
      const combined = balance + num(entry.amount);
      const addedBags = Math.floor(combined/price);
      entry.qty = addedBags;
      entry.unitPrice = price;
      bags += addedBags;
      balance = combined - addedBags*price;
    }
    entry.balanceAfter = balance;
  });
  settings.bagFundBalance = Math.round(balance*100)/100;
  return bags;
}
function bagStockTotals(){
  // نحسب صافي حركات التمويل الفعلية فقط (إيداع/سحب) من سجل مخزون الحقائب — أي سجلات "تسليم" (issue)
  // قديمة متبقية من نسخ سابقة يتم تجاهلها هنا، لأن الخصم الفعلي أصبح مرتبطاً ربطاً مباشراً وكاملاً
  // بعدد العملاء الذين حالتهم "bagSource==='stock'" في شيت العملاء نفسه — وهو بالضبط نفس المصدر الذي
  // يُبنى منه "سجل عمليات شراء الحقائب المكتملة للعملاء". بهذا يبقى "المخزون الحالي" مطابقاً دائماً لذلك
  // السجل تلقائياً، بغض النظر عن الشاشة أو الاستيراد الذي سجّل عملية الشراء (شيت العملاء، شيت الدورات
  // عبر خانة الشراء السريعة، الاستيراد الجماعي لبيانات العملاء، استيراد متدربين حوالة شركة... أو أي شاشة مستقبلية)،
  // دون الحاجة لأي مزامنة يدوية أو سجل وسيط.
  const fundingQty = bagStock.reduce((s,x)=> x.type==='issue' ? s : s+num(x.qty), 0);
  const spentBulk = bagStock.reduce((s,x)=> x.type==='issue' ? s : s+num(x.qty)*num(x.unitPrice), 0);
  const issuedToClients = clients.filter(c=>c.bagSource==='stock' && !c.suspended).length;
  const purchasedQty = fundingQty - issuedToClients;
  return {purchasedQty, spentBulk, fundingQty, issuedToClients};
}
function bagStockFiltered(){
  const dfrom = $('#bst-date-from')?.value || '';
  const dto = $('#bst-date-to')?.value || '';
  // نستبعد عمليات "تسليم لعميل من المخزون" (type==='issue') من سجل التمويل نفسه وتصديره ومجموع الفترة:
  // هذا السجل مخصص لحركات التمويل الفعلية (إيداع/سحب) فقط. الخصم الفعلي من "المخزون الحالي" يبقى يعمل
  // كالمعتاد لأنه يُحسب من bagStockTotals() على كامل السجل بدون هذا الفلتر.
  return bagStock.filter(b=>{
    if(b.type==='issue') return false;
    if(dfrom && (!b.date || b.date<dfrom)) return false;
    if(dto && (!b.date || b.date>dto)) return false;
    return true;
  });
}
let pendingBagsPageState = {page:1, sig:''};
let bagStockPageState = {page:1, sig:''};
function renderBagFinanceLinkToggle(){
  const btn = $('#btn-toggle-bagfinancelink');
  const status = $('#bagfinancelink-status');
  if(!btn || !status) return;
  const enabled = settings.bagFinanceLinkEnabled!==false;
  status.textContent = enabled ? '✅ الربط مُفعَّل حالياً' : '⛔ الربط مُلغى حالياً';
  status.style.color = enabled ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)';
  btn.textContent = enabled ? 'إلغاء الربط' : 'تفعيل الربط';
  btn.className = enabled ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
}
$('#btn-toggle-bagfinancelink').addEventListener('click', async ()=>{
  const enabled = settings.bagFinanceLinkEnabled!==false;
  settings.bagFinanceLinkEnabled = !enabled;
  await saveSettings();
  await logAudit('edit','الإعدادات', settings.bagFinanceLinkEnabled
    ? 'تم تفعيل ربط عمليات مخزون الحقائب بالحركات المالية تلقائياً'
    : 'تم إلغاء ربط عمليات مخزون الحقائب بالحركات المالية تلقائياً (العمليات الجديدة لن تُنشئ حركات مالية، والحركات القديمة تبقى كما هي)');
  renderBagFinanceLinkToggle();
  showToast(settings.bagFinanceLinkEnabled ? 'تم تفعيل الربط' : 'تم إلغاء الربط');
});

/* ---------------- ربط Power Automate (Webhooks) ----------------
   إرسال أحداث تلقائياً (POST بصيغة JSON) لرابط HTTP Trigger من Power Automate عند حدوث أحداث معيّنة.
   الإرسال يتم بطريقة "fire-and-forget" (mode:'no-cors') لتفادي مشاكل CORS الشائعة مع روابط Power Automate،
   وبالتالي لا يمكن للبرنامج معرفة نجاح الإرسال من عدمه — يُنصح بمراجعة سجل تشغيل الـ Flow للتأكد. */
async function sendPowerAutomateEvent(eventType, payload){
  const cfg = settings.powerAutomate;
  if(!cfg || !cfg.webhookUrl) return;
  if(eventType==='new_client' && cfg.notifyNewClient===false) return;
  if(eventType==='course_number_updated' && cfg.notifyCourseNumber===false) return;
  try{
    await fetch(cfg.webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: {'Content-Type':'text/plain'},
      body: JSON.stringify({event: eventType, timestamp: new Date().toISOString(), data: payload})
    });
  }catch(err){
    console.warn('تعذّر إرسال حدث Power Automate:', err);
  }
}
$('#btn-save-pa-webhook').addEventListener('click', async ()=>{
  settings.powerAutomate = {
    webhookUrl: $('#set-pa-webhook-url').value.trim(),
    notifyNewClient: $('#set-pa-notify-newclient').checked,
    notifyCourseNumber: $('#set-pa-notify-coursenum').checked
  };
  await saveSettings();
  await logAudit('edit','الإعدادات', 'تم تحديث إعدادات ربط Power Automate');
  showToast('تم حفظ إعدادات Power Automate');
});
$('#btn-test-pa-webhook').addEventListener('click', async ()=>{
  const url = $('#set-pa-webhook-url').value.trim();
  if(!url){ showToast('أدخل رابط Webhook أولاً'); return; }
  try{
    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: {'Content-Type':'text/plain'},
      body: JSON.stringify({event:'test', timestamp: new Date().toISOString(), data:{message:'رسالة اختبار من برنامج المركز'}})
    });
    showToast('تم إرسال طلب الاختبار — تحقّق من سجل تشغيل الـ Flow في Power Automate للتأكد من الاستلام');
  }catch(err){
    showToast('تعذّر إرسال طلب الاختبار — تأكد من صحة الرابط');
  }
});

function renderBags(){
  $('#set-bagprice').value = settings.bagPrice;
  renderBagFinanceLinkToggle();
  if($('#bs-fixed-price')) $('#bs-fixed-price').textContent = fmt(num(settings.bagPrice));
  if($('#bs-current-balance')) $('#bs-current-balance').textContent = fmt(num(settings.bagFundBalance));
  if($('#bs-date') && !$('#bs-date').value) $('#bs-date').value = todayISO();
  // طرق الدفع الموحدة (نفس طرق الدفع المُعرَّفة في الإعدادات — يطابق شيت "الحركات المالية")
  if($('#bs-method')){
    const bsMethodVal = $('#bs-method').value;
    populateSelect($('#bs-method'), settings.channels.map(c=>c.name), false);
    if(settings.channels.some(c=>c.name===bsMethodVal)) $('#bs-method').value = bsMethodVal;
    else { const vaultCh = settings.channels.find(c=>c.dest==='vault'); $('#bs-method').value = vaultCh ? vaultCh.name : settings.channels[0]?.name || ''; }
  }

  const pendingBuy = clients.filter(c=>c.bagSource==='buy' && c.bagStatus!=='purchased' && !c.suspended);
  const purchasedBuy = clients.filter(c=>c.bagSource==='buy' && c.bagStatus==='purchased' && !c.suspended);
  const ownBag = clients.filter(c=>c.bagSource==='own' && !c.suspended);
  const {purchasedQty, spentBulk} = bagStockTotals();
  const availableStock = purchasedQty;
  const spentDirect = purchasedBuy.reduce((s,c)=>s+num(c.bagPrice),0);
  const totalSpent = spentBulk + spentDirect;
  const totalCollected = clients.reduce((s,c)=>s+bagAmount(c),0);

  $('#bag-cards').innerHTML = `
    <div class="card">
      <div class="k" style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
        <span>المخزون الحالي</span>
        <button type="button" class="btn btn-ghost btn-sm" data-refresh-bagstock style="padding:1px 8px; font-size:11px; line-height:1.6;" title="إعادة حساب كل أرقام الحقائب من جديد من مصدرها الفعلي">↻ تحديث</button>
      </div>
      <div class="v ${availableStock<0?'red':''}">${availableStock}</div>
    </div>
    <div class="card"><div class="k">حقائب مطلوب شراؤها</div><div class="v red">${pendingBuy.length}</div></div>
    <div class="card"><div class="k">عملاء وفّروا بحقيبتهم الخاصة</div><div class="v teal">${ownBag.length}</div></div>
    <div class="card"><div class="k">إجمالي المصروف على الحقائب</div><div class="v gold">${fmt(totalSpent)}</div></div>
    <div class="card"><div class="k">حصيلة الحقائب من العملاء</div><div class="v">${fmt(totalCollected)}</div></div>
    <div class="card"><div class="k">الفرق (محصّل - مصروف)</div><div class="v ${ (totalCollected-totalSpent) < 0 ? 'red':''}">${fmt(totalCollected-totalSpent)}</div></div>
  `;

  const pendingBagsSearchTerm = ($('#pending-bags-search')?.value || '').trim();
  const pendingBuyFiltered = (pendingBagsSearchTerm
    ? pendingBuy.filter(c=>String(c.clientId||'').includes(pendingBagsSearchTerm))
    : pendingBuy
  ).slice().sort((a,b)=> (b.date||'').localeCompare(a.date||''));

  if($('#pending-bags-total')){
    const pendingBuyTotalValue = pendingBuyFiltered.reduce((s,c)=>s+num(c.bagPrice),0);
    $('#pending-bags-total').innerHTML = `العدد: <span style="color:var(--red);">${pendingBuyFiltered.length}</span> — القيمة الإجمالية: <span style="color:var(--red);">${fmt(pendingBuyTotalValue)}</span>`;
  }

  const pendingBagsPageRows = applyGenericPagination('pendingbags', pendingBuyFiltered, pendingBagsPageState, [
    pendingBagsSearchTerm
  ]);
  $('#pending-bags-table').innerHTML = pendingBuyFiltered.length ? `
    <div class="table-scroll cards-mobile">
    <table>
      <thead><tr><th>العميل</th><th>رقم الهوية</th><th>رقم الهاتف</th><th>الرقم المرجعي</th><th>الدورة</th><th>تاريخ التسجيل</th><th>قيمة الحقيبة</th><th></th></tr></thead>
      <tbody>${pendingBagsPageRows.map(c=>`
        <tr>
          <td data-label="العميل">${escapeHtml(c.name)}</td>
          <td class="mono" data-label="رقم الهوية">${escapeHtml(c.clientId||'—')}</td>
          <td class="mono" data-label="رقم الهاتف">${escapeHtml(c.phone||'—')}</td>
          <td class="mono" data-label="الرقم المرجعي">${escapeHtml(c.referNum||'—')}</td>
          <td data-label="الدورة">${escapeHtml(c.courseType||'')}</td>
          <td class="mono" data-label="تاريخ التسجيل">${formatDateDisplay(c.date)||'—'}</td>
          <td class="mono" data-label="قيمة الحقيبة">${fmt(num(c.bagPrice))}</td>
          <td class="card-full" data-label="" style="white-space:nowrap;">
            <button class="btn btn-ghost btn-sm" data-fromstock="${c.id}">تسليم من المخزون</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>
    </div>` : `<div class="empty-state" style="padding:20px;">لا توجد حقائب معلّقة — كل الحقائب المطلوبة تم شراؤها 👍</div>`;

  const bagStockRows = bagStockFiltered().slice().reverse();
  if($('#bagstock-period-deposit-total')){
    const periodNetQty = bagStockFiltered().reduce((s,b)=>s+num(b.qty),0);
    $('#bagstock-period-deposit-total').textContent = periodNetQty;
  }
  const bagStockPageRows = applyGenericPagination('bagstock', bagStockRows, bagStockPageState, [
    $('#bst-date-from')?.value, $('#bst-date-to')?.value
  ]);
  $('#bag-stock-body').innerHTML = bagStockRows.length ? bagStockPageRows.map(b=>{
    const typeLabel = (b.type==='withdraw' ? 'سحب' : (b.type==='deposit' ? 'إيداع' : (b.type==='issue' ? 'تسليم لعميل من المخزون' : 'إضافة يدوية (سجل قديم)'))) + (b.manualQty ? ' (عدد فعلي)' : '');
    const typeColor = b.type==='withdraw' ? 'red' : (b.type==='deposit' ? 'teal' : (b.type==='issue' ? 'red' : ''));
    const qtyDisplay = num(b.qty)>0 ? `+${b.qty}` : `${b.qty}`;
    const amountDisplay = b.amount!==undefined ? fmt(num(b.amount)) : fmt(num(b.qty)*num(b.unitPrice));
    return `
    <tr>
      <td class="mono" data-label="التاريخ">${b.date||'—'}</td>
      <td class="${typeColor}" data-label="النوع">${typeLabel}</td>
      <td class="mono" data-label="المبلغ">${amountDisplay}</td>
      <td class="mono ${num(b.qty)<0?'red':''}" data-label="الكمية">${qtyDisplay}</td>
      <td class="mono" data-label="الرصيد بعدها">${b.balanceAfter!==undefined ? fmt(num(b.balanceAfter)) : '—'}</td>
      <td data-label="طريقة الدفع">${escapeHtml(b.method||'')}</td>
      <td data-label="ملاحظات">${escapeHtml(b.notes||'')}</td>
      <td class="card-full" data-label="" style="white-space:nowrap;">
        ${b.type && b.type!=='issue' ? `<button class="btn btn-ghost btn-sm" data-editstock="${b.id}">${tr('edit')}</button>` : ''}
        <button class="btn btn-danger btn-sm" data-delstock="${b.id}">${tr('delete')}</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد عمليات تمويل مسجّلة</td></tr>`;

  const methodTotals = {};
  bagStock.forEach(b=>{ const k=b.method||'غير محدد'; methodTotals[k]=(methodTotals[k]||0)+num(b.qty)*num(b.unitPrice); });
  purchasedBuy.forEach(c=>{ const k=c.bagPaymentMethod||'غير محدد'; methodTotals[k]=(methodTotals[k]||0)+num(c.bagPrice); });
  drawBars('#chart-bag-method', Object.entries(methodTotals).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]));

  renderClientBagPurchases();
  renderOwnBagClients();
}

/* سجل العملاء الذين وفّروا حقيبتهم الخاصة (bagSource === 'own') */
function ownBagClientsFiltered(){
  const q = ($('#ownbag-search')?.value || '').trim().toLowerCase();
  const year = $('#ownbag-year-filter')?.value || '';
  let rows = clients.filter(c=>c.bagSource==='own' && !c.suspended);
  if(q){
    rows = rows.filter(c=> [c.name,c.clientId,c.phone].some(v=> String(v||'').toLowerCase().includes(q)));
  }
  if(year) rows = rows.filter(c=> c.date && c.date.slice(0,4)===year);
  rows.sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  return rows;
}
function populateOwnBagYearFilter(){
  const sel = $('#ownbag-year-filter');
  if(!sel) return;
  const years = new Set();
  clients.forEach(c=>{
    if(c.bagSource==='own' && !c.suspended && c.date && c.date.length>=4) years.add(c.date.slice(0,4));
  });
  const sortedYears = [...years].sort((a,b)=>b.localeCompare(a));
  const current = sel.value;
  sel.innerHTML = '<option value="">كل السنوات</option>' + sortedYears.map(y=>`<option value="${y}">${y}</option>`).join('');
  if(sortedYears.includes(current)) sel.value = current;
}
let ownbagPageState = {page:1, sig:''};
function renderOwnBagClients(){
  const body = $('#own-bag-clients-body');
  if(!body) return;
  populateOwnBagYearFilter();
  const rows = ownBagClientsFiltered();
  if($('#ownbag-total')) $('#ownbag-total').innerHTML = `العدد: <span style="color:var(--teal);">${rows.length}</span>`;
  const pageRows = applyGenericPagination('ownbag', rows, ownbagPageState, [$('#ownbag-search')?.value, $('#ownbag-year-filter')?.value]);
  body.innerHTML = rows.length ? pageRows.map(c=>`
    <tr>
      <td data-label="الاسم">${escapeHtml(c.name||'—')}</td>
      <td class="mono" data-label="رقم الهوية">${escapeHtml(c.clientId||'—')}</td>
      <td data-label="الجنسية">${escapeHtml(c.nationality||'—')}</td>
      <td class="mono" data-label="رقم الهاتف">${escapeHtml(c.phone||'—')}</td>
      <td data-label="الدورة">${escapeHtml(c.courseType||'—')}</td>
      <td class="mono" data-label="رقم الفاتورة">${escapeHtml(c.invoice||'—')}</td>
      <td class="mono" data-label="تاريخ التسجيل">${formatDateDisplay(c.date)||'—'}</td>
    </tr>`).join('') : `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">لا يوجد عملاء وفّروا حقيبتهم الخاصة</td></tr>`;
}
onSearchInput('#ownbag-search', renderOwnBagClients);
$('#ownbag-year-filter')?.addEventListener('change', renderOwnBagClients);
bindGenericPagination('ownbag', ownbagPageState, renderOwnBagClients);
$('#btn-export-ownbag')?.addEventListener('click', ()=>{
  const headers = ['الاسم','رقم الهوية','الجنسية','رقم الهاتف','الدورة','رقم الفاتورة','تاريخ التسجيل'];
  const rows = ownBagClientsFiltered().map(c=>[c.name,c.clientId,c.nationality,c.phone,c.courseType,c.invoice,c.date]);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'عملاء_حقائبهم_الخاصة.csv';
  a.click();
});

/* سجل موحّد لكل عميل حصل على حقيبته فعلياً — سواء بالشراء المباشر (شيت العملاء) أو بالتسليم من المخزون
   المموَّل (شيت مخزون الحقائب) — يجمعهما في مكان واحد بغض النظر عن أي شيت جاءت منه العملية. */
function clientBagPurchasesFiltered(){
  const q = ($('#cbp-search')?.value || '').trim().toLowerCase();
  const dfrom = $('#cbp-date-from')?.value || '';
  const dto = $('#cbp-date-to')?.value || '';
  const year = $('#cbp-year-filter')?.value || '';
  let rows = clients.filter(c=> ((c.bagSource==='buy' && c.bagStatus==='purchased') || c.bagSource==='stock') && !c.suspended);
  if(q){
    rows = rows.filter(c=> [c.name,c.clientId,c.phone,c.bagInvoice].some(v=> String(v||'').toLowerCase().includes(q)));
  }
  rows = rows.map(c=>({
    c,
    purchaseDate: c.bagPurchaseDate || (c.bagSource==='stock' ? c.date : '')
  }));
  if(dfrom) rows = rows.filter(r=> r.purchaseDate && r.purchaseDate>=dfrom);
  if(dto) rows = rows.filter(r=> r.purchaseDate && r.purchaseDate<=dto);
  if(year) rows = rows.filter(r=> r.purchaseDate && r.purchaseDate.slice(0,4)===year);
  rows.sort((a,b)=> (b.purchaseDate||'').localeCompare(a.purchaseDate||''));
  return rows;
}
function populateCbpYearFilter(){
  const sel = $('#cbp-year-filter');
  if(!sel) return;
  const years = new Set();
  clients.forEach(c=>{
    if(!(((c.bagSource==='buy' && c.bagStatus==='purchased') || c.bagSource==='stock') && !c.suspended)) return;
    const d = c.bagPurchaseDate || (c.bagSource==='stock' ? c.date : '');
    if(d && d.length>=4) years.add(d.slice(0,4));
  });
  const sortedYears = [...years].sort((a,b)=>b.localeCompare(a));
  const current = sel.value;
  sel.innerHTML = '<option value="">كل السنوات</option>' + sortedYears.map(y=>`<option value="${y}">${y}</option>`).join('');
  if(sortedYears.includes(current)) sel.value = current;
}
let cbpPageState = {page:1, sig:''};
function renderClientBagPurchases(){
  const body = $('#client-bag-purchases-body');
  if(!body) return;
  populateCbpYearFilter();
  const rows = clientBagPurchasesFiltered();
  if($('#cbp-total')){
    const cbpTotalValue = rows.reduce((s,{c})=>s+num(c.bagPrice),0);
    $('#cbp-total').innerHTML = `العدد: <span style="color:var(--gold-dark);">${rows.length}</span> — القيمة الإجمالية: <span style="color:var(--gold-dark);">${fmt(cbpTotalValue)}</span>`;
  }
  const pageRows = applyGenericPagination('cbp', rows, cbpPageState, [
    $('#cbp-search')?.value, $('#cbp-date-from')?.value, $('#cbp-date-to')?.value, $('#cbp-year-filter')?.value
  ]);
  body.innerHTML = rows.length ? pageRows.map(({c,purchaseDate})=>`
    <tr>
      <td>${escapeHtml(c.name||'—')}</td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td>${escapeHtml(c.nationality||'—')}</td>
      <td class="mono">${escapeHtml(c.phone||'—')}</td>
      <td class="mono"><input type="text" class="cbp-invoice-input" data-invoice-id="${c.id}" value="${escapeHtml(c.bagInvoice||'')}" placeholder="رقم الفاتورة" style="width:120px;"></td>
      <td class="mono">${escapeHtml(purchaseDate||'—')}</td>
      <td><span class="stamp ${c.bagSource==='stock' ? 'teal':'paid'}">${c.bagSource==='stock' ? 'من المخزون' : 'شراء مباشر'}</span></td>
    </tr>`).join('') : `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد عمليات شراء حقائب مكتملة بعد</td></tr>`;
}
onSearchInput('#cbp-search', renderClientBagPurchases);
bindGenericPagination('cbp', cbpPageState, renderClientBagPurchases);
onSearchInput('#pending-bags-search', renderBags);
bindGenericPagination('pendingbags', pendingBagsPageState, renderBags);
bindGenericPagination('bagstock', bagStockPageState, renderBags);
$('#btn-export-pending-bags')?.addEventListener('click', ()=>{
  const pendingBagsSearchTerm = ($('#pending-bags-search')?.value || '').trim();
  const rows = clients.filter(c=>c.bagSource==='buy' && c.bagStatus!=='purchased' && !c.suspended)
    .filter(c=> !pendingBagsSearchTerm || String(c.clientId||'').includes(pendingBagsSearchTerm))
    .slice().sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  const headers = ['العميل','رقم الهوية','رقم الهاتف','الرقم المرجعي','الدورة','تاريخ التسجيل','قيمة الحقيبة'];
  const csvRows = rows.map(c=>[c.name,c.clientId,c.phone,c.referNum,c.courseType,c.date,num(c.bagPrice)]);
  const csv = '\uFEFF'+[headers, ...csvRows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'حقائب_يجب_شراؤها.csv';
  a.click();
});
$('#cbp-date-from')?.addEventListener('input', renderClientBagPurchases);
$('#cbp-date-to')?.addEventListener('input', renderClientBagPurchases);
$('#cbp-year-filter')?.addEventListener('change', renderClientBagPurchases);
// حفظ رقم فاتورة الحقيبة مباشرة من داخل جدول "سجل عمليات شراء الحقائب المكتملة" — بدون الحاجة لملف Excel
$('#client-bag-purchases-body')?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && e.target.classList.contains('cbp-invoice-input')) e.target.blur();
});
$('#client-bag-purchases-body')?.addEventListener('change', async e=>{
  const inp = e.target.closest('.cbp-invoice-input');
  if(!inp) return;
  const idx = clients.findIndex(c=>c.id===inp.dataset.invoiceId);
  if(idx<0) return;
  const newVal = inp.value.trim();
  if((clients[idx].bagInvoice||'') === newVal) return;
  snapshotState(`تعديل رقم فاتورة الحقيبة: ${clients[idx].name}`);
  clients[idx].bagInvoice = newVal;
  await saveClients();
  await logAudit('edit','سجل شراء الحقائب', `تم تحديث رقم فاتورة الحقيبة للعميل ${clients[idx].name} إلى "${newVal||'—'}"`);
  showToast('تم حفظ رقم الفاتورة');
});
$('#bst-date-from')?.addEventListener('input', renderBags);
$('#bst-date-to')?.addEventListener('input', renderBags);
$('#btn-export-bagstock')?.addEventListener('click', ()=>{
  const headers = ['التاريخ','النوع','المبلغ','عدد الحقائب (+/-)','الرصيد بعد العملية','طريقة الدفع','ملاحظات'];
  const rows = bagStockFiltered().map(b=>{
    const typeLabel = (b.type==='withdraw' ? 'سحب' : (b.type==='deposit' ? 'إيداع' : (b.type==='issue' ? 'تسليم لعميل من المخزون' : 'إضافة يدوية (سجل قديم)'))) + (b.manualQty ? ' (عدد فعلي)' : '');
    const amountDisplay = b.amount!==undefined ? num(b.amount) : num(b.qty)*num(b.unitPrice);
    return [b.date,typeLabel,amountDisplay,b.qty,b.balanceAfter!==undefined?num(b.balanceAfter):'',b.method||'',b.notes||''];
  });
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'تمويل_مخزون_الحقائب.csv';
  a.click();
});
$('#btn-export-cbp')?.addEventListener('click', ()=>{
  const headers = ['الاسم','رقم الهوية','الجنسية','رقم الهاتف','رقم فاتورة الحقيبة','تاريخ الشراء','المصدر'];
  const rows = clientBagPurchasesFiltered().map(({c,purchaseDate})=>[c.name,c.clientId,c.nationality,c.phone,c.bagInvoice,purchaseDate,c.bagSource==='stock'?'من المخزون':'شراء مباشر']);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'حقائب_العملاء.csv';
  a.click();
});

function openBagStockEdit(id){
  const entry = bagStock.find(b=>b.id===id);
  if(!entry || !entry.type) return;
  editingBagStockId = id;
  $('#bs-type').value = entry.type;
  $('#bs-date').value = entry.date || todayISO();
  $('#bs-amount').value = entry.amount ?? '';
  $('#bs-qty').value = entry.manualQty ?? '';
  populateSelect($('#bs-method'), settings.channels.map(c=>c.name), false);
  {
    const bsEditVal = entry.method || '';
    if(settings.channels.some(c=>c.name===bsEditVal)) $('#bs-method').value = bsEditVal;
    else { const vaultCh = settings.channels.find(c=>c.dest==='vault'); $('#bs-method').value = vaultCh ? vaultCh.name : settings.channels[0]?.name || ''; }
  }
  $('#bs-notes').value = entry.notes || '';
  $('#btn-add-stock').textContent = 'حفظ التعديل';
  $('#btn-cancel-edit-stock').style.display = '';
  $('#bs-type').closest('.panel').scrollIntoView({behavior:'smooth', block:'start'});
}
function cancelBagStockEdit(){
  editingBagStockId = null;
  $('#bs-amount').value=''; $('#bs-qty').value=''; $('#bs-notes').value='';
  $('#btn-add-stock').textContent = 'تسجيل العملية';
  $('#btn-cancel-edit-stock').style.display = 'none';
}
$('#btn-cancel-edit-stock').addEventListener('click', cancelBagStockEdit);

$('#btn-add-stock').addEventListener('click', async ()=>{
  const type = $('#bs-type').value; // deposit | withdraw
  const amount = num($('#bs-amount').value);
  if(amount<=0){ showToast('أدخل مبلغاً صحيحاً'); return; }
  const price = num(settings.bagPrice) || DEFAULT_SETTINGS.bagPrice;
  const method = $('#bs-method').value;
  const date = $('#bs-date').value || todayISO();
  const notes = $('#bs-notes').value.trim();
  const isEditing = !!editingBagStockId;
  // عدد الحقائب الفعلي (اختياري): إن أُدخل، يُعتمد كما هو كرقم حقيقي ولا يُعاد اشتقاقه من المبلغ/السعر لاحقاً
  const qtyRaw = $('#bs-qty').value.trim();
  const manualQty = qtyRaw ? Math.abs(Math.round(num(qtyRaw))) : undefined;
  if(qtyRaw && (!manualQty || manualQty<=0)){ showToast('عدد الحقائب الفعلي يجب أن يكون رقماً صحيحاً أكبر من صفر'); return; }

  if(type==='withdraw'){
    const currentBags = bagStockTotals().purchasedQty;
    let currentTotalValue = currentBags*price + num(settings.bagFundBalance);
    if(isEditing){
      // عند التعديل، أضف مرة أخرى قيمة العملية القديمة قبل المقارنة (لأنها ستُحذف ثم تُعاد بالقيم الجديدة)
      const oldEntry = bagStock.find(b=>b.id===editingBagStockId);
      if(oldEntry) currentTotalValue += num(oldEntry.qty)*price;
    }
    if(amount > currentTotalValue){
      if(!await customConfirm(`المبلغ المسحوب (${fmt(amount)}) أكبر من إجمالي الرصيد المتاح حالياً لتمويل الحقائب (${fmt(currentTotalValue)}). سيؤدي هذا إلى عجز في مخزون الحقائب. هل تريد المتابعة؟`)) return;
    }
  }

  let addedEntry;
  if(isEditing){
    const idx = bagStock.findIndex(b=>b.id===editingBagStockId);
    if(idx===-1){ showToast('تعذّر إيجاد العملية المطلوب تعديلها'); cancelBagStockEdit(); return; }
    snapshotState(`تعديل عملية في سجل تمويل مخزون الحقائب: ${fmt(amount)} ﷼`);
    // احذف أي حركة خزنة مرتبطة بالعملية القديمة قبل التعديل، وسيُعاد إنشاؤها بالقيم الجديدة أدناه إن لزم
    const oldLinkedTx = vaultTx.find(t=>t.bagStockRef===bagStock[idx].id);
    if(oldLinkedTx){
      if(isDateLocked(oldLinkedTx.date)){ showToast('تعذّر التعديل: الحركة القديمة المرتبطة تقع ضمن فترة محاسبية مُقفلة'); return; }
      const removedOld = softDeleteVaultTx(oldLinkedTx.id, 'استُبدلت تلقائياً بعد تعديل عملية تمويل مخزون الحقائب المرتبطة بها');
      await saveVaultTx();
      await saveDeletedVaultTx();
      await logAudit('delete','الحركات المالية', `تم إلغاء (حذف منطقي) حركة خزنة قديمة رقم تسلسلي #${removedOld.seq||'—'} مرتبطة بعملية تمويل حقائب قبل تعديلها: ${fmt(num(removedOld.amount))} ﷼`);
    }
    bagStock[idx] = { ...bagStock[idx], type, date, amount, method, notes, manualQty };
    addedEntry = bagStock[idx];
  }else{
    snapshotState(type==='withdraw' ? `سحب مبلغ من حساب الحقائب: ${fmt(amount)}` : `إيداع مبلغ في حساب الحقائب: ${fmt(amount)}`);
    bagStock.push({
      id: uid(), createdBy: currentUser,
      createdAt: Date.now(),
      type,
      date,
      amount,
      method,
      notes,
      manualQty
    });
    addedEntry = bagStock[bagStock.length-1];
  }
  recalcBagFundLedger();
  await saveBagStock();
  await saveSettings();

  if(type==='withdraw'){
    await logAudit('edit','مخزون الحقائب', `${isEditing?'تم تعديل عملية سحب لتصبح':'تم سحب'} ${fmt(amount)} ﷼ من حساب تمويل الحقائب، ما أدى إلى خصم ${Math.abs(addedEntry.qty)} حقيبة من المخزون (الرصيد المتبقي: ${fmt(settings.bagFundBalance)})`);
    // تُرحَّل الحركة إلى "الحركات المالية" كإضافة (وارد) لرصيد الخزنة (كاش) فقط إذا كان السحب "سحب نقدي"
    // (أي أن المبلغ خرج من حساب تمويل الحقائب وعاد كاشاً فعلياً للخزنة). أي طريقة سحب أخرى (سحب من الحساب
    // البنكي مثلاً) لا تُرحَّل لأن المبلغ لم يدخل فعلياً لرصيد الخزنة النقدي.
    if(method==='سحب نقدي' && settings.bagFinanceLinkEnabled!==false){
      const cashInTx = {
        id: uid(), seq: allocVaultSeq('vault'), createdAt: Date.now(),
        type: 'in', date, amount, method,
        notes: `سحب نقدي من حساب تمويل مخزون الحقائب${notes ? ' — '+notes : ''}`,
        clientId: '', clientName: '', manual: 'سحب نقدي من مخزون الحقائب',
        category: 'تمويل مخزون الحقائب (سحب نقدي)', destination: 'vault', networkInvoice: '',
        bagStockRef: addedEntry.id
      };
      vaultTx.push(cashInTx);
      await saveVaultTx();
      await saveSettings();
      await logAudit('add','الحركات المالية', `تمت إضافة حركة وارد رقم تسلسلي #${cashInTx.seq}: إضافة ${fmt(amount)} ﷼ لرصيد الخزنة (كاش) من سحب نقدي من حساب تمويل مخزون الحقائب`);
    }
  }else{
    if(addedEntry.qty>0){
      await logAudit(isEditing?'edit':'add','مخزون الحقائب', `${isEditing?'تم تعديل عملية إيداع، وأصبحت تضيف':'تمت إضافة'} ${addedEntry.qty} حقيبة للمخزون من إيداع ${fmt(amount)} ﷼ (الرصيد المتبقي: ${fmt(settings.bagFundBalance)})`);
    }else{
      await logAudit(isEditing?'edit':'add','مخزون الحقائب', `${isEditing?'تم تعديل عملية إيداع، وأصبح':'تم تسجيل'} إيداع ${fmt(amount)} ﷼ لحساب الحقائب — لم يكتمل بعد لشراء حقيبة كاملة (الرصيد الحالي: ${fmt(settings.bagFundBalance)})`);
    }
    // تُرحَّل الحركة إلى "الحركات المالية" كخصم من رصيد الخزنة (كاش) إذا كان الإيداع "كاش في الحساب البنكي"
    // أو "كاش مباشر" (أي أن المبلغ كان كاشاً خرج فعلياً من الخزنة). أي طريقة دفع أخرى (تحويل بنكي، دعم شركاء
    // أو غيرها) لا تُرحَّل لأن المبلغ لم يخرج فعلياً من رصيد الخزنة النقدي.
    if((method==='إيداع كاش في الحساب البنكي' || method==='كاش مباشر') && settings.bagFinanceLinkEnabled!==false){
      const cashOutTx = {
        id: uid(), seq: allocVaultSeq('vault'), createdAt: Date.now(),
        type: 'out', date, amount, method,
        notes: `إيداع نقدي (${method}) لتمويل مخزون الحقائب${notes ? ' — '+notes : ''}`,
        clientId: '', clientName: '', manual: '',
        category: 'تمويل مخزون الحقائب (إيداع كاش بالبنك)', destination: 'vault', networkInvoice: '',
        bagStockRef: addedEntry.id
      };
      vaultTx.push(cashOutTx);
      await saveVaultTx();
      await saveSettings();
      await logAudit('add','الحركات المالية', `تمت إضافة حركة صادر رقم تسلسلي #${cashOutTx.seq}: خصم ${fmt(amount)} ﷼ من رصيد الخزنة (كاش) مقابل تمويل مخزون الحقائب (${method})`);
    }
  }
  const wasEditing = isEditing;
  cancelBagStockEdit();
  renderBags();
  showToast(wasEditing ? 'تم حفظ التعديل' : 'تم تسجيل العملية');
});

/* ---------------- إضافة حركات تمويل مخزون الحقائب دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل الاستيراد من ملف Excel: نفس منطق الإدخال اليدوي من نموذج "تمويل مخزون الحقائب" أعلاه
   (بما في ذلك ترحيل أي مبلغ كاش فعلي من/إلى "الحركات المالية")، لكن عبر جدول صفوف متعددة داخل البرنامج. */
let bagfundBulkRowSeq = 0;
function bagfundBulkRowHtml(rowId){
  const methodOptions = (settings.channels||[]).map(c=>`<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  return `<tr data-row="${rowId}">
    <td><input type="date" class="bfb-date" data-col="0" style="min-width:120px;"></td>
    <td><select class="bfb-type" data-col="1" style="min-width:100px;">
      <option value="deposit">إيداع</option>
      <option value="withdraw">سحب</option>
    </select></td>
    <td><input type="number" step="0.01" min="0" class="bfb-amount" data-col="2" style="min-width:100px;"></td>
    <td><select class="bfb-method" data-col="3" style="min-width:140px;"><option value="">— افتراضي —</option>${methodOptions}</select></td>
    <td><input type="number" step="1" min="0" class="bfb-qty" data-col="4" placeholder="تلقائي" style="min-width:100px;"></td>
    <td><input type="text" class="bfb-notes" data-col="5" style="min-width:150px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm bfb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBagfundBulkRow(){
  bagfundBulkRowSeq++;
  $('#bagfund-bulk-table-body').insertAdjacentHTML('beforeend', bagfundBulkRowHtml(bagfundBulkRowSeq));
}
function openBagfundBulkModal(){
  $('#bagfund-bulk-table-body').innerHTML = '';
  populateSelect($('#bagfund-bulk-default-method'), settings.channels.map(c=>c.name), false);
  const bankCh = (settings.channels||[]).find(c=>c.dest==='bank');
  $('#bagfund-bulk-default-method').value = bankCh ? bankCh.name : (settings.channels[0]?.name||'');
  for(let i=0;i<5;i++) addBagfundBulkRow();
  const firstDate = $('#bagfund-bulk-table-body').querySelector('.bfb-date');
  if(firstDate) firstDate.value = todayISO();
  $('#bagfund-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeBagfundBulkModal(){ $('#bagfund-bulk-overlay').classList.remove('show'); }
$('#btn-open-bagfund-bulk').addEventListener('click', openBagfundBulkModal);
$('#bagfund-bulk-cancel').addEventListener('click', closeBagfundBulkModal);
$('#bagfund-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='bagfund-bulk-overlay') closeBagfundBulkModal(); });
$('#btn-bagfund-bulk-row').addEventListener('click', addBagfundBulkRow);
$('#bagfund-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('bfb-remove-row')){
    const rows = $('#bagfund-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#bagfund-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#bagfund-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBagfundBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>5) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT'){
        const opt = [...field.options].find(o=>o.value===val.trim() || o.textContent.trim()===val.trim());
        if(opt) field.value = opt.value;
      }else{
        field.value = val.trim();
      }
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bagfund-bulk-save').addEventListener('click', async ()=>{
  const defaultMethod = $('#bagfund-bulk-default-method').value;
  const rows = [...$('#bagfund-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  rows.forEach((row, i)=>{
    const dateVal = row.querySelector('.bfb-date').value.trim();
    const typeVal = row.querySelector('.bfb-type').value;
    const amountVal = num(row.querySelector('.bfb-amount').value);
    const methodVal = row.querySelector('.bfb-method').value.trim();
    const qtyVal = row.querySelector('.bfb-qty').value.trim();
    const notesVal = row.querySelector('.bfb-notes').value.trim();
    if(!dateVal && !amountVal && !notesVal) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(amountVal<=0){ errors.push(`${rowLabel}: المبلغ مطلوب ويجب أن يكون أكبر من صفر`); return; }
    if(!dateVal){ errors.push(`${rowLabel}: التاريخ مطلوب`); return; }
    const method = methodVal || defaultMethod;
    if(!method){ errors.push(`${rowLabel}: طريقة الدفع مطلوبة`); return; }
    const manualQty = qtyVal ? Math.abs(Math.round(num(qtyVal))) : undefined;
    items.push({ date: dateVal, type: typeVal, amount: amountVal, method, notes: notesVal, manualQty });
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`إضافة حركات تمويل مخزون الحقائب من جدول داخل البرنامج (${items.length} صف)`);
  let added=0;
  const changedRows = [];
  for(const {date, type, amount, method, notes, manualQty} of items){
    bagStock.push({ id: uid(), createdAt: Date.now(), createdBy: currentUser, type, date, amount, method, notes, manualQty });
    recalcBagFundLedger();
    await saveBagStock();
    await saveSettings();
    const addedEntry = bagStock[bagStock.length-1];

    if(type==='withdraw'){
      if(method==='سحب نقدي' && settings.bagFinanceLinkEnabled!==false){
        const cashInTx = {
          id: uid(), seq: allocVaultSeq('vault'), createdAt: Date.now(),
          type: 'in', date, amount, method,
          notes: `سحب نقدي من حساب تمويل مخزون الحقائب${notes ? ' — '+notes : ''}`,
          clientId: '', clientName: '', manual: 'سحب نقدي من مخزون الحقائب',
          category: 'تمويل مخزون الحقائب (سحب نقدي)', destination: 'vault', networkInvoice: '',
          bagStockRef: addedEntry.id
        };
        vaultTx.push(cashInTx);
        await saveVaultTx();
        await saveSettings();
      }
    }else{
      if((method==='إيداع كاش في الحساب البنكي' || method==='كاش مباشر') && settings.bagFinanceLinkEnabled!==false){
        const cashOutTx = {
          id: uid(), seq: allocVaultSeq('vault'), createdAt: Date.now(),
          type: 'out', date, amount, method,
          notes: `إيداع نقدي (${method}) لتمويل مخزون الحقائب${notes ? ' — '+notes : ''}`,
          clientId: '', clientName: '', manual: '',
          category: 'تمويل مخزون الحقائب (إيداع كاش بالبنك)', destination: 'vault', networkInvoice: '',
          bagStockRef: addedEntry.id
        };
        vaultTx.push(cashOutTx);
        await saveVaultTx();
        await saveSettings();
      }
    }
    added++;
    changedRows.push({'التاريخ':date, 'النوع':type==='withdraw'?'سحب':'إيداع', 'المبلغ':amount, 'طريقة الدفع':method, 'عدد الحقائب الفعلي (كما أُدخل)':manualQty||'', 'عدد الحقائب (+/-)':addedEntry.qty, 'الرصيد بعد العملية':addedEntry.balanceAfter, 'ملاحظات':notes});
  }
  await logAudit('add','مخزون الحقائب', `إضافة حركات تمويل مخزون الحقائب من جدول داخل البرنامج: تمت إضافة ${added} حركة جديدة (الرصيد المتبقي: ${fmt(settings.bagFundBalance)})`);
  renderBags(); renderReports();
  downloadXlsx(`تقرير_إضافة_تمويل_الحقائب_${stampNow()}.xlsx`, 'تقرير الإضافة', changedRows);
  closeBagfundBulkModal();
  showToast(`تمت إضافة ${added} حركة جديدة`);
});

document.addEventListener('click', async e=>{
  if(e.target.closest('[data-refresh-bagstock]')){
    // إعادة حساب كامل: نُزامن أولاً أي بيانات قديمة غير متسقة، ثم نعيد رسم كل بطاقات/جداول الحقائب
    // من مصدرها الفعلي (شيت العملاء + سجل التمويل)، ونعرض الرقم الفعلي الناتج فوراً للمستخدم.
    await syncBagStockIssues();
    renderBags();
    const {purchasedQty} = bagStockTotals();
    showToast(`تم إعادة حساب كل أرقام الحقائب — المخزون الحالي فعلياً: ${purchasedQty}`);
    return;
  }
  if(e.target.dataset.buy){
    bagPurchaseTargetId = e.target.dataset.buy;
    $('#bp-date').value = todayISO();
    $('#bp-invoice').value = '';
    // طرق الدفع الموحدة (نفس طرق الدفع المُعرَّفة في الإعدادات — يطابق شيت "الحركات المالية")
    populateSelect($('#bp-method'), settings.channels.map(c=>c.name), false);
    { const vaultCh = settings.channels.find(c=>c.dest==='vault'); $('#bp-method').value = vaultCh ? vaultCh.name : settings.channels[0]?.name || ''; }
    $('#bag-overlay').classList.add('show'); SoundFX.open();
  }
  if(e.target.dataset.fromstock){
    const idx = clients.findIndex(c=>c.id===e.target.dataset.fromstock);
    if(idx>-1){
      const availableStock = bagStockTotals().purchasedQty;
      if(availableStock<=0){
        if(!await customConfirm(`المخزون الحالي المتاح هو ${availableStock} — لا توجد حقائب كافية بالمخزون. هل تريد المتابعة وتسليم الحقيبة من المخزون على أي حال؟`)) return;
      }
      snapshotState(`تسليم حقيبة من المخزون للعميل: ${clients[idx].name}`);
      clients[idx].bagSource = 'stock';
      clients[idx].bagStatus = 'purchased';
      clients[idx].bagPurchaseDate = clients[idx].bagPurchaseDate || todayISO();
      // نسجّل عملية التسليم كسطر مستقل في سجل عمليات مخزون الحقائب (وليس فقط كحقل في شيت العملاء)،
      // حتى يبقى "المخزون الحالي" مبنياً بالكامل على سجل العمليات نفسه ويمكن تتبعه وحذفه بدقة عند الإلغاء
      bagStock.push({
        id: uid(), createdBy: currentUser, type:'issue', qty:-1, unitPrice:0,
        date: clients[idx].bagPurchaseDate,
        createdAt: Date.now(),
        issuedClientId: clients[idx].id, issuedClientName: clients[idx].name,
        notes: `تسليم من المخزون للعميل: ${clients[idx].name}`
      });
      recalcBagFundLedger();
      await saveClients();
      await saveBagStock();
      await saveSettings();
      await logAudit('edit','مخزون الحقائب', `تم تسليم حقيبة من المخزون المتوفر للعميل: ${clients[idx].name} (بدلاً من شراء حقيبة جديدة)`);
      renderBags(); renderTable(); renderCourses(); renderMissingCourse();
      showToast('تم تسليم الحقيبة من المخزون');
    }
  }
  if(e.target.dataset.editstock){
    openBagStockEdit(e.target.dataset.editstock);
  }
  if(e.target.dataset.delstock){
    const removedPreview = bagStock.find(b=>b.id===e.target.dataset.delstock);
    const confirmMsg = removedPreview && removedPreview.type==='issue'
      ? `حذف عملية تسليم الحقيبة للعميل "${removedPreview.issuedClientName||''}"؟ ستعود حالة حقيبته إلى "مطلوب شراء" وتُضاف الحقيبة تلقائياً للمخزون المتاح.`
      : 'حذف هذه العملية من سجل التمويل؟ سيُعاد احتساب رصيد الحقائب والمخزون تلقائياً.';
    if(await customConfirm(confirmMsg)){
      if(editingBagStockId===e.target.dataset.delstock) cancelBagStockEdit();
      const removed = bagStock.find(b=>b.id===e.target.dataset.delstock);
      const removedDesc = removed ? (removed.type==='issue' ? `تسليم حقيبة للعميل: ${removed.issuedClientName||''}` : (removed.amount!==undefined ? `${removed.type==='withdraw'?'سحب':'إيداع'} ${fmt(num(removed.amount))} ﷼` : `${removed.qty||''} حقيبة`)) : '';
      snapshotState(`حذف عملية من سجل تمويل مخزون الحقائب: ${removedDesc}`);
      bagStock = bagStock.filter(b=>b.id!==e.target.dataset.delstock);
      recalcBagFundLedger();
      await saveBagStock();
      await saveSettings();
      // إن كانت عملية "تسليم من المخزون"، تعود حالة حقيبة العميل المرتبط إلى "مطلوب شراء" تلقائياً حتى تبقى بيانات
      // شيت العملاء متسقة مع سجل عمليات المخزون بعد حذف عملية التسليم منه مباشرة
      if(removed && removed.type==='issue' && removed.issuedClientId){
        const linkedClient = clients.find(c=>c.id===removed.issuedClientId);
        if(linkedClient && linkedClient.bagSource==='stock'){
          linkedClient.bagSource = 'buy';
          linkedClient.bagPrice = num(settings.bagPrice) || DEFAULT_SETTINGS.bagPrice;
          linkedClient.bagInvoice = '';
          linkedClient.bagStatus = 'pending';
          delete linkedClient.bagPurchaseDate;
          delete linkedClient.bagPaymentMethod;
          syncClientLedgerEntry(linkedClient);
          await saveClients();
          await saveVaultTx();
        }
      }
      // إذا كانت هذه العملية قد رُحِّلت سابقاً كخصم من الخزنة (كاش) — لأنها كانت إيداعاً كاشاً في البنك —
      // نحذف حركة الخصم المرتبطة بها من "الحركات المالية" أيضاً حتى لا يبقى رصيد الخزنة منقوصاً بلا سبب.
      const linkedTx = removed ? vaultTx.find(t=>t.bagStockRef===removed.id) : null;
      if(linkedTx){
        vaultTx = vaultTx.filter(t=>t.id!==linkedTx.id);
        await saveVaultTx();
        await logAudit('delete','الحركات المالية', `تم حذف حركة صادر مرتبطة بعملية تمويل محذوفة من مخزون الحقائب: خصم ${fmt(num(linkedTx.amount))} ﷼ من الخزنة (كاش)`);
      }
      await logAudit('delete','مخزون الحقائب', `تم حذف عملية من سجل التمويل بتاريخ ${removed?.date}: ${removedDesc} (تمت إعادة احتساب الرصيد والمخزون)`);
      renderBags(); renderTable(); renderCourses(); renderMissingCourse();
    }
  }
});
$('#bp-cancel').addEventListener('click', ()=>{ $('#bag-overlay').classList.remove('show'); bagPurchaseTargetId=null; });
$('#bag-overlay').addEventListener('click', e=>{ if(e.target.id==='bag-overlay'){ $('#bag-overlay').classList.remove('show'); bagPurchaseTargetId=null; } });
$('#bag-purchase-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const idx = clients.findIndex(c=>c.id===bagPurchaseTargetId);
  if(idx>-1){
    snapshotState(`تسجيل شراء حقيبة للعميل: ${clients[idx].name}`);
    clients[idx].bagStatus = 'purchased';
    clients[idx].bagPurchaseDate = $('#bp-date').value;
    clients[idx].bagPaymentMethod = $('#bp-method').value;
    if($('#bp-invoice').value.trim()) clients[idx].bagInvoice = $('#bp-invoice').value.trim();
    await saveClients();
    await logAudit('edit','مخزون الحقائب', `تم تسجيل شراء حقيبة للعميل: ${clients[idx].name}`);
  }
  $('#bag-overlay').classList.remove('show');
  bagPurchaseTargetId = null;
  renderBags(); renderTable(); renderCourses(); renderMissingCourse();
  showToast('تم تسجيل شراء الحقيبة');
});

/* خانة الشراء السريعة بجانب "مطلوب شراء" في شيت العملاء وشيت الدورات (بكل تبويباته):
   عند التأشير عليها يتم تسليم الحقيبة من مخزون الحقائب المتوفر مباشرة (شراء مباشر بفاتورة خاصة أُلغي نهائياً). */
document.addEventListener('change', async e=>{
  if(!e.target.dataset.bagbuy) return;
  const id = e.target.dataset.bagbuy;
  const idx = clients.findIndex(c=>c.id===id);
  e.target.checked = false; // الحالة الفعلية تُقرأ من bagStatus/bagSource بعد إعادة الرسم، وليس من الخانة نفسها
  if(idx===-1) return;
  const availableStock = bagStockTotals().purchasedQty;
  if(availableStock<=0){
    if(!await customConfirm(`المخزون الحالي المتاح هو ${availableStock} — لا توجد حقائب كافية بالمخزون. هل تريد المتابعة وتسليم الحقيبة من المخزون على أي حال؟`)) return;
  }else if(!await customConfirm(`تسليم حقيبة من المخزون المتوفر للعميل "${clients[idx].name}"؟`)){
    return;
  }
  snapshotState(`تسليم حقيبة من المخزون للعميل: ${clients[idx].name}`);
  clients[idx].bagSource = 'stock';
  clients[idx].bagStatus = 'purchased';
  clients[idx].bagPurchaseDate = clients[idx].bagPurchaseDate || todayISO();
  bagStock.push({
    id: uid(), createdBy: currentUser, type:'issue', qty:-1, unitPrice:0,
    date: clients[idx].bagPurchaseDate,
    createdAt: Date.now(),
    issuedClientId: clients[idx].id, issuedClientName: clients[idx].name,
    notes: `تسليم من المخزون للعميل: ${clients[idx].name} (من خانة الشراء السريعة)`
  });
  recalcBagFundLedger();
  await saveClients();
  await saveBagStock();
  await saveSettings();
  await logAudit('edit','مخزون الحقائب', `تم تسليم حقيبة من المخزون المتوفر للعميل: ${clients[idx].name} (من خانة الشراء السريعة)`);
  renderBags(); renderTable(); renderCourses(); renderMissingCourse();
  showToast('تم تسليم الحقيبة من المخزون');
});

/* ---------------- استيراد حركات وارد وصادر من Excel إلى الحركات المالية ---------------- */
function destLabelToValue(l){
  const v = String(l||'').trim();
  if(v==='البنك') return 'bank';
  if(v==='الشبكة') return 'network';
  if(v==='الخزنة (كاش)' || v==='الخزنة' || v==='كاش') return 'vault';
  return 'vault';
}
function txTypeLabelToValue(l){
  const v = String(l||'').trim();
  if(v==='وارد' || v==='وارد (إيراد)' || v.toLowerCase()==='in') return 'in';
  if(v==='صادر' || v==='صادر (مصروف)' || v.toLowerCase()==='out') return 'out';
  return '';
}
$('#btn-template-vault-expenses').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_حركات_مالية.xlsx', 'نموذج', [
    {'التاريخ':'2026-01-15', 'نوع الحركة':'وارد', 'المبلغ':1000, 'الحساب/الوجهة':'الخزنة (كاش)', 'طريقة الدفع':'كاش مباشر', 'رقم الهوية':'', 'البيان/الجهة':'دعم شركاء', 'التصنيف':'', 'اسم مستلم المبلغ':'', 'رقم فاتورة الشبكة':'', 'ملاحظات':''},
    {'التاريخ':'2026-01-16', 'نوع الحركة':'صادر', 'المبلغ':500, 'الحساب/الوجهة':'الخزنة (كاش)', 'طريقة الدفع':'كاش مباشر', 'رقم الهوية':'', 'البيان/الجهة':'', 'التصنيف':'إيجار', 'اسم مستلم المبلغ':'', 'رقم المستند':'', 'رقم فاتورة الشبكة':'', 'ملاحظات':''}
  ]);
});
$('#btn-import-vault-expenses').addEventListener('click', ()=> $('#import-vaultexp-input').click());
$('#import-vaultexp-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    snapshotState('استيراد حركات وارد وصادر من Excel');
    let addedIn=0, addedOut=0, skipped=0;
    const changedRows = [];
    for(const row of json){
      const amount = num(row['المبلغ']);
      const date = normalizeExcelDate(row['التاريخ']) || todayISO();
      const type = txTypeLabelToValue(row['نوع الحركة']);
      if(amount<=0 || !type){ skipped++; continue; }
      if(isDateLocked(date)){ skipped++; continue; } // تاريخ يقع ضمن فترة محاسبية مُقفلة — يُتخطى الصف
      const destination = destLabelToValue(row['الحساب/الوجهة']);
      const methodRaw2 = String(row['طريقة الدفع']||'').trim();
      const destCh = (settings.channels||[]).find(c=>c.dest===destination);
      const method = methodRaw2 ? canonicalizeChannelName(methodRaw2) : (destCh ? destCh.name : '');
      const notes = String(row['ملاحظات']||'').trim();
      const networkInvoice = destination==='network' ? String(row['رقم فاتورة الشبكة']||'').trim() : '';

      let newTx;
      if(type==='in'){
        const clientId = String(row['رقم الهوية']||'').trim();
        const client = clientId ? clients.find(c=>c.clientId===clientId) : null;
        newTx = {
          id: uid(), seq: allocVaultSeq(destination), createdAt: Date.now(), type:'in', isReturn:false,
          date, amount, method, notes,
          clientId: client ? clientId : '',
          clientName: client ? client.name : '',
          manual: !client ? String(row['البيان/الجهة']||'').trim() : '',
          category:'', recipientName:'',
          destination, networkInvoice
        };
        addedIn++;
        changedRows.push({'التاريخ':date, 'نوع الحركة':'وارد', 'المبلغ':amount, 'الحساب/الوجهة':destLabel(destination), 'طريقة الدفع':method, 'رقم الهوية':newTx.clientId, 'البيان/الجهة':newTx.manual, 'ملاحظات':notes});
      }else{
        const category = String(row['التصنيف']||'').trim();
        newTx = {
          id: uid(), seq: allocVaultSeq(destination), createdAt: Date.now(), type:'out', isReturn:false,
          date, amount, method, notes,
          clientId:'', clientName:'', manual:'',
          category,
          recipientName: String(row['اسم مستلم المبلغ']||'').trim(),
          referenceNo: String(row['رقم المستند']||'').trim(),
          destination, networkInvoice
        };
        if(category && !settings.expenseCategories.includes(category)) settings.expenseCategories.push(category);
        addedOut++;
        changedRows.push({'التاريخ':date, 'نوع الحركة':'صادر', 'المبلغ':amount, 'الحساب/الوجهة':destLabel(destination), 'طريقة الدفع':method, 'التصنيف':category, 'اسم مستلم المبلغ':newTx.recipientName, 'رقم فاتورة الشبكة':networkInvoice, 'ملاحظات':notes});
      }
      vaultTx.push(newTx);
    }
    await saveVaultTx();
    await saveSettings();
    const added = addedIn + addedOut;
    await logAudit('add','الحركات المالية', `استيراد حركات وارد وصادر من Excel: تمت إضافة ${addedIn} حركة وارد و${addedOut} حركة صادر${skipped?`، وتخطي ${skipped} صف بدون مبلغ أو نوع حركة صحيح`:''}`);
    renderVault(); renderReports();
    downloadXlsx(`تقرير_استيراد_حركات_مالية_${stampNow()}.xlsx`, 'تقرير الاستيراد', changedRows);
    showToast(`تم الاستيراد: ${addedIn} حركة وارد، ${addedOut} حركة صادر${skipped?`، ${skipped} تم تخطيه`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد من وجود أعمدة "المبلغ" و"نوع الحركة" على الأقل وأنه بصيغة Excel صحيحة');
  }finally{
    e.target.value = '';
  }
});

/* ---------------- مطابقة كشف الحساب البنكي ---------------- */
// يحاول ربط كل سطر غير مربوط في كشف الحساب المستورد بحركة "بنك" غير مربوطة في الحركات المالية،
// فقط عندما يوجد تطابق فريد (نفس التاريخ + نفس المبلغ + نفس اتجاه الحركة). لا يربط تلقائياً عند وجود أكثر من مرشح.
function autoMatchBankStatement(){
  const usedTxIds = new Set(bankStatementRows.filter(r=>r.matchedTxId).map(r=>r.matchedTxId));
  const bankTx = vaultTx.filter(t=>t.destination==='bank');
  let matchedCount = 0;
  bankStatementRows.forEach(row=>{
    if(row.matchedTxId) return;
    const wantType = row.type==='credit' ? 'in' : 'out';
    const candidates = bankTx.filter(t=>!usedTxIds.has(t.id) && t.type===wantType && t.date===row.date && Math.abs(num(t.amount)-num(row.amount))<0.01);
    if(candidates.length===1){
      row.matchedTxId = candidates[0].id;
      usedTxIds.add(candidates[0].id);
      matchedCount++;
    }
  });
  return matchedCount;
}
// مرشحو الربط اليدوي لسطر معيّن: حركات بنك غير مربوطة، بنفس اتجاه الحركة، مرتّبة بحيث الأقرب بالمبلغ والتاريخ أولاً
function bankReconCandidatesFor(row){
  const usedTxIds = new Set(bankStatementRows.filter(r=>r.matchedTxId && r.id!==row.id).map(r=>r.matchedTxId));
  const wantType = row.type==='credit' ? 'in' : 'out';
  return vaultTx.filter(t=>t.destination==='bank' && t.type===wantType && !usedTxIds.has(t.id))
    .sort((a,b)=>{
      const da = Math.abs(num(a.amount)-num(row.amount)), db = Math.abs(num(b.amount)-num(row.amount));
      if(da!==db) return da-db;
      return String(a.date).localeCompare(String(b.date));
    });
}
function renderBankRecon(){
  const wrap = $('#bankrecon-wrap');
  const summaryEl = $('#bankrecon-summary');
  if(!wrap || !summaryEl) return;
  const usedTxIds = new Set(bankStatementRows.filter(r=>r.matchedTxId).map(r=>r.matchedTxId));
  const bankTx = vaultTx.filter(t=>t.destination==='bank');
  const unmatchedRows = bankStatementRows.filter(r=>!r.matchedTxId);
  const matchedRows = bankStatementRows.filter(r=>r.matchedTxId);
  const unmatchedSystemTx = bankTx.filter(t=>!usedTxIds.has(t.id));
  const stmtNet = bankStatementRows.reduce((s,r)=> s + (r.type==='credit'? num(r.amount) : -num(r.amount)), 0);
  const systemNet = bankTx.reduce((s,t)=> s + (t.type==='in'? num(t.amount) : -num(t.amount)), 0);
  summaryEl.innerHTML = `
    <span>سطور كشف الحساب: <b class="mono">${bankStatementRows.length}</b></span>
    <span>مطابَقة: <b class="mono" style="color:var(--teal);">${matchedRows.length}</b></span>
    <span>غير مطابَقة: <b class="mono" style="color:var(--red);">${unmatchedRows.length}</b></span>
    <span>حركات "البنك" بالنظام غير مطابَقة: <b class="mono" style="color:var(--red);">${unmatchedSystemTx.length}</b></span>
    <span>صافي كشف الحساب: <b class="mono">${fmt(stmtNet)} ﷼</b></span>
    <span>صافي حركات البنك بالنظام: <b class="mono">${fmt(systemNet)} ﷼</b></span>
  `;
  if(!bankStatementRows.length){
    wrap.innerHTML = `<div class="empty-state" style="padding:20px;"><div class="big">🏦</div>لم يتم استيراد كشف حساب بنكي بعد</div>`;
    return;
  }
  const rowHtml = (row, matched)=>{
    const candidates = matched ? [] : bankReconCandidatesFor(row);
    const matchedTx = matched ? vaultTx.find(t=>t.id===row.matchedTxId) : null;
    return `<tr>
      <td class="mono">${row.date||''}</td>
      <td>${escapeHtml(row.description||'')}</td>
      <td>${row.type==='credit'?'إيداع':'سحب'}</td>
      <td class="mono">${fmt(num(row.amount))}</td>
      <td>${escapeHtml(row.reference||'')}</td>
      <td>${matched
        ? `<span class="hint" style="margin:0;">مربوطة بحركة #${matchedTx?matchedTx.seq:'—'} بتاريخ ${matchedTx?matchedTx.date:'—'}</span> <button type="button" class="btn btn-ghost btn-sm" data-unmatch="${row.id}">فك الربط</button>`
        : (candidates.length
            ? `<select data-select-for="${row.id}" style="max-width:220px; display:inline-block;">${candidates.map(c=>`<option value="${c.id}">#${c.seq} — ${c.date} — ${fmt(num(c.amount))} ﷼ — ${escapeHtml(c.clientName||c.manual||c.recipientName||c.category||'')}</option>`).join('')}</select> <button type="button" class="btn btn-gold btn-sm" data-match="${row.id}">ربط</button>`
            : `<span class="hint" style="margin:0;">لا توجد حركة بنك بالنظام بنفس الاتجاه غير مربوطة بعد لمطابقتها</span>`)
      } <button type="button" class="btn btn-ghost btn-sm" data-delrow="${row.id}">حذف السطر</button></td>
    </tr>`;
  };
  let html = `
    <div class="table-scroll">
      <table>
        <thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>المبلغ</th><th>المرجع</th><th>المطابقة</th></tr></thead>
        <tbody id="bankrecon-stmt-body">
          ${unmatchedRows.map(r=>rowHtml(r,false)).join('') || '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">لا توجد سطور غير مطابَقة 🎉</td></tr>'}
        </tbody>
      </table>
    </div>`;
  if(bankReconShowMatched && matchedRows.length){
    html += `
    <h4 style="margin:14px 0 6px;">الحركات المطابَقة</h4>
    <div class="table-scroll">
      <table>
        <thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>المبلغ</th><th>المرجع</th><th>المطابقة</th></tr></thead>
        <tbody id="bankrecon-matched-body">
          ${matchedRows.map(r=>rowHtml(r,true)).join('')}
        </tbody>
      </table>
    </div>`;
  }
  if(unmatchedSystemTx.length){
    html += `
    <h4 style="margin:14px 0 6px;">حركات "البنك" بالنظام غير المطابَقة مع كشف الحساب</h4>
    <div class="hint" style="margin-bottom:6px;">هذه حركات مسجّلة في شيت الحركات المالية بحساب "البنك" ولم تُطابَق مع أي سطر من كشف الحساب المستورد — قد تكون لم تظهر بعد في كشف البنك، أو تحتاج مراجعة.</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>الرقم التسلسلي</th><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>العميل / البيان</th></tr></thead>
        <tbody>
          ${unmatchedSystemTx.map(t=>`<tr><td class="mono">#${t.seq||'—'}</td><td class="mono">${t.date}</td><td>${t.type==='in'?'وارد':'صادر'}</td><td class="mono">${fmt(num(t.amount))}</td><td>${escapeHtml(t.clientName||t.manual||t.recipientName||t.category||'')}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }
  wrap.innerHTML = html;
}
$('#btn-bankrecon-toggle-matched')?.addEventListener('click', ()=>{ bankReconShowMatched = !bankReconShowMatched; renderBankRecon(); });
$('#btn-template-bankrecon')?.addEventListener('click', ()=>{
  downloadXlsx('نموذج_كشف_حساب_بنكي.xlsx', 'كشف الحساب', [
    {'التاريخ':'2026-01-15', 'البيان':'تحويل وارد', 'نوع الحركة':'إيداع', 'المبلغ':1000, 'المرجع':''},
    {'التاريخ':'2026-01-16', 'البيان':'رسوم بنكية', 'نوع الحركة':'سحب', 'المبلغ':25, 'المرجع':''}
  ]);
});
function bankStmtTypeLabelToValue(l){
  const v = String(l||'').trim();
  if(v==='إيداع' || v==='دائن' || v.toLowerCase()==='credit' || v.toLowerCase()==='in') return 'credit';
  if(v==='سحب' || v==='مدين' || v.toLowerCase()==='debit' || v.toLowerCase()==='out') return 'debit';
  return '';
}
$('#btn-import-bankrecon')?.addEventListener('click', ()=> $('#import-bankrecon-input').click());
$('#import-bankrecon-input')?.addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    let added=0, skipped=0;
    json.forEach(row=>{
      const amount = num(row['المبلغ']);
      const date = normalizeExcelDate(row['التاريخ']);
      const type = bankStmtTypeLabelToValue(row['نوع الحركة']);
      if(amount<=0 || !date || !type){ skipped++; return; }
      bankStatementRows.push({
        id: uid(), date, amount, type,
        description: String(row['البيان']||'').trim(),
        reference: String(row['المرجع']||'').trim(),
        matchedTxId: '', importedAt: Date.now()
      });
      added++;
    });
    await saveBankStatementRows();
    const autoMatched = autoMatchBankStatement();
    await saveBankStatementRows();
    renderBankRecon();
    showToast(`تم استيراد ${added} سطراً${skipped?`، وتخطي ${skipped} صف بدون تاريخ/مبلغ/نوع حركة صحيح`:''} — تمت مطابقة ${autoMatched} تلقائياً`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد من وجود أعمدة "التاريخ" و"المبلغ" و"نوع الحركة" على الأقل وأنه بصيغة Excel صحيحة');
  }finally{
    e.target.value = '';
  }
});
$('#btn-bankrecon-clear')?.addEventListener('click', async ()=>{
  if(!bankStatementRows.length){ showToast('لا يوجد كشف حساب مستورد أصلاً'); return; }
  if(!await customConfirm('سيتم مسح كل سطور كشف الحساب البنكي المستورد وكل الربط الحالي معها. هذا لا يؤثر على الحركات المالية نفسها. متابعة؟')) return;
  bankStatementRows = [];
  await saveBankStatementRows();
  renderBankRecon();
  showToast('تم مسح كشف الحساب المستورد');
});
document.addEventListener('click', async e=>{
  const matchId = e.target?.dataset?.match;
  const unmatchId = e.target?.dataset?.unmatch;
  const delId = e.target?.dataset?.delrow;
  if(matchId){
    const sel = document.querySelector(`select[data-select-for="${matchId}"]`);
    const txId = sel && sel.value;
    if(!txId){ showToast('اختر حركة من القائمة أولاً'); return; }
    const row = bankStatementRows.find(r=>r.id===matchId);
    if(row){ row.matchedTxId = txId; await saveBankStatementRows(); showToast('تم الربط'); renderBankRecon(); }
  }
  if(unmatchId){
    const row = bankStatementRows.find(r=>r.id===unmatchId);
    if(row){ row.matchedTxId = ''; await saveBankStatementRows(); showToast('تم فك الربط'); renderBankRecon(); }
  }
  if(delId){
    if(!await customConfirm('حذف هذا السطر من كشف الحساب المستورد؟ هذا لا يحذف أي حركة مالية.')) return;
    bankStatementRows = bankStatementRows.filter(r=>r.id!==delId);
    await saveBankStatementRows();
    renderBankRecon();
  }
});

