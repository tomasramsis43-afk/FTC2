/* ============ دليل الحسابات والقيود اليومية بنظام القيد المزدوج ============ */
const ACCOUNT_TYPES = [
  {value:'asset', label:'أصول'},
  {value:'liability', label:'خصوم'},
  {value:'equity', label:'حقوق ملكية'},
  {value:'revenue', label:'إيرادات'},
  {value:'expense', label:'مصروفات'},
];
function accountTypeLabel(t){ return (ACCOUNT_TYPES.find(x=>x.value===t)||{}).label || t; }
function accountNormalBalance(t){ return (t==='asset'||t==='expense') ? 'debit' : 'credit'; }
function seedChartOfAccountsIfEmpty(){
  if(chartOfAccounts && chartOfAccounts.length) return;
  chartOfAccounts = [
    {id:uid(), code:'1000', name:'النقدية والبنوك', type:'asset'},
    {id:uid(), code:'1100', name:'حسابات مدينة (ذمم العملاء)', type:'asset'},
    {id:uid(), code:'1200', name:'مخزون الحقائب التدريبية', type:'asset'},
    {id:uid(), code:'1500', name:'الأصول الثابتة', type:'asset'},
    {id:uid(), code:'1590', name:'مجمع الإهلاك', type:'asset'},
    {id:uid(), code:'1900', name:'حساب تسويات معلّق (بانتظار التصنيف)', type:'asset'},
    {id:uid(), code:'2000', name:'حسابات دائنة (ذمم الموردين)', type:'liability'},
    {id:uid(), code:'2100', name:'ضريبة القيمة المضافة المستحقة', type:'liability'},
    {id:uid(), code:'2200', name:'مصروفات مستحقة', type:'liability'},
    {id:uid(), code:'2300', name:'قروض', type:'liability'},
    {id:uid(), code:'3000', name:'رأس المال', type:'equity'},
    {id:uid(), code:'3100', name:'الأرباح المرحّلة', type:'equity'},
    {id:uid(), code:'4000', name:'إيرادات الدورات التدريبية', type:'revenue'},
    {id:uid(), code:'4100', name:'إيرادات أخرى', type:'revenue'},
    {id:uid(), code:'5000', name:'مصروفات تشغيلية', type:'expense'},
    {id:uid(), code:'5100', name:'مصروف الإهلاك', type:'expense'},
    {id:uid(), code:'5200', name:'تكلفة الحقائب التدريبية', type:'expense'},
  ];
}
function sortedChartOfAccounts(){ return chartOfAccounts.slice().sort((a,b)=> String(a.code||'').localeCompare(String(b.code||''), 'en')); }
function accountOptionsHtml(selectedId){
  return sortedChartOfAccounts().map(a=> `<option value="${a.id}" ${a.id===selectedId?'selected':''}>${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`).join('');
}
function renderChartOfAccountsTable(){
  const tbody = $('#coa-list-body');
  if(!tbody) return;
  const usedIds = new Set();
  journalDE.forEach(e=> (e.lines||[]).forEach(l=> usedIds.add(l.accountId)));
  tbody.innerHTML = sortedChartOfAccounts().map(a=> `<tr>
    <td class="mono">${escapeHtml(a.code)}</td><td>${escapeHtml(a.name)}</td><td>${accountTypeLabel(a.type)}</td>
    <td><button class="btn btn-ghost btn-sm" data-coa-del="${a.id}" ${usedIds.has(a.id)?'disabled title="لا يمكن حذف حساب مستخدم في قيود يومية"':''}>حذف</button></td>
  </tr>`).join('') || `<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد حسابات — أضف أول حساب أعلاه</td></tr>`;
}
function refreshAccountSelectOptions(){
  const glSel = $('#gl-account');
  if(glSel){ const cur = glSel.value; glSel.innerHTML = accountOptionsHtml(); if(cur && chartOfAccounts.some(a=>a.id===cur)) glSel.value = cur; }
  document.querySelectorAll('#de-lines .de-line-account').forEach(sel=>{
    const cur = sel.value; sel.innerHTML = accountOptionsHtml(); if(cur && chartOfAccounts.some(a=>a.id===cur)) sel.value = cur;
  });
}
$('#btn-add-account')?.addEventListener('click', async ()=>{
  const code = $('#coa-code').value.trim();
  const name = $('#coa-name').value.trim();
  const type = $('#coa-type').value;
  if(!code){ showToast('أدخل رمز الحساب'); return; }
  if(!name){ showToast('أدخل اسم الحساب'); return; }
  if(chartOfAccounts.some(a=>a.code===code)){ showToast('يوجد حساب آخر بنفس الرمز'); return; }
  chartOfAccounts.push({ id: uid(), code, name, type });
  await saveChartOfAccounts();
  await logAudit('add','المحاسبة', `تمت إضافة حساب لدليل الحسابات: ${code} — ${name} (${accountTypeLabel(type)})`);
  $('#coa-code').value=''; $('#coa-name').value='';
  showToast('تمت إضافة الحساب');
  renderChartOfAccountsTable();
  refreshAccountSelectOptions();
});
$('#coa-list-body')?.addEventListener('click', async e=>{
  const btn = e.target.closest('[data-coa-del]');
  if(!btn || btn.disabled) return;
  const a = chartOfAccounts.find(x=>x.id===btn.dataset.coaDel);
  if(!a) return;
  if(!await customConfirm(`هل تريد حذف الحساب "${a.code} — ${a.name}"؟`)) return;
  chartOfAccounts = chartOfAccounts.filter(x=>x.id!==a.id);
  await saveChartOfAccounts();
  await logAudit('delete','المحاسبة', `تم حذف حساب من دليل الحسابات: ${a.code} — ${a.name}`);
  renderChartOfAccountsTable();
  refreshAccountSelectOptions();
  showToast('تم حذف الحساب');
});

