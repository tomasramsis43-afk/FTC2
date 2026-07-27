/* ---------------- Dashboard ---------------- */
function renderDashboard(){
  const c = clients.filter(x=>matchYear(x.date));
  const totalPaid = c.reduce((s,x)=>s+paidTotal(x),0);
  const totalRemaining = c.filter(x=>!x.suspended && !x.cancelled).reduce((s,x)=>s+remaining(x),0);
  // لا تُعرض أرقام الملخص السريع (عميل/مستلم/متبقي) لدور "استقبال" — هذا الشريط موجود في الهيدر
  // العلوي بمعزل عن تبويب لوحة التحكم نفسه (المحجوب عنهم أصلاً عبر rolePermissions)، فكان يفضح
  // إجمالي المبالغ المالية للاستقبال رغم عدم وصولهم لأي شاشة مالية أخرى في البرنامج.
  $('#quickstats').innerHTML = (currentUserRole==='reception') ? '' : `
    <div><div class="n">${c.length}</div><div class="l">عميل</div></div>
    <div><div class="n">${fmt(totalPaid)}</div><div class="l">مستلم</div></div>
    <div><div class="n">${fmt(totalRemaining)}</div><div class="l">متبقي</div></div>
  `;
  renderCfoDashboard();
  renderSmartAlerts();
  renderCloseOverview(c, totalPaid, totalRemaining);
}

