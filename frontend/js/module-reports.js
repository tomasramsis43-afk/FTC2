/* ---------------- Reports ---------------- */
function allTimeTotals(){
  const income = vaultTx.filter(t=>t.type==='in' && vaultTxCountsTowardBalance(t)).reduce((s,t)=>s+num(t.amount),0);
  const expense = vaultTx.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const totalRemaining = clients.filter(c=>!c.suspended && !c.cancelled).reduce((s,c)=>s+remaining(c),0);
  const {purchasedQty, spentBulk} = bagStockTotals();
  const purchasedBuy = clients.filter(c=>c.bagSource==='buy' && c.bagStatus==='purchased' && !c.suspended);
  const spentDirect = purchasedBuy.reduce((s,c)=>s+num(c.bagPrice),0);
  const bagSpent = spentBulk + spentDirect;
  const bagCollected = clients.filter(c=>!c.suspended).reduce((s,c)=>s+bagAmount(c),0);
  return {income, expense, net: income-expense, totalRemaining, bagSpent, bagCollected};
}
function renderBudget(){
  const t = allTimeTotals();
  $('#budget-cards').innerHTML = `
    <div class="card"><div class="k">إجمالي الإيرادات (كل الفترة)</div><div class="v teal">${fmt(t.income)}</div></div>
    <div class="card"><div class="k">إجمالي المصروفات (كل الفترة)</div><div class="v red">${fmt(t.expense)}</div></div>
    <div class="card"><div class="k">صافي الربح / الخسارة</div><div class="v ${t.net<0?'red':'gold'}">${fmt(t.net)}</div></div>
    <div class="card"><div class="k">رصيد الخزنة (كاش)</div><div class="v ${balanceOf('vault')<0?'red':''}">${fmt(balanceOf('vault'))}</div></div>
    <div class="card"><div class="k">رصيد البنك</div><div class="v ${balanceOf('bank')<0?'red':'teal'}">${fmt(balanceOf('bank'))}</div></div>
    <div class="card"><div class="k">رصيد الشبكة</div><div class="v ${balanceOf('network')<0?'red':'gold'}">${fmt(balanceOf('network'))}</div></div>
    <div class="card"><div class="k">إجمالي المتبقي على العملاء (ذمم)</div><div class="v red">${fmt(t.totalRemaining)}</div></div>
    <div class="card"><div class="k">عدد العملاء المسجّلين إجمالاً</div><div class="v">${clients.length}</div></div>
    <div class="card"><div class="k">حصيلة الحقائب من العملاء</div><div class="v">${fmt(t.bagCollected)}</div></div>
    <div class="card"><div class="k">إجمالي المصروف على الحقائب</div><div class="v gold">${fmt(t.bagSpent)}</div></div>
  `;
}
function periodFilteredVaultTx(){
  const from = $('#rp-from').value;
  const to = $('#rp-to').value;
  return vaultTx.filter(t=>{
    if(from && (t.date||'') < from) return false;
    if(to && (t.date||'') > to) return false;
    return true;
  });
}
function clientsInPeriod(){
  const from = $('#rp-from').value;
  const to = $('#rp-to').value;
  return clients.filter(c=>{
    const d = c.date || '';
    if(from && d < from) return false;
    if(to && d > to) return false;
    return true;
  });
}
/* ============ ربحية الدورات حسب النوع (تقديرية) ============ */
function courseProfitabilityData(){
  const activeClients = clients.filter(c=>!c.cancelled && !c.suspended);
  const revByType = {}, countByType = {};
  activeClients.forEach(c=>{
    const t = c.courseType || 'غير محدد';
    revByType[t] = (revByType[t]||0) + centerIncome(c);
    countByType[t] = (countByType[t]||0) + 1;
  });
  const totalRev = Object.values(revByType).reduce((a,b)=>a+b,0);
  const totalExpenses = vaultTx.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  return Object.entries(revByType).map(([type, rev])=>{
    const share = totalRev>0 ? rev/totalRev : 0;
    const allocExpense = totalExpenses * share;
    const profit = rev - allocExpense;
    const margin = rev>0 ? (profit/rev*100) : 0;
    return { type, rev, allocExpense, profit, margin, count: countByType[type]||0 };
  }).sort((a,b)=>b.profit-a.profit);
}
function renderCourseProfitability(){
  const tbody = $('#course-profit-body');
  if(!tbody) return;
  const rows = courseProfitabilityData();
  tbody.innerHTML = rows.map(r=> `<tr>
    <td>${escapeHtml(r.type)}</td>
    <td class="mono">${r.count}</td>
    <td class="mono">${fmt(r.rev)}</td>
    <td class="mono">${fmt(r.allocExpense)}</td>
    <td class="mono" style="color:${r.profit>=0?'var(--teal)':'var(--red)'};">${fmt(r.profit)}</td>
    <td class="mono">${fmt(r.margin)}%</td>
  </tr>`).join('') || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد بيانات كافية</td></tr>`;
}

/* ============ تقرير أعمار الديون (Aging / Collections) ============ */
function agingBuckets(){
  const buckets = {b0_30:[], b31_60:[], b61_90:[], b90p:[]};
  clients.filter(c=>!c.suspended && !c.cancelled && remaining(c)>0).forEach(c=>{
    const days = daysSinceDate(c.date);
    const r = remaining(c);
    const entry = {c, r, days};
    if(days<=30) buckets.b0_30.push(entry);
    else if(days<=60) buckets.b31_60.push(entry);
    else if(days<=90) buckets.b61_90.push(entry);
    else buckets.b90p.push(entry);
  });
  return buckets;
}
function renderAgingReport(){
  const cardsEl = $('#aging-summary-cards');
  const tbody = $('#aging-table-body');
  if(!cardsEl && !tbody) return;
  const b = agingBuckets();
  const sumOf = arr => arr.reduce((s,x)=>s+x.r,0);
  if(cardsEl){
    cardsEl.innerHTML = `
      <div class="card"><div class="k">0-30 يوم</div><div class="v">${fmt(sumOf(b.b0_30))}</div></div>
      <div class="card"><div class="k">31-60 يوم</div><div class="v gold">${fmt(sumOf(b.b31_60))}</div></div>
      <div class="card"><div class="k">61-90 يوم</div><div class="v gold">${fmt(sumOf(b.b61_90))}</div></div>
      <div class="card"><div class="k">أكثر من 90 يوم</div><div class="v red">${fmt(sumOf(b.b90p))}</div></div>
    `;
  }
  if(tbody){
    const all = [...b.b0_30, ...b.b31_60, ...b.b61_90, ...b.b90p].sort((x,y)=>y.days-x.days);
    tbody.innerHTML = all.map(x=> `<tr>
      <td>${escapeHtml(x.c.name||'')}</td>
      <td>${escapeHtml(x.c.phone||'')}</td>
      <td>${escapeHtml(x.c.date||'')}</td>
      <td class="mono">${x.days}</td>
      <td class="mono" style="color:${x.days>90?'var(--red)':''};">${fmt(x.r)}</td>
    </tr>`).join('') || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد ذمم متبقية 🎉</td></tr>`;
  }
}

/* ============ التقرير الشهري عبر واتساب ============ */
function lastCompleteMonthKey(){
  // الشهر المكتمل: الشهر السابق للشهر الحالي، محسوباً بالتوقيت المحلي (وليس UTC).
  // toISOString() هنا كان يُزيح التاريخ للتوقيت العالمي (+3 في السعودية) فيُرجع الشهر
  // الحالي بدل السابق في الساعات الأولى من اليوم.
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
  const prev = m === 0 ? [y-1, 11] : [y, m-1];
  return `${prev[0]}-${String(prev[1]+1).padStart(2,'0')}`;
}
function monthSummaryData(key){
  const income = vaultTx.filter(t=>t.type==='in' && (t.date||'').slice(0,7)===key).reduce((s,t)=>s+num(t.amount),0);
  const expense = vaultTx.filter(t=>t.type==='out' && (t.date||'').slice(0,7)===key).reduce((s,t)=>s+num(t.amount),0);
  const regCount = clients.filter(c=>!c.suspended && (c.date||'').slice(0,7)===key).length;
  const byType = {};
  clients.filter(c=>!c.cancelled && (c.date||'').slice(0,7)===key).forEach(c=>{
    const t = c.courseType || 'غير محدد';
    byType[t] = (byType[t]||0) + centerIncome(c);
  });
  const topType = Object.entries(byType).sort((a,b)=>b[1]-a[1])[0] || null;
  const totalOutstanding = clients.filter(c=>!c.suspended && !c.cancelled).reduce((s,c)=>s+remaining(c),0);
  return { key, income, expense, net: income-expense, regCount, topType, totalOutstanding };
}
function monthSummaryText(key){
  const d = monthSummaryData(key);
  const label = monthLabelAr(key);
  const centerName = (settings.centerInfo && settings.centerInfo.name) || '';
  let text = `📊 ملخص ${label}${centerName?' — '+centerName:''}\n\n`;
  text += `👥 عدد التسجيلات: ${d.regCount}\n`;
  text += `💵 إجمالي الإيرادات: ${fmt(d.income)}\n`;
  text += `💸 إجمالي المصروفات: ${fmt(d.expense)}\n`;
  text += `📈 الصافي: ${fmt(d.net)}\n`;
  if(d.topType) text += `🏆 الأعلى تسجيلاً: ${d.topType[0]}\n`;
  text += `⏳ إجمالي الذمم المتبقية على العملاء (تراكمي حتى الآن): ${fmt(d.totalOutstanding)}\n`;
  return text;
}
function waLink(phone, text){
  const clean = (phone||'').replace(/[^\d]/g,'');
  return `https://wa.me/${clean}?text=${encodeURIComponent(text)}`;
}
function sendMonthlyReportWhatsapp(key){
  if(!settings.monthlyReportWhatsapp){
    showToast('يرجى إدخال رقم واتساب المستلم من الإعدادات أولاً');
    return;
  }
  const text = monthSummaryText(key);
  window.open(waLink(settings.monthlyReportWhatsapp, text), '_blank');
}
if($('#wa-report-month')) $('#wa-report-month').value = lastCompleteMonthKey();
$('#btn-send-monthly-wa')?.addEventListener('click', ()=>{
  const key = $('#wa-report-month').value;
  if(!key){ showToast('اختر الشهر أولاً'); return; }
  sendMonthlyReportWhatsapp(key);
});

/* ============ 4 تقارير PDF شهرية منفصلة عبر مشاركة الجوال (واتساب) ============
   يولّد كل تقرير كملف PDF حقيقي على جهاز المستخدم (بدون أي سيرفر) عبر html2canvas + jsPDF،
   ثم يفتح قائمة المشاركة الأصلية بالجوال (Web Share API) مع الملفات الأربعة مرفقة تلقائياً.
   ملاحظة مهمة: لا يوجد أي رابط أو API يسمح بإرسال ملفات لواتساب تلقائياً بالكامل من صفحة ويب
   عادية بدون تدخل المستخدم — أقصى شي ممكن هو فتح قائمة المشاركة وعلى المستخدم اختيار واتساب
   والضغط "إرسال". على الأجهزة/المتصفحات التي لا تدعم مشاركة الملفات، تُنزَّل الملفات الأربعة
   مباشرة ليرفقها المستخدم يدوياً. */

