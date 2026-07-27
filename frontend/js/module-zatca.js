/* ================================================================
   الفوترة الضريبية والزكاة (ZATCA) — تبويب مستقل
   يجمع: فواتير المبيعات (تلقائي من فواتير الدورات + يدوي)، مردودات المبيعات،
   المشتريات، ملخص الإقرار الضريبي، وحساب الزكاة التقديري.
   ================================================================ */
let editingManualSalesId = null;

function formatManualSalesInvoiceNo(n){ return 'MSI-' + String(n).padStart(6,'0'); }

function zatcaSelectedRange(){
  const year = $('#zt-year')?.value || String(new Date().getFullYear());
  const period = $('#zt-period')?.value || 'year';
  const map = {
    year: [`${year}-01-01`, `${year}-12-31`],
    q1: [`${year}-01-01`, `${year}-03-31`],
    q2: [`${year}-04-01`, `${year}-06-30`],
    q3: [`${year}-07-01`, `${year}-09-30`],
    q4: [`${year}-10-01`, `${year}-12-31`],
  };
  const [from, to] = map[period] || map.year;
  return { year, period, from, to, asOf: to };
}
function populateZtYearSelect(){
  const sel = $('#zt-year');
  if(!sel) return;
  const years = typeof collectAllYears==='function' ? collectAllYears() : [String(new Date().getFullYear())];
  const thisYear = String(new Date().getFullYear());
  if(!years.includes(thisYear)) years.unshift(thisYear);
  const keep = sel.value;
  sel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join('');
  sel.value = years.includes(keep) ? keep : years[0];
}

function buildZatcaSalesRows(from, to){
  const courseRows = (typeof courseInvoiceClients==='function' ? courseInvoiceClients() : []).filter(c=>{
    const d = c.receiptIssueDate || '';
    return num(c.receiptActualValue) > 0 && d && d>=from && d<=to;
  }).map(c=>({
    refId: c.id, source:'course', date: c.receiptIssueDate, name: c.name || '—',
    invoiceNo: c.invoice || '—', totalInclVat: num(c.receiptActualValue), vat: courseInvoiceVat(c.receiptActualValue)
  }));
  const manualRows = manualSalesInvoices.filter(m=> m.date && m.date>=from && m.date<=to).map(m=>({
    refId: m.id, source:'manual', date: m.date, name: m.name || '—',
    invoiceNo: formatManualSalesInvoiceNo(m.invoiceNo||0), totalInclVat: num(m.total), vat: num(m.total) - (num(m.total)/1.15)
  }));
  return courseRows.concat(manualRows).sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')));
}
function buildZatcaReturnsRows(from, to){
  return vaultTx.filter(t=>t.type==='out' && t.isReturn && inRange(t.date, from, to))
    .map(t=>({ id:t.id, date:t.date, name:t.clientName||t.clientId||'—', amount:num(t.amount), vat: num(t.amount)-(num(t.amount)/1.15) }))
    .sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')));
}
function buildZatcaPurchaseRows(from, to){
  return purchases.filter(p=> p.date && p.date>=from && p.date<=to)
    .map(p=>({id:p.id, date:p.date, supplierName:p.supplierName||'—', invoiceNo:p.invoiceNo||'—', total:num(p.total), vat:num(p.taxAmount)}))
    .sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')));
}

