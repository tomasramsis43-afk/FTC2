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
  await withBtnLoading($('#btn-add-account'), async ()=>{
    chartOfAccounts.push({ id: uid(), code, name, type });
    await saveChartOfAccounts();
    await logAudit('add','المحاسبة', `تمت إضافة حساب لدليل الحسابات: ${code} — ${name} (${accountTypeLabel(type)})`);
    $('#coa-code').value=''; $('#coa-name').value='';
    showToast('تمت إضافة الحساب');
    renderChartOfAccountsTable();
    refreshAccountSelectOptions();
  });
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
  const btn = $('#btn-de-save');
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
  await withBtnLoading(btn, async ()=>{
    journalDE.push({ id: uid(), createdAt: Date.now(), date, description, lines });
    await saveJournalDE();
    await logAudit('add','المحاسبة', `تمت إضافة قيد يومية: ${description} بمبلغ ${fmt(totalDebit)} ﷼ (${lines.length} سطور)`);
    $('#de-desc').value = '';
    resetDELinesForm();
    showToast('تم حفظ القيد اليومية');
    renderDoubleEntryModule();
  });
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
  // الرصيد الافتتاحي (carried forward): عند الفلترة بفترة تبدأ بعد البداية، يجب أن يبدأ الرصيد
  // المعروض من الرصيد المتراكم حتى اليوم السابق للفترة، وإلا ظهر حساب برصيد صفري (أو خاطئ)
  // رغم وجود حركات سابقة عليه — كان balance يبدأ دائماً من صفر فيعرض رصيداً ناقصاً.
  const openingBalance = (from)
    ? journalDE.filter(e=> e.date && e.date < from).reduce((s,e)=> s + (e.lines||[]).reduce((sl,l)=> sl + (l.accountId===accountId ? (normal==='debit' ? num(l.debit)-num(l.credit) : num(l.credit)-num(l.debit)) : 0), 0), 0)
    : 0;
  let rows = [];
  journalDE.forEach(entry=> (entry.lines||[]).forEach(l=>{
    if(l.accountId===accountId) rows.push({ date: entry.date, description: entry.description, debit: num(l.debit), credit: num(l.credit) });
  }));
  rows = rows.filter(r=> inRange(r.date, from, to)).sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  let balance = openingBalance;
  const header = from ? `<tr><td class="mono" style="color:var(--text-muted);">${escapeHtml(formatDateDisplay(addDaysISO(from, -1))||'')}</td><td style="color:var(--text-muted);">رصيد افتتاحي (مرحّل من قبل الفترة)</td><td></td><td></td><td class="mono" style="font-weight:700;">${fmt(balance)}</td></tr>` : '';
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
  tbody.innerHTML = header + body || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد حركات على هذا الحساب ضمن الفترة المحددة</td></tr>`;
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

/* تنظيف القيود اليومية اليتيمة: قيد يومية بترحيل تلقائي (isAuto) مرتبط بمصدر لم يعد موجوداً —
   فاتورة شراء/مبيعات يدوية/قيد يدوي/فاتورة دورة حُذفت دون حذف قيدها المرتبط — كان يبقى إلى
   الأبد في القيد المزدوج كأثر وحيد للوثيقة المحذوفة: يظهر في دليل الحسابات وتقارير القيود
   اليومية بمبالغ لا أصل لها، وأي قيد/فاتورة جديدة بنفس الحسابات تخالف توازن الدفاتر. تُحذف
   هنا تلقائياً عند كل تحميل، مع مسح مؤشرات المصادر التي لا تزال حية لكن قيدها اختفى (حُذف
   يدوياً مثلاً) حتى يعيد الترحيل التلقائي إنشاءه عند الحاجة بدل بقاء الوثيقة "مُرحَّلة" رغم
   غياب قيدها الفعلي. آمنة للتكرار (تعمل على الحالة الحالية ولا تفترض شيئاً عن الجلسات السابقة). */
function cleanupOrphanedJournalDE(){
  const liveSourceIds = new Set();
  journalEntries.forEach(j=> liveSourceIds.add(j.id));
  purchases.forEach(p=> liveSourceIds.add(p.id));
  manualSalesInvoices.forEach(m=> liveSourceIds.add(m.id));
  if(typeof courseInvoiceClients==='function') courseInvoiceClients().forEach(c=> liveSourceIds.add(c.id));
  const before = journalDE.length;
  const liveDeIds = new Set();
  journalDE = journalDE.filter(e=>{
    const hasSource = !!(e.sourceJournalEntryId || e.sourcePurchaseId || e.sourceManualSalesId || e.sourceClientId);
    if(!hasSource) return true; // قيد يدوي بلا مصدر — يُحذف فقط من واجهته
    const live = e.sourceJournalEntryId ? liveSourceIds.has(e.sourceJournalEntryId)
      : e.sourcePurchaseId ? liveSourceIds.has(e.sourcePurchaseId)
      : e.sourceManualSalesId ? liveSourceIds.has(e.sourceManualSalesId)
      : liveSourceIds.has(e.sourceClientId);
    if(live) liveDeIds.add(e.id);
    return live;
  });
  const removed = before - journalDE.length;
  let pointersFixed = 0;
  journalEntries.forEach(j=>{ if(j.linkedDEId && !liveDeIds.has(j.linkedDEId)){ delete j.linkedDEId; pointersFixed++; } });
  if(typeof courseInvoiceClients==='function') courseInvoiceClients().forEach(c=>{ if(c.courseInvoiceDEId && !liveDeIds.has(c.courseInvoiceDEId)){ delete c.courseInvoiceDEId; pointersFixed++; } });
  if(removed>0 || pointersFixed>0) return { removed, pointersFixed };
  return null;
}

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
  const vat = vatFromGross(total);
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
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
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