/* عرض التقرير داخل iframe مخفي خارج الشاشة لالتقاطه بـ html2canvas دون التأثير على واجهة المستخدم */
function renderReportToOffscreenIframe(fullHtml){
  return new Promise((resolve, reject)=>{
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed; top:-10000px; left:-10000px; width:900px; height:10px; border:0; background:#fff;';
    iframe.onload = ()=> resolve(iframe);
    iframe.onerror = ()=> reject(new Error('تعذّر تحضير التقرير'));
    document.body.appendChild(iframe);
    iframe.srcdoc = fullHtml;
  });
}
/* تحويل محتوى HTML لتقرير (نفس تنسيق تقارير الطباعة الحالية) إلى ملف PDF حقيقي متعدد الصفحات عند اللزوم */
async function htmlBodyToPdfFile(bodyHtml, {title, filename, variant='table', accent, borderColor, amountColor} = {}){
  if(typeof html2canvas==='undefined' || !window.jspdf){
    throw new Error('مكتبة توليد PDF غير متوفرة (تحقق من الاتصال بالإنترنت)');
  }
  const fullHtml = `${printDocHead(title, {variant, accent, borderColor, amountColor})}<body>${bodyHtml}</body></html>`;
  const iframe = await renderReportToOffscreenIframe(fullHtml);
  try{
    await new Promise(r=> setTimeout(r, 200)); // مهلة قصيرة لضبط التخطيط قبل الالتقاط
    const doc = iframe.contentDocument;
    const canvas = await html2canvas(doc.body, {
      scale:2, backgroundColor:'#ffffff', useCORS:true,
      windowWidth: doc.documentElement.scrollWidth, windowHeight: doc.documentElement.scrollHeight,
    });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p','mm','a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = canvas.height * imgWidth / canvas.width;
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    let heightLeft = imgHeight, position = 0;
    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while(heightLeft > 0){
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }
    const blob = pdf.output('blob');
    return new File([blob], filename, {type:'application/pdf'});
  } finally {
    iframe.remove();
  }
}
/* تقرير الإقرار الضريبي كمستند مستقل (بدل الاعتماد على جدول معروض بالشاشة، حتى يعمل لأي شهر مباشرة) */
function vatReturnReportBodyHtml(r, from, to, monthLabel){
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const row = (label, value, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:1px solid #D8DEE6;':(opts&&opts.muted?'color:#66707E;':'')}"><td style="${opts&&opts.indent?'padding-right:22px;':''}">${label}</td><td class="mono" style="text-align:left;">${fmt(value)}</td></tr>`;
  const summaryHtml = `<table><tbody>
    <tr><td colspan="2" style="padding-top:14px; font-weight:800;">المبيعات (ضريبة المخرجات) — ${r.salesRows.length} فاتورة${r.returnRows.length?` · ${r.returnRows.length} مردود`:''}</td></tr>
    ${row('إجمالي المبيعات شامل الضريبة', r.salesGross, {indent:true, muted:true})}
    ${row('يُخصم: مردودات مبيعات (شامل الضريبة)', -r.returnsGross, {indent:true, muted:true})}
    ${row('إجمالي المبيعات بدون الضريبة (بعد المردودات)', r.salesNet, {indent:true, muted:true})}
    ${row('صافي ضريبة المخرجات (15%)', r.outputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px; font-weight:800;">المشتريات (ضريبة المدخلات) — ${r.purchaseRows.length} فاتورة</td></tr>
    ${row('إجمالي المشتريات شامل الضريبة', r.purchasesGross, {indent:true, muted:true})}
    ${row('إجمالي المشتريات بدون الضريبة', r.purchasesNet, {indent:true, muted:true})}
    ${row('إجمالي ضريبة المدخلات (15%)', r.inputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px;"></td></tr>
    ${row(r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', Math.abs(r.netVat), {bold:true})}
  </tbody></table>`;
  return `
    <div class="head">
      <div><h2>الإقرار الضريبي (ضريبة القيمة المضافة)</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)} — ${escapeHtml(monthLabel)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">عن الفترة: ${escapeHtml(formatDateDisplay(from))} إلى ${escapeHtml(formatDateDisplay(to))}<br>تاريخ الطباعة: ${escapeHtml(today)}</div>
    ${summaryHtml}
    ${buildVatBoxesTableHtml(r)}
    ${buildVatDetailTablesHtml(r)}`;
}
/* تقرير الحركات المالية الصادرة خلال الشهر، باستثناء ما يخص تمويل/شراء مخزون الحقائب */
function vaultOutReportBodyHtml(from, to, monthLabel){
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const rows = vaultTx.filter(t=> t.type==='out' && !t.isReturn && inRange(t.date, from, to) && !String(t.category||'').includes('حقائب'))
    .sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  const total = rows.reduce((s,t)=>s+num(t.amount),0);
  const rowsHtml = rows.length ? rows.map(t=>`
    <tr>
      <td class="mono">${escapeHtml(formatDateDisplay(t.date)||t.date||'—')}</td>
      <td>${escapeHtml(t.category||'—')}</td>
      <td>${escapeHtml(t.notes||'—')}</td>
      <td>${escapeHtml(t.method||'—')}</td>
      <td>${escapeHtml(t.recipientName||'—')}</td>
      <td class="mono">${fmt(num(t.amount))}</td>
    </tr>`).join('') : `<tr><td colspan="6" style="text-align:center; color:#8A94A3; padding:16px;">لا توجد حركات صادرة في هذا الشهر</td></tr>`;
  return `
    <div class="head">
      <div><h2>الحركات المالية الصادرة</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)} — ${escapeHtml(monthLabel)} (عدا ما يخص تمويل/شراء الحقائب)</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">الفترة: ${escapeHtml(formatDateDisplay(from))} إلى ${escapeHtml(formatDateDisplay(to))}<br>تاريخ الطباعة: ${escapeHtml(today)}</div>
    <table>
      <thead><tr><th>التاريخ</th><th>التصنيف</th><th>ملاحظات</th><th>طريقة الدفع</th><th>مستلم المبلغ</th><th>المبلغ</th></tr></thead>
      <tbody>
        ${rowsHtml}
        <tr style="font-weight:800; background:#F1F4F7;"><td colspan="5">الإجمالي (${rows.length} حركة)</td><td class="mono">${fmt(total)}</td></tr>
      </tbody>
    </table>`;
}
/* تقرير الحقائب المشتراة خلال الشهر: قسمان — حقائب أضافها المركز للمخزون، وحقائب اشتراها العملاء مباشرة */
function bagsPurchasedReportBodyHtml(from, to, monthLabel){
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const stockRows = bagStock.filter(b=> b.type!=='issue' && b.date && b.date>=from && b.date<=to)
    .sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  const stockQtyTotal = stockRows.reduce((s,b)=> s+num(b.qty), 0);
  const stockTypeLabel = b => (b.type==='withdraw' ? 'سحب' : (b.type==='deposit' ? 'إيداع' : 'إضافة يدوية')) + (b.manualQty ? ' (عدد فعلي)' : '');
  const stockRowsHtml = stockRows.length ? stockRows.map(b=>`
    <tr>
      <td class="mono">${escapeHtml(formatDateDisplay(b.date)||b.date||'—')}</td>
      <td>${escapeHtml(stockTypeLabel(b))}</td>
      <td class="mono">${fmt(num(b.amount!==undefined?b.amount:num(b.qty)*num(b.unitPrice)))}</td>
      <td class="mono">${num(b.qty)>0?'+':''}${num(b.qty)}</td>
      <td>${escapeHtml(b.method||'—')}</td>
    </tr>`).join('') : `<tr><td colspan="5" style="text-align:center; color:#8A94A3; padding:16px;">لا توجد عمليات إضافة لمخزون الحقائب في هذا الشهر</td></tr>`;

  const clientRows = clients.filter(c=> ((c.bagSource==='buy' && c.bagStatus==='purchased') || c.bagSource==='stock') && !c.suspended)
    .map(c=>({ c, purchaseDate: c.bagPurchaseDate || (c.bagSource==='stock' ? c.date : '') }))
    .filter(r=> r.purchaseDate && r.purchaseDate>=from && r.purchaseDate<=to)
    .sort((a,b)=> (a.purchaseDate||'').localeCompare(b.purchaseDate||''));
  const clientValueTotal = clientRows.reduce((s,{c})=>s+num(c.bagPrice),0);
  const clientRowsHtml = clientRows.length ? clientRows.map(({c,purchaseDate})=>`
    <tr>
      <td>${escapeHtml(c.name||'—')}</td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td class="mono">${escapeHtml(c.phone||'—')}</td>
      <td class="mono">${escapeHtml(c.bagInvoice||'—')}</td>
      <td class="mono">${escapeHtml(formatDateDisplay(purchaseDate)||purchaseDate||'—')}</td>
      <td>${c.bagSource==='stock' ? 'من المخزون' : 'شراء مباشر'}</td>
      <td class="mono">${fmt(num(c.bagPrice))}</td>
    </tr>`).join('') : `<tr><td colspan="7" style="text-align:center; color:#8A94A3; padding:16px;">لا توجد حقائب اشتراها عملاء في هذا الشهر</td></tr>`;

  return `
    <div class="head">
      <div><h2>الحقائب المشتراة</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)} — ${escapeHtml(monthLabel)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">الفترة: ${escapeHtml(formatDateDisplay(from))} إلى ${escapeHtml(formatDateDisplay(to))}<br>تاريخ الطباعة: ${escapeHtml(today)}</div>
    <h3 style="margin:18px 0 8px;">أولاً: حقائب أضافها المركز للمخزون (تمويل/شراء)</h3>
    <table>
      <thead><tr><th>التاريخ</th><th>نوع العملية</th><th>المبلغ</th><th>عدد الحقائب (+/-)</th><th>طريقة الدفع</th></tr></thead>
      <tbody>
        ${stockRowsHtml}
        <tr style="font-weight:800; background:#F1F4F7;"><td colspan="3">إجمالي عدد الحقائب المضافة للمخزون</td><td class="mono">${stockQtyTotal>0?'+':''}${stockQtyTotal}</td><td></td></tr>
      </tbody>
    </table>
    <h3 style="margin:22px 0 8px;">ثانياً: عملاء اشتروا حقائبهم (مباشرة أو من المخزون)</h3>
    <table>
      <thead><tr><th>الاسم</th><th>رقم الهوية</th><th>رقم الهاتف</th><th>رقم فاتورة الحقيبة</th><th>تاريخ الشراء</th><th>المصدر</th><th>القيمة</th></tr></thead>
      <tbody>
        ${clientRowsHtml}
        <tr style="font-weight:800; background:#F1F4F7;"><td colspan="6">الإجمالي (${clientRows.length} عميل)</td><td class="mono">${fmt(clientValueTotal)}</td></tr>
      </tbody>
    </table>`;
}
/* ---------- 3 تقارير شهرية (تسجيلات ومبالغ / الحركات الصادرة / الحقائب المشتراة) ---------- */
async function generateAndShareThreeMonthlyReports(yearMonth){
  const statusEl = $('#wa3-report-status');
  const setStatus = msg => { if(statusEl) statusEl.textContent = msg; };
  const [yStr, mStr] = yearMonth.split('-');
  const from = `${yStr}-${mStr}-01`;
  const daysInMonth = new Date(Number(yStr), Number(mStr), 0).getDate();
  const to = `${yStr}-${mStr}-${String(daysInMonth).padStart(2,'0')}`;
  const monthLabel = monthLabelAr(yearMonth);
  const btn = $('#btn-send-3-reports-wa');

  if(typeof html2canvas==='undefined' || !window.jspdf){
    setStatus('❌ لم تُحمَّل مكتبة توليد PDF بعد (تحقق من اتصال الإنترنت وأعد فتح الصفحة).');
    showToast('تعذّر تحميل مكتبة توليد PDF — تحقق من الاتصال بالإنترنت وأعد المحاولة');
    return;
  }
  if(btn) btn.disabled = true;
  setStatus('⏳ جارٍ توليد التقارير الثلاثة... قد يستغرق بضع ثوانٍ');
  showToast('جارٍ توليد التقارير...');
  try{
    const files = [];
    setStatus('⏳ (١/٣) تقرير التسجيلات والمبالغ...');
    files.push(await htmlBodyToPdfFile(monthlyClientsReportBodyHtml(yearMonth), {title:'تقرير شهري — '+monthLabel, filename:`تقرير_شهري_تسجيلات_ومبالغ_${yearMonth}.pdf`}));
    setStatus('⏳ (٢/٣) الحركات المالية الصادرة...');
    files.push(await htmlBodyToPdfFile(vaultOutReportBodyHtml(from, to, monthLabel), {title:'الحركات المالية الصادرة', filename:`الحركات_الصادرة_${yearMonth}.pdf`}));
    setStatus('⏳ (٣/٣) الحقائب المشتراة...');
    files.push(await htmlBodyToPdfFile(bagsPurchasedReportBodyHtml(from, to, monthLabel), {title:'الحقائب المشتراة', filename:`الحقائب_المشتراة_${yearMonth}.pdf`}));

    downloadFilesAndOpenWhatsapp(files, settings.monthlyPdfReportsWhatsappNumbers,
      `تقارير ${monthLabel} — مرفقة 3 ملفات PDF (تسجيلات ومبالغ، الحركات الصادرة، الحقائب المشتراة). يرجى إرفاقها من مجلد التنزيلات.`,
      setStatus, 'الملفات الثلاثة');
  }catch(e){
    console.error(e);
    setStatus('❌ حدث خطأ أثناء توليد التقارير: ' + (e.message||e));
    showToast('تعذّر توليد التقارير، حاول مجدداً');
  } finally {
    if(btn) btn.disabled = false;
  }
}
if($('#wa3-report-month')) $('#wa3-report-month').value = lastCompleteMonthKey();
$('#btn-send-3-reports-wa')?.addEventListener('click', ()=>{
  const val = $('#wa3-report-month').value;
  if(!val){ showToast('اختر الشهر أولاً'); return; }
  generateAndShareThreeMonthlyReports(val);
});

/* ---------- الإقرار الضريبي (ضريبة القيمة المضافة) — تقرير مستقل كل ربع سنة ---------- */
function quarterDateRange(year, quarter){
  const q = Number(quarter);
  const startMonth = (q-1)*3 + 1; // 1,4,7,10
  const endMonth = startMonth + 2; // 3,6,9,12
  const from = `${year}-${String(startMonth).padStart(2,'0')}-01`;
  const daysInEndMonth = new Date(Number(year), endMonth, 0).getDate();
  const to = `${year}-${String(endMonth).padStart(2,'0')}-${String(daysInEndMonth).padStart(2,'0')}`;
  const qLabels = {1:'الربع الأول (يناير–مارس)', 2:'الربع الثاني (أبريل–يونيو)', 3:'الربع الثالث (يوليو–سبتمبر)', 4:'الربع الرابع (أكتوبر–ديسمبر)'};
  return { from, to, label: `${qLabels[q]} ${year}` };
}
async function generateAndShareVatReport(year, quarter){
  const statusEl = $('#vat-report-status');
  const setStatus = msg => { if(statusEl) statusEl.textContent = msg; };
  const { from, to, label } = quarterDateRange(year, quarter);
  const btn = $('#btn-send-vat-report-wa');

  if(typeof html2canvas==='undefined' || !window.jspdf){
    setStatus('❌ لم تُحمَّل مكتبة توليد PDF بعد (تحقق من اتصال الإنترنت وأعد فتح الصفحة).');
    showToast('تعذّر تحميل مكتبة توليد PDF — تحقق من الاتصال بالإنترنت وأعد المحاولة');
    return;
  }
  if(btn) btn.disabled = true;
  setStatus('⏳ جارٍ توليد الإقرار الضريبي...');
  showToast('جارٍ توليد الإقرار الضريبي...');
  try{
    const vatReturn = buildVatReturn(from, to);
    const file = await htmlBodyToPdfFile(vatReturnReportBodyHtml(vatReturn, from, to, label), {title:'الإقرار الضريبي — '+label, filename:`الإقرار_الضريبي_${year}_ر${quarter}.pdf`});
    downloadFilesAndOpenWhatsapp([file], settings.vatPdfReportWhatsappNumbers,
      `الإقرار الضريبي (ضريبة القيمة المضافة) — ${label}. يرجى إرفاق الملف من مجلد التنزيلات.`,
      setStatus, 'ملف الإقرار الضريبي');
  }catch(e){
    console.error(e);
    setStatus('❌ حدث خطأ أثناء توليد الإقرار الضريبي: ' + (e.message||e));
    showToast('تعذّر توليد الإقرار الضريبي، حاول مجدداً');
  } finally {
    if(btn) btn.disabled = false;
  }
}
$('#btn-send-vat-report-wa')?.addEventListener('click', ()=>{
  const year = Number($('#vat-report-year').value);
  const quarter = Number($('#vat-report-quarter').value);
  if(!year || !quarter){ showToast('اختر السنة والربع أولاً'); return; }
  generateAndShareVatReport(year, quarter);
});

/* دالة مشتركة: تنزيل ملف/ملفات PDF على الجهاز، ثم فتح محادثة واتساب لكل رقم محفوظ */
function downloadFilesAndOpenWhatsapp(files, numbersRaw, waText, setStatus, filesLabel){
  files.forEach(f=>{
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  showToast(`تم تنزيل ${filesLabel} لجهازك`);
  const numbers = (numbersRaw||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(numbers.length){
    setStatus(`✅ تم تنزيل ${filesLabel}. جارٍ فتح محادثة واتساب لـ ${numbers.length} رقم — أرفق الملفات من مجلد التنزيلات في كل محادثة ثم أرسل.`);
    numbers.forEach((num, i)=>{
      setTimeout(()=>{ window.open(waLink(num, waText), '_blank'); }, i*700);
    });
  } else {
    setStatus(`✅ تم تنزيل ${filesLabel}. لم تُحفظ أي أرقام واتساب — أضف رقماً أو أكثر أعلاه لفتح محادثة واتساب تلقائياً في المرة القادمة، أو افتح واتساب وأرفقها يدوياً الآن.`);
    showToast('لم تُحفظ أي أرقام واتساب — أرفق الملفات المنزَّلة يدوياً في واتساب');
  }
}

/* ============ مقارنة سنة بسنة (Year-over-Year) ============ */
function yoyAvailableYears(){
  const years = new Set();
  clients.forEach(c=>{ const y = (c.date||'').slice(0,4); if(y) years.add(Number(y)); });
  vaultTx.forEach(t=>{ const y = (t.date||'').slice(0,4); if(y) years.add(Number(y)); });
  years.add(new Date().getFullYear());
  return [...years].sort((a,b)=>b-a);
}
function yoyData(year){
  const rows = [];
  for(let m=1;m<=12;m++){
    const key = `${year}-${String(m).padStart(2,'0')}`;
    const prevKey = `${year-1}-${String(m).padStart(2,'0')}`;
    const cur = monthSummaryData(key);
    const prev = monthSummaryData(prevKey);
    const growth = prev.income>0 ? ((cur.income-prev.income)/prev.income*100) : (cur.income>0 ? null : 0);
    rows.push({ label: MONTH_NAMES_AR_SHORT[m-1], curIncome: cur.income, prevIncome: prev.income, growth, curReg: cur.regCount, prevReg: prev.regCount });
  }
  return rows;
}
function renderYoY(){
  const yearSel = $('#yoy-year');
  const tbody = $('#yoy-table-body');
  if(!yearSel || !tbody) return;
  if(!yearSel.dataset.filled){
    yearSel.innerHTML = yoyAvailableYears().map(y=>`<option value="${y}">${y}</option>`).join('');
    yearSel.dataset.filled = '1';
  }
  const year = Number(yearSel.value || new Date().getFullYear());
  const rows = yoyData(year);
  tbody.innerHTML = rows.map(r=> `<tr>
    <td>${r.label}</td>
    <td class="mono">${fmt(r.curIncome)}</td>
    <td class="mono">${fmt(r.prevIncome)}</td>
    <td class="mono" style="color:${r.growth===null?'':(r.growth>=0?'var(--teal)':'var(--red)')};">${r.growth===null?'—':fmt(r.growth)+'%'}</td>
    <td class="mono">${r.curReg}</td>
    <td class="mono">${r.prevReg}</td>
  </tr>`).join('');
}
$('#yoy-year')?.addEventListener('change', renderYoY);
$('#btn-export-yoy')?.addEventListener('click', ()=>{
  const year = Number($('#yoy-year').value || new Date().getFullYear());
  const rows = yoyData(year).map(r=>({
    'الشهر': r.label, [`إيراد ${year}`]: r.curIncome, [`إيراد ${year-1}`]: r.prevIncome,
    'نسبة النمو %': r.growth===null?'':Math.round(r.growth*100)/100,
    [`تسجيلات ${year}`]: r.curReg, [`تسجيلات ${year-1}`]: r.prevReg
  }));
  downloadXlsx(`مقارنة_سنوية_${year}.xlsx`, 'مقارنة سنة بسنة', rows);
});

/* ============ حاسبة نقطة التعادل (Break-even) ============ */
function suggestedFixedCost(){
  const keys = lastNMonthKeys(3);
  const totals = keys.map(k=> vaultTx.filter(t=>t.type==='out' && (t.date||'').slice(0,7)===k).reduce((s,t)=>s+num(t.amount),0));
  return totals.length ? Math.round(totals.reduce((a,b)=>a+b,0)/totals.length) : 0;
}
function avgRevenuePerClient(){
  const cutoffStr = (typeof addDaysISO==='function' && typeof todayISO==='function') ? addDaysISO(todayISO(), -90) : (()=>{ const c=new Date(); c.setDate(c.getDate()-90); return c.toISOString().slice(0,10); })();
  const recent = clients.filter(c=>!c.cancelled && (c.date||'')>=cutoffStr);
  if(!recent.length) return 0;
  const total = recent.reduce((s,c)=>s+centerIncome(c),0);
  return total/recent.length;
}
function renderBreakeven(){
  const cardsEl = $('#breakeven-cards');
  const input = $('#be-fixed-cost');
  if(!cardsEl || !input) return;
  if(!input.dataset.touched){
    input.value = suggestedFixedCost();
  }
  const fixedCost = Math.max(0, Number(input.value)||0);
  const avgRev = avgRevenuePerClient();
  const needed = avgRev>0 ? Math.ceil(fixedCost/avgRev) : 0;
  const thisMonthKey = todayISO().slice(0,7);
  const regThisMonth = clients.filter(c=>!c.cancelled && (c.date||'').slice(0,7)===thisMonthKey).length;
  const remainingNeeded = Math.max(0, needed - regThisMonth);
  cardsEl.innerHTML = `
    <div class="card"><div class="k">متوسط دخل المركز لكل متدرب (آخر 90 يوم)</div><div class="v">${fmt(avgRev)}</div></div>
    <div class="card"><div class="k">عدد المتدربين اللازم شهرياً لتغطية المصاريف</div><div class="v gold">${needed || '—'}</div></div>
    <div class="card"><div class="k">المسجَّلون هذا الشهر حتى الآن</div><div class="v teal">${regThisMonth}</div></div>
    <div class="card"><div class="k">المتبقي للوصول لنقطة التعادل هذا الشهر</div><div class="v ${remainingNeeded>0?'red':'teal'}">${needed ? remainingNeeded : '—'}</div></div>
  `;
}
$('#be-fixed-cost')?.addEventListener('input', e=>{ e.target.dataset.touched='1'; renderBreakeven(); });
$('#btn-suggest-fixed-cost')?.addEventListener('click', ()=>{
  $('#be-fixed-cost').value = suggestedFixedCost();
  $('#be-fixed-cost').dataset.touched='1';
  renderBreakeven();
});

function renderReports(){
  if($('#wa3-report-month') && !$('#wa3-report-month').value) $('#wa3-report-month').value = lastCompleteMonthKey();
  if($('#vat-report-year') && !$('#vat-report-year').value) $('#vat-report-year').value = new Date().getFullYear();
  if($('#vat-report-quarter') && !$('#vat-report-quarter').value) $('#vat-report-quarter').value = String(Math.max(1, Math.ceil((new Date().getMonth() + 1) / 3)) || 1);
  renderBudget();
  renderCourseProfitability();
  renderAgingReport();
  renderYoY();
  renderBreakeven();
  renderPnL($('#rp-from').value, $('#rp-to').value);
  const rows = periodFilteredVaultTx();
  const income = rows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0);
  const expense = rows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const cInPeriod = clientsInPeriod();
  const avgPerClient = cInPeriod.length ? income/cInPeriod.length : 0;
  $('#period-cards').innerHTML = `
    <div class="card"><div class="k">إيرادات الفترة</div><div class="v teal">${fmt(income)}</div></div>
    <div class="card"><div class="k">مصروفات الفترة</div><div class="v red">${fmt(expense)}</div></div>
    <div class="card"><div class="k">صافي الفترة</div><div class="v ${(income-expense)<0?'red':'gold'}">${fmt(income-expense)}</div></div>
    <div class="card"><div class="k">عدد العملاء المسجّلين بالفترة</div><div class="v">${cInPeriod.length}</div></div>
    <div class="card"><div class="k">متوسط الإيراد لكل عميل بالفترة</div><div class="v">${fmt(avgPerClient)}</div></div>
  `;
  // مقارنة بالفترة السابقة مباشرة (بنفس عدد الأيام)
  const cmp = periodComparison();
  const net = income - expense;
  const prevNet = cmp.prevIncome - cmp.prevExpense;
  $('#period-compare-hint').textContent = `مقارنة بالفترة من ${formatDateDisplay(cmp.prevFromISO)} إلى ${formatDateDisplay(cmp.prevToISO)}`;
  $('#period-compare-cards').innerHTML = `
    <div class="card"><div class="k">الإيرادات</div><div class="v teal">${fmt(income)}</div>${changeBadgePositive(pctChange(income, cmp.prevIncome))}</div>
    <div class="card"><div class="k">المصروفات</div><div class="v red">${fmt(expense)}</div>${changeBadgeNegative(pctChange(expense, cmp.prevExpense))}</div>
    <div class="card"><div class="k">الصافي</div><div class="v ${net<0?'red':'gold'}">${fmt(net)}</div>${changeBadgePositive(pctChange(net, prevNet))}</div>
    <div class="card"><div class="k">عدد العملاء</div><div class="v">${cInPeriod.length}</div>${changeBadgePositive(pctChange(cInPeriod.length, cmp.prevClients))}</div>
  `;
  // الاتجاهات الشهرية (آخر 12 شهر) — مستقلة عن فلتر الفترة
  const finTrend = monthlyFinancialTrend(12);
  drawLineChart('#chart-trend-financial', finTrend.labels, finTrend.series);
  const clientsTrend = monthlyRegistrationsTrend(12);
  drawLineChart('#chart-trend-clients', clientsTrend.labels, clientsTrend.series);
  // جدول شهري: عدد المسجّلين والمبالغ المدفوعة (كاش/شبكة/بنك)
  const monthlyTable = monthlyRegistrationsPaymentsTable(12);
  $('#monthly-summary-body').innerHTML = monthlyTable.map(m=>`
    <tr>
      <td>${m.label}</td>
      <td class="mono">${m.regCount}</td>
      <td class="mono">${fmt(m.cash)}</td>
      <td class="mono">${fmt(m.network)}</td>
      <td class="mono">${fmt(m.bank)}</td>
      <td class="mono" style="font-weight:bold;">${fmt(m.total)}</td>
    </tr>`).join('');
  // دخل المركز حسب نوع الدورة (يحترم فلتر الفترة الحالي)
  drawBars('#chart-report-revenue-course', revenueByCourseType());
  const catTotals = {};
  rows.filter(t=>t.type==='out').forEach(t=>{ const k=t.category||'أخرى'; catTotals[k]=(catTotals[k]||0)+num(t.amount); });
  drawBars('#chart-report-expense', Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]));
}
['#rp-from','#rp-to'].forEach(sel=> $(sel).addEventListener('input', renderReports));
$('#btn-export-monthly-summary')?.addEventListener('click', ()=>{
  const monthlyTable = monthlyRegistrationsPaymentsTable(12);
  const headers = ['الشهر','عدد المسجّلين','نقدي (كاش)','شبكة','بنك','إجمالي المدفوع'];
  const rows = monthlyTable.map(m=>[m.label, m.regCount, m.cash, m.network, m.bank, m.total]);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'الجدول_الشهري_للتسجيلات_والمدفوعات.csv';
  a.click();
});
$('#btn-export-report').addEventListener('click', ()=>{
  const rows = periodFilteredVaultTx();
  const income = rows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0);
  const expense = rows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const cInPeriod = clientsInPeriod();
  const from = $('#rp-from').value || 'البداية';
  const to = $('#rp-to').value || 'الآن';
  const summary = [
    ['الفترة', `من ${from} إلى ${to}`],
    ['إجمالي الإيرادات', income],
    ['إجمالي المصروفات', expense],
    ['صافي الفترة', income-expense],
    ['عدد العملاء المسجّلين بالفترة', cInPeriod.length],
    ['متوسط الإيراد لكل عميل', cInPeriod.length ? Math.round((income/cInPeriod.length)*100)/100 : 0],
  ];
  const csv = '\uFEFF'+summary.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `تقرير_الفترة_${from}_${to}.csv`;
  a.click();
});

