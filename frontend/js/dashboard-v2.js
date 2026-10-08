/* ============================================================
   لوحة التحكم الجديدة (Dashboard v2)
   ------------------------------------------------------------
   تحلّ محل لوحة CFO القديمة (الهيرو + شبكة الرسوم + نبض الخزنة + نظرة الإقفال).
   المحتوى:
     1) شريط مؤشرات علوي (KPIs) مرتبط بفترة قابلة للاختيار (اليوم / 7 أيام / الشهر / السنة)
        مع مقارنة بالفترة السابقة وخط اتجاه مصغّر (Sparkline) — كل كرت قابل للنقر (Drill-down).
     2) التدفق النقدي (محصّل مقابل مصروف) لآخر 6/12 شهراً.
     3) أعمار الذمم (المتبقي على العملاء حسب عمر التسجيل: 30/60/90/+90 يوماً).
     4) أداء الدورات: الدورات القادمة ونسبة امتلاء كل دورة + أداء أنواع الدورات في الفترة.
   مركز التنبيهات (#smart-alerts-panel) والموافقات المعلّقة والمتابعات وإرسال التقارير بالإيميل
   تبقى كما هي (أدوات تشغيلية لا رسوم) ويُرسم هذا الملف حولها.
   قواعد:
     - كل الحسابات في المتصفح (البيانات المالية مشفّرة end-to-end فلا يمكن حسابها في SQL).
     - رسوم SVG خفيفة بلا مكتبات. الاتجاه RTL: الأقدم يميناً والأحدث يساراً.
     - المحتوى المالي (دخل/محصّل/سيولة/ذمم/تدفق) يظهر فقط لمن لديه صلاحية الخزنة أو المحاسبة.
   ============================================================ */

const DASH2_PERIOD_KEY = 'ftc2-dash2-period';
const DASH2_FLOW_KEY = 'ftc2-dash2-flow-months';
const DASH2_PERIODS = {
  today: { label: 'اليوم',        prevLabel: 'أمس' },
  week:  { label: 'آخر 7 أيام',   prevLabel: 'الـ 7 أيام السابقة' },
  month: { label: 'هذا الشهر',    prevLabel: 'نفس الفترة من الشهر الماضي' },
  year:  { label: 'هذه السنة',    prevLabel: 'نفس الفترة من السنة الماضية' },
};
let dash2Period = (function(){
  try{ const v = localStorage.getItem(DASH2_PERIOD_KEY); return DASH2_PERIODS[v] ? v : 'month'; }catch(e){ return 'month'; }
})();
let dash2FlowMonths = (function(){
  try{ return localStorage.getItem(DASH2_FLOW_KEY) === '12' ? 12 : 6; }catch(e){ return 6; }
})();

const D2_ICONS = {
  users:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  trend:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M17 15h.01"/></svg>',
  alert:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5h.01"/></svg>',
  vault:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  book:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
};

