/* ================= دوال مساعدة مشتركة (رسوم بيانية/فلاتر/تقارير) + فلترة شيت العملاء =================
   كانت لوحة تحكم CFO القديمة تعيش هنا — استُبدلت بـ js/dashboard-v2.js. بقي هنا فقط ما تستخدمه
   شاشات أخرى: drawBars/drawLineChart (التقارير/الخزنة/الحقائب)، lastNMonthKeys/monthLabelAr،
   مقارنات الفترات (periodComparison/pctChange)، التقرير الشهري، وفلترة وترتيب شيت العملاء. */
function drawBars(sel, entries, limit=20, formatter){
  const el = $(sel);
  entries = entries.slice(0, limit);
  if(entries.length===0){ el.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">لا توجد بيانات بعد</div>'; return; }
  const max = Math.max(...entries.map(e=>e[1]));
  el.innerHTML = entries.map(([k,v])=>`
    <div class="bar-row">
      <div class="label">${escapeHtml(String(k))}</div>
      <div class="track"><div class="fill" style="width:${(v/max*100).toFixed(1)}%"></div></div>
      <div class="val">${formatter ? formatter(v) : escapeHtml(String(v))}</div>
    </div>`).join('');
}

/* لوحة ألوان الشارت الدائري — امتداد من نفس هوية ألوان البرنامج (gold/navy/teal/red) لعدد فئات أكبر */
const DONUT_COLORS = ['#2E6BE6','#E8752C','#2FA84F','#E24C3D','#8B5CF6','#0EA5B7','#F0935B','#5B8DEF','#4FCB7A','#C85F1E','#94A3B8','#1B4DB8'];


/* رسم بياني خطي بسيط (SVG) لعرض اتجاهات متعددة عبر الزمن دون الحاجة لمكتبة خارجية */
function drawLineChart(sel, labels, series){
  const el = $(sel);
  if(!el) return;
  const hasData = labels.length && series.some(s=>s.values.some(v=>v));
  if(!hasData){ el.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">لا توجد بيانات كافية بعد</div>'; return; }
  const W = 900, H = 280, padL = 60, padR = 20, padT = 16, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const allVals = series.flatMap(s=>s.values);
  let max = Math.max(...allVals, 0), min = Math.min(...allVals, 0);
  if(max===min) max = min + 1;
  const xStep = labels.length>1 ? innerW/(labels.length-1) : 0;
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
  const showEvery = labels.length>8 ? Math.ceil(labels.length/8) : 1;
  const labelsHtml = labels.map((l,i)=> i%showEvery===0 ? `<text x="${xScale(i).toFixed(1)}" y="${H-8}" font-size="10" fill="var(--text-muted)" text-anchor="middle">${escapeHtml(l)}</text>` : '').join('');
  const seriesHtml = series.map(s=>{
    const pts = s.values.map((v,i)=>`${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
    const dots = s.values.map((v,i)=>`<circle cx="${xScale(i).toFixed(1)}" cy="${yScale(v).toFixed(1)}" r="3.2" fill="${s.color}"><title>${escapeHtml(labels[i])}: ${fmt(v)}</title></circle>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');
  const legendHtml = series.map(s=>`<span style="display:inline-flex; align-items:center; gap:5px; margin-left:16px; font-size:12px; color:var(--text-muted);"><span style="width:10px; height:10px; border-radius:50%; background:${s.color}; display:inline-block;"></span>${escapeHtml(s.name)}</span>`).join('');
  el.innerHTML = `
    <div style="margin-bottom:10px;">${legendHtml}</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; max-height:280px; display:block;">
      ${gridsHtml}
      ${seriesHtml}
      ${labelsHtml}
    </svg>`;
}
/* آخر n شهر كمفاتيح YYYY-MM */
function lastNMonthKeys(n){
  const arr = [];
  const now = new Date();
  for(let i=n-1;i>=0;i--){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    arr.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  return arr;
}
const MONTH_NAMES_AR_SHORT = ['ينا','فبر','مار','أبر','ماي','يون','يول','أغس','سبت','أكت','نوف','ديس'];
const MONTH_NAMES_AR_FULL = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const WEEKDAY_NAMES_AR = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
function monthLabelAr(key){
  const [y,m] = key.split('-');
  return `${MONTH_NAMES_AR_SHORT[Number(m)-1]} ${y.slice(2)}`;
}
/* تقرير شهري يومي: لكل يوم من أيام الشهر المختار (من 1 إلى آخر يوم فيه)، عدد العملاء الذين سُجّلوا في ذلك اليوم
   (تاريخ التسجيل c.date)، وتفصيل المبالغ المحصّلة فعلياً في ذلك اليوم من "الحركات المالية" (نقدي/شبكة/بنك)
   حسب الوجهة الفعلية للحركة (نفس منطق الجدول الشهري في شاشة التقارير). يشمل كل أيام الشهر حتى لو لم
   يُسجَّل فيها أي عميل أو تُحصَّل أي مبالغ (تظهر بصفر). */
function monthlyClientsDailyReport(yearMonth){
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number(yStr), month = Number(mStr); // month: 1-12
  const daysInMonth = new Date(year, month, 0).getDate();
  const rows = [];
  let totalReg = 0, totalCash = 0, totalNetwork = 0, totalNetwork2 = 0, totalBank = 0, totalAmount = 0;
  for(let day=1; day<=daysInMonth; day++){
    const dateStr = `${yStr}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const regCount = clients.filter(c=>c.date===dateStr).length;
    const dayIn = vaultTx.filter(t=>t.type==='in' && t.date===dateStr);
    const cash = dayIn.filter(t=>(t.destination||'vault')==='vault').reduce((s,t)=>s+num(t.amount),0);
    const network = dayIn.filter(t=>(t.destination||'vault')==='network').reduce((s,t)=>s+num(t.amount),0);
    const network2 = dayIn.filter(t=>(t.destination||'vault')==='network2').reduce((s,t)=>s+num(t.amount),0);
    const bank = dayIn.filter(t=>(t.destination||'vault')==='bank').reduce((s,t)=>s+num(t.amount),0);
    const amount = cash + network + network2 + bank;
    const weekday = WEEKDAY_NAMES_AR[new Date(year, month-1, day).getDay()];
    totalReg += regCount; totalCash += cash; totalNetwork += network; totalNetwork2 += network2; totalBank += bank; totalAmount += amount;
    rows.push({ day, dateStr, weekday, regCount, cash, network, network2, bank, amount });
  }
  return { year, month, monthLabel: `${MONTH_NAMES_AR_FULL[month-1]} ${year}`, rows, totalReg, totalCash, totalNetwork, totalNetwork2, totalBank, totalAmount };
}
function monthlyClientsReportBodyHtml(yearMonth){
  const rep = monthlyClientsDailyReport(yearMonth);
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const rowsHtml = rep.rows.map(r=>`
    <tr>
      <td class="mono">${r.day}</td>
      <td class="mono">${escapeHtml(r.dateStr)}</td>
      <td>${escapeHtml(r.weekday)}</td>
      <td class="mono">${r.regCount}</td>
      <td class="mono">${fmt(r.cash)}</td>
      <td class="mono">${fmt(r.network)}</td>
      <td class="mono">${fmt(r.network2)}</td>
      <td class="mono">${fmt(r.bank)}</td>
      <td class="mono" style="font-weight:bold;">${fmt(r.amount)}</td>
    </tr>`).join('');
  return `
    <div class="head">
      <div><h2>تقرير شهري — تسجيلات ومبالغ العملاء</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)} — ${escapeHtml(rep.monthLabel)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">تاريخ الطباعة: ${escapeHtml(today)}</div>
    <table>
      <thead><tr><th>اليوم</th><th>التاريخ</th><th>اسم اليوم</th><th>عدد العملاء المسجّلين</th><th>نقدي (كاش)</th><th>شبكة المركز</th><th>شبكة المستوصف</th><th>بنك</th><th>الإجمالي</th></tr></thead>
      <tbody>
        ${rowsHtml}
        <tr style="font-weight:800; background:#F1F4F7;">
          <td colspan="3">الإجمالي</td>
          <td class="mono">${rep.totalReg}</td>
          <td class="mono">${fmt(rep.totalCash)}</td>
          <td class="mono">${fmt(rep.totalNetwork)}</td>
          <td class="mono">${fmt(rep.totalNetwork2)}</td>
          <td class="mono">${fmt(rep.totalBank)}</td>
          <td class="mono">${fmt(rep.totalAmount)}</td>
        </tr>
      </tbody>
    </table>`;
}
function printMonthlyClientsReport(yearMonth){
  const rep = monthlyClientsDailyReport(yearMonth);
  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('تقرير شهري — ' + rep.monthLabel, {variant: 'table'})}
  <body>
    ${monthlyClientsReportBodyHtml(yearMonth)}
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
}
$('#btn-monthly-report')?.addEventListener('click', ()=>{
  const now = new Date();
  $('#mr-month').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  $('#monthly-report-overlay').classList.add('show');
});
$('#mr-cancel')?.addEventListener('click', ()=> $('#monthly-report-overlay').classList.remove('show'));
$('#mr-generate')?.addEventListener('click', ()=>{
  const val = $('#mr-month').value;
  if(!val){ showToast('اختر الشهر أولاً'); return; }
  printMonthlyClientsReport(val);
  $('#monthly-report-overlay').classList.remove('show');
});
/* اتجاه الإيرادات/المصروفات/الصافي الشهري لآخر n شهر (مستقل عن فلتر الفترة، يعرض كامل السجل) */
function monthlyFinancialTrend(n=12){
  const keys = lastNMonthKeys(n);
  const income = keys.map(k=> Math.round(vaultTx.filter(t=>t.type==='in' && (t.date||'').slice(0,7)===k).reduce((s,t)=>s+num(t.amount),0)*100)/100);
  const expense = keys.map(k=> Math.round(vaultTx.filter(t=>t.type==='out' && (t.date||'').slice(0,7)===k).reduce((s,t)=>s+num(t.amount),0)*100)/100);
  const net = keys.map((k,i)=> Math.round((income[i]-expense[i])*100)/100);
  return { labels: keys.map(monthLabelAr), series:[
    {name:'الإيرادات', color:'var(--teal)', values:income},
    {name:'المصروفات', color:'var(--red)', values:expense},
    {name:'الصافي', color:'var(--gold-dark)', values:net},
  ]};
}
/* اتجاه عدد العملاء المسجّلين شهرياً لآخر n شهر */
function monthlyRegistrationsTrend(n=12){
  const keys = lastNMonthKeys(n);
  const counts = keys.map(k=> clients.filter(c=>(c.date||'').slice(0,7)===k).length);
  return { labels: keys.map(monthLabelAr), series:[{name:'عدد التسجيلات', color:'var(--navy)', values:counts}] };
}
/* جدول شهري: عدد المسجّلين والمبالغ المدفوعة (كاش/شبكة/بنك) لآخر n شهر */
function monthlyRegistrationsPaymentsTable(n=12){
  const keys = lastNMonthKeys(n);
  return keys.map(k=>{
    const regCount = clients.filter(c=>!c.suspended && (c.date||'').slice(0,7)===k).length;
    const monthIn = vaultTx.filter(t=>t.type==='in' && (t.date||'').slice(0,7)===k);
    const cash = monthIn.filter(t=>(t.destination||'vault')==='vault').reduce((s,t)=>s+num(t.amount),0);
    const network = monthIn.filter(t=>(t.destination||'vault')==='network').reduce((s,t)=>s+num(t.amount),0);
    const network2 = monthIn.filter(t=>(t.destination||'vault')==='network2').reduce((s,t)=>s+num(t.amount),0);
    const bank = monthIn.filter(t=>(t.destination||'vault')==='bank').reduce((s,t)=>s+num(t.amount),0);
    return { key:k, label: monthLabelAr(k), regCount, cash, network, network2, bank, total: cash+network+network2+bank };
  });
}
/* دخل المركز حسب نوع الدورة، مقيّداً بفلتر الفترة الحالي في شاشة التقارير */
function revenueByCourseType(){
  const rows = clientsInPeriod().filter(c=>!c.cancelled);
  const totals = {};
  rows.forEach(c=>{ const k = c.courseType||'غير محدد'; totals[k]=(totals[k]||0)+centerIncome(c); });
  return Object.entries(totals).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]);
}
/* حساب إحصائيات الفترة السابقة مباشرة (بنفس عدد أيام الفترة الحالية) للمقارنة */
function periodComparison(){
  const fromStr = $('#rp-from').value;
  const toStr = $('#rp-to').value;
  const toDate = toStr ? new Date(toStr) : new Date();
  let fromDate;
  if(fromStr){ fromDate = new Date(fromStr); }
  else{
    const allDates = [...clients.map(c=>c.date), ...vaultTx.map(t=>t.date)].filter(Boolean).sort();
    fromDate = allDates.length ? new Date(allDates[0]) : new Date(toDate.getTime() - 30*86400000);
  }
  const spanMs = Math.max(toDate - fromDate, 86400000);
  const prevTo = new Date(fromDate.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - spanMs);
  const prevFromISO = prevFrom.toISOString().slice(0,10);
  const prevToISO = prevTo.toISOString().slice(0,10);
  const prevRows = vaultTx.filter(t=> (t.date||'') >= prevFromISO && (t.date||'') <= prevToISO);
  const prevIncome = prevRows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0);
  const prevExpense = prevRows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const prevClients = clients.filter(c=>{ const d=c.date||''; return d>=prevFromISO && d<=prevToISO; }).length;
  return { prevIncome, prevExpense, prevClients, prevFromISO, prevToISO };
}
function pctChange(curr, prev){
  if(!prev) return curr>0 ? 100 : 0;
  return Math.round(((curr-prev)/Math.abs(prev))*1000)/10;
}
/* شارة تغيّر: الأخضر يعني تحسّن (للإيرادات/العملاء/الصافي)، والأحمر يعني تراجع */
function changeBadgePositive(pct){
  if(pct>0) return `<span style="color:var(--teal); font-size:11.5px;">▲ ${pct}%</span>`;
  if(pct<0) return `<span style="color:var(--red); font-size:11.5px;">▼ ${Math.abs(pct)}%</span>`;
  return `<span style="color:var(--text-muted); font-size:11.5px;">— 0%</span>`;
}
/* شارة تغيّر معكوسة: الأحمر يعني زيادة (مناسبة للمصروفات، حيث الزيادة سلبية)*/
function changeBadgeNegative(pct){
  if(pct>0) return `<span style="color:var(--red); font-size:11.5px;">▲ ${pct}%</span>`;
  if(pct<0) return `<span style="color:var(--teal); font-size:11.5px;">▼ ${Math.abs(pct)}%</span>`;
  return `<span style="color:var(--text-muted); font-size:11.5px;">— 0%</span>`;
}

/* ---------------- Clients table ---------------- */
function populateSelect(sel, values, withEmpty){
  sel.innerHTML = (withEmpty?'<option value="">—</option>':'') + values.map(v=>`<option value="${escapeHtml(String(v))}">${escapeHtml(String(v))}</option>`).join('');
}
/* ---------------- فلتر "موظفي الاستقبال" (شيت العملاء + شيت الحركات المالية) ----------------
   يتيح للمدير/المحاسب اختيار موظف استقبال بعينه من قائمة منسدلة ورؤية عملياته هو فقط
   (العملاء الذين سجّلهم، وحركات الخزنة التلقائية الناتجة عن تسجيلهم). لا يظهر هذا الفلتر
   أصلاً لغير المدير/المحاسب لأن الاستقبال والموظف العام أصلاً مقيَّدون ببياناتهم فقط (isOwnRecord). */
let receptionUsersCache = null;
async function loadReceptionUsersList(force){
  if(!canSeeAllData()) return receptionUsersCache = [];
  if(receptionUsersCache && !force) return receptionUsersCache;
  try{
    const res = await fetch(API_BASE + '/api/users/reception', { headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN } });
    const data = await res.json();
    receptionUsersCache = (res.ok && Array.isArray(data.users)) ? data.users : [];
  }catch(e){ receptionUsersCache = receptionUsersCache || []; }
  return receptionUsersCache;
}
async function populateReceptionFilterSelects(){
  const wraps = ['filter-reception-wrap','v-filter-reception-wrap'].map(id=>document.getElementById(id));
  if(!canSeeAllData()){ wraps.forEach(w=>{ if(w) w.style.display='none'; }); return; }
  const users = await loadReceptionUsersList();
  const opts = users.map(u=>`<option value="${escapeHtml(u.username)}">${escapeHtml(u.display_name||u.username)}</option>`).join('');
  ['filter-reception','v-filter-reception'].forEach(id=>{
    const sel = document.getElementById(id);
    if(!sel) return;
    const prevVals = selectedFilterValues(sel);
    sel.innerHTML = '<option value="">كل موظفي الاستقبال</option>' + opts;
    Array.from(sel.options).forEach(o=> o.selected = prevVals.includes(o.value));
    refreshMultiSelectFilterUI(sel);
  });
  wraps.forEach(w=>{ if(w) w.style.display = users.length ? '' : 'none'; });
}
function refreshFilterOptions(){
  if(typeof populateYearFilterSelect==='function') populateYearFilterSelect();
  if(typeof populateReceptionFilterSelects==='function') populateReceptionFilterSelects();
  // فلاتر متعددة الاختيار: نحفظ كل القيم المحددة سابقاً (مش قيمة واحدة بس) قبل إعادة بناء
  // الخيارات، ونعيد تحديد كل قيمة كانت مختارة ولسه موجودة ضمن الخيارات الجديدة، حتى لا تُفقد
  // بقية الاختيارات المتعددة في كل مرة يُعاد فيها بناء القائمة (تغيير بحث/بيانات...الخ)
  const courseFilterVals = selectedFilterValues($('#filter-course'));
  populateSelect($('#filter-course'), settings.courses.map(c=>c.name), false);
  $('#filter-course').insertAdjacentHTML('afterbegin','<option value="__unknown__">⚠ بدون نوع دورة</option>');
  $('#filter-course').insertAdjacentHTML('afterbegin','<option value="">كل الدورات</option>');
  Array.from($('#filter-course').options).forEach(o=> o.selected = courseFilterVals.includes(o.value));
  refreshMultiSelectFilterUI($('#filter-course'));

  const natFilterVals = selectedFilterValues($('#filter-nat'));
  populateSelect($('#filter-nat'), settings.nationalities, false);
  // ترتيب الإدراج مهم: "بدون جنسية" أولاً ثم "كل الجنسيات" بعدها (afterbegin) حتى تصبح
  // "كل الجنسيات" هي index 0 الفعلي (نفس ترتيب فلتر الدورة أعلاه) — لا العكس، لأن أي كود
  // يعتمد على selectedIndex=0 لتمثيل "الكل" (مثل زر "إلغاء الفلتر" العلوي) كان يحدد
  // "بدون جنسية" خطأً بدل "الكل" بسبب الترتيب المعكوس القديم هنا.
  $('#filter-nat').insertAdjacentHTML('afterbegin','<option value="__no_nationality__">🚫 بدون جنسية</option>');
  $('#filter-nat').insertAdjacentHTML('afterbegin','<option value="">كل الجنسيات</option>');
  Array.from($('#filter-nat').options).forEach(o=> o.selected = natFilterVals.includes(o.value));
  refreshMultiSelectFilterUI($('#filter-nat'));

  const companyFilterVals = selectedFilterValues($('#filter-company'));
  // نجمع أسماء الشركات من القائمة الرئيسية (تبويب تحويلات الشركات) ومن العملاء المسجَّلين فعلياً، حتى تظهر أي شركة أُضيفت هناك فوراً هنا وتبقى الفلترة مرتبطة بين التبويبين
  const companyNamesForFilter = [...new Set([...companies.map(c=>c.name), ...clients.map(c=>c.companyName)].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  populateSelect($('#filter-company'), companyNamesForFilter, false);
  $('#filter-company').insertAdjacentHTML('afterbegin','<option value="">كل الشركات</option>');
  Array.from($('#filter-company').options).forEach(o=> o.selected = companyFilterVals.includes(o.value));
  refreshMultiSelectFilterUI($('#filter-company'));
}
function filteredClients(opts){
  opts = opts || {};
  const q = $('#search').value.trim().toLowerCase();
  const fcVals = opts.skipCourseFilter ? [] : selectedFilterValues($('#filter-course'));
  const fnVals = selectedFilterValues($('#filter-nat'));
  const fsVals = selectedFilterValues($('#filter-status'));
  const fcompVals = selectedFilterValues($('#filter-company'));
  const finvVals = $('#filter-invoice') ? selectedFilterValues($('#filter-invoice')) : [];
  const fcnVals = $('#filter-coursenum') ? selectedFilterValues($('#filter-coursenum')) : [];
  const frnVals = $('#filter-refnum') ? selectedFilterValues($('#filter-refnum')) : [];
  const dfrom = $('#cl-date-from').value;
  const dto = $('#cl-date-to').value;
  const paidMinRaw = $('#cl-paid-min').value;
  const paidMaxRaw = $('#cl-paid-max').value;
  const paidMin = paidMinRaw!=='' ? num(paidMinRaw) : null;
  const paidMax = paidMaxRaw!=='' ? num(paidMaxRaw) : null;
  const frecepVals = $('#filter-reception') ? selectedFilterValues($('#filter-reception')) : [];
  const fbagVals = $('#filter-bag-source') ? selectedFilterValues($('#filter-bag-source')) : [];
  const rows = clients.filter(c=>{
    // عزل البيانات: دور 'reception' مستثنى من isOwnRecord الفردية هنا تحديداً، لأن السيرفر
    // أصلاً لا يُرجع له إلا تخزينه الخاص (origin='reception' — مساحة واحدة مشتركة بين كل
    // مستخدمي الاستقبال معاً، وليست فردية لكل مستخدم كباقي الأدوار المقيَّدة). راجع
    // clientRecordsVisibilitySql فى server.js وتعليق canSeeAllData فى ui-framework.js.
    if(currentUserRole!=='reception' && !isOwnRecord(c)) return false; // عزل البيانات: عرض فقط — لا يمس المصفوفة الأصلية أبداً
    // عند وجود نص بحث (q) نُعلّق فلتر السنة/التاريخ — فالبحث في جدول العملاء مقصود به
    // إيجاد الشخص المطلوب أينما كان تاريخه، فلا يختفي نتيجة كونه خارج سنة ما.
    if(!q && !matchYear(c.date)) return false; // فلتر السنة العلوي (خط دفاع مباشر — بجانب مزامنته لحقلي من/إلى أدناه)
    if(frecepVals.length && !frecepVals.includes(c.createdBy)) return false;
    if(showSuspendedOnly && !c.suspended) return false;
    if(showUnpurchasedBagsOnly && !(c.bagSource==='buy' && c.bagStatus!=='purchased' && !c.suspended)) return false;
    // كل فلتر متعدد الاختيار: مطابقة "أو" بين القيم المحددة داخل نفس الفلتر — لو مفيش أي
    // اختيار محدد (مصفوفة فارغة) يبقى معناه "الكل" فلا يُستبعد أي عميل بسبب هذا الفلتر
    if(fcVals.length){
      const okCourse = fcVals.some(v => v==='__unknown__' ? !(c.courseType && c.courseType.trim()) : c.courseType===v);
      if(!okCourse) return false;
    }
    if(fnVals.length){
      const okNat = fnVals.some(v => v==='__no_nationality__'
        ? !(String(c.nationality||'').trim())
        : c.nationality===v);
      if(!okNat) return false;
    }
    if(fsVals.length){
      const rem = remaining(c);
      const okStatus = (fsVals.includes('paid') && rem<=0) || (fsVals.includes('owe') && rem>0);
      if(!okStatus) return false;
    }
    if(fcompVals.length && !fcompVals.includes(c.companyName)) return false;
    if(finvVals.length){
      const hasInv = !!(c.invoice && String(c.invoice).trim());
      const ok = (finvVals.includes('yes') && hasInv) || (finvVals.includes('no') && !hasInv);
      if(!ok) return false;
    }
    if(fcnVals.length){
      const hasCn = !!(c.courseNumber && String(c.courseNumber).trim());
      const ok = (fcnVals.includes('yes') && hasCn) || (fcnVals.includes('no') && !hasCn);
      if(!ok) return false;
    }
    if(frnVals.length){
      const hasRn = !!(c.referNum && String(c.referNum).trim());
      const ok = (frnVals.includes('yes') && hasRn) || (frnVals.includes('no') && !hasRn);
      if(!ok) return false;
    }
    // فلتر الحقيبة (شيت العملاء): فلتر واحد مدمج بقيم مصدر الحقيبة الثلاث — من المخزون (stock)،
    // حقيبة خاصة (own)، أو بدون حقيبة (buy — شراء عادي وليس من المخزون ولا حقيبة خاصة)
    if(fbagVals.length && !fbagVals.includes(c.bagSource)) return false;
    // فلاتر التاريخ من/إلى تُعلّق أثناء البحث مثل فلتر السنة أعلاه (نفس المنطق)
    if(!q && dfrom && (!c.date || c.date<dfrom)) return false;
    if(!q && dto && (!c.date || c.date>dto)) return false;
    if(paidMin!==null && paidTotal(c)<paidMin) return false;
    if(paidMax!==null && paidTotal(c)>paidMax) return false;
    if(q){
      // تطبيع البحث الرقمي: مقارنة أرقام الهاتف بأرقامها فقط (بدون رموز دولة/+/مسافات/أقواس)
      // وبصيغتين (مع أو بدون صفر البادئ، مع/بدون 966) حتى يطابق البحث مهما كانت صيغة
      // التخزين (05X.. / +9665X.. / 9665X..). باقي الحقول بحث حرفي.
      const qDigits = q.replace(/[^0-9]/g,'');
      if(qDigits && qDigits.length <= 15){
        const phoneDigits = String(c.phone||'').replace(/[^0-9]/g,'');
        const phoneLocal = phoneDigits.startsWith('966') ? phoneDigits.slice(3) : phoneDigits; // بلا رمز الدولة
        const qLocal = qDigits.startsWith('966') ? qDigits.slice(3) : qDigits;               // بلا رمز الدولة
        const qNoZero = qLocal.startsWith('0') ? qLocal.slice(1) : qLocal;                    // بلا الصفر البادئ
        const qVariants = qDigits && (phoneDigits.includes(qDigits) || phoneLocal.includes(qLocal) || phoneLocal.includes(qNoZero));
        if(qVariants) { /* مطابقة بالرقم */ }
        else{
          const hay = [c.name,c.clientId,c.invoice,c.referNum,c.courseNumber].join(' ').toLowerCase();
          if(!hay.includes(q)) return false;
        }
      } else {
        const hay = [c.name,c.clientId,c.invoice,c.referNum,c.courseNumber].join(' ').toLowerCase();
        if(!hay.includes(q)) return false;
      }
    }
    return true;
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0) || String(a.clientId||a.id||'').localeCompare(String(b.clientId||b.id||'')));
  return applyClientsColumnSort(rows);
}
/* ---------------- ترتيب بالنقر على رأس العمود (جدول العملاء) ----------------
   يُطبَّق فوق الترتيب الافتراضي (بالتاريخ) وليس بديلاً عنه — إن لم يختر المستخدم
   عموداً بعد، تبقى النتائج كما كانت دائماً (بالتاريخ الأحدث أولاً). */
let clientsSortState = { key: null, dir: 1 };
const CLIENT_SORT_GETTERS = {
  name: c => (c.name||'').toLowerCase(),
  clientId: c => (c.clientId||'').toLowerCase(),
  referNum: c => (c.referNum||'').toLowerCase(),
  nationality: c => (c.nationality||'').toLowerCase(),
  courseType: c => (c.courseType||'').toLowerCase(),
  courseNumber: c => (c.courseNumber||'').toLowerCase(),
  invoice: c => (c.invoice||'').toLowerCase(),
  date: c => c.date || '',
  total: c => total(c),
  paid: c => paidTotal(c),
  remaining: c => remaining(c),
};
function applyClientsColumnSort(rows){
  const getter = clientsSortState.key && CLIENT_SORT_GETTERS[clientsSortState.key];
  if(!getter) return rows;
  return [...rows].sort((a,b)=>{
    const va = getter(a), vb = getter(b);
    if(typeof va === 'number' && typeof vb === 'number') return (va-vb)*clientsSortState.dir;
    return String(va).localeCompare(String(vb),'ar') * clientsSortState.dir;
  });
}
document.querySelectorAll('#view-clients thead th.sortable').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.sort;
    if(clientsSortState.key === key){ clientsSortState.dir *= -1; }
    else{ clientsSortState.key = key; clientsSortState.dir = 1; }
    document.querySelectorAll('#view-clients thead th.sortable').forEach(t=>t.setAttribute('aria-sort','none'));
    th.setAttribute('aria-sort', clientsSortState.dir===1 ? 'ascending' : 'descending');
    renderTable();
  });
});
let tableCurrentPage = 1;
let tableLastFilterSig = '';
let showSuspendedOnly = false;
let showUnpurchasedBagsOnly = false;

/* كروت فلتر الدورات أسفل صندوق إحصائيات شيت العملاء — بديل الكروت لقائمة "كل الدورات"
   المنسدلة القديمة. تُبنى الكروت مباشرة من خيارات select#filter-course الحقيقي (الذي يبقى
   مصدر الحقيقة الوحيد ومخفياً في الـ DOM دون تغليفه بواجهة Checkbox العامة — راجع
   data-multi-filter في core-utils.js)، فترث تلقائياً أي دورة جديدة تُضاف من الإعدادات دون أي
   تعديل هنا. الضغط على كرت يبدّل تحديد الخيار المطابق له في الـ select نفسه، فتستمر كل بقية
   منظومة الفلترة (filteredClients، المسار السريع، الفلاتر المتقدمة، العروض المحفوظة، مسح
   الفلاتر...) في العمل بلا أي تعديل إضافي لأنها كلها تقرأ من نفس الـ select عبر
   selectedFilterValues(). rows: نتيجة filteredClients({skipCourseFilter:true}) يمررها المستدعي
   لتفادي حسابها مرتين — العدد داخل كل كرت يعكس بقية الفلاتر الشغالة فعلاً بمعزل عن فلتر الدورة. */
function renderCourseStatCards(rows){
  const wrap = $('#course-stat-cards');
  const sel = $('#filter-course');
  if(!wrap || !sel) return;
  const selectedVals = selectedFilterValues(sel);
  const counts = {};
  (rows||[]).forEach(c=>{
    const k = (c.courseType && c.courseType.trim()) ? c.courseType : '__unknown__';
    counts[k] = (counts[k]||0)+1;
  });
  wrap.innerHTML = Array.from(sel.options).filter(o=>o.value!=='').map(o=>{
    const key = o.value;
    const isActive = selectedVals.includes(key);
    return `<div class="stat course-stat${isActive?' active':''}" data-course-key="${escapeHtml(key)}">
      ${isActive ? '<span class="course-check" title="مُحدَّد">✓</span>' : ''}
      <b class="mono">${counts[key]||0}</b><span>${escapeHtml(o.textContent)}</span>
    </div>`;
  }).join('');
}
$('#course-stat-cards')?.addEventListener('click', e=>{
  const card = e.target.closest('.course-stat');
  if(!card) return;
  const sel = $('#filter-course');
  if(!sel) return;
  const key = card.dataset.courseKey;
  const opt = Array.from(sel.options).find(o=>o.value===key);
  if(!opt) return;
  opt.selected = !opt.selected;
  // مطابق لسلوك قائمة "كل الدورات" (خيار قيمته فارغة): إلغاء تحديدها تلقائياً عند اختيار دورة،
  // وإعادة تحديدها تلقائياً لو انتهى الأمر بعدم وجود أي دورة مختارة (يساوي "كل الدورات")
  const allOpt = Array.from(sel.options).find(o=>o.value==='');
  if(allOpt){
    allOpt.selected = false;
    if(!Array.from(sel.selectedOptions).length) allOpt.selected = true;
  }
  sel.dispatchEvent(new Event('input', {bubbles:true}));
  sel.dispatchEvent(new Event('change', {bubbles:true}));
});