/* ============ التنبيهات الذكية (Smart Alerts) ============ */
function daysSinceDate(dateStr){
  if(!dateStr) return 0;
  const d = new Date(dateStr);
  if(isNaN(d.getTime())) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function renderSmartAlerts(){
  const el = $('#smart-alerts-panel');
  if(!el) return;
  const alerts = [];

  // ١) حقائب مطلوب شراؤها متأخرة عن الحد المسموح
  const overdueDays = settings.bagOverdueDays || 14;
  const overdueBags = clients.filter(c=> c.bagSource==='buy' && c.bagStatus!=='purchased' && !c.suspended && daysSinceDate(c.date) > overdueDays);
  if(overdueBags.length){
    alerts.push({level:'red', icon:'👜', text:`${overdueBags.length} حقيبة مطلوب شراؤها تجاوزت ${overdueDays} يوم بدون شراء`, view:'clients'});
  }

  // ٢) انخفاض رصيد الخزنة + البنك عن الحد الأدنى
  const today = todayISO();
  const liquid = balanceOfAsOf('vault', today) + balanceOfAsOf('bank', today);
  const threshold = settings.lowBalanceThreshold ?? 5000;
  if(liquid < threshold){
    alerts.push({level:'red', icon:'💰', text:`رصيد الخزنة والبنك (${fmt(liquid)}) أقل من الحد الأدنى المحدد (${fmt(threshold)})`, view:'vault'});
  }

  // ٣) اقتراب انتهاء الترخيص
  if(LICENSE_EXPIRY_DATE){
    const daysLeft = Math.ceil((new Date(LICENSE_EXPIRY_DATE).getTime() - Date.now()) / 86400000);
    if(daysLeft <= 14 && daysLeft >= 0){
      alerts.push({level:'gold', icon:'🔑', text:`ترخيص البرنامج سينتهي خلال ${daysLeft} يوم — يُرجى التجديد قريباً`});
    }
  }

  // ٤) دورات قريبة من اكتمال العدد (لم تكتمل بعد)
  if(typeof coursesFilteredSessions==='function' && typeof groupClientsByCourseNumber==='function'){
    const byCourseNumber = groupClientsByCourseNumber();
    const nearFull = courseSessions.filter(s=>{
      if(!s.capacity) return false;
      const enrolled = (byCourseNumber.get(s.courseNumber)||[]).filter(c=>!c.cancelled).length;
      const ratio = enrolled / s.capacity;
      return ratio >= 0.8 && enrolled < s.capacity;
    });
    if(nearFull.length){
      alerts.push({level:'gold', icon:'📚', text:`${nearFull.length} دورة اقتربت من اكتمال العدد (80% فأكثر)`, view:'courses'});
    }
  }

  // ٥) تذكير بالنسخ الاحتياطي التلقائي (لو معطّل أو متأخر بشكل غير متوقع)
  if(!settings.autoBackupEnabled){
    alerts.push({level:'gold', icon:'💾', text:'النسخ الاحتياطي التلقائي معطّل حالياً — يُفضّل تفعيله من الإعدادات', view:'settings'});
  }

  // ٦) ملخص الشهر الماضي جاهز للإرسال عبر واتساب (يظهر أول 7 أيام من الشهر الجديد فقط ولمرة واحدة لكل شهر)
  if(settings.monthlyReportWhatsapp && typeof lastCompleteMonthKey==='function'){
    const key = lastCompleteMonthKey();
    const dayOfMonth = new Date().getDate();
    if(dayOfMonth<=7 && settings.lastMonthlyReportPromptMonth!==key){
      alerts.push({level:'gold', icon:'📤', text:`ملخص ${monthLabelAr(key)} جاهز — اضغط لإرساله عبر واتساب`, action:'monthly-wa', actionKey:key});
    }
  }

  window.__openAlertsCount = alerts.length;
  if(!alerts.length){ el.innerHTML = ''; return; }
  el.innerHTML = `<div class="panel" style="border-right:4px solid var(--red);">
    <h3 style="margin:0 0 8px;">🔔 تنبيهات تحتاج انتباهك</h3>
    ${alerts.map(a=> `<div style="display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--border);" ${a.view?`class="sa-alert-item" data-sa-view="${a.view}" style="cursor:pointer;"`:(a.action?`class="sa-alert-item" data-sa-action="${a.action}" data-sa-action-key="${a.actionKey||''}" style="cursor:pointer;"`:'')}>
      <span style="font-size:18px;">${a.icon}</span>
      <span style="font-size:13px; color:${a.level==='red'?'var(--red)':'var(--gold-dark)'};">${escapeHtml(a.text)}</span>
    </div>`).join('')}
  </div>`;
}
$('#smart-alerts-panel')?.addEventListener('click', async e=>{
  const actionItem = e.target.closest('[data-sa-action]');
  if(actionItem){
    if(actionItem.dataset.saAction==='monthly-wa'){
      const key = actionItem.dataset.saActionKey;
      sendMonthlyReportWhatsapp(key);
      settings.lastMonthlyReportPromptMonth = key;
      await saveSettings();
      renderSmartAlerts();
    }
    return;
  }
  const item = e.target.closest('[data-sa-view]');
  if(!item) return;
  document.querySelector(`nav.tabs button[data-view="${item.dataset.saView}"]`)?.click();
});


/* ============ لوحة "النظرة التنفيذية" — عصرية بطابع لوحات إقفال الحسابات ============ */
function closeRingSvg(pct, size, strokeW, color){
  const p = Math.max(0, Math.min(100, pct));
  const r = (size/2) - (strokeW/2) - 1;
  const circumference = 2 * Math.PI * r;
  const dash = (p/100) * circumference;
  return `<svg viewBox="0 0 ${size} ${size}">
    <circle class="close-ring-track" cx="${size/2}" cy="${size/2}" r="${r}" stroke-width="${strokeW}"></circle>
    <circle class="close-ring-fill" cx="${size/2}" cy="${size/2}" r="${r}" stroke-width="${strokeW}"
      style="stroke:${color}; stroke-dasharray:${dash} ${circumference};"></circle>
  </svg>`;
}
function closeEntityRingSvg(pct, color){
  const size=44, strokeW=5;
  const r = (size/2) - (strokeW/2);
  const circumference = 2 * Math.PI * r;
  const dash = (Math.max(0,Math.min(100,pct))/100) * circumference;
  return `<svg viewBox="0 0 ${size} ${size}">
    <circle class="close-entity-ring-track" cx="${size/2}" cy="${size/2}" r="${r}"></circle>
    <circle class="close-entity-ring-fill" cx="${size/2}" cy="${size/2}" r="${r}"
      style="stroke:${color}; stroke-dasharray:${dash} ${circumference};"></circle>
  </svg>`;
}
function renderCloseOverview(c, totalPaid, totalRemaining){
  const el = $('#close-overview');
  if(!el) return;
  const overdueDays = settings.paymentOverdueDays || 30;
  const active = c.filter(x=>!x.suspended && !x.cancelled);
  const fullyPaid = active.filter(x=> remaining(x) <= 0);
  const owing = active.filter(x=> remaining(x) > 0);
  const overdue = owing.filter(x=> daysSinceDate(x.date) > overdueDays);
  const onTrack = owing.filter(x=> daysSinceDate(x.date) <= overdueDays);

  const collectionBase = totalPaid + totalRemaining;
  const collectionPct = collectionBase > 0 ? (totalPaid/collectionBase)*100 : 100;
  const isDone = collectionPct >= 99.5;

  const purchasedBuy = clients.filter(x=>x.bagSource==='buy' && x.bagStatus==='purchased' && !x.suspended);
  const pendingBuy = clients.filter(x=>x.bagSource==='buy' && x.bagStatus!=='purchased' && !x.suspended);
  const bagsBase = purchasedBuy.length + pendingBuy.length;
  const bagsPct = bagsBase > 0 ? (purchasedBuy.length/bagsBase)*100 : 100;

  const fullyPaidPct = active.length > 0 ? (fullyPaid.length/active.length)*100 : 100;
  const alertsCount = window.__openAlertsCount || 0;
  const alertsPct = alertsCount === 0 ? 100 : Math.max(10, 100 - alertsCount*15);

  const metric = (name, tag, num, pct, warn) => `
    <div class="close-metric">
      <div class="close-metric-head">
        <span class="close-metric-name">${escapeHtml(name)}</span>
        ${tag ? `<span class="close-metric-tag">${escapeHtml(tag)}</span>` : ''}
      </div>
      <div class="close-metric-num">${num}</div>
      <div class="close-metric-track"><div class="close-metric-fill ${warn?'warn':''}" style="width:${pct.toFixed(0)}%"></div></div>
    </div>`;

  el.innerHTML = `
    <div class="close-ring-col">
      <div class="close-ring-wrap">
        ${closeRingSvg(collectionPct, 168, 10, isDone ? 'var(--teal)' : 'var(--gold)')}
        <div class="close-ring-center">
          <div class="close-ring-pct">${collectionPct.toFixed(0)}<span>%</span></div>
          <div class="close-ring-label">${tr('closeRingLabel')}</div>
        </div>
      </div>
      <div class="close-status-chip ${isDone?'done':'pending'}">${isDone ? tr('closeRingDone') : tr('closeRingPending')}</div>
      <div class="close-target">${tr('closeTarget')}</div>
      <div class="close-remaining">${tr('closeRemainingPrefix')} <b>${fmt(totalRemaining)}</b> ${tr('closeRemainingSuffix')} (${owing.length})</div>
    </div>
    <div class="close-body">
      <div class="close-status-row">
        <div class="close-status-item teal"><span class="dot"></span><span class="n">${fullyPaid.length}</span><span class="l">${tr('closeStatusPaid')}</span></div>
        <div class="close-status-item navy"><span class="dot"></span><span class="n">${onTrack.length}</span><span class="l">${tr('closeStatusOwe')}</span></div>
        <div class="close-status-item gold"><span class="dot"></span><span class="n">${overdue.length}</span><span class="l">${tr('closeStatusOverdue')}</span></div>
      </div>
      <div class="close-metrics-grid">
        ${metric(tr('closeMetricCollections'), null, fmt(totalPaid)+' / '+fmt(collectionBase), collectionPct, collectionPct<80)}
        ${metric(tr('closeMetricBags'), pendingBuy.length? `${pendingBuy.length} ${currentLang==='ar'?'متبقية':'left'}`:null, `${purchasedBuy.length} / ${bagsBase}`, bagsPct, bagsPct<80)}
        ${metric(tr('closeMetricFullyPaid'), null, `${fullyPaid.length} / ${active.length}`, fullyPaidPct, fullyPaidPct<70)}
        ${metric(tr('closeMetricAlerts'), null, String(alertsCount), alertsPct, alertsCount>0)}
      </div>
    </div>
  `;
  renderCloseEntities();
}
function renderCloseEntities(){
  const panel = $('#close-entities-panel');
  const grid = $('#close-entities-grid');
  if(!panel || !grid) return;
  if(typeof courseSessions==='undefined' || typeof groupClientsByCourseNumber!=='function'){ panel.style.display='none'; return; }
  const sessionsWithCapacity = courseSessions.filter(s=>s.capacity);
  if(!sessionsWithCapacity.length){ panel.style.display='none'; return; }
  const byCourseNumber = groupClientsByCourseNumber();
  const buckets = { early:[], onTrack:[], nearFull:[], complete:[] };
  sessionsWithCapacity.forEach(s=>{
    const enrolled = (byCourseNumber.get(s.courseNumber)||[]).filter(c=>!c.cancelled).length;
    const ratio = s.capacity ? enrolled/s.capacity : 0;
    if(ratio >= 1) buckets.complete.push(s);
    else if(ratio >= 0.8) buckets.nearFull.push(s);
    else if(ratio >= 0.25) buckets.onTrack.push(s);
    else buckets.early.push(s);
  });
  const total = sessionsWithCapacity.length;
  panel.style.display = '';
  const card = (key, label, color) => {
    const n = buckets[key].length;
    const pct = total ? (n/total)*100 : 0;
    return `<div class="close-entity-card">
      <div class="close-entity-info">
        <div class="l"><span class="dot" style="background:${color}"></span>${escapeHtml(label)}</div>
        <div class="n">${n}</div>
        <div class="of">${tr('closeEntityOf')} ${total} ${tr('closeEntityCourses')}</div>
      </div>
      <div class="close-entity-ring">
        ${closeEntityRingSvg(pct, color)}
        <div class="close-entity-ring-txt">${pct.toFixed(0)}%</div>
      </div>
    </div>`;
  };
  grid.innerHTML = [
    card('early', tr('closeEntityEarly'), 'var(--gold-soft)'),
    card('onTrack', tr('closeEntityOnTrack'), 'var(--navy)'),
    card('nearFull', tr('closeEntityNearFull'), 'var(--gold)'),
    card('complete', tr('closeEntityComplete'), 'var(--teal)')
  ].join('');
}

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

  `;

  drawLineChart('#cfo-trend-income', incomeTrend.labels, incomeTrend.series);
  drawLineChart('#cfo-trend-cash', cashFlowTrend.labels, cashFlowTrend.series);
  if(apBars.length){ drawBars('#cfo-bars-ap', apBars, 6, v=>fmt(v)+' ﷼'); }
  else { drawLineChart('#cfo-trend-purchases', purchasesTrend.labels, purchasesTrend.series); }
  drawBars('#cfo-bars-remaining', remainBars, 6, v=>fmt(v)+' ﷼');
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
      <div class="label">${k}</div>
      <div class="track"><div class="fill" style="width:${(v/max*100).toFixed(1)}%"></div></div>
      <div class="val">${formatter ? formatter(v) : v}</div>
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
  win.document.close();
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
  sel.innerHTML = (withEmpty?'<option value="">—</option>':'') + values.map(v=>`<option value="${v}">${v}</option>`).join('');
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
    if(!isOwnRecord(c)) return false; // عزل البيانات: عرض فقط — لا يمس المصفوفة الأصلية أبداً
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
/* ============ نظام ترقيم صفحات عام (يُستخدم في كل الشيتات الطويلة) ============
   لكل جدول: state = {page:1, sig:''} خاص به، وبادئة (prefix) فريدة لعناصر الـ HTML:
   #{prefix}-pagination, #{prefix}-page-size, #{prefix}-page-info, #{prefix}-page-current,
   #{prefix}-page-first/prev/next/last */
function genericPageSize(prefix){
  const v = $(`#${prefix}-page-size`)?.value || '50';
  return v==='all' ? Infinity : Number(v);
}
function applyGenericPagination(prefix, rows, state, filterSigParts){
  const sig = JSON.stringify(filterSigParts);
  if(sig !== state.sig){ state.page = 1; state.sig = sig; }
  const pageSize = genericPageSize(prefix);
  const totalPages = Number.isFinite(pageSize) ? Math.max(1, Math.ceil(rows.length/pageSize)) : 1;
  if(state.page > totalPages) state.page = totalPages;
  if(state.page < 1) state.page = 1;
  const pageRows = Number.isFinite(pageSize) ? rows.slice((state.page-1)*pageSize, state.page*pageSize) : rows;
  const pag = $(`#${prefix}-pagination`);
  if(pag){
    pag.style.display = rows.length ? '' : 'none';
    const startN = rows.length ? (state.page-1)*(Number.isFinite(pageSize)?pageSize:rows.length)+1 : 0;
    const endN = Number.isFinite(pageSize) ? Math.min(rows.length, state.page*pageSize) : rows.length;
    const infoEl = $(`#${prefix}-page-info`); if(infoEl) infoEl.textContent = rows.length ? `عرض ${startN} - ${endN} من ${rows.length}` : '';
    const curEl = $(`#${prefix}-page-current`); if(curEl) curEl.textContent = `صفحة ${state.page} / ${totalPages}`;
    const fb = $(`#${prefix}-page-first`); if(fb) fb.disabled = state.page<=1;
    const pb = $(`#${prefix}-page-prev`); if(pb) pb.disabled = state.page<=1;
    const nb = $(`#${prefix}-page-next`); if(nb) nb.disabled = state.page>=totalPages;
    const lb = $(`#${prefix}-page-last`); if(lb) lb.disabled = state.page>=totalPages;
  }
  return pageRows;
}
function bindGenericPagination(prefix, state, renderFn){
  $(`#${prefix}-page-size`)?.addEventListener('change', ()=>{ state.page=1; renderFn(); });
  $(`#${prefix}-page-first`)?.addEventListener('click', ()=>{ state.page=1; renderFn(); });
  $(`#${prefix}-page-prev`)?.addEventListener('click', ()=>{ state.page=Math.max(1,state.page-1); renderFn(); });
  $(`#${prefix}-page-next`)?.addEventListener('click', ()=>{ state.page=state.page+1; renderFn(); });
  $(`#${prefix}-page-last`)?.addEventListener('click', ()=>{ state.page=Infinity; renderFn(); });
}
function currentTablePageSize(){
  const v = $('#table-page-size')?.value || '100';
  return v==='all' ? Infinity : Number(v);
}
let renderTableSeq = 0; // يمنع تعارض ردود طلبات متتالية سريعة (تغيير صفحة/فلتر قبل وصول رد الطلب السابق)
// الأعمدة المدعومة للفرز من السيرفر (مطابقة لِما يدعمه GET /api/clients بالضبط) — أي فرز
// بعمود آخر (مثل الإجمالي/المدفوع/المتبقي، التي تحتاج حسابات معقّدة) يُبقي الوضع على المسار المحلي.
const SERVER_SORTABLE_CLIENT_COLS = { name:1, date:1, clientId:1, courseType:1, nationality:1 };
function clientsQueryIsSimple(){
  // عزل البيانات: المسار السريع يستعلم مباشرة من السيرفر بكل العملاء بدون فلترة الملكية، فيجب
  // تعطيله لأي مستخدم مقيَّد لإجباره على المسار المحلي الذي يطبّق isOwnRecord() في filteredClients().
  // (هذا فقط يختار أي مسار عرض يُستخدم — لا يُعيد تعيين مصفوفة clients نفسها بأي شكل).
  if(!canSeeAllData()) return false;
  if(showSuspendedOnly || showUnpurchasedBagsOnly) return false;
  if($('#filter-company')?.value) return false;
  if($('#filter-invoice')?.value) return false;
  if($('#filter-coursenum')?.value) return false;
  if($('#filter-refnum')?.value) return false;
  if(($('#cl-paid-min')?.value||'') !== '' || ($('#cl-paid-max')?.value||'') !== '') return false;
  if($('#filter-status')?.value) return false; // مدين/مسدد يحتاج حساب المتبقي الكامل (خصومات، دفعات...)
  if(clientsSortState.key && !SERVER_SORTABLE_CLIENT_COLS[clientsSortState.key]) return false;
  return true;
}
async function renderTable(){
  const mySeq = ++renderTableSeq;
  const filterSig = JSON.stringify([
    $('#search')?.value, $('#filter-course')?.value, $('#filter-nat')?.value, $('#filter-status')?.value,
    $('#filter-company')?.value, $('#filter-invoice')?.value, $('#filter-coursenum')?.value, $('#filter-refnum')?.value, $('#cl-date-from')?.value, $('#cl-date-to')?.value,
    $('#cl-paid-min')?.value, $('#cl-paid-max')?.value, showSuspendedOnly, showUnpurchasedBagsOnly
  ]);
  if(filterSig !== tableLastFilterSig){ tableCurrentPage = 1; tableLastFilterSig = filterSig; }
  const pageSize = currentTablePageSize();

  if(clientsQueryIsSimple() && Number.isFinite(pageSize)){
    // المسار السريع: نطلب من السيرفر فقط سجلات الصفحة الحالية (ترقيم/بحث/فلترة حقيقية من قاعدة
    // البيانات)، بدل تحميل ومعالجة وتقطيع آلاف السجلات المحمّلة أصلاً بالمتصفح في كل مرة — أخف
    // وأسرع بكثير على جهاز المستخدم، خصوصاً على الجوال. أي فلتر غير مدعوم بالسيرفر (البند أعلاه)
    // يُبقي العمل بالطريقة المحلية القديمة تماماً كما كانت قبل هذا التحديث دون أي فرق في النتيجة.
    try{
      const params = new URLSearchParams();
      params.set('page', tableCurrentPage);
      params.set('pageSize', pageSize);
      const q = ($('#search')?.value||'').trim(); if(q) params.set('search', q);
      const fc = $('#filter-course')?.value; if(fc && fc!=='__unknown__') params.set('courseType', fc);
      const fn = $('#filter-nat')?.value; if(fn) params.set('nationality', fn);
      const dfrom = $('#cl-date-from')?.value; if(dfrom) params.set('dateFrom', dfrom);
      const dto = $('#cl-date-to')?.value; if(dto) params.set('dateTo', dto);
      if(clientsSortState.key){ params.set('sort', clientsSortState.key); params.set('order', clientsSortState.dir===-1?'desc':'asc'); }
      const res = await serverFetch('/api/clients?'+params.toString());
      if(mySeq !== renderTableSeq) return; // وصل رد لطلب قديم تجاوزه المستخدم فعلاً (غيّر الصفحة/الفلتر) — نتجاهله
      if(!res.ok) throw new Error('server pagination failed');
      const data = await res.json();
      // حماية عامة: لو السيرفر رجّع 0 نتيجة لأي تركيبة فلاتر (بحث/نوع دورة/جنسية/تاريخ)، بينما
      // نفس هذه الفلاتر مطبّقة محلياً على البيانات المحمّلة أصلاً بالمتصفح (clients) تُعطي نتائج
      // فعلية — هذا يعني عدم تطابق بين clients_rows على السيرفر والبيانات الحقيقية (مثال: نوع
      // دورة تمت إعادة تسميته، أو خلل مؤقت في مزامنة clients_rows)، فنتجاهل رد السيرفر المضلِّل
      // ونكمل تلقائياً للمسار المحلي الكامل أدناه (فلترة دقيقة 100% من نفس البيانات) بدل عرض
      // جدول فارغ خطأً للمستخدم رغم وجود بيانات فعلية مطابقة.
      const localMatches = clients.filter(c=>{
        if(q){
          const hay = [c.name, c.clientId, c.referNum, c.invoice].map(v=>String(v||'').toLowerCase());
          if(!hay.some(v=>v.includes(q.toLowerCase()))) return false;
        }
        if(fc==='__unknown__'){ if(c.courseType && c.courseType.trim()) return false; }
        else if(fc && c.courseType!==fc) return false;
        if(fn && c.nationality!==fn) return false;
        if(dfrom && (!c.date || c.date<dfrom)) return false;
        if(dto && (!c.date || c.date>dto)) return false;
        return true;
      }).length;
      if(data.total === 0 && localMatches > 0){
        throw new Error('server returned suspicious empty result');
      }
      renderClientsTableRows(data.rows, data.total, data.total, pageSize);
      return;
    }catch(e){
      // فشل الاتصال بالمسار السريع (مثلاً الخادم نائم لحظياً على الاستضافة المجانية) — نكمل
      // فوراً بالطريقة المحلية القديمة أدناه كخط رجعة آمن، بدون أي رسالة خطأ مزعجة للمستخدم
    }
  }

  // المسار الكامل المحلي (فلاتر/فرز غير مدعوم بالسيرفر، أو تعذّر الاتصال بالمسار السريع أعلاه) —
  // نفس المنطق والنتيجة تماماً كما كانا قبل إضافة الترقيم من السيرفر.
  let rows = filteredClients();
  if(mySeq !== renderTableSeq) return;
  const totalPages = Number.isFinite(pageSize) ? Math.max(1, Math.ceil(rows.length/pageSize)) : 1;
  if(tableCurrentPage > totalPages) tableCurrentPage = totalPages;
  if(tableCurrentPage < 1) tableCurrentPage = 1;
  const pageRows = Number.isFinite(pageSize) ? rows.slice((tableCurrentPage-1)*pageSize, tableCurrentPage*pageSize) : rows;
  renderClientsTableRows(pageRows, rows.length, clients.length, pageSize);
}
// يرسم صفوف الجدول وشريط الترقيم فعلياً — يُستخدَم من كلا مساري renderTable (السيرفر والمحلي)
// حتى لا يتكرر كود بناء HTML للصف في مكانين قد يختلفان عن بعض بمرور الوقت.
function renderClientsTableRows(pageRows, filteredTotal, grandTotal, pageSize){
  const cfc = $('#clients-filtered-count'); if(cfc) cfc.textContent = filteredTotal;
  const ctc = $('#clients-total-count'); if(ctc) ctc.textContent = canSeeAllData() ? clients.length : clients.filter(c=>isOwnRecord(c)).length;

  $('#empty-state').style.display = filteredTotal ? 'none' : 'block';

  const totalPages = Number.isFinite(pageSize) ? Math.max(1, Math.ceil(filteredTotal/pageSize)) : 1;
  const pag = $('#table-pagination');
  if(pag){
    pag.style.display = filteredTotal ? '' : 'none';
    const startN = filteredTotal ? (tableCurrentPage-1)*(Number.isFinite(pageSize)?pageSize:filteredTotal)+1 : 0;
    const endN = Number.isFinite(pageSize) ? Math.min(filteredTotal, tableCurrentPage*pageSize) : filteredTotal;
    $('#table-page-info').textContent = filteredTotal ? `عرض ${startN} - ${endN} من ${filteredTotal}` : '';
    $('#table-page-current').textContent = `صفحة ${tableCurrentPage} / ${totalPages}`;
    $('#table-page-first').disabled = tableCurrentPage<=1;
    $('#table-page-prev').disabled = tableCurrentPage<=1;
    $('#table-page-next').disabled = tableCurrentPage>=totalPages;
    $('#table-page-last').disabled = tableCurrentPage>=totalPages;
  }

  currentPageClientIds = pageRows.map(c=>c.id);
  $('#table-body').innerHTML = pageRows.map(c=>{
    const rem = remaining(c);
    const nameBadges = `${escapeHtml(c.name)}${phoneWithWhatsapp(c.phone)}${c.cancelled ? ' <span class="stamp owe">ملغى</span>' : ''}${c.absent ? ' <span class="stamp owe">غياب</span>' : ''}${c.suspended ? ' <span class="stamp owe">موقوف</span>' : ''}`;
    return `<tr${(c.cancelled || c.suspended) ? ' style="opacity:.55;"' : ''}>
      <td class="sticky-col sticky-col-1" data-label=""><input type="checkbox" class="row-select-client" data-id="${c.id}" ${selectedClientIds.has(c.id)?'checked':''}></td>
      <td class="sticky-col sticky-col-2 card-full" data-label="الاسم">${nameBadges}</td>
      <td class="mono" data-label="رقم الهوية">${escapeHtml(c.clientId||'—')}</td>
      <td class="mono" data-label="الرقم المرجعي">${escapeHtml(c.referNum||'—')}</td>
      <td data-label="الجنسية">${escapeHtml(c.nationality||'')}</td>
      <td data-label="الدورة">${escapeHtml(c.courseType||'')}</td>
      <td class="mono" data-label="رقم الدورة">${escapeHtml(c.courseNumber||'—')}</td>
      <td class="mono" data-label="رقم الفاتورة">${escapeHtml(c.invoice||'—')}</td>
      <td class="mono" data-label="تاريخ التسجيل">${formatDateDisplay(c.date)||'—'}</td>
      <td class="mono" data-label="الإجمالي">${fmt(total(c))}</td>
      <td class="mono" data-label="المدفوع">${fmt(paidTotal(c))}</td>
      <td class="mono" data-label="المتبقي"><span class="stamp ${rem>0?'owe':'paid'}">${fmt(rem)}</span></td>
      <td data-label="الحقيبة"><span class="stamp ${c.bagSource==='buy' && c.bagStatus!=='purchased' ? 'owe':'paid'}">${bagSourceLabel(c)}</span>${bagBuyCheckboxHtml(c)}${bagCancelBtnHtml(c)}</td>
      <td data-label="طريقة الدفع"><span class="stamp channel">${escapeHtml(paymentChannelsLabel(c))}</span></td>
      <td class="card-full" data-label="" style="white-space:nowrap;">
        <div class="row-menu">
          <button type="button" class="btn btn-ghost btn-sm row-menu-toggle" title="إجراءات" aria-haspopup="true" aria-expanded="false">⋮</button>
          <div class="row-menu-panel" role="menu">
            <button class="btn btn-gold btn-sm" data-invoice="${c.id}">${tr('invoiceBtn')}</button>
            ${(c.taxInvoiceNo && canDeleteClientRecord(c)) ? `<button class="btn btn-danger btn-sm" data-delinvoice="${c.id}" title="حذف الفاتورة الضريبية الصادرة لهذا العميل (حذف منطقي مع الاحتفاظ بالرقم التسلسلي)">حذف الفاتورة</button>` : ''}
            ${canReceptionEditClient(c) ? `<button class="btn btn-ghost btn-sm" data-edit="${c.id}">${tr('edit')}</button>` : `<span class="btn btn-ghost btn-sm" style="opacity:.5;cursor:not-allowed" title="انتهت مهلة التعديل (5 ساعات من التسجيل) — للأدمن فقط الآن">${tr('edit')} 🔒</span>`}
            ${c.suspended
              ? `<button class="btn btn-ghost btn-sm" data-unsuspend="${c.id}" title="إعادة العميل ليظهر في شيت الدورات ومخزون الحقائب">إلغاء الإيقاف</button>`
              : `<button class="btn btn-ghost btn-sm" data-suspend="${c.id}" title="إيقاف العميل مؤقتاً — يبقى في شيت العملاء لكن يختفي من شيت الدورات ومخزون الحقائب">موقوف</button>`}
            ${canDeleteClientRecord(c) ? `<button class="btn btn-danger btn-sm" data-del="${c.id}">${tr('delete')}</button>` : ''}
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
  // نحذف من التحديد أي عميل لم يعد موجوداً أصلاً (حُذف من مكان آخر)، حتى لا يبقى تحديد "شبح"
  const allIds = new Set(clients.map(c=>c.id));
  [...selectedClientIds].forEach(id=>{ if(!allIds.has(id)) selectedClientIds.delete(id); });
  renderBulkSelectionBar({length: filteredTotal});
}

let selectedClientIds = new Set();
let currentPageClientIds = [];
function renderBulkSelectionBar(filteredRows){
  const bar = $('#bulk-actions-bar');
  if(!bar) return;
  const count = selectedClientIds.size;
  bar.style.display = count>0 ? '' : 'none';
  $('#bulk-selected-count').textContent = count;
  $('#bulk-filtered-total').textContent = filteredRows.length;
  const selectAllBox = $('#select-all-clients');
  if(selectAllBox){
    const pageIds = currentPageClientIds;
    const selectedOnPage = pageIds.filter(id=>selectedClientIds.has(id)).length;
    selectAllBox.checked = pageIds.length>0 && selectedOnPage===pageIds.length;
    selectAllBox.indeterminate = selectedOnPage>0 && selectedOnPage<pageIds.length;
  }
}
$('#table-body').addEventListener('change', e=>{
  if(e.target.classList.contains('row-select-client')){
    const id = e.target.dataset.id;
    if(e.target.checked) selectedClientIds.add(id); else selectedClientIds.delete(id);
    renderBulkSelectionBar(filteredClients());
  }
});
$('#select-all-clients').addEventListener('change', e=>{
  if(e.target.checked) currentPageClientIds.forEach(id=>selectedClientIds.add(id));
  else currentPageClientIds.forEach(id=>selectedClientIds.delete(id));
  renderTable();
});
$('#btn-select-all-filtered').addEventListener('click', ()=>{
  filteredClients().forEach(c=>selectedClientIds.add(c.id));
  renderTable();
});
$('#btn-clear-selection').addEventListener('click', ()=>{
  selectedClientIds.clear();
  renderTable();
});
$('#btn-bulk-delete-selected').addEventListener('click', async ()=>{
  const allIds = [...selectedClientIds].filter(id=>clients.some(c=>c.id===id));
  if(!allIds.length){ showToast('لا يوجد عملاء محددين'); return; }
  const ids = allIds.filter(id=>canDeleteClientRecord(clients.find(c=>c.id===id)));
  const blockedCount = allIds.length - ids.length;
  if(!ids.length){ showToast(blockedCount ? `🔒 كل السجلات المحددة (${blockedCount}) خارج مهلة الحذف المسموح بها أو الحذف معطَّل لصلاحيتك` : 'لا يوجد عملاء محددين'); return; }
  if(blockedCount) showToast(`⚠️ تم استبعاد ${blockedCount} سجل خارج مهلة الحذف المسموح بها`);
  const namesPreview = clients.filter(c=>ids.includes(c.id)).slice(0,5).map(c=>c.name).join('، ');
  const extra = ids.length>5 ? ` وآخرين (${ids.length-5})` : '';
  if(!await customConfirm(`تأكيد حذف ${ids.length} عميل دفعة واحدة؟ (${namesPreview}${extra})\nسيُحذف أيضاً أي ترحيل مالي تلقائي مرتبط بكل عميل منهم. هذا الإجراء لا يمكن التراجع عنه.`)) return;
  snapshotState(`حذف مجموعة عملاء دفعة واحدة (${ids.length} عميل)`);
  const removedNames = clients.filter(c=>ids.includes(c.id)).map(c=>c.name);
  clients = clients.filter(c=>!ids.includes(c.id));
  ids.forEach(id=>removeClientLedgerEntries(id));
  await saveClients(true); await saveVaultTx();
  await logAudit('delete','العملاء', `تم حذف ${ids.length} عميل دفعة واحدة: ${removedNames.slice(0,20).join('، ')}${removedNames.length>20?` وآخرين (${removedNames.length-20})`:''}`);
  selectedClientIds.clear();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderCourses(); renderBags();
  if(typeof renderVault==='function') renderVault();
  showToast(`تم حذف ${ids.length} عميل بنجاح`);
});
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* تطبيع رقم جوال العميل ليتوافق مع صيغة واتساب الدولية (يفترض أرقام السعودية عند غياب رمز الدولة) */
function normalizePhoneForWhatsapp(phone){
  let p = String(phone||'').replace(/[^0-9]/g,'');
  if(!p) return '';
  if(p.startsWith('00')) p = p.slice(2);
  if(p.startsWith('0')) p = '966' + p.slice(1);          // 05XXXXXXXX -> 9665XXXXXXXX
  else if(p.length===9 && p.startsWith('5')) p = '966' + p; // 5XXXXXXXX (بدون صفر) -> 9665XXXXXXXX
  if(!/^\d{8,15}$/.test(p)) return '';
  return p;
}
/* رابط "wa.me" لمراسلة العميل مباشرة عبر واتساب، أو نص فارغ إن كان الرقم غير صالح للتطبيع */
function whatsappLink(phone){
  const p = normalizePhoneForWhatsapp(phone);
  return p ? `https://wa.me/${p}` : '';
}
const WA_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="flex:none;"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.86 9.86 0 0 0 12.04 2zm0 18.06h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.34c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.18 8.18 0 0 1 2.41 5.83c0 4.55-3.7 8.24-8.24 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.13-.17.24-.64.8-.78.97-.14.17-.29.19-.53.06-.25-.12-1.04-.38-1.99-1.22-.73-.66-1.23-1.47-1.37-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.17.04-.31-.02-.43-.06-.12-.56-1.35-.77-1.85-.2-.48-.4-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.86.84-.86 2.05s.88 2.38 1 2.55c.12.17 1.73 2.64 4.2 3.7.59.25 1.05.4 1.41.51.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.15-1.18-.06-.1-.23-.16-.48-.28z"/></svg>';
/* يبني HTML للرقم بجانب اسم العميل: رابط واتساب قابل للنقر إن أمكن تطبيع الرقم، وإلا نص عادي */
function phoneWithWhatsapp(phone){
  if(!phone) return '';
  const link = whatsappLink(phone);
  if(!link) return ` <span class="mono" style="color:var(--text-muted); font-size:11.5px;">(${escapeHtml(phone)})</span>`;
  return ` <a href="${link}" target="_blank" rel="noopener" class="mono" title="مراسلة العميل عبر واتساب" style="color:#25D366; font-size:11.5px; text-decoration:none; display:inline-flex; align-items:center; gap:3px; vertical-align:middle;">${WA_ICON}(${escapeHtml(phone)})</a>`;
}

// بديل عن window.open للطباعة: بعض تطبيقات Electron لا تدعم معاينة الطباعة (Print Preview)
// للنوافذ المفتوحة عبر window.open، فتظهر رسالة "This app doesn't support print preview".
// الحل: إنشاء iframe داخل نفس النافذة الرئيسية وكتابة محتوى الطباعة بداخله،
// فتعمل الطباعة والمعاينة بشكل طبيعي لأن الـ iframe جزء من نفس النافذة المُهيأة للطباعة.
// ملاحظة مهمة: يجب أن يكون الـ iframe *ظاهراً* بحجم حقيقي وليس صفراً/مخفياً،
// لأن محتوى الطباعة يتضمن زر "طباعة / حفظ PDF" ينقر عليه المستخدم يدوياً —
// وإن كان الإطار مخفياً (visibility:hidden) أو بحجم صفر فلن يظهر شيء على الإطلاق
// عند الضغط على زر الطباعة (وهذا كان سبب عدم عمل طباعة كشف الحضور والفاتورة).
/* ============================================================
   قالب موحّد لمستندات الطباعة (فواتير/سندات/تقارير/كشوف)
   بدل تكرار نفس قواعد CSS يدوياً في كل دالة طباعة على حدة —
   أي تعديل على شكل الطباعة (لون، خط، مسافات) يتم هنا فقط ويظهر في كل المستندات.
   ============================================================ */
const PRINT_PALETTE = { navy:'#374151', gold:'#6B7280', red:'#52525B', text:'#1B1F26', muted:'#6B7280', border:'#E4E6EB', surfaceAlt:'#F7F8FA' };

function printDocStyles({accent = PRINT_PALETTE.navy, borderColor, amountColor, variant = 'full'} = {}){
  const p = PRINT_PALETTE;
  borderColor = borderColor || accent;
  amountColor = amountColor || accent;
  const base = `
    body{font-family:'Tahoma','Arial',sans-serif; color:${p.text}; margin:0; padding:${variant==='table'?'24px':'28px'};}
    .footer-note{margin-top:30px; font-size:11.5px; color:${p.muted}; text-align:center; border-top:1px solid ${p.border}; padding-top:12px;}
    @media print{ .no-print{display:none;} body{padding:10px;} }
    /* ---------- عرض المستند على شاشة جوال (لا يؤثر على الطباعة الفعلية) ----------
       المستند مصمم أصلاً لمقاس ورق A4، فبدون هذا الجزء يظهر مصغّراً جداً أو
       يتطلب تكبيراً يدوياً داخل معاينة الطباعة على الموبايل. */
    @media screen and (max-width:700px){
      body{padding:14px; overflow-x:auto;}
      table{width:max-content; min-width:100%;}
      th, td{white-space:nowrap;}
    }
  `;
  if(variant==='table' || variant==='table-center'){
    const cellAlign = variant==='table-center' ? 'center' : 'right';
    return base + `
    .head{display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid ${borderColor}; padding-bottom:14px; margin-bottom:16px;}
    .head img{width:70px; height:70px; border-radius:50%; object-fit:cover;}
    h2{color:${borderColor}; margin:0 0 4px;}
    .meta{font-size:13px; color:${p.muted}; margin-bottom:18px; display:flex; gap:18px; flex-wrap:wrap;}
    table{width:100%; border-collapse:collapse; font-size:12.5px;}
    th,td{border:1px solid ${p.border}; padding:8px; text-align:${cellAlign};}
    ${cellAlign==='right' ? 'td.mono, td:last-child{text-align:left; font-family:monospace;}' : ''}
    th{background:${p.surfaceAlt}; text-align:${cellAlign==='right'?'right':'center'};}
    `;
  }
  const amountBg = accent===p.red ? '#FBEEEA' : p.surfaceAlt;
  const amountBorder = accent===p.red ? '#E9CFC9' : p.border;
  return base + `
    .inv-head{display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid ${borderColor}; box-shadow:0 3px 0 ${p.gold}; padding-bottom:16px; margin-bottom:20px;}
    .inv-head .logo{width:90px; height:90px; border-radius:50%; object-fit:cover;}
    .inv-head .center-name{font-size:19px; font-weight:bold; color:${p.navy}; margin:0 0 4px;}
    .inv-head .center-meta{font-size:12.5px; color:${p.muted}; line-height:1.7;}
    .inv-title{text-align:left;}
    .inv-title h2{margin:0; color:${accent}; font-size:22px;}
    .inv-title .no{font-family:monospace; font-size:14px; margin-top:4px;}
    .zatca-qr{display:flex; flex-direction:column; align-items:center; gap:4px; margin-right:auto;}
    .zatca-qr img{width:110px; height:110px; border:1px solid ${p.border}; border-radius:6px; padding:4px; background:#fff;}
    .zatca-qr span{font-size:10.5px; color:${p.muted};}
    .info-grid{display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:22px; font-size:13px;}
    .info-box{border:1px solid ${p.border}; border-radius:8px; padding:12px 14px;}
    .info-box h4{margin:0 0 8px; font-size:12.5px; color:${p.muted};}
    .info-row{display:flex; justify-content:space-between; padding:3px 0;}
    table.items{width:100%; border-collapse:collapse; margin-bottom:18px;}
    table.items th{background:${p.surfaceAlt}; text-align:right; padding:9px 12px; font-size:12.5px; color:${p.navy};}
    table.items td{padding:9px 12px; border-bottom:1px solid ${p.border}; font-size:13px;}
    table.items td.num{text-align:left; font-family:monospace;}
    .totals{width:320px; margin-right:auto; margin-left:0; font-size:13.5px;}
    .totals .r{display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid ${p.surfaceAlt};}
    .totals .grand{font-weight:bold; color:${p.navy}; font-size:15px; border-top:2px solid ${p.navy}; margin-top:4px; padding-top:8px;}
    .amount-box{background:${amountBg}; border:1px solid ${amountBorder}; border-radius:8px; padding:16px; text-align:center; margin-bottom:22px;}
    .amount-box .lbl{font-size:12.5px; color:${p.muted}; margin-bottom:6px;}
    .amount-box .amt{font-size:26px; font-weight:bold; color:${amountColor}; font-family:monospace;}
    .sig-grid{display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:50px;}
    .sig-box{text-align:center;}
    .sig-line{border-top:1px solid ${p.text}; margin-top:50px; padding-top:8px; font-size:12.5px;}
    @media screen and (max-width:700px){
      .inv-head{flex-wrap:wrap; gap:14px;}
      .zatca-qr{margin-right:0;}
      .zatca-qr img{width:84px; height:84px;}
      .info-grid{grid-template-columns:1fr; gap:10px;}
      .totals{width:100%;}
      table.items{font-size:12px;}
      table.items th, table.items td{padding:7px 8px; font-size:12px;}
      .sig-grid{grid-template-columns:1fr; gap:36px;}
    }
  `;
}
/* رأس مستند HTML كامل جاهز للطباعة (DOCTYPE + head + style) */
function printDocHead(title, {accent, borderColor, amountColor, variant, extraCss = ''} = {}){
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${printDocStyles({accent, borderColor, amountColor, variant})}${extraCss}</style></head>`;
}
/* زر الطباعة/الحفظ الموحّد أسفل كل مستند */
function printDocFooterButton(){
  return `<div class="no-print" style="text-align:center; margin-top:20px;"><button onclick="window.print()" style="padding:10px 24px; background:${PRINT_PALETTE.navy}; color:#fff; border:none; border-radius:8px; font-size:14px; cursor:pointer;">طباعة / حفظ PDF</button></div>`;
}

function openPrintTarget(){
  const overlay = document.createElement('div');
  overlay.id = 'print-preview-overlay';
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,33,.6); z-index:99999; display:flex; flex-direction:column; align-items:center; padding:18px; box-sizing:border-box;';

  const bar = document.createElement('div');
  bar.style.cssText = 'width:100%; max-width:900px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;';
  bar.innerHTML = `<span style="color:#fff; font-family:Tahoma,Arial,sans-serif; font-size:13px;">معاينة الطباعة — اضغط زر "طباعة / حفظ PDF" داخل المعاينة</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ إغلاق المعاينة';
  closeBtn.style.cssText = 'padding:8px 16px; background:#fff; color:#1B242E; border:none; border-radius:8px; cursor:pointer; font-family:Tahoma,Arial,sans-serif; font-size:13px;';
  closeBtn.onclick = ()=> overlay.remove();
  bar.appendChild(closeBtn);

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%; max-width:900px; flex:1 1 auto; background:#fff; border:0; border-radius:10px; min-height:0;';

  overlay.appendChild(bar);
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);

  const win = iframe.contentWindow;
  win.addEventListener('afterprint', ()=>{ setTimeout(()=> overlay.remove(), 400); });
  return win;
}

onSearchInput('#search', renderTable);
$('#table-page-size')?.addEventListener('change', ()=>{ tableCurrentPage = 1; renderTable(); });
$('#table-page-first')?.addEventListener('click', ()=>{ tableCurrentPage = 1; renderTable(); });
$('#table-page-prev')?.addEventListener('click', ()=>{ tableCurrentPage = Math.max(1, tableCurrentPage-1); renderTable(); });
$('#table-page-next')?.addEventListener('click', ()=>{ tableCurrentPage = tableCurrentPage+1; renderTable(); });
$('#table-page-last')?.addEventListener('click', ()=>{ tableCurrentPage = Infinity; renderTable(); });
$('#filter-course').addEventListener('change', renderTable);
$('#filter-nat').addEventListener('change', renderTable);
$('#filter-reception')?.addEventListener('change', renderTable);
$('#filter-status').addEventListener('change', renderTable);
$('#btn-filter-suspended').addEventListener('click', ()=>{
  showSuspendedOnly = !showSuspendedOnly;
  $('#btn-filter-suspended').classList.toggle('btn-gold', showSuspendedOnly);
  $('#btn-filter-suspended').classList.toggle('btn-ghost', !showSuspendedOnly);
  renderTable();
});
$('#btn-filter-unpurchased-bags').addEventListener('click', ()=>{
  showUnpurchasedBagsOnly = !showUnpurchasedBagsOnly;
  $('#btn-filter-unpurchased-bags').classList.toggle('btn-gold', showUnpurchasedBagsOnly);
  $('#btn-filter-unpurchased-bags').classList.toggle('btn-ghost', !showUnpurchasedBagsOnly);
  renderTable();
});
$('#filter-company').addEventListener('change', renderTable);
$('#filter-invoice').addEventListener('change', renderTable);
$('#filter-coursenum').addEventListener('change', renderTable);
$('#filter-refnum').addEventListener('change', renderTable);
$('#cl-date-from').addEventListener('input', renderTable);
$('#cl-date-to').addEventListener('input', renderTable);
$('#cl-paid-min').addEventListener('input', renderTable);
$('#cl-paid-max').addEventListener('input', renderTable);

/* ---------------- طي/توسيع الفلاتر المتقدمة (جدول العملاء) ----------------
   الحقول نفسها (filter-course، filter-nat...) لم تتغيّر مكانها في الـ DOM ولا
   معالجات renderTable المرتبطة بها أعلاه — فقط نُخفي/نُظهر الحاوية الأم، ونضيف
   عدّاداً صغيراً يوضّح كم فلتراً متقدماً مفعّلاً حالياً حتى لو كانت القائمة مطوية. */
const ADVANCED_FILTER_IDS = ['filter-course','filter-nat','filter-company','filter-invoice','filter-coursenum','filter-refnum','cl-date-from','cl-date-to','cl-paid-min','cl-paid-max'];
function updateAdvancedFiltersBadge(){
  const badge = $('#advanced-filters-count');
  if(!badge) return;
  const activeCount = ADVANCED_FILTER_IDS.filter(id=>{ const el=document.getElementById(id); return el && el.value; }).length;
  badge.textContent = activeCount;
  badge.style.display = activeCount ? '' : 'none';
}
$('#btn-toggle-advanced-filters')?.addEventListener('click', ()=>{
  const panel = $('#advanced-filters-panel');
  const btn = $('#btn-toggle-advanced-filters');
  if(!panel || !btn) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  btn.setAttribute('aria-expanded', String(!isOpen));
});
$('#btn-clear-advanced-filters')?.addEventListener('click', ()=>{
  ADVANCED_FILTER_IDS.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    if(el.tagName === 'SELECT') el.selectedIndex = 0; else el.value = '';
  });
  updateAdvancedFiltersBadge();
  renderTable();
});
ADVANCED_FILTER_IDS.forEach(id=>{
  const el = document.getElementById(id);
  if(el) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', updateAdvancedFiltersBadge);
});
updateAdvancedFiltersBadge();