// يبني مستلمي التقارير (To أساسي + CC) من الإعداد الموحّد فى شاشة الإعدادات بدل سؤال
// المستخدم فى كل مرة. يرجع {to, cc} أو null (مع toast توجيهي) لو لم يُضبط بريد رئيسي بعد.
function reportEmailRecipients(){
  const to = (settings.reportEmailTo||'').trim();
  if(!to){
    showToast('لم يتم ضبط بريد استلام التقارير بعد — اضبطه من الإعدادات ← إرسال التقارير بالإيميل');
    return null;
  }
  const cc = (settings.reportEmailCC||'').split(',').map(s=>s.trim()).filter(Boolean);
  return { to, cc, all: [to, ...cc] };
}

// إرسال أي تقرير CSV بالإيميل — دالة عامة تُستخدم لكل أزرار "إرسال بالإيميل" فى شاشة التقارير.
// المستلمون (To + CC) يُقرأون تلقائياً من إعداد "إرسال التقارير بالإيميل" الموحّد فى شاشة
// الإعدادات (settings.reportEmailTo / reportEmailCC) بدل سؤال المستخدم فى كل مرة.
// تحوّل النص إلى base64 وتبعته للسيرفر كمرفق CSV مع سطر ملخص فى متن الرسالة.
async function emailCsvReport(filename, csv, subject, summaryLines){
  const recipients = reportEmailRecipients();
  if(!recipients) return;
  const attachmentBase64 = btoa(unescape(encodeURIComponent(csv)));
  const bodyHtml = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif; line-height:1.9;">
    <p>مرفق التقرير المطلوب: <b>${escapeHtml(subject)}</b></p>
    ${summaryLines ? `<ul>${summaryLines.map(l=>`<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
  </div>`;
  try{
    const res = await serverFetch('/api/email/report', {
      method:'POST',
      body: JSON.stringify({ to: [recipients.to], cc: recipients.cc, subject, bodyHtml, attachmentBase64, attachmentName: filename, attachmentType: 'text/csv' }),
    });
    if(res.ok){
      showToast(`تم إرسال التقرير بالإيميل إلى ${recipients.all.join(', ')}`);
      await logAudit('edit','التقارير', `تم إرسال تقرير "${subject}" بالإيميل إلى ${recipients.all.join(', ')}`);
    }else{
      const data = await res.json().catch(()=>({}));
      showToast(`تعذّر إرسال التقرير بالإيميل: ${data.error || 'خطأ غير معروف'}`);
    }
  }catch(e){
    console.error('فشل إرسال إيميل التقرير:', e);
    showToast('تعذّر إرسال التقرير بالإيميل — تحقق من الاتصال');
  }
}
$('#btn-email-report')?.addEventListener('click', ()=>{
  const rows = periodFilteredVaultTx();
  const income = rows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0);
  const expense = rows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const cInPeriod = clientsInPeriod();
  const from = $('#rp-from').value || 'البداية';
  const to = $('#rp-to').value || 'الآن';
  const summary = [
    ['الفترة', `من ${from} إلى ${to}`],
    ['إجمالي الإيرادات', income],
    ['إجمالي المصروفات', expense],
    ['صافي الفترة', income-expense],
    ['عدد العملاء المسجّلين بالفترة', cInPeriod.length],
    ['متوسط الإيراد لكل عميل', cInPeriod.length ? Math.round((income/cInPeriod.length)*100)/100 : 0],
  ];
  const csv = '\uFEFF'+summary.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  emailCsvReport(`تقرير_الفترة_${from}_${to}.csv`, csv, `تقرير الفترة من ${from} إلى ${to}`, summary.map(r=>`${r[0]}: ${r[1]}`));
});

/* ================================================================
   المحاسبة — قوائم مالية على أساس الاستحقاق (دخل / ميزانية / ميزان مراجعة)
   ================================================================ */
function inRange(d, from, to){ d = d||''; if(from && d < from) return false; if(to && d > to) return false; return true; }
function isLoanTx(t){ return !t.clientId && /قرض/i.test(`${t.notes||''} ${t.manual||''} ${t.category||''}`); }
function journalUpTo(asOf){ return journalEntries.filter(j=> !asOf || (j.date||'') <= asOf); }
function journalInRange(from, to){ return journalEntries.filter(j=> inRange(j.date, from, to)); }

/* ---- أرصدة الخزنة/البنك/الشبكة كأرصدة تراكمية حتى تاريخ معيّن ---- */
function balanceOfAsOf(dest, asOf){
  const rows = vaultTx.filter(t=> !asOf || (t.date||'') <= asOf);
  return rows.filter(t=>(t.destination||'vault')===dest && t.type==='in' && vaultTxCountsTowardBalance(t)).reduce((s,t)=>s+num(t.amount),0)
       - rows.filter(t=>(t.destination||'vault')===dest && t.type==='out').reduce((s,t)=>s+num(t.amount),0);
}
/* ---- ذمم العملاء (مدينون) كأرصدة تراكمية حتى تاريخ معيّن ---- */
function paidTotalAsOf(c, asOf){
  if(!c.clientId) return (!asOf || (c.date||'')<=asOf) ? (num(c.paid)+num(c.paid2)) : 0;
  // نفس مشكلة paidTotal() تماماً: عميل حوالة شركة (companyTransferAllocated) ماله ما يظهرش
  // كقيد فردي بـ clientId في الحركات المالية (مُرحَّل ضمن القيد الموحّد لكامل الحوالة)، فكانت
  // فهرسة vaultInTxIndex ترجع 0 دائماً، ويظهر كامل مبلغه كذمة مدينة (غير مسدَّد) في التقارير
  // المحاسبية (ذمم العملاء، قائمة الدخل، ميزان المراجعة) رغم تحصيله فعلياً ضمن الحوالة.
  if(c.companyTransferAllocated) return (!asOf || (c.date||'')<=asOf) ? (num(c.paid)+num(c.paid2)) : 0;
  const txs = vaultInTxIndex().get(c.clientId);
  if(!txs) return 0;
  return txs.reduce((s,t)=> (!asOf || (t.date||'')<=asOf) ? s+num(t.amount) : s, 0);
}
function receivablesAsOf(asOf){
  return clients.filter(c=>!c.suspended && !c.cancelled && (!asOf || (c.date||'')<=asOf))
    .reduce((s,c)=> s + Math.max(0, total(c) - paidTotalAsOf(c, asOf)), 0);
}
/* ---- مخزون الحقائب والتزام أمانة الحقائب تجاه العملاء، كأرصدة تراكمية حتى تاريخ معيّن ---- */
function bagStockQtyAsOf(asOf){
  return bagStock.filter(b=> !asOf || (b.date||'')<=asOf).reduce((s,x)=>s+num(x.qty),0);
}
function bagDeliveredAsOf(asOf){
  const stockIssued = clients.filter(c=>c.bagSource==='stock' && !c.suspended && (!asOf || (c.date||'')<=asOf)).length;
  const spentDirect = clients.filter(c=>c.bagSource==='buy' && c.bagStatus==='purchased' && !c.suspended && (!asOf || (c.date||'')<=asOf))
    .reduce((s,c)=>s+num(c.bagPrice),0);
  return { stockIssued, spentDirect };
}
function bagInventoryValueAsOf(asOf){
  const qty = Math.max(0, bagStockQtyAsOf(asOf));
  return qty * num(settings.bagPrice);
}
function bagCustodyLiabilityAsOf(asOf){
  const bagCollected = clients.filter(c=>!c.suspended && (!asOf || (c.date||'')<=asOf)).reduce((s,c)=>s+bagAmount(c),0);
  const { stockIssued, spentDirect } = bagDeliveredAsOf(asOf);
  return bagCollected - (stockIssued*num(settings.bagPrice) + spentDirect);
}
/* ---- قروض مصنَّفة تلقائياً من الملاحظات ("قرض") ضمن الحركات غير المرتبطة بعميل ---- */
function loansPayableAsOf(asOf){
  const rows = vaultTx.filter(t=> !t.clientId && !t.bagStockRef && isLoanTx(t) && (!asOf || (t.date||'')<=asOf));
  return rows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0) - rows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
}
/* ---- القيود اليدوية: أصول ثابتة / إهلاك / التزامات ---- */
function fixedAssetsTotalAsOf(asOf){ return journalUpTo(asOf).filter(j=>j.type==='fixedasset').reduce((s,j)=>s+num(j.amount),0); }
function depreciationTotalAsOf(asOf){ return journalUpTo(asOf).filter(j=>j.type==='depreciation').reduce((s,j)=>s+num(j.amount),0); }
function accruedTotalAsOf(asOf){ return journalUpTo(asOf).filter(j=>j.type==='accrued').reduce((s,j)=>s+num(j.amount),0); }
function otherLiabilityTotalAsOf(asOf){ return journalUpTo(asOf).filter(j=>j.type==='otherliability').reduce((s,j)=>s+num(j.amount),0); }

/* ---- قائمة الدخل التشغيلية عن فترة (from..to)، مبنية على أساس الاستحقاق ---- */
function revenueBreakdown(from, to){
  const rows = clients.filter(c=>!c.cancelled && inRange(c.date, from, to));
  const totals = {};
  rows.forEach(c=>{ const k = c.courseType || 'دخل دورات غير مصنّف'; totals[k] = (totals[k]||0) + centerIncome(c); });
  return totals;
}
function salesReturnsTotal(from, to){
  return vaultTx.filter(t=>t.type==='out' && t.isReturn && inRange(t.date, from, to)).reduce((s,t)=>{
    // تسجيل مردود لعميل يُحوّله تلقائياً إلى "ملغى" (module-finance.js) — وإيراد العميل الملغى
    // مستبعد أصلاً من revenueBreakdown (الفلتر !c.cancelled). لو خصمنا مردوده هنا أيضاً
    // كان صافي الإيراد يسجل سالباً بدل صفر (خصم مزدوج). نخصم فقط المرتجعات التي لا تُحسب
    // قيمتها ضمن الإيرادات — أي المرتجع لعملاء غير ملغين، أو مرتجع بلا عميل مرتبط.
    if(t.clientId){
      const c = clients.find(x=>x.clientId===t.clientId);
      if(c && c.cancelled) return s;
    }
    return s+num(t.amount);
  },0);
}
function expenseBreakdown(from, to){
  const rows = vaultTx.filter(t=>t.type==='out' && !t.bagStockRef && !t.isReturn && t.category!=='مسحوبات شركاء' && !isLoanTx(t) && inRange(t.date, from, to));
  const totals = {};
  rows.forEach(t=>{ const k = t.category || 'مصروفات أخرى'; totals[k] = (totals[k]||0) + num(t.amount); });
  return totals;
}
function drawingsTotal(from, to){
  return vaultTx.filter(t=>t.type==='out' && t.category==='مسحوبات شركاء' && inRange(t.date, from, to)).reduce((s,t)=>s+num(t.amount),0);
}
/* صافي الربح/الخسارة عن فترة، شاملاً أي قيود إهلاك أو مستحقات أو تسويات يدوية داخل نفس الفترة */
function netIncomeOf(from, to){
  const rev = Object.values(revenueBreakdown(from,to)).reduce((a,b)=>a+b,0) - salesReturnsTotal(from,to);
  const exp = Object.values(expenseBreakdown(from,to)).reduce((a,b)=>a+b,0);
  const dep = journalInRange(from,to).filter(j=>j.type==='depreciation').reduce((s,j)=>s+num(j.amount),0);
  const acc = journalInRange(from,to).filter(j=>j.type==='accrued').reduce((s,j)=>s+num(j.amount),0);
  const rj  = journalInRange(from,to).filter(j=>j.type==='readj').reduce((s,j)=>s+num(j.amount),0);
  return rev - exp - dep - acc + rj;
}
/* الأرباح المرحلة كرصيد تراكمي حتى تاريخ معيّن (منذ بداية بيانات النظام) */
function retainedEarningsAsOf(asOf){
  return netIncomeOf(null, asOf) - drawingsTotal(null, asOf);
}

/* ---- حدود الفترة المحاسبية المختارة في الشاشة ---- */
function accSelectedRange(){
  const year = $('#acc-year')?.value || String(new Date().getFullYear());
  const period = $('#acc-period')?.value || 'year';
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
function accPeriodLabel(period){
  return {year:'السنة كاملة', q1:'الربع الأول', q2:'الربع الثاني', q3:'الربع الثالث', q4:'الربع الرابع'}[period] || 'السنة كاملة';
}

/* ---- الإقرار الضريبي (ضريبة القيمة المضافة): ضريبة المخرجات من فواتير الدورات + الفواتير اليدوية − مردودات المبيعات، ضريبة المدخلات من المشتريات ---- */
function buildVatReturn(from, to){
  // ضريبة المخرجات: فواتير الدورات (رقم فاتورة + قيمة فعلية بالإيصال، حسب تاريخ صدور الفاتورة) + فواتير المبيعات اليدوية
  const courseRows = courseInvoiceClients().filter(c=>{
    const d = c.receiptIssueDate || '';
    return num(c.receiptActualValue) > 0 && d && d>=from && d<=to;
  }).map(c=>({
    source:'course', date: c.receiptIssueDate, name: c.name||'', clientId: c.clientId||'', invoice: c.invoice||'',
    totalInclVat: num(c.receiptActualValue), vat: courseInvoiceVat(c.receiptActualValue)
  }));
  const manualRows = manualSalesInvoices.filter(m=> m.date && m.date>=from && m.date<=to).map(m=>({
    source:'manual', date: m.date, name: m.name||'', clientId:'', invoice: formatManualSalesInvoiceNo(m.invoiceNo||0),
    totalInclVat: num(m.total), vat: vatFromGross(m.total)
  }));
  const salesRows = courseRows.concat(manualRows);
  const salesGross = salesRows.reduce((s,r)=> s+r.totalInclVat, 0);
  const outputVatGross = salesRows.reduce((s,r)=> s+r.vat, 0);

  // مردودات المبيعات (استرجاعات) خلال نفس الفترة
  const returnRows = vaultTx.filter(t=>t.type==='out' && t.isReturn && inRange(t.date, from, to))
    .filter(t=>{
      // تسجيل المردود يُلغي العميل ويوقفه (module-finance.js) — فعميل المردود مستبعد أصلاً من
      // courseInvoiceClients (!c.suspended)، فلا يجوز خصم مردوده مرة ثانية هنا (خصم مزدوج).
      if(t.clientId){
        const c = clients.find(x=>x.clientId===t.clientId);
        if(c && c.cancelled) return false;
      }
      return true;
    })
    .map(t=>({ date:t.date, name:t.clientName||t.clientId||'—', amount:num(t.amount), vat: vatFromGross(t.amount) }))
    .sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  const returnsGross = returnRows.reduce((s,r)=> s+r.amount, 0);
  const returnsVat = returnRows.reduce((s,r)=> s+r.vat, 0);

  const outputVat = outputVatGross - returnsVat;
  const salesNet = (salesGross - outputVatGross) - (returnsGross - returnsVat);

  // ضريبة المدخلات: فواتير الشراء حسب تاريخ الشراء
  const purchaseRows = (typeof purchases!=='undefined' ? purchases : []).filter(p=> p.date && p.date>=from && p.date<=to);
  const purchasesNet = purchaseRows.reduce((s,p)=> s+num(p.subtotal), 0);
  const inputVat = purchaseRows.reduce((s,p)=> s+num(p.taxAmount), 0);
  const purchasesGross = purchasesNet + inputVat;

  const netVat = outputVat - inputVat;
  salesRows.sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  purchaseRows.sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  return { salesRows, returnRows, purchaseRows, salesGross, salesNet, outputVat, returnsGross, returnsVat, purchasesGross, purchasesNet, inputVat, netVat };
}
function renderVatReturnTable(from, to){
  const table = $('#acc-vat-table');
  if(!table) return;
  const r = buildVatReturn(from, to);
  const row = (label, value, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:1px solid var(--border);':(opts&&opts.muted?'color:var(--text-muted);':'')}"><td style="${opts&&opts.indent?'padding-right:22px;':''}">${label}</td><td class="mono" style="text-align:left;">${fmt(value)}</td></tr>`;
  table.innerHTML = `<tbody>
    <tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">المبيعات (ضريبة المخرجات) — ${r.salesRows.length} فاتورة${r.returnRows.length?` · ${r.returnRows.length} مردود`:''}</td></tr>
    ${row('إجمالي المبيعات شامل الضريبة', r.salesGross, {indent:true, muted:true})}
    ${row('يُخصم: مردودات مبيعات (شامل الضريبة)', -r.returnsGross, {indent:true, muted:true})}
    ${row('إجمالي المبيعات بدون الضريبة (بعد المردودات)', r.salesNet, {indent:true, muted:true})}
    ${row('صافي ضريبة المخرجات (15%)', r.outputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">المشتريات (ضريبة المدخلات) — ${r.purchaseRows.length} فاتورة</td></tr>
    ${row('إجمالي المشتريات شامل الضريبة', r.purchasesGross, {indent:true, muted:true})}
    ${row('إجمالي المشتريات بدون الضريبة', r.purchasesNet, {indent:true, muted:true})}
    ${row('إجمالي ضريبة المدخلات (15%)', r.inputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px;"></td></tr>
    ${row(r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', Math.abs(r.netVat), {bold:true})}
  </tbody>`;
}
$('#btn-export-vat')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  const r = buildVatReturn(from, to);
  const summaryRows = [
    {'البند':'إجمالي المبيعات شامل الضريبة', 'القيمة':r.salesGross},
    {'البند':'يُخصم: مردودات مبيعات (شامل الضريبة)', 'القيمة':-r.returnsGross},
    {'البند':'إجمالي المبيعات بدون الضريبة (بعد المردودات)', 'القيمة':r.salesNet},
    {'البند':'صافي ضريبة المخرجات (15%)', 'القيمة':r.outputVat},
    {'البند':'إجمالي المشتريات شامل الضريبة', 'القيمة':r.purchasesGross},
    {'البند':'إجمالي المشتريات بدون الضريبة', 'القيمة':r.purchasesNet},
    {'البند':'إجمالي ضريبة المدخلات (15%)', 'القيمة':r.inputVat},
    {'البند': r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', 'القيمة':Math.abs(r.netVat)},
  ];
  const salesDetailRows = r.salesRows.map(c=>({
    'التاريخ': c.date||'', 'العميل': c.name||'', 'رقم الهوية': c.clientId||'', 'رقم الفاتورة': c.invoice||'', 'المصدر': c.source==='manual'?'يدوي':'فاتورة دورة',
    'القيمة بدون الضريبة': c.totalInclVat - c.vat, 'الضريبة': c.vat, 'الإجمالي': c.totalInclVat,
  }));
  const returnsDetailRows = r.returnRows.map(t=>({
    'التاريخ': t.date||'', 'العميل': t.name||'', 'القيمة بدون الضريبة': t.amount - t.vat, 'الضريبة': t.vat, 'الإجمالي': t.amount,
  }));
  const purchaseDetailRows = r.purchaseRows.map(p=>({
    'التاريخ': p.date||'', 'المورد': p.supplierName||'', 'رقم الفاتورة': p.invoiceNo||'',
    'القيمة بدون الضريبة': num(p.subtotal), 'الضريبة': num(p.taxAmount), 'الإجمالي': num(p.total),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'ملخص الإقرار');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salesDetailRows), 'تفاصيل المبيعات');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(returnsDetailRows), 'تفاصيل المردودات');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(purchaseDetailRows), 'تفاصيل المشتريات');
  XLSX.writeFile(wb, `الإقرار_الضريبي_${from}_${to}.xlsx`);
});
function populateAccYearSelect(){
  const sel = $('#acc-year');
  if(!sel) return;
  const years = collectAllYears();
  const thisYear = String(new Date().getFullYear());
  if(!years.includes(thisYear)) years.unshift(thisYear);
  const keep = sel.value;
  sel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join('');
  sel.value = years.includes(keep) ? keep : (years.includes(String(selectedYearFilter)) ? String(selectedYearFilter) : years[0]);
}

