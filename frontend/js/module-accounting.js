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
    {id:uid(), code:'1000', name:'النقدية (الخزنة)', type:'asset'},
    {id:uid(), code:'1010', name:'البنك', type:'asset'},
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
  // فلتر «الحساب» في سجل القيود اليومية (عرض فقط)
  const deAccSel = $('#de-filter-account');
  if(deAccSel){
    const cur = deAccSel.value;
    deAccSel.innerHTML = '<option value="">كل الحسابات</option>' + accountOptionsHtml();
    if(cur && chartOfAccounts.some(a=>a.id===cur)) deAccSel.value = cur; else deAccSel.value = '';
  }
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
    /* مؤشر التوازن الحي (Phase 4c): عرض فقط — منطق التوفير/الحفظ في مكانه */
    const emptyForm = debit === 0 && credit === 0;
    const maxSide = Math.max(debit, credit);
    const pctD = maxSide > 0 ? Math.round(debit / maxSide * 100) : 0;
    const pctC = maxSide > 0 ? Math.round(credit / maxSide * 100) : 0;
    const pill = emptyForm
      ? `<span class="de-pill muted">بانتظار الإدخال</span>`
      : balanced
        ? `<span class="de-pill ok">✅ القيد متوازن</span>`
        : `<span class="de-pill bad">⚠️ غير متوازن — الفرق ${fmt(Math.abs(diff))}</span>`;
    const fixBtn = (!emptyForm && !balanced)
      ? `<button type="button" class="btn btn-gold btn-sm" id="de-diff-fix" title="يضيف سطراً جديداً بمقدار الفرق على الجهة الناقصة">سدّ الفرق تلقائياً</button>` : '';
    totalsEl.innerHTML = `
      <div class="de-balance ${emptyForm ? '' : (balanced ? 'is-balanced' : 'is-unbalanced')}">
        <div class="de-side"><small>إجمالي مدين</small><b class="mono">${fmt(debit)}</b><i style="width:${pctD}%"></i></div>
        ${pill}${fixBtn}
        <div class="de-side alt"><small>إجمالي دائن</small><b class="mono">${fmt(credit)}</b><i style="width:${pctC}%"></i></div>
      </div>`;
  }
  return { debit, credit, balanced };
}
/* سدّ الفرق تلقائياً: يضيف سطر توازن جديد بالفرق على الجهة الناقصة —
   تعبئة نموذج فقط؛ الحفظ يمر عبر btn-de-save ومساره القائم كما هو */
document.addEventListener('click', e=>{
  if(e.target.id !== 'de-diff-fix') return;
  const tbody = $('#de-lines');
  if(!tbody) return;
  let debit=0, credit=0;
  document.querySelectorAll('#de-lines .de-line-debit').forEach(i=> debit += num(i.value));
  document.querySelectorAll('#de-lines .de-line-credit').forEach(i=> credit += num(i.value));
  const diff = Number((debit - credit).toFixed(2));
  if(Math.abs(diff) < 0.01){ showToast('القيد متوازن بالفعل'); return; }
  tbody.insertAdjacentHTML('beforeend', deLineRowHtml());
  const last = tbody.lastElementChild;
  const inp = last.querySelector(diff > 0 ? '.de-line-credit' : '.de-line-debit');
  if(inp){ inp.value = Math.abs(diff); }
  computeDETotals();
  inp?.focus();
});
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
/* ==================== سجل القيود اليومية — عرض احترافي ====================
   تنبيه: هذا القسم عرض وتنظيم فقط. لا يغيّر أي منطق محاسبي ولا يعدّل أي قيد.
   - رقم القيد (JV-YYYY-####) رقم عرضي يُحسب من ترتيب الإنشاء داخل سنة القيد،
     ولا يُحفظ في البيانات ولا يُستخدم في أي حساب (حذف قيد يعيد ترقيم ما بعده).
   - كل الإجماليات وحالة التوازن محسوبة من سطور القيد كما هي مخزّنة.
   ========================================================================= */
const DE_PAGE_GROUPS = 12;              // عدد الأيام (المجموعات) في الصفحة الواحدة
let deCurrentPage = 1;
const deExpandedEntries = new Set();    // القيود المفتوحة (تفاصيل السطور)
const deCollapsedDays = new Set();      // الأيام المطويّة
const DE_WEEKDAYS_AR = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
let deLookups = null;