document.addEventListener('click', async e=>{
  const editId = e.target.dataset.edit;
  const delId = e.target.dataset.del;
  const invId = e.target.dataset.invoice;
  const suspendId = e.target.dataset.suspend;
  const unsuspendId = e.target.dataset.unsuspend;
  const cancelBagId = e.target.dataset.cancelbag;
  const delInvoiceId = e.target.dataset.delinvoice;
  if(invId){ await printInvoice(invId); return; }
  if(delInvoiceId){
    const c = clients.find(x=>x.id===delInvoiceId);
    if(!canDeleteClientRecord(c)){ showToast('🔒 غير مسموح لصلاحيتك بحذف بيانات هذا العميل الآن (خارج المهلة المسموح بها أو الحذف معطَّل)'); return; }
    if(!c || !c.taxInvoiceNo){ showToast('لا توجد فاتورة صادرة لهذا العميل'); return; }
    const invLabel = formatInvoiceNo(c.taxInvoiceNo);
    const reason = await customPrompt(`توثيقاً للمعايير المحاسبية، لا يمكن حذف رقم الفاتورة التسلسلي (${invLabel}) نهائياً أو إعادة استخدامه — سيتم حذف الفاتورة من سجل العميل "${c.name}" فقط مع الاحتفاظ بالرقم والسبب في سجل الفواتير المحذوفة. عند طباعة فاتورة جديدة لهذا العميل لاحقاً سيُمنح رقماً تسلسلياً جديداً.\nيرجى كتابة سبب الحذف (إلزامي):`, {title:'سبب حذف الفاتورة', required:true, placeholder:'اكتب سبب الحذف هنا...'});
    if(reason===null) return;
    if(!reason.trim()){ showToast('سبب الحذف إلزامي — لم يتم الحذف'); return; }
    snapshotState(`حذف فاتورة العميل: ${c.name} (${invLabel})`);
    const removed = softDeleteClientInvoice(c.id, reason.trim());
    if(removed){
      await saveClients();
      await saveDeletedInvoices();
      await logAudit('delete','العملاء', `تم حذف الفاتورة رقم ${removed.invoiceNoLabel} للعميل "${removed.clientName}" — السبب: ${removed.deletedReason}`);
      refreshEverything();
      showToast(`تم حذف الفاتورة ${removed.invoiceNoLabel}`);
    }
    return;
  }
  if(editId){
    const targetClient = clients.find(x=>x.id===editId);
    if(!canReceptionEditClient(targetClient)){
      showToast('⏱️ انتهت مهلة تعديل هذا العميل (5 ساعات من وقت تسجيله) — يمكن للأدمن فقط تعديله الآن');
    }else{
      openModal(editId);
    }
  }
  if(cancelBagId){
    const c = clients.find(x=>x.id===cancelBagId);
    if(c && await customConfirm(`تأكيد إلغاء الحقيبة المسجّلة لـ"${c.name}"؟ ستُحذف تماماً من سجل شراء الحقائب المكتملة (إن وُجدت) ومن سجل "اشتروا حقيبتهم الخاصة" (إن كانت كذلك)، ويُمسح رقم الفاتورة وتاريخ الشراء، وتعود حالته إلى "مطلوب شراء" — وإن كانت من المخزون تُعاد تلقائياً لرصيد التمويل.`)){
      snapshotState(`إلغاء حقيبة عميل: ${c.name}`);
      resetClientBagToPending(c);
      await saveClients(); await saveVaultTx(); await saveBagStock(); await saveSettings();
      await logAudit('edit','مخزون الحقائب', `تم إلغاء حقيبة العميل ${c.name} — عادت حالته إلى "مطلوب شراء"`);
      refreshEverything();
      showToast('تم إلغاء الحقيبة');
    }
  }
  if(suspendId){
    const c = clients.find(x=>x.id===suspendId);
    if(c && await customConfirm(`تأكيد إيقاف "${c.name}"؟ سيبقى ظاهراً في شيت العملاء، لكن سيختفي من شيت الدورات ومخزون الحقائب حتى تُلغي الإيقاف عنه.`)){
      snapshotState(`إيقاف عميل: ${c.name}`);
      c.suspended = true;
      await saveClients();
      await logAudit('edit','العملاء', `تم إيقاف العميل ${c.name} — أصبح مخفياً من شيت الدورات ومخزون الحقائب`);
      refreshEverything();
      showToast('تم إيقاف العميل');
    }
  }
  if(unsuspendId){
    const c = clients.find(x=>x.id===unsuspendId);
    if(c){
      snapshotState(`إلغاء إيقاف عميل: ${c.name}`);
      c.suspended = false;
      await saveClients();
      await logAudit('edit','العملاء', `تم إلغاء إيقاف العميل ${c.name} — عاد للظهور في شيت الدورات ومخزون الحقائب`);
      refreshEverything();
      showToast('تم إلغاء الإيقاف');
    }
  }
  if(delId){
    if(!canDeleteClientRecord(clients.find(c=>c.id===delId))){ showToast('🔒 غير مسموح لصلاحيتك بحذف هذا العميل الآن (خارج المهلة المسموح بها أو الحذف معطَّل)'); return; }
    if(await customConfirm('تأكيد حذف هذا السجل؟ سيُحذف أيضاً أي ترحيل مالي مرتبط به.')){
      const removedClient = clients.find(c=>c.id===delId);
      snapshotState(`حذف عميل: ${removedClient?.name || delId}`);
      clients = clients.filter(c=>c.id!==delId);
      removeClientLedgerEntries(delId);
      await saveClients(); await saveVaultTx();
      await logAudit('delete','العملاء', `تم حذف بيانات العميل: ${removedClient?.name || delId}`);
      renderTable(); renderDashboard(); renderBags();
      showToast('تم حذف السجل');
    }
  }
});