/* ---------------- أدوات التاريخ ---------------- */
function d2Iso(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
/* نطاق الفترة الحالية + الفترة السابقة المقابلة لها.
   الشهر/السنة تُقارَن بنفس عدد الأيام المنقضية من الفترة السابقة (مقارنة عادلة وليس بشهر كامل). */
function d2Range(period, now){
  const t = now || new Date();
  const y = t.getFullYear(), m = t.getMonth(), day = t.getDate();
  let from, to, pFrom, pTo;
  if(period === 'today'){
    from = to = new Date(y, m, day);
    pFrom = pTo = new Date(y, m, day - 1);
  }else if(period === 'week'){
    from = new Date(y, m, day - 6); to = new Date(y, m, day);
    pFrom = new Date(y, m, day - 13); pTo = new Date(y, m, day - 7);
  }else if(period === 'month'){
    from = new Date(y, m, 1); to = new Date(y, m, day);
    const dimPrev = new Date(y, m, 0).getDate();
    pFrom = new Date(y, m - 1, 1); pTo = new Date(y, m - 1, Math.min(day, dimPrev));
  }else{
    from = new Date(y, 0, 1); to = new Date(y, m, day);
    const dimPrev = new Date(y - 1, m + 1, 0).getDate();
    pFrom = new Date(y - 1, 0, 1); pTo = new Date(y - 1, m, Math.min(day, dimPrev));
  }
  return { from: d2Iso(from), to: d2Iso(to), pFrom: d2Iso(pFrom), pTo: d2Iso(pTo) };
}
/* مفاتيح خط الاتجاه المصغّر: يومي (7 أو 30 يوماً) أو شهري (12 شهراً للسنة) — الأقدم أولاً */
function d2SparkKeys(period, now){
  const t = now || new Date();
  if(period === 'year'){
    const keys = [];
    for(let i = 11; i >= 0; i--){
      const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
      keys.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
    }
    return { keys, keyOf: s => String(s || '').slice(0, 7) };
  }
  const n = period === 'month' ? 30 : 7;
  const keys = [];
  for(let i = n - 1; i >= 0; i--) keys.push(d2Iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i)));
  return { keys, keyOf: s => String(s || '').slice(0, 10) };
}
function d2Compact(n){
  const a = Math.abs(n);
  if(a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'م';
  if(a >= 1e3) return Math.round(n / 1e3) + 'ألف';
  return String(Math.round(n));
}

/* ---------------- تجميع الأرقام ---------------- */
function d2Collect(){
  const R = d2Range(dash2Period);
  const sk = d2SparkKeys(dash2Period);
  const idx = new Map(sk.keys.map((k, i) => [k, i]));
  const mk = () => ({ cur: 0, prev: 0, spark: new Array(sk.keys.length).fill(0) });
  const D = { R, reg: mk(), income: mk(), collected: mk(), typeMap: {} };
  const bump = (m, dateStr, v) => {
    const d = String(dateStr || '').slice(0, 10);
    if(d >= R.from && d <= R.to) m.cur += v;
    else if(d >= R.pFrom && d <= R.pTo) m.prev += v;
    const i = idx.get(sk.keyOf(dateStr));
    if(i !== undefined) m.spark[i] += v;
  };
  clients.forEach(c => {
    if(c.cancelled || !isApprovedClient(c)) return;
    const inc = centerIncome(c);
    bump(D.reg, c.date, 1);
    bump(D.income, c.date, inc);
    const d = String(c.date || '').slice(0, 10);
    if(d >= R.from && d <= R.to){
      const k = c.courseType || 'غير محدد';
      const o = D.typeMap[k] || (D.typeMap[k] = { count: 0, income: 0 });
      o.count += 1; o.income += inc;
    }
  });
  vaultTx.forEach(t => { if(t.type === 'in') bump(D.collected, t.date, num(t.amount)); });
  return D;
}
/* أعمار الذمم: المتبقي على العملاء (المعتمدين وغير الموقوفين/الملغيين) موزّعاً حسب عمر التسجيل */
function d2Receivables(){
  const buckets = [
    { label: 'حتى 30 يوماً', color: 'var(--success)', count: 0, amount: 0 },
    { label: '31 – 60 يوماً', color: 'var(--warning, #e0a72f)', count: 0, amount: 0 },
    { label: '61 – 90 يوماً', color: '#e8833a', count: 0, amount: 0 },
    { label: 'أكثر من 90 يوماً', color: 'var(--danger)', count: 0, amount: 0 },
  ];
  let total = 0, count = 0;
  clients.forEach(c => {
    if(c.suspended || c.cancelled || !isApprovedClient(c)) return;
    const r = remaining(c);
    if(r <= 0) return;
    const days = daysSinceDate(c.date);
    const b = buckets[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3];
    b.count += 1; b.amount += r;
    total += r; count += 1;
  });
  return { buckets, total, count };
}
/* الدورات القادمة (تاريخ الدورة اليوم أو بعده) مع عدد المسجلين والسعة */
function d2UpcomingCourses(limit){
  const today = todayISO();
  const by = groupClientsByCourseNumber();
  const all = getEffectiveSessions()
    .filter(s => s.courseNumber && s.date && String(s.date) >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const rows = all.slice(0, limit).map(s => {
    const enrolled = (by.get(s.courseNumber) || []).filter(c => !c.cancelled).length;
    const days = Math.round((new Date(s.date) - new Date(today)) / 86400000);
    return { s, enrolled, days };
  });
  return { rows, total: all.length, nextDate: all.length ? all[0].date : '' };
}

/* ---------------- مكوّنات الرسم ---------------- */
function d2Delta(cur, prev, prevLabel){
  if(!prev && !cur) return '<span class="dash2-delta flat">—</span>';
  if(!prev) return `<span class="dash2-delta up" title="لا توجد بيانات في ${escapeHtml(prevLabel)}">جديد</span>`;
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  const cls = p > 0.5 ? 'up' : p < -0.5 ? 'down' : 'flat';
  const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '■';
  return `<span class="dash2-delta ${cls}" title="مقارنة بـ ${escapeHtml(prevLabel)}: ${escapeHtml(fmt(prev))}">${arrow} ${Math.abs(p).toFixed(0)}%</span>`;
}
function d2Spark(values){
  const n = values.length;
  if(n < 2) return '';
  const W = 96, H = 28, p = 2;
  const max = Math.max(...values), min = Math.min(...values);
  const span = (max - min) || 1;
  const pts = values.map((v, i) => [W - p - (i / (n - 1)) * (W - 2 * p), H - p - ((v - min) / span) * (H - 2 * p)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[n - 1][0].toFixed(1)} ${H - p} L${pts[0][0].toFixed(1)} ${H - p} Z`;
  return `<svg class="dash2-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${area}"/><path class="line" d="${line}"/></svg>`;
}
function d2Kpi(o){
  return `<button type="button" class="dash2-kpi ${o.tone ? 'tone-' + o.tone : ''}" ${o.nav ? `data-d2-nav="${o.nav}"` : ''} title="${escapeHtml(o.hint || '')}">
    <span class="dash2-kpi-top">
      <span class="dash2-kpi-icon">${D2_ICONS[o.icon] || ''}</span>
      <span class="dash2-kpi-label">${escapeHtml(o.label)}</span>
      ${o.delta || ''}
    </span>
    <span class="dash2-kpi-value">${o.value}</span>
    <span class="dash2-kpi-foot">
      <span class="dash2-kpi-sub">${o.sub || ''}</span>
      ${o.spark ? d2Spark(o.spark) : ''}
    </span>
  </button>`;
}
function d2Panel(title, body, opts){
  const o = opts || {};
  return `<div class="panel dash2-panel no-collapse ${o.cls || ''}">
    <div class="dash2-panel-head">
      <h3>${escapeHtml(title)}</h3>
      ${o.actions || ''}
    </div>
    ${body}
  </div>`;
}
function d2Empty(msg){ return `<div class="dash2-empty">${escapeHtml(msg)}</div>`; }

/* تدفق نقدي: أعمدة مزدوجة (محصّل / مصروف) لكل شهر، الأقدم يميناً */
function d2FlowPanel(){
  const keys = lastNMonthKeys(dash2FlowMonths);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const ins = new Array(keys.length).fill(0), outs = new Array(keys.length).fill(0);
  vaultTx.forEach(t => {
    const i = idx.get(String(t.date || '').slice(0, 7));
    if(i === undefined) return;
    if(t.type === 'in') ins[i] += num(t.amount);
    else if(t.type === 'out') outs[i] += num(t.amount);
  });
  const totalIn = ins.reduce((s, v) => s + v, 0), totalOut = outs.reduce((s, v) => s + v, 0);
  const net = totalIn - totalOut;
  const W = 560, H = 220, padR = 8, padL = 8, padT = 16, padB = 28;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(1, ...ins, ...outs);
  const step = innerW / keys.length;
  const bw = Math.max(5, Math.min(18, step / 3.2));
  const yOf = v => padT + innerH - (v / max) * innerH;
  const grid = [0, .5, 1].map(f => {
    const y = padT + innerH - f * innerH;
    return `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" class="grid"/><text x="${W - padR}" y="${y - 3}" class="axis" text-anchor="end">${d2Compact(max * f)}</text>`;
  }).join('');
  const bars = keys.map((k, i) => {
    const cx = W - padR - (i + .5) * step;
    const hi = (ins[i] / max) * innerH, ho = (outs[i] / max) * innerH;
    const tip = `${monthLabelAr(k)} — محصّل: ${fmt(ins[i])} · مصروف: ${fmt(outs[i])}`;
    return `<g><title>${escapeHtml(tip)}</title>
      <rect x="${cx - bw - 1}" y="${yOf(ins[i])}" width="${bw}" height="${Math.max(hi, ins[i] ? 1.5 : 0)}" rx="2.5" class="bar-in"/>
      <rect x="${cx + 1}" y="${yOf(outs[i])}" width="${bw}" height="${Math.max(ho, outs[i] ? 1.5 : 0)}" rx="2.5" class="bar-out"/>
      <text x="${cx}" y="${H - 9}" class="axis" text-anchor="middle">${escapeHtml(monthLabelAr(k))}</text></g>`;
  }).join('');
  const toggle = `<span class="dash2-seg dash2-seg-sm">
    <button type="button" data-d2-flow="6" class="${dash2FlowMonths === 6 ? 'active' : ''}">6 أشهر</button>
    <button type="button" data-d2-flow="12" class="${dash2FlowMonths === 12 ? 'active' : ''}">12 شهراً</button></span>`;
  const body = `
    <div class="dash2-flow-sums">
      <span><i class="dash2-dot in"></i> محصّل <b class="mono">${fmt(totalIn)}</b></span>
      <span><i class="dash2-dot out"></i> مصروف <b class="mono">${fmt(totalOut)}</b></span>
      <span>الصافي <b class="mono ${net < 0 ? 'neg' : 'pos'}">${fmt(net)}</b></span>
    </div>
    <svg class="dash2-flow" viewBox="0 0 ${W} ${H}" role="img" aria-label="التدفق النقدي الشهري">${grid}${bars}</svg>`;
  return d2Panel('التدفق النقدي', body, { cls: 'span-7', actions: toggle });
}

function d2ReceivablesPanel(){
  const R = d2Receivables();
  if(!R.count) return d2Panel('أعمار الذمم', d2Empty('لا توجد مبالغ متبقية على العملاء 🎉'), { cls: 'span-5' });
  const bar = R.buckets.map(b => b.amount > 0
    ? `<span style="flex:${b.amount}; background:${b.color};" title="${escapeHtml(b.label)}: ${escapeHtml(fmt(b.amount))}"></span>` : '').join('');
  const rows = R.buckets.map(b => {
    const pct = R.total ? (b.amount / R.total) * 100 : 0;
    return `<div class="dash2-age-row">
      <span class="dash2-age-name"><i class="dash2-dot" style="background:${b.color};"></i>${escapeHtml(b.label)}</span>
      <span class="mono dash2-age-count">${b.count} عميل</span>
      <span class="mono dash2-age-amt">${fmt(b.amount)}</span>
      <span class="mono dash2-age-pct">${pct.toFixed(0)}%</span>
    </div>`;
  }).join('');
  const body = `
    <div class="dash2-age-total"><b class="mono">${fmt(R.total)}</b> <span>﷼ على ${R.count} عميل</span></div>
    <div class="dash2-age-bar">${bar}</div>
    ${rows}
    <button type="button" class="btn btn-ghost btn-sm" data-d2-nav="owing" style="margin-top:10px;">عرض العملاء المتبقي عليهم ›</button>`;
  return d2Panel('أعمار الذمم', body, { cls: 'span-5' });
}

function d2CoursesPanel(){
  const U = d2UpcomingCourses(8);
  if(!U.rows.length) return d2Panel('الدورات القادمة', d2Empty('لا توجد دورات قادمة بتاريخ مسجّل'), { cls: 'span-7' });
  const rows = U.rows.map(({ s, enrolled, days }) => {
    const cap = Number(s.capacity) || 0;
    const ratio = cap ? enrolled / cap : 0;
    const tone = !cap ? 'none' : ratio >= 1 ? 'full' : ratio >= .6 ? 'good' : days <= 7 ? 'low' : 'mid';
    const when = days <= 0 ? 'اليوم' : days === 1 ? 'غداً' : `بعد ${days} يوم`;
    const meter = cap
      ? `<span class="dash2-meter"><span class="fill ${tone}" style="width:${Math.min(100, ratio * 100).toFixed(0)}%"></span></span>`
      : '<span class="dash2-meter none"></span>';
    return `<div class="dash2-course" data-d2-nav="courses">
      <span class="dash2-course-main"><b class="mono">${escapeHtml(String(s.courseNumber))}</b><small>${escapeHtml(s.courseType || 'غير محدد')} · ${escapeHtml(String(s.date))} · ${when}</small></span>
      ${meter}
      <span class="mono dash2-course-count ${tone === 'low' ? 'neg' : ''}">${cap ? `${enrolled} / ${cap}` : `${enrolled} مسجّل`}</span>
    </div>`;
  }).join('');
  const more = U.total > U.rows.length ? `<div class="dash2-more">+ ${U.total - U.rows.length} دورة أخرى قادمة</div>` : '';
  return d2Panel('الدورات القادمة', rows + more, {
    cls: 'span-7',
    actions: '<button type="button" class="btn btn-ghost btn-sm" data-d2-nav="courses">كل الدورات ›</button>',
  });
}

function d2TypesPanel(D, canMoney){
  const entries = Object.entries(D.typeMap)
    .sort((a, b) => canMoney ? b[1].income - a[1].income : b[1].count - a[1].count)
    .slice(0, 6);
  const label = `أداء أنواع الدورات — ${DASH2_PERIODS[dash2Period].label}`;
  if(!entries.length) return d2Panel(label, d2Empty('لا توجد تسجيلات في هذه الفترة'), { cls: 'span-5' });
  const max = Math.max(1, ...entries.map(([, v]) => canMoney ? v.income : v.count));
  const rows = entries.map(([name, v]) => {
    const val = canMoney ? v.income : v.count;
    return `<div class="dash2-type">
      <span class="dash2-type-name">${escapeHtml(name)}</span>
      <span class="dash2-meter"><span class="fill brand" style="width:${Math.max(3, (val / max) * 100).toFixed(0)}%"></span></span>
      <span class="mono dash2-type-val">${canMoney ? fmt(v.income) : v.count}<small>${canMoney ? ` · ${v.count} عميل` : ''}</small></span>
    </div>`;
  }).join('');
  return d2Panel(label, rows, { cls: 'span-5' });
}

/* ---------------- الرسم الرئيسي ---------------- */
function renderDashboardV2(){
  const kEl = $('#dash2-kpis'), gEl = $('#dash2-grid');
  if(!kEl || !gEl) return;
  try{
    const canMoney = canAccessView('vault') || canAccessView('accounting');
    const P = DASH2_PERIODS[dash2Period];
    document.querySelectorAll('#dash2-period [data-d2-period]').forEach(b => b.classList.toggle('active', b.dataset.d2Period === dash2Period));
    const D = d2Collect();
    const lbl = $('#dash2-range-label');
    if(lbl) lbl.textContent = `${D.R.from === D.R.to ? D.R.from : `${D.R.from} → ${D.R.to}`} · مقارنةً بـ ${P.prevLabel}`;

    const kpis = [];
    kpis.push(d2Kpi({ icon: 'users', label: 'التسجيلات', nav: 'clients-period', hint: 'فتح شيت العملاء بنفس الفترة',
      value: String(D.reg.cur), delta: d2Delta(D.reg.cur, D.reg.prev, P.prevLabel), spark: D.reg.spark, sub: P.label }));
    if(canMoney){
      kpis.push(d2Kpi({ icon: 'trend', label: 'صافي دخل الدورات', nav: 'reports', hint: 'فتح التقارير',
        value: `${fmt(D.income.cur)} <small>﷼</small>`, delta: d2Delta(D.income.cur, D.income.prev, P.prevLabel), spark: D.income.spark, sub: P.label }));
      kpis.push(d2Kpi({ icon: 'wallet', label: 'المحصّل فعلياً', nav: 'vault', hint: 'فتح الحركات المالية',
        value: `${fmt(D.collected.cur)} <small>﷼</small>`, delta: d2Delta(D.collected.cur, D.collected.prev, P.prevLabel), spark: D.collected.spark, sub: P.label }));
      const rec = d2Receivables();
      kpis.push(d2Kpi({ icon: 'alert', label: 'المتبقي على العملاء', nav: 'owing', tone: rec.total > 0 ? 'warn' : '', hint: 'فتح العملاء المتبقي عليهم',
        value: `${fmt(rec.total)} <small>﷼</small>`, sub: `${rec.count} عميل · الآن` }));
      const liquid = balanceOf('vault') + balanceOf('bank') + balanceOf('network') + balanceOf('network2');
      const threshold = settings.lowBalanceThreshold ?? 5000;
      const t0 = todayISO();
      const low = (balanceOfAsOf('vault', t0) + balanceOfAsOf('bank', t0)) < threshold; /* نفس شرط تنبيه انخفاض الرصيد */
      kpis.push(d2Kpi({ icon: 'vault', label: 'السيولة المتاحة', nav: 'vault', tone: low ? 'danger' : '', hint: 'فتح الخزنة',
        value: `${fmt(liquid)} <small>﷼</small>`, sub: low ? 'الخزنة والبنك أقل من الحد الأدنى' : 'خزنة + بنك + شبكة · الآن' }));
    }
    const U = d2UpcomingCourses(1);
    kpis.push(d2Kpi({ icon: 'book', label: 'الدورات القادمة', nav: 'courses', hint: 'فتح شيت الدورات',
      value: String(U.total), sub: U.nextDate ? `أقربها ${escapeHtml(String(U.nextDate))}` : 'لا توجد دورات قادمة' }));
    kEl.innerHTML = kpis.join('');

    const panels = [];
    if(canMoney){ panels.push(d2FlowPanel()); panels.push(d2ReceivablesPanel()); }
    panels.push(d2CoursesPanel());
    panels.push(d2TypesPanel(D, canMoney));
    gEl.innerHTML = panels.join('');
  }catch(err){
    console.error('renderDashboardV2 failed:', err);
    kEl.innerHTML = '';
    gEl.innerHTML = '<div class="panel"><div class="dash2-empty">تعذّر رسم لوحة التحكم — حدّث الصفحة وجرّب مرة أخرى.</div></div>';
  }
}

/* ---------------- التنقل والتفاعل ---------------- */
function d2Go(kind){
  const clickTab = view => document.querySelector(`nav.tabs button[data-view="${view}"]`)?.click();
  if(kind === 'vault' || kind === 'reports' || kind === 'courses'){ clickTab(kind); return; }
  if(kind === 'owing'){
    clickTab('clients');
    const f = $('#filter-status');
    if(f){ f.value = 'owe'; f.dispatchEvent(new Event('change')); }
    return;
  }
  if(kind === 'clients-period'){
    clickTab('clients');
    const R = d2Range(dash2Period);
    const panel = $('#advanced-filters-panel');
    if(panel) panel.style.display = '';
    const from = $('#cl-date-from'), to = $('#cl-date-to');
    if(from){ from.value = R.from; from.dispatchEvent(new Event('input')); }
    if(to){ to.value = R.to; to.dispatchEvent(new Event('input')); }
  }
}
$('#view-dashboard')?.addEventListener('click', e => {
  const per = e.target.closest('[data-d2-period]');
  if(per){
    dash2Period = per.dataset.d2Period;
    try{ localStorage.setItem(DASH2_PERIOD_KEY, dash2Period); }catch(err){}
    renderDashboardV2();
    return;
  }
  const flow = e.target.closest('[data-d2-flow]');
  if(flow){
    dash2FlowMonths = flow.dataset.d2Flow === '12' ? 12 : 6;
    try{ localStorage.setItem(DASH2_FLOW_KEY, String(dash2FlowMonths)); }catch(err){}
    renderDashboardV2();
    return;
  }
  const nav = e.target.closest('[data-d2-nav]');
  if(nav) d2Go(nav.dataset.d2Nav);
});