/* فهارس مؤقتة (تُبنى عند كل رسم) لتفادي البحث الخطي في كل قيد */
function deBuildLookups(){
  deLookups = {
    purchases: new Map((typeof purchases!=='undefined' && purchases ? purchases : []).map(p=>[p.id, p])),
    sales: new Map((typeof manualSalesInvoices!=='undefined' && manualSalesInvoices ? manualSalesInvoices : []).map(m=>[m.id, m])),
    clients: new Map((typeof clients!=='undefined' && clients ? clients : []).map(c=>[c.id, c])),
    vault: new Map((typeof vaultTx!=='undefined' && vaultTx ? vaultTx : []).map(t=>[t.id, t])),
  };
  return deLookups;
}
function deEntryYear(e){
  const m = String(e.date||'').match(/^(\d{4})/);
  if(m) return m[1];
  const ts = num(e.createdAt);
  if(ts) return String(new Date(ts).getFullYear());
  return '0000';
}
/* خريطة ترقيم عرضية: لكل سنة ترتيب تسلسلي حسب وقت الإنشاء */
function buildJournalDENumberMap(){
  const map = new Map();
  const byYear = new Map();
  journalDE.slice().sort((a,b)=>{
    const d = (a.createdAt||0)-(b.createdAt||0);
    return d !== 0 ? d : String(a.date||'').localeCompare(String(b.date||''));
  }).forEach(e=>{
    const y = deEntryYear(e);
    if(!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(e);
  });
  byYear.forEach((list, y)=>{
    list.forEach((e, i)=> map.set(e.id, `JV-${y}-${String(i+1).padStart(4,'0')}`));
  });
  return map;
}
function deEntryTotals(e){
  let debit = 0, credit = 0;
  (e.lines||[]).forEach(l=>{ debit += num(l.debit); credit += num(l.credit); });
  return { debit, credit, diff: debit-credit, balanced: Math.abs(debit-credit) < 0.01, lineCount: (e.lines||[]).length };
}
/* شارة المصدر: تُحدَّد من روابط القيد بالمستند الأصلي */
function deEntrySource(e){
  const lk = deLookups || deBuildLookups();
  if(e.sourcePurchaseId){
    const p = lk.purchases.get(e.sourcePurchaseId);
    const no = p ? String(p.invoiceNo||'').trim() : '';
    return { key:'purchase', label: no ? `فاتورة شراء ${no}` : 'فاتورة شراء', title: p ? String(p.supplierName||'') : '' };
  }
  if(e.sourceManualSalesId){
    const m = lk.sales.get(e.sourceManualSalesId);
    let no = '';
    if(m) no = (typeof formatManualSalesInvoiceNo==='function') ? formatManualSalesInvoiceNo(m.invoiceNo||0) : String(m.invoiceNo||'');
    return { key:'sale', label: no ? `فاتورة مبيعات ${no}` : 'فاتورة مبيعات', title: m ? String(m.name||'') : '' };
  }
  if(e.sourceClientId){
    const c = lk.clients.get(e.sourceClientId);
    const no = c ? String(c.invoice||'').trim() : '';
    return { key:'course', label: no ? `فاتورة دورة ${no}` : 'فاتورة دورة', title: c ? String(c.name||'') : '' };
  }
  if(e.sourceVaultId){
    const t = lk.vault.get(e.sourceVaultId);
    if(t){
      const label = t.isReturn ? 'مردود مبيعات' : (t.type==='in' ? 'حركة قبض' : 'حركة صرف');
      return { key:'vault', label, title: String(t.clientName||t.manual||t.category||t.recipientName||'') };
    }
    return { key:'vault', label:'حركة مالية', title:'' };
  }
  if(e.sourceJournalEntryId) return { key:'legacy', label:'قيد يدوي قديم', title:'' };
  return e.isAuto ? { key:'auto', label:'تلقائي', title:'' } : { key:'manual', label:'يدوي', title:'' };
}
function filteredJournalDE(){
  deBuildLookups();
  const q = ($('#de-filter-search')?.value || '').trim().toLowerCase();
  const from = $('#de-filter-from')?.value || '';
  const to = $('#de-filter-to')?.value || '';
  const typeVals = selectedFilterValues($('#de-filter-type'));
  const accountId = $('#de-filter-account')?.value || '';
  const onlyUnbalanced = !!$('#de-filter-unbalanced')?.checked;
  const numbers = buildJournalDENumberMap();
  let rows = journalDE.slice();
  if(q) rows = rows.filter(e=>{
    if(String(e.description||'').toLowerCase().includes(q)) return true;
    if(String(numbers.get(e.id)||'').toLowerCase().includes(q)) return true;
    if(deEntrySource(e).label.toLowerCase().includes(q)) return true;
    return (e.lines||[]).some(l=>{
      const a = chartOfAccounts.find(x=>x.id===l.accountId);
      return !!a && `${a.code} ${a.name}`.toLowerCase().includes(q);
    });
  });
  if(from) rows = rows.filter(e=> (e.date||'') >= from);
  if(to) rows = rows.filter(e=> (e.date||'') <= to);
  if(typeVals.length){
    rows = rows.filter(e=> (typeVals.includes('auto') && !!e.isAuto) || (typeVals.includes('manual') && !e.isAuto));
  }
  if(accountId) rows = rows.filter(e=> (e.lines||[]).some(l=>l.accountId===accountId));
  if(onlyUnbalanced) rows = rows.filter(e=> !deEntryTotals(e).balanced);
  return rows;
}
/* تجميع القيود حسب اليوم (الأحدث أولاً) */
function deGroupByDay(rows){
  const map = new Map();
  rows.forEach(e=>{
    const key = String(e.date||'');
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  });
  return Array.from(map.entries()).map(([date, entries])=>{
    entries.sort((a,b)=> (a.createdAt||0)-(b.createdAt||0));
    const totals = entries.reduce((acc,e)=>{ const t = deEntryTotals(e); acc.debit += t.debit; acc.credit += t.credit; return acc; }, {debit:0, credit:0});
    return { date, entries, debit: totals.debit, credit: totals.credit };
  }).sort((a,b)=>{
    if(!a.date) return 1;
    if(!b.date) return -1;
    return String(b.date).localeCompare(String(a.date));
  });
}
function deDayLabel(date){
  const m = String(date||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!m) return 'بدون تاريخ';
  const d = new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
  return `${DE_WEEKDAYS_AR[d.getDay()]||''} ${formatDateDisplay(date)}`.trim();
}
function deEntryLinesHtml(e){
  const rows = (e.lines||[]).map(l=>{
    const acc = chartOfAccounts.find(a=>a.id===l.accountId);
    const debit = num(l.debit), credit = num(l.credit);
    return `<tr>
      <td class="mono de-line-code">${escapeHtml(acc ? acc.code : '—')}</td>
      <td>${escapeHtml(acc ? acc.name : 'حساب غير موجود')}${acc ? ` <span class="de-acc-type">${escapeHtml(accountTypeLabel(acc.type))}</span>` : ''}</td>
      <td class="de-c-num mono">${debit ? fmt(debit) : ''}</td>
      <td class="de-c-num mono">${credit ? fmt(credit) : ''}</td>
    </tr>`;
  }).join('');
  const t = deEntryTotals(e);
  return `<table class="de-lines">
    <thead><tr><th>الرمز</th><th>الحساب</th><th class="de-c-num">مدين</th><th class="de-c-num">دائن</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="de-lines-empty">لا توجد سطور لهذا القيد</td></tr>'}</tbody>
    <tfoot><tr><td colspan="2">إجمالي القيد</td><td class="de-c-num mono">${fmt(t.debit)}</td><td class="de-c-num mono">${fmt(t.credit)}</td></tr></tfoot>
  </table>`;
}
function deEntryRowHtml(e, numbers){
  const t = deEntryTotals(e);
  const src = deEntrySource(e);
  const jv = numbers.get(e.id) || '—';
  const expanded = deExpandedEntries.has(e.id);
  return `<tr class="de-row${t.balanced ? '' : ' de-row-bad'}" data-de-row="${escapeHtml(e.id)}">
    <td class="de-c-exp"><button type="button" class="de-exp-btn${expanded ? ' open' : ''}" data-de-expand="${escapeHtml(e.id)}" aria-expanded="${expanded ? 'true' : 'false'}" title="عرض/إخفاء سطور القيد">▸</button></td>
    <td class="mono de-jv">${escapeHtml(jv)}</td>
    <td class="mono de-date">${escapeHtml(formatDateDisplay(e.date) || e.date || '—')}</td>
    <td class="de-desc">${escapeHtml(e.description || '—')}</td>
    <td><span class="de-badge de-badge-${src.key}"${src.title ? ` title="${escapeHtml(src.title)}"` : ''}>${escapeHtml(src.label)}</span></td>
    <td class="de-c-num mono">${fmt(t.debit)}</td>
    <td class="de-c-num mono">${fmt(t.credit)}</td>
    <td class="de-c-act">${t.balanced ? '' : '<span class="de-flag" title="قيد غير متوازن — يحتاج مراجعة">⚠️</span>'}<button type="button" class="btn btn-ghost btn-sm de-del" data-de-del="${escapeHtml(e.id)}">حذف</button></td>
  </tr>
  <tr class="de-detail" data-de-detail="${escapeHtml(e.id)}"${expanded ? '' : ' hidden'}>
    <td></td>
    <td colspan="7">
      <div class="de-detail-inner">
        ${deEntryLinesHtml(e)}
        <div class="de-detail-meta">
          ${t.lineCount} سطر ·
          ${t.balanced ? '<span class="de-ok">متوازن ✓</span>' : `<span class="de-bad">فرق ${fmt(t.diff)} ﷼</span>`} ·
          المصدر: ${escapeHtml(src.label)}
        </div>
      </div>
    </td>
  </tr>`;
}
function deKpiCard(label, value, sub, cls){
  return `<div class="de-kpi ${cls || ''}">
    <div class="de-kpi-k">${escapeHtml(label)}</div>
    <div class="de-kpi-v">${value}</div>
    ${sub ? `<div class="de-kpi-s">${sub}</div>` : ''}
  </div>`;
}
function renderJournalDEKpis(rows){
  const box = $('#de-kpis');
  if(!box) return;
  let debit = 0, credit = 0, autoCount = 0, bad = 0;
  rows.forEach(e=>{
    const t = deEntryTotals(e);
    debit += t.debit; credit += t.credit;
    if(e.isAuto) autoCount++;
    if(!t.balanced) bad++;
  });
  const diff = debit - credit;
  const balanced = Math.abs(diff) < 0.01;
  box.innerHTML = [
    deKpiCard('عدد القيود', fmt(rows.length), `<b>${fmt(autoCount)}</b> تلقائي · <b>${fmt(rows.length-autoCount)}</b> يدوي`),
    deKpiCard('إجمالي المدين', fmt(debit), 'مجموع النتائج المعروضة', 'de-kpi-debit'),
    deKpiCard('إجمالي الدائن', fmt(credit), 'مجموع النتائج المعروضة', 'de-kpi-credit'),
    deKpiCard('حالة التوازن', balanced ? 'متوازن ✓' : 'غير متوازن', balanced ? 'المدين = الدائن' : `الفرق ${fmt(diff)} ﷼`, balanced ? 'de-kpi-ok' : 'de-kpi-bad'),
    deKpiCard('قيود غير متوازنة', fmt(bad), bad ? 'تحتاج مراجعة فورية' : 'لا يوجد قيد تالف', bad ? 'de-kpi-bad' : 'de-kpi-ok'),
  ].join('');
}
function renderJournalDEPager(totalDays, totalEntries){
  const box = $('#de-pagination');
  if(!box) return;
  if(!totalEntries){ box.innerHTML = ''; return; }
  const totalPages = Math.max(1, Math.ceil(totalDays / DE_PAGE_GROUPS));
  if(deCurrentPage > totalPages) deCurrentPage = totalPages;
  if(deCurrentPage < 1) deCurrentPage = 1;
  const winFrom = Math.max(1, Math.min(deCurrentPage - 2, totalPages - 4));
  const winTo = Math.min(totalPages, winFrom + 4);
  let nums = '';
  for(let p = winFrom; p <= winTo; p++){
    nums += `<button type="button" class="de-page-num${p===deCurrentPage ? ' active' : ''}" data-de-page="${p}">${p}</button>`;
  }
  box.innerHTML = `<span class="de-pager-info">صفحة <b>${deCurrentPage}</b> من <b>${totalPages}</b> · ${fmt(totalEntries)} قيد · ${fmt(totalDays)} يوم</span>
    <div class="de-pager-btns">
      <button type="button" class="de-page-btn" data-de-page="prev" ${deCurrentPage<=1?'disabled':''}>السابق</button>
      ${nums}
      <button type="button" class="de-page-btn" data-de-page="next" ${deCurrentPage>=totalPages?'disabled':''}>التالي</button>
    </div>`;
}
function renderJournalDEList(){
  const tbody = $('#de-entries-body');
  if(!tbody) return;
  // ضمان وجود خيارات فلتر الحساب حتى لو رُسم السجل قبل تحديث قائمة الحسابات
  const accSel = $('#de-filter-account');
  if(accSel && accSel.options.length <= 1 && chartOfAccounts.length){
    accSel.innerHTML = '<option value="">كل الحسابات</option>' + accountOptionsHtml();
  }
  const rows = filteredJournalDE();
  const numbers = buildJournalDENumberMap();
  const groups = deGroupByDay(rows);
  renderJournalDEKpis(rows);

  let debit = 0, credit = 0;
  rows.forEach(e=>{ const t = deEntryTotals(e); debit += t.debit; credit += t.credit; });
  if($('#de-total-debit')) $('#de-total-debit').textContent = fmt(debit);
  if($('#de-total-credit')) $('#de-total-credit').textContent = fmt(credit);
  if($('#de-totals-label')){
    const diff = debit - credit;
    $('#de-totals-label').innerHTML = `إجمالي ${fmt(rows.length)} قيد · ${fmt(groups.length)} يوم` +
      (Math.abs(diff) < 0.01 ? ' <span class="de-ok">(متوازن)</span>' : ` <span class="de-bad">(فرق ${fmt(diff)})</span>`);
  }

  const totalPages = Math.max(1, Math.ceil(groups.length / DE_PAGE_GROUPS));
  if(deCurrentPage > totalPages) deCurrentPage = totalPages;
  if(deCurrentPage < 1) deCurrentPage = 1;
  const pageGroups = groups.slice((deCurrentPage-1)*DE_PAGE_GROUPS, deCurrentPage*DE_PAGE_GROUPS);

  const html = pageGroups.map(g=>{
    const collapsed = deCollapsedDays.has(g.date);
    let out = `<tr class="de-day${collapsed ? ' collapsed' : ''}" data-de-day-row="${escapeHtml(g.date)}">
      <td class="de-c-exp"><button type="button" class="de-day-btn${collapsed ? '' : ' open'}" data-de-day="${escapeHtml(g.date)}" aria-expanded="${collapsed ? 'false' : 'true'}" title="طي/فتح قيود اليوم">▸</button></td>
      <td colspan="4" class="de-day-label">${escapeHtml(deDayLabel(g.date))} · <span class="de-day-count">${fmt(g.entries.length)} قيد</span></td>
      <td class="de-c-num mono">${fmt(g.debit)}</td>
      <td class="de-c-num mono">${fmt(g.credit)}</td>
      <td class="de-c-act"></td>
    </tr>`;
    if(!collapsed) out += g.entries.map(e=> deEntryRowHtml(e, numbers)).join('');
    return out;
  }).join('');

  tbody.innerHTML = html;
  renderJournalDEPager(groups.length, rows.length);
  const empty = $('#de-entries-empty');
  if(empty){
    empty.style.display = rows.length ? 'none' : '';
    const msg = empty.querySelector('.de-empty-msg');
    if(msg) msg.textContent = journalDE.length ? 'لا توجد قيود يومية مطابقة للفلتر الحالي' : 'لا توجد قيود يومية مسجّلة بعد';
  }
}
/* أزرار الفترات السريعة */
function deSetQuickRange(kind){
  const now = new Date();
  let from, to;
  if(kind === 'month'){ from = new Date(now.getFullYear(), now.getMonth(), 1); to = new Date(now.getFullYear(), now.getMonth()+1, 0); }
  else if(kind === 'quarter'){ const q = Math.floor(now.getMonth()/3); from = new Date(now.getFullYear(), q*3, 1); to = new Date(now.getFullYear(), q*3+3, 0); }
  else { from = new Date(now.getFullYear(), 0, 1); to = new Date(now.getFullYear(), 11, 31); }
  const iso = d=> `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  if($('#de-filter-from')) $('#de-filter-from').value = iso(from);
  if($('#de-filter-to')) $('#de-filter-to').value = iso(to);
  deCurrentPage = 1;
  renderJournalDEList();
}
/* تصدير السجل: ورقة للقيود + ورقة لسطور القيود */
function exportJournalDERegister(){
  const rows = filteredJournalDE();
  const numbers = buildJournalDENumberMap();
  const sorted = rows.slice().sort((a,b)=>{
    const d = String(a.date||'').localeCompare(String(b.date||''));
    return d !== 0 ? d : (a.createdAt||0)-(b.createdAt||0);
  });
  const entryRows = sorted.map(e=>{
    const t = deEntryTotals(e), src = deEntrySource(e);
    return {
      'رقم القيد': numbers.get(e.id) || '',
      'التاريخ': formatDateDisplay(e.date) || e.date || '',
      'البيان': e.description || '',
      'المصدر': src.label,
      'النوع': e.isAuto ? 'تلقائي' : 'يدوي',
      'مدين': t.debit,
      'دائن': t.credit,
      'الفرق': t.diff,
      'الحالة': t.balanced ? 'متوازن' : 'غير متوازن',
      'عدد السطور': t.lineCount,
    };
  });
  const lineRows = [];
  sorted.forEach(e=>{
    const jv = numbers.get(e.id) || '';
    (e.lines||[]).forEach(l=>{
      const acc = chartOfAccounts.find(a=>a.id===l.accountId);
      lineRows.push({
        'رقم القيد': jv,
        'التاريخ': formatDateDisplay(e.date) || e.date || '',
        'البيان': e.description || '',
        'رمز الحساب': acc ? acc.code : '',
        'الحساب': acc ? acc.name : 'حساب غير موجود',
        'التصنيف': acc ? accountTypeLabel(acc.type) : '',
        'مدين': num(l.debit),
        'دائن': num(l.credit),
      });
    });
  });
  const totalDebit = sorted.reduce((s,e)=> s + deEntryTotals(e).debit, 0);
  const totalCredit = sorted.reduce((s,e)=> s + deEntryTotals(e).credit, 0);
  const summaryRows = [
    { 'البند': 'عدد القيود', 'القيمة': sorted.length },
    { 'البند': 'إجمالي المدين', 'القيمة': totalDebit },
    { 'البند': 'إجمالي الدائن', 'القيمة': totalCredit },
    { 'البند': 'الفرق', 'القيمة': totalDebit - totalCredit },
    { 'البند': 'حالة التوازن', 'القيمة': Math.abs(totalDebit-totalCredit) < 0.01 ? 'متوازن' : 'غير متوازن' },
    { 'البند': 'تاريخ التصدير', 'القيمة': formatDateDisplay(todayISO()) || todayISO() },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entryRows.length ? entryRows : [{'—':'لا توجد بيانات'}]), 'القيود اليومية');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lineRows.length ? lineRows : [{'—':'لا توجد بيانات'}]), 'سطور القيود');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'الإجماليات');
  XLSX.writeFile(wb, `سجل_القيود_اليومية_${stampNow()}.xlsx`);
  showToast(`تم تصدير ${fmt(sorted.length)} قيد إلى Excel`);
}
/* طباعة/حفظ PDF لسجل القيود كاملاً (كل النتائج المطابقة للفلتر) */
function printJournalDERegister(){
  const rows = filteredJournalDE();
  if(!rows.length){ showToast('لا توجد قيود لطباعتها بالفلتر الحالي'); return; }
  const numbers = buildJournalDENumberMap();
  const sorted = rows.slice().sort((a,b)=>{
    const d = String(a.date||'').localeCompare(String(b.date||''));
    return d !== 0 ? d : (a.createdAt||0)-(b.createdAt||0);
  });
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const from = $('#de-filter-from')?.value || '';
  const to = $('#de-filter-to')?.value || '';
  const periodLine = (from || to)
    ? `عن الفترة: <b>${escapeHtml(formatDateDisplay(from) || 'البداية')}</b> إلى <b>${escapeHtml(formatDateDisplay(to) || 'الآن')}</b>`
    : 'كل الفترات';
  let totalDebit = 0, totalCredit = 0;
  const body = sorted.map(e=>{
    const t = deEntryTotals(e), src = deEntrySource(e);
    totalDebit += t.debit; totalCredit += t.credit;
    const lines = (e.lines||[]).map(l=>{
      const acc = chartOfAccounts.find(a=>a.id===l.accountId);
      return `<tr class="ln">
        <td></td>
        <td class="acc">${escapeHtml(acc ? acc.code : '—')} — ${escapeHtml(acc ? acc.name : 'حساب غير موجود')}</td>
        <td></td>
        <td class="num">${num(l.debit) ? fmt(num(l.debit)) : ''}</td>
        <td class="num">${num(l.credit) ? fmt(num(l.credit)) : ''}</td>
      </tr>`;
    }).join('');
    return `<tr class="ent">
      <td class="mono">${escapeHtml(numbers.get(e.id) || '')}</td>
      <td>${escapeHtml(e.description || '—')}</td>
      <td>${escapeHtml(src.label)}</td>
      <td class="num">${fmt(t.debit)}</td>
      <td class="num">${fmt(t.credit)}</td>
    </tr>${lines}`;
  }).join('');
  const diff = totalDebit - totalCredit;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const extraCss = `
    .jv-head{display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #1B2A41; padding-bottom:14px; margin-bottom:14px;}
    .jv-head h2{margin:0 0 4px; font-size:20px; color:#1B2A41;}
    .jv-head .sub{font-size:13px; color:#66707E;}
    .jv-head img{width:80px; height:80px; border-radius:50%; object-fit:cover;}
    .jv-sum{display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px;}
    .jv-sum div{border:1px solid #d8dee7; border-radius:8px; padding:7px 12px; font-size:12.5px; background:#f7f9fc; color:#334155;}
    .jv-sum b{color:#1B2A41; font-family:monospace;}
    .jv-sum .bad b{color:#be123c;}
    .jv-sum .ok b{color:#047857;}
    table.jv{width:100%; border-collapse:collapse; font-size:12px;}
    table.jv th,table.jv td{border:1px solid #d8dee7; padding:6px 8px; text-align:right;}
    table.jv th{background:#eef2f7; color:#1B2A41;}
    table.jv .num{text-align:left; font-family:monospace; white-space:nowrap;}
    table.jv tr.ent td{background:#f8fafc; font-weight:bold;}
    table.jv tr.ln td{color:#334155; font-size:11.5px;}
    table.jv tr.ln td.acc{padding-right:22px; font-weight:normal;}
    table.jv tfoot td{background:#eef2f7; font-weight:bold;}
    .jv-sign{display:flex; justify-content:space-between; gap:30px; margin-top:34px; font-size:12px; color:#334155;}
    .jv-sign div{flex:1; border-top:1px dashed #9aa7b6; padding-top:6px; text-align:center;}
    @media print{ body{padding:0;} table.jv{font-size:10.5px;} table.jv th,table.jv td{padding:4px 6px;} tr{page-break-inside:avoid;} }
  `;
  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('سجل القيود اليومية', { variant: 'table', extraCss })}
  <body>
    <div class="jv-head">
      <div>
        <h2>سجل القيود اليومية</h2>
        <div class="sub">${escapeHtml(ci.name || '')}</div>
      </div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">${periodLine} · تاريخ الطباعة: ${escapeHtml(today)}</div>
    <div class="jv-sum">
      <div>عدد القيود: <b>${fmt(sorted.length)}</b></div>
      <div>إجمالي المدين: <b>${fmt(totalDebit)}</b></div>
      <div>إجمالي الدائن: <b>${fmt(totalCredit)}</b></div>
      <div class="${Math.abs(diff) < 0.01 ? 'ok' : 'bad'}">حالة التوازن: <b>${Math.abs(diff) < 0.01 ? 'متوازن ✓' : `فرق ${fmt(diff)}`}</b></div>
    </div>
    <table class="jv">
      <thead><tr><th style="width:110px;">رقم القيد</th><th>البيان / الحساب</th><th style="width:130px;">المصدر</th><th style="width:90px;">مدين</th><th style="width:90px;">دائن</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="3">الإجمالي العام</td><td class="num">${fmt(totalDebit)}</td><td class="num">${fmt(totalCredit)}</td></tr></tfoot>
    </table>
    <div class="jv-sign"><div>أعدّه (المحاسب)</div><div>راجعه (المدير المالي)</div><div>اعتمده (المدير العام)</div></div>
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
}
// حقول الفلترة: تأخير إعادة الرسم حتى توقف الكتابة بدل إعادة بناء الجدول مع كل حرف
['#de-filter-search','#de-filter-from','#de-filter-to'].forEach(sel=> { const el=$(sel); if(el) el.addEventListener('input', debounce(()=>{ deCurrentPage = 1; renderJournalDEList(); })); });
$('#de-filter-type')?.addEventListener('change', ()=>{ deCurrentPage = 1; renderJournalDEList(); });
$('#de-filter-account')?.addEventListener('change', ()=>{ deCurrentPage = 1; renderJournalDEList(); });
$('#de-filter-unbalanced')?.addEventListener('change', ()=>{ deCurrentPage = 1; renderJournalDEList(); });
document.querySelectorAll('[data-de-quick]').forEach(btn=>{
  btn.addEventListener('click', ()=> deSetQuickRange(btn.dataset.deQuick));
});
$('#btn-de-export')?.addEventListener('click', exportJournalDERegister);
$('#btn-de-print')?.addEventListener('click', printJournalDERegister);
$('#btn-de-filter-clear')?.addEventListener('click', ()=>{
  ['#de-filter-search','#de-filter-from','#de-filter-to'].forEach(sel=>{ if($(sel)) $(sel).value=''; });
  if($('#de-filter-type')){ $('#de-filter-type').value=''; refreshMultiSelectFilterUI($('#de-filter-type')); }
  if($('#de-filter-account')) $('#de-filter-account').value='';
  if($('#de-filter-unbalanced')) $('#de-filter-unbalanced').checked = false;
  deCurrentPage = 1;
  renderJournalDEList();
});
$('#de-pagination')?.addEventListener('click', e=>{
  const btn = e.target.closest('[data-de-page]');
  if(!btn || btn.disabled) return;
  const v = btn.dataset.dePage;
  if(v === 'prev') deCurrentPage--;
  else if(v === 'next') deCurrentPage++;
  else deCurrentPage = Number(v) || 1;
  renderJournalDEList();
});
$('#de-entries-body')?.addEventListener('click', async e=>{
  const dayBtn = e.target.closest('[data-de-day]');
  if(dayBtn){
    const key = dayBtn.dataset.deDay;
    if(deCollapsedDays.has(key)) deCollapsedDays.delete(key); else deCollapsedDays.add(key);
    renderJournalDEList();
    return;
  }
  const expBtn = e.target.closest('[data-de-expand]');
  if(expBtn){
    const id = expBtn.dataset.deExpand;
    if(deExpandedEntries.has(id)) deExpandedEntries.delete(id); else deExpandedEntries.add(id);
    renderJournalDEList();
    return;
  }
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
  deExpandedEntries.delete(entry.id);
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
  // تحقق فعلي (وليس عرض بصري فقط) من توازن الدفتر بالكامل: كانت الشاشة تعرض الإجماليين جنباً
  // إلى جنب فقط، فلو حصل خلل (بيانات مستوردة، باج قديم، تعديل يدوي مباشر في الداتابيز) كان
  // يمر بصمت تامة إلا لو انتبه أحد للفرق الرقمي بعينيه. الآن تنبيه واضح لا يمكن تجاهله.
  const banner = $('#tb2-imbalance-banner');
  const grandDiff = Math.abs(totalDebit - totalCredit);
  if(banner){
    if(grandDiff >= 0.01){
      banner.style.display = '';
      banner.innerHTML = `⚠️ ميزان المراجعة غير متزن! إجمالي المدين ${fmt(totalDebit)} لا يساوي إجمالي الدائن ${fmt(totalCredit)} — الفرق ${fmt(grandDiff)} ﷼. هذا يشير لقيد تالف أو بيانات مستوردة بشكل غير صحيح ويجب مراجعته فوراً.`;
    } else {
      banner.style.display = 'none';
    }
  }
}
$('#tb2-asof')?.addEventListener('change', renderTrialBalanceDE2);
function accountByCode(code){ return chartOfAccounts.find(a=>a.code===code); }
/* حارس توازن إلزامي قبل ترحيل أي قيد تلقائي: القيود اليدوية (الفورم) تُرفض عند عدم التوازن
   قبل الحفظ، لكن الترحيل التلقائي (فواتير المشتريات/المبيعات/الدورات) كان يدفع سطوره لـ
   journalDE مباشرة بثقة كاملة أن البناء صحيح رياضياً، من غير أي تحقق فعلي وقت التنفيذ. لو
   حصل يوماً خلل في البيانات المصدر (مثلاً total لا يساوي subtotal+taxAmount في فاتورة شراء
   أُدخلت يدوياً بشكل غير متسق) كان القيد المختل يدخل الدفاتر الرسمية بصمت تام. الآن أي قيد
   تلقائي غير متزن (فرق >= 0.01) يُرفض ولا يُنشأ إطلاقاً، ويُسجَّل بسجل التدقيق ليُراجَع يدوياً
   بدل أن يفسد ميزان المراجعة (Trial Balance) بصمت. */
function assertBalancedLines(lines){
  if(!lines || !lines.length) return false;
  let debit=0, credit=0;
  lines.forEach(l=>{ debit += num(l.debit); credit += num(l.credit); });
  return Math.abs(debit-credit) < 0.01;
}
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
  const prev = findExistingDEBySource('sourceJournalEntryId', j.id);
  if(prev){ if(j.linkedDEId !== prev.id){ j.linkedDEId = prev.id; _deRelinkDirty++; } return false; }
  const lines = buildAutoDELinesForLegacy(j);
  if(!lines) return false;
  if(!assertBalancedLines(lines)){
    logAudit('edit','المحاسبة', `⚠️ تعذّر الترحيل التلقائي: قيد يدوي قديم "${j.description||''}" غير متزن — تحتاج مراجعة يدوية`);
    return false;
  }
  const deEntry = { id: uid(), createdAt: Date.now(), date: j.date, description: `[ترحيل تلقائي] ${j.description||''}`, lines, sourceJournalEntryId: j.id, isAuto: true };
  journalDE.push(deEntry);
  j.linkedDEId = deEntry.id;
  return true;
}
/* ترحيل تلقائي شامل: كل القيود اليدوية القديمة + فواتير المشتريات/المبيعات اليدوية/الدورات
   المعلّقة، دفعة واحدة. تُستخدم عند كل تحميل بيانات (بدل الاعتماد على أزرار الترحيل اليدوية)،
   وأيضاً يمكن استدعاؤها يدوياً من الأزرار (تبقى موجودة لإعادة الطمأنة/كتابة سجل تدقيق مخصص). */
async function autoPostAllPendingDoubleEntries(){
  _vaultDEFullLoadDone = true;
  let legacyCount = 0, invoicesCount = 0, vaultAdded = 0, vaultRemoved = 0, accountsAdded = 0;
  _deRelinkDirty = 0;
  journalEntries.filter(j=>!j.linkedDEId).forEach(j=>{ if(autoPostLegacyEntry(j)) legacyCount++; });
  purchases.filter(p=>!p.linkedDEId).forEach(p=>{ if(autoPostPurchase(p)) invoicesCount++; });
  manualSalesInvoices.filter(m=>!m.linkedDEId).forEach(m=>{ if(autoPostManualSale(m)) invoicesCount++; });
  if(typeof courseInvoiceClients==='function'){
    courseInvoiceClients().filter(c=>!c.courseInvoiceDEId).forEach(c=>{ if(autoPostCourseInvoice(c)) invoicesCount++; });
  }
  // حركات الخزنة/البنك (الإيرادات والمصروفات والتحصيلات) — بأثر رجعي أيضاً
  if(typeof syncVaultTxDoubleEntries==='function'){
    const vSync = syncVaultTxDoubleEntries();
    vaultAdded = vSync.added; vaultRemoved = vSync.removed; accountsAdded = vSync.accounts;
  }
  const count = legacyCount + invoicesCount;
  const relinked = _deRelinkDirty;
  _deRelinkDirty = 0;
  if(count>0 || relinked>0 || vaultAdded>0 || vaultRemoved>0 || accountsAdded>0){
    const saves = [saveJournalEntries(), saveJournalDE(), savePurchases(), saveManualSalesInvoices(), saveClients()];
    if(vaultAdded>0 || vaultRemoved>0) saves.push(saveVaultTx());
    if(accountsAdded>0) saves.push(saveChartOfAccounts());
    await Promise.all(saves);
    if(count>0){
      await logAudit('add','المحاسبة', `ترحيل تلقائي عند التحميل: تم ترحيل ${count} عملية إلى القيد المزدوج (${legacyCount} قيد يدوي، ${invoicesCount} فاتورة)`);
    }
    if(relinked>0){
      await logAudit('edit','المحاسبة', `إصلاح تلقائي: تمت إعادة ربط ${relinked} مستنداً بقيده المزدوج الموجود مسبقاً بدل إنشاء قيد مكرر جديد`);
    }
    if(vaultAdded>0 || vaultRemoved>0){
      await logAudit('add','المحاسبة', `ترحيل تلقائي لحركات الخزنة/البنك: ${vaultAdded} قيداً جديداً${vaultRemoved ? ` وحذف ${vaultRemoved} قيداً قديماً تغيّرت بيانات حركته` : ''}`);
    }
  }
  return count + vaultAdded;
}
$('#btn-migrate-legacy')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-migrate-legacy'), async ()=>{
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

  });});

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
  if(typeof vaultTx!=='undefined' && vaultTx) vaultTx.forEach(t=> liveSourceIds.add(t.id));
  const before = journalDE.length;
  const liveDeIds = new Set();
  journalDE = journalDE.filter(e=>{
    const hasSource = !!(e.sourceJournalEntryId || e.sourcePurchaseId || e.sourceManualSalesId || e.sourceClientId || e.sourceVaultId);
    if(!hasSource) return true; // قيد يدوي بلا مصدر — يُحذف فقط من واجهته
    const live = e.sourceJournalEntryId ? liveSourceIds.has(e.sourceJournalEntryId)
      : e.sourcePurchaseId ? liveSourceIds.has(e.sourcePurchaseId)
      : e.sourceManualSalesId ? liveSourceIds.has(e.sourceManualSalesId)
      : e.sourceVaultId ? liveSourceIds.has(e.sourceVaultId)
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

/* هل يوجد قيد يومية سابق لنفس المستند المصدر؟ (حارس منع التكرار)
   كان الترحيل التلقائي يعتمد فقط على مؤشر محفوظ على المستند نفسه (linkedDEId /
   courseInvoiceDEId). لو فُقد هذا المؤشر لأي سبب (حفظ عملاء فشل، أو استُبدلت مصفوفة
   العملاء من مزامنة خلفية بعد الترحيل، أو استُعيدت نسخة احتياطية قديمة للمستند)
   يُرحَّل المستند مرة أخرى في كل تشغيل — فتتراكم نسخ قيود مكررة لنفس الفاتورة.
   هذا الحارس يفحص القيود نفسها أولاً، ويعيد ربط المؤشر بالقيد الموجود بدل إنشاء نسخة. */
let _deRelinkDirty = 0; // عدد المستندات التي أُعيد ربط مؤشرها بقيد موجود (يجب حفظ المؤشر)
function findExistingDEBySource(field, sourceId){
  if(!field || !sourceId) return null;
  for(const e of journalDE){ if(e[field] === sourceId) return e; }
  return null;
}
/* ---- تنظيف القيود المكررة (نسخ زائدة لنفس المستند) ----
   السبب: كان كل ترحيل تلقائي يعتمد على مؤشر واحد محفوظ على المستند (مثل
   courseInvoiceDEId). فقدان هذا المؤشر لأي سبب (حفظ فاشل/استبدال مصفوفة العملاء
   من مزامنة، أو استرجاع نسخة قديمة) كان يجعل البرنامج يُنشئ قيداً جديداً في كل
   تشغيل، فتظهر نفس الفاتورة أكثر من مرة بأرقام قيود مختلفة. هذه الأدوات تكتشف
   النسخ المتطابقة تماماً (نفس المستند + نفس التاريخ + نفس السطور والمبالغ)
   وتحذف الزائد مع الاحتفاظ بالأقدم، وتعيد ربط المستند بالقيد الباقي. */
function deEntrySignature(e){
  const parts = (e.lines||[]).map(l=> `${l.accountId}|${num(l.debit).toFixed(2)}|${num(l.credit).toFixed(2)}`).sort();
  return `${String(e.date||'')}#${parts.join(';')}`;
}
function deSourceKey(e){
  if(e.sourcePurchaseId) return 'purchase:' + e.sourcePurchaseId;
  if(e.sourceManualSalesId) return 'sale:' + e.sourceManualSalesId;
  if(e.sourceClientId) return 'client:' + e.sourceClientId;
  if(e.sourceVaultId) return 'vault:' + e.sourceVaultId;
  if(e.sourceJournalEntryId) return 'legacy:' + e.sourceJournalEntryId;
  return '';
}
function findDuplicateJournalDEGroups(){
  const map = new Map();
  journalDE.forEach(e=>{
    const src = deSourceKey(e);
    if(!src) return; // القيود اليدوية بلا مصدر لا تُمسّ تلقائياً
    const key = src + '#' + deEntrySignature(e);
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  });
  const groups = [];
  map.forEach(list=>{
    if(list.length < 2) return;
    const sorted = list.slice().sort((a,b)=> (a.createdAt||0)-(b.createdAt||0));
    groups.push({ keep: sorted[0], extras: sorted.slice(1) });
  });
  return groups;
}
function deRelinkSourceTo(entry){
  if(!entry) return false;
  if(entry.sourcePurchaseId){
    const p = purchases.find(x=>x.id===entry.sourcePurchaseId);
    if(p && p.linkedDEId !== entry.id){ p.linkedDEId = entry.id; return true; }
  }
  if(entry.sourceManualSalesId){
    const m = manualSalesInvoices.find(x=>x.id===entry.sourceManualSalesId);
    if(m && m.linkedDEId !== entry.id){ m.linkedDEId = entry.id; return true; }
  }
  if(entry.sourceClientId){
    const c = (typeof clients!=='undefined' ? clients : []).find(x=>x.id===entry.sourceClientId);
    if(c && c.courseInvoiceDEId !== entry.id){ c.courseInvoiceDEId = entry.id; return true; }
  }
  if(entry.sourceVaultId){
    const t = (typeof vaultTx!=='undefined' ? vaultTx : []).find(x=>x.id===entry.sourceVaultId);
    if(t && t.linkedDEId !== entry.id){ t.linkedDEId = entry.id; return true; }
  }
  if(entry.sourceJournalEntryId){
    const j = journalEntries.find(x=>x.id===entry.sourceJournalEntryId);
    if(j && j.linkedDEId !== entry.id){ j.linkedDEId = entry.id; return true; }
  }
  return false;
}
/* ينفّذ الحذف بعد تصدير نسخة احتياطية بالمحذوفات (Excel). يُرجع ملخصاً بالنتائج. */
async function dedupeJournalDEEntries(){
  const groups = findDuplicateJournalDEGroups();
  const extras = groups.reduce((acc,g)=> acc.concat(g.extras), []);
  if(!extras.length) return { groups: 0, removed: 0, relinked: 0 };
  const numbers = buildJournalDENumberMap();
  const backupRows = [];
  extras.forEach(e=>{
    const jv = numbers.get(e.id) || '';
    (e.lines||[]).forEach(l=>{
      const acc = chartOfAccounts.find(a=>a.id===l.accountId);
      backupRows.push({
        'رقم القيد': jv,
        'التاريخ': formatDateDisplay(e.date) || e.date || '',
        'البيان': e.description || '',
        'رمز الحساب': acc ? acc.code : '',
        'الحساب': acc ? acc.name : 'حساب غير موجود',
        'مدين': num(l.debit),
        'دائن': num(l.credit),
        'سبب الحذف': 'نسخة مكررة لنفس المستند — تم الاحتفاظ بالقيد الأقدم',
      });
    });
  });
  downloadXlsx(`نسخة_احتياطية_قيود_مكررة_${stampNow()}.xlsx`, 'القيود المحذوفة', backupRows);
  const removedIds = new Set(extras.map(e=>e.id));
  journalDE = journalDE.filter(e=> !removedIds.has(e.id));
  let relinked = 0;
  groups.forEach(g=>{ if(deRelinkSourceTo(g.keep)) relinked++; });
  await Promise.all([saveJournalDE(), savePurchases(), saveManualSalesInvoices(), saveJournalEntries(), saveClients()]);
  await logAudit('delete','المحاسبة', `تنظيف القيود المكررة: ${groups.length} مستنداً كان له نسخ قيود زائدة — تم حذف ${extras.length} قيداً مكرراً والاحتفاظ بالأقدم لكل مستند، وإعادة ربط ${relinked} مستند بقيده (النسخة الاحتياطية صُدّرت إلى Excel)`);
  return { groups: groups.length, removed: extras.length, relinked };
}
async function deScanAndCleanDuplicates(){
  const groups = findDuplicateJournalDEGroups();
  if(!groups.length){
    showToast('لا توجد قيود مكررة — جميع القيود مرتبطة بمستنداتها مرة واحدة فقط');
    return;
  }
  const extras = groups.reduce((s,g)=> s + g.extras.length, 0);
  let amount = 0;
  groups.forEach(g=> g.extras.forEach(e=>{ amount += deEntryTotals(e).debit; }));
  const okToDelete = await customConfirm(
    `تم العثور على ${groups.length} مستنداً له نسخ قيود مكررة (${extras} قيداً زائداً بإجمالي مدين ${fmt(amount)} ﷼).\n\n` +
    'سيتم الاحتفاظ بأقدم قيد لكل مستند وحذف النسخ الزائدة فقط، مع تصدير نسخة احتياطية بالمحذوفات إلى Excel أولاً.\n\nهل تريد المتابعة؟'
  );
  if(!okToDelete) return;
  const result = await dedupeJournalDEEntries();
  renderDoubleEntryModule();
  showToast(`تم حذف ${result.removed} قيداً مكرراً والاحتفاظ بالأقدم لكل مستند`);
}
$('#btn-de-dedupe')?.addEventListener('click', ()=> withBtnLoading($('#btn-de-dedupe'), deScanAndCleanDuplicates));

/* ---- ترحيل تلقائي لفواتير المشتريات ---- */
function buildDELinesForPurchase(p){
  const expenseAcc = accountByCode('5000'), vatAcc = accountByCode('2100'), cashAcc = accountByCode('1000'), payableAcc = accountByCode('2000');
  if(!expenseAcc || !vatAcc || !cashAcc || !payableAcc) return null;
  // الدفع من البنك يُقيَّد على حساب البنك 1010 بدل النقدية (الحركة المرتبطة بالفاتورة تحمل الوجهة)
  const linkedVault = (p.vaultTxId && typeof vaultTx!=='undefined' && vaultTx) ? vaultTx.find(t=>t.id===p.vaultTxId) : null;
  const payAcc = (linkedVault && linkedVault.destination==='bank') ? (accountByCode('1010') || cashAcc) : cashAcc;
  const lines = [{accountId:expenseAcc.id, debit:num(p.subtotal), credit:0}];
  if(num(p.taxAmount)>0) lines.push({accountId:vatAcc.id, debit:num(p.taxAmount), credit:0});
  const creditAcc = p.status==='paid' ? payAcc : payableAcc;
  lines.push({accountId:creditAcc.id, debit:0, credit:num(p.total)});
  return lines;
}
function autoPostPurchase(p){
  if(p.linkedDEId) return false;
  const prev = findExistingDEBySource('sourcePurchaseId', p.id);
  if(prev){ if(p.linkedDEId !== prev.id){ p.linkedDEId = prev.id; _deRelinkDirty++; } return false; }
  const lines = buildDELinesForPurchase(p);
  if(!lines || num(p.total)<=0) return false;
  if(!assertBalancedLines(lines)){
    logAudit('edit','المحاسبة', `⚠️ تعذّر الترحيل التلقائي: فاتورة شراء ${p.invoiceNo||''} غير متزنة (الإجمالي ${p.total} لا يساوي الفرعي+الضريبة) — تحتاج مراجعة يدوية`);
    return false;
  }
  const entry = { id: uid(), createdAt: Date.now(), date: p.date, description: `[ترحيل تلقائي] فاتورة شراء ${p.invoiceNo||''} — ${p.supplierName||''}`, lines, sourcePurchaseId: p.id, isAuto: true };
  journalDE.push(entry);
  p.linkedDEId = entry.id;
  return true;
}

/* ---- ترحيل تلقائي لفواتير المبيعات اليدوية ---- */
function buildDELinesForManualSale(m){
  const arAcc = accountByCode('1100'), revAcc = accountByCode('4000'), vatAcc = accountByCode('2100');
  if(!arAcc || !revAcc || !vatAcc) return null;
  const total = roundMoney(num(m.total));
  const vat = vatFromGross(total); // مُقرَّبة بالفعل داخل vatFromGross
  const net = roundMoney(total - vat);
  const lines = [{accountId:arAcc.id, debit:total, credit:0}, {accountId:revAcc.id, debit:0, credit:net}];
  if(vat>0.004) lines.push({accountId:vatAcc.id, debit:0, credit:vat});
  return lines;
}
function autoPostManualSale(m){
  if(m.linkedDEId) return false;
  const prev = findExistingDEBySource('sourceManualSalesId', m.id);
  if(prev){ if(m.linkedDEId !== prev.id){ m.linkedDEId = prev.id; _deRelinkDirty++; } return false; }
  const lines = buildDELinesForManualSale(m);
  if(!lines || num(m.total)<=0) return false;
  if(!assertBalancedLines(lines)){
    logAudit('edit','المحاسبة', `⚠️ تعذّر الترحيل التلقائي: فاتورة مبيعات يدوية رقم ${formatManualSalesInvoiceNo(m.invoiceNo||0)} غير متزنة — تحتاج مراجعة يدوية`);
    return false;
  }
  const entry = { id: uid(), createdAt: Date.now(), date: m.date, description: `[ترحيل تلقائي] فاتورة مبيعات يدوية رقم ${formatManualSalesInvoiceNo(m.invoiceNo||0)}${m.name?(' — '+m.name):''}`, lines, sourceManualSalesId: m.id, isAuto: true };
  journalDE.push(entry);
  m.linkedDEId = entry.id;
  return true;
}

/* ---- ترحيل تلقائي لفواتير الدورات التدريبية (فواتير العملاء) ---- */
function buildDELinesForCourseInvoice(c){
  const arAcc = accountByCode('1100'), revAcc = accountByCode('4000'), vatAcc = accountByCode('2100');
  if(!arAcc || !revAcc || !vatAcc) return null;
  const total = roundMoney(num(c.receiptActualValue));
  const vat = courseInvoiceVat(total); // مُقرَّبة بالفعل داخل vatFromGross
  const net = roundMoney(total - vat);
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

/* ================= تدقيق محاسبي شامل (قراءة فقط — لا يكتب أي قيد) =================
   يجيب على ثلاثة أسئلة دفعة واحدة:
   1) ما المستندات/الحركات التي لم تُرحَّل بعد إلى القيد المزدوج، وما سبب كل واحدة؟
   2) هل توجد قيود مكررة (نفس المستند أكثر من مرة) أو قيود متشابهة تستحق المراجعة؟
   3) هل أرصدة القيد المزدوج مطابقة للقوائم المالية المبنية على بيانات التشغيل
      (النقدية، الذمم، المخزون، الموردون، الضريبة، الإيراد، المصروف، حقوق الملكية)؟
   النتيجة تُصدَّر إلى Excel بعدة أوراق. لا تُعدّل أي بيانات إطلاقاً. */
function deAccountBalanceByCode(code, asOf){
  const acc = accountByCode(code);
  if(!acc) return 0;
  let net = 0;
  journalDE.forEach(e=>{
    if(asOf && (e.date||'') > asOf) return;
    (e.lines||[]).forEach(l=>{ if(l.accountId===acc.id) net += num(l.debit) - num(l.credit); });
  });
  return roundMoney(net);
}
/* سبب استثناء حركة خزنة/بنك من الترحيل التلقائي (نفس منطق vaultTxDoubleEntryBlocked لكن بنص واضح) */
function vaultTxAuditReason(t, purchaseVaultIds){
  if(!t || t.deletedAt) return 'حركة محذوفة منطقياً';
  if((t.destination||'vault')==='other') return 'وجهة "أخرى" — خارج نقدية المركز';
  if(purchaseVaultIds && purchaseVaultIds.has(t.id)) return 'دفعة فاتورة شراء — مُرحَّلة عبر الفاتورة نفسها';
  const meta = (typeof recordMeta==='object' && recordMeta && recordMeta.vaultTx) ? recordMeta.vaultTx[t.id] : null;
  if(meta && meta.status==='pending') return 'بانتظار اعتماد الأدمن';
  if(t.autoClientId && (t.destination||'vault')==='vault' && t.settled===false) return 'دفعة نقدية غير مُسوّاة من الاستقبال';
  return '';
}
/* يجمع كل نتائج التدقيق في كائن واحد — دالة نقية بلا أي تعديل على البيانات */
function buildAccountingAuditData(){
  const today = todayISO();
  const asOf = today;
  const purchaseVaultIds = new Set((typeof purchases!=='undefined' && purchases ? purchases : []).map(p=>p.vaultTxId).filter(Boolean));
  const postedVault = new Set(journalDE.filter(e=>e.sourceVaultId).map(e=>e.sourceVaultId));
  /* فحص الوجود الفعلي للقيد لا مجرد وجود المؤشر (linkedDEId/courseInvoiceDEId):
     المؤشر قد يبقى يشير إلى قيد حُذف (تنظيف/تراجع/استعادة)، فيظهر المستند "مُرحّلاً" وهو فعلياً
     بلا قيد. هذا الفحص هو ما كشف 14 فاتورة شراء مدفوعة و13 فاتورة عميل مكررة في البيانات الحقيقية. */
  const deIds = new Set(journalDE.map(e=>e.id));
  const hasLiveDE = (field, sourceId)=> !!sourceId && journalDE.some(e=> e[field]===sourceId);
  const out = { today, course:[], purchases:[], manualSales:[], legacy:[], vault:[], vaultReasonCounts:{}, duplicates:[], similar:[], brokenLinks:[], summary:[] };

  // 1) فواتير الدورات
  if(typeof courseInvoiceClients==='function'){
    courseInvoiceClients().filter(c=> !hasLiveDE('sourceClientId', c.id) && !(c.courseInvoiceDEId && deIds.has(c.courseInvoiceDEId))).forEach(c=>{
      let reason;
      if(c.courseInvoiceDEId && !deIds.has(c.courseInvoiceDEId)) reason = 'مؤشر القيد القديم يشير إلى قيد محذوف — يحتاج إعادة ترحيل';
      else if(!c.receiptIssueDate) reason = 'لا يوجد تاريخ إصدار فاتورة';
      else if(!(num(c.receiptActualValue)>0)) reason = 'لم تُدخل القيمة الفعلية بالإيصال';
      else if(typeof clientHasUnsettledCash==='function' && clientHasUnsettledCash(c)) reason = 'دفعة نقدية غير مُسوّاة من الاستقبال';
      else if(!buildDELinesForCourseInvoice(c)) reason = 'حسابات ناقصة في دليل الحسابات';
      else reason = 'مؤهّلة — ستُرحَّل تلقائياً عند التحميل التالي';
      out.course.push({
        'رقم الهوية': c.clientId||'', 'الاسم': c.name||'', 'رقم الفاتورة': c.invoice||'',
        'تاريخ الفاتورة': c.receiptIssueDate||'', 'القيمة الفعلية': num(c.receiptActualValue),
        'قيمة الدورة بالنظام': typeof centerIncome==='function' ? centerIncome(c) : '',
        'السبب': reason
      });
    });
  }

  // 2) فواتير المشتريات
  (typeof purchases!=='undefined' && purchases ? purchases : []).filter(p=> !hasLiveDE('sourcePurchaseId', p.id) && !(p.linkedDEId && deIds.has(p.linkedDEId))).forEach(p=>{
    let reason;
    const lines = buildDELinesForPurchase(p);
    if(p.linkedDEId && !deIds.has(p.linkedDEId)) reason = 'مؤشر القيد القديم يشير إلى قيد محذوف — يحتاج إعادة ترحيل';
    else if(!(num(p.total)>0)) reason = 'إجمالي الفاتورة صفر';
    else if(!lines) reason = 'حسابات ناقصة في دليل الحسابات';
    else if(!assertBalancedLines(lines)) reason = 'الفاتورة غير متزنة (الإجمالي ≠ الفرعي + الضريبة)';
    else reason = 'مؤهّلة — ستُرحَّل عند التحميل التالي';
    out.purchases.push({
      'رقم الفاتورة': p.invoiceNo||'', 'المورد': p.supplierName||'', 'التاريخ': p.date||'',
      'الفرعي': num(p.subtotal), 'الضريبة': num(p.taxAmount), 'الإجمالي': num(p.total),
      'الحالة': p.status==='paid'?'مدفوعة':'غير مدفوعة', 'السبب': reason
    });
  });

  // 3) فواتير المبيعات اليدوية (بيانات قديمة — لا شاشة إدخال حالياً)
  (typeof manualSalesInvoices!=='undefined' && manualSalesInvoices ? manualSalesInvoices : []).filter(m=> !hasLiveDE('sourceManualSalesId', m.id) && !(m.linkedDEId && deIds.has(m.linkedDEId))).forEach(m=>{
    let reason;
    const lines = buildDELinesForManualSale(m);
    if(m.linkedDEId && !deIds.has(m.linkedDEId)) reason = 'مؤشر القيد القديم يشير إلى قيد محذوف — يحتاج إعادة ترحيل';
    else if(!(num(m.total)>0)) reason = 'إجمالي الفاتورة صفر';
    else if(!lines) reason = 'حسابات ناقصة في دليل الحسابات';
    else if(!assertBalancedLines(lines)) reason = 'الفاتورة غير متزنة';
    else reason = 'مؤهّلة — ستُرحَّل عند التحميل التالي';
    out.manualSales.push({
      'رقم الفاتورة': typeof formatManualSalesInvoiceNo==='function' ? formatManualSalesInvoiceNo(m.invoiceNo||0) : (m.invoiceNo||''),
      'الاسم': m.name||'', 'التاريخ': m.date||'', 'الإجمالي': num(m.total), 'السبب': reason
    });
  });

  // 4) القيود اليدوية القديمة
  journalEntries.filter(j=> !hasLiveDE('sourceJournalEntryId', j.id) && !(j.linkedDEId && deIds.has(j.linkedDEId))).forEach(j=>{
    let reason;
    const lines = buildAutoDELinesForLegacy(j);
    if(j.linkedDEId && !deIds.has(j.linkedDEId)) reason = 'مؤشر القيد القديم يشير إلى قيد محذوف — يحتاج إعادة ترحيل';
    else if(!lines) reason = 'نوع القيد غير معرّف للترحيل التلقائي (يحتاج قيداً يدوياً مباشراً)';
    else if(!assertBalancedLines(lines)) reason = 'القيد غير متزن';
    else reason = 'مؤهّل — سيُرحَّل عند التحميل التالي';
    out.legacy.push({
      'النوع': j.type||'', 'التاريخ': j.date||'', 'البيان': j.description||'',
      'المبلغ': num(j.amount), 'السبب': reason
    });
  });

  // 5) حركات الخزنة/البنك غير المُرحّلة
  (typeof vaultTx!=='undefined' && vaultTx ? vaultTx : []).forEach(t=>{
    const reason = vaultTxAuditReason(t, purchaseVaultIds);
    if(reason){
      out.vaultReasonCounts[reason] = (out.vaultReasonCounts[reason]||0) + 1;
      out.vault.push({
        'الرقم التسلسلي': t.seq||'', 'التاريخ': t.date||'',
        'النوع': t.isReturn ? 'مردود مبيعات' : (t.type==='in'?'وارد':'صادر'),
        'المبلغ': num(t.amount), 'الوجهة': t.destination||'vault',
        'العميل/الجهة': t.clientName||t.manual||t.category||t.recipientName||'',
        'قيد مزدوج قائم': postedVault.has(t.id) ? 'نعم (سيُحذف عند التحميل)' : 'لا',
        'السبب': reason
      });
    }else if(!postedVault.has(t.id)){
      out.vault.push({
        'الرقم التسلسلي': t.seq||'', 'التاريخ': t.date||'',
        'النوع': t.isReturn ? 'مردود مبيعات' : (t.type==='in'?'وارد':'صادر'),
        'المبلغ': num(t.amount), 'الوجهة': t.destination||'vault',
        'العميل/الجهة': t.clientName||t.manual||t.category||t.recipientName||'',
        'قيد مزدوج قائم': 'لا',
        'السبب': 'مؤهّلة ولم تُرحَّل بعد — راجع التحميل/المزامنة'
      });
    }
  });

  // 6) القيود المكررة
  // 6-أ) نفس المصدر + نفس التاريخ + نفس السطور
  const _pushedDupIds = new Set();
  findDuplicateJournalDEGroups().forEach(g=>{
    g.extras.forEach(e=>{
      _pushedDupIds.add(e.id);
      out.duplicates.push({
        'رقم القيد': (buildJournalDENumberMap().get(e.id)||''),
        'التاريخ': e.date||'', 'البيان': e.description||'',
        'المصدر': deSourceKey(e)||'—', 'مدين': deEntryTotals(e).debit, 'دائن': deEntryTotals(e).credit,
        'ملاحظة': 'نسخة زائدة — الأقدم هو المحتفظ به'
      });
    });
  });
  // 6-ب) فاتورة العميل مُرحَّلة أكثر من مرة بنفس المبلغ ولو اختلف التاريخ (يكشف ازدواج إعادة الترحيل)
  const arAccForDup = accountByCode('1100');
  if(arAccForDup){
    const byClient = new Map();
    journalDE.forEach(e=>{
      if(!e.sourceClientId) return;
      if(!byClient.has(e.sourceClientId)) byClient.set(e.sourceClientId, []);
      byClient.get(e.sourceClientId).push(e);
    });
    const arDebitOf = e => roundMoney((e.lines||[]).reduce((s,l)=> s + (l.accountId===arAccForDup.id ? num(l.debit) : 0), 0));
    byClient.forEach((list, cid)=>{
      if(list.length < 2) return;
      const groups = new Map();
      list.slice().sort((a,b)=> (a.createdAt||0)-(b.createdAt||0)).forEach(e=>{
        const k = arDebitOf(e).toFixed(2);
        if(!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
      });
      groups.forEach((arr)=>{
        if(arr.length < 2) return;
        const c = (typeof clients!=='undefined' ? clients : []).find(x=>x.id===cid);
        arr.slice(1).forEach(e=>{
          if(_pushedDupIds.has(e.id)) return;
          _pushedDupIds.add(e.id);
          out.duplicates.push({
            'رقم القيد': (buildJournalDENumberMap().get(e.id)||''),
            'التاريخ': e.date||'', 'البيان': `${e.description||''}${c?` — ${c.name} (${c.invoice||'بلا فاتورة'})`:''}`,
            'المصدر': deSourceKey(e)||'—', 'مدين': deEntryTotals(e).debit, 'دائن': deEntryTotals(e).credit,
            'ملاحظة': 'فاتورة العميل مُرحَّلة أكثر من مرة بنفس المبلغ — احتفظ بالأقدم وامسح الباقي'
          });
        });
      });
    });
  }

  // 6-ج) روابط قيود مكسورة (مؤشر يشير إلى قيد غير موجود)
  const pushBroken = (kind, ref, date, amount, linked) => out.brokenLinks.push({
    'نوع المستند': kind, 'المرجع': ref||'', 'التاريخ': date||'', 'المبلغ': roundMoney(num(amount)),
    'المؤشر': linked||''
  });
  (typeof purchases!=='undefined' && purchases ? purchases : []).forEach(p=>{
    if(p.linkedDEId && !deIds.has(p.linkedDEId)) pushBroken('فاتورة شراء', p.invoiceNo||p.id, p.date, p.total, p.linkedDEId);
  });
  (typeof manualSalesInvoices!=='undefined' && manualSalesInvoices ? manualSalesInvoices : []).forEach(m=>{
    if(m.linkedDEId && !deIds.has(m.linkedDEId)) pushBroken('فاتورة مبيعات يدوية', m.invoiceNo||m.id, m.date, m.total, m.linkedDEId);
  });
  journalEntries.forEach(j=>{
    if(j.linkedDEId && !deIds.has(j.linkedDEId)) pushBroken('قيد يدوي قديم', j.description||j.id, j.date, j.amount, j.linkedDEId);
  });
  (typeof vaultTx!=='undefined' && vaultTx ? vaultTx : []).forEach(t=>{
    if(t.linkedDEId && !deIds.has(t.linkedDEId)) pushBroken('حركة مالية', t.seq||t.id, t.date, t.amount, t.linkedDEId);
  });
  if(typeof courseInvoiceClients==='function'){
    courseInvoiceClients().forEach(c=>{
      if(c.courseInvoiceDEId && !deIds.has(c.courseInvoiceDEId)) pushBroken('فاتورة دورة', `${c.name||''} — ${c.invoice||'بلا رقم'}`, c.receiptIssueDate, c.receiptActualValue, c.courseInvoiceDEId);
    });
  }

  // 7) قيود متشابهة من مصادر مختلفة (نفس التاريخ ونفس السطور) — مراجعة بشرية
  const sigMap = new Map();
  journalDE.forEach(e=>{
    const parts = (e.lines||[]).map(l=> `${l.accountId}|${num(l.debit).toFixed(2)}|${num(l.credit).toFixed(2)}`).sort().join(';');
    const key = `${e.date||''}#${parts}`;
    if(!sigMap.has(key)) sigMap.set(key, []);
    sigMap.get(key).push(e);
  });
  let similarCount = 0;
  sigMap.forEach(list=>{
    if(list.length < 2 || similarCount >= 200) return;
    const sources = new Set(list.map(e=>deSourceKey(e)||e.id));
    if(sources.size < 2) return; // مكرر نفس المصدر — عولج في البند 6
    list.forEach(e=>{
      if(similarCount >= 200) return;
      similarCount++;
      out.similar.push({
        'التاريخ': e.date||'', 'البيان': e.description||'', 'المصدر': deSourceKey(e)||'يدوي',
        'مدين': deEntryTotals(e).debit, 'دائن': deEntryTotals(e).credit,
        'ملاحظة': 'يشبه قيداً آخر من مصدر مختلف — قد يكون ازدواجاً (تحقق يدوياً)'
      });
    });
  });

  // 8) مطابقة القيد المزدوج مع القوائم المبنية على بيانات التشغيل
  const push = (metric, de, op, note)=> out.summary.push({
    'البند': metric,
    'القيد المزدوج': roundMoney(de),
    'القوائم المبنية على التشغيل': (op===null||op===undefined) ? '' : roundMoney(op),
    'الفرق (مزدوج − تشغيل)': (op===null||op===undefined) ? '' : roundMoney(de-op),
    'ملاحظة': note
  });
  const deCash = roundMoney(deAccountBalanceByCode('1000', asOf) + deAccountBalanceByCode('1010', asOf));
  const opCash = roundMoney(['vault','bank','network','network2'].reduce((s,d)=> s + balanceOfAsOf(d, asOf), 0));
  push('النقدية والبنك والشبكات', deCash, opCash, 'يجب أن يتطابقا بعد ترحيل كل الحركات');

  push('ذمم العملاء (1100)', roundMoney(-deAccountBalanceByCode('1100', asOf)), receivablesAsOf(asOf),
    'القيد المزدوج يستخدم القيمة الفعلية بالإيصال، والتشغيل يستخدم قيمة الدورة + الحقيبة − المدفوع');

  push('مخزون الحقائب (1200)', deAccountBalanceByCode('1200', asOf), bagInventoryValueAsOf(asOf),
    'التشغيل يقيّم المخزون بسعر الحقيبة الحالي × الكمية');

  const unpaidPurchases = roundMoney(purchases.filter(p=>p.status!=='paid').reduce((s,p)=>s+num(p.total),0));
  push('ذمم الموردين (2000)', roundMoney(-deAccountBalanceByCode('2000', asOf)), unpaidPurchases,
    'فرق متوقع إن كان القيد المزدوج أقدم من آخر تعديل فاتورة');

  push('ضريبة القيمة المضافة (2100)', roundMoney(-deAccountBalanceByCode('2100', asOf)),
    roundMoney(buildVatReturn('', asOf).netVat),
    'الإقرار يُحسب من الفواتير مباشرة، والقيد من القيود المُرحّلة فقط');

  const opRevenue = roundMoney(Object.values(revenueBreakdown(null, asOf)).reduce((a,b)=>a+b,0) - salesReturnsTotal(null, asOf));
  push('الإيرادات (4000 + 4100)', roundMoney(-(deAccountBalanceByCode('4000', asOf) + deAccountBalanceByCode('4100', asOf))),
    opRevenue, 'التشغيل يستثني الحقائب ويعتمد تاريخ التسجيل؛ القيد يعتمد تاريخ الفاتورة');

  push('المصروفات (5000 + 5100 + 5200)', roundMoney(deAccountBalanceByCode('5000', asOf) + deAccountBalanceByCode('5100', asOf) + deAccountBalanceByCode('5200', asOf)),
    roundMoney(Object.values(expenseBreakdown(null, asOf)).reduce((a,b)=>a+b,0)
      + journalInRange(null, asOf).filter(j=>j.type==='depreciation').reduce((s,j)=>s+num(j.amount),0)
      + journalInRange(null, asOf).filter(j=>j.type==='accrued').reduce((s,j)=>s+num(j.amount),0)),
    'التشغيل نقدي للمصروفات (لا يشمل المشتريات الآجلة)، والقيد على أساس الاستحقاق');

  push('حقوق الملكية (3000 + 3100)', roundMoney(-(deAccountBalanceByCode('3000', asOf) + deAccountBalanceByCode('3100', asOf))),
    buildBalanceSheet(asOf).totalEquity, 'التشغيل يحسب الملكية كرصيد مُستخرج (Plug) من الأصول − الخصوم');

  return out;
}
function runFullAccountingAudit(){
  const a = buildAccountingAuditData();
  const eligibleUnposted = a.course.length + a.purchases.length + a.manualSales.length + a.legacy.length
    + a.vault.filter(r=> String(r['السبب']||'').startsWith('مؤهّلة')).length;
  const excludedCount = a.vault.filter(r=> !String(r['السبب']||'').startsWith('مؤهّلة')).length;
  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows, fallback)=>{
    const safe = (rows && rows.length) ? rows : [{ 'النتيجة': fallback || 'لا يوجد' }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(safe), name.slice(0,31));
  };
  addSheet('الملخص والفروقات', a.summary);
  const reasonRows = Object.entries(a.vaultReasonCounts).map(([r,n])=>({'سبب عدم الترحيل':r, 'عدد الحركات':n}));
  if(reasonRows.length){
    const ws = XLSX.utils.json_to_sheet(reasonRows);
    XLSX.utils.book_append_sheet(wb, ws, 'ملخص أسباب الاستثناء');
  }
  addSheet('فواتير دورات غير مرحّلة', a.course);
  addSheet('مشتريات غير مرحّلة', a.purchases);
  addSheet('مبيعات يدوية غير مرحّلة', a.manualSales);
  addSheet('قيود يدوية غير مرحّلة', a.legacy);
  addSheet('حركات خزنة غير مرحّلة', a.vault);
  addSheet('قيود مكررة', a.duplicates);
  addSheet('روابط قيود مكسورة', a.brokenLinks);
  addSheet('تشابه يستحق المراجعة', a.similar);
  XLSX.writeFile(wb, `تدقيق_محاسبي_شامل_${stampNow()}.xlsx`);
  const dupCount = a.duplicates.length;
  showToast(`تم التدقيق: ${eligibleUnposted} مستنداً مؤهّلاً غير مُرحّل · ${excludedCount} حركة مستثناة · ${dupCount} قيداً مكرراً · ${a.brokenLinks.length} رابط قيد مكسور — التقرير في Excel`);
  return a;
}
$('#btn-full-audit')?.addEventListener('click', ()=> withBtnLoading($('#btn-full-audit'), ()=> Promise.resolve(runFullAccountingAudit())));

function autoPostCourseInvoice(c){
  if(c.courseInvoiceDEId) return false;
  const prev = findExistingDEBySource('sourceClientId', c.id);
  if(prev){ if(c.courseInvoiceDEId !== prev.id){ c.courseInvoiceDEId = prev.id; _deRelinkDirty++; } return false; }
  if(!(c.receiptIssueDate && num(c.receiptActualValue)>0)) return false;
  if(clientHasUnsettledCash(c)) return false;
  const lines = buildDELinesForCourseInvoice(c);
  if(!lines) return false;
  if(!assertBalancedLines(lines)){
    logAudit('edit','المحاسبة', `⚠️ تعذّر الترحيل التلقائي: فاتورة دورة ${c.invoice||''} — ${c.name||''} غير متزنة — تحتاج مراجعة يدوية`);
    return false;
  }
  const entry = { id: uid(), createdAt: Date.now(), date: c.receiptIssueDate, description: `[ترحيل تلقائي] فاتورة دورة ${c.invoice||''} — ${c.name||''}`, lines, sourceClientId: c.id, isAuto: true };
  journalDE.push(entry);
  c.courseInvoiceDEId = entry.id;
  return true;
}

/* ================= ترحيل تلقائي لحركات الخزنة/البنك (الإيرادات والمصروفات والتحصيلات) =================
   كانت حركات الخزنة/البنك (وارد/صادر/مردود) خارج القيد المزدوج تماماً: قائمة الدخل تُحسب منها
   مباشرة، بينما دفتر الأستاذ وميزان المراجعة لا يريانها. الآن كل حركة مالية فعّالة تُرحَّل لقيد
   مزدوج متوازن، بأثر رجعي أيضاً، مع منع التكرار عند كل تحميل.

   التوجيه المحاسبي:
   - وارد مرتبط بعميل أو بحوالة شركة → مدين النقدية / دائن ذمم العملاء 1100 (تحصيل).
   - وارد غير مرتبط → مدين النقدية / دائن إيرادات أخرى 4100.
   - صادر عادي → مدين مصروفات تشغيلية 5000 / دائن النقدية (أو 5200 إن كان تصنيفه حقائب).
   - مردود مبيعات → مدين إيرادات 4000 بصافي المبلغ + مدين ضريبة 2100 / دائن النقدية.
   - تمويل/سحب مخزون الحقائب (bagStockRef) → تحويل بين النقدية ومخزون الحقائب 1200 وليس مصروفاً.
   - الوجهة: البنك → 1010، وأي وجهة أخرى (خزنة/شبكة/شبكة المستوصف) → 1000.

   لا تُرحَّل: حركة دفع فاتورة مشتريات (الفاتورة نفسها مُرحَّلة، وترحيل الدفع يضاعف المصروف)،
   والوجهة "أخرى" (خارج نقدية المركز)، والسجلات المعلّقة اعتماد الأدمن أو غير المسوّاة. */

let _vaultDEFullLoadDone = false;

/* يضمن وجود حساب البنك 1010 (دليل الحسابات في النسخ القديمة أُنشئ قبل إضافته). يرجع عدد التغييرات. */
function ensureAccountingAccounts(){
  let changed = 0;
  // حماية من نداء المزامنة قبل تحميل/تهيئة دليل الحسابات: نُنشئ الدليل الكامل بدل إضافة 1010 وحده
  if(!chartOfAccounts.length){
    seedChartOfAccountsIfEmpty();
    changed += chartOfAccounts.length;
  }
  if(!chartOfAccounts.some(a=>a.code==='1010')){
    chartOfAccounts.push({id:uid(), code:'1010', name:'البنك', type:'asset'});
    changed++;
  }
  const cash = chartOfAccounts.find(a=>a.code==='1000');
  if(cash && cash.name==='النقدية والبنوك'){ cash.name = 'النقدية (الخزنة)'; changed++; }
  return changed;
}

function vaultTxDoubleEntryBlocked(t, purchaseVaultIds){
  if(!t || t.deletedAt) return true;
  if((t.destination||'vault')==='other') return true;
  const linkedToPurchase = purchaseVaultIds
    ? purchaseVaultIds.has(t.id)
    : (typeof purchases!=='undefined' && purchases && purchases.some(p=>p.vaultTxId===t.id));
  if(linkedToPurchase) return true;
  const meta = (typeof recordMeta==='object' && recordMeta && recordMeta.vaultTx) ? recordMeta.vaultTx[t.id] : null;
  if(meta && meta.status==='pending') return true;
  if(t.autoClientId && (t.destination||'vault')==='vault' && t.settled===false) return true;
  return false;
}

function vaultCashAccount(t){
  return ((t.destination||'vault')==='bank' ? accountByCode('1010') : null) || accountByCode('1000');
}

function buildDELinesForVaultTx(t){
  const cash = vaultCashAccount(t);
  const ar = accountByCode('1100'), rev = accountByCode('4000'), otherRev = accountByCode('4100');
  const opex = accountByCode('5000'), bagCost = accountByCode('5200'), bagInv = accountByCode('1200');
  const vat = accountByCode('2100');
  const amount = roundMoney(num(t.amount));
  if(!cash || amount<=0) return null;

  // تمويل/سحب مخزون الحقائب: تحويل بين النقدية والمخزون، وليس مصروفاً
  if(t.bagStockRef && bagInv){
    if(t.type==='out') return [{accountId:bagInv.id, debit:amount, credit:0}, {accountId:cash.id, debit:0, credit:amount}];
    if(t.type==='in') return [{accountId:cash.id, debit:amount, credit:0}, {accountId:bagInv.id, debit:0, credit:amount}];
  }

  if(t.type==='in'){
    const creditAcc = (t.clientId || t.companyTransferId) ? ar : otherRev;
    if(!creditAcc) return null;
    return [{accountId:cash.id, debit:amount, credit:0}, {accountId:creditAcc.id, debit:0, credit:amount}];
  }

  if(t.type==='out'){
    if(t.isReturn){
      if(!rev) return null;
      const v = (vat && typeof vatFromGross==='function') ? roundMoney(vatFromGross(amount)) : 0;
      const net = roundMoney(amount - v);
      const lines = [{accountId:rev.id, debit:net, credit:0}];
      if(v>0.004 && vat) lines.push({accountId:vat.id, debit:v, credit:0});
      lines.push({accountId:cash.id, debit:0, credit:amount});
      return lines;
    }
    const debitAcc = (String(t.category||'').indexOf('حقائب')>-1 && bagCost) ? bagCost : opex;
    if(!debitAcc) return null;
    return [{accountId:debitAcc.id, debit:amount, credit:0}, {accountId:cash.id, debit:0, credit:amount}];
  }
  return null;
}

/* توقيع الحركة: أي تغيير في المبلغ/التاريخ/النوع/الوجهة/التصنيف/الارتباط يجب أن يعيد بناء القيد */
function vaultTxDESignature(t){
  return [
    String(t.date||''), roundMoney(num(t.amount)).toFixed(2), String(t.type||''), t.isReturn?'R':'',
    String(t.destination||'vault'), String(t.category||''), String(t.clientId||''),
    String(t.companyTransferId||''), String(t.bagStockRef||'')
  ].join('|');
}

function autoPostVaultTx(t, purchaseVaultIds){
  if(!t || vaultTxDoubleEntryBlocked(t, purchaseVaultIds)) return false;
  if(t.linkedDEId){
    const linked = journalDE.find(e=>e.id===t.linkedDEId);
    if(linked) return false;
    delete t.linkedDEId;
  }
  const prev = findExistingDEBySource('sourceVaultId', t.id);
  if(prev){
    if(t.linkedDEId !== prev.id) t.linkedDEId = prev.id;
    return false;
  }
  const lines = buildDELinesForVaultTx(t);
  if(!lines || !assertBalancedLines(lines)) return false;
  const kind = t.isReturn ? 'مردود مبيعات' : (t.type==='in' ? 'حركة قبض/إيراد' : 'حركة صرف/مصروف');
  const who = t.clientName || t.manual || t.category || t.recipientName || '';
  const entry = {
    id: uid(), createdAt: Date.now(), date: t.date || todayISO(),
    description: `[ترحيل تلقائي] ${kind} #${t.seq||'—'}${who ? ' — '+who : ''}`,
    lines, sourceVaultId: t.id, vaultSig: vaultTxDESignature(t), isAuto: true
  };
  journalDE.push(entry);
  t.linkedDEId = entry.id;
  return true;
}

/* مزامنة شاملة (آمنة للتكرار): تحذف قيود الحركات المحذوفة/المعلّقة/المتغيّرة، وتضيف قيود
   الحركات المؤهّلة التي لا قيد لها. تُستدعى عند التحميل، وعند فتح تبويب المحاسبة، وبعد أي
   إضافة/تعديل/إلغاء/اعتماد لحركة مالية. */
function syncVaultTxDoubleEntries(){
  const accounts = ensureAccountingAccounts();
  const live = new Map((typeof vaultTx!=='undefined' && vaultTx ? vaultTx : []).map(t=>[t.id, t]));
  const purchaseVaultIds = new Set(
    (typeof purchases!=='undefined' && purchases ? purchases : [])
      .map(p=>p.vaultTxId).filter(Boolean)
  );
  let removed = 0;
  journalDE = journalDE.filter(e=>{
    if(!e.sourceVaultId) return true;
    const t = live.get(e.sourceVaultId);
    const stale = !t || t.deletedAt || vaultTxDoubleEntryBlocked(t, purchaseVaultIds) || e.vaultSig !== vaultTxDESignature(t);
    if(stale){ removed++; return false; }
    return true;
  });
  const kept = new Set();
  journalDE.forEach(e=>{ if(e.sourceVaultId) kept.add(e.sourceVaultId); });
  let pointers = 0;
  live.forEach(t=>{
    if(t.linkedDEId && !journalDE.some(e=>e.id===t.linkedDEId)){ delete t.linkedDEId; pointers++; }
  });
  let added = 0;
  live.forEach(t=>{
    if(kept.has(t.id)) return;
    if(autoPostVaultTx(t, purchaseVaultIds)) added++;
  });
  return { added, removed, pointers, accounts, changed: added>0 || removed>0 || pointers>0 };
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
  if(!$('#coa-code')) return;
  // مزامنة حركات الخزنة/البنك مع القيد المزدوج عند فتح التبويب (تعكس أي تعديل جرى دون إعادة تحميل).
  // لا تُنفَّذ قبل اكتمال تحميل حقيقي للبيانات حتى لا تُرحَّل سجلات معلّقة قبل معرفة حالتها.
  if(_vaultDEFullLoadDone && typeof syncVaultTxDoubleEntries==='function'){
    try{
      const vSync = syncVaultTxDoubleEntries();
      if(vSync.accounts) saveChartOfAccounts().catch(()=>{});
    }catch(e){ /* لا نمنع عرض التبويب بسبب فشل المزامنة */ }
  }
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
/* ============ بحث شامل (Global Search) ============ */
function runGlobalSearch(q){
  q = (q||'').trim().toLowerCase();
  if(q.length < 2) return { clients:[], vault:[], purchases:[], journal:[] };
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
  const matchJournal = journalEntries.filter(j=>
    String(j.description||'').toLowerCase().includes(q) ||
    String(num(j.amount)).includes(q)
  ).slice(0,8);
  return { clients: matchClients, vault: matchVault, purchases: matchPurchases, journal: matchJournal };
}
/* ============ مركز الأوامر (Command Center v1) — فوق البحث الشامل ============
   الأوامر تُبنى من DOM وقت الفتح لتبقى متزامنة تلقائياً مع الصلاحيات والتسميات.
   كل صف قابل للتنفيذ يسجّل دالة في _gsActs ويُخاطَب بالفهرس (نقر/لوحة مفاتيح). */
let _gsActs = [];
let _gsActiveIdx = 0;
const GS_ICONS = {
  nav: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6l-6 6 6 6"></path></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="3.4"></circle><path d="M5.5 20c0-3.4 2.9-5.6 6.5-5.6s6.5 2.2 6.5 5.6"></path></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="7" width="18" height="11" rx="2"></rect><circle cx="12" cy="12.5" r="2.4"></circle><path d="M6.5 10v.01M17.5 15v.01"></path></svg>',
  ledger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="4" width="14" height="16" rx="2"></rect><path d="M9 9h6M9 13h6M9 17h3"></path></svg>',
  theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"></path></svg>',
  kbd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="7" width="18" height="11" rx="2"></rect><path d="M7 11h.01M11 11h.01M15 11h.01M7 14.5h10"></path></svg>'
};
function gsCommandItems(){
  const cmds = [];
  $all('nav.tabs button[data-view]').forEach(btn=>{
    if(btn.style.display === 'none') return;
    const span = btn.querySelector('span');
    const label = span ? span.textContent.trim() : '';
    if(!label) return;
    cmds.push({ icon:'nav', label:`فتح: ${label}`, kw:`${label} ${btn.dataset.view||''} تنقل افتح شاشة`, run(){
      closeGlobalSearch(); btn.click();
    }});
  });
  const pushAct = (sel, icon, label, kw, pre)=>{
    const b = document.getElementById(sel.replace('#',''));
    if(!b || b.style.display === 'none') return;
    cmds.push({ icon, label, kw, run(){
      closeGlobalSearch();
      if(pre) pre();
      setTimeout(()=> b.click(), pre ? 250 : 0);
    }});
  };
  pushAct('#btn-add', 'user', 'تسجيل متدرب جديد', 'متدرب عميل جديد تسجيل إضافة client',
    ()=> document.querySelector('nav.tabs button[data-view="clients"]')?.click());
  pushAct('#btn-fab-quickadd', 'money', 'حركة مالية جديدة', 'حركة مالية قبض صرف إيراد مصروف خزنة vault',
    null);
  pushAct('#btn-add-journal', 'ledger', 'قيد يومية جديد', 'قيد يومية محاسبة دفتر journal',
    ()=> document.querySelector('nav.tabs button[data-view="accounting"]')?.click());
  pushAct('#btn-theme-toggle', 'theme', 'تبديل الوضع الليلي/النهاري', 'وضع ليلي نهاري ثيم مظهر dark theme',
    null);
  pushAct('#btn-shortcuts-help', 'kbd', 'اختصارات لوحة المفاتيح', 'اختصارات مساعدة لوحة مفاتيح keyboard',
    null);
  return cmds;
}
function gsRunRow(html, run){
  const i = _gsActs.length; _gsActs.push(run);
  return `<div class="gsr-item" role="option" data-gs-act="${i}">${html}</div>`;
}
function gsSyncActive(){
  $all('#global-search-results .gsr-item').forEach(el=>{
    el.classList.toggle('active', Number(el.dataset.gsAct) === _gsActiveIdx);
  });
  $('#global-search-results .gsr-item.active')?.scrollIntoView({ block:'nearest' });
}
function renderGlobalSearchResults(q){
  const el = $('#global-search-results');
  if(!el) return;
  _gsActs = []; _gsActiveIdx = 0;
  q = String(q ?? '');
  const ql = q.trim().toLowerCase();
  /* شاشة فارغة = إجراءات سريعة جاهزة بدل رسالة "اكتب حرفين" الجافة */
  if(ql.length < 2){
    const quick = gsCommandItems().slice(0,6);
    el.innerHTML = `<div class="hint">اكتب حرفين للبحث في العملاء والحركات والمشتريات — أو نفّذ أمراً مباشرة:</div>
      <div class="gsr-grid">${ quick.map(c=> gsRunRow(
        `<span class="gsr-cmd-icon">${GS_ICONS[c.icon]||GS_ICONS.nav}</span><span>${escapeHtml(c.label)}</span>`, c.run)).join('') }</div>`;
    gsSyncActive();
    return;
  }
  const { clients: rc, vault: rv, purchases: rp, journal: rj } = runGlobalSearch(q);
  const cmds = gsCommandItems().filter(c=> c.kw.toLowerCase().includes(ql)).slice(0,7);
  let html = '';
  if(cmds.length){
    html += `<h4 class="gsr-head">أوامر</h4>`;
    html += cmds.map(c=> gsRunRow(
      `<span class="gsr-cmd-icon">${GS_ICONS[c.icon]||GS_ICONS.nav}</span><b>${escapeHtml(c.label)}</b>`, c.run)).join('');
  }
  if(rc.length){
    html += `<h4 class="gsr-head">العملاء (${rc.length})</h4>`;
    html += rc.map(c=> gsRunRow(
      `<b>${escapeHtml(c.name||'')}</b><span class="gsr-meta">${escapeHtml(c.phone||'')} · ${escapeHtml(c.courseType||'')} · ${escapeHtml(c.invoice||'')}</span>`,
      ()=>{
        closeGlobalSearch();
        document.querySelector('nav.tabs button[data-view="clients"]')?.click();
        if($('#search')){ $('#search').value = c.clientId || c.name || ''; $('#search').dispatchEvent(new Event('input')); }
      })).join('');
  }
  if(rv.length){
    html += `<h4 class="gsr-head">الحركات المالية (${rv.length})</h4>`;
    html += rv.map(t=> gsRunRow(
      `<b>${fmt(num(t.amount))}</b><span class="gsr-meta">${escapeHtml(t.clientName||t.category||'')} · ${escapeHtml(t.date||'')} · ${t.type==='in'?'قبض':'صرف'}</span>`,
      ()=>{
        closeGlobalSearch();
        document.querySelector('nav.tabs button[data-view="vault"]')?.click();
      })).join('');
  }
  if(rp.length){
    html += `<h4 class="gsr-head">المشتريات (${rp.length})</h4>`;
    html += rp.map(p=> gsRunRow(
      `<b>${escapeHtml(p.supplierName||'')}</b><span class="gsr-meta">${escapeHtml(p.invoiceNo||'')} · ${fmt(num(p.total))} · ${escapeHtml(p.date||'')}</span>`,
      ()=>{
        closeGlobalSearch();
        document.querySelector('nav.tabs button[data-view="purchases"]')?.click();
      })).join('');
  }
  if(rj.length){
    html += `<h4 class="gsr-head">قيود اليومية (${rj.length})</h4>`;
    html += rj.map(j=> gsRunRow(
      `<b>${escapeHtml(j.description||'')}</b><span class="gsr-meta">${fmt(num(j.amount))} · ${escapeHtml(j.date||'')}</span>`,
      ()=>{
        closeGlobalSearch();
        document.querySelector('nav.tabs button[data-view="accounting"]')?.click();
      })).join('');
  }
  el.innerHTML = html || `<div class="hint">لا توجد نتائج مطابقة</div>`;
  gsSyncActive();
}
function openGlobalSearch(){
  $('#global-search-overlay').classList.add('show');
  $('#global-search-input').value = '';
  renderGlobalSearchResults('');
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
// البحث العام يمسح كل قواعد البيانات الأربع مع كل حرف — نؤخّره حتى توقف الكتابة، عادة الشكوى
// من "تعليق" أثناء البحث في شاشات كثيرة.
const _debouncedGlobalSearch = debounce(v => renderGlobalSearchResults(v));
$('#global-search-input')?.addEventListener('input', e=> _debouncedGlobalSearch(e.target.value));
$('#global-search-input')?.addEventListener('keydown', e=>{
  const rows = $all('#global-search-results .gsr-item');
  if(!rows.length) return;
  if(e.key==='ArrowDown' || e.key==='ArrowUp'){
    e.preventDefault();
    const dir = e.key==='ArrowDown' ? 1 : -1;
    _gsActiveIdx = (_gsActiveIdx + dir + rows.length) % rows.length;
    gsSyncActive();
  } else if(e.key==='Enter'){
    e.preventDefault();
    const run = _gsActs[Math.min(_gsActiveIdx, _gsActs.length - 1)];
    if(typeof run === 'function') run();
  }
});
$('#global-search-results')?.addEventListener('click', e=>{
  const item = e.target.closest('[data-gs-act]');
  if(!item) return;
  const run = _gsActs[Number(item.dataset.gsAct)];
  if(typeof run === 'function') run();
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
