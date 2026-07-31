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
  // الشريط العلوي (quickstats) دايماً ظاهر فمحتاج يتحدّث دايماً — لكن باقي لوحة التحكم (CFO/التنبيهات
  // الذكية/نظرة الإقفال) بيحسب على كل بيانات العملاء والخزنة، وده تقيل ومحتاجينه بس لو تبويب "لوحة
  // التحكم" فعلاً مفتوح قدام المستخدم دلوقتي. لو مقفول، هيتحسب تلقائياً لحظة ما يفتحه (نفس السلوك
  // الموجود فى معالج نقر أزرار التنقل). ده بيوفر حساب كامل مكرر بعد كل عملية إضافة/حذف/تعديل فى أي
  // قسم تاني بالبرنامج (فواتير، خزنة، حقائب، دورات...) وهو أصلاً مش شايف لوحة التحكم دلوقتي.
  if(isViewActive('dashboard')){
    renderCfoDashboard();
    renderSmartAlerts();
    renderCloseOverview(c, totalPaid, totalRemaining);
  }
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