/* ---- بناء الميزانية العمومية الكاملة كأرصدة تراكمية حتى asOf ---- */
function buildBalanceSheet(asOf){
  const cash = balanceOfAsOf('vault', asOf);
  const bank = balanceOfAsOf('bank', asOf);
  const network = balanceOfAsOf('network', asOf);
  const receivables = receivablesAsOf(asOf);
  const bagInventory = bagInventoryValueAsOf(asOf);
  const fixedAssetsGross = fixedAssetsTotalAsOf(asOf);
  const accumDep = depreciationTotalAsOf(asOf);
  const fixedAssetsNet = fixedAssetsGross - accumDep;

  let bagCustody = bagCustodyLiabilityAsOf(asOf);
  let bagCustodyAsset = 0;
  if(bagCustody < 0){ bagCustodyAsset = -bagCustody; bagCustody = 0; } // تسليم أكثر مما حُصِّل (نادر) يُعرض كأصل بدل التزام سالب

  const loans = Math.max(0, loansPayableAsOf(asOf));
  const accrued = accruedTotalAsOf(asOf);
  const otherLiab = otherLiabilityTotalAsOf(asOf);

  const totalAssets = cash + bank + network + receivables + bagInventory + Math.max(0,fixedAssetsNet) + bagCustodyAsset;
  const totalLiabilities = bagCustody + loans + accrued + otherLiab;
  const retainedEarnings = retainedEarningsAsOf(asOf);
  const totalEquity = totalAssets - totalLiabilities;
  const ownerCapital = totalEquity - retainedEarnings;

  return {
    cash, bank, network, receivables, bagInventory, fixedAssetsGross, accumDep, fixedAssetsNet,
    bagCustody, bagCustodyAsset, loans, accrued, otherLiab,
    totalAssets, totalLiabilities, retainedEarnings, ownerCapital, totalEquity
  };
}