function renderZtSalesTable(from, to){
  const rows = buildZatcaSalesRows(from, to);
  $('#zt-sales-body').innerHTML = rows.map(r=>`
    <tr>
      <td class="mono">${escapeHtml(r.date||'—')}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="mono">${escapeHtml(r.invoiceNo)}</td>
      <td><span class="stamp ${r.source==='course'?'paid':'owe'}">${r.source==='course'?'فاتورة دورة':'يدوية'}</span></td>
      <td class="mono">${fmt(r.totalInclVat)}</td>
      <td class="mono">${fmt(r.vat)}</td>
      <td>
        ${r.source==='course'
          ? `<button class="btn btn-ghost btn-sm" data-zt-print-course="${r.refId}">طباعة</button>`
          : `<button class="btn btn-ghost btn-sm" data-zt-print-manual="${r.refId}">طباعة</button>
             <button class="btn btn-ghost btn-sm" data-zt-edit-manual="${r.refId}">تعديل</button>
             <button class="btn btn-danger btn-sm" data-zt-del-manual="${r.refId}">حذف</button>`}
      </td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد فواتير مبيعات ضمن هذه الفترة</td></tr>`;
  const totalIncl = rows.reduce((s,r)=>s+r.totalInclVat,0);
  const totalVat = rows.reduce((s,r)=>s+r.vat,0);
  $('#zt-sales-total').textContent = `عدد الفواتير: ${rows.length} · الإجمالي شامل الضريبة: ${fmt(totalIncl)} ﷼ · إجمالي الضريبة: ${fmt(totalVat)} ﷼`;
}
function renderZtReturnsTable(from, to){
  const rows = buildZatcaReturnsRows(from, to);
  $('#zt-returns-body').innerHTML = rows.map(r=>`
    <tr>
      <td class="mono">${escapeHtml(r.date||'—')}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="mono">${fmt(r.amount)}</td>
      <td class="mono">${fmt(r.vat)}</td>
      <td><button class="btn btn-ghost btn-sm" data-zt-print-return="${r.id}">طباعة</button></td>
    </tr>`).join('') || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد مردودات مبيعات ضمن هذه الفترة</td></tr>`;
  const totalAmount = rows.reduce((s,r)=>s+r.amount,0);
  const totalVat = rows.reduce((s,r)=>s+r.vat,0);
  $('#zt-returns-total').textContent = `عدد المردودات: ${rows.length} · الإجمالي: ${fmt(totalAmount)} ﷼ · الضريبة داخل المردود: ${fmt(totalVat)} ﷼`;
}
function renderZtPurchasesTable(from, to){
  const rows = buildZatcaPurchaseRows(from, to);
  $('#zt-purchases-body').innerHTML = rows.map(r=>`
    <tr>
      <td class="mono">${escapeHtml(r.date||'—')}</td>
      <td>${escapeHtml(r.supplierName)}</td>
      <td class="mono">${escapeHtml(r.invoiceNo)}</td>
      <td class="mono">${fmt(r.total)}</td>
      <td class="mono">${fmt(r.vat)}</td>
    </tr>`).join('') || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد فواتير مشتريات ضمن هذه الفترة</td></tr>`;
  const totalIncl = rows.reduce((s,r)=>s+r.total,0);
  const totalVat = rows.reduce((s,r)=>s+r.vat,0);
  $('#zt-purchases-total').textContent = `عدد الفواتير: ${rows.length} · الإجمالي شامل الضريبة: ${fmt(totalIncl)} ﷼ · إجمالي الضريبة: ${fmt(totalVat)} ﷼`;
}
function buildZatcaVatReturn(from, to){
  const salesRows = buildZatcaSalesRows(from, to);
  const returnRows = buildZatcaReturnsRows(from, to);
  const purchaseRows = buildZatcaPurchaseRows(from, to);
  const salesGross = salesRows.reduce((s,r)=>s+r.totalInclVat,0);
  const outputVatGross = salesRows.reduce((s,r)=>s+r.vat,0);
  const returnsGross = returnRows.reduce((s,r)=>s+r.amount,0);
  const returnsVat = returnRows.reduce((s,r)=>s+r.vat,0);
  const outputVat = outputVatGross - returnsVat;
  const salesNet = (salesGross - outputVatGross) - (returnsGross - returnsVat);
  const purchasesGross = purchaseRows.reduce((s,r)=>s+r.total,0);
  const inputVat = purchaseRows.reduce((s,r)=>s+r.vat,0);
  const purchasesNet = purchasesGross - inputVat;
  const netVat = outputVat - inputVat;
  return { salesRows, returnRows, purchaseRows, salesGross, salesNet, outputVat, returnsGross, returnsVat, purchasesGross, purchasesNet, inputVat, netVat };
}
function renderZtVatTable(from, to){
  const table = $('#zt-vat-table');
  if(!table) return null;
  const r = buildZatcaVatReturn(from, to);
  const row = (label, value, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:1px solid var(--border);':(opts&&opts.muted?'color:var(--text-muted);':'')}"><td style="${opts&&opts.indent?'padding-right:22px;':''}">${label}</td><td class="mono" style="text-align:left;">${fmt(value)}</td></tr>`;
  table.innerHTML = `<tbody>
    <tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">المبيعات (ضريبة المخرجات) — ${r.salesRows.length} فاتورة</td></tr>
    ${row('إجمالي المبيعات شامل الضريبة', r.salesGross, {indent:true, muted:true})}
    ${row('يُخصم: مردودات مبيعات (شامل الضريبة)', -r.returnsGross, {indent:true, muted:true})}
    ${row('صافي ضريبة المخرجات', r.outputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">المشتريات (ضريبة المدخلات) — ${r.purchaseRows.length} فاتورة</td></tr>
    ${row('إجمالي المشتريات شامل الضريبة', r.purchasesGross, {indent:true, muted:true})}
    ${row('إجمالي ضريبة المدخلات', r.inputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px;"></td></tr>
    ${row(r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', Math.abs(r.netVat), {bold:true})}
  </tbody>`;
  return r;
}
/* جدول مطابقة صناديق نموذج الإقرار الرسمي في بوابة الهيئة (نفس ترتيب النموذج: مبيعات ثم مشتريات ثم صافي الضريبة) */
function renderZtVatBoxesTable(from, to){
  const table = $('#zt-vat-boxes-table');
  if(!table) return;
  const r = buildZatcaVatReturn(from, to);
  const head = `<thead><tr><th style="width:50px;">#</th><th>البيان</th><th style="text-align:left;">القيمة (بدون ضريبة)</th><th style="text-align:left;">الضريبة</th></tr></thead>`;
  const box = (n, label, value, vat, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:2px solid var(--navy);':''}">
    <td class="mono">${n}</td><td>${label}</td>
    <td class="mono" style="text-align:left;">${value===null?'—':fmt(value)}</td>
    <td class="mono" style="text-align:left;">${vat===null?'—':fmt(vat)}</td>
  </tr>`;
  table.innerHTML = `${head}<tbody>
    <tr><td colspan="4" style="padding-top:12px; font-weight:800; color:var(--navy);">المبيعات</td></tr>
    ${box('1', 'المبيعات المحلية الخاضعة للنسبة الأساسية (15%)', r.salesNet, r.outputVat)}
    ${box('2', 'المبيعات الخاضعة لآلية الاحتساب العكسي المحلي', 0, 0)}
    ${box('3', 'المبيعات المحلية الخاضعة لنسبة الصفر', 0, null)}
    ${box('4', 'الصادرات', 0, null)}
    ${box('5', 'المبيعات المعفاة', 0, null)}
    ${box('—', 'إجمالي المبيعات وضريبة المخرجات', r.salesNet, r.outputVat, {bold:true})}
    <tr><td colspan="4" style="padding-top:12px; font-weight:800; color:var(--navy);">المشتريات</td></tr>
    ${box('6', 'المشتريات المحلية الخاضعة للنسبة الأساسية (15%)', r.purchasesNet, r.inputVat)}
    ${box('7', 'الواردات الخاضعة للضريبة المدفوعة عند الجمارك', 0, 0)}
    ${box('8', 'الواردات الخاضعة للضريبة بموجب آلية الاحتساب العكسي', 0, 0)}
    ${box('9', 'المشتريات الخاضعة لنسبة الصفر', 0, null)}
    ${box('10', 'المشتريات المعفاة', 0, null)}
    ${box('—', 'إجمالي المشتريات وضريبة المدخلات', r.purchasesNet, r.inputVat, {bold:true})}
    <tr><td colspan="4" style="padding-top:12px;"></td></tr>
    ${box('11', r.netVat>=0 ? 'صافي ضريبة القيمة المضافة المستحقة للهيئة' : 'صافي ضريبة القيمة المضافة الدائنة (لصالحك)', null, Math.abs(r.netVat), {bold:true})}
  </tbody>`;
}

/* ---- الزكاة (تقديري): وعاء الزكاة ≈ حقوق الملكية + القروض طويلة الأجل − صافي الأصول الثابتة، مع تعديلات يدوية ---- */
function computeZakat(asOf, year){
  const bs = typeof buildBalanceSheet==='function' ? buildBalanceSheet(asOf) : {totalEquity:0, loans:0, fixedAssetsNet:0};
  const adj = zakatAdjustments[year] || {additions:0, deductions:0, rate:0.025, notes:''};
  const additions = num($('#zk-additions')?.value ?? adj.additions);
  const deductions = num($('#zk-deductions')?.value ?? adj.deductions);
  const rate = num($('#zk-rate')?.value ?? adj.rate) || 0.025;
  const base = Math.max(0, bs.totalEquity + Math.max(0,bs.loans) - Math.max(0, bs.fixedAssetsNet) + additions - deductions);
  const due = base * rate;
  return { bs, additions, deductions, rate, base, due };
}
function renderZtZakatTable(asOf, year){
  const adj = zakatAdjustments[year] || {additions:0, deductions:0, rate:0.025, notes:''};
  if($('#zk-additions') && !$('#zk-additions')._touched) $('#zk-additions').value = adj.additions || 0;
  if($('#zk-deductions') && !$('#zk-deductions')._touched) $('#zk-deductions').value = adj.deductions || 0;
  if($('#zk-rate')) $('#zk-rate').value = String(adj.rate || 0.025);
  if($('#zk-notes')) $('#zk-notes').value = adj.notes || '';
  const z = computeZakat(asOf, year);
  const row = (label, value, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:1px solid var(--border);':(opts&&opts.muted?'color:var(--text-muted);':'')}"><td style="${opts&&opts.indent?'padding-right:22px;':''}">${label}</td><td class="mono" style="text-align:left;">${fmt(value)}</td></tr>`;
  $('#zt-zakat-table').innerHTML = `<tbody>
    ${row('حقوق الملكية (كما بالميزانية العمومية)', z.bs.totalEquity, {indent:true, muted:true})}
    ${row('يُضاف: القروض طويلة الأجل', Math.max(0,z.bs.loans), {indent:true, muted:true})}
    ${row('يُخصم: صافي الأصول الثابتة', -Math.max(0,z.bs.fixedAssetsNet), {indent:true, muted:true})}
    ${row('يُضاف: إضافات يدوية أخرى', z.additions, {indent:true, muted:true})}
    ${row('يُخصم: خصومات يدوية أخرى', -z.deductions, {indent:true, muted:true})}
    ${row('وعاء الزكاة التقديري', z.base, {bold:true})}
    ${row(`الزكاة المستحقة (${(z.rate*100).toFixed(3)}%)`, z.due, {bold:true})}
  </tbody>`;
}

function renderZtSummaryCards(from, to, asOf, year){
  const vat = buildZatcaVatReturn(from, to);
  const zk = computeZakat(asOf, year);
  $('#zt-summary-cards').innerHTML = `
    <div class="card"><div class="k">مبيعات الفترة (شامل الضريبة)</div><div class="v teal">${fmt(vat.salesGross)}</div></div>
    <div class="card"><div class="k">ضريبة المخرجات (صافي)</div><div class="v">${fmt(vat.outputVat)}</div></div>
    <div class="card"><div class="k">مشتريات الفترة (شامل الضريبة)</div><div class="v">${fmt(vat.purchasesGross)}</div></div>
    <div class="card"><div class="k">ضريبة المدخلات</div><div class="v">${fmt(vat.inputVat)}</div></div>
    <div class="card"><div class="k">${vat.netVat>=0?'صافي الضريبة المستحقة':'صافي الضريبة الدائنة'}</div><div class="v ${vat.netVat>=0?'red':'gold'}">${fmt(Math.abs(vat.netVat))}</div></div>
    <div class="card"><div class="k">الزكاة التقديرية المستحقة</div><div class="v gold">${fmt(zk.due)}</div></div>
  `;
}

function renderZatca(){
  if(!$('#view-zatca')) return;
  refreshZatcaOnboardStatus();
  populateZtYearSelect();
  const { year, period, from, to, asOf } = zatcaSelectedRange();
  $('#zt-period-label').textContent = `الفترة المعروضة: من ${formatDateDisplay(from)} إلى ${formatDateDisplay(to)}`;
  renderZtSummaryCards(from, to, asOf, year);
  renderZtSalesTable(from, to);
  renderZtReturnsTable(from, to);
  renderZtPurchasesTable(from, to);
  renderZtVatTable(from, to);
  renderZtVatBoxesTable(from, to);
  renderZtZakatTable(asOf, year);
}
['#zt-year','#zt-period'].forEach(sel=> $(sel)?.addEventListener('change', renderZatca));
$('#zk-additions')?.addEventListener('input', function(){ this._touched = true; renderZtZakatTable(zatcaSelectedRange().asOf, zatcaSelectedRange().year); });
$('#zk-deductions')?.addEventListener('input', function(){ this._touched = true; renderZtZakatTable(zatcaSelectedRange().asOf, zatcaSelectedRange().year); });
$('#zk-rate')?.addEventListener('change', ()=> renderZtZakatTable(zatcaSelectedRange().asOf, zatcaSelectedRange().year));
$('#btn-save-zakat')?.addEventListener('click', async ()=>{
  const { year } = zatcaSelectedRange();
  zakatAdjustments[year] = {
    additions: num($('#zk-additions').value),
    deductions: num($('#zk-deductions').value),
    rate: num($('#zk-rate').value) || 0.025,
    notes: $('#zk-notes').value.trim()
  };
  await saveZakatAdjustments();
  await logAudit('edit','الفوترة الضريبية والزكاة', `تم حفظ تعديلات وعاء الزكاة لسنة ${year}`);
  showToast('تم حفظ تعديلات الزكاة لهذه السنة');
  if($('#zk-additions')) $('#zk-additions')._touched = false;
  if($('#zk-deductions')) $('#zk-deductions')._touched = false;
});
$('#btn-goto-purchases')?.addEventListener('click', ()=> $('[data-view="purchases"]')?.click());

/* ---- الربط الفعلي مع منصة فاتورة (المرحلة الثانية): تحميل الحالة + التسجيل ---- */
async function refreshZatcaOnboardStatus(){
  const box = $('#zt-onboard-status');
  if(!box) return;
  try{
    const res = await serverFetch('/api/zatca/status?environment=sandbox');
    if(!res.ok){ box.innerHTML = '⚠️ تعذّر جلب حالة الربط'; return; }
    const s = await res.json();
    if(!s.onboarded){
      box.innerHTML = '⚪ لم يتم التسجيل بعد — عبّي البيانات وأدخل رمز OTP من بوابة فاتورة (Sandbox).';
      $('#zt-onboard-form-wrap').style.display = '';
      $('#zt-onboard-production-wrap').style.display = 'none';
    }else if(!s.hasProductionCsid){
      box.innerHTML = `🧪 تم التسجيل والحصول على شهادة الامتثال (${escapeHtml(s.vatName||'')} — ${escapeHtml(s.vatNumber||'')}) — بانتظار شهادة الإنتاج.`;
      $('#zt-onboard-form-wrap').style.display = 'none';
      $('#zt-onboard-production-wrap').style.display = '';
      if(s.complianceRequestId) _lastZatcaComplianceRequestId = s.complianceRequestId;
    }else{
      box.innerHTML = `✅ الربط مفعّل بالكامل (${escapeHtml(s.vatName||'')} — ${escapeHtml(s.vatNumber||'')}) — الفواتير تُرسل فعلياً عند الطباعة.`;
      $('#zt-onboard-form-wrap').style.display = 'none';
      $('#zt-onboard-production-wrap').style.display = 'none';
    }
  }catch(e){ box.innerHTML = '⚠️ تعذّر جلب حالة الربط'; }
}
let _lastZatcaComplianceRequestId = null;
$('#btn-zatca-onboard')?.addEventListener('click', async ()=>{
  const otp = $('#zo-otp').value.trim();
  const vatName = $('#zo-vatname').value.trim();
  const vatNumber = $('#zo-vatnumber').value.trim();
  if(!otp || !vatName || !vatNumber){ showToast('عبّي الاسم والرقم الضريبي وOTP على الأقل'); return; }
  const btn = $('#btn-zatca-onboard'); btn.disabled = true; btn.textContent = 'جارٍ التسجيل…';
  try{
    const res = await serverFetch('/api/zatca/onboard', { method:'POST', body: JSON.stringify({
      environment: 'sandbox', otp,
      orgProfile: {
        vatName, vatNumber, crnNumber: $('#zo-crn').value.trim(),
        city: $('#zo-city').value.trim(), citySubdivision: $('#zo-subdivision').value.trim(),
        street: $('#zo-street').value.trim(), postalZone: $('#zo-postal').value.trim(),
        branchName: $('#zo-branchname').value.trim(), branchIndustry: $('#zo-branchindustry').value.trim(),
      }
    })});
    const data = await res.json();
    if(!res.ok) throw new Error(data.detail || data.error || 'فشل التسجيل');
    _lastZatcaComplianceRequestId = data.complianceRequestId;
    showToast('تم التسجيل والحصول على شهادة الامتثال بنجاح ✅');
    await logAudit('edit','الفوترة الضريبية والزكاة', 'تم تسجيل EGS والحصول على شهادة امتثال من هيئة فاتورة (Sandbox)');
    await refreshZatcaOnboardStatus();
  }catch(e){
    showToast('فشل التسجيل: ' + (e.message||'خطأ غير معروف'));
  }finally{ btn.disabled = false; btn.textContent = 'تسجيل والحصول على شهادة الامتثال'; }
});
$('#btn-zatca-production')?.addEventListener('click', async ()=>{
  if(!_lastZatcaComplianceRequestId){ showToast('لا يوجد رقم طلب امتثال محفوظ في هذه الجلسة — أعد تسجيل الدخول وحاول مجدداً بعد الطباعة التجريبية'); return; }
  const btn = $('#btn-zatca-production'); btn.disabled = true; btn.textContent = 'جارٍ الطلب…';
  try{
    const res = await serverFetch('/api/zatca/production-csid', { method:'POST', body: JSON.stringify({
      environment: 'sandbox', complianceRequestId: _lastZatcaComplianceRequestId
    })});
    const data = await res.json();
    if(!res.ok) throw new Error(data.detail || data.error || 'فشل الطلب');
    showToast('تم تفعيل الإرسال الفعلي الكامل ✅');
    await logAudit('edit','الفوترة الضريبية والزكاة', 'تم الحصول على شهادة الإنتاج (PCSID) — الإرسال الفعلي مفعّل الآن');
    await refreshZatcaOnboardStatus();
  }catch(e){
    showToast('فشل الطلب: ' + (e.message||'خطأ غير معروف'));
  }finally{ btn.disabled = false; btn.textContent = 'طلب شهادة الإنتاج (PCSID)'; }
});

/* ---- فاتورة مبيعات يدوية: نموذج إضافة/تعديل ---- */
$('#btn-add-manual-sales')?.addEventListener('click', ()=>{
  editingManualSalesId = null;
  $('#manualsales-modal-title').textContent = 'فاتورة مبيعات يدوية جديدة';
  $('#ms-name').value = ''; $('#ms-clientid').value = ''; $('#ms-clienttax').value = '';
  $('#ms-desc').value = ''; $('#ms-date').value = (typeof todayISO==='function' ? todayISO() : new Date().toISOString().slice(0,10));
  $('#ms-total').value = ''; $('#ms-notes').value = '';
  $('#manualsales-overlay').classList.add('show');
});
$('#ms-cancel')?.addEventListener('click', ()=> $('#manualsales-overlay').classList.remove('show'));
$('#ms-save')?.addEventListener('click', async ()=>{
  const total = num($('#ms-total').value);
  const date = $('#ms-date').value;
  if(!date){ showToast('الرجاء اختيار تاريخ الفاتورة'); return; }
  if(total<=0){ showToast('الرجاء إدخال إجمالي صحيح للفاتورة'); return; }
  if(editingManualSalesId){
    const m = manualSalesInvoices.find(x=>x.id===editingManualSalesId);
    if(m){
      Object.assign(m, {
        name: $('#ms-name').value.trim(), clientId: $('#ms-clientid').value.trim(),
        clientTax: $('#ms-clienttax').value.trim(), description: $('#ms-desc').value.trim(),
        date, total, notes: $('#ms-notes').value.trim()
      });
    }
    await logAudit('edit','الفوترة الضريبية والزكاة', `تم تعديل فاتورة مبيعات يدوية رقم ${formatManualSalesInvoiceNo(m?.invoiceNo||0)}`);
  } else {
    const invoiceNo = settings.nextManualSalesInvoiceNo || 1;
    settings.nextManualSalesInvoiceNo = invoiceNo + 1;
    await saveSettings();
    const newSale = {
      id: uid(), invoiceNo,
      name: $('#ms-name').value.trim(), clientId: $('#ms-clientid').value.trim(),
      clientTax: $('#ms-clienttax').value.trim(), description: $('#ms-desc').value.trim(),
      date, total, notes: $('#ms-notes').value.trim(), createdAt: Date.now()
    };
    manualSalesInvoices.push(newSale);
    autoPostManualSale(newSale);
    await saveJournalDE();
    await logAudit('add','الفوترة الضريبية والزكاة', `تمت إضافة فاتورة مبيعات يدوية رقم ${formatManualSalesInvoiceNo(invoiceNo)}`);
  }
  await saveManualSalesInvoices();
  $('#manualsales-overlay').classList.remove('show');
  showToast('تم حفظ فاتورة المبيعات');
  renderZatca();
});
document.getElementById('zt-sales-body')?.addEventListener('click', async (e)=>{
  const printC = e.target.closest('[data-zt-print-course]');
  const printM = e.target.closest('[data-zt-print-manual]');
  const editM = e.target.closest('[data-zt-edit-manual]');
  const delM = e.target.closest('[data-zt-del-manual]');
  if(printC){ await printInvoice(printC.dataset.ztPrintCourse); return; }
  if(printM){ await printManualSalesInvoice(printM.dataset.ztPrintManual); return; }
  if(editM){
    const m = manualSalesInvoices.find(x=>x.id===editM.dataset.ztEditManual);
    if(!m) return;
    editingManualSalesId = m.id;
    $('#manualsales-modal-title').textContent = 'تعديل فاتورة مبيعات يدوية';
    $('#ms-name').value = m.name||''; $('#ms-clientid').value = m.clientId||''; $('#ms-clienttax').value = m.clientTax||'';
    $('#ms-desc').value = m.description||''; $('#ms-date').value = m.date||''; $('#ms-total').value = m.total||'';
    $('#ms-notes').value = m.notes||'';
    $('#manualsales-overlay').classList.add('show');
    return;
  }
  if(delM){
    const id = delM.dataset.ztDelManual;
    if(!(await customConfirm('هل تريد حذف فاتورة المبيعات اليدوية هذه؟ لا يمكن التراجع عن هذا الإجراء.'))) return;
    manualSalesInvoices = manualSalesInvoices.filter(x=>x.id!==id);
    await saveManualSalesInvoices();
    await logAudit('delete','الفوترة الضريبية والزكاة', 'تم حذف فاتورة مبيعات يدوية');
    showToast('تم حذف الفاتورة');
    renderZatca();
  }
});
document.getElementById('zt-returns-body')?.addEventListener('click', async (e)=>{
  const btn = e.target.closest('[data-zt-print-return]');
  if(btn) await printReturnInvoice(btn.dataset.ztPrintReturn);
});

/* يطبع فاتورة مبيعات يدوية بنفس تنسيق الفواتير الضريبية مع رمز QR متوافق مع الفوترة الإلكترونية المبسّطة */
async function printManualSalesInvoice(id){
  const m = manualSalesInvoices.find(x=>x.id===id);
  if(!m){ showToast('تعذر إيجاد بيانات الفاتورة'); return; }
  const invNoLabel = formatManualSalesInvoiceNo(m.invoiceNo||0);
  await logAudit('edit','الفوترة الضريبية والزكاة', `تمت طباعة فاتورة مبيعات يدوية رقم ${invNoLabel}`);

  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const totalInclVat = num(m.total);
  const vat = totalInclVat - (totalInclVat/1.15);
  const net = totalInclVat - vat;
  const today = new Date().toLocaleDateString('ar-SA');

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('فاتورة ' + invNoLabel, {accent: PRINT_PALETTE.gold, borderColor: PRINT_PALETTE.navy})}
  <body>
    <div class="inv-head">
      <div style="display:flex; gap:14px; align-items:center;">
        <img class="logo" src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
        <div>
          <p class="center-name">${escapeHtml(ci.name)}</p>
          <div class="center-meta">
            الرقم الضريبي: ${escapeHtml(ci.taxNumber)}<br>
            الهاتف: ${escapeHtml(ci.phone)}
          </div>
        </div>
      </div>
      ${zatcaInvoiceQrTag(ci, totalInclVat, vat, m.date || today)}
      <div class="inv-title">
        <h2>فاتورة ضريبية مبسّطة</h2>
        <div class="no">${invNoLabel}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">تاريخ الإصدار: ${escapeHtml(m.date || today)}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيانات العميل</h4>
        <div class="info-row"><span>الاسم:</span><b>${escapeHtml(m.name||'—')}</b></div>
        ${m.clientId ? `<div class="info-row"><span>رقم الهوية / السجل التجاري:</span><b>${escapeHtml(m.clientId)}</b></div>` : ''}
        ${m.clientTax ? `<div class="info-row"><span>الرقم الضريبي للعميل:</span><b>${escapeHtml(m.clientTax)}</b></div>` : ''}
      </div>
      <div class="info-box">
        <h4>بيانات الفاتورة</h4>
        <div class="info-row"><span>البيان:</span><b>${escapeHtml(m.description||'—')}</b></div>
        <div class="info-row"><span>ملاحظات:</span><b>${escapeHtml(m.notes||'—')}</b></div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>البيان</th><th style="text-align:left;">المبلغ (ر.س)</th></tr></thead>
      <tbody><tr><td>${escapeHtml(m.description||'مبيعات')}</td><td class="num">${fmt(net)}</td></tr></tbody>
    </table>

    <div class="totals">
      <div class="r"><span>القيمة الفعلية (بدون ضريبة القيمة المضافة)</span><b class="mono">${fmt(net)}</b></div>
      <div class="r"><span>ضريبة القيمة المضافة (15% مضمنة ضمن الإجمالي)</span><b class="mono">${fmt(vat)}</b></div>
      <div class="r grand"><span>الإجمالي (شامل الضريبة)</span><b>${fmt(totalInclVat)}</b></div>
    </div>
    <div style="margin:14px 0 22px; padding:12px 14px; border:1px solid #DDE3EA; border-radius:8px; background:#F7F9FB; font-size:12.5px; text-align:center;">
      <b>المبلغ كتابةً:</b> ${escapeHtml(numberToArabicWords(totalInclVat))}
    </div>

    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
  renderZatca();
}

/* ---- تصدير الإقرار الكامل (مبيعات + مردودات + مشتريات + ملخص + زكاة) إلى Excel ---- */
$('#btn-export-zatca')?.addEventListener('click', ()=>{
  const { year, from, to, asOf } = zatcaSelectedRange();
  const vat = buildZatcaVatReturn(from, to);
  const zk = computeZakat(asOf, year);
  const summaryRows = [
    {'البند':'إجمالي المبيعات شامل الضريبة', 'القيمة':vat.salesGross},
    {'البند':'مردودات المبيعات شامل الضريبة', 'القيمة':vat.returnsGross},
    {'البند':'صافي ضريبة المخرجات', 'القيمة':vat.outputVat},
    {'البند':'إجمالي المشتريات شامل الضريبة', 'القيمة':vat.purchasesGross},
    {'البند':'إجمالي ضريبة المدخلات', 'القيمة':vat.inputVat},
    {'البند': vat.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة', 'القيمة':Math.abs(vat.netVat)},
    {'البند':'وعاء الزكاة التقديري', 'القيمة':zk.base},
    {'البند':`الزكاة المستحقة (${(zk.rate*100).toFixed(3)}%)`, 'القيمة':zk.due},
  ];
  const salesDetail = vat.salesRows.map(r=>({'التاريخ':r.date||'', 'العميل':r.name||'', 'رقم الفاتورة':r.invoiceNo||'', 'المصدر': r.source==='course'?'فاتورة دورة':'يدوية', 'الإجمالي شامل الضريبة':r.totalInclVat, 'الضريبة':r.vat}));
  const returnsDetail = vat.returnRows.map(r=>({'التاريخ':r.date||'', 'العميل':r.name||'', 'المبلغ':r.amount, 'الضريبة':r.vat}));
  const purchasesDetail = vat.purchaseRows.map(r=>({'التاريخ':r.date||'', 'المورد':r.supplierName||'', 'رقم الفاتورة':r.invoiceNo||'', 'الإجمالي شامل الضريبة':r.total, 'الضريبة':r.vat}));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'الملخص');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salesDetail), 'فواتير المبيعات');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(returnsDetail), 'مردودات المبيعات');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(purchasesDetail), 'المشتريات');
  XLSX.writeFile(wb, `الإقرار_الضريبي_والزكاة_${from}_${to}.xlsx`);
});