function deLineRowHtml(){
  return `<tr data-de-line>
    <td><select class="de-line-account">${accountOptionsHtml()}</select></td>
    <td><input type="number" step="0.01" class="de-line-debit" placeholder="0"></td>
    <td><input type="number" step="0.01" class="de-line-credit" placeholder="0"></td>
    <td><button type="button" class="btn btn-ghost btn-sm" data-de-removeline>×</button></td>
  </tr>`;
}
function resetDELinesForm(){
  const tbody = $('#de-lines');
  if(!tbody) return;
  tbody.innerHTML = deLineRowHtml() + deLineRowHtml();
  computeDETotals();
}
function computeDETotals(){
  const totalsEl = $('#de-totals');
  let debit=0, credit=0;
  document.querySelectorAll('#de-lines .de-line-debit').forEach(i=> debit += num(i.value));
  document.querySelectorAll('#de-lines .de-line-credit').forEach(i=> credit += num(i.value));
  const diff = debit - credit;
  const balanced = Math.abs(diff) < 0.01 && debit > 0;
  if(totalsEl){
    totalsEl.innerHTML = `<span>إجمالي مدين: <b class="mono">${fmt(debit)}</b> · إجمالي دائن: <b class="mono">${fmt(credit)}</b> · ${balanced ? '<b style="color:var(--teal,#0f8a6b);">✅ القيد متوازن</b>' : `<b style="color:var(--red);">⚠️ غير متوازن (الفرق ${fmt(Math.abs(diff))})</b>`}</span>`;
  }
  return { debit, credit, balanced };
}
$('#de-lines')?.addEventListener('input', e=>{
  if(e.target.classList.contains('de-line-debit') && num(e.target.value)>0){
    const row = e.target.closest('tr'); const c = row?.querySelector('.de-line-credit'); if(c) c.value='';
  }
  if(e.target.classList.contains('de-line-credit') && num(e.target.value)>0){
    const row = e.target.closest('tr'); const d = row?.querySelector('.de-line-debit'); if(d) d.value='';
  }
  computeDETotals();
});
$('#de-lines')?.addEventListener('click', e=>{
  const btn = e.target.closest('[data-de-removeline]');
  if(!btn) return;
  const tbody = $('#de-lines');
  if(tbody.querySelectorAll('tr').length <= 2){ showToast('يجب أن يحتوي القيد على سطرين على الأقل'); return; }
  btn.closest('tr').remove();
  computeDETotals();
});
$('#btn-de-addline')?.addEventListener('click', ()=>{
  $('#de-lines')?.insertAdjacentHTML('beforeend', deLineRowHtml());
});
$('#de-date') && ($('#de-date').value = todayISO());
$('#btn-de-save')?.addEventListener('click', async ()=>{
  if(!chartOfAccounts.length){ showToast('أضف حسابات لدليل الحسابات أولاً'); return; }
  const date = $('#de-date').value || todayISO();
  const description = $('#de-desc').value.trim();
  if(!description){ showToast('أدخل بياناً موجزاً للقيد'); return; }
  const lines = [];
  document.querySelectorAll('#de-lines tr[data-de-line]').forEach(row=>{
    const accountId = row.querySelector('.de-line-account')?.value;
    const debit = num(row.querySelector('.de-line-debit')?.value);
    const credit = num(row.querySelector('.de-line-credit')?.value);
    if(accountId && (debit>0 || credit>0)) lines.push({ accountId, debit, credit });
  });
  if(lines.length < 2){ showToast('أدخل سطرين على الأقل بحساب ومبلغ (مدين أو دائن)'); return; }
  const totalDebit = lines.reduce((s,l)=>s+l.debit,0);
  const totalCredit = lines.reduce((s,l)=>s+l.credit,0);
  if(Math.abs(totalDebit-totalCredit) >= 0.01){ showToast('القيد غير متوازن — يجب أن يتساوى إجمالي المدين مع إجمالي الدائن'); return; }
  journalDE.push({ id: uid(), createdAt: Date.now(), date, description, lines });
  await saveJournalDE();
  await logAudit('add','المحاسبة', `تمت إضافة قيد يومية: ${description} بمبلغ ${fmt(totalDebit)} ﷼ (${lines.length} سطور)`);
  $('#de-desc').value = '';
  resetDELinesForm();
  showToast('تم حفظ القيد اليومية');
  renderDoubleEntryModule();
});
function filteredJournalDE(){
  const q = ($('#de-filter-search')?.value || '').trim().toLowerCase();
  const from = $('#de-filter-from')?.value || '';
  const to = $('#de-filter-to')?.value || '';
  const type = $('#de-filter-type')?.value || '';
  let rows = journalDE.slice();
  if(q) rows = rows.filter(e=> String(e.description||'').toLowerCase().includes(q));
  if(from) rows = rows.filter(e=> (e.date||'') >= from);
  if(to) rows = rows.filter(e=> (e.date||'') <= to);
  if(type==='auto') rows = rows.filter(e=> !!e.isAuto);
  else if(type==='manual') rows = rows.filter(e=> !e.isAuto);
  return rows;
}
function renderJournalDEList(){
  const tbody = $('#de-entries-body');
  if(!tbody) return;
  const sorted = filteredJournalDE().sort((a,b)=>{
    const d = String(a.date||'').localeCompare(String(b.date||''));
    return d!==0 ? d : (a.createdAt||0)-(b.createdAt||0);
  });
  tbody.innerHTML = sorted.map(e=>{
    const totalDebit = (e.lines||[]).reduce((s,l)=>s+num(l.debit),0);
    const totalCredit = (e.lines||[]).reduce((s,l)=>s+num(l.credit),0);
    const linesDetail = (e.lines||[]).map(l=>{
      const acc = chartOfAccounts.find(a=>a.id===l.accountId);
      const accLabel = acc ? `${escapeHtml(acc.code)} — ${escapeHtml(acc.name)}` : '—';
      return `${accLabel}: ${l.debit>0?('مدين '+fmt(l.debit)):('دائن '+fmt(l.credit))}`;
    }).join(' · ');
    return `<tr>
      <td class="mono">${escapeHtml(formatDateDisplay(e.date)||e.date||'—')}</td>
      <td>${e.isAuto ? '<span class="hint" style="color:var(--teal,#0f8a6b);">🔗 تلقائي · </span>' : ''}${escapeHtml(e.description||'—')}<div class="hint" style="margin:2px 0 0;">${linesDetail}</div></td>
      <td class="mono">${fmt(totalDebit)}</td>
      <td class="mono">${fmt(totalCredit)}</td>
      <td><button class="btn btn-ghost btn-sm" data-de-del="${e.id}">حذف</button></td>
    </tr>`;
  }).join('');
  $('#de-entries-empty') && ($('#de-entries-empty').style.display = sorted.length ? 'none' : '');
  if($('#de-entries-empty')){
    $('#de-entries-empty').lastChild.textContent = journalDE.length ? 'لا توجد قيود يومية مطابقة للفلتر الحالي' : 'لا توجد قيود يومية مسجّلة بعد';
  }
}
['#de-filter-search','#de-filter-from','#de-filter-to'].forEach(sel=> $(sel)?.addEventListener('input', renderJournalDEList));
$('#de-filter-type')?.addEventListener('change', renderJournalDEList);
$('#btn-de-filter-clear')?.addEventListener('click', ()=>{
  ['#de-filter-search','#de-filter-from','#de-filter-to'].forEach(sel=>{ if($(sel)) $(sel).value=''; });
  if($('#de-filter-type')) $('#de-filter-type').value='';
  renderJournalDEList();
});
$('#de-entries-body')?.addEventListener('click', async e=>{
  const btn = e.target.closest('[data-de-del]');
  if(!btn) return;
  const entry = journalDE.find(x=>x.id===btn.dataset.deDel);
  if(!entry) return;
  if(!await customConfirm('هل تريد حذف هذا القيد اليومية؟')) return;
  journalDE = journalDE.filter(x=>x.id!==entry.id);
  await saveJournalDE();
  if(entry.sourceJournalEntryId){
    const src = journalEntries.find(x=>x.id===entry.sourceJournalEntryId);
    if(src){ delete src.linkedDEId; await saveJournalEntries(); }
  }
  await logAudit('delete','المحاسبة', `تم حذف قيد يومية: ${entry.description||''}`);
  renderDoubleEntryModule();
  showToast('تم حذف القيد');
});
function renderGeneralLedgerDE(){
  const tbody = $('#gl-table-body');
  if(!tbody) return;
  const accountId = $('#gl-account')?.value;
  const from = $('#gl-from')?.value || '';
  const to = $('#gl-to')?.value || '';
  const acc = chartOfAccounts.find(a=>a.id===accountId);
  if(!acc){ tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">أضف حساباً لدليل الحسابات لعرض حركته</td></tr>`; return; }
  const normal = accountNormalBalance(acc.type);
  let rows = [];
  journalDE.forEach(entry=> (entry.lines||[]).forEach(l=>{
    if(l.accountId===accountId) rows.push({ date: entry.date, description: entry.description, debit: num(l.debit), credit: num(l.credit) });
  }));
  rows = rows.filter(r=> inRange(r.date, from, to)).sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  let balance = 0;
  const body = rows.map(r=>{
    balance += normal==='debit' ? (r.debit - r.credit) : (r.credit - r.debit);
    return `<tr>
      <td class="mono">${escapeHtml(formatDateDisplay(r.date)||r.date||'—')}</td>
      <td>${escapeHtml(r.description||'—')}</td>
      <td class="mono">${r.debit?fmt(r.debit):''}</td>
      <td class="mono">${r.credit?fmt(r.credit):''}</td>
      <td class="mono" style="font-weight:700;">${fmt(balance)}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = body || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد حركات على هذا الحساب ضمن الفترة المحددة</td></tr>`;
}
['#gl-account','#gl-from','#gl-to'].forEach(sel=> $(sel)?.addEventListener('change', renderGeneralLedgerDE));
function renderTrialBalanceDE2(){
  const tbody = $('#tb2-table-body');
  if(!tbody) return;
  const asOf = $('#tb2-asof')?.value || '';
  const balances = {};
  journalDE.filter(e=> !asOf || (e.date||'') <= asOf).forEach(e=>{
    (e.lines||[]).forEach(l=>{
      if(!balances[l.accountId]) balances[l.accountId] = {debit:0, credit:0};
      balances[l.accountId].debit += num(l.debit);
      balances[l.accountId].credit += num(l.credit);
    });
  });
  const active = sortedChartOfAccounts().filter(a=> balances[a.id] && (balances[a.id].debit || balances[a.id].credit));
  let totalDebit=0, totalCredit=0;
  const rowsHtml = active.map(a=>{
    const b = balances[a.id];
    const normal = accountNormalBalance(a.type);
    const net = normal==='debit' ? (b.debit-b.credit) : (b.credit-b.debit);
    const debitCol = normal==='debit' ? Math.max(0,net) : Math.max(0,-net);
    const creditCol = normal==='credit' ? Math.max(0,net) : Math.max(0,-net);
    totalDebit += debitCol; totalCredit += creditCol;
    return `<tr>
      <td class="mono">${escapeHtml(a.code)}</td><td>${escapeHtml(a.name)}</td><td>${accountTypeLabel(a.type)}</td>
      <td class="mono">${debitCol?fmt(debitCol):''}</td><td class="mono">${creditCol?fmt(creditCol):''}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = (rowsHtml || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد قيود يومية مسجّلة بعد</td></tr>`)
    + (active.length ? `<tr style="font-weight:800; border-top:2px solid var(--navy);"><td colspan="3">الإجمالي</td><td class="mono">${fmt(totalDebit)}</td><td class="mono">${fmt(totalCredit)}</td></tr>` : '');
}
$('#tb2-asof')?.addEventListener('change', renderTrialBalanceDE2);
function accountByCode(code){ return chartOfAccounts.find(a=>a.code===code); }
const LEGACY_JOURNAL_AUTO_MAP = {
  fixedasset:   { debit:'1500', credit:'1900' }, // إضافة أصل ثابت: مدين الأصول الثابتة / دائن تسويات معلّق (مصدر التمويل غير معروف تلقائياً)
  depreciation: { debit:'5100', credit:'1590' }, // قيد إهلاك: مدين مصروف الإهلاك / دائن مجمع الإهلاك
  accrued:      { debit:'5000', credit:'2200' }, // مصروف مستحق: مدين مصروفات تشغيلية / دائن مصروفات مستحقة
  otherliability:{ debit:'1900', credit:'2000' }, // التزام آخر: مدين تسويات معلّق / دائن حسابات دائنة
};
/* يبني سطور القيد المزدوج المقابل لقيد يدوي قديم (تسوية محاسبية)، أو null إن تعذّر (حسابات ناقصة) */
function buildAutoDELinesForLegacy(j){
  if(j.type==='readj'){
    const susp = accountByCode('1900'), retained = accountByCode('3100');
    if(!susp || !retained) return null;
    const amt = Math.abs(num(j.amount));
    if(amt<=0) return null;
    return num(j.amount) >= 0
      ? [{accountId:susp.id, debit:amt, credit:0}, {accountId:retained.id, debit:0, credit:amt}]
      : [{accountId:retained.id, debit:amt, credit:0}, {accountId:susp.id, debit:0, credit:amt}];
  }
  const map = LEGACY_JOURNAL_AUTO_MAP[j.type];
  if(!map) return null;
  const debitAcc = accountByCode(map.debit), creditAcc = accountByCode(map.credit);
  const amt = num(j.amount);
  if(!debitAcc || !creditAcc || amt<=0) return null;
  return [{accountId:debitAcc.id, debit:amt, credit:0}, {accountId:creditAcc.id, debit:0, credit:amt}];
}
/* يرحّل قيداً يدوياً قديماً (تسوية) تلقائياً إلى قيد يومية مزدوج متوازن، ويربطهما ببعض. يُرجع true إن تم الترحيل */
function autoPostLegacyEntry(j){
  if(j.linkedDEId) return false;
  const lines = buildAutoDELinesForLegacy(j);
  if(!lines) return false;
  const deEntry = { id: uid(), createdAt: Date.now(), date: j.date, description: `[ترحيل تلقائي] ${j.description||''}`, lines, sourceJournalEntryId: j.id, isAuto: true };
  journalDE.push(deEntry);
  j.linkedDEId = deEntry.id;
  return true;
}
/* ترحيل تلقائي شامل: كل القيود اليدوية القديمة + فواتير المشتريات/المبيعات اليدوية/الدورات
   المعلّقة، دفعة واحدة. تُستخدم عند كل تحميل بيانات (بدل الاعتماد على أزرار الترحيل اليدوية)،
   وأيضاً يمكن استدعاؤها يدوياً من الأزرار (تبقى موجودة لإعادة الطمأنة/كتابة سجل تدقيق مخصص). */
async function autoPostAllPendingDoubleEntries(){
  let legacyCount = 0, invoicesCount = 0;
  journalEntries.filter(j=>!j.linkedDEId).forEach(j=>{ if(autoPostLegacyEntry(j)) legacyCount++; });
  purchases.filter(p=>!p.linkedDEId).forEach(p=>{ if(autoPostPurchase(p)) invoicesCount++; });
  manualSalesInvoices.filter(m=>!m.linkedDEId).forEach(m=>{ if(autoPostManualSale(m)) invoicesCount++; });
  if(typeof courseInvoiceClients==='function'){
    courseInvoiceClients().filter(c=>!c.courseInvoiceDEId).forEach(c=>{ if(autoPostCourseInvoice(c)) invoicesCount++; });
  }
  const count = legacyCount + invoicesCount;
  if(count>0){
    await Promise.all([saveJournalEntries(), saveJournalDE(), savePurchases(), saveManualSalesInvoices(), saveClients()]);
    await logAudit('add','المحاسبة', `ترحيل تلقائي عند التحميل: تم ترحيل ${count} عملية إلى القيد المزدوج (${legacyCount} قيد يدوي، ${invoicesCount} فاتورة)`);
  }
  return count;
}
$('#btn-migrate-legacy')?.addEventListener('click', async ()=>{
  const pending = journalEntries.filter(j=>!j.linkedDEId);
  if(!pending.length){ showToast('كل القيود اليدوية مُرحّلة بالفعل'); return; }
  let count = 0;
  pending.forEach(j=>{ if(autoPostLegacyEntry(j)) count++; });
  if(!count){ showToast('تعذّر الترحيل — تأكد من وجود الحسابات الافتراضية بدليل الحسابات'); return; }
  await saveJournalEntries();
  await saveJournalDE();
  await logAudit('add','المحاسبة', `تم ترحيل ${count} قيد يدوي تلقائياً إلى القيد المزدوج`);
  showToast(`تم ترحيل ${count} قيد تلقائياً`);
  renderAccounting();
});

/* ---- ترحيل تلقائي لفواتير المشتريات ---- */
function buildDELinesForPurchase(p){
  const expenseAcc = accountByCode('5000'), vatAcc = accountByCode('2100'), cashAcc = accountByCode('1000'), payableAcc = accountByCode('2000');
  if(!expenseAcc || !vatAcc || !cashAcc || !payableAcc) return null;
  const lines = [{accountId:expenseAcc.id, debit:num(p.subtotal), credit:0}];
  if(num(p.taxAmount)>0) lines.push({accountId:vatAcc.id, debit:num(p.taxAmount), credit:0});
  const creditAcc = p.status==='paid' ? cashAcc : payableAcc;
  lines.push({accountId:creditAcc.id, debit:0, credit:num(p.total)});
  return lines;
}
function autoPostPurchase(p){
  if(p.linkedDEId) return false;
  const lines = buildDELinesForPurchase(p);
  if(!lines || num(p.total)<=0) return false;
  const entry = { id: uid(), createdAt: Date.now(), date: p.date, description: `[ترحيل تلقائي] فاتورة شراء ${p.invoiceNo||''} — ${p.supplierName||''}`, lines, sourcePurchaseId: p.id, isAuto: true };
  journalDE.push(entry);
  p.linkedDEId = entry.id;
  return true;
}

/* ---- ترحيل تلقائي لفواتير المبيعات اليدوية ---- */
function buildDELinesForManualSale(m){
  const arAcc = accountByCode('1100'), revAcc = accountByCode('4000'), vatAcc = accountByCode('2100');
  if(!arAcc || !revAcc || !vatAcc) return null;
  const total = num(m.total);
  const vat = total - (total/1.15);
  const net = total - vat;
  const lines = [{accountId:arAcc.id, debit:total, credit:0}, {accountId:revAcc.id, debit:0, credit:net}];
  if(vat>0.004) lines.push({accountId:vatAcc.id, debit:0, credit:vat});
  return lines;
}
function autoPostManualSale(m){
  if(m.linkedDEId) return false;
  const lines = buildDELinesForManualSale(m);
  if(!lines || num(m.total)<=0) return false;
  const entry = { id: uid(), createdAt: Date.now(), date: m.date, description: `[ترحيل تلقائي] فاتورة مبيعات يدوية رقم ${formatManualSalesInvoiceNo(m.invoiceNo||0)}${m.name?(' — '+m.name):''}`, lines, sourceManualSalesId: m.id, isAuto: true };
  journalDE.push(entry);
  m.linkedDEId = entry.id;
  return true;
}

/* ---- ترحيل تلقائي لفواتير الدورات التدريبية (فواتير العملاء) ---- */
function buildDELinesForCourseInvoice(c){
  const arAcc = accountByCode('1100'), revAcc = accountByCode('4000'), vatAcc = accountByCode('2100');
  if(!arAcc || !revAcc || !vatAcc) return null;
  const total = num(c.receiptActualValue);
  const vat = courseInvoiceVat(c.receiptActualValue);
  const net = total - vat;
  const lines = [{accountId:arAcc.id, debit:total, credit:0}, {accountId:revAcc.id, debit:0, credit:net}];
  if(vat>0.004) lines.push({accountId:vatAcc.id, debit:0, credit:vat});
  return lines;
}
/* هل عند هذا العميل دفعة نقدية (خزنة) سجّلها الاستقبال ولسه معلّقة (لم يؤكد المسؤول عن الخزنة
   استلامها فعلياً من صندوق تسويات الاستقبال)؟ لو كذلك، فاتورة دورته لا تُرحَّل تلقائياً للقيد
   المزدوج حتى تتم التسوية — نفس منطق تعليق رصيد الخزنة الفعلي، مطبَّق هنا على دفتر الأستاذ. */
function clientHasUnsettledCash(client){
  return vaultTx.some(t=> t.autoClientId===client.id && (t.destination||'vault')==='vault' && !t.deletedAt && t.settled===false);
}
/* تشخيص: لكل عميل عنده رقم فاتورة دورة ولم تُرحَّل فاتورته بعد للقيد المزدوج، يحدد السبب
   الدقيق (لا تُوجد بيانات كافية / دفعة نقدية غير مُسوّاة / حسابات ناقصة بدليل الحسابات)،
   ويُصدّر تقريراً بالتفصيل مقسّماً حسب الشهر — يساعد على معرفة أين ولماذا توقف الترحيل. */
function diagnoseUnpostedCourseInvoices(){
  const rows = [];
  const reasonCounts = {};
  courseInvoiceClients().filter(c=>!c.courseInvoiceDEId).forEach(c=>{
    let reason;
    if(!c.receiptIssueDate) reason = 'لا يوجد تاريخ صدور فاتورة مُدخل';
    else if(!(num(c.receiptActualValue)>0)) reason = 'لم تُدخل القيمة الفعلية من الإيصال';
    else if(clientHasUnsettledCash(c)) reason = 'دفعة نقدية غير مُسوّاة بعد بصندوق تسويات الاستقبال';
    else if(!buildDELinesForCourseInvoice(c)) reason = 'حسابات ناقصة بدليل الحسابات (1100 أو 4000 أو 2100)';
    else reason = 'سبب غير محدد — راجع الدعم الفني';
    reasonCounts[reason] = (reasonCounts[reason]||0) + 1;
    rows.push({
      'الشهر': (c.receiptIssueDate||'').slice(0,7) || 'بدون تاريخ',
      'رقم الهوية': c.clientId||'', 'الاسم': c.name||'', 'رقم الفاتورة': c.invoice||'',
      'تاريخ الفاتورة': c.receiptIssueDate||'', 'القيمة الفعلية': c.receiptActualValue||'',
      'السبب': reason
    });
  });
  return { rows, reasonCounts };
}
$('#btn-diagnose-unposted')?.addEventListener('click', ()=>{
  const { rows, reasonCounts } = diagnoseUnpostedCourseInvoices();
  if(!rows.length){ showToast('كل فواتير الدورات المؤهّلة مُرحّلة بالفعل للقيد المزدوج'); return; }
  rows.sort((a,b)=> a['الشهر'].localeCompare(b['الشهر']));
  downloadXlsx(`تشخيص_فواتير_غير_مرحلة_${stampNow()}.xlsx`, 'التشخيص', rows);
  const summary = Object.entries(reasonCounts).map(([r,n])=>`${n}: ${r}`).join(' — ');
  showToast(`${rows.length} فاتورة غير مُرحّلة. ${summary}`);
});
function autoPostCourseInvoice(c){
  if(c.courseInvoiceDEId) return false;
  if(!(c.receiptIssueDate && num(c.receiptActualValue)>0)) return false;
  if(clientHasUnsettledCash(c)) return false;
  const lines = buildDELinesForCourseInvoice(c);
  if(!lines) return false;
  const entry = { id: uid(), createdAt: Date.now(), date: c.receiptIssueDate, description: `[ترحيل تلقائي] فاتورة دورة ${c.invoice||''} — ${c.name||''}`, lines, sourceClientId: c.id, isAuto: true };
  journalDE.push(entry);
  c.courseInvoiceDEId = entry.id;
  return true;
}

$('#btn-migrate-sales-purchases')?.addEventListener('click', async ()=>{
  let count = 0;
  purchases.filter(p=>!p.linkedDEId).forEach(p=>{ if(autoPostPurchase(p)) count++; });
  manualSalesInvoices.filter(m=>!m.linkedDEId).forEach(m=>{ if(autoPostManualSale(m)) count++; });
  courseInvoiceClients().filter(c=>!c.courseInvoiceDEId).forEach(c=>{ if(autoPostCourseInvoice(c)) count++; });
  if(!count){ showToast('لا توجد فواتير مبيعات أو مشتريات جديدة تحتاج ترحيلاً'); return; }
  await Promise.all([saveJournalDE(), savePurchases(), saveManualSalesInvoices(), saveClients()]);
  await logAudit('add','المحاسبة', `تم ترحيل ${count} فاتورة مبيعات/مشتريات تلقائياً إلى القيد المزدوج`);
  showToast(`تم ترحيل ${count} فاتورة تلقائياً`);
  renderAccounting();
});
function renderDoubleEntryModule(){
  if(!$('#view-accounting')) return;
  renderChartOfAccountsTable();
  if($('#de-lines') && !$('#de-lines').querySelector('tr')) resetDELinesForm();
  computeDETotals();
  renderJournalDEList();
  refreshAccountSelectOptions();
  if($('#gl-account') && !$('#gl-account').value && chartOfAccounts.length) $('#gl-account').value = sortedChartOfAccounts()[0].id;
  renderGeneralLedgerDE();
  if($('#tb2-asof') && !$('#tb2-asof').value) $('#tb2-asof').value = todayISO();
  renderTrialBalanceDE2();
}

function csvDownload(filename, rows){
  const csv = '\uFEFF'+rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}
function tableToRows(tableSel){
  return Array.from(document.querySelectorAll(tableSel+' tr')).map(tr=> Array.from(tr.querySelectorAll('td,th')).map(td=>td.textContent.trim()));
}
$('#btn-export-income')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  csvDownload(`قائمة_الدخل_${from}_${to}.csv`, tableToRows('#acc-income-table'));
});
$('#btn-export-balance')?.addEventListener('click', ()=>{
  const { asOf } = accSelectedRange();
  csvDownload(`الميزانية_العمومية_حتى_${asOf}.csv`, tableToRows('#acc-balance-table'));
});
$('#btn-export-trial')?.addEventListener('click', ()=>{
  const { asOf } = accSelectedRange();
  const rows = [['الحساب','التصنيف','مدين','دائن'], ...tableToRows('#acc-trial-body')];
  csvDownload(`ميزان_المراجعة_حتى_${asOf}.csv`, rows);
});

/* ---- طباعة PDF لكل تقرير محاسبي على حدا ---- */
function printAccountingReport(title, tableSel, opts){
  opts = opts || {};
  const table = document.querySelector(tableSel);
  if(!table){ showToast('تعذّر إيجاد التقرير للطباعة'); return; }
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const { from, to, asOf, period } = accSelectedRange();
  const periodLine = opts.asOfOnly
    ? `كأرصدة تراكمية حتى: <b>${escapeHtml(formatDateDisplay(asOf))}</b>`
    : `عن الفترة: <b>${escapeHtml(formatDateDisplay(from))}</b> إلى <b>${escapeHtml(formatDateDisplay(to))}</b>`;
  const today = new Date().toLocaleDateString('ar-SA');
  // ننسخ محتوى الجدول كنص/أرقام فقط (بدون أزرار أو عناصر تفاعلية) حتى تخرج الطباعة نظيفة
  const clone = table.cloneNode(true);
  clone.querySelectorAll('button').forEach(b=>b.remove());
  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead(escapeHtml(title), {variant: 'table'})}
  <body>
    <div class="head">
      <div><h2>${escapeHtml(title)}</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">${periodLine}<br>تاريخ الطباعة: ${escapeHtml(today)}</div>
    ${clone.outerHTML}
    ${opts.extraHtml || ''}
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
}
$('#btn-print-income')?.addEventListener('click', ()=> printAccountingReport('قائمة الدخل (الأرباح والخسائر)', '#acc-income-table'));
$('#btn-print-balance')?.addEventListener('click', ()=> printAccountingReport('الميزانية العمومية (قائمة المركز المالي)', '#acc-balance-table', {asOfOnly:true}));
$('#btn-print-quarterly')?.addEventListener('click', ()=> printAccountingReport('مقارنة ربع سنوية للسنة المالية', '#acc-quarterly-table'));
$('#btn-print-trial')?.addEventListener('click', ()=> printAccountingReport('ميزان المراجعة', '#acc-trial-table', {asOfOnly:true}));
/* جداول تفاصيل الفواتير (مبيعات ثم مردودات ثم مشتريات) لطباعة الإقرار الضريبي: رقم الفاتورة، تاريخ الفاتورة، الضريبة، القيمة بدون الضريبة فقط */
function buildVatDetailTablesHtml(r){
  const salesBody = r.salesRows.map(c=>{
    const net = c.totalInclVat - c.vat;
    return `<tr><td class="mono">${escapeHtml(c.invoice||'—')}</td><td class="mono">${escapeHtml(formatDateDisplay(c.date)||'')}</td><td class="mono">${fmt(c.vat)}</td><td class="mono">${fmt(net)}</td><td class="mono">${fmt(c.totalInclVat)}</td></tr>`;
  }).join('');
  const returnsBody = (r.returnRows||[]).map(t=>{
    const net = t.amount - t.vat;
    return `<tr><td class="mono">—</td><td class="mono">${escapeHtml(formatDateDisplay(t.date)||'')}</td><td class="mono">${fmt(t.vat)}</td><td class="mono">${fmt(net)}</td><td class="mono">${fmt(t.amount)}</td></tr>`;
  }).join('');
  const purchaseBody = r.purchaseRows.map(p=>{
    const net = num(p.subtotal);
    const vat = num(p.taxAmount);
    const total = num(p.total || (net+vat));
    return `<tr><td class="mono">${escapeHtml(p.invoiceNo||'—')}</td><td class="mono">${escapeHtml(formatDateDisplay(p.date)||'')}</td><td class="mono">${fmt(vat)}</td><td class="mono">${fmt(net)}</td><td class="mono">${fmt(total)}</td></tr>`;
  }).join('');
  const head = `<tr><th>رقم الفاتورة</th><th>تاريخ الفاتورة</th><th>الضريبة</th><th>القيمة بدون الضريبة</th><th>الإجمالي</th></tr>`;
  return `
    <h3 style="margin:22px 0 6px;">تفاصيل فواتير المبيعات (${r.salesRows.length})</h3>
    <table><thead>${head}</thead><tbody>${salesBody || `<tr><td colspan="5" style="text-align:center;">لا توجد فواتير</td></tr>`}</tbody></table>
    ${(r.returnRows && r.returnRows.length) ? `
    <h3 style="margin:22px 0 6px;">تفاصيل مردودات المبيعات (${r.returnRows.length})</h3>
    <table><thead>${head}</thead><tbody>${returnsBody}</tbody></table>` : ''}
    <h3 style="margin:22px 0 6px;">تفاصيل فواتير المشتريات (${r.purchaseRows.length})</h3>
    <table><thead>${head}</thead><tbody>${purchaseBody || `<tr><td colspan="5" style="text-align:center;">لا توجد فواتير</td></tr>`}</tbody></table>
  `;
}
/* جدول صناديق نموذج الإقرار الرسمي كـ HTML جاهز للطباعة (نفس ترتيب بوابة الهيئة) */
function buildVatBoxesTableHtml(r){
  const head = `<tr><th style="width:40px;">#</th><th>البيان</th><th>القيمة (بدون ضريبة)</th><th>الضريبة</th></tr>`;
  const box = (n, label, value, vat, bold)=> `<tr style="${bold?'font-weight:800;':''}">
    <td class="mono">${n}</td><td>${label}</td>
    <td class="mono">${value===null?'—':fmt(value)}</td>
    <td class="mono">${vat===null?'—':fmt(vat)}</td>
  </tr>`;
  return `
    <h3 style="margin:22px 0 6px;">مطابقة صناديق نموذج الإقرار (بوابة الهيئة)</h3>
    <table><thead>${head}</thead><tbody>
      <tr><td colspan="4" style="font-weight:800;">المبيعات</td></tr>
      ${box('1', 'المبيعات المحلية الخاضعة للنسبة الأساسية (15%)', r.salesNet, r.outputVat)}
      ${box('2', 'المبيعات الخاضعة لآلية الاحتساب العكسي المحلي', 0, 0)}
      ${box('3', 'المبيعات المحلية الخاضعة لنسبة الصفر', 0, null)}
      ${box('4', 'الصادرات', 0, null)}
      ${box('5', 'المبيعات المعفاة', 0, null)}
      ${box('—', 'إجمالي المبيعات وضريبة المخرجات', r.salesNet, r.outputVat, true)}
      <tr><td colspan="4" style="font-weight:800;">المشتريات</td></tr>
      ${box('6', 'المشتريات المحلية الخاضعة للنسبة الأساسية (15%)', r.purchasesNet, r.inputVat)}
      ${box('7', 'الواردات الخاضعة للضريبة المدفوعة عند الجمارك', 0, 0)}
      ${box('8', 'الواردات الخاضعة للضريبة بموجب آلية الاحتساب العكسي', 0, 0)}
      ${box('9', 'المشتريات الخاضعة لنسبة الصفر', 0, null)}
      ${box('10', 'المشتريات المعفاة', 0, null)}
      ${box('—', 'إجمالي المشتريات وضريبة المدخلات', r.purchasesNet, r.inputVat, true)}
      ${box('11', r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', null, Math.abs(r.netVat), true)}
    </tbody></table>
  `;
}
$('#btn-print-vat')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  const r = buildVatReturn(from, to);
  printAccountingReport('الإقرار الضريبي (ضريبة القيمة المضافة)', '#acc-vat-table', { extraHtml: buildVatBoxesTableHtml(r) + buildVatDetailTablesHtml(r) });
});
$('#btn-export-accounting-full')?.addEventListener('click', ()=>{
  const { year, from, to, asOf } = accSelectedRange();
  const incomeRows = tableToRows('#acc-income-table').map(r=>({'البند':r[0], 'القيمة':r[1]}));
  const balanceRows = tableToRows('#acc-balance-table').map(r=>({'البند':r[0], 'القيمة':r[1]}));
  const cashflowRows = tableToRows('#acc-cashflow-table').map(r=>({'البند':r[0], 'القيمة':r[1]}));
  const trialRows = [['الحساب','التصنيف','مدين','دائن'], ...tableToRows('#acc-trial-body')].map(r=>({'الحساب':r[0],'التصنيف':r[1],'مدين':r[2],'دائن':r[3]}));
  const quarterlyRows = tableToRows('#acc-quarterly-table').map(r=>({'البند':r[0], 'الربع 1':r[1], 'الربع 2':r[2], 'الربع 3':r[3], 'الربع 4':r[4], 'الإجمالي':r[5]}));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(incomeRows), 'قائمة الدخل');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(balanceRows), 'الميزانية العمومية');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cashflowRows), 'التدفقات النقدية');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trialRows), 'ميزان المراجعة');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(quarterlyRows), 'مقارنة ربع سنوية');
  XLSX.writeFile(wb, `التقرير_المحاسبي_${year}_${from}_${to}.xlsx`);
});