/* ---- قائمة التدفقات النقدية (الطريقة المباشرة) من حركات الخزنة/البنك/الشبكة فعلياً خلال الفترة ---- */
function buildCashFlowStatement(from, to){
  const rows = vaultTx.filter(t=> inRange(t.date, from, to) && (t.destination||'vault')!=='other');
  let opIn=0, opReturns=0, opOut=0, finIn=0, finOut=0, invOut=0;
  const isFinancingCat = c => /مسحوبات|شركاء|قرض|رأس ?مال/.test(c||'');
  const isInvestingCat = c => /أصل|أصول/.test(c||'');
  rows.forEach(t=>{
    const amt = num(t.amount);
    if(t.type==='in'){
      // حركات الوارد غير المسوّاة (autoClientId + vault + settled=false) لا تدخل رصيد الخزنة
      // إطلاقاً (vaultTxCountsTowardBalance) — ولو دخلت هنا دون استبعادها لظهر فرق بين
      // (بداية الفترة + صافي التغيّر) ورصيد النهاية في فحص التطابق أسفل الجدول.
      if(!vaultTxCountsTowardBalance(t)) return;
      // قيد الحوالة الموحّد لحوالات الشركات (companyTransferId) هو أيضاً دخل تشغيلي حقيقي من عميل
      // (شركة)، تماماً مثل أي قيد عادي بـ clientId — فقط لا يحمل clientId لأنه يمثّل عدة متدربين
      // دفعة واحدة. بدون هذا الشرط كان يُصنَّف خطأً كـ "تمويلي" (تبرعات/قروض) بدل "تشغيلي".
      if(t.clientId || t.companyTransferId) opIn += amt; else finIn += amt;
    } else if(t.type==='out'){
      if(t.isReturn) opReturns += amt;
      else if(isFinancingCat(t.category)) finOut += amt;
      else if(isInvestingCat(t.category)) invOut += amt;
      else opOut += amt;
    }
  });
  const netOperating = opIn - opReturns - opOut;
  const netInvesting = -invOut;
  const netFinancing = finIn - finOut;
  const netChange = netOperating + netInvesting + netFinancing;
  const priorDay = addDaysISO(from, -1);
  const beginCash = balanceOfAsOf('vault', priorDay) + balanceOfAsOf('bank', priorDay) + balanceOfAsOf('network', priorDay);
  const endCash = balanceOfAsOf('vault', to) + balanceOfAsOf('bank', to) + balanceOfAsOf('network', to);
  return { opIn, opReturns, opOut, netOperating, invOut, netInvesting, finIn, finOut, netFinancing, netChange, beginCash, endCash };
}
function renderCashFlowTable(from, to){
  const table = $('#acc-cashflow-table');
  if(!table) return null;
  const cf = buildCashFlowStatement(from, to);
  table.innerHTML = `<tbody>
    ${accHeaderRow('الأنشطة التشغيلية')}
    ${accRow('مقبوضات من العملاء', cf.opIn, {indent:true})}
    ${accRow('مسترد للعملاء (مردودات مبيعات)', -cf.opReturns, {indent:true})}
    ${accRow('مدفوعات تشغيلية ومشتريات', -cf.opOut, {indent:true})}
    ${accRow('صافي النقد من الأنشطة التشغيلية', cf.netOperating, {total:true})}
    ${accHeaderRow('الأنشطة الاستثمارية')}
    ${accRow('شراء أصول ثابتة', -cf.invOut, {indent:true})}
    ${accRow('صافي النقد من الأنشطة الاستثمارية', cf.netInvesting, {total:true})}
    ${accHeaderRow('الأنشطة التمويلية')}
    ${accRow('مساهمات / دعم رأس مال / قروض واردة', cf.finIn, {indent:true})}
    ${accRow('مسحوبات شركاء / سداد قروض', -cf.finOut, {indent:true})}
    ${accRow('صافي النقد من الأنشطة التمويلية', cf.netFinancing, {total:true})}
    <tr><td colspan="2" style="padding-top:14px;"></td></tr>
    ${accRow('صافي التغيّر في النقدية خلال الفترة', cf.netChange, {total:true})}
    ${accRow('رصيد النقدية في بداية الفترة', cf.beginCash, {indent:true})}
    ${accRow('رصيد النقدية في نهاية الفترة (فعلياً)', cf.endCash, {total:true})}
  </tbody>`;
  const expected = cf.beginCash + cf.netChange;
  const diff = cf.endCash - expected;
  const checkEl = $('#acc-cashflow-check');
  if(checkEl){
    checkEl.innerHTML = Math.abs(diff) < 1
      ? `<span style="color:var(--teal); font-weight:700;">✅ متطابقة: بداية الفترة + صافي التغيّر = نهاية الفترة فعلياً</span>`
      : `<span style="color:var(--red); font-weight:700;">⚠️ فرق ${fmt(Math.abs(diff))} ﷼ بين المتوقع والفعلي — راجع حركات الخزنة بدون تصنيف واضح (تصنيف "أخرى" أو معاملات خارج الفترة المحددة).</span>`;
  }
  return cf;
}
$('#btn-export-cashflow')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  renderCashFlowTable(from, to);
  csvDownload(`قائمة_التدفقات_النقدية_${from}_${to}.csv`, tableToRows('#acc-cashflow-table'));
});
$('#btn-print-cashflow')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  renderCashFlowTable(from, to);
  printAccountingReport('قائمة التدفقات النقدية', '#acc-cashflow-table');
});

/* ---- الذمم المدينة والدائنة (أعمار الديون) ---- */
function daysBetweenISO(fromIso, toIso){
  if(!fromIso || !toIso) return 0;
  const a = new Date(fromIso+'T00:00:00'), b = new Date(toIso+'T00:00:00');
  return Math.round((b-a) / 86400000);
}
function agingBucket(days){
  if(days<=30) return '0–30 يوم';
  if(days<=60) return '31–60 يوم';
  if(days<=90) return '61–90 يوم';
  return 'أكثر من 90 يوم';
}
function buildARAging(asOf){
  const rows = clients.filter(c=>!c.suspended && !c.cancelled && (!asOf || (c.date||'')<=asOf)).map(c=>{
    const bal = Math.max(0, total(c) - paidTotalAsOf(c, asOf));
    if(bal<=0) return null;
    const dueDate = c.clientType==='company' && num(c.creditDays)>0 ? addDaysISO(c.date||asOf, num(c.creditDays)) : (c.date||asOf);
    const days = Math.max(0, daysBetweenISO(dueDate, asOf));
    return { name:c.name||'—', clientId:c.clientId||'—', phone:c.phone||'—', dueDate, days, amount: bal, bucket: agingBucket(days) };
  }).filter(Boolean).sort((a,b)=> b.days - a.days);
  const buckets = {'0–30 يوم':0, '31–60 يوم':0, '61–90 يوم':0, 'أكثر من 90 يوم':0};
  rows.forEach(r=> buckets[r.bucket] += r.amount);
  const total_ = rows.reduce((s,r)=>s+r.amount,0);
  return { rows, buckets, total: total_ };
}
function buildAPAging(asOf){
  const rows = purchases.filter(p=> p.status==='unpaid' && (p.date||'')<=asOf).map(p=>{
    const days = Math.max(0, daysBetweenISO(p.date||asOf, asOf));
    return { supplierName:p.supplierName||'—', invoiceNo:p.invoiceNo||'—', date:p.date||'', days, amount:num(p.total), bucket: agingBucket(days) };
  }).sort((a,b)=> b.days - a.days);
  const buckets = {'0–30 يوم':0, '31–60 يوم':0, '61–90 يوم':0, 'أكثر من 90 يوم':0};
  rows.forEach(r=> buckets[r.bucket] += r.amount);
  const total_ = rows.reduce((s,r)=>s+r.amount,0);
  return { rows, buckets, total: total_ };
}
function agingCardsHtml(data){
  return `
    <div class="card"><div class="k">الإجمالي</div><div class="v">${fmt(data.total)}</div></div>
    <div class="card"><div class="k">0–30 يوم</div><div class="v teal">${fmt(data.buckets['0–30 يوم'])}</div></div>
    <div class="card"><div class="k">31–60 يوم</div><div class="v gold">${fmt(data.buckets['31–60 يوم'])}</div></div>
    <div class="card"><div class="k">61–90 يوم</div><div class="v gold">${fmt(data.buckets['61–90 يوم'])}</div></div>
    <div class="card"><div class="k">أكثر من 90 يوم</div><div class="v red">${fmt(data.buckets['أكثر من 90 يوم'])}</div></div>
  `;
}
function renderARAging(asOf){
  const data = buildARAging(asOf);
  $('#ar-summary-cards') && ($('#ar-summary-cards').innerHTML = agingCardsHtml(data));
  const tbody = $('#ar-table-body');
  if(tbody){
    tbody.innerHTML = data.rows.map(r=> `<tr>
      <td>${escapeHtml(r.name)}</td><td class="mono">${escapeHtml(r.clientId)}</td><td class="mono">${escapeHtml(r.phone)}</td>
      <td class="mono">${escapeHtml(formatDateDisplay(r.dueDate)||r.dueDate||'—')}</td>
      <td class="mono" style="${r.days>90?'color:var(--red); font-weight:700;':''}">${r.days}</td>
      <td class="mono">${fmt(r.amount)}</td><td>${r.bucket}</td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد ذمم مدينة حتى هذا التاريخ</td></tr>`;
  }
  return data;
}
function renderAPAging(asOf){
  const data = buildAPAging(asOf);
  $('#ap-summary-cards') && ($('#ap-summary-cards').innerHTML = agingCardsHtml(data));
  const tbody = $('#ap-table-body');
  if(tbody){
    tbody.innerHTML = data.rows.map(r=> `<tr>
      <td>${escapeHtml(r.supplierName)}</td><td class="mono">${escapeHtml(r.invoiceNo)}</td>
      <td class="mono">${escapeHtml(formatDateDisplay(r.date)||r.date||'—')}</td>
      <td class="mono" style="${r.days>90?'color:var(--red); font-weight:700;':''}">${r.days}</td>
      <td class="mono">${fmt(r.amount)}</td><td>${r.bucket}</td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد ذمم دائنة غير مسددة حتى هذا التاريخ</td></tr>`;
  }
  return data;
}
function renderARAPModule(){
  if(!$('#view-accounting')) return;
  if($('#arap-asof') && !$('#arap-asof').value) $('#arap-asof').value = todayISO();
  const asOf = $('#arap-asof')?.value || todayISO();
  renderARAging(asOf);
  renderAPAging(asOf);
}
$('#arap-asof')?.addEventListener('change', renderARAPModule);
$('#btn-export-ar')?.addEventListener('click', ()=>{
  const asOf = $('#arap-asof')?.value || todayISO();
  const data = buildARAging(asOf);
  csvDownload(`ذمم_العملاء_المدينة_${asOf}.csv`, [
    ['العميل','رقم الهوية','الجوال','تاريخ الاستحقاق','أيام التأخر','المتبقي','الفئة العمرية'],
    ...data.rows.map(r=>[r.name, r.clientId, r.phone, r.dueDate, r.days, r.amount, r.bucket])
  ]);
});
$('#btn-print-ar')?.addEventListener('click', ()=>{
  const asOf = $('#arap-asof')?.value || todayISO();
  renderARAging(asOf);
  printAccountingReport(`ذمم العملاء المدينة كما في ${formatDateDisplay(asOf)||asOf}`, '#ar-table');
});
$('#btn-export-ap')?.addEventListener('click', ()=>{
  const asOf = $('#arap-asof')?.value || todayISO();
  const data = buildAPAging(asOf);
  csvDownload(`ذمم_الموردين_الدائنة_${asOf}.csv`, [
    ['المورد','رقم الفاتورة','تاريخ الفاتورة','أيام التأخر','المبلغ','الفئة العمرية'],
    ...data.rows.map(r=>[r.supplierName, r.invoiceNo, r.date, r.days, r.amount, r.bucket])
  ]);
});
$('#btn-print-ap')?.addEventListener('click', ()=>{
  const asOf = $('#arap-asof')?.value || todayISO();
  renderAPAging(asOf);
  printAccountingReport(`ذمم الموردين الدائنة كما في ${formatDateDisplay(asOf)||asOf}`, '#ap-table');
});

function renderAccSummaryCards(bs, ni, rev, exp){
  $('#acc-summary-cards').innerHTML = `
    <div class="card"><div class="k">إجمالي الأصول</div><div class="v teal">${fmt(bs.totalAssets)}</div></div>
    <div class="card"><div class="k">إجمالي الخصوم</div><div class="v red">${fmt(bs.totalLiabilities)}</div></div>
    <div class="card"><div class="k">إجمالي حقوق الملكية</div><div class="v gold">${fmt(bs.totalEquity)}</div></div>
    <div class="card"><div class="k">إيرادات الفترة</div><div class="v teal">${fmt(rev)}</div></div>
    <div class="card"><div class="k">مصروفات الفترة</div><div class="v red">${fmt(exp)}</div></div>
    <div class="card"><div class="k">صافي ربح/خسارة الفترة</div><div class="v ${ni<0?'red':'gold'}">${fmt(ni)}</div></div>
  `;
}

function accRow(label, value, opts){
  opts = opts || {};
  const style = opts.total ? 'font-weight:800; border-top:1px solid var(--border);' : (opts.indent ? 'color:var(--text-muted);' : '');
  const pad = opts.indent ? 'padding-right:22px;' : '';
  return `<tr style="${style}"><td style="${pad}">${escapeHtml(label)}</td><td class="mono" style="text-align:left;">${value===''?'':fmt(value)}</td></tr>`;
}
function accHeaderRow(label){
  return `<tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">${escapeHtml(label)}</td></tr>`;
}

function renderIncomeStatementTable(from, to){
  const revB = revenueBreakdown(from, to);
  const returns = salesReturnsTotal(from, to);
  const grossRevenue = Object.values(revB).reduce((a,b)=>a+b,0);
  const netRevenue = grossRevenue - returns;
  const expB = expenseBreakdown(from, to);
  const totalExpense = Object.values(expB).reduce((a,b)=>a+b,0);
  const dep = journalInRange(from,to).filter(j=>j.type==='depreciation').reduce((s,j)=>s+num(j.amount),0);
  const acc = journalInRange(from,to).filter(j=>j.type==='accrued').reduce((s,j)=>s+num(j.amount),0);
  const rj  = journalInRange(from,to).filter(j=>j.type==='readj').reduce((s,j)=>s+num(j.amount),0);
  const netIncome = netRevenue - totalExpense - dep - acc + rj;

  let html = accHeaderRow('الإيرادات (حسب نوع الدورة، على أساس الاستحقاق)');
  Object.entries(revB).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{ html += accRow(k, v, {indent:true}); });
  html += accRow('إجمالي الإيرادات', grossRevenue);
  if(returns>0) html += accRow('يُخصم: مردودات مبيعات', -returns, {indent:true});
  html += accRow('صافي الإيرادات', netRevenue, {total:true});

  html += accHeaderRow('المصروفات التشغيلية (حسب التصنيف)');
  Object.entries(expB).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{ html += accRow(k, v, {indent:true}); });
  if(dep>0) html += accRow('مصروف الإهلاك (قيد يدوي)', dep, {indent:true});
  if(acc>0) html += accRow('مصروف مستحق (قيد يدوي)', acc, {indent:true});
  html += accRow('إجمالي المصروفات', totalExpense+dep+acc, {total:true});

  if(rj) html += accRow('تسويات أخرى على الأرباح (قيد يدوي)', rj);
  html += accHeaderRow('');
  html += accRow('صافي الربح / (الخسارة) عن الفترة', netIncome, {total:true});

  $('#acc-income-table tbody').innerHTML = html;
  return { netRevenue, totalExpense: totalExpense+dep+acc, netIncome, grossRevenue };
}

