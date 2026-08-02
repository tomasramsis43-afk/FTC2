/* ================= لوحة تحكم CFO-Style: أيقونات + دوال مساعدة ================= */
const CFO_ICONS = {
  sales:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
  profit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  wallet:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M17 15h.01"/></svg>',
  alert:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  vault:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  bank:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 9h20z"/><path d="M5 10v9M9 10v9M15 10v9M19 10v9"/><path d="M2 21h20"/></svg>',
  network:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>',
  truck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16V6a1 1 0 0 1 1-1h9v11"/><path d="M13 9h4l3 3v4h-2"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/></svg>',
  invoice:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l3 3v17H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>'
};
/* نسبة التغيّر المئوية بين قيمتين، بحماية من القسمة على صفر */
function cfoPct(cur, prev){
  if(!prev) return cur>0 ? 100 : (cur<0 ? -100 : 0);
  return ((cur-prev)/Math.abs(prev))*100;
}
function cfoDeltaBadge(cur, prev){
  const p = cfoPct(cur, prev);
  const cls = p>=0 ? 'up' : 'down';
  const sign = p>=0 ? '+' : '';
  return `<b class="${cls}">${sign}${p.toFixed(1)}%</b>`;
}
function cfoKpi(icon, label, value){
  return `<div class="cfo-kpi">
    <div class="cfo-kpi-icon">${CFO_ICONS[icon]||''}</div>
    <div class="cfo-kpi-body">
      <div class="cfo-kpi-label">${escapeHtml(label)}</div>
      <div class="cfo-kpi-value">${value}</div>
    </div>
  </div>`;
}
function cfoDeltasRow(yearCur, yearPrev, monthCur, monthPrev){
  return `<div class="cfo-deltas">
    <span class="lbl">مقارنة بالسنة الماضية ${cfoDeltaBadge(yearCur, yearPrev)}</span>
    <span class="lbl">مقارنة بالشهر الماضي ${cfoDeltaBadge(monthCur, monthPrev)}</span>
  </div>`;
}
/* اتجاه شهري لصافي دخل المركز من الدورات (آخر n شهر، بمعزل عن فلتر السنة العام) */
function monthlyCourseIncomeTrend(n=12){
  const keys = lastNMonthKeys(n);
  const net = keys.map(k=> Math.round(clients.filter(c=>!c.cancelled && (c.date||'').slice(0,7)===k).reduce((s,c)=>s+centerIncome(c),0)*100)/100);
  return { labels: keys.map(monthLabelAr), series:[{name:'صافي دخل المركز', color:'var(--gold-dark)', values:net}] };
}
/* اتجاه شهري للمبالغ المحصّلة فعلياً (من الحركات المالية الداخلة) */
function monthlyCollectedTrend(n=12){
  const keys = lastNMonthKeys(n);
  const vals = keys.map(k=> Math.round(vaultTx.filter(t=>t.type==='in' && (t.date||'').slice(0,7)===k).reduce((s,t)=>s+num(t.amount),0)*100)/100);
  return { labels: keys.map(monthLabelAr), series:[{name:'المحصّل شهرياً', color:'var(--teal)', values:vals}] };
}
/* اتجاه شهري لإجمالي المشتريات */
function monthlyPurchasesTrend(n=12){
  const keys = lastNMonthKeys(n);
  const vals = keys.map(k=> Math.round(purchases.filter(p=>(p.date||'').slice(0,7)===k).reduce((s,p)=>s+num(p.total),0)*100)/100);
  return { labels: keys.map(monthLabelAr), series:[{name:'المشتريات شهرياً', color:'var(--red)', values:vals}] };
}
/* إجمالي المستحق (غير المدفوع) لكل مورد */
function supplierUnpaidTotals(){
  const map = {};
  purchases.filter(p=>p.status==='unpaid').forEach(p=>{ map[p.supplierId] = (map[p.supplierId]||0) + num(p.total); });
  const bySupplier = suppliers.map(s=> [s.name, map[s.id]||0]).filter(([,v])=>v>0);
  return bySupplier.sort((a,b)=>b[1]-a[1]);
}
/* إجمالي المتبقي على العملاء مجمّعاً حسب نوع الدورة (لأعلى فئات المتبقي) */
function remainingByCourseType(){
  const map = {};
  clients.filter(c=>!c.suspended && !c.cancelled).forEach(c=>{
    const r = remaining(c);
    if(r>0){ const k = c.courseType || 'غير محدد'; map[k]=(map[k]||0)+r; }
  });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]);
}
/* رسم لوحة CFO-Style الكاملة (6 لوحات: الدخل، التحصيل والمتبقي، الخزنة والبنك، المشتريات المستحقة، توزيع الدورات، طريقة الدفع) */
function renderCfoDashboard(){
  const el = $('#cfo-grid');
  if(!el) return;
  // القسم ده فيه أرصدة الخزنة/البنك واتجاهات التحصيل — بيانات مالية حساسة تخص
  // من له صلاحية "الخزنة" أو "المحاسبة" فقط، حتى لو "لوحة التحكم" نفسها متاحة
  // لأدوار أوسع (زي الاستقبال). كان بيُعرض للجميع بلا استثناء قبل هذا التعديل.
  if(!canAccessView('vault') && !canAccessView('accounting')){
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = '';

  const now = new Date();
  const thisYear = now.getFullYear(), lastYear = thisYear-1;
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth()+1).padStart(2,'0')}`;

  const activeClients = clients.filter(c=>!c.cancelled);
  const sumWhere = (yearOrMonth, keyType) => activeClients
    .filter(c=> keyType==='year' ? String(c.date||'').slice(0,4)===String(yearOrMonth) : String(c.date||'').slice(0,7)===yearOrMonth)
    .reduce((s,c)=>s+centerIncome(c),0);

  // === لوحة 1: الدخل من الدورات ===
  const salesYear = clients.filter(c=>!c.cancelled && String(c.date||'').slice(0,4)===String(thisYear)).reduce((s,c)=>s+num(c.coursePrice),0);
  const netYear = sumWhere(thisYear,'year');
  const netLastYear = sumWhere(lastYear,'year');
  const netThisMonth = sumWhere(thisMonthKey,'month');
  const netLastMonth = sumWhere(lastMonthKey,'month');
  const incomeTrend = monthlyCourseIncomeTrend(12);

  // === لوحة 2: التحصيل والمتبقي ===
  const collectedYear = vaultTx.filter(t=>t.type==='in' && String(t.date||'').slice(0,4)===String(thisYear)).reduce((s,t)=>s+num(t.amount),0);
  const collectedLastYear = vaultTx.filter(t=>t.type==='in' && String(t.date||'').slice(0,4)===String(lastYear)).reduce((s,t)=>s+num(t.amount),0);
  const collectedThisMonth = vaultTx.filter(t=>t.type==='in' && String(t.date||'').slice(0,7)===thisMonthKey).reduce((s,t)=>s+num(t.amount),0);
  const collectedLastMonth = vaultTx.filter(t=>t.type==='in' && String(t.date||'').slice(0,7)===lastMonthKey).reduce((s,t)=>s+num(t.amount),0);
  const totalRemainingNow = clients.filter(c=>!c.suspended && !c.cancelled).reduce((s,c)=>s+remaining(c),0);
  const collectTrend = monthlyCollectedTrend(12);
  const remainBars = remainingByCourseType();

  // === لوحة 3: الخزنة والبنك ===
  const vaultBal = balanceOf('vault'), bankBal = balanceOf('bank'), networkBal = balanceOf('network');
  const netFlowYear = vaultTx.filter(t=>String(t.date||'').slice(0,4)===String(thisYear)).reduce((s,t)=> s + (t.type==='in'?num(t.amount):-num(t.amount)), 0);
  const netFlowLastYear = vaultTx.filter(t=>String(t.date||'').slice(0,4)===String(lastYear)).reduce((s,t)=> s + (t.type==='in'?num(t.amount):-num(t.amount)), 0);
  const netFlowThisMonth = vaultTx.filter(t=>String(t.date||'').slice(0,7)===thisMonthKey).reduce((s,t)=> s + (t.type==='in'?num(t.amount):-num(t.amount)), 0);
  const netFlowLastMonth = vaultTx.filter(t=>String(t.date||'').slice(0,7)===lastMonthKey).reduce((s,t)=> s + (t.type==='in'?num(t.amount):-num(t.amount)), 0);
  const cashFlowTrend = monthlyFinancialTrend(12);

  // === لوحة 4: المشتريات المستحقة (الموردون) ===
  const unpaidPurchases = purchases.filter(p=>p.status==='unpaid');
  const unpaidTotal = unpaidPurchases.reduce((s,p)=>s+num(p.total),0);
  const purchasesYear = purchases.filter(p=>String(p.date||'').slice(0,4)===String(thisYear)).reduce((s,p)=>s+num(p.total),0);
  const purchasesLastYear = purchases.filter(p=>String(p.date||'').slice(0,4)===String(lastYear)).reduce((s,p)=>s+num(p.total),0);
  const purchasesThisMonth = purchases.filter(p=>String(p.date||'').slice(0,7)===thisMonthKey).reduce((s,p)=>s+num(p.total),0);
  const purchasesLastMonth = purchases.filter(p=>String(p.date||'').slice(0,7)===lastMonthKey).reduce((s,p)=>s+num(p.total),0);
  const purchasesTrend = monthlyPurchasesTrend(12);
  const apBars = supplierUnpaidTotals();

  // === لوحة 5: أعمار الذمم المدينة (AR Aging) — نفس منطق buildARAging فى شاشة المحاسبة، معروضة
  // هنا كملخص سريع فى الداشبورد الرئيسي بدل الحاجة للدخول لشاشة منفصلة كل مرة.
  const arData = (typeof buildARAging==='function') ? buildARAging(todayISO()) : null;
  const arOverdue90 = arData ? arData.buckets['أكثر من 90 يوم'] : 0;
  const arBars = arData ? [
    ['0–30 يوم', arData.buckets['0–30 يوم']],
    ['31–60 يوم', arData.buckets['31–60 يوم']],
    ['61–90 يوم', arData.buckets['61–90 يوم']],
    ['أكثر من 90 يوم', arData.buckets['أكثر من 90 يوم']],
  ] : [];

  el.innerHTML = `
    <div class="cfo-panel">
      <h3 class="cfo-panel-title">تحليل الدخل من الدورات</h3>
      <div class="cfo-kpis">
        ${cfoKpi('sales','إجمالي المبيعات ' + thisYear, fmt(salesYear)+' ﷼')}
        ${cfoKpi('profit','صافي دخل المركز', fmt(netYear)+' ﷼')}
      </div>
      ${cfoDeltasRow(netYear, netLastYear, netThisMonth, netLastMonth)}
      <div class="cfo-visual" id="cfo-trend-income"></div>
    </div>

    <div class="cfo-panel">
      <h3 class="cfo-panel-title">تحصيل المدفوعات والمتبقي</h3>
      <div class="cfo-kpis">
        ${cfoKpi('wallet','المحصّل ' + thisYear, fmt(collectedYear)+' ﷼')}
        ${cfoKpi('alert','المتبقي على العملاء', fmt(totalRemainingNow)+' ﷼')}
      </div>
      ${cfoDeltasRow(collectedYear, collectedLastYear, collectedThisMonth, collectedLastMonth)}
      <div class="cfo-caption">المتبقي حسب نوع الدورة (الأعلى)</div>
      <div class="cfo-visual cfo-bars" id="cfo-bars-remaining"></div>
    </div>

    <div class="cfo-panel">
      <h3 class="cfo-panel-title">الخزنة والبنك</h3>
      <div class="cfo-kpis cfo-kpis-3">
        ${cfoKpi('vault','الخزنة (كاش)', fmt(vaultBal)+' ﷼')}
        ${cfoKpi('bank','البنك', fmt(bankBal)+' ﷼')}
        ${cfoKpi('network','الشبكة', fmt(networkBal)+' ﷼')}
      </div>
      ${cfoDeltasRow(netFlowYear, netFlowLastYear, netFlowThisMonth, netFlowLastMonth)}
      <div class="cfo-visual" id="cfo-trend-cash"></div>
    </div>

    <div class="cfo-panel">
      <h3 class="cfo-panel-title">المشتريات والموردون (مستحقات)</h3>
      <div class="cfo-kpis">
        ${cfoKpi('invoice','مستحق للموردين', fmt(unpaidTotal)+' ﷼')}
        ${cfoKpi('truck','فواتير غير مدفوعة', String(unpaidPurchases.length))}
      </div>
      ${cfoDeltasRow(purchasesYear, purchasesLastYear, purchasesThisMonth, purchasesLastMonth)}
      ${apBars.length ? `<div class="cfo-caption">أعلى الموردين استحقاقاً</div><div class="cfo-visual cfo-bars" id="cfo-bars-ap"></div>` : `<div class="cfo-visual" id="cfo-trend-purchases"></div>`}
    </div>

    <div class="cfo-panel">
      <h3 class="cfo-panel-title">أعمار الذمم المدينة (المتأخرات على العملاء)</h3>
      <div class="cfo-kpis">
        ${cfoKpi('wallet','إجمالي الذمم المدينة', fmt(arData?arData.total:0)+' ﷼')}
        ${cfoKpi('alert','متأخر أكثر من 90 يوم', fmt(arOverdue90)+' ﷼')}
      </div>
      ${arOverdue90>0 ? `<div class="cfo-caption" style="color:var(--red); font-weight:600;">⚠️ يوجد ${fmt(arOverdue90)} ﷼ متأخر السداد أكثر من 90 يوم — راجع شاشة المحاسبة → أعمار الديون</div>` : ''}
      ${arBars.length ? `<div class="cfo-visual cfo-bars" id="cfo-bars-ar"></div>` : `<div class="cfo-caption" style="color:var(--text-muted);">لا توجد ذمم مدينة حالياً</div>`}
    </div>

  `;

  drawLineChart('#cfo-trend-income', incomeTrend.labels, incomeTrend.series);
  drawLineChart('#cfo-trend-cash', cashFlowTrend.labels, cashFlowTrend.series);
  if(apBars.length){ drawBars('#cfo-bars-ap', apBars, 6, v=>fmt(v)+' ﷼'); }
  else { drawLineChart('#cfo-trend-purchases', purchasesTrend.labels, purchasesTrend.series); }
  drawBars('#cfo-bars-remaining', remainBars, 6, v=>fmt(v)+' ﷼');
  if(arBars.length){ drawBars('#cfo-bars-ar', arBars, 4, v=>fmt(v)+' ﷼'); }
}
function groupCount(list, field){
  const map = {};
  list.forEach(x=>{ const k = x[field] || 'غير محدد'; map[k]=(map[k]||0)+1; });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]);
}
/* توزيع "طريقة الدفع" الفعلي: يجمع المبالغ المستلمة فعلياً (paid + paid2) على كل طريقة دفع مسجّلة،
   بحيث يُحتسب كل جزء من الدفعة المقسّمة (channel/channel2) على حدة بمبلغه الحقيقي، وليس مجرد عدّ
   العملاء حسب أول طريقة دفع فقط — فتُطابق النتيجة ما هو موجود فعلياً في بيانات العملاء. */
function groupChannelAmounts(list){
  const map = {};
  list.forEach(x=>{
    const amt1 = num(x.paid);
    if(amt1>0){
      const k1 = canonicalizeChannelName(x.channel) || x.channel || 'غير محدد';
      map[k1] = (map[k1]||0) + amt1;
    }
    const amt2 = num(x.paid2);
    if(amt2>0){
      const k2 = canonicalizeChannelName(x.channel2) || x.channel2 || 'غير محدد';
      map[k2] = (map[k2]||0) + amt2;
    }
  });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]);
}
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

/* رسم بياني دائري (Donut) بألوان هوية البرنامج — يجمع بين الأناقة (فراغ مركزي، نهايات مدورة، فواصل ناعمة)
   وحيوية بصرية أعصر (تدرّج لوني خفيف وظل رقيق لكل شريحة) دون كسر الطابع الهادئ للواجهة. */
function drawDonut(sel, entries, limit=20, formatter){
  const el = $(sel);
  entries = entries.slice(0, limit);
  if(entries.length===0){ el.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">لا توجد بيانات بعد</div>'; return; }
  const total = entries.reduce((s,e)=>s+num(e[1]),0);
  if(total<=0){ el.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">لا توجد بيانات بعد</div>'; return; }

  const cx=100, cy=100, r=72, strokeW=28;
  const circumference = 2*Math.PI*r;
  const gap = entries.length>1 ? 3 : 0;
  let angleStart = -90;
  let segsHtml = '';
  entries.forEach(([k,v],i)=>{
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    const frac = num(v)/total;
    const angle = frac*360 - gap;
    const dash = Math.max(angle,0)/360*circumference;
    const rest = circumference - dash;
    segsHtml += `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${rest.toFixed(1)}"
      transform="rotate(${angleStart} ${cx} ${cy})"
      style="transition:opacity .15s ease;">
      <title>${escapeHtml(String(k))}: ${formatter ? formatter(v) : v}</title>
    </circle>`;
    angleStart += frac*360;
  });

  const legendHtml = entries.map(([k,v],i)=>{
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    const pct = (num(v)/total*100).toFixed(1);
    return `<div class="donut-legend-item" style="display:flex; align-items:center; gap:8px; font-size:12.5px; padding:3px 0;">
      <span style="width:10px; height:10px; border-radius:3px; background:${color}; flex:none;"></span>
      <span style="flex:1; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(k))}</span>
      <span style="font-family:'IBM Plex Mono',monospace; font-weight:600; color:var(--text-muted); font-size:11.5px;">${formatter ? formatter(v) : v}</span>
      <span style="font-family:'IBM Plex Mono',monospace; color:var(--text-muted); font-size:11px; min-width:38px; text-align:left;">${pct}%</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; gap:18px;">
      <svg width="180" height="180" viewBox="0 0 200 200" style="flex:none;">
        ${segsHtml}
        <g text-anchor="middle" style="font-family:'IBM Plex Mono',monospace;">
          <text x="${cx}" y="${cy-3}" font-size="19" font-weight="700" fill="var(--navy)">${fmt(total)}</text>
          <text x="${cx}" y="${cy+15}" font-size="10" fill="var(--text-muted)">الإجمالي</text>
        </g>
      </svg>
      <div style="width:100%; max-width:420px;">${legendHtml}</div>
    </div>`;
}

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
  let totalReg = 0, totalCash = 0, totalNetwork = 0, totalBank = 0, totalAmount = 0;
  for(let day=1; day<=daysInMonth; day++){
    const dateStr = `${yStr}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const regCount = clients.filter(c=>c.date===dateStr).length;
    const dayIn = vaultTx.filter(t=>t.type==='in' && t.date===dateStr);
    const cash = dayIn.filter(t=>(t.destination||'vault')==='vault').reduce((s,t)=>s+num(t.amount),0);
    const network = dayIn.filter(t=>(t.destination||'vault')==='network').reduce((s,t)=>s+num(t.amount),0);
    const bank = dayIn.filter(t=>(t.destination||'vault')==='bank').reduce((s,t)=>s+num(t.amount),0);
    const amount = cash + network + bank;
    const weekday = WEEKDAY_NAMES_AR[new Date(year, month-1, day).getDay()];
    totalReg += regCount; totalCash += cash; totalNetwork += network; totalBank += bank; totalAmount += amount;
    rows.push({ day, dateStr, weekday, regCount, cash, network, bank, amount });
  }
  return { year, month, monthLabel: `${MONTH_NAMES_AR_FULL[month-1]} ${year}`, rows, totalReg, totalCash, totalNetwork, totalBank, totalAmount };
}
function monthlyClientsReportBodyHtml(yearMonth){
  const rep = monthlyClientsDailyReport(yearMonth);
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');
  const rowsHtml = rep.rows.map(r=>`
    <tr>
      <td class="mono">${r.day}</td>
      <td class="mono">${escapeHtml(r.dateStr)}</td>
      <td>${escapeHtml(r.weekday)}</td>
      <td class="mono">${r.regCount}</td>
      <td class="mono">${fmt(r.cash)}</td>
      <td class="mono">${fmt(r.network)}</td>
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
      <thead><tr><th>اليوم</th><th>التاريخ</th><th>اسم اليوم</th><th>عدد العملاء المسجّلين</th><th>نقدي (كاش)</th><th>شبكة</th><th>بنك</th><th>الإجمالي</th></tr></thead>
      <tbody>
        ${rowsHtml}
        <tr style="font-weight:800; background:#F1F4F7;">
          <td colspan="3">الإجمالي</td>
          <td class="mono">${rep.totalReg}</td>
          <td class="mono">${fmt(rep.totalCash)}</td>
          <td class="mono">${fmt(rep.totalNetwork)}</td>
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
    const bank = monthIn.filter(t=>(t.destination||'vault')==='bank').reduce((s,t)=>s+num(t.amount),0);
    return { key:k, label: monthLabelAr(k), regCount, cash, network, bank, total: cash+network+bank };
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
    const cur = sel.value;
    sel.innerHTML = '<option value="">كل موظفي الاستقبال</option>' + opts;
    sel.value = users.some(u=>u.username===cur) ? cur : '';
  });
  wraps.forEach(w=>{ if(w) w.style.display = users.length ? '' : 'none'; });
}
function refreshFilterOptions(){
  if(typeof populateYearFilterSelect==='function') populateYearFilterSelect();
  if(typeof populateReceptionFilterSelects==='function') populateReceptionFilterSelects();
  const courseFilterVal = $('#filter-course').value;
  populateSelect($('#filter-course'), settings.courses.map(c=>c.name), false);
  $('#filter-course').insertAdjacentHTML('afterbegin','<option value="__unknown__">⚠ الدورات غير المعلومة (بدون نوع دورة)</option>');
  $('#filter-course').insertAdjacentHTML('afterbegin','<option value="">كل الدورات</option>');
  $('#filter-course').value = courseFilterVal || '';

  const natFilterVal = $('#filter-nat').value;
  populateSelect($('#filter-nat'), settings.nationalities, false);
  $('#filter-nat').insertAdjacentHTML('afterbegin','<option value="">كل الجنسيات</option>');
  $('#filter-nat').value = natFilterVal || '';

  const companyFilterVal = $('#filter-company').value;
  // نجمع أسماء الشركات من القائمة الرئيسية (تبويب تحويلات الشركات) ومن العملاء المسجَّلين فعلياً، حتى تظهر أي شركة أُضيفت هناك فوراً هنا وتبقى الفلترة مرتبطة بين التبويبين
  const companyNamesForFilter = [...new Set([...companies.map(c=>c.name), ...clients.map(c=>c.companyName)].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  populateSelect($('#filter-company'), companyNamesForFilter, false);
  $('#filter-company').insertAdjacentHTML('afterbegin','<option value="">كل الشركات</option>');
  $('#filter-company').value = companyNamesForFilter.includes(companyFilterVal) ? companyFilterVal : '';
}
function filteredClients(){
  const q = $('#search').value.trim().toLowerCase();
  const fc = $('#filter-course').value;
  const fn = $('#filter-nat').value;
  const fs = $('#filter-status').value;
  const fcomp = $('#filter-company').value;
  const finv = $('#filter-invoice') ? $('#filter-invoice').value : '';
  const fcn = $('#filter-coursenum') ? $('#filter-coursenum').value : '';
  const frn = $('#filter-refnum') ? $('#filter-refnum').value : '';
  const dfrom = $('#cl-date-from').value;
  const dto = $('#cl-date-to').value;
  const paidMinRaw = $('#cl-paid-min').value;
  const paidMaxRaw = $('#cl-paid-max').value;
  const paidMin = paidMinRaw!=='' ? num(paidMinRaw) : null;
  const paidMax = paidMaxRaw!=='' ? num(paidMaxRaw) : null;
  const frecep = $('#filter-reception') ? $('#filter-reception').value : '';
  const rows = clients.filter(c=>{
    // عزل البيانات: دور 'reception' مستثنى من isOwnRecord الفردية هنا تحديداً، لأن السيرفر
    // أصلاً لا يُرجع له إلا تخزينه الخاص (origin='reception' — مساحة واحدة مشتركة بين كل
    // مستخدمي الاستقبال معاً، وليست فردية لكل مستخدم كباقي الأدوار المقيَّدة). راجع
    // clientRecordsVisibilitySql فى server.js وتعليق canSeeAllData فى ui-framework.js.
    if(currentUserRole!=='reception' && !isOwnRecord(c)) return false; // عزل البيانات: عرض فقط — لا يمس المصفوفة الأصلية أبداً
    if(!matchYear(c.date)) return false; // فلتر السنة العلوي (خط دفاع مباشر — بجانب مزامنته لحقلي من/إلى أدناه)
    if(frecep && c.createdBy!==frecep) return false;
    if(showSuspendedOnly && !c.suspended) return false;
    if(showUnpurchasedBagsOnly && !(c.bagSource==='buy' && c.bagStatus!=='purchased' && !c.suspended)) return false;
    if(fc==='__unknown__'){ if(c.courseType && c.courseType.trim()) return false; }
    else if(fc && c.courseType!==fc) return false;
    if(fn && c.nationality!==fn) return false;
    if(fs==='paid' && remaining(c)>0) return false;
    if(fs==='owe' && remaining(c)<=0) return false;
    if(fcomp && c.companyName!==fcomp) return false;
    if(finv==='no' && c.invoice && String(c.invoice).trim()) return false;
    if(finv==='yes' && !(c.invoice && String(c.invoice).trim())) return false;
    if(fcn==='no' && c.courseNumber && String(c.courseNumber).trim()) return false;
    if(fcn==='yes' && !(c.courseNumber && String(c.courseNumber).trim())) return false;
    if(frn==='no' && c.referNum && String(c.referNum).trim()) return false;
    if(frn==='yes' && !(c.referNum && String(c.referNum).trim())) return false;
    if(dfrom && (!c.date || c.date<dfrom)) return false;
    if(dto && (!c.date || c.date>dto)) return false;
    if(paidMin!==null && paidTotal(c)<paidMin) return false;
    if(paidMax!==null && paidTotal(c)>paidMax) return false;
    if(q){
      const hay = [c.name,c.phone,c.clientId,c.invoice,c.referNum,c.courseNumber].join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0));
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