/* ---------------- قائمة "العملاء" المنسدلة لأنواع الدورات ----------------
   تظهر بجانب زر "العملاء" في القائمة الجانبية وتسرد أنواع الدورات المعرَّفة في الإعدادات (settings.courses)؛
   الضغط على أي نوع دورة ينقل لتبويب العملاء مباشرة ويطبّق فلتر "نوع الدورة" على هذا النوع تحديداً. */
const clientsFlyoutWrap = $('#nav-clients-flyout');
const clientsCaretBtn = $('#btn-clients-courses-toggle');
const clientsCourseSubmenu = $('#clients-courses-submenu');

function closeClientsCourseSubmenu(){
  clientsCourseSubmenu?.classList.remove('show');
  clientsFlyoutWrap?.classList.remove('open');
  clientsCaretBtn?.setAttribute('aria-expanded','false');
}
function renderClientsCourseSubmenu(){
  if(!clientsCourseSubmenu) return;
  const courses = settings.courses || [];
  const currentVal = $('#filter-course') ? $('#filter-course').value : '';
  const isActive = (v)=> v===currentVal ? ' class="active-course-filter" aria-current="true"' : '';
  let html = `<button type="button" data-course-filter=""${isActive('')}>كل الدورات</button>`;
  if(courses.length){
    html += courses.map(c=>`<button type="button" data-course-filter="${escapeHtml(c.name)}"${isActive(c.name)}>${escapeHtml(c.name)}</button>`).join('');
  } else {
    html += `<div class="nav-submenu-empty">لا توجد أنواع دورات معرَّفة بعد</div>`;
  }
  clientsCourseSubmenu.innerHTML = html;
}
clientsCaretBtn?.addEventListener('click', (e)=>{
  e.stopPropagation();
  const wasOpen = clientsCourseSubmenu?.classList.contains('show');
  closeClientsCourseSubmenu();
  if(!wasOpen){
    renderClientsCourseSubmenu();
    clientsCourseSubmenu.classList.add('show');
    clientsFlyoutWrap.classList.add('open');
    clientsCaretBtn.setAttribute('aria-expanded','true');
    // في وضع سطح المكتب: nav.tabs عنده overflow-x:auto (للتمرير الأفقي)، وهذا كان يُقصّ القائمة
    // المنسدلة (position:absolute) عند حدود الشريط فتظهر "داخل الصندوق" بدل التحليق فوق كل شيء.
    // الحل: نحوّلها لـ position:fixed ونحسب موضعها فعلياً بالنسبة للشاشة (خارج أي تأثير overflow)
    // — فقط في سطح المكتب، لأن وضع الجوال أصلاً معالج بشكل منفصل وصحيح عبر CSS (bottom sheet).
    if(window.innerWidth > 900){
      const r = clientsCaretBtn.getBoundingClientRect();
      clientsCourseSubmenu.style.position = 'fixed';
      clientsCourseSubmenu.style.top = (r.bottom + 8) + 'px';
      clientsCourseSubmenu.style.right = (window.innerWidth - r.right) + 'px';
      clientsCourseSubmenu.style.left = 'auto';
    }else{
      clientsCourseSubmenu.style.position = '';
      clientsCourseSubmenu.style.top = '';
      clientsCourseSubmenu.style.right = '';
      clientsCourseSubmenu.style.left = '';
    }
  }
});
clientsCourseSubmenu?.addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-course-filter]');
  if(!btn) return;
  const courseName = btn.dataset.courseFilter;
  document.querySelector('nav.tabs button[data-view="clients"]')?.click();
  const sel = $('#filter-course');
  if(sel) sel.value = courseName;
  renderTable();
  closeClientsCourseSubmenu();
});
document.addEventListener('click', (e)=>{
  if(clientsCourseSubmenu?.classList.contains('show') && !clientsFlyoutWrap.contains(e.target)) closeClientsCourseSubmenu();
});
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeClientsCourseSubmenu(); });