/* ---- قائمة الدخل (الأرباح والخسائر) في شاشة التقارير، حسب فلتر الفترة rp-from/rp-to ----
   مبنية على نفس دوال قائمة الدخل المحاسبية (أساس الاستحقاق)، لكنها مستقلة عن شاشة
   المحاسبة لتظهر مباشرة في تبويب التقارير بالفلتر المحدد أعلاه. */
function pnlData(from, to){
  const revB = revenueBreakdown(from, to);
  const returns = salesReturnsTotal(from, to);
  const grossRevenue = Object.values(revB).reduce((a,b)=>a+b,0);
  const netRevenue = grossRevenue - returns;
  const expB = expenseBreakdown(from, to);
  const totalExpense = Object.values(expB).reduce((a,b)=>a+b,0);
  const dep = journalInRange(from,to).filter(j=>j.type==='depreciation').reduce((s,j)=>s+num(j.amount),0);
  const acc = journalInRange(from,to).filter(j=>j.type==='accrued').reduce((s,j)=>s+num(j.amount),0);
  const rj  = journalInRange(from,to).filter(j=>j.type==='readj').reduce((s,j)=>s+num(j.amount),0);
  const netIncome = netRevenue - totalExpense - dep - acc + rj;
  return { revB, returns, grossRevenue, netRevenue, expB, totalExpense, dep, acc, rj, netIncome };
}
function renderPnL(from, to){
  const tbody = $('#pnl-body');
  if(!tbody) return;
  const d = pnlData(from, to);
  const periodLabel = `${from ? from : 'البداية'} ← ${to ? to : 'الآن'}`;
  let html = accHeaderRow(`الإيرادات (حسب نوع الدورة) — الفترة: ${periodLabel}`);
  Object.entries(d.revB).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{ html += accRow(k, v, {indent:true}); });
  html += accRow('إجمالي الإيرادات', d.grossRevenue);
  if(d.returns>0) html += accRow('يُخصم: مردودات مبيعات', -d.returns, {indent:true});
  html += accRow('صافي الإيرادات', d.netRevenue, {total:true});

  html += accHeaderRow('المصروفات التشغيلية (حسب التصنيف)');
  Object.entries(d.expB).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{ html += accRow(k, v, {indent:true}); });
  if(d.dep>0) html += accRow('مصروف الإهلاك (قيد يدوي)', d.dep, {indent:true});
  if(d.acc>0) html += accRow('مصروف مستحق (قيد يدوي)', d.acc, {indent:true});
  html += accRow('إجمالي المصروفات', d.totalExpense + d.dep + d.acc, {total:true});

  if(d.rj) html += accRow('تسويات أخرى على الأرباح (قيد يدوي)', d.rj);
  html += accHeaderRow('');
  html += accRow('صافي الربح / (الخسارة) عن الفترة', d.netIncome, {total:true});
  tbody.innerHTML = html;
}
$('#btn-export-pnl')?.addEventListener('click', ()=>{
  const from = $('#rp-from').value || 'البداية';
  const to = $('#rp-to').value || 'الآن';
  const d = pnlData($('#rp-from').value, $('#rp-to').value);
  const lines = [['بند','القيمة (ر.س)']];
  Object.entries(d.revB).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=> lines.push([`إيرادات: ${k}`, v]));
  lines.push(['إجمالي الإيرادات', d.grossRevenue]);
  if(d.returns>0) lines.push(['مردودات مبيعات (خصم)', -d.returns]);
  lines.push(['صافي الإيرادات', d.netRevenue]);
  Object.entries(d.expB).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=> lines.push([`مصروف: ${k}`, v]));
  if(d.dep>0) lines.push(['مصروف الإهلاك (قيد يدوي)', d.dep]);
  if(d.acc>0) lines.push(['مصروف مستحق (قيد يدوي)', d.acc]);
  lines.push(['إجمالي المصروفات', d.totalExpense + d.dep + d.acc]);
  if(d.rj) lines.push(['تسويات أخرى (قيد يدوي)', d.rj]);
  lines.push(['صافي الربح / (الخسارة)', d.netIncome]);
  const csv = '\uFEFF'+[['قائمة الدخل حسب الفترة', `من ${from} إلى ${to}`], [], ...lines].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `قائمة_الدخل_${from}_${to}.csv`;
  a.click();
});

function renderBalanceSheetTable(asOf, bs){
  let html = accHeaderRow('الأصول المتداولة');
  html += accRow('الخزنة (كاش)', bs.cash, {indent:true});
  html += accRow('البنك', bs.bank, {indent:true});
  html += accRow('الشبكة', bs.network, {indent:true});
  html += accRow('ذمم العملاء (مدينون)', bs.receivables, {indent:true});
  html += accRow('مخزون الحقائب', bs.bagInventory, {indent:true});
  if(bs.bagCustodyAsset>0) html += accRow('سلفة حقائب مسلَّمة تفوق المحصَّل', bs.bagCustodyAsset, {indent:true});
  const currentAssets = bs.cash+bs.bank+bs.network+bs.receivables+bs.bagInventory+bs.bagCustodyAsset;
  html += accRow('إجمالي الأصول المتداولة', currentAssets);

  if(bs.fixedAssetsGross>0){
    html += accHeaderRow('الأصول غير المتداولة');
    html += accRow('الأصول الثابتة (بالتكلفة)', bs.fixedAssetsGross, {indent:true});
    html += accRow('يُخصم: مجمّع الإهلاك', -bs.accumDep, {indent:true});
    html += accRow('صافي الأصول الثابتة', Math.max(0,bs.fixedAssetsNet));
  }
  html += accRow('إجمالي الأصول', bs.totalAssets, {total:true});

  html += accHeaderRow('الخصوم');
  html += accRow('أمانات حقائب لدى العملاء (التزام تسليم)', bs.bagCustody, {indent:true});
  if(bs.loans>0) html += accRow('قروض (مصنّفة تلقائياً من ملاحظات الحركات)', bs.loans, {indent:true});
  if(bs.accrued>0) html += accRow('مصروفات مستحقة (قيد يدوي)', bs.accrued, {indent:true});
  if(bs.otherLiab>0) html += accRow('التزامات / ذمم دائنة أخرى (قيد يدوي)', bs.otherLiab, {indent:true});
  html += accRow('إجمالي الخصوم', bs.totalLiabilities, {total:true});

  html += accHeaderRow('حقوق الملكية');
  html += accRow('الأرباح المرحلة (متراكمة منذ البداية)', bs.retainedEarnings, {indent:true});
  html += accRow('رأس المال ومساهمات أخرى (رصيد متبقٍّ)', bs.ownerCapital, {indent:true});
  html += accRow('إجمالي حقوق الملكية', bs.totalEquity, {total:true});
  html += accRow('إجمالي الخصوم وحقوق الملكية', bs.totalLiabilities+bs.totalEquity, {total:true});

  $('#acc-balance-table tbody').innerHTML = html;
  const diff = Math.round((bs.totalAssets - (bs.totalLiabilities+bs.totalEquity))*100)/100;
  $('#acc-balance-check').innerHTML = Math.abs(diff)<0.02
    ? `<span class="stamp paid">✓ الميزانية متوازنة: الأصول = الخصوم + حقوق الملكية</span>`
    : `<span class="stamp owe">⚠ فرق توازن قدره ${fmt(diff)} ريال — راجع القيود اليدوية</span>`;
}

