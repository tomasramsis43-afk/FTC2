/* ============================================================
   لوحة التحكم — الطبقة التنفيذية (Phase 7)
   ------------------------------------------------------------
   تُضيف فوق لوحة dashboard-v2 (دون تعديلها):
     1) شريط تنفيذي: صافي التدفق النقدي + خط اتجاه + محصّل/مصروف/نسبة تحصيل.
     2) «خطة اليوم»: أولويات التشغيل (اعتمادات، متابعات، مديونيات، حقائب، سيولة، فواتير).
     3) شبكة تحليلات: مزيج التحصيل (Donut) + أحدث التحصيلات + أعلى المديونيات + صحة البيانات.

   قواعد:
     - كل الحسابات في المتصفح، وتُعاد باستخدام نفس دوال لوحة v2 (d2Range/d2Compact...).
     - المحتوى المالي يظهر فقط لمن يملك صلاحية الخزنة أو المحاسبة.
     - لا تُعدّل هذه الطبقة أي حاوية تخص dashboard-v2 لتفادي حلقات إعادة الرسم.
   ============================================================ */
(function(){
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const esc = s => {
    if(typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  };
  const money = v => {
    if(typeof window.fmt === 'function') return window.fmt(n(v));
    return n(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  };
  const compact = v => {
    if(typeof window.d2Compact === 'function') return window.d2Compact(n(v));
    const a = Math.abs(n(v));
    if(a >= 1e6) return (n(v) / 1e6).toFixed(1).replace(/\.0$/, '') + 'م';
    if(a >= 1e3) return Math.round(n(v) / 1e3) + 'ألف';
    return String(Math.round(n(v)));
  };
  const today = () => (typeof window.todayISO === 'function' ? window.todayISO() : new Date().toISOString().slice(0, 10));
  const clock = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const period = () => (typeof window.d2Range === 'function' && typeof dash2Period !== 'undefined') ? dash2Period : 'month';
  const PERIOD_LABELS = { today: 'اليوم', week: 'آخر 7 أيام', month: 'هذا الشهر', year: 'هذه السنة' };
  const DEST = { vault: 'الخزنة', bank: 'البنك', network: 'الشبكة', network2: 'شبكة 2', other: 'أخرى' };
  const DEST_COLORS = { vault: 'var(--brand-primary)', bank: 'var(--brand-secondary)', network: '#6366f1', network2: '#d97706', other: 'var(--text-muted)' };
  const DEST_ORDER = ['vault', 'bank', 'network', 'network2', 'other'];

  /* الوصول إلى المتغيرات العامة المُعلنة بـ let/const في ملفات أخرى
     (لا تظهر كخصائص على window، لذلك نقرأها بالمعرّف المباشر بحذر) */
  function clientsArr(){
    try{ return (typeof clients !== 'undefined' && Array.isArray(clients)) ? clients : []; }catch(e){ return []; }
  }
  function vaultArr(){
    try{ return (typeof vaultTx !== 'undefined' && Array.isArray(vaultTx)) ? vaultTx : []; }catch(e){ return []; }
  }
  function settingsObj(){
    try{ return (typeof settings !== 'undefined' && settings) ? settings : {}; }catch(e){ return {}; }
  }
  function followupsArr(){
    try{ return (typeof followUpTasks !== 'undefined' && Array.isArray(followUpTasks)) ? followUpTasks : []; }catch(e){ return []; }
  }
  function visiblePending(){
    try{ return (typeof visiblePendingApprovals !== 'undefined' && Array.isArray(visiblePendingApprovals)) ? visiblePendingApprovals : []; }catch(e){ return []; }
  }
  function userRole(){
    try{ return typeof currentUserRole !== 'undefined' ? currentUserRole : ''; }catch(e){ return ''; }
  }

  function canMoney(){
    try{
      return (typeof canAccessView === 'function') && (canAccessView('vault') || canAccessView('accounting'));
    }catch(e){ return true; }
  }

  function range(){
    if(typeof window.d2Range === 'function') return window.d2Range(period());
    const now = new Date();
    const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: iso(from), to: iso(now), pFrom: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), pTo: iso(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())) };
  }

  function sparkKeys(){
    if(typeof window.d2SparkKeys === 'function') return window.d2SparkKeys(period());
    const out = [];
    const now = new Date();
    for(let i = 29; i >= 0; i--){
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return { keys: out, keyOf: s => String(s || '').slice(0, 10) };
  }

  /* ---------------- تجميع الأرقام ---------------- */
  function summary(){
    const R = range();
    const sk = sparkKeys();
    const idx = new Map(sk.keys.map((k, i) => [k, i]));
    const spark = new Array(sk.keys.length).fill(0);
    let curIn = 0, curOut = 0, curRet = 0, prevIn = 0, prevOut = 0, prevRet = 0;
    const destMap = {};
    const txs = vaultArr();

    txs.forEach(t => {
      const d = String(t.date || '').slice(0, 10);
      const amt = n(t.amount);
      const inRange = d >= R.from && d <= R.to;
      const inPrev = d >= R.pFrom && d <= R.pTo;
      const isIn = t.type === 'in';
      if(inRange){
        if(isIn){
          curIn += amt;
          const k = t.destination || 'other';
          destMap[k] = (destMap[k] || 0) + amt;
        }else if(t.isReturn){
          curRet += amt;
        }else{
          curOut += amt;
        }
      }
      if(inPrev){
        if(isIn) prevIn += amt;
        else if(t.isReturn) prevRet += amt;
        else prevOut += amt;
      }
      const i = idx.get(sk.keyOf(t.date));
      if(i !== undefined){
        spark[i] += isIn ? amt : -amt;
      }
    });

    const collected = Math.max(0, curIn - curRet);
    const expenses = curOut;
    const net = collected - expenses;
    const prevCollected = Math.max(0, prevIn - prevRet);
    const prevNet = prevCollected - prevOut;

    // نسبة تحصيل «دفعة الفترة»: كم دُفع من قيمة عملاء سُجّلوا خلال الفترة نفسها
    let cohortTotal = 0, cohortPaid = 0, pCohortTotal = 0, pCohortPaid = 0;
    const list = clientsArr();
    list.forEach(c => {
      if(c.cancelled || c.suspended) return;
      try{ if(typeof window.isApprovedClient === 'function' && !window.isApprovedClient(c)) return; }catch(e){}
      const d = String(c.date || '').slice(0, 10);
      const t = typeof window.total === 'function' ? window.total(c) : n(c.coursePrice) - n(c.discount);
      const p = typeof window.paidTotal === 'function' ? window.paidTotal(c) : n(c.paid) + n(c.paid2);
      if(d >= R.from && d <= R.to){ cohortTotal += t; cohortPaid += Math.min(t, p); }
      if(d >= R.pFrom && d <= R.pTo){ pCohortTotal += t; pCohortPaid += Math.min(t, p); }
    });
    const rate = cohortTotal > 0 ? Math.min(100, Math.round((cohortPaid / cohortTotal) * 100)) : null;
    const prevRate = pCohortTotal > 0 ? Math.min(100, Math.round((pCohortPaid / pCohortTotal) * 100)) : null;

    // أحدث التحصيلات (كل الفترات — الأحدث أولاً)
    const latest = txs
      .filter(t => t.type === 'in' && n(t.amount) > 0)
      .slice()
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || n(b.createdAt) - n(a.createdAt))
      .slice(0, 6);

    return { R, spark, collected, expenses, net, prevCollected, prevNet, destMap, rate, prevRate, latest, curIn, curRet };
  }

  function deltaChip(cur, prev, label){
    if(!prev && !cur) return `<span class="pro-delta flat">—</span>`;
    if(!prev) return `<span class="pro-delta up">جديد</span>`;
    const p = ((cur - prev) / Math.abs(prev)) * 100;
    const cls = p > 0.5 ? 'up' : p < -0.5 ? 'down' : 'flat';
    const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '■';
    const shown = Math.abs(p) >= 999 ? '999+' : Math.abs(p).toFixed(0);
    return `<span class="pro-delta ${cls}" title="مقارنةً بـ ${esc(label)}: ${p > 0 ? '+' : ''}${p.toFixed(0)}%">${arrow} ${shown}%</span>`;
  }

  /* ---------------- SVG ---------------- */
  function heroSpark(values){
    const W = 560, H = 96, p = 8;
    if(!values.length) return '';
    const max = Math.max(0, ...values), min = Math.min(0, ...values);
    const span = (max - min) || 1;
    const xOf = i => W - p - (i / Math.max(1, values.length - 1)) * (W - 2 * p);
    const yOf = v => H - p - ((v - min) / span) * (H - 2 * p);
    const pts = values.map((v, i) => [xOf(i), yOf(v)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const zeroY = yOf(0).toFixed(1);
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${zeroY} L${pts[0][0].toFixed(1)} ${zeroY} Z`;
    return `<svg class="pro-spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line class="zero" x1="${p}" y1="${zeroY}" x2="${W - p}" y2="${zeroY}"/>
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
    </svg>`;
  }

  function donut(destMap){
    const total = DEST_ORDER.reduce((s, k) => s + n(destMap[k]), 0);
    if(total <= 0) return '<div class="dash2-empty">لا توجد تحصيلات في هذه الفترة</div>';
    const R = 54, C = 2 * Math.PI * R;
    let offset = 0;
    const segs = DEST_ORDER.filter(k => n(destMap[k]) > 0).map(k => {
      const val = n(destMap[k]);
      const pct = val / total;
      const len = Math.max(0, pct * C - 4);
      const seg = `<circle class="pro-donut-seg" cx="80" cy="80" r="${R}" fill="none"
        stroke="${DEST_COLORS[k]}" stroke-width="16"
        stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 80 80)" data-pro-go="vault" style="cursor:pointer"><title>${esc(DEST[k] || k)}: ${esc(money(val))} (${Math.round(pct * 100)}%)</title></circle>`;
      offset += pct * C;
      return seg;
    }).join('');
    const legend = DEST_ORDER.filter(k => n(destMap[k]) > 0).map(k => {
      const val = n(destMap[k]);
      const pct = Math.round((val / total) * 100);
      return `<button type="button" class="pro-legend-row" data-pro-go="vault" title="فتح الحركات المالية">
        <i class="pro-dot" style="background:${DEST_COLORS[k]}"></i>
        <span class="pro-legend-name">${esc(DEST[k] || k)}</span>
        <span class="pro-legend-pct">${pct}%</span>
        <span class="pro-legend-val">${esc(money(val))} <small>﷼</small></span>
      </button>`;
    }).join('');
    return `<div class="pro-donut-wrap">
      <div class="pro-donut-box">
        <svg viewBox="0 0 160 160" class="pro-donut" role="img" aria-label="مزيج التحصيل حسب الوجهة">
          <circle cx="80" cy="80" r="${R}" fill="none" stroke="var(--surface-alt)" stroke-width="16"/>
          ${segs}
        </svg>
        <div class="pro-donut-center"><b>${esc(compact(total))}</b><span>﷼ محصّل</span></div>
      </div>
      <div class="pro-legend">${legend}</div>
    </div>`;
  }

  /* ---------------- بيانات المساعدة ---------------- */
  function approved(c){
    try{ return !c.cancelled && !c.suspended && (typeof window.isApprovedClient !== 'function' || window.isApprovedClient(c)); }
    catch(e){ return !c.cancelled && !c.suspended; }
  }

  function topDebtors(limit){
    const arr = clientsArr();
    if(typeof window.remaining !== 'function') return [];
    return arr.filter(approved).map(c => {
      const rem = window.remaining(c);
      const tot = typeof window.total === 'function' ? window.total(c) : 0;
      const paid = typeof window.paidTotal === 'function' ? window.paidTotal(c) : 0;
      const days = typeof window.daysSinceDate === 'function' ? window.daysSinceDate(c.date) : 0;
      return { c, rem, tot, paid, days };
    }).filter(x => x.rem > 0).sort((a, b) => b.rem - a.rem).slice(0, limit);
  }

  function taskCounts(){
    const counts = { pending: 0, followups: 0, debtors: 0, bags: 0, invoices: 0, lowBalance: false };
    try{
      if(userRole() === 'admin'){
        const pendingClients = typeof window.pendingClientIdSet === 'function' ? window.pendingClientIdSet().size : 0;
        const visible = visiblePending().length;
        counts.pending = pendingClients + visible;
      }
    }catch(e){}
    try{
      const t = today();
      const tasks = followupsArr();
      counts.followups = tasks.filter(x => x.status === 'open' && x.dueDate && String(x.dueDate) <= t).length;
    }catch(e){}
    try{
      const arr = clientsArr();
      if(typeof window.remaining === 'function') counts.debtors = arr.filter(c => approved(c) && window.remaining(c) > 0).length;
    }catch(e){}
    try{
      const cfg = settingsObj();
      const overdueDays = cfg.bagOverdueDays || 14;
      const arr = clientsArr();
      counts.bags = arr.filter(c => c.bagSource === 'buy' && c.bagStatus !== 'purchased' && !c.suspended && (typeof window.daysSinceDate === 'function' ? window.daysSinceDate(c.date) : 0) > overdueDays).length;
    }catch(e){}
    try{
      if(typeof window.courseInvoiceClients === 'function'){
        window.courseInvoiceClients().forEach(c => {
          const actual = n(c.receiptActualValue);
          if(actual > 0 && Math.abs(actual - (typeof window.centerIncome === 'function' ? window.centerIncome(c) : 0)) >= 0.01) counts.invoices++;
        });
      }
    }catch(e){}
    try{
      const t = today();
      const sum = (typeof window.balanceOfAsOf === 'function')
        ? window.balanceOfAsOf('vault', t) + window.balanceOfAsOf('bank', t)
        : (typeof window.balanceOf === 'function' ? window.balanceOf('vault') + window.balanceOf('bank') : 0);
      const threshold = settingsObj().lowBalanceThreshold != null ? settingsObj().lowBalanceThreshold : 5000;
      counts.lowBalance = sum < threshold;
    }catch(e){}
    return counts;
  }

  function healthRows(counts){
    const rows = [];
    const backupOk = !!settingsObj().autoBackupEnabled;
    rows.push({
      ok: counts.invoices === 0,
      label: 'فواتير دورات غير مطابقة',
      detail: counts.invoices ? `${counts.invoices.toLocaleString('en-US')} فاتورة تحتاج مراجعة` : 'كل الفواتير مطابقة',
      view: 'courseinvoices'
    });
    rows.push({
      ok: counts.bags === 0,
      label: 'حقائب مطلوب شراؤها',
      detail: counts.bags ? `${counts.bags} حقيبة تجاوزت المدة` : 'لا توجد حقائب متأخرة',
      view: 'bags'
    });
    rows.push({
      ok: counts.followups === 0,
      label: 'المتابعات المستحقة',
      detail: counts.followups ? `${counts.followups} تذكير مستحق` : 'لا توجد متابعات متأخرة',
      view: 'followups'
    });
    if(canMoney()){
      rows.push({
        ok: !counts.lowBalance,
        label: 'حد السيولة الأدنى',
        detail: counts.lowBalance ? 'الخزنة والبنك أقل من الحد' : 'السيولة ضمن الحد الآمن',
        view: 'vault'
      });
    }
    rows.push({
      ok: backupOk,
      label: 'النسخ الاحتياطي التلقائي',
      detail: backupOk ? 'مُفعّل ويعمل' : 'معطّل — يُفضّل تفعيله',
      view: 'settings'
    });
    return rows;
  }

  /* ---------------- الرسم ---------------- */
  function renderHero(){
    const el = $('#dash-pro-hero');
    if(!el) return;
    const P = PERIOD_LABELS[period()] || 'هذا الشهر';
    const moneyOn = canMoney();
    const S = summary();

    if(moneyOn){
      const spark = heroSpark(S.spark);
      el.innerHTML = `<section class="pro-hero" aria-label="الملخص التنفيذي">
        <div class="pro-hero-main">
          <div class="pro-hero-top">
            <span class="pro-hero-eyebrow"><i class="pro-live-dot"></i> الملخص التنفيذي · ${esc(P)}</span>
            <span class="pro-hero-tools">
              <span class="pro-hero-stamp">آخر تحديث ${clock()}</span>
              <button type="button" class="pro-refresh" data-pro-refresh title="تحديث اللوحة">↻ تحديث</button>
            </span>
          </div>
          <div class="pro-hero-value-row">
            <span class="pro-hero-label">صافي التدفق النقدي</span>
            <strong class="pro-hero-value ${S.net >= 0 ? 'pos' : 'neg'}">${S.net >= 0 ? '+' : '−'}${esc(money(Math.abs(S.net)))} <small>﷼</small></strong>
            ${deltaChip(S.net, S.prevNet, 'الفترة السابقة')}
          </div>
          <div class="pro-hero-chart">${spark}</div>
          <div class="pro-hero-legend">
            <span><i class="pro-dot in"></i> محصّل <b>${esc(money(S.collected))}</b></span>
            <span><i class="pro-dot out"></i> مصروف <b>${esc(money(S.expenses))}</b></span>
          </div>
        </div>
        <div class="pro-hero-side">
          <div class="pro-hero-stat">
            <span class="pro-stat-label">المحصّل</span>
            <b class="pro-stat-value">${esc(money(S.collected))} <small>﷼</small></b>
            ${deltaChip(S.collected, S.prevCollected, 'الفترة السابقة')}
          </div>
          <div class="pro-hero-stat">
            <span class="pro-stat-label">المصروف</span>
            <b class="pro-stat-value">${esc(money(S.expenses))} <small>﷼</small></b>
            <span class="pro-stat-note">إجمالي المصروفات المسجّلة في الفترة</span>
          </div>
          <div class="pro-hero-stat pro-hero-stat-rate">
            <span class="pro-stat-label">نسبة التحصيل</span>
            <b class="pro-stat-value">${S.rate == null ? '—' : S.rate + '%'}</b>
            <span class="pro-rate-bar"><i style="width:${S.rate == null ? 0 : S.rate}%"></i></span>
          </div>
        </div>
      </section>`;
      return;
    }

    // نسخة غير مالية: ملخص التسجيلات والمتابعات فقط
    let regs = 0;
    const arr = clientsArr();
    arr.forEach(c => { const d = String(c.date || '').slice(0, 10); if(d >= S.R.from && d <= S.R.to && approved(c)) regs++; });
    el.innerHTML = `<section class="pro-hero pro-hero-lite">
      <div class="pro-hero-main">
        <div class="pro-hero-top"><span class="pro-hero-eyebrow"><i class="pro-live-dot"></i> ملخص اليوم · ${esc(P)}</span></div>
        <div class="pro-hero-value-row">
          <span class="pro-hero-label">التسجيلات في الفترة</span>
          <strong class="pro-hero-value pos">${esc(String(regs))}</strong>
        </div>
      </div>
      <div class="pro-hero-side">
        <div class="pro-hero-stat"><span class="pro-stat-label">بانتظار المتابعة</span><b class="pro-stat-value">${esc(String(taskCounts().followups))}</b></div>
      </div>
    </section>`;
  }

  function renderBrief(){
    const el = $('#dash-pro-brief');
    if(!el) return;
    const c = taskCounts();
    const items = [];
    if(c.pending) items.push({ key: 'dashboard', cls: 'red', icon: '⏳', label: 'اعتمادات معلّقة', val: c.pending });
    if(c.followups) items.push({ key: 'followups', cls: 'amber', icon: '🔔', label: 'متابعات مستحقة', val: c.followups });
    if(c.debtors) items.push({ key: 'clients-owe', cls: 'amber', icon: '👤', label: 'عملاء عليهم متبقي', val: c.debtors });
    if(c.invoices && canMoney()) items.push({ key: 'courseinvoices', cls: 'amber', icon: '🧾', label: 'فواتير تحتاج مطابقة', val: c.invoices });
    if(c.bags) items.push({ key: 'bags', cls: 'red', icon: '👜', label: 'حقائب متأخرة', val: c.bags });
    if(c.lowBalance && canMoney()) items.push({ key: 'vault', cls: 'red', icon: '💧', label: 'سيولة منخفضة', val: '!' });

    if(!items.length){
      el.innerHTML = `<div class="pro-brief pro-brief-clear">
        <span class="pro-brief-title">خطة اليوم</span>
        <span class="pro-clear-chip"><i>✓</i> كل شيء تحت السيطرة — لا توجد مهام عاجلة</span>
      </div>`;
      return;
    }
    el.innerHTML = `<div class="pro-brief">
      <span class="pro-brief-title">خطة اليوم <small>${items.length} أولوية</small></span>
      <div class="pro-brief-chips">
        ${items.map(it => {
          const shown = typeof it.val === 'number' && it.val > 99 ? '99+' : it.val;
          return `<button type="button" class="pro-chip ${it.cls}" data-pro-go="${it.key}" title="فتح ${esc(it.label)}${typeof it.val === 'number' ? ` — ${it.val}` : ''}">
          <span class="pro-chip-icon">${it.icon}</span>
          <span class="pro-chip-label">${esc(it.label)}</span>
          <b class="pro-chip-count">${esc(String(shown))}</b>
        </button>`;
        }).join('')}
      </div>
    </div>`;
  }

  function renderInsights(){
    const el = $('#dash-pro-insights');
    if(!el) return;
    const moneyOn = canMoney();
    const S = moneyOn ? summary() : null;
    const debtors = moneyOn ? topDebtors(6) : [];
    const counts = taskCounts();
    const health = healthRows(counts);
    const okCount = health.filter(r => r.ok).length;
    const score = Math.round((okCount / health.length) * 100);

    const panels = [];

    if(moneyOn){
      panels.push(`<div class="panel dash2-panel pro-panel pro-span-5">
        <div class="dash2-panel-head">
          <div class="pro-panel-title"><h3>مزيج التحصيل</h3><span class="pro-panel-sub">حسب وجهة المبلغ · ${esc(PERIOD_LABELS[period()] || '')}</span></div>
          <button type="button" class="pro-link" data-pro-go="vault">الحركات ←</button>
        </div>
        ${donut(S.destMap)}
      </div>`);

      panels.push(`<div class="panel dash2-panel pro-panel pro-span-7">
        <div class="dash2-panel-head">
          <div class="pro-panel-title"><h3>أحدث التحصيلات</h3><span class="pro-panel-sub">آخر 6 دفعات واردة</span></div>
          <button type="button" class="pro-link" data-pro-go="vault">الكل ←</button>
        </div>
        ${latestCollections(S.latest)}
      </div>`);

      panels.push(`<div class="panel dash2-panel pro-panel pro-span-7">
        <div class="dash2-panel-head">
          <div class="pro-panel-title"><h3>أعلى المديونيات</h3><span class="pro-panel-sub">المتبقي على العملاء الآن</span></div>
          <button type="button" class="pro-link" data-pro-go="clients-owe">كل العملاء ←</button>
        </div>
        ${debtors.length ? debtors.map((d, i) => debtorRow(d, i)).join('') : emptyDebtors(S)}
      </div>`);
    }

    panels.push(`<div class="panel dash2-panel pro-panel ${moneyOn ? 'pro-span-5' : 'pro-span-12'}">
      <div class="dash2-panel-head">
        <div class="pro-panel-title"><h3>صحة البيانات</h3><span class="pro-panel-sub">جاهزية التشغيل الآن</span></div>
        <span class="pro-score ${score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad'}">${score}%</span>
      </div>
      <div class="pro-health-bar"><i style="width:${score}%"></i></div>
      <div class="pro-health-list">
        ${health.map(r => `<button type="button" class="pro-health-row" data-pro-go="${r.view}" title="فتح">
          <span class="pro-health-mark ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '!'}</span>
          <span class="pro-health-text"><b>${esc(r.label)}</b><small>${esc(r.detail)}</small></span>
          <span class="pro-health-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></span>
        </button>`).join('')}
      </div>
    </div>`);

    el.innerHTML = `<div class="pro-grid">${panels.join('')}</div>`;
  }

  function latestCollections(rows){
    if(!rows.length) return `<div class="dash2-empty">لا توجد تحصيلات مسجّلة بعد</div>`;
    const byId = new Map();
    const byClientId = new Map();
    clientsArr().forEach(c => {
      if(c.id) byId.set(String(c.id), c);
      if(c.clientId) byClientId.set(String(c.clientId), c);
    });
    return `<div class="pro-collections">${rows.map(t => {
      const c = (t.autoClientId && byId.get(String(t.autoClientId))) || (t.clientId && byClientId.get(String(t.clientId))) || null;
      const name = (c && c.name) || t.clientName || 'حركة غير مرتبطة بعميل';
      const initial = String(name).trim().charAt(0) || '﷼';
      const sub = [t.method || '', DEST[t.destination] || ''].filter(Boolean).join(' · ') || 'بدون تفاصيل';
      const click = c ? ` data-pro-client="${esc(String(c.id))}"` : '';
      return `<button type="button" class="pro-collection-row"${click} title="${c ? 'فتح ملف العميل' : ''}">
        <span class="pro-avatar">${esc(initial)}</span>
        <span class="pro-collection-main"><b>${esc(name)}</b><small>${esc(sub)}</small></span>
        <span class="pro-collection-amt">${esc(money(t.amount))} <small>﷼</small></span>
        <span class="pro-collection-date">${esc(String(t.date || '').slice(0, 10))}</span>
      </button>`;
    }).join('')}</div>`;
  }

  function emptyDebtors(S){
    const paidCount = clientsArr().filter(c => approved(c) && typeof window.remaining === 'function' && window.remaining(c) <= 0).length;
    return `<div class="pro-empty-good">
      <span>✓</span><b>لا توجد مديونيات</b><small>كل العملاء مسددون بالكامل</small>
      <div class="pro-empty-stats">
        <div><b>${esc(paidCount.toLocaleString('en-US'))}</b><span>عميل مسدد</span></div>
        <div><b>${esc(money(S.collected))} <small>﷼</small></b><span>محصّل الفترة</span></div>
        <div><b>${S.rate == null ? '—' : S.rate + '%'}</b><span>نسبة التحصيل</span></div>
      </div>
    </div>`;
  }

  function debtorRow(d, i){
    const pct = d.tot > 0 ? Math.min(100, Math.round((d.paid / d.tot) * 100)) : 0;
    const age = d.days > 90 ? 'danger' : d.days > 30 ? 'warn' : '';
    return `<button type="button" class="pro-debtor" data-pro-client="${esc(String(d.c.id))}" title="فتح ملف ${esc(d.c.name || '')}">
      <span class="pro-rank">${i + 1}</span>
      <span class="pro-debtor-main">
        <span class="pro-debtor-name">${esc(d.c.name || 'بدون اسم')}</span>
        <span class="pro-debtor-meta">${esc(String(d.c.phone || d.c.clientId || ''))} <em class="${age}">${d.days} يوم</em></span>
        <span class="pro-meter"><i style="width:${pct}%"></i></span>
      </span>
      <span class="pro-debtor-amt">${esc(money(d.rem))} <small>﷼</small></span>
    </button>`;
  }

  function renderAll(){
    try{ renderHero(); }catch(e){ console.error('dashboard-pro hero:', e); }
    try{ renderBrief(); }catch(e){ console.error('dashboard-pro brief:', e); }
    try{ renderInsights(); }catch(e){ console.error('dashboard-pro insights:', e); }
  }

  let timer = null;
  function schedule(delay){
    clearTimeout(timer);
    timer = setTimeout(renderAll, delay == null ? 90 : delay);
  }

  /* ---------------- التنقل ---------------- */
  function go(view){
    const clickTab = v => {
      const b = document.querySelector(`nav.tabs button[data-view="${v}"]`);
      if(b) b.click();
    };
    if(view === 'clients-owe'){
      clickTab('clients');
      const f = $('#filter-status');
      if(f){ f.value = 'owe'; f.dispatchEvent(new Event('change')); }
      return;
    }
    if(view === 'followups'){
      const target = $('#followups-panel');
      if(target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if(view === 'dashboard'){
      const p = $('#pending-approvals-panel');
      if(p) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    clickTab(view);
  }

  document.addEventListener('click', e => {
    const refresh = e.target.closest('[data-pro-refresh]');
    if(refresh){
      if(typeof window.refreshEverything === 'function') window.refreshEverything();
      else renderAll();
      return;
    }
    const client = e.target.closest('[data-pro-client]');
    if(client && typeof window.openClientWorkspace === 'function'){
      const id = client.getAttribute('data-pro-client');
      if(id) window.openClientWorkspace(id);
      return;
    }
    const nav = e.target.closest('[data-pro-go]');
    if(nav){ go(nav.getAttribute('data-pro-go')); }
  });

  /* ---------------- الربط مع لوحة v2 ---------------- */
  function hook(){
    const orig = window.renderDashboardV2;
    if(typeof orig === 'function' && !orig.__proHooked){
      const wrapped = function(){
        const out = orig.apply(this, arguments);
        schedule();
        return out;
      };
      wrapped.__proHooked = true;
      window.renderDashboardV2 = wrapped;
    }
    const kpis = $('#dash2-kpis');
    const grid = $('#dash2-grid');
    if(kpis) new MutationObserver(() => schedule()).observe(kpis, { childList: true });
    if(grid) new MutationObserver(() => schedule()).observe(grid, { childList: true });
  }

  function boot(){
    hook();
    renderAll();
    // البيانات المالية تُحمَّل بعد الإقلاع — نعيد الرسم بعد اكتمال التحميل
    setTimeout(renderAll, 600);
    setTimeout(renderAll, 1800);
    // تحديث هادئ كل دقيقة (وقت «آخر تحديث» والأرقام الجارية)
    setInterval(() => { if($('#view-dashboard')?.classList.contains('active')) renderAll(); }, 60000);
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