/* ============ الموازنة التقديرية والتخطيط المالي (EPM) ============ */
/* ============ الموازنة التقديرية والتخطيط المالي (EPM) ============
   مُعاد بناؤها لتعتمد مباشرة على بيانات البرنامج الفعلية بدل القيود اليومية اليدوية:
   - بنود الإيراد = أنواع الدورات (من settings.courses + أي نوع فعلي مستخدم في العملاء)
     والفعلي = دخل المركز الحقيقي (centerIncome) لعملاء سُجّلوا في ذلك الشهر لهذا النوع.
   - بنود المصروف = تصنيفات المصروفات (settings.expenseCategories)
     والفعلي = مجموع حركات الخزنة الفعلية (vaultTx) من نوع "صرف" لهذا التصنيف في ذلك الشهر. */
function getBudgetEntry(year, kind, key){
  return budgetEntries.find(b=> b.year===year && b.kind===kind && b.key===key);
}
function ensureBudgetEntry(year, kind, key){
  let e = getBudgetEntry(year, kind, key);
  if(!e){
    e = { id: uid(), year, kind, key, months: Array(12).fill(0), updatedBy:null, updatedAt:null };
    budgetEntries.push(e);
  }
  return e;
}
function budgetYearTotal(entry){
  return (entry && entry.months) ? entry.months.reduce((a,b)=>a+num(b),0) : 0;
}
function budgetLineSources(){
  const courseTypes = new Set((settings.courses||[]).map(c=>c.name));
  clients.forEach(c=>{ if(c.courseType) courseTypes.add(c.courseType); });
  const expenseCats = new Set(settings.expenseCategories||[]);
  vaultTx.forEach(t=>{ if(t.type==='out' && t.category) expenseCats.add(t.category); });
  return {
    revenue: [...courseTypes].sort((a,b)=>a.localeCompare(b,'ar')),
    expense: [...expenseCats].sort((a,b)=>a.localeCompare(b,'ar'))
  };
}
function actualForLineMonth(kind, key, year, monthIndex){
  const monthKey = `${year}-${String(monthIndex+1).padStart(2,'0')}`;
  if(kind==='revenue'){
    return clients.filter(c=> !c.cancelled && (c.courseType||'')===key && (c.date||'').slice(0,7)===monthKey)
      .reduce((s,c)=>s+centerIncome(c),0);
  }
  return vaultTx.filter(t=> t.type==='out' && (t.category||'')===key && (t.date||'').slice(0,7)===monthKey)
    .reduce((s,t)=>s+num(t.amount),0);
}
function actualForLineYear(kind, key, year){
  let total = 0;
  for(let m=0;m<12;m++) total += actualForLineMonth(kind, key, year, m);
  return total;
}
function renderEpmBudget(){
  if(!$('#view-budget')) return;
  const year = parseInt($('#budget-year')?.value || new Date().getFullYear(), 10);
  const sources = budgetLineSources();
  const allLines = [
    ...sources.revenue.map(key=>({kind:'revenue', key, label:'إيراد: '+key})),
    ...sources.expense.map(key=>({kind:'expense', key, label:'مصروف: '+key}))
  ];

  const inputBody = $('#budget-input-body');
  if(inputBody){
    inputBody.innerHTML = allLines.map(line=>{
      const entry = ensureBudgetEntry(year, line.kind, line.key);
      const monthInputs = entry.months.map((v,i)=> `<td><input type="number" class="budget-month-input" data-kind="${line.kind}" data-key="${escapeHtml(line.key)}" data-month="${i}" value="${v||''}" style="width:78px;"></td>`).join('');
      return `<tr><td>${escapeHtml(line.label)}</td>${monthInputs}<td class="mono" data-line-total="${line.kind}::${escapeHtml(line.key)}">${fmt(budgetYearTotal(entry))}</td></tr>`;
    }).join('') || `<tr><td colspan="14" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد أنواع دورات أو تصنيفات مصروفات معرَّفة بعد في الإعدادات</td></tr>`;
  }

  const compareBody = $('#budget-compare-body');
  if(compareBody){
    let totalBudgetRev=0, totalActualRev=0, totalBudgetExp=0, totalActualExp=0;
    let worst = null;
    const rows = allLines.map(line=>{
      const entry = getBudgetEntry(year, line.kind, line.key);
      const budget = budgetYearTotal(entry);
      const actual = actualForLineYear(line.kind, line.key, year);
      const variance = actual - budget;
      const pct = budget!==0 ? (actual/budget*100) : (actual!==0 ? null : 100);
      if(line.kind==='revenue'){ totalBudgetRev+=budget; totalActualRev+=actual; }
      else { totalBudgetExp+=budget; totalActualExp+=actual; }
      if(budget!==0 && (!worst || Math.abs(variance) > Math.abs(worst.variance))) worst = { name:line.label, variance };
      const badColor = line.kind==='expense' ? (variance>0) : (variance<0);
      const style = variance===0 ? '' : (badColor ? 'color:var(--red);' : 'color:var(--teal);');
      return `<tr><td>${escapeHtml(line.label)}</td><td class="mono">${fmt(budget)}</td><td class="mono">${fmt(actual)}</td><td class="mono" style="${style}">${fmt(variance)}</td><td class="mono">${pct===null?'—':fmt(pct)+'%'}</td></tr>`;
    }).join('') || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد بيانات</td></tr>`;
    compareBody.innerHTML = rows;

    const cardsEl = $('#budget-summary-cards');
    if(cardsEl){
      const revPct = totalBudgetRev!==0 ? (totalActualRev/totalBudgetRev*100) : 0;
      const expPct = totalBudgetExp!==0 ? (totalActualExp/totalBudgetExp*100) : 0;
      cardsEl.innerHTML = `
        <div class="card"><div class="k">نسبة تحقيق الإيرادات المخططة</div><div class="v teal">${fmt(revPct)}%</div></div>
        <div class="card"><div class="k">نسبة تنفيذ المصروفات المخططة</div><div class="v ${expPct>100?'red':'gold'}">${fmt(expPct)}%</div></div>
        <div class="card"><div class="k">صافي المخطط (${year})</div><div class="v gold">${fmt(totalBudgetRev-totalBudgetExp)}</div></div>
        <div class="card"><div class="k">صافي الفعلي (${year})</div><div class="v teal">${fmt(totalActualRev-totalActualExp)}</div></div>
        ${worst ? `<div class="card"><div class="k">أكبر انحراف عن الموازنة</div><div class="v red" style="font-size:14px;">${escapeHtml(worst.name)} (${fmt(worst.variance)})</div></div>` : ''}
      `;
    }
  }
}
$('#budget-year')?.addEventListener('change', renderEpmBudget);
$('#budget-input-body')?.addEventListener('change', async e=>{
  const input = e.target.closest('.budget-month-input');
  if(!input) return;
  const year = parseInt($('#budget-year').value, 10);
  const kind = input.dataset.kind;
  const key = input.dataset.key;
  const monthIdx = parseInt(input.dataset.month, 10);
  const entry = ensureBudgetEntry(year, kind, key);
  entry.months[monthIdx] = num(input.value);
  entry.updatedBy = (typeof currentUser!=='undefined' && currentUser) ? currentUser : 'غير معروف';
  entry.updatedAt = Date.now();
  await saveBudgetEntries();
  await logAudit('edit','الموازنة', `تم تعديل موازنة ${year} — ${kind==='revenue'?'إيراد':'مصروف'} "${key}" — شهر ${monthIdx+1}: ${fmt(entry.months[monthIdx])}`);
  renderEpmBudget();
});
$('#btn-export-budget')?.addEventListener('click', ()=>{
  const year = parseInt($('#budget-year').value, 10);
  const sources = budgetLineSources();
  const allLines = [
    ...sources.revenue.map(key=>({kind:'revenue', key, label:'إيراد: '+key})),
    ...sources.expense.map(key=>({kind:'expense', key, label:'مصروف: '+key}))
  ];
  const rows = allLines.map(line=>{
    const entry = getBudgetEntry(year, line.kind, line.key);
    const budget = budgetYearTotal(entry);
    const actual = actualForLineYear(line.kind, line.key, year);
    return { 'البند': line.label, 'المخطط (سنوي)': budget, 'الفعلي': actual, 'الفرق': actual-budget };
  });
  downloadXlsx(`الموازنة_${year}.xlsx`, 'الموازنة', rows);
});

/* ============ بحث شامل (Global Search) ============ */
function runGlobalSearch(q){
  q = (q||'').trim().toLowerCase();
  if(q.length < 2) return { clients:[], vault:[], purchases:[] };
  const matchClients = clients.filter(c=>
    String(c.name||'').toLowerCase().includes(q) ||
    String(c.phone||'').toLowerCase().includes(q) ||
    String(c.clientId||'').toLowerCase().includes(q) ||
    String(c.invoice||'').toLowerCase().includes(q) ||
    String(c.courseNumber||'').toLowerCase().includes(q) ||
    String(c.referNum||'').toLowerCase().includes(q)
  ).slice(0,8);
  const matchVault = vaultTx.filter(t=>
    String(t.clientName||'').toLowerCase().includes(q) ||
    String(t.notes||'').toLowerCase().includes(q) ||
    String(t.category||'').toLowerCase().includes(q) ||
    String(num(t.amount)).includes(q)
  ).slice(0,8);
  const matchPurchases = purchases.filter(p=>
    String(p.supplierName||'').toLowerCase().includes(q) ||
    String(p.invoiceNo||'').toLowerCase().includes(q) ||
    String(num(p.total)).includes(q)
  ).slice(0,8);
  return { clients: matchClients, vault: matchVault, purchases: matchPurchases };
}
function renderGlobalSearchResults(q){
  const el = $('#global-search-results');
  if(!el) return;
  const { clients: rc, vault: rv, purchases: rp } = runGlobalSearch(q);
  if(q.trim().length < 2){ el.innerHTML = `<div class="hint">اكتب حرفين على الأقل للبحث</div>`; return; }
  if(!rc.length && !rv.length && !rp.length){ el.innerHTML = `<div class="hint">لا توجد نتائج مطابقة</div>`; return; }
  let html = '';
  if(rc.length){
    html += `<h4 style="margin:10px 0 6px; color:var(--navy);">العملاء (${rc.length})</h4>`;
    html += rc.map(c=> `<div class="gsr-item" data-gs-client="${c.id}" style="padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">
      <b>${escapeHtml(c.name||'')}</b> — ${escapeHtml(c.phone||'')} <span style="color:var(--text-muted); font-size:12px;">· ${escapeHtml(c.courseType||'')} · ${escapeHtml(c.invoice||'')}</span>
    </div>`).join('');
  }
  if(rv.length){
    html += `<h4 style="margin:10px 0 6px; color:var(--navy);">الحركات المالية (${rv.length})</h4>`;
    html += rv.map(t=> `<div class="gsr-item" style="padding:8px; border-bottom:1px solid var(--border);">
      <b>${fmt(num(t.amount))}</b> — ${escapeHtml(t.clientName||t.category||'')} <span style="color:var(--text-muted); font-size:12px;">· ${escapeHtml(t.date||'')} · ${t.type==='in'?'قبض':'صرف'}</span>
    </div>`).join('');
  }
  if(rp.length){
    html += `<h4 style="margin:10px 0 6px; color:var(--navy);">المشتريات (${rp.length})</h4>`;
    html += rp.map(p=> `<div class="gsr-item" style="padding:8px; border-bottom:1px solid var(--border);">
      <b>${escapeHtml(p.supplierName||'')}</b> — ${escapeHtml(p.invoiceNo||'')} <span style="color:var(--text-muted); font-size:12px;">· ${fmt(num(p.total))} · ${escapeHtml(p.date||'')}</span>
    </div>`).join('');
  }
  el.innerHTML = html;
}
function openGlobalSearch(){
  $('#global-search-overlay').classList.add('show');
  $('#global-search-input').value = '';
  $('#global-search-results').innerHTML = '';
  setTimeout(()=> $('#global-search-input')?.focus(), 50);
}
function closeGlobalSearch(){ $('#global-search-overlay').classList.remove('show'); }
$('#btn-global-search')?.addEventListener('click', openGlobalSearch);
$('#btn-close-global-search')?.addEventListener('click', closeGlobalSearch);
$('#global-search-overlay')?.addEventListener('click', e=>{ if(e.target.id==='global-search-overlay') closeGlobalSearch(); });
document.addEventListener('keydown', e=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); openGlobalSearch(); }
  if(e.key==='Escape' && $('#global-search-overlay')?.classList.contains('show')) closeGlobalSearch();
});
$('#global-search-input')?.addEventListener('input', e=> renderGlobalSearchResults(e.target.value));
$('#global-search-results')?.addEventListener('click', e=>{
  const item = e.target.closest('[data-gs-client]');
  if(!item) return;
  const client = clients.find(c=>c.id===item.dataset.gsClient);
  if(!client) return;
  closeGlobalSearch();
  document.querySelector('nav.tabs button[data-view="clients"]')?.click();
  if($('#search')){ $('#search').value = client.clientId || client.name || ''; $('#search').dispatchEvent(new Event('input')); }
});

/* ---------------- Courses / Sessions ---------------- */
function getEffectiveSessions(){
  const byCourseNumber = groupClientsByCourseNumber();
  const findFromClients = (cn, field) => {
    const arr = byCourseNumber.get(cn);
    if(!arr) return '';
    const found = arr.find(c=>c[field]);
    return found ? found[field] : '';
  };
  const list = courseSessions.map(s=>({
    ...s,
    courseType: s.courseType || findFromClients(s.courseNumber, 'courseType'),
    date: s.date || findFromClients(s.courseNumber, 'expectedCourseDate'),
    isDefined:true
  }));
  const definedNums = new Set(courseSessions.map(s=>s.courseNumber));
  const extraNums = new Set();
  clients.forEach(c=>{ if(c.courseNumber && !c.suspended && !definedNums.has(c.courseNumber)) extraNums.add(c.courseNumber); });
  extraNums.forEach(cn=>{
    list.push({id:'auto-'+cn, courseNumber:cn, courseType:findFromClients(cn,'courseType'), date:findFromClients(cn,'expectedCourseDate'), language:'', capacity:null, notes:'', isDefined:false});
  });
  return list;
}
/* تاريخ الدورة الفعلي (متى سيحضر العميل ليأخذ الدورة) — يختلف عن تاريخ التسجيل (متى دفع وسجّل).
   يُقرأ من شيت الدورات (courseSessions) حسب رقم الدورة المرتبط بالعميل. */
function actualCourseDateOf(c){
  if(!c || !c.courseNumber) return '';
  const sess = courseSessions.find(s=>s.courseNumber===c.courseNumber);
  return sess?.date || '';
}
let csUndefinedOnly = false;
function coursesFilteredSessions(){
  const ffrom = $('#cs-filter-from').value;
  const fto = $('#cs-filter-to').value;
  const fn = $('#cs-filter-num').value.trim().toLowerCase();
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  return getEffectiveSessions().filter(s=>{
    if(csUndefinedOnly && s.courseNumber && s.date && s.courseType) return false;
    if(ffrom && (!s.date || s.date<ffrom)) return false;
    if(fto && (!s.date || s.date>fto)) return false;
    if(fn && !String(s.courseNumber||'').toLowerCase().includes(fn)) return false;
    if(fcid){
      const has = clients.some(c=>c.courseNumber===s.courseNumber && String(c.clientId||'').toLowerCase().includes(fcid));
      if(!has) return false;
    }
    return true;
  }).sort((a,b)=> ffrom ? (a.date||'').localeCompare(b.date||'') : (b.date||'').localeCompare(a.date||''));
}
/* تجميع العملاء حسب رقم الدورة مرة واحدة بدل تصفية كامل مصفوفة العملاء لكل دورة على حدة —
   يقلّل زمن رسم شيت الدورات كثيراً عندما يكبر عدد العملاء والدورات */
function groupClientsByCourseNumber(){
  const map = new Map();
  clients.forEach(c=>{
    if(c.suspended || !c.courseNumber) return;
    let arr = map.get(c.courseNumber);
    if(!arr){ arr = []; map.set(c.courseNumber, arr); }
    arr.push(c);
  });
  return map;
}
/* شاشة عرض بالأعداد لشيت الدورات: بطاقات إحصائية سريعة حسب الفلتر الحالي */
function renderCoursesStats(sessions, fcid){
  const el = $('#courses-stats-cards');
  if(!el) return;
  const today = todayISO();
  let totalEnrolled = 0, totalCancelled = 0, totalAbsent = 0, activeCount = 0;
  let upcoming = 0, past = 0, undated = 0;
  let fullSessions = 0, seatsDefined = 0, seatsTaken = 0;
  const byType = {};
  const byCourseNumber = groupClientsByCourseNumber();
  sessions.forEach(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const activeEnrolled = enrolled.filter(c=>!c.cancelled);
    totalEnrolled += enrolled.length;
    totalCancelled += enrolled.filter(c=>c.cancelled).length;
    totalAbsent += enrolled.filter(c=>c.absent).length;
    activeCount += activeEnrolled.length;
    if(!s.date) undated++;
    else if(s.date >= today) upcoming++;
    else past++;
    if(s.capacity){
      seatsDefined += Number(s.capacity)||0;
      seatsTaken += activeEnrolled.length;
      if(activeEnrolled.length >= s.capacity) fullSessions++;
    }
    const t = s.courseType || 'غير محدد';
    byType[t] = (byType[t]||0) + 1;
  });
  const topType = Object.entries(byType).sort((a,b)=>b[1]-a[1])[0];
  const seatsRemaining = Math.max(0, seatsDefined - seatsTaken);
  el.innerHTML = `
    <div class="card"><div class="k">عدد الدورات</div><div class="v">${sessions.length}</div></div>
    <div class="card"><div class="k">إجمالي المسجّلين</div><div class="v gold">${totalEnrolled}</div></div>
    <div class="card"><div class="k">دورات قادمة</div><div class="v">${upcoming}</div></div>
    <div class="card"><div class="k">دورات منتهية</div><div class="v">${past}</div></div>
    <div class="card"><div class="k">دورات بلا تاريخ محدَّد</div><div class="v red">${undated}</div></div>
    <div class="card"><div class="k">دورات مكتملة العدد</div><div class="v red">${fullSessions}</div></div>
    <div class="card"><div class="k">المقاعد المتبقية (للدورات محددة السعة)</div><div class="v">${seatsDefined ? seatsRemaining : '—'}</div></div>
    <div class="card"><div class="k">ملغى / غياب</div><div class="v red">${totalCancelled} / ${totalAbsent}</div></div>
    <div class="card"><div class="k">الأكثر تكراراً</div><div class="v" style="font-size:15px;">${topType ? `${escapeHtml(topType[0])} (${topType[1]})` : '—'}</div></div>
  `;
}
let coursesPageState = {page:1, sig:''};
function renderCourses(){
  refreshMissingCourseOptions();
  renderMissingCourse();
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  let sessions = coursesFilteredSessions();
  renderCoursesStats(sessions, fcid);
  const byCourseNumber = groupClientsByCourseNumber();

  if(!sessions.length){
    $('#courses-sessions-list').innerHTML = `<div class="panel"><div class="empty-state"><div class="big">📚</div>لا توجد دورات مطابقة — أضف دورة جديدة أو عدّل الفلاتر</div></div>`;
    const cPag = $('#courses-pagination'); if(cPag) cPag.style.display = 'none';
    return;
  }
  const coursesPageRows = applyGenericPagination('courses', sessions, coursesPageState, [
    $('#cs-filter-from')?.value, $('#cs-filter-to')?.value, $('#cs-filter-num')?.value, fcid
  ]);
  $('#courses-sessions-list').innerHTML = coursesPageRows.map(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const days = courseDurationDays(s.courseType);
    const capLabel = s.capacity ? `${enrolled.length} / ${s.capacity}` : `${enrolled.length}`;
    const full = s.capacity && enrolled.length>=s.capacity;
    return `<div class="panel">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
        <div>
          <h3 style="margin:0 0 4px;">${escapeHtml(s.courseNumber||'—')} — ${escapeHtml(s.courseType||'غير محدد')}</h3>
          <div style="font-size:12.5px; color:var(--text-muted);">التاريخ: ${escapeHtml(s.date||'—')} · اللغة: ${escapeHtml(s.language||'—')} · المدة: ${days} يوم · العدد: <span class="mono">${capLabel}</span>
            ${full ? ' <span class="stamp owe">مكتملة العدد</span>' : ''}
            ${s.isDefined ? '' : ' <span class="stamp owe">غير معرّفة في شيت الدورات</span>'}
          </div>
        </div>
        <div style="white-space:nowrap;">
          ${s.isDefined ? `<button class="btn btn-ghost btn-sm" data-edit-session="${s.id}">${tr('editCourse')}</button>
          <button class="btn btn-danger btn-sm" data-del-session="${s.id}">${tr('delete')}</button>` : ''}
          <button class="btn btn-gold btn-sm" data-print-attendance="${escapeHtml(s.courseNumber)}">${tr('printAttendance')}</button>
        </div>
      </div>
      <div class="table-scroll table-scroll-course cards-mobile">
      <table>
        <thead><tr><th>الاسم</th><th>رقم الهوية</th><th>الجنسية</th><th>الحالة</th><th>حالة الحقيبة</th><th></th></tr></thead>
        <tbody>
          ${enrolled.length ? enrolled.map(c=>`
            <tr${c.cancelled?' style="opacity:.5;"':''}>
              <td data-label="الاسم">${escapeHtml(c.name)}</td>
              <td class="mono" data-label="رقم الهوية">${escapeHtml(c.clientId||'—')}</td>
              <td data-label="الجنسية">${escapeHtml(c.nationality||'')}</td>
              <td data-label="الحالة">${c.cancelled ? '<span class="stamp owe">ملغى</span>' : (c.absent ? '<span class="stamp owe">غياب</span>' : '<span class="stamp paid">مسجّل</span>')}</td>
              <td data-label="حالة الحقيبة"><span class="stamp ${c.bagSource==='buy' && c.bagStatus!=='purchased' ? 'owe':'paid'}">${bagSourceLabel(c)}</span>${bagBuyCheckboxHtml(c)}</td>
              <td class="card-full" data-label="" style="white-space:nowrap;">
                ${!c.cancelled && !c.absent ? `<button class="btn btn-danger btn-sm" data-mark-absent="${c.id}">${tr('markAbsent')}</button>` : ''}
                ${c.absent ? `<button class="btn btn-ghost btn-sm" data-clear-absent="${c.id}">${tr('clearAbsent')}</button>` : ''}
              </td>
            </tr>`).join('') : `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">لا يوجد عملاء مسجّلين برقم هذه الدورة بعد</td></tr>`}
        </tbody>
      </table>
      </div>
    </div>`;
  }).join('');
}
['#cs-filter-from','#cs-filter-to'].forEach(sel=> $(sel).addEventListener('input', renderCourses));
bindGenericPagination('courses', coursesPageState, renderCourses);
onSearchInput('#cs-filter-num', renderCourses);
onSearchInput('#cs-filter-clientid', renderCourses);
onSearchInput('#cs-filter-clientid', renderMissingCourse);
$('#btn-filter-upcoming').addEventListener('click', ()=>{
  $('#cs-filter-from').value = todayISO();
  $('#cs-filter-to').value = '';
  renderCourses();
});
$('#btn-filter-undefined').addEventListener('click', ()=>{
  csUndefinedOnly = !csUndefinedOnly;
  $('#btn-filter-undefined').classList.toggle('btn-primary', csUndefinedOnly);
  $('#btn-filter-undefined').classList.toggle('btn-ghost', !csUndefinedOnly);
  renderCourses();
});
$('#btn-export-courses').addEventListener('click', ()=>{
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  const headers = ['رقم الدورة','نوع الدورة','تاريخ الدورة','اللغة','مدة الدورة (أيام)','السعة','عدد المسجّلين','مكتملة العدد؟',
    'اسم المتدرب','رقم الهوية','رقم المرجعي','الجوال','الجنسية','نوع العميل','اسم الشركة','تاريخ التسجيل','رقم الفاتورة',
    'سعر الدورة','مصدر الحقيبة','قيمة الحقيبة','الخصم','الإجمالي','المدفوع','المتبقي','طريقة الدفع الأولى','طريقة الدفع الثانية',
    'رقم فاتورة الشبكة','حالة الحقيبة','الحالة','ملاحظات'];
  const rows = [];
  const byCourseNumber = groupClientsByCourseNumber();
  coursesFilteredSessions().forEach(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const days = courseDurationDays(s.courseType);
    const full = s.capacity && enrolled.length>=s.capacity ? 'نعم' : 'لا';
    if(enrolled.length){
      enrolled.forEach(c=>{
        rows.push([s.courseNumber,s.courseType,formatDateDisplay(s.date),s.language,days,s.capacity||'',enrolled.length,full,
          c.name,c.clientId,c.referNum||'',c.phone||'',c.nationality,c.clientType==='company'?'عميل شركات':'عميل مركز',c.companyName||'',
          formatDateDisplay(c.date),c.invoice||'',num(c.coursePrice),bagSourceLabel(c),num(c.bagPrice),num(c.discount),total(c),paidTotal(c),
          remaining(c),c.channel||'',c.channel2||'',c.networkInvoice||'',c.bagStatus||'',c.cancelled?'ملغى':(c.absent?'غياب':'مسجّل'),c.notes||'']);
      });
    } else {
      rows.push([s.courseNumber,s.courseType,formatDateDisplay(s.date),s.language,days,s.capacity||'',0,full,
        '','','','','','','','','','','','','','','','','','','','','لا يوجد مسجّلين بعد']);
    }
  });
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'الدورات.csv';
  a.click();
});

/* تقرير شامل قابل للطباعة يضم كل الدورات المطابقة للفلتر الحالي بكل تفاصيلها المتاحة (بيانات الدورة + كل متدرب فيها) */
$('#btn-print-courses-report').addEventListener('click', ()=>{
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  const sessions = coursesFilteredSessions();
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');
  const ffrom = $('#cs-filter-from').value;
  const fto = $('#cs-filter-to').value;

  const byCourseNumber = groupClientsByCourseNumber();
  const sectionsHtml = sessions.map(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const days = courseDurationDays(s.courseType);
    const capLabel = s.capacity ? `${enrolled.length} / ${s.capacity}` : `${enrolled.length}`;
    const full = s.capacity && enrolled.length>=s.capacity;
    const sessionTotal = enrolled.reduce((sum,c)=>sum+total(c),0);
    const sessionPaid = enrolled.reduce((sum,c)=>sum+paidTotal(c),0);
    const sessionRemaining = enrolled.reduce((sum,c)=>sum+remaining(c),0);
    const rowsHtml = enrolled.length ? enrolled.map((c,i)=>`
      <tr${c.cancelled?' style="opacity:.55;"':''}>
        <td>${i+1}</td>
        <td>${escapeHtml(c.name)}</td>
        <td class="mono">${escapeHtml(c.clientId||'—')}</td>
        <td>${escapeHtml(c.nationality||'—')}</td>
        <td class="mono">${escapeHtml(c.phone||'—')}</td>
        <td class="mono">${escapeHtml(c.invoice||'—')}</td>
        <td class="mono">${formatDateDisplay(c.date)||'—'}</td>
        <td class="mono">${fmt(num(c.coursePrice))}</td>
        <td>${escapeHtml(bagSourceLabel(c))}</td>
        <td class="mono">${fmt(bagAmount(c))}</td>
        <td class="mono">${fmt(num(c.discount))}</td>
        <td class="mono">${fmt(total(c))}</td>
        <td class="mono">${fmt(paidTotal(c))}</td>
        <td class="mono">${fmt(remaining(c))}</td>
        <td>${escapeHtml(paymentChannelsLabel(c))}</td>
        <td>${c.cancelled ? 'ملغى' : (c.absent ? 'غياب' : 'مسجّل')}</td>
        <td>${escapeHtml(c.notes||'—')}</td>
      </tr>`).join('') : `<tr><td colspan="17" style="text-align:center; color:#66707E;">لا يوجد عملاء مسجّلين برقم هذه الدورة بعد</td></tr>`;
    return `
    <div class="session-block">
      <div class="session-head">
        <h3>${escapeHtml(s.courseNumber||'—')} — ${escapeHtml(s.courseType||'غير محدد')}</h3>
        <div class="session-meta">
          <span>التاريخ: <b>${formatDateDisplay(s.date)||'—'}</b></span>
          <span>اللغة: <b>${escapeHtml(s.language||'—')}</b></span>
          <span>المدة: <b>${days} يوم</b></span>
          <span>عدد المسجّلين: <b>${capLabel}</b></span>
          ${full ? '<span class="stamp-full">مكتملة العدد</span>' : ''}
          ${s.isDefined ? '' : '<span class="stamp-undef">غير معرّفة في شيت الدورات</span>'}
        </div>
      </div>
      <table>
        <thead><tr>
          <th>م</th><th>الاسم</th><th>رقم الهوية</th><th>الجنسية</th><th>الجوال</th><th>رقم الفاتورة</th><th>تاريخ التسجيل</th>
          <th>سعر الدورة</th><th>مصدر الحقيبة</th><th>قيمة الحقيبة</th><th>الخصم</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th>
          <th>طريقة الدفع</th><th>الحالة</th><th>ملاحظات</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
        ${enrolled.length ? `<tfoot><tr>
          <td colspan="11" style="text-align:left; font-weight:bold;">إجمالي الدورة</td>
          <td class="mono" style="font-weight:bold;">${fmt(sessionTotal)}</td>
          <td class="mono" style="font-weight:bold;">${fmt(sessionPaid)}</td>
          <td class="mono" style="font-weight:bold;">${fmt(sessionRemaining)}</td>
          <td colspan="3"></td>
        </tr></tfoot>` : ''}
      </table>
    </div>`;
  }).join('');

  const grandEnrolled = sessions.reduce((sum,s)=>{
    let en = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) en = en.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    return sum + en.length;
  },0);

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('تقرير شامل — شيت الدورات', {variant: 'table-center', extraCss: `
    .session-block{margin-bottom:28px; page-break-inside:avoid;}
    .session-head h3{margin:0 0 4px; color:${PRINT_PALETTE.navy};}
    .session-meta{font-size:12.5px; color:${PRINT_PALETTE.muted}; margin-bottom:10px; display:flex; gap:14px; flex-wrap:wrap; align-items:center;}
    .stamp-full, .stamp-undef{background:#FDECEC; color:#B3261E; border-radius:6px; padding:2px 8px; font-size:11.5px;}
    tfoot td{background:#F5F7FA;}
    @media print{ .session-block{page-break-inside:avoid;} }
  `})}
  <body>
    <div class="head">
      <div><h2>تقرير شامل — شيت الدورات</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">
      <span>تاريخ التقرير: <b>${today}</b></span>
      ${ffrom ? `<span>من تاريخ: <b>${formatDateDisplay(ffrom)}</b></span>` : ''}
      ${fto ? `<span>إلى تاريخ: <b>${formatDateDisplay(fto)}</b></span>` : ''}
      <span>عدد الدورات: <b>${sessions.length}</b></span>
      <span>إجمالي عدد المسجّلين: <b>${grandEnrolled}</b></span>
    </div>
    ${sectionsHtml || '<div style="text-align:center; color:#66707E; padding:40px;">لا توجد دورات مطابقة للفلتر الحالي</div>'}
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
});


/* ---------------- Who hasn't joined a given course type ---------------- */
function refreshMissingCourseOptions(){
  const sel = $('#cs-missing-course');
  const cur = sel.value;
  populateSelect(sel, settings.courses.map(c=>c.name), false);
  sel.insertAdjacentHTML('afterbegin','<option value="">كل أنواع الدورات</option>');
  sel.value = settings.courses.some(c=>c.name===cur) ? cur : '';
  refreshMissingNatOptions();
}
/* ---- فلتر متعدد الجنسيات لتبويب "من سجّل ولم يُحدَّد له رقم دورة بعد" ---- */
let missingNatSelected = new Set();
function refreshMissingNatOptions(){
  const box = $('#cs-missing-nat-options');
  const nats = settings.nationalities || [];
  box.innerHTML = nats.map(n=>`
    <label style="display:flex; align-items:center; gap:6px; padding:4px 2px; font-size:13px; cursor:pointer;">
      <input type="checkbox" class="cs-missing-nat-cb" value="${escapeHtml(n)}" ${missingNatSelected.has(n)?'checked':''}>
      ${escapeHtml(n)}
    </label>`).join('') || '<div style="font-size:12px; color:var(--text-muted);">لا توجد جنسيات معرّفة</div>';
  updateMissingNatButtonLabel();
}
function updateMissingNatButtonLabel(){
  const btn = $('#cs-missing-nat-btn');
  btn.textContent = missingNatSelected.size ? `الجنسية: (${missingNatSelected.size}) ▾` : 'الجنسية: الكل ▾';
}
$('#cs-missing-nat-btn').addEventListener('click', e=>{
  e.stopPropagation();
  const panel = $('#cs-missing-nat-panel');
  panel.style.display = panel.style.display==='none' ? 'block' : 'none';
});
document.addEventListener('click', e=>{
  const wrap = $('#cs-missing-nat-wrap');
  if(wrap && !wrap.contains(e.target)) $('#cs-missing-nat-panel').style.display = 'none';
});
$('#cs-missing-nat-panel').addEventListener('click', e=> e.stopPropagation());
$('#cs-missing-nat-options').addEventListener('change', e=>{
  if(!e.target.classList.contains('cs-missing-nat-cb')) return;
  if(e.target.checked) missingNatSelected.add(e.target.value);
  else missingNatSelected.delete(e.target.value);
  updateMissingNatButtonLabel();
  renderMissingCourse();
});
$('#cs-missing-nat-clear').addEventListener('click', ()=>{
  missingNatSelected.clear();
  refreshMissingNatOptions();
  renderMissingCourse();
});
$('#cs-missing-nat-all').addEventListener('click', ()=>{
  missingNatSelected = new Set(settings.nationalities || []);
  refreshMissingNatOptions();
  renderMissingCourse();
});
function registrationAgeLabel(dateStr){
  if(!dateStr) return '<span class="stamp">—</span>';
  const AGE_THRESHOLD_DAYS = 14; // أكثر من 14 يوم منذ التسجيل يُعتبر "قديم"
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if(isNaN(days)) return '<span class="stamp">—</span>';
  return days > AGE_THRESHOLD_DAYS
    ? `<span class="stamp owe">قديم (${escapeHtml(formatDateDisplay(dateStr))})</span>`
    : `<span class="stamp paid">حديث (${escapeHtml(formatDateDisplay(dateStr))})</span>`;
}
function effectiveExpectedDate(c){ return c.expectedCourseDate || addDaysISO(c.date, 7); }
function missingCourseFiltered(){
  const sel = $('#cs-missing-course');
  const type = sel ? sel.value : '';
  const ffrom = $('#cs-missing-from').value;
  const fto = $('#cs-missing-to').value;
  const efrom = $('#cs-missing-exp-from').value;
  const eto = $('#cs-missing-exp-to').value;
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  return clients
    .filter(c=> !c.cancelled && !c.suspended && !String(c.courseNumber||'').trim())
    .filter(c=> !type || c.courseType===type)
    .filter(c=> !missingNatSelected.size || missingNatSelected.has(c.nationality))
    .filter(c=> !ffrom || (c.date && c.date>=ffrom))
    .filter(c=> !fto || (c.date && c.date<=fto))
    .filter(c=> !efrom || effectiveExpectedDate(c)>=efrom)
    .filter(c=> !eto || effectiveExpectedDate(c)<=eto)
    .filter(c=> !fcid || String(c.clientId||'').toLowerCase().includes(fcid))
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
}
function renderMissingCourse(){
  const sel = $('#cs-missing-course');
  if(!sel) return;
  const type = sel.value;
  const box = $('#cs-missing-list');
  const countEl = $('#cs-missing-count');
  // العميل يظهر إن لم يُحدَّد له رقم دورة بعد؛ اختيار نوع الدورة (إن وُجد) فلتر إضافي اختياري فقط،
  // أما بقية الفلاتر (الجنسية وتاريخ التسجيل وتاريخ الدورة المتوقع ورقم الهوية) فتعمل على كامل الشيت بكل أنواع الدورات
  const missing = missingCourseFiltered();
  countEl.textContent = type
    ? `${missing.length} عميل سجّل في دورة "${type}" ولم يُحدَّد له رقم دورة بعد`
    : `${missing.length} عميل في كل الشيت لم يُحدَّد له رقم دورة بعد`;
  if(!missing.length){
    box.innerHTML = `<div class="empty-state" style="padding:24px 10px;"><div class="big">✅</div>${type ? `لا يوجد — كل من سجّل في دورة "${escapeHtml(type)}" له رقم دورة محدَّد` : 'لا يوجد — كل العملاء لديهم رقم دورة محدَّد'}</div>`;
    return;
  }
  box.innerHTML = `<div class="table-scroll cards-mobile"><table>
    <thead><tr><th>الاسم</th><th>تاريخ التسجيل</th><th>نوع الدورة</th><th>رقم الهوية</th><th>الجوال</th><th>الجنسية</th><th>اسم الشركة</th><th>حالة الحقيبة</th><th>تاريخ دورة متوقع</th></tr></thead>
    <tbody>${missing.map(c=>`<tr>
      <td data-label="الاسم">${escapeHtml(c.name||'—')}</td>
      <td data-label="تاريخ التسجيل">${registrationAgeLabel(c.date)}</td>
      <td data-label="نوع الدورة">${escapeHtml(c.courseType||'—')}</td>
      <td class="mono" data-label="رقم الهوية">${escapeHtml(c.clientId||'—')}</td>
      <td class="mono" data-label="الجوال">${escapeHtml(c.phone||'—')}</td>
      <td data-label="الجنسية">${escapeHtml(c.nationality||'')}</td>
      <td data-label="اسم الشركة">${escapeHtml(c.companyName||'—')}</td>
      <td data-label="حالة الحقيبة"><span class="stamp ${c.bagSource==='buy' && c.bagStatus!=='purchased' ? 'owe':'paid'}">${bagSourceLabel(c)}</span>${bagBuyCheckboxHtml(c)}</td>
      <td class="card-full" data-label="تاريخ دورة متوقع"><input type="date" class="cs-expected-date" data-client-id="${escapeHtml(c.id)}" value="${escapeHtml(effectiveExpectedDate(c))}" title="تاريخ متوقّع لأخذ العميل الدورة — قيمة افتراضية تلقائية يمكن تعديلها"></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}
$('#cs-missing-course').addEventListener('change', renderMissingCourse);
$('#btn-export-missing-course')?.addEventListener('click', ()=>{
  const missing = missingCourseFiltered();
  const headers = ['الاسم','تاريخ التسجيل','نوع الدورة','رقم الهوية','الجوال','الجنسية','اسم الشركة','حالة الحقيبة','تاريخ دورة متوقع'];
  const rows = missing.map(c=>[c.name,formatDateDisplay(c.date),c.courseType,c.clientId,c.phone,c.nationality,c.companyName,bagSourceLabel(c),effectiveExpectedDate(c)]);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'عملاء_لم_يحدد_لهم_رقم_دورة.csv';
  a.click();
});
$('#cs-missing-from').addEventListener('input', renderMissingCourse);
$('#cs-missing-to').addEventListener('input', renderMissingCourse);
$('#cs-missing-exp-from').addEventListener('input', renderMissingCourse);
$('#cs-missing-exp-to').addEventListener('input', renderMissingCourse);
$('#cs-missing-list').addEventListener('change', async e=>{
  if(!e.target.classList.contains('cs-expected-date')) return;
  const id = e.target.dataset.clientId;
  const client = clients.find(c=>c.id===id);
  if(!client) return;
  client.expectedCourseDate = e.target.value;
  await saveClients();
  await logAudit('edit','الدورات', `تم تحديد تاريخ دورة متوقع للعميل ${client.name}: ${client.expectedCourseDate || '—'}`);
});

function openSessionModal(id){
  editingSessionId = id || null;
  $('#session-modal-title').textContent = id ? 'تعديل بيانات الدورة' : 'دورة جديدة';
  populateSelect($('#sf-type'), settings.courses.map(c=>c.name), true);
  const s = id ? courseSessions.find(x=>x.id===id) : null;
  $('#sf-num').value = s?.courseNumber || '';
  $('#sf-type').value = s?.courseType || '';
  $('#sf-date').value = s?.date || '';
  $('#sf-lang').value = s?.language || '';
  $('#sf-cap').value = s?.capacity ?? '';
  $('#sf-notes').value = s?.notes || '';
  $('#session-overlay').classList.add('show'); SoundFX.open();
}
function closeSessionModal(){ $('#session-overlay').classList.remove('show'); editingSessionId=null; }
$('#sf-cancel').addEventListener('click', closeSessionModal);
$('#session-overlay').addEventListener('click', e=>{ if(e.target.id==='session-overlay') closeSessionModal(); });
$('#btn-add-session').addEventListener('click', ()=>openSessionModal(null));

$('#session-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const data = {
    courseNumber: $('#sf-num').value.trim(),
    courseType: $('#sf-type').value,
    date: $('#sf-date').value,
    language: $('#sf-lang').value.trim(),
    capacity: $('#sf-cap').value ? num($('#sf-cap').value) : null,
    notes: $('#sf-notes').value.trim(),
  };
  if(!data.courseNumber){ showToast('رقم الدورة مطلوب'); return; }
  const dup = courseSessions.find(s=>s.courseNumber===data.courseNumber && s.id!==editingSessionId);
  if(dup){ showToast('رقم الدورة هذا مستخدم بالفعل لدورة أخرى'); return; }
  const wasEdit = !!editingSessionId;
  snapshotState(wasEdit ? `تعديل دورة: ${data.courseNumber}` : `إضافة دورة: ${data.courseNumber}`);
  if(editingSessionId){
    const idx = courseSessions.findIndex(s=>s.id===editingSessionId);
    const oldNum = courseSessions[idx].courseNumber;
    courseSessions[idx] = {...courseSessions[idx], ...data};
    if(oldNum!==data.courseNumber){
      clients.forEach(c=>{ if(c.courseNumber===oldNum) c.courseNumber = data.courseNumber; });
      await saveClients();
    }
    showToast('تم تحديث بيانات الدورة');
  }else{
    courseSessions.push({id:uid(), createdAt:Date.now(), createdBy: currentUser, ...data});
    showToast('تمت إضافة الدورة');
  }
  await saveCourseSessions();
  await logAudit(wasEdit?'edit':'add','الدورات', `${wasEdit?'تم تعديل':'تمت إضافة'} الدورة رقم ${data.courseNumber}`);
  closeSessionModal(); renderCourses(); renderTable();
});

$('#courses-sessions-list').addEventListener('click', async e=>{
  const editS = e.target.dataset.editSession;
  const delS = e.target.dataset.delSession;
  const printA = e.target.dataset.printAttendance;
  const markAbsent = e.target.dataset.markAbsent;
  const clearAbsent = e.target.dataset.clearAbsent;
  if(editS) openSessionModal(editS);
  if(delS){
    if(await customConfirm('تأكيد حذف هذه الدورة من الشيت؟ لن يتم حذف العملاء المسجلين، فقط بيانات الدورة نفسها.')){
      const removed = courseSessions.find(s=>s.id===delS);
      snapshotState(`حذف دورة: ${removed?.courseNumber||delS}`);
      courseSessions = courseSessions.filter(s=>s.id!==delS);
      await saveCourseSessions();
      await logAudit('delete','الدورات', `تم حذف الدورة رقم ${removed?.courseNumber||delS}`);
      renderCourses();
      showToast('تم حذف الدورة');
    }
  }
  if(printA) printAttendance(printA);
  if(markAbsent){
    const c = clients.find(x=>x.id===markAbsent);
    if(c && await customConfirm(`تحديد "${c.name}" كغائب؟ سيتم مسح رقم الدورة الحالي عنه تلقائياً حتى يوضع له رقم دورة جديد.`)){
      snapshotState(`تحديد غياب: ${c.name}`);
      const oldNum = c.courseNumber;
      c.absent = true;
      c.courseNumber = '';
      await saveClients();
      await logAudit('edit','العملاء', `تم تسجيل غياب العميل ${c.name} عن الدورة ${oldNum||''} ومسح رقم الدورة عنه تلقائياً`);
      renderCourses(); renderTable();
      showToast('تم تسجيل الغياب ومسح رقم الدورة');
    }
  }
  if(clearAbsent){
    const c = clients.find(x=>x.id===clearAbsent);
    if(c){
      snapshotState(`إلغاء غياب: ${c.name}`);
      c.absent = false;
      await saveClients();
      await logAudit('edit','العملاء', `تم إلغاء علامة الغياب عن العميل ${c.name}`);
      renderCourses(); renderTable();
      showToast('تم إلغاء علامة الغياب');
    }
  }
});

function printAttendance(courseNumber){
  const s = getEffectiveSessions().find(x=>x.courseNumber===courseNumber) || {courseNumber, courseType:'', date:'', language:''};
  const enrolled = clients.filter(c=>c.courseNumber===courseNumber && !c.cancelled && !c.suspended);
  const days = courseDurationDays(s.courseType);
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const dayCols = days===2
    ? '<th>حضور اليوم الأول</th><th>انصراف اليوم الأول</th><th>حضور اليوم الثاني</th><th>انصراف اليوم الثاني</th><th>ملاحظات</th>'
    : '<th>توقيع الحضور</th><th>توقيع الانصراف</th><th>ملاحظات</th>';
  const colCount = days===2 ? 9 : 7;
  const rowsHtml = enrolled.map((c,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(c.name)}</td><td class="mono">${escapeHtml(c.clientId||'—')}</td><td>${escapeHtml(c.nationality||'')}</td>${days===2?'<td></td><td></td><td></td><td></td>':'<td></td><td></td>'}<td></td></tr>`).join('');
  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('كشف حضور وانصراف — ' + escapeHtml(courseNumber), {variant: 'table-center'})}
  <body>
    <div class="head">
      <div><h2>كشف حضور وانصراف</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">
      <span>رقم الدورة: <b>${escapeHtml(courseNumber)}</b></span>
      <span>نوع الدورة: <b>${escapeHtml(s.courseType||'—')}</b></span>
      <span>تاريخ الدورة: <b>${escapeHtml(s.date||'—')}</b></span>
      <span>اللغة: <b>${escapeHtml(s.language||'—')}</b></span>
      <span>عدد المسجلين: <b>${enrolled.length}</b></span>
    </div>
    <table>
      <thead><tr><th>م</th><th>الاسم</th><th>رقم الهوية</th><th>الجنسية</th>${dayCols}</tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="${colCount}">لا يوجد مسجلين</td></tr>`}</tbody>
    </table>
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
}

/* عند استيراد/إدخال رقم دورة (أو رقم فاتورة) مرتبط برقم هوية غير موجود إطلاقاً في شيت العملاء ولا بأي مكان
   آخر بالبرنامج، يُضاف تلقائياً كعميل جديد بالحد الأدنى من البيانات (رقم الهوية + رقم الدورة) بدل تجاهله
   أو رفض الصف — ويبقى محفوظاً بشكل دائم في شيت العملاء/الدورات حتى لو لم تُستكمل بقية بياناته لاحقاً
   (الاسم، الجوال...)، ولا يُحذف تلقائياً لعدم اكتمال بياناته. */
function addMinimalClientForCourseImport(clientId, courseNumber, courseDate){
  const rowDate = courseDate || todayISO();
  const c = {
    id: uid(), createdAt: Date.now(), createdBy: currentUser,
    clientId, name: '',
    phone: '', nationality: '',
    clientType: 'center',
    companyName: '', creditDays: '',
    clientTaxNumber: '',
    courseType: '',
    courseNumber: courseNumber || '',
    referNum: '', invoice: '', bagInvoice: '',
    date: rowDate,
    coursePrice: 0,
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending', bagPurchaseDate: '',
    discount: 0, paid: 0,
    channel: '', networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: 'أُضيف تلقائياً برقم الهوية ورقم الدورة فقط عبر استيراد أرقام الدورات — بيانات غير مكتملة، لن يُحذف تلقائياً'
  };
  clients.push(c);
  syncClientLedgerEntry(c);
  return c;
}

function addMinimalClientForRefnumImport(clientId, referNum){
  const c = {
    id: uid(), createdAt: Date.now(), createdBy: currentUser,
    clientId, name: '',
    phone: '', nationality: '',
    clientType: 'center',
    companyName: '', creditDays: '',
    clientTaxNumber: '',
    courseType: '',
    courseNumber: '',
    referNum: referNum || '', invoice: '', bagInvoice: '',
    date: todayISO(),
    coursePrice: 0,
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending', bagPurchaseDate: '',
    discount: 0, paid: 0,
    channel: '', networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: 'أُضيف تلقائياً برقم الهوية والرقم المرجعي فقط عبر استيراد الرقم المرجعي — بيانات غير مكتملة، لن يُحذف تلقائياً'
  };
  clients.push(c);
  syncClientLedgerEntry(c);
  return c;
}

/* ---- Bulk import: course numbers & course invoice numbers, linked by رقم الهوية ---- */
$('#btn-template-course-numbers').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_أرقام_الدورات.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890', 'رقم الدورة':'CRS-1001', 'تاريخ الدورة':'2026-02-01'}
  ]);
});
$('#btn-import-course-numbers').addEventListener('click', ()=> $('#import-coursenum-input').click());
$('#import-coursenum-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    snapshotState('استيراد أرقام الدورات من Excel');
    let updated=0, added=0, skipped=0, sessionsUpdated=0, sessionsAdded=0;
    const changedRows = [];
    for(const row of json){
      const clientId = String(row['رقم الهوية']||'').trim();
      const courseNumber = String(row['رقم الدورة']||'').trim();
      if(!clientId || !courseNumber){ skipped++; continue; }
      const courseDate = normalizeExcelDate(row['تاريخ الدورة']);
      let c = clients.find(x=>x.clientId===clientId);
      let isNew = false;
      if(!c){ c = addMinimalClientForCourseImport(clientId, courseNumber, courseDate); isNew = true; added++; }
      const oldCourseNumber = isNew ? '' : (c.courseNumber||'');
      c.courseNumber = courseNumber;
      c.absent = false;
      updated++;
      let sessionNote = '';
      if(courseDate){
        const sess = courseSessions.find(s=>s.courseNumber===courseNumber);
        if(sess){
          if(sess.date!==courseDate){ sess.date = courseDate; sessionsUpdated++; sessionNote = 'تحديث تاريخ الدورة'; }
        }else{
          courseSessions.push({id:uid(), createdAt:Date.now(), createdBy: currentUser, courseNumber, courseType:c.courseType||'', date:courseDate, language:'', capacity:null, notes:''});
          sessionsAdded++;
          sessionNote = 'إضافة دورة جديدة';
        }
      }
      changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name||'(غير مكتمل — أُضيف تلقائياً)', 'رقم الدورة (قديم)':oldCourseNumber, 'رقم الدورة (جديد)':courseNumber, 'ملاحظة الجدول': isNew ? `عميل جديد أُضيف تلقائياً بالحد الأدنى من البيانات${sessionNote?' — '+sessionNote:''}` : sessionNote});
      if(courseNumber!==oldCourseNumber){
        sendPowerAutomateEvent('course_number_updated', {clientId: c.clientId, name: c.name, courseNumber: c.courseNumber, courseType: c.courseType||''});
      }
    }
    await saveClients();
    if(added){ await syncBagStockIssues(); await saveVaultTx(); }
    if(sessionsUpdated || sessionsAdded) await saveCourseSessions();
    await logAudit('edit','الدورات', `استيراد أرقام الدورات من Excel: تحديث ${updated} عميل${added?`(منهم ${added} عميل جديد أُضيف تلقائياً برقم الهوية والدورة فقط)`:''}${sessionsAdded||sessionsUpdated?`، وتحديث تاريخ ${sessionsUpdated} دورة وإضافة ${sessionsAdded} دورة جديدة`:''}${skipped?`، وتخطي ${skipped} صف بدون رقم هوية/دورة`:''}`);
    renderTable(); renderCourses();
    // تقرير بالبيانات التي تم تحديثها فعلياً
    downloadXlsx(`تقرير_استيراد_أرقام_الدورات_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
    showToast(`تم تحديث ${updated} عميل${added?`، منهم ${added} عميل جديد أُضيف تلقائياً`:''}${skipped?`، ${skipped} تم تخطيه`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد أن الأعمدة "رقم الهوية" و"رقم الدورة" (وتاريخ الدورة اختياري)');
  }finally{
    e.target.value = '';
  }
});


/* ---------------- تحديث/استيراد أرقام الدورات وفواتيرها دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل استيراد الملفين (أرقام الدورات / أرقام الفواتير) عبر Excel بجدول واحد داخل البرنامج، بنفس منطق
   الربط برقم الهوية والتحديث الجزئي (أي حقل فارغ في الصف يبقى كما هو في النظام دون تغيير). */
let csBulkRowSeq = 0;
function csBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="csb-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="csb-invoice" data-col="1" style="min-width:100px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm csb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCsBulkRow(){
  csBulkRowSeq++;
  $('#cs-bulk-table-body').insertAdjacentHTML('beforeend', csBulkRowHtml(csBulkRowSeq));
}
function openCsBulkModal(){
  $('#cs-bulk-table-body').innerHTML = '';
  $('#cs-bulk-coursenum').value = '';
  $('#cs-bulk-date').value = '';
  for(let i=0;i<5;i++) addCsBulkRow();
  $('#cs-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeCsBulkModal(){ $('#cs-bulk-overlay').classList.remove('show'); }
$('#btn-cs-bulk').addEventListener('click', openCsBulkModal);
$('#cs-bulk-cancel').addEventListener('click', closeCsBulkModal);
$('#cs-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='cs-bulk-overlay') closeCsBulkModal(); });
$('#btn-cs-bulk-row').addEventListener('click', addCsBulkRow);
$('#cs-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('csb-remove-row')){
    const rows = $('#cs-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#cs-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#cs-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCsBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>1) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-cs-bulk-save').addEventListener('click', async ()=>{
  const courseNumber = $('#cs-bulk-coursenum').value.trim();
  const courseDate = $('#cs-bulk-date').value.trim();
  const rows = [...$('#cs-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  let newClientsCount = 0;
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value.trim();
    const clientId = val('csb-id');
    const invoice = val('csb-invoice');
    if(!clientId && !invoice) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!courseNumber && !invoice){ errors.push(`${rowLabel}: أدخل رقم الدورة أعلاه أو رقم الفاتورة لهذا الصف`); return; }
    let c = clients.find(x=>x.clientId===clientId);
    let isNew = false;
    // إن لم يكن رقم الهوية موجوداً بشيت العملاء أو بأي مكان آخر بالبرنامج، يُضاف تلقائياً كعميل جديد
    // بالحد الأدنى من البيانات (رقم الهوية + رقم الدورة) بدل رفض الصف، ويبقى محفوظاً حتى لو لم تكتمل بياناته لاحقاً.
    if(!c){ c = addMinimalClientForCourseImport(clientId, courseNumber, courseDate); isNew = true; newClientsCount++; }
    items.push({clientId, courseNumber, courseDate, invoice, c, isNew});
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`تحديث/استيراد أرقام الدورات وفواتيرها من جدول داخل البرنامج (${items.length} صف)`);
  let updated=0, sessionsUpdated=0, sessionsAdded=0;
  const changedRows = [];
  items.forEach(({clientId, courseNumber, courseDate, invoice, c, isNew})=>{
    const oldCourseNumber = isNew ? '' : (c.courseNumber||'');
    const oldInvoice = isNew ? '' : (c.invoice||'');
    let sessionNote = '';
    if(courseNumber){
      c.courseNumber = courseNumber;
      c.absent = false;
      if(courseDate){
        const sess = courseSessions.find(s=>s.courseNumber===courseNumber);
        if(sess){
          if(sess.date!==courseDate){ sess.date = courseDate; sessionsUpdated++; sessionNote = 'تحديث تاريخ الدورة'; }
        }else{
          courseSessions.push({id:uid(), createdAt:Date.now(), createdBy: currentUser, courseNumber, courseType:c.courseType||'', date:courseDate, language:'', capacity:null, notes:''});
          sessionsAdded++;
          sessionNote = 'إضافة دورة جديدة';
        }
      }
    }
    if(invoice) c.invoice = invoice;
    updated++;
    changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name||'(غير مكتمل — أُضيف تلقائياً)', 'رقم الدورة (قديم)':oldCourseNumber, 'رقم الدورة (جديد)':c.courseNumber||'', 'رقم الفاتورة (قديم)':oldInvoice, 'رقم الفاتورة (جديد)':c.invoice||'', 'ملاحظة الجدول': isNew ? `عميل جديد أُضيف تلقائياً بالحد الأدنى من البيانات${sessionNote?' — '+sessionNote:''}` : sessionNote});
    if(c.courseNumber && c.courseNumber!==oldCourseNumber){
      sendPowerAutomateEvent('course_number_updated', {clientId: c.clientId, name: c.name, courseNumber: c.courseNumber, courseType: c.courseType||''});
    }
  });
  await saveClients();
  if(newClientsCount){ await syncBagStockIssues(); await saveVaultTx(); }
  if(sessionsUpdated || sessionsAdded) await saveCourseSessions();
  await logAudit('edit','الدورات', `تحديث/استيراد أرقام الدورات وفواتيرها من جدول داخل البرنامج: تحديث ${updated} عميل${newClientsCount?`(منهم ${newClientsCount} عميل جديد أُضيف تلقائياً برقم الهوية والدورة فقط)`:''}${sessionsAdded||sessionsUpdated?`، وتحديث تاريخ ${sessionsUpdated} دورة وإضافة ${sessionsAdded} دورة جديدة`:''}`);
  closeCsBulkModal();
  renderTable(); renderCourses();
  // تقرير بالبيانات التي تم تحديثها فعلياً
  downloadXlsx(`تقرير_تحديث_أرقام_الدورات_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
  showToast(`تم تحديث ${updated} عميل${newClientsCount?`، منهم ${newClientsCount} عميل جديد أُضيف تلقائياً`:''}`);
});

/* ---------------- استيراد/تحديث الرقم المرجعي دفعة واحدة (جدول داخل البرنامج) ----------------
   الربط برقم الهوية فقط: تحديث جزئي (الرقم المرجعي فقط) لعميل موجود، أو إضافة عميل جديد بالحد الأدنى
   من البيانات (رقم الهوية + الرقم المرجعي) إن لم يكن موجوداً — بنفس منطق استيراد أرقام الدورات. */
let refnumBulkRowSeq = 0;
function refnumBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="rnb-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="rnb-refnum" data-col="1" style="min-width:120px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm rnb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addRefnumBulkRow(){
  refnumBulkRowSeq++;
  $('#refnum-bulk-table-body').insertAdjacentHTML('beforeend', refnumBulkRowHtml(refnumBulkRowSeq));
}
function openRefnumBulkModal(){
  $('#refnum-bulk-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addRefnumBulkRow();
  $('#refnum-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeRefnumBulkModal(){ $('#refnum-bulk-overlay').classList.remove('show'); }
$('#btn-refnum-bulk').addEventListener('click', openRefnumBulkModal);
$('#refnum-bulk-cancel').addEventListener('click', closeRefnumBulkModal);
$('#refnum-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='refnum-bulk-overlay') closeRefnumBulkModal(); });
$('#btn-refnum-bulk-row').addEventListener('click', addRefnumBulkRow);
$('#refnum-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('rnb-remove-row')){
    const rows = $('#refnum-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#refnum-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#refnum-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addRefnumBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>1) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-refnum-bulk-save').addEventListener('click', async ()=>{
  const rows = [...$('#refnum-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  let newClientsCount = 0;
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value.trim();
    const clientId = val('rnb-id');
    const referNum = val('rnb-refnum');
    if(!clientId && !referNum) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!referNum){ errors.push(`${rowLabel}: الرقم المرجعي مطلوب`); return; }
    let c = clients.find(x=>x.clientId===clientId);
    let isNew = false;
    if(!c){ c = addMinimalClientForRefnumImport(clientId, referNum); isNew = true; newClientsCount++; }
    items.push({clientId, referNum, c, isNew});
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`استيراد/تحديث الرقم المرجعي من جدول داخل البرنامج (${items.length} صف)`);
  let updated=0;
  const changedRows = [];
  items.forEach(({clientId, referNum, c, isNew})=>{
    const oldReferNum = isNew ? '' : (c.referNum||'');
    c.referNum = referNum;
    updated++;
    changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name||'(غير مكتمل — أُضيف تلقائياً)', 'الرقم المرجعي (قديم)':oldReferNum, 'الرقم المرجعي (جديد)':c.referNum||'', 'ملاحظة الجدول': isNew ? 'عميل جديد أُضيف تلقائياً بالحد الأدنى من البيانات' : ''});
  });
  await saveClients();
  if(newClientsCount){ await syncBagStockIssues(); await saveVaultTx(); }
  await logAudit('edit','العملاء', `استيراد/تحديث الرقم المرجعي من جدول داخل البرنامج: تحديث ${updated} عميل${newClientsCount?`(منهم ${newClientsCount} عميل جديد أُضيف تلقائياً برقم الهوية والرقم المرجعي فقط)`:''}`);
  closeRefnumBulkModal();
  renderTable();
  downloadXlsx(`تقرير_استيراد_الرقم_المرجعي_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
  showToast(`تم تحديث ${updated} عميل${newClientsCount?`، منهم ${newClientsCount} عميل جديد أُضيف تلقائياً`:''}`);
});

/* ---------------- استيراد عمال الشركات دفعة واحدة (جدول داخل البرنامج فقط — بدون Excel) ----------------
   الربط برقم الهوية فقط: تحديث اسم الشركة (ونوع العميل تلقائياً إلى "عميل شركات") لعميل موجود، أو إضافة
   عميل جديد بالحد الأدنى من البيانات (رقم الهوية + اسم الشركة) إن لم يكن موجوداً — بنفس منطق استيراد
   الرقم المرجعي، لكن عبر جدول لصق داخل البرنامج فقط دون أي رفع لملف Excel. */
function addMinimalClientForCompanyImport(clientId, companyName){
  const c = {
    id: uid(), createdAt: Date.now(), createdBy: currentUser,
    clientId, name: '',
    phone: '', nationality: '',
    clientType: 'company',
    companyName: companyName || '', creditDays: '',
    clientTaxNumber: '',
    courseType: '',
    courseNumber: '',
    referNum: '', invoice: '', bagInvoice: '',
    date: todayISO(),
    coursePrice: 0,
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending', bagPurchaseDate: '',
    discount: 0, paid: 0,
    channel: '', networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: 'أُضيف تلقائياً برقم الهوية واسم الشركة فقط عبر استيراد عمال الشركات — بيانات غير مكتملة، لن يُحذف تلقائياً'
  };
  clients.push(c);
  syncClientLedgerEntry(c);
  return c;
}
let compWorkersBulkRowSeq = 0;
function compWorkersBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="cwb-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:150px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm cwb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCompWorkersBulkRow(){
  compWorkersBulkRowSeq++;
  $('#compworkers-bulk-table-body').insertAdjacentHTML('beforeend', compWorkersBulkRowHtml(compWorkersBulkRowSeq));
}
function openCompWorkersBulkModal(){
  $('#compworkers-bulk-company').value = '';
  $('#compworkers-bulk-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addCompWorkersBulkRow();
  $('#compworkers-bulk-overlay').classList.add('show'); SoundFX.open();
  setTimeout(()=>$('#compworkers-bulk-company').focus(), 50);
}
function closeCompWorkersBulkModal(){ $('#compworkers-bulk-overlay').classList.remove('show'); }
$('#btn-compworkers-bulk').addEventListener('click', openCompWorkersBulkModal);
$('#compworkers-bulk-cancel').addEventListener('click', closeCompWorkersBulkModal);
$('#compworkers-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='compworkers-bulk-overlay') closeCompWorkersBulkModal(); });
$('#btn-compworkers-bulk-row').addEventListener('click', addCompWorkersBulkRow);
$('#compworkers-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('cwb-remove-row')){
    const rows = $('#compworkers-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// دعم لصق عمود كامل (رقم هوية واحد في كل سطر) منسوخ من إكسل مباشرة داخل الجدول
$('#compworkers-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').map(l=>l.split('\t')[0]);
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#compworkers-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  lines.forEach((val, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCompWorkersBulkRow();
    const row = tbody.children[rowIdx];
    const field = row.querySelector('[data-col="0"]');
    if(field) field.value = val.trim();
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-compworkers-bulk-save').addEventListener('click', async ()=>{
  const companyName = $('#compworkers-bulk-company').value.trim();
  if(!companyName){ showToast('اكتب اسم الشركة أعلى الجدول أولاً'); $('#compworkers-bulk-company').focus(); return; }
  const rows = [...$('#compworkers-bulk-table-body').querySelectorAll('tr')];
  const items = [];
  const seenIds = new Set();
  let newClientsCount = 0;
  rows.forEach(row=>{
    const clientId = row.querySelector('.cwb-id').value.trim();
    if(!clientId) return; // صف فارغ يُتجاهل بصمت
    if(seenIds.has(clientId)) return; // تكرار داخل نفس الجدول يُتجاهل بصمت
    seenIds.add(clientId);
    let c = clients.find(x=>x.clientId===clientId);
    let isNew = false;
    if(!c){ c = addMinimalClientForCompanyImport(clientId, companyName); isNew = true; newClientsCount++; }
    items.push({clientId, c, isNew});
  });
  if(!items.length){ showToast('أدخل رقم هوية واحداً على الأقل'); return; }
  snapshotState(`استيراد عمال الشركات من جدول داخل البرنامج (${items.length} صف) — الشركة: ${companyName}`);
  let updated=0;
  items.forEach(({c, isNew})=>{
    c.companyName = companyName;
    if(!isNew) c.clientType = 'company';
    updated++;
  });
  await saveClients();
  if(newClientsCount){ await syncBagStockIssues(); await saveVaultTx(); }
  await logAudit('edit','العملاء', `استيراد عمال الشركات من جدول داخل البرنامج للشركة "${companyName}": تحديث ${updated} عميل${newClientsCount?`(منهم ${newClientsCount} عميل جديد أُضيف تلقائياً برقم الهوية واسم الشركة فقط)`:''}`);
  closeCompWorkersBulkModal();
  renderTable(); refreshFilterOptions();
  showToast(`تم تحديث ${updated} عميل${newClientsCount?`، منهم ${newClientsCount} عميل جديد أُضيف تلقائياً`:''} — الشركة: ${companyName}`);
});

/* ---------------- تحديث/استيراد فواتير الدورات دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل استيراد ملف Excel بنفس منطق الربط برقم الهوية (وبرقم الدورة إن وُجد) والتحديث الجزئي. */
let ciBulkRowSeq = 0;
function ciBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="cib-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="cib-coursenum" data-col="1" style="min-width:100px;"></td>
    <td><input type="text" class="cib-invoice" data-col="2" style="min-width:100px;"></td>
    <td><input type="date" class="cib-date" data-col="3" style="min-width:120px;"></td>
    <td><input type="number" step="0.01" class="cib-value" data-col="4" style="min-width:110px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm cib-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCiBulkRow(){
  ciBulkRowSeq++;
  $('#ci-bulk-table-body').insertAdjacentHTML('beforeend', ciBulkRowHtml(ciBulkRowSeq));
}
function openCiBulkModal(){
  $('#ci-bulk-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addCiBulkRow();
  $('#ci-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeCiBulkModal(){ $('#ci-bulk-overlay').classList.remove('show'); }
$('#btn-ci-bulk').addEventListener('click', openCiBulkModal);
$('#ci-bulk-cancel').addEventListener('click', closeCiBulkModal);
$('#ci-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='ci-bulk-overlay') closeCiBulkModal(); });
$('#btn-ci-bulk-row').addEventListener('click', addCiBulkRow);
$('#ci-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('cib-remove-row')){
    const rows = $('#ci-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#ci-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#ci-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCiBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>4) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.classList.contains('cib-date')){ const norm = normalizeDateForBulkPaste(val); if(norm) field.value = norm; }
      else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-ci-bulk-save').addEventListener('click', async ()=>{
  const rows = [...$('#ci-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value.trim();
    const clientId = val('cib-id');
    const courseNumber = val('cib-coursenum');
    const invoice = val('cib-invoice');
    const date = val('cib-date');
    const valueRaw = val('cib-value');
    if(!clientId && !courseNumber && !invoice && !date && !valueRaw) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!courseNumber && !invoice && !date && valueRaw===''){ errors.push(`${rowLabel}: أدخل رقم الدورة أو رقم الفاتورة أو التاريخ أو القيمة الفعلية`); return; }
    // البحث أولاً بمطابقة رقم الهوية + رقم الدورة معاً (لتحديد التسجيل الصحيح عند تعدد دورات نفس العميل)،
    // وإن لم يوجد رقم دورة في الصف أو لم تُطابق، نكتفي بمطابقة رقم الهوية وحده
    let c = null;
    if(courseNumber) c = clients.find(x=>x.clientId===clientId && String(x.courseNumber||'').trim()===courseNumber);
    if(!c) c = clients.find(x=>x.clientId===clientId);
    if(!c){ errors.push(`${rowLabel}: رقم الهوية ${clientId} غير موجود بشيت العملاء`); return; }
    items.push({clientId, invoice, date, valueRaw, c});
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`تحديث/استيراد فواتير الدورات من جدول داخل البرنامج (${items.length} صف)`);
  let updated=0, invoiceChanged=0, postedCount=0;
  const changedRows = [];
  items.forEach(({clientId, invoice, date, valueRaw, c})=>{
    const oldInvoice = c.invoice||'';
    const oldDate = c.receiptIssueDate||'';
    const oldValue = c.receiptActualValue||'';
    // رقم الفاتورة (رقم الإيصال) فقط هو ما يُرحَّل ويُربط مع باقي شيتات النظام — أما التاريخ والقيمة الفعلية
    // فيبقى تحديثهما محصوراً داخل شيت فواتير الدورات نفسه فقط
    if(invoice){
      c.invoice = invoice;
      if(invoice!==oldInvoice) invoiceChanged++;
    }
    if(date) c.receiptIssueDate = date;
    if(valueRaw!==''){ c.receiptActualValue = num(valueRaw); }
    if(typeof autoPostCourseInvoice==='function' && autoPostCourseInvoice(c)) postedCount++;
    updated++;
    changedRows.push({
      'رقم الهوية':clientId, 'الاسم':c.name, 'رقم الدورة':c.courseNumber||'',
      'رقم الفاتورة (قديم)':oldInvoice, 'رقم الفاتورة (جديد)':c.invoice||'',
      'تاريخ الفاتورة (قديم)':oldDate, 'تاريخ الفاتورة (جديد)':c.receiptIssueDate||'',
      'القيمة الفعلية (قديمة)':oldValue, 'القيمة الفعلية (جديدة)':c.receiptActualValue||''
    });
  });
  await saveClients();
  if(postedCount>0) await saveJournalDE();
  await logAudit('edit','فواتير الدورات', `تحديث/استيراد فواتير الدورات من جدول داخل البرنامج: تحديث ${updated} سجل${invoiceChanged?` (تم ترحيل ${invoiceChanged} رقم فاتورة تلقائياً إلى شيت العملاء وربطها بجميع الشيتات)`:''}${postedCount?` — ورُحّلت ${postedCount} فاتورة تلقائياً للقيد المزدوج`:''}`);
  closeCiBulkModal();
  if(invoiceChanged && typeof refreshEverything==='function'){
    // رقم الفاتورة تغيّر فعلياً لسجل واحد أو أكثر → يُحدَّث النظام بالكامل (شيت العملاء، لوحة التحكم، الدورات، التقارير...)
    refreshEverything();
  }else{
    // لا يوجد تغيير في أرقام الفواتير (تحديث تاريخ/قيمة فعلية فقط) → يبقى التحديث محصوراً في شيت فواتير الدورات فقط
    renderCourseInvoices();
  }
  // تقرير بالبيانات التي تم تحديثها فعلياً
  downloadXlsx(`تقرير_تحديث_فواتير_الدورات_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
  showToast(`تم تحديث ${updated} سجل${invoiceChanged?` — ورُبط ${invoiceChanged} رقم فاتورة بجميع الشيتات`:''}`);
});

/* ---------------- Excel Import / Export (linked by رقم الهوية) ---------------- */
function bagSourceToLabel(s){ return s==='own' ? 'خاصته' : s==='stock' ? 'من المخزون' : 'شراء'; }
/* عرض التاريخ بصيغة يوم/شهر/سنة للمستخدم، مع بقاء التخزين الداخلي بصيغة ISO (سنة-شهر-يوم) للفرز والفلترة */
function formatDateDisplay(iso){
  if(!iso) return '';
  const s = String(iso).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}
function normalizeExcelDate(v){
  if(v===undefined || v===null || v==='') return '';
  if(v instanceof Date && !isNaN(v)){
    // نستخدم مكوّنات التاريخ المحلي (وليس toISOString الذي يحوّل إلى UTC)
    // لتجنّب رجوع التاريخ يوماً إلى الخلف (مثال: 18 يتحول خطأً إلى 17)
    const y = v.getFullYear();
    const m = String(v.getMonth()+1).padStart(2,'0');
    const d = String(v.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // تاريخ نصي بصيغة يوم/شهر/سنة (الصيغة الشائعة عند إدخال أو حفظ التاريخ كنص في إكسل بدل خلية تاريخ حقيقية)
  // مثال: عمود "التاريخ" محفوظ كنص "04/06/2026" ولم يُكتشف كخلية تاريخ، فكان يمر بدون تحويل ويظهر لاحقاً بترتيب مقلوب
  const dm = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(dm){
    let day = Number(dm[1]), month = Number(dm[2]);
    const year = dm[3];
    // نفترض دائماً يوم/شهر/سنة (المعتاد محلياً)، ولا نبدّل الترتيب إلا إذا كان الرقم الأول لا يصلح كيوم (أكبر من 31)
    // أو لا يصلح كشهر ثانٍ (أكبر من 12) بينما الثاني يصلح كيوم — عندها تكون الصيغة الأصلية شهر/يوم
    if(!(day>=1 && day<=31) || (month>12 && day<=12)){
      const tmp = day; day = month; month = tmp;
    }
    if(day>=1 && day<=31 && month>=1 && month<=12){
      return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }
  // Excel serial date number as string
  if(/^\d+(\.\d+)?$/.test(s)){
    const d = XLSX.SSF.parse_date_code(Number(s));
    if(d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  return s;
}
function clientToExportRow(c){
  return {
    'رقم الهوية': c.clientId||'',
    'الاسم': c.name||'',
    'رقم المرجع': c.referNum||'',
    'الجوال': c.phone||'',
    'الجنسية': c.nationality||'',
    'نوع العميل': c.clientType==='company' ? 'عميل شركات' : 'عميل مركز',
    'اسم الشركة': c.companyName||'',
    'الأجل (أيام)': c.clientType==='company' ? (num(c.creditDays)||'') : '',
    'نوع الدورة': c.courseType||'',
    'رقم الدورة': c.courseNumber||'',
    'رقم الفاتورة': c.invoice||'',
    'التاريخ': c.date||'',
    'سعر الدورة': num(c.coursePrice),
    'مصدر الحقيبة': bagSourceToLabel(c.bagSource),
    'قيمة الحقيبة': num(c.bagPrice),
    'رقم فاتورة الحقيبة': c.bagInvoice||'',
    'الخصم': num(c.discount),
    'المدفوع': num(c.paid),
    'طريقة الدفع': c.channel||'',
    'المبلغ (الطريقة الثانية)': num(c.paid2),
    'طريقة الدفع الثانية': c.channel2||'',
    'رقم فاتورة الشبكة': c.networkInvoice||'',
    'الحالة': c.stage||'',
    'ملغى': c.cancelled ? 'نعم' : 'لا',
    'ملاحظات': c.notes||''
  };
}