/* ---------------- قائمة إجراءات الصف (⋮) في أي جدول (عملاء / حركات مالية...) ----------------
   القائمة الفعلية المعروضة للمستخدم ليست القائمة المدمجة داخل صف الجدول (تلك تبقى مخفية
   دائماً وتُستخدم فقط كـ"قالب" نسخ منه)، بل عنصر واحد مشترك (#global-row-menu-panel) يُضاف
   مباشرة إلى نهاية <body> (portal) عند كل فتح. هذا يضمن ظهورها دائماً فوق كل نصوص/خطوط/صفوف
   الجدول ولا تُغطّى بها أبداً، لأنها فعلياً لم تعد جزءاً من شجرة DOM الخاصة بالجدول (ولا من أي
   Stacking Context أو منطقة overflow داخله) وقت ظهورها — بدل الاعتماد فقط على z-index/position:fixed
   داخل مكانها الأصلي وسط صفوف الجدول.
   نستمر في حساب الموضع عبر JS (getBoundingClientRect) بدل الاعتماد على مكانها الأصلي، لأن
   الجدول داخل .table-scroll (overflow:auto) وأي قائمة عادية كانت ستُقطَع عند حواف منطقة التمرير. */
let openRowMenuPanel = null;
let openRowMenuToggle = null;
function getGlobalRowMenuPanel(){
  let el = document.getElementById('global-row-menu-panel');
  if(!el){
    el = document.createElement('div');
    el.id = 'global-row-menu-panel';
    el.className = 'row-menu-panel';
    el.setAttribute('role','menu');
    document.body.appendChild(el);
  }
  return el;
}
function closeRowMenu(){
  if(openRowMenuPanel){
    openRowMenuPanel.classList.remove('show');
    openRowMenuPanel.innerHTML = '';
    if(openRowMenuToggle) openRowMenuToggle.setAttribute('aria-expanded','false');
    openRowMenuPanel = null;
    openRowMenuToggle = null;
  }
}
document.addEventListener('click', e=>{
  const toggle = e.target.closest('.row-menu-toggle');
  if(!toggle) return;
  e.stopPropagation();
  const sourcePanel = toggle.nextElementSibling; // القالب المخفي الخاص بهذا الصف تحديداً
  if(!sourcePanel || !sourcePanel.classList.contains('row-menu-panel')) return;
  if(openRowMenuToggle === toggle){ closeRowMenu(); return; }
  closeRowMenu();
  const panel = getGlobalRowMenuPanel();
  panel.innerHTML = sourcePanel.innerHTML; // ننسخ أزرار هذا الصف (وبياناتها data-edit/data-del...) لحظياً
  const r = toggle.getBoundingClientRect();
  // نقيس أبعاد القائمة الحقيقية أولاً وهي مخفية (visibility:hidden لا تؤثر على القياس
  // خلافاً لـ display:none)، بدل تقدير المكان ثم تصحيحه بعد الظهور — كان هذا يسبب
  // ظهور القائمة متراكبة فوق صف خاطئ أو مقطوعة الأزرار في الصفوف القريبة من أعلى الجدول.
  panel.style.visibility = 'hidden';
  panel.style.top = '0px';
  panel.style.left = '0px';
  panel.classList.add('show');
  const pw = panel.offsetWidth || 180;
  const ph = panel.offsetHeight || 160;
  const spaceBelow = window.innerHeight - r.bottom;
  const spaceAbove = r.top;
  const openUp = spaceBelow < (ph + 12) && spaceAbove > spaceBelow;
  const top = openUp
    ? Math.max(8, r.top - ph - 4)
    : Math.min(r.bottom + 4, window.innerHeight - ph - 8);
  // نُحاصر القائمة أفقياً داخل حدود صندوق الجدول نفسه (.panel/.table-scroll) وليس عرض
  // النافذة كله — كانت القائمة أحياناً تمتد لليسار خارج حدود الصندوق (فوق الخلفية/الشريط
  // الجانبي) لأن الحساب كان يعتمد على window.innerWidth فقط، بغض النظر عن عرض الجدول الفعلي.
  const container = toggle.closest('.panel') || toggle.closest('.table-scroll');
  const cRect = container ? container.getBoundingClientRect() : null;
  const minLeft = cRect ? cRect.left + 6 : 8;
  const maxLeft = cRect ? Math.max(minLeft, cRect.right - pw - 6) : window.innerWidth - pw - 8;
  const left = Math.max(minLeft, Math.min(r.right - pw, maxLeft));
  panel.style.top = Math.max(8, top) + 'px';
  panel.style.left = left + 'px';
  panel.style.visibility = '';
  toggle.setAttribute('aria-expanded','true');
  openRowMenuPanel = panel;
  openRowMenuToggle = toggle;
});
// إغلاق القائمة المفتوحة عند اختيار أي إجراء من داخلها، أو عند أي نقر خارجها،
// أو عند التمرير/تصغير النافذة/الضغط على Esc.
document.addEventListener('click', e=>{
  if(!openRowMenuPanel) return;
  if(e.target.closest('.row-menu-toggle')) return;
  const insidePanel = e.target.closest('#global-row-menu-panel');
  if(insidePanel){
    // القائمة نفسها لم تعد تُزال تلقائياً بإعادة رسم الجدول (لأنها الآن خارج شجرته)،
    // لذا نُغلقها يدوياً بعد تنفيذ أي زر إجراء بداخلها ليطابق السلوك السابق.
    if(e.target.closest('button')) setTimeout(closeRowMenu, 0);
    return;
  }
  closeRowMenu();
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeRowMenu(); });
window.addEventListener('scroll', closeRowMenu, true);
window.addEventListener('resize', closeRowMenu);

