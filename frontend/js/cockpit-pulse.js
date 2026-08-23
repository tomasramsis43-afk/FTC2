/* ============================================================
   نبض Cockpit Pulse — اللوحات الناقصة عن لوحة القيادة المالية
   ------------------------------------------------------------
   تكملة لـ renderCfoDashboard الموجود (هيرو + شبكة CFO شهرية) بثلاث
   لوحات من مواصفة "Financial Cockpit" (docs/redesign/04):
     1) تدفق نقدي يومي (آخر 30 يومًا) — SVG خفيف بلا مكتبات
     2) سجل النشاط (آخر العمليات من auditLog)
     3) إجراءات سريعة (نفس فتحات النماذج الحالية — لا منطق جديد)
   الصلاحيات: التدفق يتطلب vault|accounting، والنشاط يتطلب audit،
   وكل زر إجراء سريع يظهر حسب صلاحية شاشته.
   ============================================================ */

/* زمن نسبي عربي مبسط */
function pulseRelTime(ts){
  const diff = Date.now() - Number(ts || 0);
  if(diff < 60000) return 'الآن';
  const m = Math.floor(diff / 60000);
  if(m < 60) return `قبل ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if(h < 24) return `قبل ${h} ${h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : h + ' ساعات'}`;
  const d = Math.floor(h / 24);
  if(d < 30) return `قبل ${d} ${d === 1 ? 'يوم' : d === 2 ? 'يومين' : d + ' أيام'}`;
  return new Date(Number(ts)).toLocaleDateString('ar');
}

/* آخر N يوم بصيغة YYYY-MM-DD (الأقدم أولاً) */
function pulseLastNDates(n){
  const out = [];
  const t = new Date();
  for(let i = n - 1; i >= 0; i--){
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

const PULSE_ACT_META = {
  add:    { label:'إضافة', color:'var(--success)', icon:'add_circle' },
  edit:   { label:'تعديل', color:'var(--warning, #e0a72f)', icon:'edit' },
  delete: { label:'حذف',  color:'var(--danger)', icon:'do_not_disturb_on' }
};

function renderCockpitPulse(){
  const el = $('#cockpit-pulse');
  if(!el) return;

  /* ---- صلاحيات: بلا وصول مالي على الإطلاق = اللوحة كلها مخفية (نفس منطق cfo-grid) ---- */
  const canMoney = canAccessView('vault') || canAccessView('accounting');
  if(!canMoney){ el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';

  /* ================= 1) تدفق نقدي — آخر 30 يومًا ================= */
  /* نافذة زمنية حقيقية مستقلة عن فلتر السنة عمداً (نبض لحظي وليس تقرير فترة) */
  let flowHtml = '';
  {
    const days = pulseLastNDates(30);
    const byDay = {};
    days.forEach(d => byDay[d] = { in:0, out:0 });
    vaultTx.forEach(t => {
      const k = String(t.date || '').slice(0, 10);
      if(!byDay[k]) return;
      if(t.type === 'in') byDay[k].in += num(t.amount);
      else byDay[k].out += num(t.amount);
    });
    const totalIn = days.reduce((s, d) => s + byDay[d].in, 0);
    const totalOut = days.reduce((s, d) => s + byDay[d].out, 0);
    const net = totalIn - totalOut;
    const maxVal = Math.max(1, ...days.map(d => Math.max(byDay[d].in, byDay[d].out)));
    const H = 64;
    const bars = days.map((d, i) => {
      const hi = Math.round((byDay[d].in / maxVal) * H);
      const ho = Math.round((byDay[d].out / maxVal) * H);
      const x = i * 12;
      const dt = new Date(d + 'T00:00:00');
      const label = `${d} — داخل: ${fmt(byDay[d].in)} · خارج: ${fmt(byDay[d].out)}`;
      return `<g><title>${label}</title>` +
        `<rect x="${x + 3.2}" y="${H - ho}" width="3.6" height="${Math.max(ho, byDay[d].out ? 1 : 0)}" rx="1.5" fill="var(--danger)" opacity=".85"></rect>` +
        `<rect x="${x}" y="${H - hi}" width="3.6" height="${Math.max(hi, byDay[d].in ? 1 : 0)}" rx="1.5" fill="var(--brand-secondary)" opacity=".95"></rect>` +
        `</g>`;
    }).join('');
    flowHtml = `
      <div class="pulse-card">
        <div class="pulse-card-head">
          <h3>تدفق نقدي — آخر 30 يومًا</h3>
          <span class="pulse-legend"><i class="lg-in"></i> داخل <i class="lg-out"></i> خارج</span>
        </div>
        <svg class="flow-chart" viewBox="0 0 360 66" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>
        <div class="pulse-chips">
          <span class="chip chip-in">داخل <b>${fmt(totalIn)}</b></span>
          <span class="chip chip-out">خارج <b>${fmt(totalOut)}</b></span>
          <span class="chip ${net >= 0 ? 'chip-in' : 'chip-out'}">الصافي <b>${fmt(net)}</b></span>
        </div>
      </div>`;
  }

  /* ================= 2) سجل النشاط (يتطلب صلاحية audit) ================= */
  let actHtml = '';
  {
    const canAudit = canAccessView('audit');
    const items = canAudit
      ? auditLog.slice().sort((a, b) => b.ts - a.ts).slice(0, 8)
      : [];
    actHtml = `
      <div class="pulse-card">
        <div class="pulse-card-head"><h3>سجل النشاط</h3><span class="pulse-sub">آخر العمليات</span></div>
        ${items.length ? `<div class="act-stream">${items.map(it => {
          const meta = PULSE_ACT_META[it.action] || { label: it.action || '', color:'var(--text-muted)', icon:'circle' };
          return `<div class="act-row">
            <span class="msi act-ico" style="color:${meta.color};">${meta.icon}</span>
            <div class="act-body">
              <div class="act-text"><b>${escapeHtml(it.user || '')}</b> ${escapeHtml(meta.label)} — ${escapeHtml(String(it.description || it.section || ''))}</div>
              <div class="act-time">${pulseRelTime(it.ts)} · ${escapeHtml(it.section || '')}</div>
            </div>
          </div>`;
        }).join('')}</div>`
        : `<div class="hint">${canAudit ? 'لا يوجد نشاط مسجّل بعد' : 'سجل النشاط متاح لمن يملك صلاحية شاشة المراجعة'}</div>`}
      </div>`;
  }

  /* ================= 3) إجراءات سريعة ================= */
  let qaHtml = '';
  {
    const qa = [];
    const navTo = v => document.querySelector(`nav.tabs button[data-view="${v}"]`)?.click();
    if(canAccessView('clients')){
      qa.push({ icon:'person_add', label:'تسجيل متدرب', run(){
        navTo('clients'); setTimeout(() => document.getElementById('btn-add')?.click(), 250);
      }});
    }
    if(canAccessView('vault')){
      qa.push({ icon:'point_of_sale', label:'قبض / صرف', run(){
        document.getElementById('btn-fab-quickadd')?.click();
      }});
    }
    if(canAccessView('accounting')){
      qa.push({ icon:'menu_book', label:'قيد يومية', run(){
        navTo('accounting'); setTimeout(() => document.getElementById('btn-add-journal')?.click(), 250);
      }});
    }
    qa.push({ icon:'search', label:'بحث شامل (Ctrl+K)', run(){
      if(typeof openGlobalSearch === 'function') openGlobalSearch();
    }});
    qaHtml = `
      <div class="pulse-card">
        <div class="pulse-card-head"><h3>إجراءات سريعة</h3></div>
        <div class="qa-grid">${qa.map((q, i) =>
          `<button type="button" class="btn btn-ghost btn-sm qa-btn" data-qa-idx="${i}"><span class="msi" style="font-size:17px;">${q.icon}</span>${escapeHtml(q.label)}</button>`
        ).join('')}</div>
      </div>`;
    el.__qaRuns = qa.map(q => q.run);
  }

  el.innerHTML =
    `<div class="pulse-grid">${flowHtml}${actHtml}${qaHtml}</div>`;
}

/* نقر أزرار الإجراءات السريعة (تفويض واحد على الحاوية) */
$('#cockpit-pulse')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-qa-idx]');
  if(!btn) return;
  const runs = $('#cockpit-pulse').__qaRuns || [];
  const run = runs[Number(btn.dataset.qaIdx)];
  if(typeof run === 'function') run();
});