function renderTrialBalanceTable(asOf, bs, incomeStmt, periodFrom){
  // الأرباح المرحلة تُحسب حتى بداية الفترة المعروضة (اليوم السابق لبدايتها) وليس حتى نهايتها،
  // لأن "صافي إيرادات الفترة" و"إجمالي مصروفات الفترة" يُعرضان كسطرين مستقلين بالجدول —
  // استخدام الأرباح المرحلة حتى نهاية الفترة كان يعني إدراج صافي دخل الفترة مرتين في الميزان.
  const retainedEarningsStart = periodFrom ? retainedEarningsAsOf(addDaysISO(periodFrom, -1)) : bs.retainedEarnings;
  const rows = [
    ['الخزنة (كاش)','أصول', bs.cash, 0],
    ['البنك','أصول', bs.bank, 0],
    ['الشبكة','أصول', bs.network, 0],
    ['ذمم العملاء (مدينون)','أصول', bs.receivables, 0],
    ['مخزون الحقائب','أصول', bs.bagInventory, 0],
    ['الأصول الثابتة (بالتكلفة)','أصول', bs.fixedAssetsGross, 0],
    ['مجمّع الإهلاك (مقابل أصول)','أصول مقابلة', 0, bs.accumDep],
    ['أمانات حقائب لدى العملاء','خصوم', 0, bs.bagCustody],
    ['قروض','خصوم', 0, bs.loans],
    ['مصروفات مستحقة','خصوم', 0, bs.accrued],
    ['التزامات أخرى','خصوم', 0, bs.otherLiab],
    ['الأرباح المرحلة','حقوق ملكية', 0, Math.max(0,retainedEarningsStart)],
    ['رأس المال ومساهمات أخرى','حقوق ملكية', bs.ownerCapital<0?-bs.ownerCapital:0, bs.ownerCapital>0?bs.ownerCapital:0],
    ['صافي إيرادات الفترة','إيرادات', 0, incomeStmt.netRevenue],
    ['إجمالي مصروفات الفترة','مصروفات', incomeStmt.totalExpense, 0],
  ];
  if(retainedEarningsStart<0) { rows.find(r=>r[0]==='الأرباح المرحلة')[2] = -retainedEarningsStart; rows.find(r=>r[0]==='الأرباح المرحلة')[3]=0; }
  let totalDr=0, totalCr=0;
  const bodyHtml = rows.filter(r=>r[2]!==0 || r[3]!==0).map(([name,cat,dr,cr])=>{
    totalDr += dr; totalCr += cr;
    return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(cat)}</td><td class="mono">${dr?fmt(dr):''}</td><td class="mono">${cr?fmt(cr):''}</td></tr>`;
  }).join('') + `<tr style="font-weight:800; border-top:2px solid var(--border);"><td>الإجمالي</td><td></td><td class="mono">${fmt(totalDr)}</td><td class="mono">${fmt(totalCr)}</td></tr>`;
  $('#acc-trial-body').innerHTML = bodyHtml;
}

function renderQuarterlyTable(year){
  const quarters = ['q1','q2','q3','q4'];
  const ranges = quarters.map(q=>({year, period:q, ...(function(){
    const map = { q1:[`${year}-01-01`,`${year}-03-31`], q2:[`${year}-04-01`,`${year}-06-30`], q3:[`${year}-07-01`,`${year}-09-30`], q4:[`${year}-10-01`,`${year}-12-31`] };
    return {from:map[q][0], to:map[q][1]};
  })()}));
  const data = ranges.map(r=>{
    const revB = revenueBreakdown(r.from, r.to);
    const rev = Object.values(revB).reduce((a,b)=>a+b,0) - salesReturnsTotal(r.from,r.to);
    const expB = expenseBreakdown(r.from, r.to);
    const exp = Object.values(expB).reduce((a,b)=>a+b,0);
    const ni = netIncomeOf(r.from, r.to);
    return { label: accPeriodLabel(r.period), rev, exp, ni };
  });
  const totalRev = data.reduce((s,d)=>s+d.rev,0), totalExp = data.reduce((s,d)=>s+d.exp,0), totalNi = data.reduce((s,d)=>s+d.ni,0);
  let html = `<thead><tr><th>البند</th>${data.map(d=>`<th>${d.label}</th>`).join('')}<th>الإجمالي السنوي</th></tr></thead><tbody>`;
  html += `<tr><td>الإيرادات</td>${data.map(d=>`<td class="mono">${fmt(d.rev)}</td>`).join('')}<td class="mono" style="font-weight:800;">${fmt(totalRev)}</td></tr>`;
  html += `<tr><td>المصروفات</td>${data.map(d=>`<td class="mono">${fmt(d.exp)}</td>`).join('')}<td class="mono" style="font-weight:800;">${fmt(totalExp)}</td></tr>`;
  html += `<tr style="font-weight:800;"><td>صافي الربح/الخسارة</td>${data.map(d=>`<td class="mono ${d.ni<0?'red':''}">${fmt(d.ni)}</td>`).join('')}<td class="mono ${totalNi<0?'red':''}">${fmt(totalNi)}</td></tr>`;
  html += `</tbody>`;
  $('#acc-quarterly-table').innerHTML = html;
  drawLineChart('#chart-acc-quarterly', data.map(d=>d.label), [
    {name:'الإيرادات', color:'var(--teal)', values:data.map(d=>Math.round(d.rev*100)/100)},
    {name:'المصروفات', color:'var(--red)', values:data.map(d=>Math.round(d.exp*100)/100)},
    {name:'الصافي', color:'var(--gold-dark)', values:data.map(d=>Math.round(d.ni*100)/100)},
  ]);
}

function renderJournalTable(){
  const typeLabels = {fixedasset:'إضافة أصل ثابت', depreciation:'قيد إهلاك', accrued:'مصروف مستحق', otherliability:'التزام / ذمم دائنة', readj:'تسوية أرباح مرحلة'};
  const sorted = journalEntries.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  $('#acc-journal-body').innerHTML = sorted.map(j=>`
    <tr>
      <td class="mono">${escapeHtml(j.date||'—')}</td>
      <td><span class="stamp ${j.type==='readj'||j.type==='depreciation'||j.type==='accrued' ? 'owe':'paid'}">${typeLabels[j.type]||j.type}</span></td>
      <td>${escapeHtml(j.description||'—')}${j.linkedDEId ? ' <span class="hint" style="color:var(--teal,#0f8a6b);">🔗 مُرحّل للقيد المزدوج</span>' : ''}</td>
      <td class="mono">${fmt(num(j.amount))}</td>
      <td><button class="btn btn-danger btn-sm" data-jdel="${j.id}">${tr('delete')}</button></td>
    </tr>`).join('');
  $('#acc-journal-empty').style.display = sorted.length ? 'none' : '';
}

function renderAccounting(){
  if(!$('#view-accounting')) return;
  populateAccYearSelect();
  const { year, period, from, to, asOf } = accSelectedRange();
  $('#acc-period-label').textContent = `الفترة المعروضة: من ${formatDateDisplay(from)} إلى ${formatDateDisplay(to)}`;
  const bs = buildBalanceSheet(asOf);
  const incomeStmt = renderIncomeStatementTable(from, to);
  renderAccSummaryCards(bs, incomeStmt.netIncome, incomeStmt.netRevenue, incomeStmt.totalExpense);
  renderBalanceSheetTable(asOf, bs);
  renderVatReturnTable(from, to);
  renderCashFlowTable(from, to);
  renderARAPModule();
  renderTrialBalanceTable(asOf, bs, incomeStmt, from);
  renderQuarterlyTable(year);
  renderJournalTable();
  renderDoubleEntryModule();
}
['#acc-year','#acc-period'].forEach(sel=>{ if($(sel)) $(sel).addEventListener('change', renderAccounting); });

$('#jf-date') && ($('#jf-date').value = todayISO());
$('#btn-add-journal')?.addEventListener('click', async ()=>{
  const type = $('#jf-type').value;
  const date = $('#jf-date').value || todayISO();
  let amount = num($('#jf-amount').value);
  const description = $('#jf-desc').value.trim();
  if(type!=='readj' && amount<=0){ showToast('أدخل مبلغاً صحيحاً أكبر من صفر'); return; }
  if(type==='readj' && amount===0){ showToast('أدخل قيمة التسوية (يمكن أن تكون سالبة)'); return; }
  if(!description){ showToast('أدخل بياناً موجزاً لهذا القيد'); return; }
  await withBtnLoading($('#btn-add-journal'), async ()=>{
    const entry = { id: uid(), createdAt: Date.now(), type, date, amount, description };
    journalEntries.push(entry);
    const posted = autoPostLegacyEntry(entry);
    await saveJournalEntries();
    if(posted) await saveJournalDE();
    await logAudit('add','المحاسبة', `تمت إضافة قيد يدوي (${$('#jf-type').selectedOptions[0].textContent}): ${description} بمبلغ ${fmt(amount)} ﷼${posted ? ' — ورُحّل تلقائياً لدليل الحسابات' : ''}`);
    $('#jf-amount').value=''; $('#jf-desc').value='';
    showToast(posted ? 'تمت إضافة القيد وترحيله تلقائياً للقيد المزدوج' : 'تمت إضافة القيد');
    renderAccounting();
  });
});
$('#acc-journal-body')?.addEventListener('click', async e=>{
  const btn = e.target.closest('[data-jdel]');
  if(!btn) return;
  const j = journalEntries.find(x=>x.id===btn.dataset.jdel);
  if(!j) return;
  if(!await customConfirm('هل تريد حذف هذا القيد اليدوي؟ سيُحذف معه القيد المزدوج المرتبط به تلقائياً إن وُجد.')) return;
  if(j.linkedDEId){ journalDE = journalDE.filter(x=>x.id!==j.linkedDEId); await saveJournalDE(); }
  journalEntries = journalEntries.filter(x=>x.id!==j.id);
  await saveJournalEntries();
  await logAudit('delete','المحاسبة', `تم حذف قيد يدوي: ${j.description||''} بمبلغ ${fmt(num(j.amount))} ﷼`);
  renderAccounting();
  showToast('تم حذف القيد');
});

/* ================================================================
   إرسال التقارير بالإيميل من لوحة التحكم (جدول التقارير + التقرير اليومي)
   ================================================================ */
// إرسال أي تقرير كملف PDF بالإيميل — دالة عامة لجدول التقارير في لوحة التحكم. المستلمون
// (To + CC) يُقرأون تلقائياً من إعداد "إرسال التقارير بالإيميل" الموحّد فى شاشة الإعدادات.
async function emailPdfReport(subject, bodyHtml, filename){
  const recipients = reportEmailRecipients();
  if(!recipients) return;
  let pdfFile;
  try{
    pdfFile = await htmlBodyToPdfFile(bodyHtml, { title: subject, filename });
  }catch(e){
    console.error(e);
    showToast('تعذّر توليد PDF — تأكد من الاتصال بالإنترنت ثم أعد المحاولة');
    return;
  }
  const attachmentBase64 = await fileToBase64(pdfFile);
  const emailBodyHtml = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif; line-height:1.9;"><p>مرفق التقرير المطلوب: <b>${escapeHtml(subject)}</b></p></div>`;
  try{
    const res = await serverFetch('/api/email/report', {
      method:'POST',
      body: JSON.stringify({ to: [recipients.to], cc: recipients.cc, subject, bodyHtml: emailBodyHtml, attachmentBase64, attachmentName: pdfFile.name, attachmentType: 'application/pdf' }),
    });
    if(res.ok){
      showToast(`تم إرسال التقرير بالإيميل إلى ${recipients.all.join(', ')}`);
      await logAudit('edit','التقارير', `تم إرسال تقرير "${subject}" بالإيميل إلى ${recipients.all.join(', ')}`);
    }else{
      const data = await res.json().catch(()=>({}));
      showToast(`تعذّر إرسال التقرير بالإيميل: ${data.error || 'خطأ غير معروف'}`);
    }
  }catch(e){
    console.error('فشل إرسال إيميل التقرير:', e);
    showToast('تعذّر إرسال التقرير بالإيميل — تحقق من الاتصال');
  }
}

/* ---- قائمة التقارير المتاحة في جدول لوحة التحكم ---- */
const EMAIL_REPORTS_DEFS = [
  {
    id:'daily', label:'التقرير اليومي',
    desc:'كل عمليات اليوم: العملاء الجدد بأسمائهم ومبالغهم وطرق الدفع، المبالغ المحصّلة، المصروفات، المشتريات، شراء/إضافة الحقائب، مردودات المبيعات، وتعديل/حذف العملاء القدام.',
    param:{type:'date', label:'تاريخ اليوم'}
  },
  {
    id:'monthly', label:'التقرير الشهري (تسجيلات ومبالغ)',
    desc:'عدد العملاء المسجّلين والمبالغ المدفوعة (نقدي/شبكة/بنك) لكل يوم من الشهر.',
    param:{type:'month', label:'الشهر'}
  },
  {
    id:'vault-out', label:'الحركات المالية الصادرة',
    desc:'كل المصروفات (صادر) خلال الشهر، عدا ما يخص تمويل/شراء الحقائب.',
    param:{type:'month', label:'الشهر'}
  },
  {
    id:'bags', label:'الحقائب المشتراة',
    desc:'حقائب أضافها المركز للمخزون + عملاء اشتروا حقائبهم (مباشرة أو من المخزون) خلال الشهر.',
    param:{type:'month', label:'الشهر'}
  },
  {
    id:'vat', label:'الإقرار الضريبي (ضريبة القيمة المضافة)',
    desc:'إقرار ربع سنوي: المبيعات والمردودات والمشتريات وصافي الضريبة المستحقة للهيئة.',
    param:{type:'quarter', label:'الفترة'}
  },
  {
    id:'period', label:'الإيرادات والمصروفات حسب الفترة',
    desc:'إجمالي الإيرادات والمصروفات وصافي الفترة وعدد العملاء المسجّلين، مع تفصيل الوارد والصادر.',
    param:{type:'range', label:'الفترة'}
  },
];
function emailReportsParamHtml(def){
  const p = def.param;
  if(!p) return '<span style="color:var(--text-muted);">—</span>';
  if(p.type==='date'){
    return `<div class="field" style="max-width:175px;"><label>${escapeHtml(p.label)}</label><input type="date" data-er-date value="${todayISO()}"></div>`;
  }
  if(p.type==='month'){
    return `<div class="field" style="max-width:175px;"><label>${escapeHtml(p.label)}</label><input type="month" data-er-month value="${lastCompleteMonthKey()}"></div>`;
  }
  if(p.type==='quarter'){
    const year = new Date().getFullYear();
    const curQ = Math.floor(new Date().getMonth()/3) + 1;
    const qOptions = [1,2,3,4].map(q=>`<option value="${q}"${q===curQ?' selected':''}>الربع ${q}${q===1?' (يناير–مارس)':q===2?' (أبريل–يونيو)':q===3?' (يوليو–سبتمبر)':' (أكتوبر–ديسمبر)'}</option>`).join('');
    return `<div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap;">
      <div class="field" style="max-width:110px;"><label>السنة</label><input type="number" data-er-year value="${year}" min="2020" max="2100" style="font-family:var(--font-mono);"></div>
      <div class="field" style="max-width:200px;"><label>${escapeHtml(p.label)}</label><select data-er-quarter>${qOptions}</select></div>
    </div>`;
  }
  if(p.type==='range'){
    const now = new Date();
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    return `<div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap;">
      <div class="field" style="max-width:155px;"><label>من تاريخ</label><input type="date" data-er-from value="${firstOfMonth}"></div>
      <div class="field" style="max-width:155px;"><label>إلى تاريخ</label><input type="date" data-er-to value="${todayISO()}"></div>
    </div>`;
  }
  return '<span style="color:var(--text-muted);">—</span>';
}
function renderReportsEmailList(){
  const tbody = $('#reports-email-list');
  if(!tbody) return;
  tbody.innerHTML = EMAIL_REPORTS_DEFS.map(def=>`
    <tr>
      <td style="min-width:280px;"><b>${escapeHtml(def.label)}</b><div style="font-size:12px; color:var(--text-muted); margin-top:3px; line-height:1.5;">${escapeHtml(def.desc)}</div></td>
      <td style="min-width:230px;">${emailReportsParamHtml(def)}</td>
      <td style="text-align:left; white-space:nowrap;"><button class="btn btn-ghost btn-sm" data-emailreport="${def.id}">✉️ إرسال بالإيميل</button></td>
    </tr>`).join('');
}
// يبني { subject, filename, bodyHtml } للتقرير المختار من جدول لوحة التحكم حسب الفترة في صفه.
function buildDashboardEmailReport(id, rowEl){
  const val = sel => { const el = rowEl.querySelector(sel); return el ? el.value : ''; };
  switch(id){
    case 'daily': {
      const dateStr = val('[data-er-date]') || todayISO();
      return { subject:'التقرير اليومي — ' + formatDateDisplay(dateStr), filename:`التقرير_اليومي_${dateStr}.pdf`, bodyHtml: buildDailyReportBodyHtml(dateStr) };
    }
    case 'monthly': {
      const ym = val('[data-er-month]') || lastCompleteMonthKey();
      const label = monthLabelAr(ym);
      return { subject:'التقرير الشهري — '+label, filename:`تقرير_شهري_تسجيلات_ومبالغ_${ym}.pdf`, bodyHtml: monthlyClientsReportBodyHtml(ym) };
    }
    case 'vault-out': {
      const ym = val('[data-er-month]') || lastCompleteMonthKey();
      const [yStr, mStr] = ym.split('-');
      const daysInMonth = new Date(Number(yStr), Number(mStr), 0).getDate();
      const from = `${ym}-01`, to = `${ym}-${String(daysInMonth).padStart(2,'0')}`;
      const label = monthLabelAr(ym);
      return { subject:'الحركات المالية الصادرة — '+label, filename:`الحركات_الصادرة_${ym}.pdf`, bodyHtml: vaultOutReportBodyHtml(from, to, label) };
    }
    case 'bags': {
      const ym = val('[data-er-month]') || lastCompleteMonthKey();
      const [yStr, mStr] = ym.split('-');
      const daysInMonth = new Date(Number(yStr), Number(mStr), 0).getDate();
      const from = `${ym}-01`, to = `${ym}-${String(daysInMonth).padStart(2,'0')}`;
      const label = monthLabelAr(ym);
      return { subject:'الحقائب المشتراة — '+label, filename:`الحقائب_المشتراة_${ym}.pdf`, bodyHtml: bagsPurchasedReportBodyHtml(from, to, label) };
    }
    case 'vat': {
      const year = val('[data-er-year]') || String(new Date().getFullYear());
      const q = val('[data-er-quarter]') || '1';
      const { from, to, label } = quarterDateRange(year, q);
      const r = buildVatReturn(from, to);
      return { subject:'الإقرار الضريبي — '+label, filename:`الاقرار_الضريبي_${year}_Q${q}.pdf`, bodyHtml: vatReturnReportBodyHtml(r, from, to, label) };
    }
    case 'period': {
      const from = val('[data-er-from]') || todayISO();
      const to = val('[data-er-to]') || todayISO();
      return { subject:'الإيرادات والمصروفات حسب الفترة', filename:`تقرير_الفترة_${from}_${to}.pdf`, bodyHtml: buildPeriodReportBodyHtml(from, to) };
    }
  }
  return null;
}
document.addEventListener('click', async e=>{
  const btn = e.target.closest('[data-emailreport]');
  if(!btn) return;
  const def = EMAIL_REPORTS_DEFS.find(r=>r.id===btn.dataset.emailreport);
  if(!def) return;
  const rowEl = btn.closest('tr');
  const rep = buildDashboardEmailReport(def.id, rowEl);
  if(!rep){ showToast('تعذّر تجهيز التقرير'); return; }
  await emailPdfReport(rep.subject, rep.bodyHtml, rep.filename);
});

/* ---- التقرير اليومي: كل عمليات اليوم ---- */
const DAILY_REPORT_EDIT_OLD_DAYS = 2;   // تعديل "عميل قديم": سجّله أقدم من هذه المدة (بالأيام)
const DAILY_REPORT_DELETE_OLD_DAYS = 1; // حذف "عميل قديم": سجّله أقدم من هذه المدة (بالأيام)
// من سجل العمليات (auditLog)، نستخرج تعديلات/حذف العملاء التي وقعت فعلاً على عملاء قدام
// (سُجّلوا قبل المدة المحددة) — قدَم العميل يُعرف من createdAt مباشرة أو من تاريخ آخر
// "إضافة" لنفس الاسم في سجل العمليات (للعملاء المحذوفين الذين لم يعودوا موجودين).
function dailyReportOldClientEntries(dateStr, kind){
  const dayStart = Date.parse(dateStr+'T00:00:00');
  const dayEnd = dayStart + 24*3600*1000;
  const days = kind==='edit' ? DAILY_REPORT_EDIT_OLD_DAYS : DAILY_REPORT_DELETE_OLD_DAYS;
  const entries = auditLog.filter(a=> a.action===kind && a.section==='العملاء' && a.ts>=dayStart && a.ts<dayEnd);
  const nameFrom = desc => { const m = /(?:بيانات العميل):\s*(.*)$/.exec(desc||''); return m ? m[1].trim() : ''; };
  const addedAtOf = name => {
    if(!name) return null;
    const c = clients.find(x=>x.name===name);
    if(c && c.createdAt) return c.createdAt;
    for(let i=auditLog.length-1; i>=0; i--){
      const a = auditLog[i];
      if(a.action==='add' && a.section==='العملاء' && a.description && a.description.includes(name)) return a.ts;
    }
    return null;
  };
  return entries.filter(a=>{
    const at = addedAtOf(nameFrom(a.description));
    return at && (a.ts - at) > days*24*3600*1000;
  });
}
function buildDailyReportBodyHtml(dateStr){
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const weekday = WEEKDAY_NAMES_AR[new Date(dateStr+'T00:00:00').getDay()];
  const dateLabel = `${formatDateDisplay(dateStr)} (${weekday})`;

  const newClients = clients.filter(c=>c.date===dateStr);
  const dayIn = vaultTx.filter(t=>t.type==='in' && !t.isReturn && t.date===dateStr);
  const dayExp = vaultTx.filter(t=>t.type==='out' && !t.isReturn && t.date===dateStr && !String(t.category||'').includes('حقائب'));
  const dayBagFund = vaultTx.filter(t=>t.type==='out' && !t.isReturn && t.date===dateStr && String(t.category||'').includes('حقائب'));
  const dayReturns = vaultTx.filter(t=>t.isReturn && t.date===dateStr);
  const dayPurchases = (typeof purchases!=='undefined'?purchases:[]).filter(p=>p.date===dateStr);
  const bagStockDay = bagStock.filter(b=> b.type!=='issue' && b.date===dateStr);
  const bagBuyers = clients.filter(c=> ((c.bagSource==='buy'&&c.bagStatus==='purchased')||c.bagSource==='stock') && c.bagPurchaseDate===dateStr);
  const oldEdits = dailyReportOldClientEntries(dateStr, 'edit');
  const oldDeletes = dailyReportOldClientEntries(dateStr, 'delete');

  const income = dayIn.reduce((s,t)=>s+num(t.amount),0);
  const expense = dayExp.reduce((s,t)=>s+num(t.amount),0);
  const returnsTotal = dayReturns.reduce((s,t)=>s+num(t.amount),0);
  const purchTotal = dayPurchases.reduce((s,p)=>s+num(p.total),0);
  const bagFundTotal = dayBagFund.reduce((s,t)=>s+num(t.amount),0);
  const stockQty = bagStockDay.reduce((s,b)=>s+num(b.qty),0);
  const bagValue = bagBuyers.reduce((s,c)=>s+num(c.bagPrice),0);
  const cash = dayIn.filter(t=>(t.destination||'vault')==='vault').reduce((s,t)=>s+num(t.amount),0);
  const network = dayIn.filter(t=>(t.destination||'vault')==='network').reduce((s,t)=>s+num(t.amount),0);
  const bank = dayIn.filter(t=>(t.destination||'vault')==='bank').reduce((s,t)=>s+num(t.amount),0);

  const row = (label, value, opts={}) => `<tr${opts.total?` style="font-weight:800; background:#F1F4F7;"`:''}><td>${label}</td><td class="mono" style="text-align:left;">${value}</td></tr>`;
  const emptyRow = (colspan, msg)=> `<tr><td colspan="${colspan}" style="text-align:center; color:#8A94A3; padding:14px;">${msg}</td></tr>`;
  const sumRow = (colspan, label, value) => `<tr style="font-weight:800; background:#F1F4F7;"><td colspan="${colspan}">${label}</td><td class="mono">${value}</td></tr>`;

  const newClientsHtml = newClients.length ? newClients.map(c=>`
    <tr>
      <td>${escapeHtml(c.name||'—')}</td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td>${escapeHtml(c.courseType||'—')}</td>
      <td class="mono">${fmt(num(c.coursePrice))}</td>
      <td class="mono">${num(c.discount)>0? '-'+fmt(num(c.discount)) : '—'}</td>
      <td class="mono">${fmt(paidTotal(c))}</td>
      <td>${escapeHtml(paymentChannelsLabel(c)||'—')}</td>
      <td class="mono">${fmt(remaining(c))}</td>
    </tr>`).join('') : emptyRow(8, 'لا يوجد عملاء جدد في هذا اليوم');

  const expRows = dayExp.length ? dayExp.map(t=>`
    <tr>
      <td>${escapeHtml(t.category||'—')}</td>
      <td>${escapeHtml(t.recipientName||'—')}</td>
      <td>${escapeHtml(t.method||'—')}</td>
      <td class="mono">${escapeHtml(t.referenceNo||'—')}</td>
      <td class="mono">${fmt(num(t.amount))}</td>
    </tr>`).join('') : emptyRow(5, 'لا توجد مصروفات في هذا اليوم');

  const purchRows = dayPurchases.length ? dayPurchases.map(p=>`
    <tr>
      <td>${escapeHtml(p.supplierName||'—')}</td>
      <td class="mono">${escapeHtml(p.invoiceNo||'—')}</td>
      <td>${escapeHtml(p.method||'—')}</td>
      <td class="mono">${fmt(num(p.total))}</td>
    </tr>`).join('') : emptyRow(4, 'لا توجد مشتريات في هذا اليوم');

  const bagStockType = b => (b.type==='withdraw' ? 'سحب' : (b.type==='deposit' ? 'إيداع' : 'إضافة يدوية')) + (b.manualQty ? ' (عدد فعلي)' : '');
  const bagStockRows = bagStockDay.length ? bagStockDay.map(b=>`
    <tr>
      <td>${escapeHtml(bagStockType(b))}</td>
      <td class="mono">${fmt(num(b.amount!==undefined?b.amount:num(b.qty)*num(b.unitPrice)))}</td>
      <td class="mono">${num(b.qty)>0?'+':''}${num(b.qty)}</td>
      <td>${escapeHtml(b.method||'—')}</td>
    </tr>`).join('') : emptyRow(4, 'لا توجد عمليات إضافة لمخزون الحقائب في هذا اليوم');

  const bagBuyerRows = bagBuyers.length ? bagBuyers.map(c=>`
    <tr>
      <td>${escapeHtml(c.name||'—')}</td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td>${c.bagSource==='stock' ? 'من المخزون' : 'شراء مباشر'}</td>
      <td class="mono">${escapeHtml(c.bagInvoice||'—')}</td>
      <td class="mono">${fmt(num(c.bagPrice))}</td>
    </tr>`).join('') : emptyRow(5, 'لا يوجد عملاء اشتروا حقائبهم في هذا اليوم');

  const returnRows = dayReturns.length ? dayReturns.map(t=>`
    <tr>
      <td>${escapeHtml(t.clientName||t.clientId||'—')}</td>
      <td>${escapeHtml(t.method||'—')}</td>
      <td class="mono">${fmt(num(t.amount))}</td>
    </tr>`).join('') : emptyRow(3, 'لا توجد مردودات مبيعات في هذا اليوم');

  const auditRow = a => `<tr>
      <td>${escapeHtml((a.description||'').replace(/^تم (تعديل|حذف) بيانات العميل:\s*/, '') || '—')}</td>
      <td>${escapeHtml(a.user || 'غير معروف')}</td>
      <td class="mono">${escapeHtml(new Date(a.ts).toLocaleString('ar-EG'))}</td>
    </tr>`;
  const oldEditRows = oldEdits.length ? oldEdits.map(auditRow).join('') : emptyRow(3, 'لا يوجد تعديل على عملاء قدام في هذا اليوم');
  const oldDeleteRows = oldDeletes.length ? oldDeletes.map(auditRow).join('') : emptyRow(3, 'لا يوجد حذف لعملاء قدام في هذا اليوم');

  return `
    <div class="head">
      <div><h2>التقرير اليومي</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)} — ${escapeHtml(dateLabel)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">تاريخ الطباعة: ${escapeHtml(today)}<br>عدد العملاء الإجمالي بالنظام: ${clients.length} عميل</div>

    <h3 style="margin:18px 0 8px;">١. ملخص اليوم</h3>
    <table>
      <tbody>
        ${row('عملاء جدد', String(newClients.length))}
        ${row('المبالغ المحصّلة (وارد)', fmt(income)+' ﷼')}
        ${row('المصروفات', fmt(expense)+' ﷼')}
        ${row('مردودات المبيعات', fmt(returnsTotal)+' ﷼')}
        ${row('المشتريات', fmt(purchTotal)+' ﷼')}
        ${row('حقائب اشتراها عملاء', fmt(bagValue)+' ﷼')}
        ${row('إضافة/تمويل مخزون الحقائب', fmt(bagFundTotal)+' ﷼')}
        ${row('تعديل عملاء قدام (أقدم من '+DAILY_REPORT_EDIT_OLD_DAYS+' يوم)', String(oldEdits.length))}
        ${row('حذف عملاء قدام (أقدم من '+DAILY_REPORT_DELETE_OLD_DAYS+' يوم)', String(oldDeletes.length), {total:true})}
      </tbody>
    </table>

    <h3 style="margin:22px 0 8px;">٢. العملاء الجدد (${newClients.length})</h3>
    <table>
      <thead><tr><th>الاسم</th><th>رقم الهوية</th><th>الدورة</th><th>سعر الدورة</th><th>الخصم</th><th>المدفوع</th><th>طريقة الدفع</th><th>المتبقي</th></tr></thead>
      <tbody>
        ${newClientsHtml}
        ${newClients.length ? sumRow(5, 'إجمالي قيم العملاء الجدد', fmt(newClients.reduce((s,c)=>s+centerIncome(c),0))+' ﷼') : ''}
      </tbody>
    </table>

    <h3 style="margin:22px 0 8px;">٣. المبالغ المحصّلة اليوم (${dayIn.length} حركة)</h3>
    <table>
      <tbody>
        ${row('نقدي (كاش)', fmt(cash)+' ﷼')}
        ${row('شبكة', fmt(network)+' ﷼')}
        ${row('بنك', fmt(bank)+' ﷼')}
        ${row('الإجمالي المحصّل', fmt(income)+' ﷼', {total:true})}
      </tbody>
    </table>

    <h3 style="margin:22px 0 8px;">٤. المصروفات اليوم (${dayExp.length})</h3>
    <table>
      <thead><tr><th>التصنيف</th><th>مستلم المبلغ</th><th>طريقة الدفع</th><th>رقم المستند</th><th>المبلغ</th></tr></thead>
      <tbody>
        ${expRows}
        ${dayExp.length ? sumRow(4, 'إجمالي المصروفات', fmt(expense)+' ﷼') : ''}
      </tbody>
    </table>

    <h3 style="margin:22px 0 8px;">٥. المشتريات اليوم (${dayPurchases.length})</h3>
    <table>
      <thead><tr><th>المورد</th><th>رقم الفاتورة</th><th>طريقة الدفع</th><th>الإجمالي (شامل الضريبة)</th></tr></thead>
      <tbody>
        ${purchRows}
        ${dayPurchases.length ? sumRow(3, 'إجمالي المشتريات', fmt(purchTotal)+' ﷼') : ''}
      </tbody>
    </table>

    <h3 style="margin:22px 0 8px;">٦. الحقائب</h3>
    <div style="font-size:13px; color:#66707E; margin:6px 0;">أولاً: إضافة/تمويل مخزون الحقائب (${bagStockDay.length} عملية)</div>
    <table>
      <thead><tr><th>نوع العملية</th><th>المبلغ</th><th>عدد الحقائب (+/-)</th><th>طريقة الدفع</th></tr></thead>
      <tbody>
        ${bagStockRows}
        ${bagStockDay.length ? sumRow(2, 'إجمالي عدد الحقائب المضافة للمخزون', (stockQty>0?'+':'')+stockQty) : ''}
      </tbody>
    </table>
    <div style="font-size:13px; color:#66707E; margin:12px 0 6px;">ثانياً: عملاء اشتروا حقائبهم اليوم (${bagBuyers.length})</div>
    <table>
      <thead><tr><th>الاسم</th><th>رقم الهوية</th><th>المصدر</th><th>رقم فاتورة الحقيبة</th><th>القيمة</th></tr></thead>
      <tbody>
        ${bagBuyerRows}
        ${bagBuyers.length ? sumRow(4, 'إجمالي قيمة حقائب العملاء', fmt(bagValue)+' ﷼') : ''}
      </tbody>
    </table>

    <h3 style="margin:22px 0 8px;">٧. مردودات المبيعات اليوم (${dayReturns.length})</h3>
    <table>
      <thead><tr><th>العميل</th><th>طريقة الدفع</th><th>المبلغ</th></tr></thead>
      <tbody>
        ${returnRows}
        ${dayReturns.length ? sumRow(2, 'إجمالي المردودات', fmt(returnsTotal)+' ﷼') : ''}
      </tbody>
    </table>

    <h3 style="margin:22px 0 8px;">٨. تعديل عملاء قدام (سُجّلوا منذ أكثر من ${DAILY_REPORT_EDIT_OLD_DAYS} يوم — ${oldEdits.length})</h3>
    <table>
      <thead><tr><th>العميل</th><th>بواسطة</th><th>الوقت</th></tr></thead>
      <tbody>${oldEditRows}</tbody>
    </table>

    <h3 style="margin:22px 0 8px;">٩. حذف عملاء قدام (سُجّلوا منذ أكثر من ${DAILY_REPORT_DELETE_OLD_DAYS} يوم — ${oldDeletes.length})</h3>
    <table>
      <thead><tr><th>العميل</th><th>بواسطة</th><th>الوقت</th></tr></thead>
      <tbody>${oldDeleteRows}</tbody>
    </table>`;
}
/* ---- تقرير الإيرادات والمصروفات حسب الفترة (نسخة PDF لجدول لوحة التحكم) ---- */
function buildPeriodReportBodyHtml(from, to){
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const vIn = vaultTx.filter(t=>t.type==='in' && !t.isReturn && inRange(t.date, from, to));
  const vOut = vaultTx.filter(t=>t.type==='out' && !t.isReturn && inRange(t.date, from, to));
  const income = vIn.reduce((s,t)=>s+num(t.amount),0);
  const expense = vOut.reduce((s,t)=>s+num(t.amount),0);
  const cInPeriod = clients.filter(c=>inRange(c.date, from, to));
  const row = (label, value, opts={}) => `<tr${opts.total?` style="font-weight:800; background:#F1F4F7;"`:''}><td>${label}</td><td class="mono" style="text-align:left;">${value}</td></tr>`;
  const emptyRow = (colspan, msg)=> `<tr><td colspan="${colspan}" style="text-align:center; color:#8A94A3; padding:14px;">${msg}</td></tr>`;
  const rowsHtml = (rows, isIn)=> rows.length ? [...rows].sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))).map(t=>`
    <tr>
      <td class="mono">${escapeHtml(formatDateDisplay(t.date)||t.date||'—')}</td>
      <td>${escapeHtml(t.clientName||t.manual||t.category||'—')}</td>
      <td>${escapeHtml(t.method||'—')}</td>
      <td>${escapeHtml(t.destination?destLabel(t.destination):'—')}</td>
      <td class="mono">${isIn? '+':'−'}${fmt(num(t.amount))}</td>
    </tr>`).join('') : emptyRow(5, 'لا توجد حركات في هذه الفترة');
  return `
    <div class="head">
      <div><h2>الإيرادات والمصروفات حسب الفترة</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">الفترة: ${escapeHtml(formatDateDisplay(from))} إلى ${escapeHtml(formatDateDisplay(to))}<br>تاريخ الطباعة: ${escapeHtml(today)}</div>
    <h3 style="margin:16px 0 8px;">ملخص الفترة</h3>
    <table>
      <tbody>
        ${row('إجمالي الإيرادات', fmt(income)+' ﷼')}
        ${row('إجمالي المصروفات', fmt(expense)+' ﷼')}
        ${row('صافي الفترة', fmt(income-expense)+' ﷼', {total:true})}
        ${row('عدد العملاء المسجّلين', String(cInPeriod.length))}
      </tbody>
    </table>
    <h3 style="margin:20px 0 8px;">تفصيل الوارد (${vIn.length} حركة)</h3>
    <table>
      <thead><tr><th>التاريخ</th><th>البيان</th><th>طريقة الدفع</th><th>الوجهة</th><th>المبلغ</th></tr></thead>
      <tbody>
        ${rowsHtml(vIn, true)}
        ${vIn.length ? `<tr style="font-weight:800; background:#F1F4F7;"><td colspan="4">إجمالي الوارد (${vIn.length} حركة)</td><td class="mono">+${fmt(income)}</td></tr>` : ''}
      </tbody>
    </table>
    <h3 style="margin:20px 0 8px;">تفصيل الصادر (${vOut.length} حركة)</h3>
    <table>
      <thead><tr><th>التاريخ</th><th>البيان</th><th>طريقة الدفع</th><th>الوجهة</th><th>المبلغ</th></tr></thead>
      <tbody>
        ${rowsHtml(vOut, false)}
        ${vOut.length ? `<tr style="font-weight:800; background:#F1F4F7;"><td colspan="4">إجمالي الصادر (${vOut.length} حركة)</td><td class="mono">−${fmt(expense)}</td></tr>` : ''}
      </tbody>
    </table>`;
}
renderReportsEmailList();