/* ---------------- Modal / form ---------------- */
function openModal(id){
  editingId = id || null;
  $('#modal-title').textContent = id ? 'تعديل بيانات عميل' : 'إضافة عميل جديد';
  populateSelect($('#f-nat'), settings.nationalities, true);
  populateSelect($('#f-course'), settings.courses.map(c=>c.name), true);
  populateSelect($('#f-channel'), settings.channels.map(c=>c.name), true);

  const c = id ? clients.find(x=>x.id===id) : null;
  $('#f-name').value = c?.name || '';
  $('#f-id').value = c?.clientId || '';
  $('#f-phone').value = c?.phone || '';
  $('#f-nat').value = c?.nationality || '';
  $('#f-clienttype').value = c?.clientType || 'center';
  populateClientCompanySelect(c?.companyName || '');
  $('#f-ajal').value = c?.creditDays ?? '';
  $('#f-clienttax').value = c?.clientTaxNumber || '';
  $('#f-course').value = c?.courseType || '';
  $('#f-coursenum').value = c?.courseNumber || '';
  updateClientCourseStatus();
  $('#f-refer').value = c?.referNum || '';
  $('#f-invoice').value = c?.invoice || '';
  $('#f-baginvoice').value = c?.bagInvoice || '';
  $('#f-date').value = c?.date || '';
  $('#f-courseprice').value = c?.coursePrice ?? '';
  $('#f-bagsource').value = c?.bagSource || 'buy';
  $('#f-bagprice').value = c ? (c.bagPrice ?? '') : settings.bagPrice;
  $('#f-discount').value = c?.discount ?? 0;
  $('#f-paid').value = c?.paid ?? 0;
  if(c){
    const grandTotal = paidTotal(c);
    $('#f-paid-total-hint').textContent = `إجمالي المدفوع فعلياً لهذا العميل (شامل أي دفعات لاحقة سُجّلت في الحركات المالية): ${fmt(grandTotal)} ﷼`;
  }else{
    $('#f-paid-total-hint').textContent = 'لتسجيل دفعة إضافية لعميل مسجّل مسبقاً، احفظ العميل أولاً ثم استخدم "+ إضافة دفعة جديدة" أسفل هذا النموذج بدلاً من تعديل هذا الحقل، حتى يبقى سجل كل دفعة بتاريخها.';
  }
  $('#f-channel').value = c?.channel || '';
  $('#f-netinvoice').value = c?.networkInvoice || '';
  populateSelect($('#f-channel2'), settings.channels.map(c=>c.name), true);
  $('#f-split-payment').checked = !!(c && num(c.paid2)>0);
  $('#f-paid2').value = c?.paid2 ?? 0;
  $('#f-channel2').value = c?.channel2 || '';
  $('#f-netinvoice2').value = c?.networkInvoice2 || '';
  toggleSplitPayment();
  $('#f-stage').value = c?.stage || 'جديد';
  $('#f-cancelled').checked = !!c?.cancelled;
  $('#f-notes').value = c?.notes || '';
  toggleBagFields();
  toggleClientNetInvoice();
  toggleClientTypeFields();
  updateComputed();
  editingPaymentTxId = null;
  addingClientPayment = false;
  renderClientPaymentsPanel();
  $('#overlay').classList.add('show'); SoundFX.open();
  $('#f-name').focus();
}
function toggleClientTypeFields(){
  const isCompany = $('#f-clienttype').value === 'company';
  $('#wrap-f-company').style.display = isCompany ? '' : 'none';
  $('#wrap-f-ajal').style.display = isCompany ? '' : 'none';
  $('#wrap-f-company-hint').style.display = 'none';
  if(!isCompany) $('#f-ajal').value = '';
  else updateCompanyHint();
}
$('#f-clienttype').addEventListener('change', toggleClientTypeFields);
function populateClientCompanySelect(selectedValue){
  const sel = $('#f-company');
  const names = companies.map(c=>c.name);
  let optionsHtml = '<option value="">— اختر الشركة —</option>';
  // إن كان العميل مرتبطاً باسم شركة قديم لا يطابق أي شركة في القائمة الرئيسية (تهجئة مختلفة)، أضفه كخيار مميز حتى لا يُفقَد أو يُستبدل بصمت
  if(selectedValue && !names.includes(selectedValue)){
    optionsHtml += `<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)} (غير مطابق لقائمة الشركات — يرجى المراجعة)</option>`;
  }
  optionsHtml += names.map(n=>`<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  sel.innerHTML = optionsHtml;
  sel.value = selectedValue || '';
}
function updateCompanyHint(){
  const name = $('#f-company').value.trim();
  const c = companies.find(x=>x.name===name);
  if(c && c.categories && c.categories.length){
    $('#f-company-hint').textContent = `مبالغ هذه الشركة حسب الفئة: ${companyCategoriesSummaryText(c.categories)} — حدّد فئة هذا المتدرب يدوياً وعدّل الخصم بما يوافقها.`;
    $('#wrap-f-company-hint').style.display = '';
  }else if(c && num(c.agreedAmount)>0){
    $('#f-company-hint').textContent = `المبلغ المتفق عليه لهذه الشركة (لكل متدرب بعد الخصم): ${fmt(num(c.agreedAmount))} ﷼`;
    $('#wrap-f-company-hint').style.display = '';
    applyCompanyAgreedPricing(c);
  }else{
    $('#wrap-f-company-hint').style.display = 'none';
  }
}
/* عند اختيار شركة لها "مبلغ متفق عليه" ثابت لكل متدرب (بدون فئات)، يُحسَب الخصم تلقائياً
   بحيث يصبح "دخل المركز الصافي" (سعر الدورة - الخصم) مساوياً لهذا المبلغ المتفق عليه —
   فقط عند إضافة عميل جديد، حتى لا يُعاد حساب/الكتابة فوق خصم عميل محفوظ مسبقاً بالفعل. */
function applyCompanyAgreedPricing(company){
  if(editingId) return; // لا نُعدّل بيانات عميل محفوظ مسبقاً تلقائياً
  const price = num($('#f-courseprice').value);
  const agreed = num(company.agreedAmount);
  if(price<=0) return;
  const neededDiscount = Math.max(0, Math.round((price - agreed)*100)/100);
  $('#f-discount').value = neededDiscount;
  $('#f-company-hint').textContent = `المبلغ المتفق عليه لهذه الشركة (لكل متدرب بعد الخصم): ${fmt(agreed)} ﷼ — تم تعبئة الخصم تلقائياً (${fmt(neededDiscount)} ﷼) بحيث يصبح دخل المركز الصافي مساوياً لهذا المبلغ. يمكنك تعديل الخصم يدوياً إذا لزم الأمر.`;
  updateComputed();
}
$('#f-company').addEventListener('change', updateCompanyHint);
function toggleClientNetInvoice(){
  const chan = settings.channels.find(c=>c.name===$('#f-channel').value);
  $('#wrap-f-netinvoice').style.display = (chan && chan.dest==='network') ? '' : 'none';
}
$('#f-channel').addEventListener('change', toggleClientNetInvoice);
function toggleSplitPayment(){
  const on = $('#f-split-payment').checked;
  $('#wrap-f-paid2').style.display = on ? '' : 'none';
  $('#wrap-f-channel2').style.display = on ? '' : 'none';
  toggleClientNetInvoice2();
  updateComputed();
}
function toggleClientNetInvoice2(){
  const on = $('#f-split-payment').checked;
  const chan2 = settings.channels.find(c=>c.name===$('#f-channel2').value);
  $('#wrap-f-netinvoice2').style.display = (on && chan2 && chan2.dest==='network') ? '' : 'none';
}
$('#f-split-payment').addEventListener('change', toggleSplitPayment);
$('#f-channel2').addEventListener('change', toggleClientNetInvoice2);
$('#f-paid2').addEventListener('input', updateComputed);
function toggleBagFields(){
  const isOwn = $('#f-bagsource').value === 'own';
  $('#wrap-bagprice').style.display = isOwn ? 'none' : '';
  $('#wrap-baginvoice').style.display = isOwn ? 'none' : '';
  if(isOwn) $('#f-bagprice').value = 0;
  else if(num($('#f-bagprice').value)===0) $('#f-bagprice').value = settings.bagPrice;
  updateComputed();
}
$('#f-bagsource').addEventListener('change', toggleBagFields);
function closeModal(){ $('#overlay').classList.remove('show'); editingId=null; editingPaymentTxId=null; addingClientPayment=false; }
$('#btn-cancel').addEventListener('click', closeModal);
$('#overlay').addEventListener('click', e=>{ if(e.target.id==='overlay') closeModal(); });

/* ---------------- سجل الدفعات المرتبطة بالعميل (عرض فقط) ----------------
   هذا السجل في شيت "العملاء" أصبح للعرض فقط — أي إضافة أو تعديل أو حذف لدفعات
   العميل (غير دفعتَي التسجيل التلقائيتين) تتم حصرياً من تبويب "الحركات المالية". */
function renderClientPaymentsPanel(){
  const wrap = $('#wrap-client-payments');
  if(!wrap) return;
  const c = editingId ? clients.find(x=>x.id===editingId) : null;
  if(!c || !c.clientId){ wrap.style.display='none'; $('#client-payments-list').innerHTML=''; return; }
  wrap.style.display = '';
  const txs = vaultTx.filter(t=>t.type==='in' && t.clientId===c.clientId)
    .sort((a,b)=> (a.date||'').localeCompare(b.date||'') || (num(a.seq)-num(b.seq)));
  const list = $('#client-payments-list');

  const rowsHtml = txs.map(t=>{
    const isAuto = !!t.autoClientId;
    return `
    <div class="tag" style="width:100%; justify-content:space-between; border-radius:8px; margin-bottom:6px; flex-wrap:wrap;">
      <span class="mono" style="font-size:12px;">#${t.seq||'—'} · ${t.date||'—'} · ${escapeHtml(t.method||'—')} (${destLabel(t.destination||'vault')}) · <b>${fmt(num(t.amount))}</b> ﷼</span>
      <span class="hint" style="margin:0; font-size:11px;">${isAuto ? 'دفعة التسجيل — عدّلها من حقلي "المبلغ المدفوع"/"طريقة الدفع" أعلاه' : 'للتعديل أو الحذف، استخدم تبويب "الحركات المالية"'}</span>
    </div>`;
  }).join('');

  list.innerHTML = rowsHtml || '<div class="hint" style="margin:0;">لا توجد أي دفعة مسجّلة لهذا العميل بعد.</div>';
}

$('#btn-add').addEventListener('click', ()=>openModal(null));
/* زر تحديث لكامل شيت العملاء: يعيد مزامنة حركات الدفع التلقائية لكل عميل مع بياناته الحالية،
   ويعيد رسم كل الشاشات المرتبطة (الجدول، لوحة التحكم، الفلاتر، التقارير، الدورات، الخزنة) دفعة واحدة */
$('#btn-refresh-clients').addEventListener('click', async ()=>{
  snapshotState('تحديث شامل لشيت العملاء');
  clients.forEach(c=> syncClientLedgerEntry(c));
  await saveClients();
  await saveVaultTx();
  await saveSettings();
  renderTable();
  renderDashboard();
  refreshFilterOptions();
  renderReports();
  renderCourses();
  if(typeof renderVault==='function') renderVault();
  await logAudit('edit','العملاء', `تحديث شامل لشيت العملاء: إعادة مزامنة بيانات ${clients.length} عميل وإعادة رسم كل الشاشات المرتبطة`);
  showToast('تم تحديث الشيت بالكامل');
});

$('#f-course').addEventListener('change', ()=>{
  if(editingId) return; // don't override manual edits on existing record
  if($('#f-nat').value){
    $('#f-courseprice').value = nationalityCoursePrice($('#f-nat').value);
  }else{
    const found = settings.courses.find(c=>c.name===$('#f-course').value);
    if(found && !$('#f-courseprice').value) $('#f-courseprice').value = found.price;
  }
  reapplyCompanyPricingIfNeeded();
  updateComputed();
});
function isSaudiNationality(v){ return /^(saudi|سعود)/i.test(String(v||'').trim()); }
function nationalityCoursePrice(nat){ return isSaudiNationality(nat) ? num(settings.priceSaudi) : num(settings.priceNonSaudi); }
function reapplyCompanyPricingIfNeeded(){
  if($('#f-clienttype').value!=='company') return;
  const c = companies.find(x=>x.name===$('#f-company').value.trim());
  if(c && !(c.categories && c.categories.length) && num(c.agreedAmount)>0) applyCompanyAgreedPricing(c);
}
$('#f-nat').addEventListener('change', ()=>{
  if(editingId) return; // don't override manual edits على السجل
  if($('#f-nat').value) $('#f-courseprice').value = nationalityCoursePrice($('#f-nat').value);
  reapplyCompanyPricingIfNeeded();
  updateComputed();
});
/* حالة دورة هذا العميل تحديداً (برقم دورته الخاص فقط) — تظهر فقط عند وجود رقم دورة، ولا تعرض أي شيء عن باقي أنواع الدورات */
function updateClientCourseStatus(){
  const cn = $('#f-coursenum').value.trim();
  const wrap = $('#wrap-f-coursestatus');
  const box = $('#f-coursestatus-box');
  if(!cn){ wrap.style.display = 'none'; box.innerHTML = ''; return; }
  wrap.style.display = 'block';
  const sess = courseSessions.find(s=>s.courseNumber===cn);
  const date = sess?.date || '';
  if(!date){
    box.innerHTML = `<span class="stamp" style="border-color:var(--text-muted); color:var(--text-muted);">لم يتم تحديد تاريخ الدورة بعد</span>`;
    return;
  }
  const isTaken = date <= todayISO();
  box.innerHTML = isTaken
    ? `<span class="stamp paid">تم أخذ الدورة (${escapeHtml(date)})</span>`
    : `<span class="stamp owe">لم يحن موعد الدورة بعد (${escapeHtml(date)})</span>`;
}
$('#f-coursenum').addEventListener('input', updateClientCourseStatus);
['#f-courseprice','#f-bagprice','#f-discount','#f-paid'].forEach(sel=>{
  $(sel).addEventListener('input', updateComputed);
});
function updateComputed(){
  const income = num($('#f-courseprice').value) - num($('#f-discount').value);
  const bag = $('#f-bagsource').value==='own' ? 0 : num($('#f-bagprice').value);
  const t = income + bag;
  const paidTotalForm = num($('#f-paid').value) + ($('#f-split-payment').checked ? num($('#f-paid2').value) : 0);
  const r = Math.max(0, t - paidTotalForm);
  $('#calc-income').textContent = fmt(income);
  $('#calc-bag').textContent = fmt(bag);
  $('#calc-total').textContent = fmt(t);
  $('#calc-remaining').textContent = fmt(r);
}

$('#client-form').addEventListener('submit', async e=>{
  e.preventDefault();
  if(editingId && !canReceptionEditClient(clients.find(x=>x.id===editingId))){
    showToast('⏱️ انتهت مهلة تعديل هذا العميل (5 ساعات من وقت تسجيله) — يمكن للأدمن فقط تعديله الآن');
    closeModal();
    return;
  }
  const data = {
    name: $('#f-name').value.trim(),
    clientId: $('#f-id').value.trim(),
    phone: $('#f-phone').value.trim(),
    nationality: $('#f-nat').value,
    clientType: $('#f-clienttype').value,
    companyName: $('#f-clienttype').value==='company' ? $('#f-company').value.trim() : '',
    creditDays: $('#f-clienttype').value==='company' ? num($('#f-ajal').value) : '',
    clientTaxNumber: $('#f-clienttax').value.trim(),
    courseType: $('#f-course').value,
    courseNumber: $('#f-coursenum').value.trim(),
    referNum: $('#f-refer').value.trim(),
    invoice: $('#f-invoice').value.trim(),
    bagInvoice: $('#f-baginvoice').value.trim(),
    date: $('#f-date').value,
    coursePrice: num($('#f-courseprice').value),
    bagSource: $('#f-bagsource').value,
    bagPrice: $('#f-bagsource').value==='own' ? 0 : num($('#f-bagprice').value),
    discount: num($('#f-discount').value),
    paid: num($('#f-paid').value),
    channel: $('#f-channel').value,
    networkInvoice: $('#f-netinvoice').value.trim(),
    paid2: $('#f-split-payment').checked ? num($('#f-paid2').value) : 0,
    channel2: $('#f-split-payment').checked ? $('#f-channel2').value : '',
    networkInvoice2: $('#f-split-payment').checked ? $('#f-netinvoice2').value.trim() : '',
    stage: $('#f-stage').value,
    cancelled: $('#f-cancelled').checked,
    notes: $('#f-notes').value.trim(),
  };
  // إذا تم تعيين رقم دورة جديد يدوياً، يُلغى تلقائياً وسم الغياب السابق
  if(editingId){
    const prev = clients.find(x=>x.id===editingId);
    if(prev && prev.absent && data.courseNumber && data.courseNumber!==prev.courseNumber){
      data.absent = false;
    }
  }
  if(!data.clientId){ showToast('رقم الهوية مطلوب — يُستخدم لربط كل العمليات بهذا العميل'); return; }
  if(!/^\d{10}$/.test(data.clientId)){ showToast('رقم الهوية يجب أن يتكون من 10 خانات (أرقام) بالضبط — لا أقل ولا أكثر'); return; }
  if(!data.name){ showToast('الاسم مطلوب'); return; }
  const dupId = clients.find(c=>c.clientId===data.clientId && c.id!==editingId);
  if(dupId){ showToast(`رقم الهوية مستخدم بالفعل لعميل آخر: ${dupId.name}`); return; }
  const wasEdit = !!editingId;
  const prevClientForEvents = editingId ? clients.find(x=>x.id===editingId) : null;
  const prevCourseNumberForEvent = prevClientForEvents ? (prevClientForEvents.courseNumber||'') : '';
  snapshotState(wasEdit ? `تعديل عميل: ${data.name}` : `إضافة عميل: ${data.name}`);
  if(editingId){
    const idx = clients.findIndex(c=>c.id===editingId);
    const prevSource = clients[idx].bagSource;
    data.bagStatus = data.bagSource==='stock' ? 'purchased' : (data.bagSource==='buy' ? 'pending' : 'n/a');
    if(data.bagSource==='stock' && !clients[idx].bagPurchaseDate) data.bagPurchaseDate = todayISO();
    // إن كان مصدر حقيبته السابق "من المخزون" وتغيّر الآن لأي مصدر آخر، تُلغى عملية التسليم المسجّلة
    // تلقائياً من سجل مخزون الحقائب حتى تعود الحقيبة لرصيد المخزون المتاح ولا يبقى خصم بلا مقابل
    if(prevSource==='stock' && data.bagSource!=='stock'){
      const stIdx = bagStock.findIndex(b=>b.type==='issue' && b.issuedClientId===clients[idx].id);
      if(stIdx>-1){ bagStock.splice(stIdx,1); recalcBagFundLedger(); await saveBagStock(); }
    }
    clients[idx] = {...clients[idx], ...data};
    if(data.bagSource!=='stock') delete clients[idx].bagPurchaseDate;
    showToast('تم تحديث السجل');
  }else{
    data.bagStatus = data.bagSource==='stock' ? 'purchased' : (data.bagSource==='buy' ? 'pending' : 'n/a');
    if(data.bagSource==='stock') data.bagPurchaseDate = data.bagPurchaseDate || todayISO();
    clients.push({id:uid(), createdAt:Date.now(), createdBy: currentUser, ...data});
    showToast('تمت إضافة العميل');
  }
  const savedClient = editingId ? clients.find(c=>c.id===editingId) : clients[clients.length-1];
  await saveClients();
  syncClientLedgerEntry(savedClient);
  await syncBagStockIssues();
  await saveVaultTx();
  await saveSettings();
  await logAudit(wasEdit ? 'edit' : 'add', 'العملاء', `${wasEdit ? 'تم تعديل' : 'تمت إضافة'} بيانات العميل: ${savedClient.name}`);
  if(!wasEdit){
    sendPowerAutomateEvent('new_client', {clientId: savedClient.clientId, name: savedClient.name, nationality: savedClient.nationality||'', phone: savedClient.phone||'', courseType: savedClient.courseType||'', courseNumber: savedClient.courseNumber||''});
  }
  if(savedClient.courseNumber && savedClient.courseNumber!==prevCourseNumberForEvent){
    sendPowerAutomateEvent('course_number_updated', {clientId: savedClient.clientId, name: savedClient.name, courseNumber: savedClient.courseNumber, courseType: savedClient.courseType||''});
  }
  closeModal(); renderTable(); renderDashboard(); refreshFilterOptions(); renderCourses(); renderBags();
});

/* ---------------- إضافة عدة عملاء دفعة واحدة (جدول) ---------------- */
let bulkAddRowSeq = 0;
function bulkAddOptionsHtml(values, selected){
  return '<option value=""></option>' + values.map(v=>`<option value="${escapeHtml(v)}"${v===selected?' selected':''}>${escapeHtml(v)}</option>`).join('');
}
function bulkAddRowHtml(rowId){
  const natOptions = bulkAddOptionsHtml(settings.nationalities, '');
  const courseOptions = bulkAddOptionsHtml(settings.courses.map(c=>c.name), '');
  const channelOptions = bulkAddOptionsHtml(settings.channels.map(c=>c.name), '');
  return `<tr data-row="${rowId}">
    <td><input type="text" class="ba-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="ba-name" data-col="1" placeholder="اسم العميل" style="min-width:130px;"></td>
    <td><input type="text" class="ba-phone" data-col="2" style="min-width:100px;"></td>
    <td><select class="ba-nat" data-col="3" style="min-width:110px;">${natOptions}</select></td>
    <td><select class="ba-course" data-col="4" style="min-width:130px;">${courseOptions}</select></td>
    <td><input type="text" class="ba-coursenum" data-col="5" style="min-width:90px;"></td>
    <td><input type="date" class="ba-date" data-col="6" value="${todayISO()}" style="min-width:130px;"></td>
    <td><input type="number" class="ba-price" data-col="7" value="${settings.coursePrice||0}" style="min-width:90px;"></td>
    <td><input type="number" class="ba-discount" data-col="8" value="0" style="min-width:80px;"></td>
    <td><input type="number" class="ba-paid" data-col="9" value="0" style="min-width:90px;"></td>
    <td><select class="ba-channel" data-col="10" style="min-width:120px;">${channelOptions}</select></td>
    <td><input type="text" class="ba-notes" data-col="11" style="min-width:130px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm ba-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBulkAddRow(){
  bulkAddRowSeq++;
  $('#bulk-add-table-body').insertAdjacentHTML('beforeend', bulkAddRowHtml(bulkAddRowSeq));
}
function openBulkAddModal(){
  $('#bulk-add-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addBulkAddRow();
  $('#bulk-add-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkAddModal(){ $('#bulk-add-overlay').classList.remove('show'); }
$('#btn-bulk-add').addEventListener('click', openBulkAddModal);
$('#btn-bulk-add-cancel').addEventListener('click', closeBulkAddModal);
$('#bulk-add-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-add-overlay') closeBulkAddModal(); });
$('#btn-bulk-add-row').addEventListener('click', addBulkAddRow);
$('#bulk-add-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('ba-remove-row')){
    const rows = $('#bulk-add-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// يحول تاريخاً مكتوباً بصيغة يوم/شهر/سنة (الشائعة عند النسخ من إكسل) إلى صيغة yyyy-mm-dd التي يفهمها حقل التاريخ
function normalizeDateForBulkPaste(val){
  val = val.trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  const m = val.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(m){
    const day = m[1].padStart(2,'0'), month = m[2].padStart(2,'0'), year = m[3];
    return `${year}-${month}-${day}`;
  }
  return null;
}
// يختار في القائمة المنسدلة الخيار المطابق (نصاً) لما تم لصقه، متجاهلاً حالة الأحرف والمسافات الزائدة
function setBulkSelectFuzzy(select, val){
  val = val.trim();
  if(!val){ select.value=''; return; }
  const opt = [...select.options].find(o=> o.value.trim().toLowerCase()===val.toLowerCase());
  if(opt) select.value = opt.value;
}
// دعم لصق عمود (أو عدة أعمدة/صفوف) منسوخ من إكسل مباشرة: يوزَّع تلقائياً على الصفوف بدءاً من الخلية التي بدأ منها اللصق،
// ويُضيف صفوفاً جديدة تلقائياً إن لم تكفِ الصفوف الحالية لعدد القيم الملصوقة
$('#bulk-add-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return; // لصق خلية واحدة عادية — نترك السلوك الافتراضي
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop(); // إزالة سطر فارغ أخير ناتج عن نسخ إكسل
  const tbody = $('#bulk-add-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBulkAddRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>11) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT') setBulkSelectFuzzy(field, val);
      else if(field.classList.contains('ba-date')){ const norm = normalizeDateForBulkPaste(val); if(norm) field.value = norm; }
      else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bulk-add-save').addEventListener('click', async ()=>{
  const rows = [...$('#bulk-add-table-body').querySelectorAll('tr')];
  const toAdd = [];
  const errors = [];
  const seenIdsThisBatch = new Set();
  rows.forEach((row, i)=>{
    const clientId = row.querySelector('.ba-id').value.trim();
    const name = row.querySelector('.ba-name').value.trim();
    // صف فارغ بالكامل (لم يُدخَل فيه شيء) يُتجاهل بصمت بدل اعتباره خطأً
    if(!clientId && !name) return;
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!/^\d{10}$/.test(clientId)){ errors.push(`${rowLabel}: رقم الهوية يجب أن يتكون من 10 أرقام بالضبط`); return; }
    if(!name){ errors.push(`${rowLabel}: الاسم مطلوب`); return; }
    if(clients.find(c=>c.clientId===clientId)){ errors.push(`${rowLabel}: رقم الهوية ${clientId} مستخدم بالفعل لعميل آخر`); return; }
    if(seenIdsThisBatch.has(clientId)){ errors.push(`${rowLabel}: رقم الهوية ${clientId} مكرر داخل هذا الجدول`); return; }
    seenIdsThisBatch.add(clientId);
    const bagSource = 'stock';
    const rowDate = row.querySelector('.ba-date').value || todayISO();
    toAdd.push({
      id: uid(), createdAt: Date.now(), createdBy: currentUser,
      clientId, name,
      phone: row.querySelector('.ba-phone').value.trim(),
      nationality: row.querySelector('.ba-nat').value,
      clientType: 'center',
      companyName: '', creditDays: '',
      clientTaxNumber: '',
      courseType: row.querySelector('.ba-course').value,
      courseNumber: row.querySelector('.ba-coursenum').value.trim(),
      referNum: '', invoice: '', bagInvoice: '',
      date: rowDate,
      coursePrice: num(row.querySelector('.ba-price').value),
      bagSource, bagPrice: num(settings.bagPrice),
      bagStatus: 'purchased', bagPurchaseDate: rowDate,
      discount: num(row.querySelector('.ba-discount').value),
      paid: num(row.querySelector('.ba-paid').value),
      channel: row.querySelector('.ba-channel').value,
      networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
      stage: 'جديد', cancelled: false,
      notes: row.querySelector('.ba-notes').value.trim()
    });
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!toAdd.length){ showToast('لم تُدخل بيانات أي عميل'); return; }
  snapshotState(`إضافة ${toAdd.length} عميل دفعة واحدة`);
  toAdd.forEach(c=>{ clients.push(c); syncClientLedgerEntry(c); });
  await saveClients();
  await syncBagStockIssues();
  await saveVaultTx();
  await saveSettings();
  await logAudit('add','العملاء', `تمت إضافة ${toAdd.length} عميل دفعة واحدة عبر جدول الإضافة المتعددة: ${toAdd.map(c=>c.name).join('، ')}`);
  closeBulkAddModal();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderCourses(); renderBags();
});


/* ---------------- تحديث/استيراد بيانات العملاء دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل الاستيراد القديم عبر ملفات Excel (البيانات الرئيسية + الخصم + نوع الدورة + الأسماء).
   القاعدة: رقم الهوية إلزامي في كل صف. إن كان موجوداً بالفعل تُحدَّث فقط الأعمدة التي بها قيمة في هذا
   الصف (أي عمود فارغ يبقى كما هو في النظام دون تغيير) — تماماً كمنطق الاستيراد القديم؛ وإن لم يكن
   موجوداً يُضاف كعميل جديد بشرط توفر الاسم أيضاً. هذا يجعل نفس الجدول صالحاً لتحديث الخصم فقط، أو نوع
   الدورة فقط، أو الاسم فقط، أو أي مجموعة أعمدة، دون الحاجة لملء بقية الصف. */
let bulkUpdateRowSeq = 0;
function buFixedOptionsHtml(pairs, selected){
  return '<option value=""></option>' + pairs.map(([v,l])=>`<option value="${escapeHtml(v)}"${v===selected?' selected':''}>${escapeHtml(l)}</option>`).join('');
}
function bulkUpdateRowHtml(rowId){
  const natOptions = bulkAddOptionsHtml(settings.nationalities, '');
  const courseOptions = bulkAddOptionsHtml(settings.courses.map(c=>c.name), '');
  const channelOptions = bulkAddOptionsHtml(settings.channels.map(c=>c.name), '');
  const ctypeOptions = buFixedOptionsHtml([['center','عميل مركز'],['company','عميل شركات']], '');
  const bagSourceOptions = buFixedOptionsHtml([['stock','من المخزون'],['buy','شراء'],['own','خاصته']], '');
  const cancelledOptions = buFixedOptionsHtml([['no','لا'],['yes','نعم']], '');
  return `<tr data-row="${rowId}">
    <td><input type="text" class="bu-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="bu-name" data-col="1" style="min-width:130px;"></td>
    <td><input type="text" class="bu-refer" data-col="2" style="min-width:100px;"></td>
    <td><input type="text" class="bu-phone" data-col="3" style="min-width:100px;"></td>
    <td><select class="bu-nat" data-col="4" style="min-width:110px;">${natOptions}</select></td>
    <td><select class="bu-ctype" data-col="5" style="min-width:110px;">${ctypeOptions}</select></td>
    <td><input type="text" class="bu-company" data-col="6" style="min-width:130px;"></td>
    <td><input type="number" class="bu-credit" data-col="7" style="min-width:80px;"></td>
    <td><select class="bu-course" data-col="8" style="min-width:130px;">${courseOptions}</select></td>
    <td><input type="text" class="bu-coursenum" data-col="9" style="min-width:90px;"></td>
    <td><input type="text" class="bu-invoice" data-col="10" style="min-width:100px;"></td>
    <td><input type="date" class="bu-date" data-col="11" style="min-width:130px;"></td>
    <td><input type="number" class="bu-price" data-col="12" style="min-width:90px;"></td>
    <td><select class="bu-bagsource" data-col="13" style="min-width:110px;">${bagSourceOptions}</select></td>
    <td><input type="number" class="bu-bagprice" data-col="14" style="min-width:90px;"></td>
    <td><input type="text" class="bu-baginvoice" data-col="15" style="min-width:110px;"></td>
    <td><input type="number" class="bu-discount" data-col="16" style="min-width:80px;"></td>
    <td><input type="number" class="bu-paid" data-col="17" style="min-width:90px;"></td>
    <td><select class="bu-channel" data-col="18" style="min-width:120px;">${channelOptions}</select></td>
    <td><input type="number" class="bu-paid2" data-col="19" style="min-width:90px;"></td>
    <td><select class="bu-channel2" data-col="20" style="min-width:120px;">${channelOptions}</select></td>
    <td><input type="text" class="bu-netinvoice" data-col="21" style="min-width:110px;"></td>
    <td><input type="text" class="bu-stage" data-col="22" style="min-width:90px;"></td>
    <td><select class="bu-cancelled" data-col="23" style="min-width:80px;">${cancelledOptions}</select></td>
    <td><input type="text" class="bu-notes" data-col="24" style="min-width:130px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm bu-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBulkUpdateRow(){
  bulkUpdateRowSeq++;
  $('#bulk-update-table-body').insertAdjacentHTML('beforeend', bulkUpdateRowHtml(bulkUpdateRowSeq));
}
function openBulkUpdateModal(){
  $('#bulk-update-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addBulkUpdateRow();
  $('#bulk-update-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkUpdateModal(){ $('#bulk-update-overlay').classList.remove('show'); }

/* ---------------- إرسال رسالة واتساب جماعية للعملاء المحددين (wa.me تسلسلي) ---------------- */
/* تستخدم دالة normalizePhoneForWhatsapp الموحّدة المعرَّفة أعلى الملف (تشمل التحقق من صحة طول الرقم) */
let bulkMsgQueue = [];
let bulkMsgIndex = 0;
let bulkMsgTemplate = '';

function openBulkMessageModal(){
  const ids = [...selectedClientIds].filter(id=>clients.some(c=>c.id===id));
  if(ids.length===0){ showToast('لم يتم تحديد أي عميل'); return; }
  const recipients = ids.map(id=>clients.find(c=>c.id===id)).filter(Boolean);
  const noPhoneCount = recipients.filter(c=>!normalizePhoneForWhatsapp(c.phone)).length;
  $('#bulk-msg-recipient-count').textContent = recipients.length;
  const warn = $('#bulk-msg-no-phone-warning');
  if(noPhoneCount>0){ warn.style.display=''; $('#bulk-msg-no-phone-count').textContent = noPhoneCount; }
  else { warn.style.display='none'; }
  $('#bulk-msg-text').value = '';
  $('#bulk-msg-setup-view').style.display = '';
  $('#bulk-msg-send-view').style.display = 'none';
  $('#bulk-message-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkMessageModal(){ $('#bulk-message-overlay').classList.remove('show'); }
function renderBulkMsgCurrent(){
  const c = bulkMsgQueue[bulkMsgIndex];
  $('#bulk-msg-current-index').textContent = bulkMsgIndex+1;
  $('#bulk-msg-total-count').textContent = bulkMsgQueue.length;
  $('#bulk-msg-current-name').textContent = c.name || '(بدون اسم)';
  const phone = normalizePhoneForWhatsapp(c.phone);
  $('#bulk-msg-current-phone').textContent = c.phone ? c.phone : '—';
  $('#bulk-msg-skip-hint').style.display = phone ? 'none' : '';
  $('#btn-bulk-message-open-wa').disabled = !phone;
  $('#btn-bulk-message-prev').disabled = bulkMsgIndex===0;
  $('#btn-bulk-message-next').textContent = (bulkMsgIndex===bulkMsgQueue.length-1) ? 'إنهاء ✓' : 'التالي ▶';
}
$('#btn-bulk-send-message').addEventListener('click', openBulkMessageModal);
$('#btn-bulk-message-cancel').addEventListener('click', closeBulkMessageModal);
$('#btn-bulk-message-close').addEventListener('click', closeBulkMessageModal);
$('#bulk-message-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-message-overlay') closeBulkMessageModal(); });
$('#btn-bulk-message-start').addEventListener('click', async ()=>{
  const text = $('#bulk-msg-text').value.trim();
  if(!text){ showToast('اكتب نص الرسالة أولاً'); return; }
  const ids = [...selectedClientIds].filter(id=>clients.some(c=>c.id===id));
  if(ids.length===0){ showToast('لم يتم تحديد أي عميل'); closeBulkMessageModal(); return; }
  bulkMsgQueue = ids.map(id=>clients.find(c=>c.id===id)).filter(Boolean);
  bulkMsgTemplate = text;
  bulkMsgIndex = 0;
  $('#bulk-msg-setup-view').style.display = 'none';
  $('#bulk-msg-send-view').style.display = '';
  renderBulkMsgCurrent();
  await logAudit('other','العملاء', `بدء إرسال رسالة واتساب جماعية لعدد ${bulkMsgQueue.length} عميل`);
});
$('#btn-bulk-message-open-wa').addEventListener('click', ()=>{
  const c = bulkMsgQueue[bulkMsgIndex];
  const phone = normalizePhoneForWhatsapp(c.phone);
  if(!phone) return;
  const personalized = bulkMsgTemplate.replaceAll('{name}', c.name || '');
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(personalized)}`;
  window.open(url, '_blank');
});
$('#btn-bulk-message-prev').addEventListener('click', ()=>{
  if(bulkMsgIndex>0){ bulkMsgIndex--; renderBulkMsgCurrent(); }
});
$('#btn-bulk-message-next').addEventListener('click', ()=>{
  if(bulkMsgIndex < bulkMsgQueue.length-1){ bulkMsgIndex++; renderBulkMsgCurrent(); }
  else { showToast('تم الانتهاء من قائمة الإرسال'); closeBulkMessageModal(); }
});

$('#btn-bulk-update').addEventListener('click', openBulkUpdateModal);
$('#btn-bulk-update-cancel').addEventListener('click', closeBulkUpdateModal);
$('#bulk-update-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-update-overlay') closeBulkUpdateModal(); });
$('#btn-bulk-update-row').addEventListener('click', addBulkUpdateRow);
$('#bulk-update-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('bu-remove-row')){
    const rows = $('#bulk-update-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// دعم لصق منسوخ من إكسل، مع مطابقة نصّية (لا قيمة فقط) لقوائم الاختيار ذات الأكواد الثابتة (نوع العميل/مصدر الحقيبة/ملغى)
function setBulkSelectFuzzyAny(select, val){
  val = val.trim();
  if(!val){ select.value=''; return; }
  const opt = [...select.options].find(o=> o.value.trim().toLowerCase()===val.toLowerCase() || o.textContent.trim().toLowerCase()===val.toLowerCase());
  if(opt) select.value = opt.value;
}
$('#bulk-update-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#bulk-update-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBulkUpdateRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>24) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT') setBulkSelectFuzzyAny(field, val);
      else if(field.classList.contains('bu-date')){ const norm = normalizeDateForBulkPaste(val); if(norm) field.value = norm; }
      else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bulk-update-save').addEventListener('click', async ()=>{
  const rows = [...$('#bulk-update-table-body').querySelectorAll('tr')];
  const present = v => !(v===undefined || v===null || String(v).trim()==='');
  const errors = [];
  const seenIdsThisBatch = new Set();
  const patches = [];
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value;
    const clientId = val('bu-id').trim();
    const anyValue = [...row.querySelectorAll('input,select')].some(el=> el.value && String(el.value).trim()!=='');
    if(!clientId && !anyValue) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(seenIdsThisBatch.has(clientId)){ errors.push(`${rowLabel}: رقم الهوية ${clientId} مكرر داخل هذا الجدول`); return; }
    seenIdsThisBatch.add(clientId);
    const name = val('bu-name').trim();
    const existingIdx = clients.findIndex(c=>c.clientId===clientId);
    if(existingIdx>-1){
      const existing = clients[existingIdx];
      const patch = {};
      if(present(name)) patch.name = name;
      if(present(val('bu-refer'))) patch.referNum = val('bu-refer').trim();
      if(present(val('bu-phone'))) patch.phone = val('bu-phone').trim();
      if(present(val('bu-nat'))) patch.nationality = val('bu-nat');
      if(present(val('bu-ctype'))) patch.clientType = val('bu-ctype');
      if(present(val('bu-company'))) patch.companyName = val('bu-company').trim();
      if(present(val('bu-credit'))) patch.creditDays = num(val('bu-credit'));
      if(present(val('bu-course'))) patch.courseType = val('bu-course');
      if(present(val('bu-coursenum'))) patch.courseNumber = val('bu-coursenum').trim();
      if(present(val('bu-invoice'))) patch.invoice = val('bu-invoice').trim();
      if(present(val('bu-date'))) patch.date = val('bu-date');
      if(present(val('bu-price'))) patch.coursePrice = num(val('bu-price'));
      if(present(val('bu-baginvoice'))) patch.bagInvoice = val('bu-baginvoice').trim();
      if(present(val('bu-discount'))) patch.discount = num(val('bu-discount'));
      if(present(val('bu-paid'))) patch.paid = num(val('bu-paid'));
      if(present(val('bu-paid2'))) patch.paid2 = num(val('bu-paid2'));
      if(present(val('bu-channel2'))) patch.channel2 = val('bu-channel2');
      if(present(val('bu-channel'))) patch.channel = val('bu-channel');
      if(present(val('bu-netinvoice'))) patch.networkInvoice = val('bu-netinvoice').trim();
      if(present(val('bu-stage'))) patch.stage = val('bu-stage').trim() || 'جديد';
      if(present(val('bu-cancelled'))) patch.cancelled = val('bu-cancelled')==='yes';
      if(present(val('bu-notes'))) patch.notes = val('bu-notes').trim();
      if(present(val('bu-bagsource'))){
        const bagSourceNew = val('bu-bagsource');
        patch.bagSource = bagSourceNew;
        if(bagSourceNew==='own'){ patch.bagPrice = 0; }
        else if(present(val('bu-bagprice'))){ patch.bagPrice = num(val('bu-bagprice')); }
        if(bagSourceNew!=='buy'){ patch.bagStatus = bagSourceNew==='stock' ? 'purchased' : 'n/a'; }
        else if(!existing.bagStatus || existing.bagSource!=='buy'){ patch.bagStatus = 'pending'; }
        else { patch.bagStatus = existing.bagStatus; }
        const effectiveBagInvoice = present(val('bu-baginvoice')) ? patch.bagInvoice : existing.bagInvoice;
        if(bagSourceNew==='buy' && effectiveBagInvoice){
          patch.bagStatus = 'purchased';
          if(!existing.bagPurchaseDate) patch.bagPurchaseDate = todayISO();
        }
      } else if(present(val('bu-bagprice'))){
        patch.bagPrice = num(val('bu-bagprice'));
      }
      patches.push({mode:'update', idx: existingIdx, patch, oldCourseNumber: existing.courseNumber||''});
    } else {
      if(!name){ errors.push(`${rowLabel}: رقم الهوية ${clientId} غير موجود بالنظام — الاسم مطلوب لإضافته كعميل جديد`); return; }
      const bagSource = val('bu-bagsource') || 'stock';
      const clientTypeRaw = val('bu-ctype') || 'center';
      const rowData = {
        clientId, name,
        referNum: val('bu-refer').trim(),
        phone: val('bu-phone').trim(),
        nationality: val('bu-nat'),
        clientType: clientTypeRaw,
        companyName: clientTypeRaw==='company' ? val('bu-company').trim() : '',
        creditDays: clientTypeRaw==='company' ? num(val('bu-credit')) : '',
        courseType: val('bu-course'),
        courseNumber: val('bu-coursenum').trim(),
        invoice: val('bu-invoice').trim(),
        date: val('bu-date') || todayISO(),
        coursePrice: num(val('bu-price')),
        bagSource,
        bagPrice: bagSource==='own' ? 0 : num(val('bu-bagprice')),
        bagInvoice: val('bu-baginvoice').trim(),
        discount: num(val('bu-discount')),
        paid: num(val('bu-paid')),
        paid2: num(val('bu-paid2')),
        channel2: val('bu-channel2'),
        channel: val('bu-channel'),
        networkInvoice: val('bu-netinvoice').trim(),
        stage: val('bu-stage').trim() || 'جديد',
        cancelled: val('bu-cancelled')==='yes',
        notes: val('bu-notes').trim(),
      };
      rowData.bagStatus = rowData.bagSource==='buy' ? 'pending' : (rowData.bagSource==='stock' ? 'purchased' : 'n/a');
      if(rowData.bagSource==='buy' && rowData.bagInvoice){
        rowData.bagStatus = 'purchased';
        rowData.bagPurchaseDate = todayISO();
      }
      patches.push({mode:'add', data:{id:uid(), createdAt:Date.now(), createdBy: currentUser, ...rowData}});
    }
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!patches.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`تحديث/استيراد بيانات العملاء دفعة واحدة (${patches.length} صف)`);
  let added=0, updated=0;
  const changedRows = [];
  patches.forEach(p=>{
    if(p.mode==='update'){
      clients[p.idx] = {...clients[p.idx], ...p.patch};
      updated++;
      changedRows.push({'الإجراء':'تحديث', ...clientToExportRow(clients[p.idx])});
      if(p.patch.courseNumber && p.patch.courseNumber!==p.oldCourseNumber){
        sendPowerAutomateEvent('course_number_updated', {clientId: clients[p.idx].clientId, name: clients[p.idx].name, courseNumber: clients[p.idx].courseNumber, courseType: clients[p.idx].courseType||''});
      }
    } else {
      clients.push(p.data);
      added++;
      changedRows.push({'الإجراء':'إضافة جديد', ...clientToExportRow(p.data)});
      sendPowerAutomateEvent('new_client', {clientId: p.data.clientId, name: p.data.name, nationality: p.data.nationality||'', phone: p.data.phone||'', courseType: p.data.courseType||'', courseNumber: p.data.courseNumber||''});
      if(p.data.courseNumber){
        sendPowerAutomateEvent('course_number_updated', {clientId: p.data.clientId, name: p.data.name, courseNumber: p.data.courseNumber, courseType: p.data.courseType||''});
      }
    }
  });
  await saveClients();
  clients.forEach(c=> syncClientLedgerEntry(c));
  await saveVaultTx();
  await saveSettings();
  await syncBagStockIssues();
  await logAudit('edit','العملاء', `تحديث/استيراد بيانات العملاء من جدول داخل البرنامج: تمت إضافة ${added} عميل جديد، وتحديث ${updated} عميل موجود`);
  closeBulkUpdateModal();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderBags();
  downloadXlsx(`تقرير_تحديث_العملاء_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
  showToast(`تم: ${added} جديد، ${updated} محدث`);
});

/* ---------------- حذف عملاء دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل الحذف عبر استيراد ملف Excel القديم؛ نفس منطق التأكيد والنسخة الاحتياطية والمزامنة المالية. */
let bulkDeleteRowSeq = 0;
function bulkDeleteRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="bd-id" data-col="0" maxlength="10" placeholder="رقم الهوية"></td>
    <td><button type="button" class="btn btn-danger btn-sm bd-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBulkDeleteRow(){
  bulkDeleteRowSeq++;
  $('#bulk-delete-table-body').insertAdjacentHTML('beforeend', bulkDeleteRowHtml(bulkDeleteRowSeq));
}
function openBulkDeleteModal(){
  $('#bulk-delete-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addBulkDeleteRow();
  $('#bulk-delete-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkDeleteModal(){ $('#bulk-delete-overlay').classList.remove('show'); }
$('#btn-bulk-delete-table').addEventListener('click', openBulkDeleteModal);
$('#btn-bulk-delete-cancel').addEventListener('click', closeBulkDeleteModal);
$('#bulk-delete-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-delete-overlay') closeBulkDeleteModal(); });
$('#btn-bulk-delete-row').addEventListener('click', addBulkDeleteRow);
$('#bulk-delete-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('bd-remove-row')){
    const rows = $('#bulk-delete-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#bulk-delete-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text) return;
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  if(lines.length<=1 && !lines[0].includes('\t')) return; // لصق قيمة واحدة عادية — نترك السلوك الافتراضي
  e.preventDefault();
  const tbody = $('#bulk-delete-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBulkDeleteRow();
    const row = tbody.children[rowIdx];
    const field = row.querySelector('.bd-id');
    if(field) field.value = line.split('\t')[0].trim();
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bulk-delete-save').addEventListener('click', async ()=>{
  const rows = [...$('#bulk-delete-table-body').querySelectorAll('tr')];
  const idsInBatch = [...new Set(rows.map(r=>r.querySelector('.bd-id').value.trim()).filter(Boolean))];
  if(!idsInBatch.length){ showToast('لم تُدخل أي رقم هوية'); return; }
  const matchedAll = clients.filter(c=>idsInBatch.includes(c.clientId));
  const notFoundCount = idsInBatch.filter(id=>!clients.some(c=>c.clientId===id)).length;
  if(!matchedAll.length){ showToast('لم يتم العثور على أي عميل بأرقام الهوية المدخلة'); return; }
  const matched = matchedAll.filter(c=>canDeleteClientRecord(c));
  const blockedCount = matchedAll.length - matched.length;
  if(!matched.length){ showToast(`🔒 كل السجلات المطابقة (${matchedAll.length}) خارج مهلة الحذف المسموح بها أو الحذف معطَّل لصلاحيتك`); return; }
  if(blockedCount) showToast(`⚠️ تم استبعاد ${blockedCount} سجل خارج مهلة الحذف المسموح بها`);
  const namesPreview = matched.slice(0,5).map(c=>c.name).join('، ');
  const extra = matched.length>5 ? ` وآخرين (${matched.length-5})` : '';
  const notFoundMsg = notFoundCount ? `\n(تنبيه: ${notFoundCount} رقم هوية غير موجودين أصلاً بالنظام وسيتم تجاهلهم)` : '';
  if(!await customConfirm(`تم العثور على ${matched.length} عميل مطابق. تأكيد حذفهم دفعة واحدة؟ (${namesPreview}${extra})${notFoundMsg}\nسيُحذف أيضاً أي ترحيل مالي تلقائي مرتبط بكل عميل منهم. هذا الإجراء لا يمكن التراجع عنه.`)) return;
  snapshotState(`حذف عملاء دفعة واحدة عبر جدول (${matched.length} عميل)`);
  const idsSet = new Set(matched.map(c=>c.id));
  const removedNames = matched.map(c=>c.name);
  clients = clients.filter(c=>!idsSet.has(c.id));
  idsSet.forEach(id=>{ removeClientLedgerEntries(id); selectedClientIds.delete(id); });
  await saveClients(true); await saveVaultTx();
  await logAudit('delete','العملاء', `تم حذف ${matched.length} عميل عبر جدول داخل البرنامج: ${removedNames.slice(0,20).join('، ')}${removedNames.length>20?` وآخرين (${removedNames.length-20})`:''}${notFoundCount?` — تم تجاهل ${notFoundCount} رقم هوية غير موجود بالنظام`:''}`);
  closeBulkDeleteModal();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderCourses(); renderBags();
  if(typeof renderVault==='function') renderVault();
  showToast(`تم حذف ${matched.length} عميل${notFoundCount?`، وتجاهل ${notFoundCount} رقم غير موجود`:''}`);
});


